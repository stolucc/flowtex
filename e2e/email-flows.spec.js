// Tests for the email-bound auth routes:
//   - GET  /api/auth/verify-email
//   - POST /api/auth/resend-verification
//   - POST /api/auth/forgot-password
//   - POST /api/auth/reset-password
//   - POST /api/auth/change-email
//
// SMTP isn't wired in tests, so we don't assert that an email was sent.
// Instead, after each route call that produces a token, we read the token
// row directly out of Postgres (the server stores SHA-256 hashes; we
// generate the raw token ourselves and insert the hash to test the
// verify/reset paths). This exercises the full token-validation logic
// without requiring a mail catcher.
//
// Rate limit awareness: ~10 hits to /api/auth across this suite. Combined
// with auth-flow.spec.js running in the same suite this could approach the
// 20/15min cap. CI runs against a fresh service container so it never
// approaches it. Locally, set DISABLE_RATE_LIMIT=1 if you re-run rapidly.
import { test, expect } from 'playwright/test';
import pg from 'pg';
import crypto from 'node:crypto';
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
  if (pool) {
    await pool.query(`DELETE FROM users WHERE email LIKE 'e2e-email-%@test.local'`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'e2e-newemail-%@test.local'`);
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
  const text = await res.text();
  return { status: res.status, ok: res.ok, headers: res.headers, text, json: () => JSON.parse(text) };
}

function pickCookies(res) {
  const setCookies = res.headers.getSetCookie?.() || [];
  const parts = [];
  for (const c of setCookies) {
    const m = c.match(/^([^=]+)=([^;]+)/);
    if (m && (m[1] === '__session' || m[1] === 'csrf-token')) parts.push(`${m[1]}=${m[2]}`);
  }
  return parts.length ? parts.join('; ') : null;
}
function pickCsrf(res) {
  const setCookies = res.headers.getSetCookie?.() || [];
  for (const c of setCookies) {
    const m = c.match(/^csrf-token=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

async function registerAndGetUserId(email, name = 'Email Test', password = 'StrongPass1') {
  const r = await api('POST', '/api/auth/register', { body: { email, name, password } });
  expect(r.status).toBe(200);
  const row = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  return row.rows[0].id;
}

// Get a fresh anonymous CSRF cookie + token. /resend-verification is the
// only pre-auth endpoint that ISN'T in the csrfExempt allowlist, so a
// caller without a session needs to first prime the csrf-token cookie via
// any GET (the CSRF middleware sets it on every response). The web client
// does this implicitly by loading the SPA shell first; in tests we hit
// /api/health to do the same in one round-trip.
async function getAnonymousCsrf() {
  const r = await fetch(`${BASE}/api/health`, { headers: { Origin: BASE } });
  await r.text();
  const setCookies = r.headers.getSetCookie?.() || [];
  let cookie = '';
  let csrf = '';
  for (const c of setCookies) {
    const m = c.match(/^([^=]+)=([^;]+)/);
    if (!m) continue;
    if (m[1] === '__session' || m[1] === 'csrf-token') {
      cookie += (cookie ? '; ' : '') + `${m[1]}=${m[2]}`;
      if (m[1] === 'csrf-token') csrf = decodeURIComponent(m[2]);
    }
  }
  return { cookie, csrf };
}

// Insert a verification or reset token directly into the DB. The server
// looks up the SHA-256 hash; the client (real users: the email link)
// presents the raw bytes. Returning the raw token lets the test hit the
// verify/reset endpoint as a real user would.
async function insertVerificationToken(userId, { ttlHours = 24 } = {}) {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await pool.query(
    `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' hours')::INTERVAL)`,
    [crypto.randomUUID(), userId, hash, String(ttlHours)],
  );
  return raw;
}
async function insertResetToken(userId, { ttlHours = 1 } = {}) {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await pool.query(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' hours')::INTERVAL)`,
    [crypto.randomUUID(), userId, hash, String(ttlHours)],
  );
  return raw;
}

// Tests ───────────────────────────────────────────────────────────────────

test('verify-email: valid token marks user verified and returns ok', async () => {
  const email = `e2e-email-verify-${Date.now()}@test.local`;
  const userId = await registerAndGetUserId(email);
  const token = await insertVerificationToken(userId);

  const r = await api('GET', `/api/auth/verify-email?token=${token}`);
  expect(r.status).toBe(200);
  expect(r.json().ok).toBe(true);

  const row = await pool.query('SELECT email_verified FROM users WHERE id = $1', [userId]);
  expect(row.rows[0].email_verified).toBe(true);
});

test('verify-email: replay of an already-used token is idempotent (200)', async () => {
  // verifyEmail is deliberately idempotent so that mail-provider scanners
  // (Outlook Safe Links, Gmail virus scan, Apple Mail preview) GETting the
  // URL before the human clicks don't burn the single-use token and leave
  // the human with "expired" 30s later. The token stays valid for its
  // configured window; replay succeeds.
  const email = `e2e-email-replay-${Date.now()}@test.local`;
  const userId = await registerAndGetUserId(email);
  const token = await insertVerificationToken(userId);

  const first = await api('GET', `/api/auth/verify-email?token=${token}`);
  expect(first.status).toBe(200);
  const second = await api('GET', `/api/auth/verify-email?token=${token}`);
  expect(second.status).toBe(200);

  // And the user really is verified after the replay.
  const row = await pool.query('SELECT email_verified FROM users WHERE id = $1', [userId]);
  expect(row.rows[0].email_verified).toBe(true);
});

test('verify-email: unknown / malformed token → 400 (no leak)', async () => {
  const r = await api('GET', `/api/auth/verify-email?token=${'a'.repeat(64)}`);
  expect(r.status).toBe(400);
  // Missing token → 400 with a different message but same status class
  const r2 = await api('GET', `/api/auth/verify-email`);
  expect(r2.status).toBe(400);
});

test('verify-email: expired token → 400', async () => {
  const email = `e2e-email-expired-${Date.now()}@test.local`;
  const userId = await registerAndGetUserId(email);
  const token = await insertVerificationToken(userId, { ttlHours: -1 }); // already expired

  const r = await api('GET', `/api/auth/verify-email?token=${token}`);
  expect(r.status).toBe(400);
  // User must NOT be marked verified.
  const row = await pool.query('SELECT email_verified FROM users WHERE id = $1', [userId]);
  expect(row.rows[0].email_verified).toBe(false);
});

test('resend-verification: returns ok and creates a new token row for an existing unverified user', async () => {
  const email = `e2e-email-resend-${Date.now()}@test.local`;
  const userId = await registerAndGetUserId(email);
  // Register itself creates one token. Resend must create a SECOND.
  const before = await pool.query(
    'SELECT COUNT(*)::int AS n FROM email_verification_tokens WHERE user_id = $1',
    [userId],
  );

  const { cookie, csrf } = await getAnonymousCsrf();
  const r = await api('POST', '/api/auth/resend-verification', { body: { email }, cookie, csrf });
  expect(r.status, r.text).toBe(200);
  expect(r.json().ok).toBe(true);

  const after = await pool.query(
    'SELECT COUNT(*)::int AS n FROM email_verification_tokens WHERE user_id = $1',
    [userId],
  );
  expect(after.rows[0].n).toBeGreaterThan(before.rows[0].n);
});

test('resend-verification: unknown email returns ok (no enumeration leak)', async () => {
  const { cookie, csrf } = await getAnonymousCsrf();
  const r = await api('POST', '/api/auth/resend-verification', {
    body: { email: 'never-existed@test.local' },
    cookie,
    csrf,
  });
  expect(r.status).toBe(200);
  expect(r.json().ok).toBe(true);
});

test('resend-verification: already-verified user returns ok but creates no new token', async () => {
  const email = `e2e-email-alreadyok-${Date.now()}@test.local`;
  const userId = await registerAndGetUserId(email);
  await pool.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [userId]);
  const before = await pool.query(
    'SELECT COUNT(*)::int AS n FROM email_verification_tokens WHERE user_id = $1',
    [userId],
  );

  const { cookie, csrf } = await getAnonymousCsrf();
  const r = await api('POST', '/api/auth/resend-verification', { body: { email }, cookie, csrf });
  expect(r.status).toBe(200);
  expect(r.json().ok).toBe(true);

  const after = await pool.query(
    'SELECT COUNT(*)::int AS n FROM email_verification_tokens WHERE user_id = $1',
    [userId],
  );
  // Server short-circuits at the email_verified check — no token issued.
  expect(after.rows[0].n).toBe(before.rows[0].n);
});

test('forgot-password: returns ok and creates a reset token row', async () => {
  const email = `e2e-email-forgot-${Date.now()}@test.local`;
  const userId = await registerAndGetUserId(email);
  await pool.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [userId]);

  const r = await api('POST', '/api/auth/forgot-password', { body: { email } });
  expect(r.status).toBe(200);
  expect(r.json().ok).toBe(true);

  const tokens = await pool.query(
    'SELECT id FROM password_reset_tokens WHERE user_id = $1',
    [userId],
  );
  expect(tokens.rowCount).toBeGreaterThan(0);
});

test('forgot-password: unknown email returns ok (no enumeration leak)', async () => {
  const r = await api('POST', '/api/auth/forgot-password', { body: { email: 'no-such-user@test.local' } });
  expect(r.status).toBe(200);
  expect(r.json().ok).toBe(true);
});

test('reset-password: full flow — old password no longer works, new one does, sessions invalidated', async () => {
  const email = `e2e-email-reset-${Date.now()}@test.local`;
  const oldPassword = 'OldStrong1';
  const newPassword = 'NewStrong2';

  // Register, verify, log in (so we have an active session to invalidate later).
  await api('POST', '/api/auth/register', { body: { email, name: 'Reset Flow', password: oldPassword } });
  const u = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  const userId = u.rows[0].id;
  await pool.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [userId]);
  const login = await api('POST', '/api/auth/login', { body: { email, password: oldPassword } });
  expect(login.status).toBe(200);
  const sessionCookie = pickCookies(login);

  // Issue a real reset token through the back door.
  const token = await insertResetToken(userId);

  // Reset.
  const reset = await api('POST', '/api/auth/reset-password', { body: { token, password: newPassword } });
  expect(reset.status, reset.text).toBe(200);
  expect(reset.json().ok).toBe(true);

  // Old password fails.
  const tryOld = await api('POST', '/api/auth/login', { body: { email, password: oldPassword } });
  expect(tryOld.status).toBe(401);

  // New password succeeds.
  const tryNew = await api('POST', '/api/auth/login', { body: { email, password: newPassword } });
  expect(tryNew.status).toBe(200);

  // Pre-reset session is invalidated.
  const me = await api('GET', '/api/auth/me', { cookie: sessionCookie });
  expect(me.status).toBe(401);
});

test('reset-password: invalid token → 400', async () => {
  const r = await api('POST', '/api/auth/reset-password', {
    body: { token: 'a'.repeat(64), password: 'AnyStrong1' },
  });
  expect(r.status).toBe(400);
});

test('reset-password: replay of an already-used token → 400', async () => {
  const email = `e2e-email-replayreset-${Date.now()}@test.local`;
  const userId = await registerAndGetUserId(email);
  await pool.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [userId]);
  const token = await insertResetToken(userId);
  const password = 'FirstReset1';

  const first = await api('POST', '/api/auth/reset-password', { body: { token, password } });
  expect(first.status).toBe(200);

  const second = await api('POST', '/api/auth/reset-password', { body: { token, password: 'OtherPass2' } });
  expect(second.status).toBe(400);
});

test('reset-password: weak new password → 400', async () => {
  const email = `e2e-email-weakreset-${Date.now()}@test.local`;
  const userId = await registerAndGetUserId(email);
  const token = await insertResetToken(userId);

  const r = await api('POST', '/api/auth/reset-password', { body: { token, password: 'short' } });
  expect(r.status).toBe(400);
});

test('change-email: changes the email and creates a fresh verification token', async () => {
  const oldEmail = `e2e-email-change-${Date.now()}@test.local`;
  const newEmail = `e2e-newemail-${Date.now()}@test.local`;
  const password = 'StrongPass1';
  await api('POST', '/api/auth/register', { body: { email: oldEmail, name: 'Change Mail', password } });
  const u = await pool.query('SELECT id FROM users WHERE email = $1', [oldEmail]);
  const userId = u.rows[0].id;
  await pool.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [userId]);

  // Login + sync csrf
  const login = await api('POST', '/api/auth/login', { body: { email: oldEmail, password } });
  const cookie = pickCookies(login);
  const me = await api('GET', '/api/auth/me', { cookie });
  const csrf = pickCsrf(me);

  const r = await api('POST', '/api/auth/change-email', {
    cookie,
    csrf,
    body: { password, newEmail },
  });
  expect(r.status, r.text).toBe(200);
  const body = r.json();
  expect(body.email).toBe(newEmail);
  expect(body.needsVerification).toBe(true);

  // DB state: row's email is updated AND email_verified is reset to false.
  const row = await pool.query('SELECT email, email_verified FROM users WHERE id = $1', [userId]);
  expect(row.rows[0].email).toBe(newEmail);
  expect(row.rows[0].email_verified).toBe(false);

  // A fresh verification token row exists for this user.
  const tokens = await pool.query(
    'SELECT id FROM email_verification_tokens WHERE user_id = $1 AND used = FALSE',
    [userId],
  );
  expect(tokens.rowCount).toBeGreaterThan(0);
});

test('change-email: wrong password is rejected, email unchanged', async () => {
  const oldEmail = `e2e-email-changewrong-${Date.now()}@test.local`;
  const newEmail = `e2e-newemail-wrong-${Date.now()}@test.local`;
  const password = 'StrongPass1';
  await api('POST', '/api/auth/register', { body: { email: oldEmail, name: 'Change Wrong', password } });
  const u = await pool.query('SELECT id FROM users WHERE email = $1', [oldEmail]);
  await pool.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [u.rows[0].id]);
  const login = await api('POST', '/api/auth/login', { body: { email: oldEmail, password } });
  const cookie = pickCookies(login);
  const me = await api('GET', '/api/auth/me', { cookie });
  const csrf = pickCsrf(me);

  const r = await api('POST', '/api/auth/change-email', {
    cookie,
    csrf,
    body: { password: 'definitely-wrong', newEmail },
  });
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(r.status).toBeLessThan(500);

  const row = await pool.query('SELECT email FROM users WHERE id = $1', [u.rows[0].id]);
  expect(row.rows[0].email).toBe(oldEmail);
});

test('change-email: requires authentication', async () => {
  const r = await api('POST', '/api/auth/change-email', {
    body: { password: 'whatever', newEmail: 'doesnt@matter.local' },
  });
  expect([401, 403]).toContain(r.status);
});
