import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({ default: { get: vi.fn(), run: vi.fn() } }));
vi.mock('../services/googleAuthService.js', () => ({
  isGoogleAuthEnabled: vi.fn(() => true),
  buildAuthRequest: vi.fn(async () => ({
    url: 'https://accounts.google.com/auth?x=1',
    state: 'st',
    nonce: 'no',
    codeVerifier: 'cv',
  })),
  exchangeCallback: vi.fn(),
  resolveGoogleLogin: vi.fn(),
  linkGoogleToUser: vi.fn(),
  unlinkGoogle: vi.fn(),
}));
vi.mock('../services/authService.js', () => ({
  attemptLogin: vi.fn(),
  checkTrustedDevice: vi.fn(async () => null),
  createTrustedDevice: vi.fn(async () => ({ token: 'td', maxAge: 1000 })),
  verifyTotpWithLockout: vi.fn(),
  recordLoginAttempt: vi.fn(),
}));
vi.mock('../utils/audit.js', () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import db from '../db.js';
import * as google from '../services/googleAuthService.js';
import * as authService from '../services/authService.js';
import { auditLog } from '../utils/audit.js';
import router, { _testing } from '../routes/googleAuth.js';

const { safeReturnTo } = _testing;

function getHandler(method, path) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`no handler ${method} ${path}`);
}

function mockSession(init = {}) {
  const s = {
    ...init,
    save: vi.fn((cb) => cb && cb()),
    destroy: vi.fn((cb) => cb && cb()),
    regenerate: vi.fn((cb) => {
      // Real regenerate drops all data; model that so tests catch any
      // pending state surviving sign-in.
      for (const k of Object.keys(s)) if (!['save', 'destroy', 'regenerate'].includes(k)) delete s[k];
      cb();
    }),
  };
  return s;
}

function mockReq(over = {}) {
  return {
    body: {},
    query: {},
    params: {},
    cookies: {},
    headers: {},
    ip: '127.0.0.1',
    originalUrl: '/api/auth/google/callback?code=c&state=st',
    session: mockSession(),
    ...over,
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    redirectedTo: undefined,
    cookies: {},
    status: vi.fn((c) => { res.statusCode = c; return res; }),
    json: vi.fn((b) => { res.body = b; return res; }),
    redirect: vi.fn((u) => { res.redirectedTo = u; return res; }),
    cookie: vi.fn((n, v) => { res.cookies[n] = v; return res; }),
  };
  return res;
}

const freshPending = (over = {}) => ({
  mode: 'login', state: 'st', nonce: 'no', codeVerifier: 'cv', returnTo: '/project/abc',
  expiresAt: Date.now() + 60_000, ...over,
});
const identity = { sub: 'sub-1', email: 'u@example.com', name: 'U' };
const user = (over = {}) => ({ id: 'u1', email: 'u@example.com', name: 'U', totp_enabled: false, totp_secret: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  google.isGoogleAuthEnabled.mockReturnValue(true);
  authService.checkTrustedDevice.mockResolvedValue(null);
  process.env.APP_URL = 'https://app.test';
});

describe('safeReturnTo', () => {
  it('keeps same-origin paths, rejects everything else', () => {
    expect(safeReturnTo('/project/1?x=2')).toBe('/project/1?x=2');
    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil', 'rel', '', null, 5, '/api/auth/google/login', '/a\0b', '/' + 'a'.repeat(1100)]) {
      expect(safeReturnTo(bad)).toBe('/');
    }
  });
});

describe('GET /login', () => {
  it('stores state/nonce/verifier server-side and redirects to Google', async () => {
    const req = mockReq({ query: { returnTo: '/project/abc' } });
    const res = mockRes();
    await getHandler('get', '/login')(req, res);
    expect(res.redirectedTo).toBe('https://accounts.google.com/auth?x=1');
    expect(google.buildAuthRequest).toHaveBeenCalledWith('https://app.test/api/auth/google/callback');
    expect(req.session.googleOAuth).toMatchObject({ mode: 'login', state: 'st', nonce: 'no', codeVerifier: 'cv', returnTo: '/project/abc' });
  });

  it('sanitises returnTo', async () => {
    const req = mockReq({ query: { returnTo: '//evil.com' } });
    await getHandler('get', '/login')(req, mockRes());
    expect(req.session.googleOAuth.returnTo).toBe('/');
  });

  it('404s when not configured', async () => {
    google.isGoogleAuthEnabled.mockReturnValue(false);
    const res = mockRes();
    await getHandler('get', '/login')(mockReq(), res);
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /callback', () => {
  const run = async (sessionInit, over = {}) => {
    const req = mockReq({ session: mockSession(sessionInit), ...over });
    const res = mockRes();
    await getHandler('get', '/callback')(req, res);
    return { req, res };
  };

  it('rejects when there is no pending request (no state in session = CSRF / replay)', async () => {
    const { res } = await run({});
    expect(res.redirectedTo).toBe('/login?google_error=expired');
    expect(google.exchangeCallback).not.toHaveBeenCalled();
  });

  it('rejects an expired pending request', async () => {
    const { res } = await run({ googleOAuth: freshPending({ expiresAt: Date.now() - 1 }) });
    expect(res.redirectedTo).toBe('/login?google_error=expired');
  });

  it('consumes the pending state even on failure (one-shot)', async () => {
    google.exchangeCallback.mockRejectedValueOnce(new Error('bad state'));
    const { req, res } = await run({ googleOAuth: freshPending() });
    expect(req.session.googleOAuth).toBeUndefined();
    expect(res.redirectedTo).toBe('/login?google_error=failed');
  });

  it('maps Google ?error= (user cancelled) without exchanging', async () => {
    const { res } = await run({ googleOAuth: freshPending() }, { query: { error: 'access_denied' } });
    expect(res.redirectedTo).toBe('/login?google_error=cancelled');
    expect(google.exchangeCallback).not.toHaveBeenCalled();
  });

  it('reports unverified Google emails distinctly', async () => {
    google.exchangeCallback.mockRejectedValueOnce(Object.assign(new Error('Google account email is not verified'), { status: 400 }));
    const { res } = await run({ googleOAuth: freshPending() });
    expect(res.redirectedTo).toBe('/login?google_error=unverified_email');
  });

  it('passes the full callback URL and the stored checks to the exchange', async () => {
    google.exchangeCallback.mockResolvedValueOnce(identity);
    google.resolveGoogleLogin.mockResolvedValueOnce({ kind: 'login', user: user(), isNew: false, claimed: false });
    await run({ googleOAuth: freshPending() });
    const [url, checks] = google.exchangeCallback.mock.calls[0];
    expect(url.href).toBe('https://app.test/api/auth/google/callback?code=c&state=st');
    expect(checks).toMatchObject({ state: 'st', nonce: 'no', codeVerifier: 'cv' });
  });

  it('signs in: regenerates session, sets userId + CSRF, redirects to returnTo', async () => {
    google.exchangeCallback.mockResolvedValueOnce(identity);
    google.resolveGoogleLogin.mockResolvedValueOnce({ kind: 'login', user: user(), isNew: false, claimed: false });
    const { req, res } = await run({ googleOAuth: freshPending(), userId: 'someone-else' });
    expect(req.session.regenerate).toHaveBeenCalled();
    expect(req.session.userId).toBe('u1');
    expect(req.session.authMethod).toBe('google');
    expect(req.session.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    expect(res.cookies['csrf-token']).toBe(req.session.csrfToken);
    expect(res.redirectedTo).toBe('/project/abc');
    expect(auditLog).toHaveBeenCalledWith('u1', 'login', expect.objectContaining({ detail: { method: 'google' } }));
  });

  it('audits new accounts and squat claims', async () => {
    google.exchangeCallback.mockResolvedValue(identity);
    google.resolveGoogleLogin.mockResolvedValueOnce({ kind: 'login', user: user(), isNew: true, claimed: false });
    await run({ googleOAuth: freshPending() });
    expect(auditLog).toHaveBeenCalledWith('u1', 'google_register', expect.anything());
    google.resolveGoogleLogin.mockResolvedValueOnce({ kind: 'login', user: user(), isNew: false, claimed: true });
    await run({ googleOAuth: freshPending() });
    expect(auditLog).toHaveBeenCalledWith('u1', 'google_claim_unverified', expect.anything());
  });

  it('TOTP user: does NOT sign in, parks a pending MFA step', async () => {
    google.exchangeCallback.mockResolvedValueOnce(identity);
    google.resolveGoogleLogin.mockResolvedValueOnce({ kind: 'login', user: user({ totp_enabled: true }), isNew: false, claimed: false });
    const { req, res } = await run({ googleOAuth: freshPending() });
    expect(req.session.userId).toBeUndefined();
    expect(req.session.regenerate).not.toHaveBeenCalled();
    expect(req.session.pendingGoogleMfa).toMatchObject({ userId: 'u1', returnTo: '/project/abc' });
    expect(res.redirectedTo).toBe('/login/google-mfa');
  });

  it('TOTP user with a valid trusted-device cookie: signs in and rotates the cookie', async () => {
    google.exchangeCallback.mockResolvedValueOnce(identity);
    google.resolveGoogleLogin.mockResolvedValueOnce({ kind: 'login', user: user({ totp_enabled: true }), isNew: false, claimed: false });
    authService.checkTrustedDevice.mockResolvedValueOnce({ token: 'rotated', maxAge: 5 });
    const { req, res } = await run({ googleOAuth: freshPending() }, { cookies: { 'trusted-device': 'old' } });
    expect(req.session.userId).toBe('u1');
    expect(res.cookies['trusted-device']).toBe('rotated');
  });

  it('existing password account: parks pending link, does not sign in', async () => {
    google.exchangeCallback.mockResolvedValueOnce(identity);
    google.resolveGoogleLogin.mockResolvedValueOnce({ kind: 'needs_link', userId: 'u1', email: 'u@example.com', existingName: 'U' });
    const { req, res } = await run({ googleOAuth: freshPending() });
    expect(req.session.userId).toBeUndefined();
    expect(req.session.pendingGoogleLink).toMatchObject({ userId: 'u1', sub: 'sub-1', email: 'u@example.com' });
    expect(res.redirectedTo).toBe('/login/link-google');
  });

  it('refusals map to error codes', async () => {
    for (const reason of ['deleted', 'sso_required', 'other_google_linked']) {
      google.exchangeCallback.mockResolvedValueOnce(identity);
      google.resolveGoogleLogin.mockResolvedValueOnce({ kind: 'refused', reason });
      const { req, res } = await run({ googleOAuth: freshPending() });
      expect(res.redirectedTo).toBe(`/login?google_error=${reason}`);
      expect(req.session.userId).toBeUndefined();
    }
  });

  describe('link mode (from Settings)', () => {
    it('links to the signed-in user who started it', async () => {
      google.exchangeCallback.mockResolvedValueOnce(identity);
      const { res } = await run({ userId: 'u1', googleOAuth: freshPending({ mode: 'link', userId: 'u1' }) });
      expect(google.linkGoogleToUser).toHaveBeenCalledWith('u1', 'sub-1');
      expect(google.resolveGoogleLogin).not.toHaveBeenCalled();
      expect(res.redirectedTo).toBe('/?google=linked');
    });

    it('refuses if the signed-in user changed mid-flow', async () => {
      google.exchangeCallback.mockResolvedValueOnce(identity);
      const { res } = await run({ userId: 'u2', googleOAuth: freshPending({ mode: 'link', userId: 'u1' }) });
      expect(google.linkGoogleToUser).not.toHaveBeenCalled();
      expect(res.redirectedTo).toBe('/?google_error=session_changed');
    });

    it('reports a Google account already linked elsewhere', async () => {
      google.exchangeCallback.mockResolvedValueOnce(identity);
      google.linkGoogleToUser.mockRejectedValueOnce(Object.assign(new Error('taken'), { status: 409 }));
      const { res } = await run({ userId: 'u1', googleOAuth: freshPending({ mode: 'link', userId: 'u1' }) });
      expect(res.redirectedTo).toBe('/?google_error=already_linked');
    });
  });
});

describe('POST /link-start', () => {
  const handler = () => getHandler('post', '/link-start');

  it('requires the current password through attemptLogin (lockout)', async () => {
    db.get.mockResolvedValueOnce({ email: 'u@example.com', password_hash: 'h', google_sub: null, auth_method: 'password' });
    authService.attemptLogin.mockResolvedValueOnce({ error: 'Invalid credentials', status: 401 });
    const req = mockReq({ session: mockSession({ userId: 'u1' }), body: { password: 'bad' } });
    const res = mockRes();
    await handler()(req, res);
    expect(authService.attemptLogin).toHaveBeenCalledWith('u@example.com', 'bad', '127.0.0.1');
    expect(res.statusCode).toBe(401);
    expect(req.session.googleOAuth).toBeUndefined();
  });

  it('passes through lockout 429', async () => {
    db.get.mockResolvedValueOnce({ email: 'u@example.com', password_hash: 'h', google_sub: null, auth_method: 'password' });
    authService.attemptLogin.mockResolvedValueOnce({ error: 'Too many failed attempts.', status: 429 });
    const res = mockRes();
    await handler()(mockReq({ session: mockSession({ userId: 'u1' }), body: { password: 'x' } }), res);
    expect(res.statusCode).toBe(429);
  });

  it('on success, stores a link-mode request bound to the user and returns the URL', async () => {
    db.get.mockResolvedValueOnce({ email: 'u@example.com', password_hash: 'h', google_sub: null, auth_method: 'password' });
    authService.attemptLogin.mockResolvedValueOnce({ user: user() });
    const req = mockReq({ session: mockSession({ userId: 'u1' }), body: { password: 'good' } });
    const res = mockRes();
    await handler()(req, res);
    expect(res.body).toEqual({ url: 'https://accounts.google.com/auth?x=1' });
    expect(req.session.googleOAuth).toMatchObject({ mode: 'link', userId: 'u1', state: 'st' });
  });

  it('refuses SAML accounts, already-linked accounts, and accounts without a password', async () => {
    for (const [row, code] of [
      [{ auth_method: 'saml', password_hash: null, google_sub: null }, 409],
      [{ auth_method: 'password', password_hash: 'h', google_sub: 'g' }, 409],
      [{ auth_method: 'password', password_hash: null, google_sub: null }, 400],
    ]) {
      db.get.mockResolvedValueOnce({ email: 'u@example.com', ...row });
      const res = mockRes();
      await handler()(mockReq({ session: mockSession({ userId: 'u1' }), body: { password: 'x' } }), res);
      expect(res.statusCode).toBe(code);
    }
    expect(authService.attemptLogin).not.toHaveBeenCalled();
  });
});

describe('POST /confirm-link', () => {
  const handler = () => getHandler('post', '/confirm-link');
  const pendingLink = (over = {}) => ({
    userId: 'u1', sub: 'sub-1', email: 'u@example.com', existingName: 'U', returnTo: '/p', expiresAt: Date.now() + 60_000, ...over,
  });

  it('expired / missing pending link → 400, no password check', async () => {
    const res = mockRes();
    await handler()(mockReq({ session: mockSession({ pendingGoogleLink: pendingLink({ expiresAt: 1 }) }), body: { password: 'x' } }), res);
    expect(res.statusCode).toBe(400);
    expect(authService.attemptLogin).not.toHaveBeenCalled();
  });

  it('wrong password → 401 and nothing linked', async () => {
    authService.attemptLogin.mockResolvedValueOnce({ error: 'Invalid credentials', status: 401 });
    const req = mockReq({ session: mockSession({ pendingGoogleLink: pendingLink() }), body: { password: 'bad' } });
    const res = mockRes();
    await handler()(req, res);
    expect(res.statusCode).toBe(401);
    expect(google.linkGoogleToUser).not.toHaveBeenCalled();
    expect(req.session.userId).toBeUndefined();
  });

  it('password for a different account than the pending one → 409', async () => {
    authService.attemptLogin.mockResolvedValueOnce({ user: user({ id: 'other' }) });
    const res = mockRes();
    await handler()(mockReq({ session: mockSession({ pendingGoogleLink: pendingLink() }), body: { password: 'x' } }), res);
    expect(res.statusCode).toBe(409);
    expect(google.linkGoogleToUser).not.toHaveBeenCalled();
  });

  it('right password, no TOTP → links and signs in', async () => {
    authService.attemptLogin.mockResolvedValueOnce({ user: user() });
    google.linkGoogleToUser.mockResolvedValueOnce(user());
    const req = mockReq({ session: mockSession({ pendingGoogleLink: pendingLink() }), body: { password: 'good' } });
    const res = mockRes();
    await handler()(req, res);
    expect(google.linkGoogleToUser).toHaveBeenCalledWith('u1', 'sub-1');
    expect(req.session.userId).toBe('u1');
    expect(req.session.pendingGoogleLink).toBeUndefined();
    expect(res.body).toEqual({ ok: true, redirect: '/p' });
  });

  it('TOTP user without code → mfaRequired, nothing linked yet', async () => {
    authService.attemptLogin.mockResolvedValueOnce({ user: user({ totp_enabled: true, totp_secret: 'enc' }) });
    const req = mockReq({ session: mockSession({ pendingGoogleLink: pendingLink() }), body: { password: 'good' } });
    const res = mockRes();
    await handler()(req, res);
    expect(res.body).toEqual({ mfaRequired: true });
    expect(google.linkGoogleToUser).not.toHaveBeenCalled();
    expect(req.session.userId).toBeUndefined();
  });

  it('TOTP user with bad code → error, nothing linked', async () => {
    authService.attemptLogin.mockResolvedValueOnce({ user: user({ totp_enabled: true, totp_secret: 'enc' }) });
    authService.verifyTotpWithLockout.mockResolvedValueOnce({ error: 'Invalid 2FA code', status: 401 });
    const res = mockRes();
    await handler()(mockReq({ session: mockSession({ pendingGoogleLink: pendingLink() }), body: { password: 'good', totpCode: '123456' } }), res);
    expect(res.statusCode).toBe(401);
    expect(google.linkGoogleToUser).not.toHaveBeenCalled();
  });

  it('TOTP user with good code → links, signs in, optionally trusts device', async () => {
    authService.attemptLogin.mockResolvedValueOnce({ user: user({ totp_enabled: true, totp_secret: 'enc' }) });
    authService.verifyTotpWithLockout.mockResolvedValueOnce({});
    google.linkGoogleToUser.mockResolvedValueOnce(user());
    const req = mockReq({ session: mockSession({ pendingGoogleLink: pendingLink() }), body: { password: 'good', totpCode: '123456', trustDevice: true } });
    const res = mockRes();
    await handler()(req, res);
    expect(authService.verifyTotpWithLockout).toHaveBeenCalledWith('u1', '123456', 'enc', 'u@example.com', '127.0.0.1');
    expect(res.cookies['trusted-device']).toBe('td');
    expect(req.session.userId).toBe('u1');
  });
});

describe('POST /mfa', () => {
  const handler = () => getHandler('post', '/mfa');

  it('no pending MFA → 400 (cannot be used to skip the Google step)', async () => {
    const res = mockRes();
    await handler()(mockReq({ body: { totpCode: '123456' } }), res);
    expect(res.statusCode).toBe(400);
    expect(authService.verifyTotpWithLockout).not.toHaveBeenCalled();
  });

  it('bad code → error, no session', async () => {
    db.get.mockResolvedValueOnce({ ...user({ totp_enabled: true, totp_secret: 'enc' }), deleted_at: null });
    authService.verifyTotpWithLockout.mockResolvedValueOnce({ error: 'Invalid 2FA code', status: 401 });
    const req = mockReq({ session: mockSession({ pendingGoogleMfa: { userId: 'u1', returnTo: '/', expiresAt: Date.now() + 1e4 } }), body: { totpCode: '000000' } });
    const res = mockRes();
    await handler()(req, res);
    expect(res.statusCode).toBe(401);
    expect(req.session.userId).toBeUndefined();
  });

  it('good code → signs in', async () => {
    db.get.mockResolvedValueOnce({ ...user({ totp_enabled: true, totp_secret: 'enc' }), deleted_at: null });
    authService.verifyTotpWithLockout.mockResolvedValueOnce({});
    const req = mockReq({ session: mockSession({ pendingGoogleMfa: { userId: 'u1', returnTo: '/p', expiresAt: Date.now() + 1e4 } }), body: { totpCode: '123456' } });
    const res = mockRes();
    await handler()(req, res);
    expect(req.session.userId).toBe('u1');
    expect(req.session.pendingGoogleMfa).toBeUndefined();
    expect(res.body).toEqual({ ok: true, redirect: '/p' });
  });

  it('account deleted meanwhile → 400', async () => {
    db.get.mockResolvedValueOnce({ ...user({ totp_enabled: true }), deleted_at: new Date() });
    const req = mockReq({ session: mockSession({ pendingGoogleMfa: { userId: 'u1', returnTo: '/', expiresAt: Date.now() + 1e4 } }), body: { totpCode: '123456' } });
    const res = mockRes();
    await handler()(req, res);
    expect(res.statusCode).toBe(400);
    expect(req.session.userId).toBeUndefined();
  });
});

describe('POST /unlink', () => {
  it('maps service errors to their status', async () => {
    google.unlinkGoogle.mockRejectedValueOnce(Object.assign(new Error('Set a password first'), { status: 400 }));
    const res = mockRes();
    await getHandler('post', '/unlink')(mockReq({ session: mockSession({ userId: 'u1' }), body: { password: 'x' } }), res);
    expect(res.statusCode).toBe(400);
  });

  it('audits a successful unlink', async () => {
    google.unlinkGoogle.mockResolvedValueOnce(undefined);
    const res = mockRes();
    await getHandler('post', '/unlink')(mockReq({ session: mockSession({ userId: 'u1' }), body: { password: 'x' } }), res);
    expect(res.body).toEqual({ ok: true });
    expect(auditLog).toHaveBeenCalledWith('u1', 'google_unlink', expect.anything());
  });
});
