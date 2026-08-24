// Auth flow end-to-end: register → verify-email → login → logout → re-login →
// delete-account. Hits the real REST endpoints over HTTPS with proper CSRF /
// Origin handling — does NOT use the cookie-injection shortcut the other
// suites rely on, because the point here is to exercise login itself.
//
// Rate limit awareness: /api/auth is bounded to 20 requests / 15min / IP.
// This spec uses ~12 requests in the happy path plus a handful of error
// probes, so it fits under the budget. If you re-run this spec several
// times in quick succession you may hit the limit and see 429s — wait
// 15 minutes or restart the server with DISABLE_RATE_LIMIT=1.
import { test, expect } from 'playwright/test';
import pg from 'pg';
import { close } from './_seed.js';

const BASE = process.env.E2E_BASE_URL || `https://localhost:${process.env.PORT || 3001}`;

let pool;

test.beforeAll(async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  pool = new pg.Pool({
    database: process.env.PGDATABASE || 'flowtex',
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    max: 2,
  });
});

test.afterAll(async () => {
  // Best-effort cleanup of any test users this spec left behind.
  if (pool) {
    await pool.query(`DELETE FROM users WHERE email LIKE 'e2e-auth-%@test.local'`);
    await pool.end();
  }
  await close();
});

// Helpers ─────────────────────────────────────────────────────────────────

async function api(method, path, { body, cookie, csrf } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: BASE,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  // Pre-read the body so callers can both inspect status with a meaningful
  // error message and call .json() / .text on the wrapped result without
  // hitting the "Body is unusable" double-read error from the fetch API.
  const bodyText = await res.text();
  return {
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    text: bodyText,
    json() { return JSON.parse(bodyText); },
  };
}

function pickSessionCookie(res) {
  // Set-Cookie may include multiple cookies (csrf-token + __session). Grab
  // both and join into a single Cookie header value for re-presentation
  // on subsequent requests. We need the csrf-token for any state-changing
  // endpoint that ISN'T in the pre-auth exempt list (e.g. delete-account).
  const setCookies = res.headers.getSetCookie?.() || [];
  const parts = [];
  for (const c of setCookies) {
    const m = c.match(/^([^=]+)=([^;]+)/);
    if (m && (m[1] === '__session' || m[1] === 'csrf-token')) parts.push(`${m[1]}=${m[2]}`);
  }
  return parts.length ? parts.join('; ') : null;
}

function pickCsrfToken(res) {
  const setCookies = res.headers.getSetCookie?.() || [];
  for (const c of setCookies) {
    const m = c.match(/^csrf-token=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

async function getEmailVerificationToken(userEmail) {
  // The /register endpoint writes a hashed token to the email_verification_tokens
  // table and emails the raw token. In test we don't have SMTP, so we read the
  // raw token straight out of the DB — but the server stores it HASHED. The
  // pragmatic shortcut for testing the verify-email flow without SMTP: bypass
  // by directly setting email_verified=TRUE for our test user.
  const r = await pool.query('SELECT id FROM users WHERE email = $1', [userEmail]);
  if (r.rowCount === 0) throw new Error(`no user ${userEmail}`);
  await pool.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [r.rows[0].id]);
  return r.rows[0].id;
}

// Tests ───────────────────────────────────────────────────────────────────

test('register: happy path returns needsVerification + persists user', async () => {
  const stamp = Date.now();
  const email = `e2e-auth-register-${stamp}@test.local`;
  const r = await api('POST', '/api/auth/register', {
    body: { email, name: 'Reg Happy', password: 'ValidPass123' },
  });
  expect(r.status, r.text).toBe(200);
  const body = r.json();
  expect(body.needsVerification).toBe(true);
  expect(body.email).toBe(email);

  // The DB row should exist with email_verified=false.
  const row = await pool.query('SELECT email_verified FROM users WHERE email = $1', [email]);
  expect(row.rowCount).toBe(1);
  expect(row.rows[0].email_verified).toBe(false);
});

test('register: duplicate email returns same shape (no enumeration leak)', async () => {
  const email = `e2e-auth-dup-${Date.now()}@test.local`;
  // First call creates the user.
  await api('POST', '/api/auth/register', { body: { email, name: 'Dup', password: 'ValidPass123' } });
  // Second call with the same email must look identical to the first — same
  // status, same response shape — so an attacker can't tell which emails are
  // already registered. The hardened registerUser() returns alreadyExisted=true
  // internally and the route maps it to the standard needsVerification:true.
  const r = await api('POST', '/api/auth/register', { body: { email, name: 'Dup2', password: 'OtherPass123' } });
  expect(r.status).toBe(200);
  const body = r.json();
  expect(body.needsVerification).toBe(true);
  expect(body.email).toBe(email);
  // Sanity: the original user's name/password were NOT overwritten.
  const row = await pool.query('SELECT name FROM users WHERE email = $1', [email]);
  expect(row.rows[0].name).toBe('Dup');
});

test('register: invalid email format → 400', async () => {
  const r = await api('POST', '/api/auth/register', {
    body: { email: 'not-an-email', name: 'Bad', password: 'ValidPass123' },
  });
  expect(r.status).toBe(400);
});

test('register: weak password → 400 with reason', async () => {
  const r = await api('POST', '/api/auth/register', {
    body: { email: `e2e-auth-weak-${Date.now()}@test.local`, name: 'Weak', password: 'short' },
  });
  expect(r.status).toBe(400);
  const body = r.json();
  expect(body.error.toLowerCase()).toMatch(/password/);
});

test('login: full flow — register → verify → login → /me → logout → /me 401', async () => {
  const stamp = Date.now();
  const email = `e2e-auth-flow-${stamp}@test.local`;
  const password = 'StrongPass1234';

  // 1. Register
  const reg = await api('POST', '/api/auth/register', { body: { email, name: 'Flow', password } });
  expect(reg.status).toBe(200);

  // 2. Bypass email verification by flipping the DB flag (no SMTP in tests).
  // Real users would click the link in the verification email, which hits
  // GET /api/auth/verify-email?token=… — covered separately by the
  // server vitest suite.
  await getEmailVerificationToken(email);

  // 3. Login
  const login = await api('POST', '/api/auth/login', { body: { email, password } });
  expect(login.status, login.text).toBe(200);
  const loginBody = login.json();
  expect(loginBody.email).toBe(email);
  expect(loginBody.name).toBe('Flow');
  expect(loginBody.totpEnabled).toBe(false);
  const sessionCookie = pickSessionCookie(login);
  expect(sessionCookie, 'login should set __session cookie').toBeTruthy();

  // 4. /me with the new session returns the user. This call also "syncs"
  //    the csrf-token cookie to the freshly-regenerated post-login session
  //    (login regenerates, so the csrf cookie from the login response was
  //    bound to the pre-login session). The browser client does the same
  //    thing transparently — it issues /me right after login.
  const me = await api('GET', '/api/auth/me', { cookie: sessionCookie });
  expect(me.status).toBe(200);
  const meBody = me.json();
  expect(meBody.email).toBe(email);
  // After /me, we have a csrf-token bound to the post-login session.
  const csrf = pickCsrfToken(me);
  expect(csrf, '/me should set a csrf-token cookie').toBeTruthy();

  // 5. Logout (state-changing → needs CSRF token from the live session)
  const logout = await api('POST', '/api/auth/logout', { cookie: sessionCookie, csrf });
  expect(logout.status, logout.text).toBe(200);

  // 6. The same cookie now fails /me
  const me2 = await api('GET', '/api/auth/me', { cookie: sessionCookie });
  expect(me2.status).toBe(401);
});

test('login: wrong password → 401, no session', async () => {
  // Use the user from the previous "register happy path" test — already in DB.
  // Mark verified first so we actually exercise the password check rather
  // than getting bounced by the unverified-email gate.
  const email = (await pool.query(`SELECT email FROM users WHERE email LIKE 'e2e-auth-register-%' LIMIT 1`)).rows[0]
    ?.email;
  if (!email) test.skip(true, 'register-happy-path test must run first');
  await pool.query(`UPDATE users SET email_verified = TRUE WHERE email = $1`, [email]);

  const r = await api('POST', '/api/auth/login', { body: { email, password: 'definitely-wrong' } });
  expect(r.status).toBe(401);
  const body = r.json();
  expect(body.error.toLowerCase()).toMatch(/credentials/);
  // The response will have an anonymous session cookie (express-session
  // always issues one to track CSRF) — but it must NOT be authenticated.
  // Verify by hitting /me with this cookie: must come back 401.
  const cookie = pickSessionCookie(r);
  if (cookie) {
    const me = await api('GET', '/api/auth/me', { cookie });
    expect(me.status, 'failed login should not produce an authenticated session').toBe(401);
  }
});

test('login: unknown email → 401 (timing-equalised with wrong-password path)', async () => {
  // Server runs a dummy bcrypt.compare on the unknown-email path so this
  // takes roughly the same time as wrong-password. We only assert the
  // response, not timing — but the test exercises the code path.
  const r = await api('POST', '/api/auth/login', {
    body: { email: 'never-registered@test.local', password: 'whatever123' },
  });
  expect(r.status).toBe(401);
});

test('login: unverified email → 403 with unverified: true flag', async () => {
  // Register a fresh user but DON'T flip the verified flag.
  const email = `e2e-auth-unverif-${Date.now()}@test.local`;
  await api('POST', '/api/auth/register', { body: { email, name: 'Unv', password: 'StrongPass1234' } });

  const r = await api('POST', '/api/auth/login', { body: { email, password: 'StrongPass1234' } });
  expect(r.status).toBe(403);
  const body = r.json();
  expect(body.unverified).toBe(true);
});

test('delete-account: wrong password is rejected, account remains', async () => {
  const stamp = Date.now();
  const email = `e2e-auth-delwrong-${stamp}@test.local`;
  const password = 'StrongPass1234';
  await api('POST', '/api/auth/register', { body: { email, name: 'Del Wrong', password } });
  await getEmailVerificationToken(email);
  const login = await api('POST', '/api/auth/login', { body: { email, password } });
  const cookie = pickSessionCookie(login);
  // Sync the csrf-token to the post-login (regenerated) session via /me.
  const me = await api('GET', '/api/auth/me', { cookie });
  const csrf = pickCsrfToken(me);

  const r = await api('POST', '/api/auth/delete-account', {
    cookie,
    csrf,
    body: { password: 'definitely-not-the-password' },
  });
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(r.status).toBeLessThan(500);

  // User row still exists.
  const row = await pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
  expect(row.rowCount).toBe(1);
});

test('delete-account: correct password removes the user and invalidates the session', async () => {
  const stamp = Date.now();
  const email = `e2e-auth-delok-${stamp}@test.local`;
  const password = 'StrongPass1234';
  await api('POST', '/api/auth/register', { body: { email, name: 'Del OK', password } });
  await getEmailVerificationToken(email);
  const login = await api('POST', '/api/auth/login', { body: { email, password } });
  const cookie = pickSessionCookie(login);
  const me = await api('GET', '/api/auth/me', { cookie });
  const csrf = pickCsrfToken(me);

  const r = await api('POST', '/api/auth/delete-account', { cookie, csrf, body: { password } });
  expect(r.status, r.text).toBe(200);
  const body = r.json();
  expect(body.ok).toBe(true);

  // Soft delete: the row survives in the 30-day recovery bin with
  // deleted_at set; the hourly purge cron is what eventually removes it.
  // See server/services/authService.js — softDeleteUserInTx + the docs in
  // the rebuild/recovery-bin feature commit.
  const row = await pool.query('SELECT deleted_at FROM users WHERE email = $1', [email]);
  expect(row.rowCount).toBe(1);
  expect(row.rows[0].deleted_at).not.toBeNull();

  // The post-delete session is destroyed — /me should 401 with the cookie.
  const meAfter = await api('GET', '/api/auth/me', { cookie });
  expect(meAfter.status).toBe(401);

  // And login with that email now fails: deleted accounts present as
  // plain "invalid credentials" so the bin's existence isn't leaked.
  const reLogin = await api('POST', '/api/auth/login', { body: { email, password } });
  expect(reLogin.status).toBe(401);
});

test('delete-account: requires authentication (no cookie → 401)', async () => {
  const r = await api('POST', '/api/auth/delete-account', { body: { password: 'whatever' } });
  expect([401, 403]).toContain(r.status);
});
