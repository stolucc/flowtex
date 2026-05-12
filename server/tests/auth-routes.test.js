import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies ────────────────────────────────────────────────────
vi.mock('../db.js', () => ({
  default: {
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  },
}));

vi.mock('../services/authService.js', () => ({
  registerUser: vi.fn(),
  createEmailVerificationToken: vi.fn(),
  verifyEmail: vi.fn(),
  authenticateUser: vi.fn(),
  isAccountLocked: vi.fn(),
  recordLoginAttempt: vi.fn(),
  checkTrustedDevice: vi.fn(),
  verifyTotp: vi.fn(),
  createTrustedDevice: vi.fn(),
  getCurrentUser: vi.fn(),
  setupTotp: vi.fn(),
  verifyAndEnableTotp: vi.fn(),
  disableTotp: vi.fn(),
  createPasswordResetToken: vi.fn(),
  resetPassword: vi.fn(),
  changeEmail: vi.fn(),
  changePassword: vi.fn(),
  deleteAccount: vi.fn(),
}));

vi.mock('../utils/email.js', () => ({
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  sendEmailVerificationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/audit.js', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: vi.fn((req, res, next) => next()),
}));

vi.mock('../middleware/errorHandler.js', () => ({
  sendError: vi.fn((res, err) => {
    res.status(err.status || 500).json({ error: err.message });
  }),
}));

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import db from '../db.js';
import * as authService from '../services/authService.js';
import { auditLog } from '../utils/audit.js';
import { sendError } from '../middleware/errorHandler.js';
import router from '../routes/auth.js';

// ── Handler extraction ──────────────────────────────────────────────────
function getHandler(method, pathPattern) {
  for (const layer of router.stack) {
    if (layer.route) {
      const routePath = layer.route.path;
      const routeMethod = Object.keys(layer.route.methods)[0];
      if (routeMethod === method && routePath === pathPattern) {
        // Return the last handler (skip middleware like requireAuth)
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  throw new Error(`No handler found for ${method.toUpperCase()} ${pathPattern}`);
}

// ── Helpers ─────────────────────────────────────────────────────────────
function mockReq(overrides = {}) {
  return {
    body: {},
    query: {},
    params: {},
    session: {
      userId: 'user-1',
      userName: 'Test',
      save: vi.fn((cb) => cb()),
      regenerate: vi.fn((cb) => {
        // Simulate Express regenerate: clears session then calls cb
        cb();
      }),
      destroy: vi.fn((cb) => cb()),
    },
    ip: '127.0.0.1',
    cookies: {},
    headers: {},
    sessionID: 'sid-1',
    ...overrides,
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status: vi.fn(function (code) {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn(function (data) {
      res.body = data;
      return res;
    }),
    cookie: vi.fn().mockReturnThis(),
    clearCookie: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════
// POST /register
// ═════════════════════════════════════════════════════════════════════════
describe('POST /register', () => {
  const handler = getHandler('post', '/register');

  it('returns 400 when email is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { name: 'A', password: 'pass123' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('returns 400 when name is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { email: 'a@b.com', password: 'pass123' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it('returns 400 when password is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { email: 'a@b.com', name: 'A' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/password/i);
  });

  it('returns 400 for invalid email format', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { email: 'not-an-email', name: 'A', password: 'pass123' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/email format/i);
  });

  it('returns 400 for email without domain', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { email: 'user@', name: 'A', password: 'pass123' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/email format/i);
  });

  it('returns 400 when name exceeds 200 characters', async () => {
    const res = mockRes();
    const longName = 'a'.repeat(201);
    await handler(mockReq({ body: { email: 'a@b.com', name: longName, password: 'pass123' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/200/);
  });

  it('returns 400 when name is empty string', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { email: 'a@b.com', name: '   ', password: 'pass123' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('registers successfully and returns needsVerification', async () => {
    authService.registerUser.mockResolvedValueOnce({ id: 'user-99', email: 'test@example.com' });
    authService.createEmailVerificationToken.mockResolvedValueOnce('verify-token-abc');

    const res = mockRes();
    await handler(mockReq({ body: { email: 'test@example.com', name: 'Test', password: 'StrongPass1!' } }), res);

    expect(res.body).toEqual({ needsVerification: true, email: 'test@example.com' });
    expect(authService.registerUser).toHaveBeenCalledWith('test@example.com', 'Test', 'StrongPass1!');
    expect(auditLog).toHaveBeenCalledWith('user-99', 'register', { ip: '127.0.0.1' });
  });

  it('delegates service errors to sendError', async () => {
    const serviceErr = new Error('Email already exists');
    serviceErr.status = 409;
    authService.registerUser.mockRejectedValueOnce(serviceErr);

    const res = mockRes();
    await handler(mockReq({ body: { email: 'dup@test.com', name: 'A', password: 'pass1234' } }), res);

    expect(sendError).toHaveBeenCalledWith(res, serviceErr);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /login
// ═════════════════════════════════════════════════════════════════════════
describe('POST /login', () => {
  const handler = getHandler('post', '/login');

  it('returns 400 when email is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { password: 'pass' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('returns 400 when password is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { email: 'a@b.com' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/password/i);
  });

  it('returns 429 when account is locked', async () => {
    authService.isAccountLocked.mockResolvedValueOnce(true);

    const res = mockRes();
    await handler(mockReq({ body: { email: 'a@b.com', password: 'pass' } }), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.body.error).toMatch(/too many/i);
  });

  it('returns error status when authentication fails', async () => {
    authService.isAccountLocked.mockResolvedValueOnce(false);
    authService.authenticateUser.mockResolvedValueOnce({ error: 'Invalid credentials', status: 401 });

    const res = mockRes();
    await handler(mockReq({ body: { email: 'a@b.com', password: 'wrong' } }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(authService.recordLoginAttempt).toHaveBeenCalledWith('a@b.com', '127.0.0.1', false);
  });

  it('returns unverified flag for unverified accounts', async () => {
    authService.isAccountLocked.mockResolvedValueOnce(false);
    authService.authenticateUser.mockResolvedValueOnce({
      error: 'Email not verified',
      status: 403,
      unverified: true,
    });

    const res = mockRes();
    await handler(mockReq({ body: { email: 'a@b.com', password: 'pass' } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body.unverified).toBe(true);
  });

  it('returns mfaRequired when TOTP is enabled and no code provided', async () => {
    authService.isAccountLocked.mockResolvedValueOnce(false);
    authService.authenticateUser.mockResolvedValueOnce({
      user: { id: 'user-1', email: 'a@b.com', name: 'A', totp_enabled: true, totp_secret: 'secret' },
    });
    authService.checkTrustedDevice.mockResolvedValueOnce(null);

    const res = mockRes();
    await handler(mockReq({ body: { email: 'a@b.com', password: 'pass' } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ mfaRequired: true });
  });

  it('returns TOTP error when code is invalid', async () => {
    authService.isAccountLocked.mockResolvedValueOnce(false);
    authService.authenticateUser.mockResolvedValueOnce({
      user: { id: 'user-1', email: 'a@b.com', name: 'A', totp_enabled: true, totp_secret: 'secret' },
    });
    authService.checkTrustedDevice.mockResolvedValueOnce(null);
    authService.verifyTotp.mockResolvedValueOnce({ error: 'Invalid code', status: 401 });

    const res = mockRes();
    await handler(mockReq({ body: { email: 'a@b.com', password: 'pass', totpCode: '000000' } }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(authService.recordLoginAttempt).toHaveBeenCalledWith('a@b.com', '127.0.0.1', false);
  });

  it('sets trusted device cookie when trustDevice is true and TOTP succeeds', async () => {
    authService.isAccountLocked.mockResolvedValueOnce(false);
    authService.authenticateUser.mockResolvedValueOnce({
      user: { id: 'user-1', email: 'a@b.com', name: 'A', totp_enabled: true, totp_secret: 'secret' },
    });
    authService.checkTrustedDevice.mockResolvedValueOnce(null);
    authService.verifyTotp.mockResolvedValueOnce({});
    authService.createTrustedDevice.mockResolvedValueOnce({ token: 'trust-tok', maxAge: 2592000000 });
    authService.recordLoginAttempt.mockResolvedValueOnce(undefined);

    const req = mockReq({
      body: { email: 'a@b.com', password: 'pass', totpCode: '123456', trustDevice: true },
      headers: { 'user-agent': 'TestBrowser/1.0' },
    });
    const res = mockRes();
    await handler(req, res);

    expect(res.cookie).toHaveBeenCalledWith(
      'trusted-device',
      'trust-tok',
      expect.objectContaining({
        httpOnly: true,
        maxAge: 2592000000,
      }),
    );
  });

  it('skips MFA when device is trusted', async () => {
    authService.isAccountLocked.mockResolvedValueOnce(false);
    authService.authenticateUser.mockResolvedValueOnce({
      user: { id: 'user-1', email: 'a@b.com', name: 'A', totp_enabled: true },
    });
    authService.checkTrustedDevice.mockResolvedValueOnce({ token: 'rotated-tok', maxAge: 604800000 });
    authService.recordLoginAttempt.mockResolvedValueOnce(undefined);

    const req = mockReq({
      body: { email: 'a@b.com', password: 'pass' },
      cookies: { 'trusted-device': 'valid-tok' },
    });
    const res = mockRes();
    await handler(req, res);

    // Should proceed to login without asking for MFA, and rotate the cookie.
    expect(res.body).not.toHaveProperty('mfaRequired');
    expect(res.body.id).toBe('user-1');
    expect(res.cookie).toHaveBeenCalledWith(
      'trusted-device',
      'rotated-tok',
      expect.objectContaining({ httpOnly: true, maxAge: 604800000 }),
    );
  });

  it('sets session and returns user data on successful login (no MFA)', async () => {
    authService.isAccountLocked.mockResolvedValueOnce(false);
    authService.authenticateUser.mockResolvedValueOnce({
      user: { id: 'user-2', email: 'b@c.com', name: 'Bob', totp_enabled: false, is_admin: false },
    });
    authService.recordLoginAttempt.mockResolvedValueOnce(undefined);

    const req = mockReq({ body: { email: 'b@c.com', password: 'goodpass' } });
    const res = mockRes();
    await handler(req, res);

    expect(req.session.userId).toBe('user-2');
    expect(req.session.userName).toBe('Bob');
    expect(res.body).toEqual({
      id: 'user-2',
      email: 'b@c.com',
      name: 'Bob',
      totpEnabled: false,
      isAdmin: false,
    });
    expect(authService.recordLoginAttempt).toHaveBeenCalledWith('b@c.com', '127.0.0.1', true);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /logout
// ═════════════════════════════════════════════════════════════════════════
describe('POST /logout', () => {
  const handler = getHandler('post', '/logout');

  it('destroys session, clears cookie, and returns ok', async () => {
    const req = mockReq();
    const res = mockRes();
    handler(req, res);
    // The destroy callback is async — wait for microtasks to flush
    await new Promise((r) => setTimeout(r, 0));

    expect(req.session.destroy).toHaveBeenCalled();
    expect(res.clearCookie).toHaveBeenCalledWith('__session', { path: '/' });
    expect(res.body).toEqual({ ok: true });
  });

  it('calls auditLog with userId when present', async () => {
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    // auditLog is called asynchronously inside destroy callback
    expect(auditLog).toHaveBeenCalledWith('user-1', 'logout', { ip: '127.0.0.1' });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// GET /me
// ═════════════════════════════════════════════════════════════════════════
describe('GET /me', () => {
  const handler = getHandler('get', '/me');

  it('returns user from service', async () => {
    const userData = { id: 'user-1', email: 'test@x.com', name: 'Test' };
    authService.getCurrentUser.mockResolvedValueOnce(userData);

    const res = mockRes();
    await handler(mockReq(), res);

    expect(authService.getCurrentUser).toHaveBeenCalledWith('user-1');
    expect(res.body).toEqual(userData);
  });

  it('returns 401 if user not found', async () => {
    authService.getCurrentUser.mockResolvedValueOnce(null);

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// GET /verify-email
// ═════════════════════════════════════════════════════════════════════════
describe('GET /verify-email', () => {
  const handler = getHandler('get', '/verify-email');

  it('returns 400 when token is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ query: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/token/i);
  });

  it('verifies email and returns ok', async () => {
    authService.verifyEmail.mockResolvedValueOnce('user-1');

    const res = mockRes();
    await handler(mockReq({ query: { token: 'valid-token' } }), res);

    expect(res.body).toEqual({ ok: true });
    expect(auditLog).toHaveBeenCalledWith('user-1', 'email_verified', { ip: '127.0.0.1' });
  });

  it('delegates service errors to sendError', async () => {
    const err = new Error('Invalid or expired token');
    err.status = 400;
    authService.verifyEmail.mockRejectedValueOnce(err);

    const res = mockRes();
    await handler(mockReq({ query: { token: 'bad-token' } }), res);

    expect(sendError).toHaveBeenCalledWith(res, err);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /resend-verification
// ═════════════════════════════════════════════════════════════════════════
describe('POST /resend-verification', () => {
  const handler = getHandler('post', '/resend-verification');

  it('returns 400 when email is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns ok even when user does not exist (no enumeration)', async () => {
    db.get.mockResolvedValueOnce(undefined);

    const res = mockRes();
    await handler(mockReq({ body: { email: 'noone@x.com' } }), res);

    expect(res.body).toEqual({ ok: true });
  });

  it('returns ok when user is already verified (no enumeration)', async () => {
    db.get.mockResolvedValueOnce({ id: 'u1', email: 'a@b.com', email_verified: true });

    const res = mockRes();
    await handler(mockReq({ body: { email: 'a@b.com' } }), res);

    expect(res.body).toEqual({ ok: true });
    expect(authService.createEmailVerificationToken).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /forgot-password
// ═════════════════════════════════════════════════════════════════════════
describe('POST /forgot-password', () => {
  const handler = getHandler('post', '/forgot-password');

  it('returns 400 when email is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('always returns ok even when user does not exist (no enumeration)', async () => {
    authService.createPasswordResetToken.mockResolvedValueOnce(null);

    const res = mockRes();
    await handler(mockReq({ body: { email: 'noone@x.com' } }), res);

    expect(res.body).toEqual({ ok: true });
  });

  it('sends reset email when user exists', async () => {
    authService.createPasswordResetToken.mockResolvedValueOnce({
      email: 'real@x.com',
      token: 'reset-tok',
      userId: 'user-5',
    });

    const res = mockRes();
    await handler(mockReq({ body: { email: 'real@x.com' } }), res);

    expect(res.body).toEqual({ ok: true });
    expect(auditLog).toHaveBeenCalledWith('user-5', 'password_reset_requested', { ip: '127.0.0.1' });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /reset-password
// ═════════════════════════════════════════════════════════════════════════
describe('POST /reset-password', () => {
  const handler = getHandler('post', '/reset-password');

  it('returns 400 when token is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { password: 'new1234' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when password is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { token: 'tok' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('resets password, invalidates sessions, and returns ok', async () => {
    authService.resetPassword.mockResolvedValueOnce('user-7');
    db.run.mockResolvedValueOnce({});

    const res = mockRes();
    await handler(mockReq({ body: { token: 'valid-tok', password: 'NewPass1!' } }), res);

    expect(res.body).toEqual({ ok: true });
    expect(db.run).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM session'), ['user-7']);
    expect(auditLog).toHaveBeenCalledWith('user-7', 'password_reset', { ip: '127.0.0.1' });
  });

  it('delegates service errors to sendError', async () => {
    const err = new Error('Invalid or expired token');
    err.status = 400;
    authService.resetPassword.mockRejectedValueOnce(err);

    const res = mockRes();
    await handler(mockReq({ body: { token: 'bad', password: 'pass' } }), res);

    expect(sendError).toHaveBeenCalledWith(res, err);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /change-email
// ═════════════════════════════════════════════════════════════════════════
describe('POST /change-email', () => {
  const handler = getHandler('post', '/change-email');

  it('returns 400 when password is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { newEmail: 'new@x.com' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when newEmail is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { password: 'pass' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('changes email and returns ok with new email', async () => {
    authService.changeEmail.mockResolvedValueOnce({ oldEmail: 'old@x.com', email: 'new@x.com' });

    const res = mockRes();
    await handler(mockReq({ body: { password: 'pass', newEmail: 'new@x.com' } }), res);

    expect(res.body).toEqual({ ok: true, email: 'new@x.com', needsVerification: true });
    expect(auditLog).toHaveBeenCalledWith(
      'user-1',
      'email_changed',
      expect.objectContaining({
        oldEmail: 'old@x.com',
        newEmail: 'new@x.com',
      }),
    );
  });

  it('delegates service errors to sendError', async () => {
    const err = new Error('Wrong password');
    err.status = 403;
    authService.changeEmail.mockRejectedValueOnce(err);

    const res = mockRes();
    await handler(mockReq({ body: { password: 'wrong', newEmail: 'new@x.com' } }), res);

    expect(sendError).toHaveBeenCalledWith(res, err);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /change-password
// ═════════════════════════════════════════════════════════════════════════
describe('POST /change-password', () => {
  const handler = getHandler('post', '/change-password');

  it('returns 400 when currentPassword is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { newPassword: 'new' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when newPassword is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ body: { currentPassword: 'old' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('changes password, invalidates other sessions, returns ok', async () => {
    authService.changePassword.mockResolvedValueOnce(undefined);
    db.run.mockResolvedValueOnce({});

    const res = mockRes();
    await handler(mockReq({ body: { currentPassword: 'old', newPassword: 'new' } }), res);

    expect(res.body).toEqual({ ok: true });
    // Should delete other sessions but keep current one
    expect(db.run).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM session'), ['user-1', 'sid-1']);
    expect(auditLog).toHaveBeenCalledWith('user-1', 'password_changed', { ip: '127.0.0.1' });
  });

  it('delegates service errors to sendError', async () => {
    const err = new Error('Current password is incorrect');
    err.status = 403;
    authService.changePassword.mockRejectedValueOnce(err);

    const res = mockRes();
    await handler(mockReq({ body: { currentPassword: 'wrong', newPassword: 'new' } }), res);

    expect(sendError).toHaveBeenCalledWith(res, err);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /totp/setup
// ═════════════════════════════════════════════════════════════════════════
describe('POST /totp/setup', () => {
  const handler = getHandler('post', '/totp/setup');

  it('returns setup data from service', async () => {
    const setupData = { secret: 'ABCD', qrCode: 'data:image/png;base64,...' };
    authService.setupTotp.mockResolvedValueOnce(setupData);

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.body).toEqual(setupData);
  });

  it('delegates errors to sendError', async () => {
    const err = new Error('TOTP already enabled');
    err.status = 400;
    authService.setupTotp.mockRejectedValueOnce(err);

    const res = mockRes();
    await handler(mockReq(), res);

    expect(sendError).toHaveBeenCalledWith(res, err);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /totp/verify
// ═════════════════════════════════════════════════════════════════════════
describe('POST /totp/verify', () => {
  const handler = getHandler('post', '/totp/verify');

  it('returns 400 when code is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/code/i);
  });

  it('enables TOTP and returns ok', async () => {
    authService.verifyAndEnableTotp.mockResolvedValueOnce(undefined);

    const res = mockRes();
    await handler(mockReq({ body: { code: '123456' } }), res);

    expect(res.body).toEqual({ ok: true });
    expect(auditLog).toHaveBeenCalledWith('user-1', 'mfa_enabled', { ip: '127.0.0.1' });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /totp/disable
// ═════════════════════════════════════════════════════════════════════════
describe('POST /totp/disable', () => {
  const handler = getHandler('post', '/totp/disable');

  it('returns 400 when password is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/password/i);
  });

  it('disables TOTP, clears trusted-device cookie, and returns ok', async () => {
    authService.disableTotp.mockResolvedValueOnce(undefined);

    const res = mockRes();
    await handler(mockReq({ body: { password: 'pass' } }), res);

    expect(res.body).toEqual({ ok: true });
    expect(res.clearCookie).toHaveBeenCalledWith('trusted-device', { path: '/' });
    expect(auditLog).toHaveBeenCalledWith('user-1', 'mfa_disabled', { ip: '127.0.0.1' });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// POST /delete-account
// ═════════════════════════════════════════════════════════════════════════
describe('POST /delete-account', () => {
  const handler = getHandler('post', '/delete-account');

  it('returns 400 when password is missing', async () => {
    const res = mockRes();
    await handler(mockReq({ body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toMatch(/password/i);
  });

  it('deletes account, destroys session, and returns ok', async () => {
    authService.deleteAccount.mockResolvedValueOnce(undefined);

    const req = mockReq({ body: { password: 'pass' } });
    const res = mockRes();
    await handler(req, res);

    expect(authService.deleteAccount).toHaveBeenCalledWith('user-1', 'pass');
    expect(req.session.destroy).toHaveBeenCalled();
    expect(res.body).toEqual({ ok: true });
  });

  it('delegates service errors to sendError', async () => {
    const err = new Error('Wrong password');
    err.status = 403;
    authService.deleteAccount.mockRejectedValueOnce(err);

    const res = mockRes();
    await handler(mockReq({ body: { password: 'wrong' } }), res);

    expect(sendError).toHaveBeenCalledWith(res, err);
  });
});
