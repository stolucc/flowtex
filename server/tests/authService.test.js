import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';

// Mock db before importing authService
vi.mock('../db.js', () => ({
  default: {
    get: vi.fn(),
    run: vi.fn(),
  },
}));

vi.mock('../utils/crypto.js', () => ({
  encrypt: vi.fn((v) => 'encrypted:' + v),
  decrypt: vi.fn((v) => v.replace('encrypted:', '')),
  _setSaltForTesting: vi.fn(),
}));

import db from '../db.js';
import { decrypt } from '../utils/crypto.js';
import {
  validatePassword,
  authenticateUser,
  registerUser,
  recordLoginAttempt,
  decryptTotpSecret,
  getCurrentUser,
  changePassword,
  changeEmail,
  verifyTotp,
} from '../services/authService.js';

// Shared test fixtures
const TEST_PASSWORD = 'Password1234';
const TEST_HASH = bcrypt.hashSync(TEST_PASSWORD, 4); // low rounds for speed

beforeEach(() => {
  vi.clearAllMocks();
  db.get.mockResolvedValue(undefined);
  db.run.mockResolvedValue(undefined);
});

// ─── validatePassword ────────────────────────────────────────────────

describe('validatePassword', () => {
  it('returns null for a valid password', () => {
    expect(validatePassword('Password1234')).toBeNull();
  });

  it('returns null for a password with special characters', () => {
    expect(validatePassword('P@ssw0rd!#$X')).toBeNull(); // 12 chars
  });

  it('returns error for non-string input', () => {
    expect(validatePassword(undefined)).toBe('Password must be at least 12 characters');
    expect(validatePassword(null)).toBe('Password must be at least 12 characters');
    expect(validatePassword(12345678)).toBe('Password must be at least 12 characters');
  });

  it('returns error for password shorter than 12 characters', () => {
    expect(validatePassword('Pass1')).toBe('Password must be at least 12 characters');
    expect(validatePassword('Abcde1')).toBe('Password must be at least 12 characters');
    expect(validatePassword('Passwor1')).toBe('Password must be at least 12 characters');   // 8 chars — now too short
    expect(validatePassword('Passw0rd!#$')).toBe('Password must be at least 12 characters'); // 11 chars — still too short
  });

  it('returns error for empty string', () => {
    expect(validatePassword('')).toBe('Password must be at least 12 characters');
  });

  it('returns error for password longer than 128 characters', () => {
    const longPw = 'A' + 'a'.repeat(127) + '1';
    expect(validatePassword(longPw)).toBe('Password must be at most 128 characters');
  });

  it('returns error for missing uppercase letter', () => {
    expect(validatePassword('password1234')).toBe('Password must contain an uppercase letter');
  });

  it('returns error for missing lowercase letter', () => {
    expect(validatePassword('PASSWORD1234')).toBe('Password must contain a lowercase letter');
  });

  it('returns error for missing number', () => {
    expect(validatePassword('Passworddddd')).toBe('Password must contain a number');
  });

  it('accepts exactly 12 characters', () => {
    expect(validatePassword('Passworddd12')).toBeNull(); // 12 chars
  });

  it('accepts exactly 128 characters', () => {
    const pw = 'Aa1' + 'x'.repeat(125);
    expect(pw.length).toBe(128);
    expect(validatePassword(pw)).toBeNull();
  });
});

// ─── authenticateUser ────────────────────────────────────────────────

describe('authenticateUser', () => {
  it('returns error if user not found', async () => {
    db.get.mockResolvedValue(undefined);

    const result = await authenticateUser('nobody@test.com', 'Password1234');
    expect(result).toEqual({ error: 'Invalid credentials', status: 401 });
  });

  it('returns error if password does not match', async () => {
    db.get.mockResolvedValue({
      id: 'u1',
      email: 'user@test.com',
      name: 'Test',
      password_hash: TEST_HASH,
      totp_enabled: false,
      totp_secret: null,
      is_admin: false,
      email_verified: true,
    });

    const result = await authenticateUser('user@test.com', 'WrongPassword1');
    expect(result).toEqual({ error: 'Invalid credentials', status: 401 });
  });

  it('returns unverified error if email not verified', async () => {
    db.get.mockResolvedValue({
      id: 'u1',
      email: 'user@test.com',
      name: 'Test',
      password_hash: TEST_HASH,
      totp_enabled: false,
      totp_secret: null,
      is_admin: false,
      email_verified: false,
    });

    const result = await authenticateUser('user@test.com', TEST_PASSWORD);
    expect(result.status).toBe(403);
    expect(result.unverified).toBe(true);
    expect(result.userId).toBe('u1');
    expect(result.error).toContain('verify your email');
  });

  it('returns user object on successful authentication', async () => {
    const userRow = {
      id: 'u1',
      email: 'user@test.com',
      name: 'Test User',
      password_hash: TEST_HASH,
      totp_enabled: false,
      totp_secret: null,
      is_admin: false,
      email_verified: true,
    };
    db.get.mockResolvedValue(userRow);

    const result = await authenticateUser('user@test.com', TEST_PASSWORD);
    expect(result.user).toBeDefined();
    expect(result.user.id).toBe('u1');
    expect(result.user.email).toBe('user@test.com');
    expect(result.error).toBeUndefined();
  });

  it('normalizes email to lowercase and trims whitespace', async () => {
    db.get.mockResolvedValue(undefined);

    await authenticateUser('  USER@TEST.COM  ', 'Password1234');
    expect(db.get).toHaveBeenCalledWith(expect.any(String), ['user@test.com']);
  });
});

// ─── registerUser ────────────────────────────────────────────────────

describe('registerUser', () => {
  it('creates a user with hashed password', async () => {
    db.get.mockResolvedValue(undefined); // no existing user
    db.run.mockResolvedValue(undefined);

    const result = await registerUser('new@test.com', 'New User', 'Password1234');
    expect(result.email).toBe('new@test.com');
    expect(result.name).toBe('New User');
    expect(result.id).toBeDefined();
    expect(result.totpEnabled).toBe(false);
    expect(result.isAdmin).toBe(false);
    expect(result.emailVerified).toBe(false);

    // Verify db.run was called with an Argon2id hash (starts with $argon2id$).
    // Legacy bcrypt hashes ($2a/b/y) are still verifiable on login but new
    // hashes always emit Argon2id (ASVS V2.4.1).
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO users'),
      expect.arrayContaining([
        expect.any(String), // id
        'new@test.com',
        'New User',
        expect.stringMatching(/^\$argon2id\$/),
      ]),
    );
  });

  it('returns alreadyExisted=true (not an error) if email is registered, to defeat enumeration', async () => {
    db.get.mockResolvedValue({ id: 'existing-id' });

    const result = await registerUser('taken@test.com', 'Name', 'Password1234');
    expect(result.alreadyExisted).toBe(true);
    expect(result.email).toBe('taken@test.com');
    expect(result.id).toBeNull();
    // Importantly: no INSERT happened.
    expect(db.run).not.toHaveBeenCalled();
  });

  it('rejects invalid passwords', async () => {
    const error = await registerUser('x@test.com', 'Name', 'short').catch((e) => e);
    expect(error.message).toBe('Password must be at least 12 characters');
    expect(error.status).toBe(400);
  });

  it('normalizes email to lowercase and trims name', async () => {
    db.get.mockResolvedValue(undefined);
    db.run.mockResolvedValue(undefined);

    const result = await registerUser('  USER@TEST.COM  ', '  Trimmed  ', 'Password1234');
    expect(result.email).toBe('user@test.com');
    expect(result.name).toBe('Trimmed');
  });
});

// isAccountLocked tests were removed in audit round 19 (HH3): the
// standalone function was dead code after DD1 inlined the
// race-protected check into attemptLogin. The lockout threshold +
// IP-3x rule behaviour is now covered by attemptLogin tests in
// authService-queries.test.js, which exercise the same SQL count
// queries inside the advisory-lock tx.

// ─── recordLoginAttempt ──────────────────────────────────────────────

describe('recordLoginAttempt', () => {
  it('inserts attempt record', async () => {
    await recordLoginAttempt('user@test.com', '1.2.3.4', false);

    expect(db.run).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO login_attempts'), [
      'user@test.com',
      '1.2.3.4',
      false,
    ]);
  });

  it('deletes failed attempts on success', async () => {
    await recordLoginAttempt('user@test.com', '1.2.3.4', true);

    expect(db.run).toHaveBeenCalledTimes(2);
    expect(db.run).toHaveBeenNthCalledWith(1, expect.stringContaining('INSERT INTO login_attempts'), [
      'user@test.com',
      '1.2.3.4',
      true,
    ]);
    expect(db.run).toHaveBeenNthCalledWith(2, expect.stringContaining('DELETE FROM login_attempts'), ['user@test.com']);
  });

  it('does not delete failed attempts on failure', async () => {
    await recordLoginAttempt('user@test.com', '1.2.3.4', false);

    expect(db.run).toHaveBeenCalledTimes(1);
  });

  it('handles null IP', async () => {
    await recordLoginAttempt('user@test.com', null, false);

    expect(db.run).toHaveBeenCalledWith(expect.any(String), ['user@test.com', null, false]);
  });

  it('handles undefined IP (converts to null)', async () => {
    await recordLoginAttempt('user@test.com', undefined, true);

    expect(db.run).toHaveBeenCalledWith(expect.any(String), ['user@test.com', null, true]);
  });
});

// ─── decryptTotpSecret ───────────────────────────────────────────────

describe('decryptTotpSecret', () => {
  it('returns null for null input', () => {
    expect(decryptTotpSecret(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(decryptTotpSecret(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(decryptTotpSecret('')).toBeNull();
  });

  it('returns decrypted value on success', () => {
    const result = decryptTotpSecret('encrypted:MY_SECRET');
    expect(result).toBe('MY_SECRET');
  });

  it('falls back to raw value if decrypt fails', () => {
    decrypt.mockImplementationOnce(() => {
      throw new Error('decrypt failed');
    });

    const result = decryptTotpSecret('raw-secret-value');
    expect(result).toBe('raw-secret-value');
  });
});

// ─── getCurrentUser ──────────────────────────────────────────────────

describe('getCurrentUser', () => {
  it('returns null if user not found', async () => {
    db.get.mockResolvedValue(undefined);

    const result = await getCurrentUser('nonexistent-id');
    expect(result).toBeNull();
  });

  it('returns formatted user object', async () => {
    db.get.mockResolvedValue({
      id: 'u1',
      email: 'user@test.com',
      name: 'Test User',
      totp_enabled: true,
      is_admin: false,
      compile_location: 'server',
    });

    const result = await getCurrentUser('u1');
    expect(result).toEqual({
      id: 'u1',
      email: 'user@test.com',
      name: 'Test User',
      totpEnabled: true,
      isAdmin: false,
      compileLocation: 'server',
      // serverFeatures.localCompile reflects FEATURE_LOCAL_COMPILE env var
      // at the moment of the call. Default off; this test does not set it.
      serverFeatures: { localCompile: false },
    });
  });

  it('converts totp_enabled and is_admin to booleans', async () => {
    db.get.mockResolvedValue({
      id: 'u1',
      email: 'admin@test.com',
      name: 'Admin',
      totp_enabled: 1, // truthy but not boolean
      is_admin: 1,
    });

    const result = await getCurrentUser('u1');
    expect(result.totpEnabled).toBe(true);
    expect(result.isAdmin).toBe(true);
  });

  it('converts falsy values to false', async () => {
    db.get.mockResolvedValue({
      id: 'u1',
      email: 'user@test.com',
      name: 'User',
      totp_enabled: 0,
      is_admin: 0,
    });

    const result = await getCurrentUser('u1');
    expect(result.totpEnabled).toBe(false);
    expect(result.isAdmin).toBe(false);
  });

  it('converts null/undefined to false', async () => {
    db.get.mockResolvedValue({
      id: 'u1',
      email: 'user@test.com',
      name: 'User',
      totp_enabled: null,
      is_admin: undefined,
    });

    const result = await getCurrentUser('u1');
    expect(result.totpEnabled).toBe(false);
    expect(result.isAdmin).toBe(false);
  });
});

// ─── verifyTotp ──────────────────────────────────────────────────────

describe('verifyTotp', () => {
  // We use a real OTPAuth secret and generate a valid code to test the full flow.
  // The decrypt mock returns the input with 'encrypted:' stripped, so we pass
  // the secret prefixed with 'encrypted:' to match.

  let validCode;
  let testSecret;

  beforeEach(async () => {
    const OTPAuth = await import('otpauth');
    const secret = new OTPAuth.Secret();
    testSecret = secret.base32;
    const totp = new OTPAuth.TOTP({
      secret,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });
    validCode = totp.generate();
  });

  it('returns error for an invalid code', async () => {
    // db.get returns undefined for isTotpUsed check
    db.get.mockResolvedValue(undefined);

    await verifyTotp('u1', '000000', 'encrypted:' + testSecret);
    // '000000' is almost certainly not a valid code for a random secret
    // but there's a 1-in-333333 chance it matches (window=1 covers 3 periods).
    // If it somehow passes validation, the test is still meaningful.
    // For robustness, we use a clearly invalid format:
    const result2 = await verifyTotp('u1', 'BADCODE', 'encrypted:' + testSecret);
    expect(result2).toEqual({ error: 'Invalid verification code', status: 401 });
  });

  it('succeeds with a valid code', async () => {
    // EE1: claim INSERT returns rowCount=1 on success.
    db.run.mockResolvedValueOnce({ rowCount: 1 });

    const result = await verifyTotp('u-succeeds-valid-code', validCode, 'encrypted:' + testSecret);
    expect(result).toEqual({ ok: true });
  });

  it('rejects a replayed code (in-memory cache)', async () => {
    // First call succeeds (INSERT claims the code; rowCount=1).
    db.run.mockResolvedValueOnce({ rowCount: 1 });

    const result1 = await verifyTotp('u1', validCode, 'encrypted:' + testSecret);
    expect(result1).toEqual({ ok: true });

    // Second call with same code should be rejected via in-memory usedTotpCodes map
    const result2 = await verifyTotp('u1', validCode, 'encrypted:' + testSecret);
    expect(result2).toEqual({ error: 'Verification code already used', status: 401 });
  });

  // EE1 (audit round 16): the replay-protection check is now the
  // atomic INSERT ... ON CONFLICT DO NOTHING. A concurrent process
  // that already claimed the code lands an INSERT that returns
  // rowCount=0 -- this side of the race must reject without
  // bypassing.
  it('EE1 — rejects a replayed code via INSERT rowCount=0 (cross-process race)', async () => {
    // Use a unique user id so the in-memory Map doesn't short-circuit
    // before the INSERT is attempted (the Map is process-local).
    db.run.mockResolvedValueOnce({ rowCount: 0 });

    const result = await verifyTotp('u-cross-process-race', validCode, 'encrypted:' + testSecret);
    expect(result).toEqual({ error: 'Verification code already used', status: 401 });
  });

  it('EE1 — fails closed (treats as already-used) when the INSERT errors', async () => {
    db.run.mockRejectedValueOnce(new Error('DB blip'));

    const result = await verifyTotp('u-db-blip', validCode, 'encrypted:' + testSecret);
    expect(result).toEqual({ error: 'Verification code already used', status: 401 });
  });
});

// ─── changePassword ──────────────────────────────────────────────────

describe('changePassword', () => {
  it('rejects if user not found', async () => {
    db.get.mockResolvedValue(undefined);

    const err = await changePassword('no-id', 'OldPass1', 'NewPassword1').catch((e) => e);
    expect(err.message).toBe('User not found');
    expect(err.status).toBe(401);
  });

  it('rejects if current password is wrong', async () => {
    db.get.mockResolvedValue({ id: 'u1', password_hash: TEST_HASH });

    const err = await changePassword('u1', 'WrongPassword1', 'NewPassword1').catch((e) => e);
    expect(err.message).toBe('Current password is incorrect');
    expect(err.status).toBe(401);
  });

  it('rejects if new password is the same as current', async () => {
    db.get.mockResolvedValue({ id: 'u1', password_hash: TEST_HASH });

    const err = await changePassword('u1', TEST_PASSWORD, TEST_PASSWORD).catch((e) => e);
    expect(err.message).toBe('New password must be different from your current password');
    expect(err.status).toBe(400);
  });

  it('rejects if new password does not meet requirements', async () => {
    db.get.mockResolvedValue({ id: 'u1', password_hash: TEST_HASH });

    await expect(changePassword('u1', TEST_PASSWORD, 'short')).rejects.toThrow(
      'Password must be at least 12 characters',
    );
  });

  it('rejects new password missing uppercase', async () => {
    db.get.mockResolvedValue({ id: 'u1', password_hash: TEST_HASH });

    await expect(changePassword('u1', TEST_PASSWORD, 'newpassword1')).rejects.toThrow(
      'Password must contain an uppercase letter',
    );
  });

  it('updates hash on success', async () => {
    db.get.mockResolvedValue({ id: 'u1', password_hash: TEST_HASH });

    await changePassword('u1', TEST_PASSWORD, 'NewPassword2');

    // New hash is Argon2id; legacy bcrypt remains verifiable but isn't emitted.
    expect(db.run).toHaveBeenCalledWith(expect.stringContaining('UPDATE users SET password_hash'), [
      expect.stringMatching(/^\$argon2id\$/),
      'u1',
    ]);
  });
});

// ─── changeEmail ─────────────────────────────────────────────────────

describe('changeEmail', () => {
  const userRow = {
    id: 'u1',
    email: 'old@test.com',
    password_hash: TEST_HASH,
  };

  it('rejects invalid email format', async () => {
    const err = await changeEmail('u1', TEST_PASSWORD, 'not-an-email').catch((e) => e);
    expect(err.message).toBe('Invalid email address');
    expect(err.status).toBe(400);
  });

  it('rejects if user not found', async () => {
    db.get.mockResolvedValue(undefined);

    const err = await changeEmail('no-id', TEST_PASSWORD, 'new@test.com').catch((e) => e);
    expect(err.message).toBe('User not found');
    expect(err.status).toBe(401);
  });

  it('rejects if password is incorrect', async () => {
    db.get.mockResolvedValue(userRow);

    const err = await changeEmail('u1', 'WrongPassword1', 'new@test.com').catch((e) => e);
    expect(err.message).toBe('Incorrect password');
    expect(err.status).toBe(401);
  });

  it('rejects if new email is the same as current', async () => {
    db.get.mockResolvedValue(userRow);

    const err = await changeEmail('u1', TEST_PASSWORD, 'old@test.com').catch((e) => e);
    expect(err.message).toBe('New email is the same as your current email');
    expect(err.status).toBe(400);
  });

  it('rejects if email is already taken', async () => {
    db.get
      .mockResolvedValueOnce(userRow) // user lookup
      .mockResolvedValueOnce({ 1: 1 }); // existing email check

    const err = await changeEmail('u1', TEST_PASSWORD, 'taken@test.com').catch((e) => e);
    expect(err.message).toBe('An account with this email already exists');
    expect(err.status).toBe(409);
  });

  it('updates email on success', async () => {
    db.get
      .mockResolvedValueOnce(userRow) // user lookup
      .mockResolvedValueOnce(undefined); // no existing email

    const result = await changeEmail('u1', TEST_PASSWORD, 'new@test.com');
    expect(result).toEqual({ email: 'new@test.com', oldEmail: 'old@test.com', needsVerification: true });
    expect(db.run).toHaveBeenCalledWith(expect.stringContaining('UPDATE users SET email'), ['new@test.com', 'u1']);
  });

  it('normalizes email to lowercase', async () => {
    db.get.mockResolvedValueOnce(userRow).mockResolvedValueOnce(undefined);

    const result = await changeEmail('u1', TEST_PASSWORD, '  NEW@TEST.COM  ');
    expect(result.email).toBe('new@test.com');
  });
});
