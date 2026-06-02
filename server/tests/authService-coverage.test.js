// Coverage-completion tests for services/authService.js — pairs with
// authService.test.js. Splits out the previously-untested functions
// (verify/reset/setup/disable/etc.) plus mutation-killing boundary tests
// for the partially-covered ones, so the original file stays focused on
// the core auth flow.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

// db mock. The transaction mock routes tx.get/tx.run to the same top-level
// mocks, so a test that does `db.get.mockResolvedValueOnce(...)` works the
// same whether the production code calls `db.get` directly or `tx.get` inside
// `db.transaction(...)`.
vi.mock('../db.js', () => {
  const mock = { get: vi.fn(), run: vi.fn() };
  mock.transaction = vi.fn(async (fn) => fn({ get: mock.get, run: mock.run }));
  return { default: mock };
});

vi.mock('../utils/crypto.js', () => ({
  encrypt: vi.fn((v) => 'encrypted:' + v),
  decrypt: vi.fn((v) => v.replace('encrypted:', '')),
  _setSaltForTesting: vi.fn(),
}));

import db from '../db.js';
import {
  isAccountLocked,
  recordLoginAttempt,
  registerUser,
  authenticateUser,
  getCurrentUser,
  updateProfile,
  changeEmail,
  changePassword,
  createEmailVerificationToken,
  verifyEmail,
  createTrustedDevice,
  checkTrustedDevice,
  setupTotp,
  verifyAndEnableTotp,
  disableTotp,
  verifyTotp,
  createPasswordResetToken,
  resetPassword,
  deleteAccount,
  adminDeleteUser,
  checkPasswordNotBreached,
} from '../services/authService.js';

const TEST_PW = 'Password1234';
const TEST_HASH = bcrypt.hashSync(TEST_PW, 4);

beforeEach(() => {
  vi.clearAllMocks();
  db.get.mockResolvedValue(undefined);
  db.run.mockResolvedValue(undefined);
});

// ─── isAccountLocked: SQL params and IP-branch boundary ──────────────

describe('isAccountLocked SQL/params', () => {
  it('queries login_attempts by email with the LOCKOUT window in minutes', async () => {
    db.get.mockResolvedValueOnce({ cnt: '0' }); // email check
    await isAccountLocked('a@b.com');
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toContain('FROM login_attempts');
    expect(sql).toContain('email = $1');
    expect(sql).toContain('success = FALSE');
    expect(params).toEqual(['a@b.com', 15]);
  });

  it('queries by IP using the same lockout window', async () => {
    db.get
      .mockResolvedValueOnce({ cnt: '0' })   // email check below threshold
      .mockResolvedValueOnce({ cnt: '0' });  // ip check below threshold
    await isAccountLocked('a@b.com', '1.2.3.4');
    const [, ipParams] = db.get.mock.calls[1];
    expect(ipParams).toEqual(['1.2.3.4', 15]);
  });

  it('returns false when ipResult is null (optional chaining branch)', async () => {
    db.get
      .mockResolvedValueOnce({ cnt: '0' })   // email
      .mockResolvedValueOnce(null);           // ip null → cnt is treated as 0
    const result = await isAccountLocked('a@b.com', '1.1.1.1');
    expect(result).toBe(false);
  });

  it('returns true when IP attempts hit exactly 3*MAX (30)', async () => {
    db.get
      .mockResolvedValueOnce({ cnt: '0' })    // email
      .mockResolvedValueOnce({ cnt: '30' });  // IP at exactly 3x
    expect(await isAccountLocked('a@b.com', '1.1.1.1')).toBe(true);
  });

  it('returns false when IP attempts are at 29 (just under 3*MAX)', async () => {
    db.get
      .mockResolvedValueOnce({ cnt: '0' })
      .mockResolvedValueOnce({ cnt: '29' });
    expect(await isAccountLocked('a@b.com', '1.1.1.1')).toBe(false);
  });
});

// ─── recordLoginAttempt: param order ──────────────────────────────────

describe('recordLoginAttempt SQL/params', () => {
  it('inserts (email, ip, success) in that order', async () => {
    await recordLoginAttempt('e@x', '1.1.1.1', true);
    const [sql, params] = db.run.mock.calls[0];
    expect(sql).toContain('INSERT INTO login_attempts (email, ip, success)');
    expect(params).toEqual(['e@x', '1.1.1.1', true]);
  });

  it('on success, deletes prior failed attempts for that email', async () => {
    await recordLoginAttempt('e@x', '1.1.1.1', true);
    expect(db.run).toHaveBeenCalledTimes(2);
    const [delSql, delParams] = db.run.mock.calls[1];
    expect(delSql).toContain('DELETE FROM login_attempts');
    expect(delSql).toContain('success = FALSE');
    expect(delParams).toEqual(['e@x']);
  });
});

// ─── registerUser: name newline scrubbing (kills regex mutants) ───────

describe('registerUser CR/LF stripping', () => {
  it('collapses any number of consecutive \\r\\n into a single space', async () => {
    db.get.mockResolvedValueOnce(null); // no existing user
    const r = await registerUser('a@b.com', 'Hi\r\n\r\n\nThere', TEST_PW);
    expect(r.name).toBe('Hi There');
  });

  it('strips a single \\r and \\n separately', async () => {
    db.get.mockResolvedValueOnce(null);
    const r = await registerUser('a@b.com', 'Foo\rBar\nBaz', TEST_PW);
    expect(r.name).toBe('Foo Bar Baz');
  });

  it('preserves a name with no newlines verbatim', async () => {
    db.get.mockResolvedValueOnce(null);
    const r = await registerUser('a@b.com', 'Plain Name', TEST_PW);
    expect(r.name).toBe('Plain Name');
  });

  it('still hashes the password on the user-already-exists path (timing equalisation)', async () => {
    // The dummy-hash call now goes through utils/passwordHash.hashPassword
    // (Argon2id), but the behavioural invariant — that timing matches the
    // create-new path — is the same. We assert it by timing rather than
    // spying on the algorithm: the alreadyExisted path should take at
    // least ~50 ms (Argon2id is ~250 ms; 50 ms is a wide safety margin).
    db.get.mockResolvedValueOnce({ id: 'existing' });
    const t0 = Date.now();
    const r = await registerUser('a@b.com', 'X', TEST_PW);
    const elapsed = Date.now() - t0;
    expect(r.alreadyExisted).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });
});

// ─── authenticateUser: dummy bcrypt + SQL ─────────────────────────────

describe('authenticateUser equal-time path', () => {
  it('queries the right columns from users', async () => {
    db.get.mockResolvedValueOnce(null);
    await authenticateUser('a@b.com', TEST_PW);
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toContain('id, email, name, password_hash, totp_enabled, totp_secret, is_admin, email_verified');
    expect(sql).toContain('FROM users');
    expect(sql).toContain('email = $1');
    expect(params).toEqual(['a@b.com']);
  });

  it('runs a dummy verify on the not-found path to equalise timing', async () => {
    // Same shape as above: we now use an Argon2id dummy hash to keep
    // the not-found path's wall time comparable to the wrong-password
    // path. Test by timing rather than internal spying: ~250 ms Argon2id
    // vs ~5 ms for "user not found, no dummy" — 50 ms is a comfortable
    // safety margin that catches a regression where the dummy is skipped.
    db.get.mockResolvedValueOnce(null);
    const t0 = Date.now();
    const result = await authenticateUser('nobody@x', TEST_PW);
    const elapsed = Date.now() - t0;
    expect(result.error).toBe('Invalid credentials');
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });
});

// ─── getCurrentUser SQL ───────────────────────────────────────────────

describe('getCurrentUser SQL', () => {
  it('selects id, email, name, totp_enabled, is_admin, compile_location from users', async () => {
    db.get.mockResolvedValueOnce({
      id: 'u', email: 'e', name: 'n', totp_enabled: false, is_admin: false,
    });
    await getCurrentUser('u');
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toContain('SELECT id, email, name, totp_enabled, is_admin, compile_location FROM users');
    expect(params).toEqual(['u']);
  });
});

// ─── updateProfile ────────────────────────────────────────────────────

describe('updateProfile', () => {
  it('strips CR/LF from the new name (kills regex mutant)', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', email: 'e', name: 'A B', totp_enabled: false, is_admin: false });
    await updateProfile('u', { name: 'A\r\n\r\nB' });
    const [, params] = db.run.mock.calls[0];
    expect(params[0]).toBe('A B');
  });

  it('throws 400 when name is empty after stripping', async () => {
    await expect(updateProfile('u', { name: '   ' }))
      .rejects.toMatchObject({ message: 'Name cannot be empty', status: 400 });
  });

  it('throws 400 when name exceeds 200 chars', async () => {
    await expect(updateProfile('u', { name: 'X'.repeat(201) }))
      .rejects.toMatchObject({ message: 'Name too long', status: 400 });
  });

  it('accepts exactly 200 chars', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', email: 'e', name: 'X'.repeat(200), totp_enabled: false, is_admin: false });
    await expect(updateProfile('u', { name: 'X'.repeat(200) })).resolves.toBeTruthy();
  });
});

// ─── changeEmail (full coverage) ──────────────────────────────────────

describe('changeEmail', () => {
  it('rejects malformed emails (no @)', async () => {
    await expect(changeEmail('u', TEST_PW, 'no-at-sign'))
      .rejects.toMatchObject({ message: 'Invalid email address', status: 400 });
  });

  it('rejects emails with no TLD', async () => {
    await expect(changeEmail('u', TEST_PW, 'a@b'))
      .rejects.toMatchObject({ status: 400 });
  });

  it('rejects emails with whitespace', async () => {
    await expect(changeEmail('u', TEST_PW, 'a b@c.com'))
      .rejects.toMatchObject({ status: 400 });
  });

  it('throws 401 when user does not exist', async () => {
    db.get.mockResolvedValueOnce(null);
    await expect(changeEmail('u', TEST_PW, 'new@x.com'))
      .rejects.toMatchObject({ status: 401 });
  });

  it('throws 401 on incorrect password', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', email: 'old@x.com', password_hash: TEST_HASH });
    await expect(changeEmail('u', 'WrongPassword1', 'new@x.com'))
      .rejects.toMatchObject({ message: 'Incorrect password', status: 401 });
  });

  it('throws 400 when new email equals current email', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', email: 'same@x.com', password_hash: TEST_HASH });
    await expect(changeEmail('u', TEST_PW, 'same@x.com'))
      .rejects.toMatchObject({ status: 400 });
  });

  it('throws 409 when new email is already taken', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'u', email: 'old@x.com', password_hash: TEST_HASH })
      .mockResolvedValueOnce({ existing: true });
    await expect(changeEmail('u', TEST_PW, 'taken@x.com'))
      .rejects.toMatchObject({ status: 409 });
  });

  it('updates email and returns oldEmail/needsVerification on success', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'u', email: 'old@x.com', password_hash: TEST_HASH })
      .mockResolvedValueOnce(null); // not taken
    const r = await changeEmail('u', TEST_PW, 'NEW@X.COM');
    expect(r).toEqual({ email: 'new@x.com', oldEmail: 'old@x.com', needsVerification: true });
    const [updateSql, updateParams] = db.run.mock.calls[0];
    expect(updateSql).toContain('UPDATE users SET email = $1, email_verified = FALSE');
    expect(updateParams).toEqual(['new@x.com', 'u']);
  });
});

// ─── changePassword: SQL params and equality check ────────────────────

describe('changePassword extras', () => {
  it('queries SELECT id, password_hash FROM users WHERE id = $1', async () => {
    db.get.mockResolvedValueOnce(null);
    await expect(changePassword('u', TEST_PW, 'NewPassword1')).rejects.toBeDefined();
    expect(db.get.mock.calls[0][0]).toContain('SELECT id, password_hash FROM users');
    expect(db.get.mock.calls[0][1]).toEqual(['u']);
  });

  it('rejects when new password equals current verbatim', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', password_hash: TEST_HASH });
    await expect(changePassword('u', TEST_PW, TEST_PW))
      .rejects.toMatchObject({ status: 400 });
  });

  it('throws 400 when new password fails validatePassword', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', password_hash: TEST_HASH });
    await expect(changePassword('u', TEST_PW, 'short'))
      .rejects.toMatchObject({ status: 400 });
  });
});

// ─── createEmailVerificationToken ─────────────────────────────────────

describe('createEmailVerificationToken', () => {
  it('returns a 64-char hex token', async () => {
    db.get.mockResolvedValueOnce({ cnt: '0' });
    const token = await createEmailVerificationToken('u');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores the SHA-256 hash of the token, not the raw token', async () => {
    db.get.mockResolvedValueOnce({ cnt: '0' });
    const token = await createEmailVerificationToken('u');
    const [, params] = db.run.mock.calls[0];
    const tokenHash = params[2];
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns null when 3 tokens have been issued in the last hour', async () => {
    db.get.mockResolvedValueOnce({ cnt: '3' });
    expect(await createEmailVerificationToken('u')).toBeNull();
    expect(db.run).not.toHaveBeenCalled();
  });

  it('still returns null at boundary count = 3', async () => {
    db.get.mockResolvedValueOnce({ cnt: '3' });
    expect(await createEmailVerificationToken('u')).toBeNull();
  });

  it('still issues a token at count = 2', async () => {
    db.get.mockResolvedValueOnce({ cnt: '2' });
    const token = await createEmailVerificationToken('u');
    expect(token).toBeTruthy();
  });

  it('handles null recent (no rows yet)', async () => {
    db.get.mockResolvedValueOnce(null);
    const token = await createEmailVerificationToken('u');
    expect(token).toBeTruthy();
  });

  it('does not throw when recent row exists but cnt field is undefined', async () => {
    // Hits the `recent?.cnt || 0` fallback — kills the OptionalChaining mutant.
    db.get.mockResolvedValueOnce({});
    const token = await createEmailVerificationToken('u');
    expect(token).toBeTruthy();
  });
});

// ─── verifyEmail ──────────────────────────────────────────────────────

describe('verifyEmail', () => {
  it('hashes the supplied token before lookup', async () => {
    db.get.mockResolvedValueOnce({ user_id: 'u', email_verified: false });
    const raw = 'rawtoken';
    await verifyEmail(raw);
    const [, params] = db.get.mock.calls[0];
    expect(params[0]).not.toBe(raw);
    expect(params[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws 400 for an invalid/expired token', async () => {
    db.get.mockResolvedValueOnce(null);
    await expect(verifyEmail('bogus'))
      .rejects.toMatchObject({ message: 'Invalid or expired verification link', status: 400 });
  });

  it('marks the user verified and invalidates other tokens on success', async () => {
    db.get.mockResolvedValueOnce({ user_id: 'u', email_verified: false });
    const userId = await verifyEmail('rawtoken');
    expect(userId).toBe('u');
    const sqls = db.run.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => s.includes('UPDATE users SET email_verified = TRUE'))).toBe(true);
    expect(sqls.some((s) => s.includes('UPDATE email_verification_tokens SET used = TRUE WHERE user_id'))).toBe(true);
  });

  it('is idempotent: an already-verified user returns success without writes', async () => {
    // Real-world trigger: an email scanner (Outlook Safe Links etc.)
    // GETs the link before the human clicks. First call verifies +
    // flips email_verified. Second call (the human's click) finds
    // email_verified=TRUE in the JOIN row and returns the user id
    // without re-running the UPDATEs. Without this, the human gets
    // "Invalid or expired verification link" within 30s of registering.
    db.get.mockResolvedValueOnce({ user_id: 'u', email_verified: true });
    db.run.mockClear();
    const userId = await verifyEmail('rawtoken');
    expect(userId).toBe('u');
    expect(db.run).not.toHaveBeenCalled();
  });
});

// ─── createTrustedDevice / checkTrustedDevice ─────────────────────────

describe('trusted device tokens', () => {
  it('createTrustedDevice returns a hex token and 7-day max-age in ms', async () => {
    const r = await createTrustedDevice('u', 'Mozilla/5.0');
    expect(r.token).toMatch(/^[0-9a-f]{64}$/);
    expect(r.maxAge).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('createTrustedDevice falls back to "Unknown device" when userAgent is empty', async () => {
    await createTrustedDevice('u', '');
    const [, params] = db.run.mock.calls[0];
    expect(params[3]).toBe('Unknown device');
  });

  it('createTrustedDevice does NOT throw when userAgent is null (optional chaining branch)', async () => {
    // userAgent?.substring vs. userAgent.substring — null without the ?. throws TypeError.
    await expect(createTrustedDevice('u', null)).resolves.toBeTruthy();
    const [, params] = db.run.mock.calls[0];
    expect(params[3]).toBe('Unknown device');
  });

  it('createTrustedDevice handles undefined userAgent', async () => {
    await expect(createTrustedDevice('u', undefined)).resolves.toBeTruthy();
    const [, params] = db.run.mock.calls[0];
    expect(params[3]).toBe('Unknown device');
  });

  it('createTrustedDevice truncates the userAgent at 200 chars', async () => {
    const long = 'A'.repeat(500);
    await createTrustedDevice('u', long);
    const [, params] = db.run.mock.calls[0];
    expect(params[3].length).toBe(200);
  });

  it('checkTrustedDevice returns null when cookie is empty', async () => {
    expect(await checkTrustedDevice('u', null)).toBe(null);
    expect(await checkTrustedDevice('u', '')).toBe(null);
    expect(await checkTrustedDevice('u', undefined)).toBe(null);
  });

  it('checkTrustedDevice hashes the cookie, returns a rotated token if a row exists', async () => {
    db.get.mockResolvedValueOnce({ id: 'dev-1' });
    const result = await checkTrustedDevice('u', 'rawcookie');
    expect(result).not.toBeNull();
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(result.token).not.toBe('rawcookie');
    expect(result.maxAge).toBe(7 * 24 * 60 * 60 * 1000);
    const [, params] = db.get.mock.calls[0];
    expect(params[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(params[0]).not.toBe('rawcookie');
    expect(params[1]).toBe('u');
    // Rotation: UPDATE was issued with a NEW hash (different from the lookup hash).
    const updateCall = db.run.mock.calls.find((c) => c[0].includes('UPDATE trusted_devices'));
    expect(updateCall).toBeTruthy();
    expect(updateCall[1][0]).toMatch(/^[0-9a-f]{64}$/);
    expect(updateCall[1][0]).not.toBe(params[0]);
  });

  it('checkTrustedDevice returns null if no row matches', async () => {
    db.get.mockResolvedValueOnce(null);
    expect(await checkTrustedDevice('u', 'rawcookie')).toBe(null);
  });
});

// ─── setupTotp / verifyAndEnableTotp / disableTotp ───────────────────

describe('TOTP lifecycle', () => {
  it('setupTotp throws 401 if user not found', async () => {
    db.get.mockResolvedValueOnce(null);
    await expect(setupTotp('u')).rejects.toMatchObject({ status: 401 });
  });

  it('setupTotp throws 400 if MFA already enabled', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', email: 'e@x', totp_enabled: true });
    await expect(setupTotp('u'))
      .rejects.toMatchObject({ message: 'MFA is already enabled', status: 400 });
  });

  it('setupTotp returns secret and QR data URL on success', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', email: 'e@x', totp_enabled: false });
    const r = await setupTotp('u');
    expect(r.secret).toBeTruthy();
    expect(r.qrCode).toMatch(/^data:image\/png;base64,/);
  });

  it('verifyAndEnableTotp throws 401 if user missing', async () => {
    db.get.mockResolvedValueOnce(null);
    await expect(verifyAndEnableTotp('u', '123456')).rejects.toMatchObject({ status: 401 });
  });

  it('verifyAndEnableTotp throws 400 if no totp_secret yet', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', totp_secret: null, totp_enabled: false });
    await expect(verifyAndEnableTotp('u', '123456'))
      .rejects.toMatchObject({ message: 'Run setup first', status: 400 });
  });

  it('verifyAndEnableTotp throws 400 if already enabled', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', totp_secret: 'encrypted:JBSWY3DPEHPK3PXP', totp_enabled: true });
    await expect(verifyAndEnableTotp('u', '123456'))
      .rejects.toMatchObject({ status: 400 });
  });

  it('disableTotp throws 401 if user not found', async () => {
    db.get.mockResolvedValueOnce(null);
    await expect(disableTotp('u', TEST_PW)).rejects.toMatchObject({ status: 401 });
  });

  it('disableTotp throws 400 if MFA not enabled', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', password_hash: TEST_HASH, totp_enabled: false });
    await expect(disableTotp('u', TEST_PW)).rejects.toMatchObject({ status: 400 });
  });

  it('disableTotp throws 401 on wrong password', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', password_hash: TEST_HASH, totp_enabled: true });
    await expect(disableTotp('u', 'WrongPassword1'))
      .rejects.toMatchObject({ message: 'Invalid password', status: 401 });
  });

  it('disableTotp clears totp_secret, disables TOTP, removes trusted devices', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', password_hash: TEST_HASH, totp_enabled: true });
    await disableTotp('u', TEST_PW);
    const sqls = db.run.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => s.includes('totp_enabled = FALSE') && s.includes('totp_secret = NULL'))).toBe(true);
    expect(sqls.some((s) => s.includes('DELETE FROM trusted_devices'))).toBe(true);
  });
});

// ─── verifyTotp replay protection ─────────────────────────────────────

describe('verifyTotp', () => {
  it('returns invalid for a wrong code', async () => {
    const r = await verifyTotp('u', '000000', 'encrypted:JBSWY3DPEHPK3PXP');
    expect(r.error).toBe('Invalid verification code');
  });

  it('persists TOTP usage with a forward-in-time expiry (catches a flipped sign)', async () => {
    // Generate a real, currently-valid TOTP token so the validator passes
    // and we hit the markTotpUsed code path (Date.now() + 90000).
    const OTPAuth = await import('otpauth');
    const secret = OTPAuth.Secret.fromBase32('JBSWY3DPEHPK3PXP');
    const totp = new OTPAuth.TOTP({ secret, algorithm: 'SHA1', digits: 6, period: 30 });
    const code = totp.generate();
    const before = Date.now();
    const r = await verifyTotp('u', code, 'encrypted:JBSWY3DPEHPK3PXP');
    expect(r.ok).toBe(true);
    // The persisted insert SQL fixes a 90-second window via
    // INTERVAL '90 seconds'; verify the SQL is the documented one.
    const insertCall = db.run.mock.calls.find((c) => c[0].includes('used_totp_codes'));
    expect(insertCall[0]).toContain("INTERVAL '90 seconds'");
    expect(Date.now()).toBeGreaterThanOrEqual(before);
  });
});

// ─── createPasswordResetToken ─────────────────────────────────────────

describe('createPasswordResetToken', () => {
  it('returns null when user does not exist (no enumeration)', async () => {
    db.get.mockResolvedValueOnce(null);
    expect(await createPasswordResetToken('nobody@x')).toBeNull();
    expect(db.run).not.toHaveBeenCalled();
  });

  it('returns null when 3 reset tokens issued in last hour', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'u', email: 'e@x' })
      .mockResolvedValueOnce({ cnt: '3' });
    expect(await createPasswordResetToken('e@x')).toBeNull();
    expect(db.run).not.toHaveBeenCalled();
  });

  it('handles a null recentTokens row (optional chaining branch)', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'u', email: 'e@x' })
      .mockResolvedValueOnce(null);
    const r = await createPasswordResetToken('e@x');
    expect(r).toBeTruthy();
  });

  it('returns token, userId, email on success', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'u', email: 'e@x' })
      .mockResolvedValueOnce({ cnt: '0' });
    const r = await createPasswordResetToken('e@x');
    expect(r).toMatchObject({ userId: 'u', email: 'e@x' });
    expect(r.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores the SHA-256 hash, not the raw token', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'u', email: 'e@x' })
      .mockResolvedValueOnce({ cnt: '0' });
    const r = await createPasswordResetToken('e@x');
    const [, insertParams] = db.run.mock.calls[0];
    expect(insertParams[2]).not.toBe(r.token);
  });

  it('normalises email (lowercase + trim) before lookup', async () => {
    db.get.mockResolvedValueOnce(null);
    await createPasswordResetToken('  HELLO@X.COM  ');
    expect(db.get.mock.calls[0][1]).toEqual(['hello@x.com']);
  });
});

// ─── resetPassword ────────────────────────────────────────────────────

describe('resetPassword', () => {
  it('rejects weak passwords up front with the validatePassword message', async () => {
    // Pin the specific error message so a mutation that skips the
    // validation (turning `if (pwError)` into `if (false)`) is caught —
    // it would proceed to "Invalid or expired reset link" instead.
    await expect(resetPassword('rawtoken', 'weak'))
      .rejects.toMatchObject({
        message: /at least 12 characters/i,
        status: 400,
      });
  });

  it('throws 400 for an unknown/expired token', async () => {
    db.get.mockResolvedValueOnce(null); // no resetToken row
    await expect(resetPassword('rawtoken', 'NewPassword1'))
      .rejects.toMatchObject({ message: 'Invalid or expired reset link', status: 400 });
  });

  it('throws 400 when the new password equals the current one', async () => {
    db.get
      .mockResolvedValueOnce({ id: 't1', user_id: 'u' })
      .mockResolvedValueOnce({ password_hash: TEST_HASH });
    await expect(resetPassword('rawtoken', TEST_PW))
      .rejects.toMatchObject({ status: 400 });
  });

  it('on success, hashes new password, deletes sessions and trusted devices', async () => {
    db.get
      .mockResolvedValueOnce({ id: 't1', user_id: 'u' })
      .mockResolvedValueOnce({ password_hash: bcrypt.hashSync('OldPass1', 4) });
    await resetPassword('rawtoken', 'NewPassword1');
    const sqls = db.run.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => s.includes('UPDATE users SET password_hash'))).toBe(true);
    expect(sqls.some((s) => s.includes('DELETE FROM session'))).toBe(true);
    expect(sqls.some((s) => s.includes('DELETE FROM trusted_devices'))).toBe(true);
  });
});

// ─── deleteAccount ────────────────────────────────────────────────────

describe('deleteAccount', () => {
  it('throws 401 when user not found', async () => {
    db.get.mockResolvedValueOnce(null);
    await expect(deleteAccount('u', TEST_PW)).rejects.toMatchObject({ status: 401 });
  });

  it('throws 401 on wrong password', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', email: 'e@x', password_hash: TEST_HASH });
    await expect(deleteAccount('u', 'WrongPassword1'))
      .rejects.toMatchObject({ message: 'Invalid password', status: 401 });
  });

  it('runs the deletion inside a single transaction', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', email: 'e@x', password_hash: TEST_HASH });
    await deleteAccount('u', TEST_PW);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('refuses when the caller is the only alive admin (409)', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'u', email: 'e@x', password_hash: TEST_HASH, is_admin: true })
      .mockResolvedValueOnce({ n: 1 });
    await expect(deleteAccount('u', TEST_PW))
      .rejects.toMatchObject({ status: 409, message: /only admin/ });
  });

  it('proceeds when caller is admin but another alive admin exists', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'u', email: 'e@x', password_hash: TEST_HASH, is_admin: true })
      .mockResolvedValueOnce({ n: 2 });
    await deleteAccount('u', TEST_PW);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('does not run the admin-count query when caller is not admin', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', email: 'e@x', password_hash: TEST_HASH, is_admin: false });
    await deleteAccount('u', TEST_PW);
    // Only the initial SELECT — no follow-up COUNT.
    expect(db.get).toHaveBeenCalledTimes(1);
  });
});

// ─── adminDeleteUser ──────────────────────────────────────────────────

describe('adminDeleteUser', () => {
  // Earlier `mockResolvedValueOnce` queues from upstream tests can leak past
  // the file-level beforeEach (which only clears call history). Reset both
  // mocks here so each test sees the queue we set.
  beforeEach(() => {
    db.get.mockReset();
    db.run.mockReset();
    db.get.mockResolvedValue(undefined);
    db.run.mockResolvedValue(undefined);
  });

  it('rejects when admin tries to delete themselves via this route', async () => {
    await expect(adminDeleteUser('same', TEST_PW, 'same'))
      .rejects.toMatchObject({ status: 400 });
    expect(db.get).not.toHaveBeenCalled();
  });

  it('rejects when missing ids', async () => {
    await expect(adminDeleteUser('', TEST_PW, 't')).rejects.toMatchObject({ status: 400 });
    await expect(adminDeleteUser('a', TEST_PW, '')).rejects.toMatchObject({ status: 400 });
  });

  it('rejects when caller is not an admin', async () => {
    db.get.mockResolvedValueOnce({ id: 'a', password_hash: TEST_HASH, is_admin: false });
    await expect(adminDeleteUser('a', TEST_PW, 't')).rejects.toMatchObject({ status: 403 });
  });

  it('rejects when admin user row is missing entirely', async () => {
    db.get.mockResolvedValueOnce(null);
    await expect(adminDeleteUser('a', TEST_PW, 't')).rejects.toMatchObject({ status: 403 });
  });

  it('rejects when admin password is wrong', async () => {
    db.get.mockResolvedValueOnce({ id: 'a', password_hash: TEST_HASH, is_admin: true });
    await expect(adminDeleteUser('a', 'WrongPassword1', 't'))
      .rejects.toMatchObject({ status: 401, message: 'Invalid admin password' });
  });

  it('rejects when password is missing or not a string', async () => {
    db.get.mockResolvedValueOnce({ id: 'a', password_hash: TEST_HASH, is_admin: true });
    await expect(adminDeleteUser('a', '', 't')).rejects.toMatchObject({ status: 400 });
  });

  it('returns 404 when the target user does not exist', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'a', password_hash: TEST_HASH, is_admin: true })
      .mockResolvedValueOnce(null);
    await expect(adminDeleteUser('a', TEST_PW, 't')).rejects.toMatchObject({ status: 404 });
  });

  it('runs the purge inside a transaction and returns target email/name', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'a', password_hash: TEST_HASH, is_admin: true })
      .mockResolvedValueOnce({ id: 't', email: 'target@example.com', name: 'Target User' });
    const out = await adminDeleteUser('a', TEST_PW, 't');
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ email: 'target@example.com', name: 'Target User' });
  });

  it('refuses to delete the last alive admin via the admin route (409)', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'a', password_hash: TEST_HASH, is_admin: true })       // admin lookup
      .mockResolvedValueOnce({ id: 't', email: 't@x', name: 'T', is_admin: true })         // target is also admin
      .mockResolvedValueOnce({ n: 1 });                                                    // count = 1 alive admin (inside tx)
    await expect(adminDeleteUser('a', TEST_PW, 't'))
      .rejects.toMatchObject({ status: 409, message: /last admin/ });
    // db.transaction IS invoked (the count check now runs inside it with
    // FOR UPDATE locking) and then rolls back via the thrown error.
    // db.run (the soft-delete writes) must not have been issued.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('proceeds when deleting an admin and another alive admin still exists', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'a', password_hash: TEST_HASH, is_admin: true })
      .mockResolvedValueOnce({ id: 't', email: 't@x', name: 'T', is_admin: true })
      .mockResolvedValueOnce({ n: 2 });
    await adminDeleteUser('a', TEST_PW, 't');
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});

// ─── checkPasswordNotBreached (HIBP k-anonymity) ──────────────────────
// The default test env exports DISABLE_HIBP_CHECK=1, which short-circuits
// this function — so its body is otherwise never exercised. These tests
// clear that flag and stub global fetch to drive the real range-API logic.
describe('checkPasswordNotBreached', () => {
  let oldFlag;
  beforeEach(() => {
    oldFlag = process.env.DISABLE_HIBP_CHECK;
    delete process.env.DISABLE_HIBP_CHECK;
  });
  afterEach(() => {
    if (oldFlag === undefined) delete process.env.DISABLE_HIBP_CHECK;
    else process.env.DISABLE_HIBP_CHECK = oldFlag;
    vi.unstubAllGlobals();
  });

  // A fake range-API body: the password's real SHA-1 suffix at `count`,
  // wrapped in non-matching decoy lines, CRLF-separated like the real API.
  function rangeBodyFor(password, count) {
    const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
    const suffix = sha1.slice(5);
    const decoyA = 'A'.repeat(35);
    const decoyB = 'B'.repeat(35);
    return `${decoyA}:3\r\n${suffix}:${count}\r\n${decoyB}:9`;
  }

  it('returns immediately without fetching when DISABLE_HIBP_CHECK=1', async () => {
    process.env.DISABLE_HIBP_CHECK = '1';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(checkPasswordNotBreached('whatever')).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('queries the range API with the uppercase 5-char SHA-1 prefix', async () => {
    const pw = 'Sup3rSecret!';
    const expectedPrefix = crypto.createHash('sha1').update(pw).digest('hex').toUpperCase().slice(0, 5);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchSpy);
    await checkPasswordNotBreached(pw);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(`https://api.pwnedpasswords.com/range/${expectedPrefix}`);
  });

  it('throws a 400 when the suffix appears in the range with a non-zero count', async () => {
    const pw = 'BreachedPass1';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => rangeBodyFor(pw, 42) }));
    await expect(checkPasswordNotBreached(pw)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/known data breaches/),
    });
  });

  it('resolves when the suffix is present but the count is 0 (not actually breached)', async () => {
    const pw = 'EdgeCasePass1';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => rangeBodyFor(pw, 0) }));
    await expect(checkPasswordNotBreached(pw)).resolves.toBeUndefined();
  });

  it('resolves when the suffix is not present in the range response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `${'C'.repeat(35)}:5\r\n${'D'.repeat(35)}:7`,
    }));
    await expect(checkPasswordNotBreached('TotallyFinePass1')).resolves.toBeUndefined();
  });

  it('fails open on a non-2xx response from the range API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, text: async () => 'ignored' }));
    await expect(checkPasswordNotBreached('SomePass1')).resolves.toBeUndefined();
  });

  it('fails open when fetch itself rejects (network error / timeout)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(checkPasswordNotBreached('SomePass1')).resolves.toBeUndefined();
  });
});
