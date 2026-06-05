// Asserts the exact SQL text and parameters for every db call in
// authService.js. This is the test layer that kills the SQL StringLiteral
// and ArrayDeclaration mutations (Stryker would otherwise replace a SQL
// string with `""` or a params array with `[]` and pass — the mocked db
// doesn't care). Behavioural tests live in authService.test.js and
// authService-coverage.test.js; this file is purely about pinning the
// queries against accidental breakage.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';

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
  setupTotp,
  verifyAndEnableTotp,
  disableTotp,
  changePassword,
  changeEmail,
  createEmailVerificationToken,
  verifyEmail,
  createTrustedDevice,
  checkTrustedDevice,
  createPasswordResetToken,
  resetPassword,
  attemptLogin,
  verifyTotpWithLockout,
} from '../services/authService.js';

const TEST_PW = 'Password1234';
const TEST_HASH = bcrypt.hashSync(TEST_PW, 4);

beforeEach(() => {
  vi.clearAllMocks();
  db.get.mockResolvedValue(undefined);
  db.run.mockResolvedValue(undefined);
});

describe('isAccountLocked queries', () => {
  it('email query selects COUNT(*) AS cnt with success=FALSE and a created_at window', async () => {
    db.get.mockResolvedValueOnce({ cnt: '0' });
    await isAccountLocked('a@b.com');
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toMatch(/SELECT COUNT\(\*\) AS cnt FROM login_attempts/);
    expect(sql).toContain('email = $1');
    expect(sql).toContain('success = FALSE');
    expect(sql).toContain('created_at > NOW()');
    expect(sql).toContain('make_interval(mins => $2)');
    expect(params).toEqual(['a@b.com', 15]);
  });

  it('IP query has the same shape, parameterised on ip and the same window', async () => {
    db.get.mockResolvedValueOnce({ cnt: '0' }).mockResolvedValueOnce({ cnt: '0' });
    await isAccountLocked('a@b.com', '9.9.9.9');
    const [sql, params] = db.get.mock.calls[1];
    expect(sql).toMatch(/SELECT COUNT\(\*\) AS cnt FROM login_attempts/);
    expect(sql).toContain('ip = $1');
    expect(params).toEqual(['9.9.9.9', 15]);
  });
});

describe('recordLoginAttempt queries', () => {
  it('insert SQL is INSERT INTO login_attempts (email, ip, success) VALUES ($1, $2, $3)', async () => {
    await recordLoginAttempt('e@x', '1.2.3.4', false);
    const [sql, params] = db.run.mock.calls[0];
    expect(sql).toBe('INSERT INTO login_attempts (email, ip, success) VALUES ($1, $2, $3)');
    expect(params).toEqual(['e@x', '1.2.3.4', false]);
  });

  it('on success path, runs DELETE FROM login_attempts WHERE email = $1 AND success = FALSE', async () => {
    await recordLoginAttempt('e@x', null, true);
    const [delSql, delParams] = db.run.mock.calls[1];
    expect(delSql).toBe('DELETE FROM login_attempts WHERE email = $1 AND success = FALSE');
    expect(delParams).toEqual(['e@x']);
  });
});

// DD1 (audit round 15): attemptLogin wraps the lockout check + auth +
// record in one tx with a per-email advisory lock so N parallel attempts
// can't all see the same pre-attempt failure count and slip past
// MAX_FAILED_ATTEMPTS. These tests pin the SQL shape: the advisory lock
// fires FIRST, on the normalised email, before any count read.
describe('attemptLogin queries — DD1 per-email advisory lock', () => {
  it('takes pg_advisory_xact_lock on hashtext(login:<email>) as the first tx call', async () => {
    db.get
      .mockResolvedValueOnce({ cnt: '0' }) // per-(email,ip) failure count
      .mockResolvedValueOnce({ cnt: '0' }) // per-ip failure count
      .mockResolvedValueOnce(null); // authenticateUser SELECT -> no user

    await attemptLogin('A@B.com', 'pass', '1.2.3.4');

    expect(db.transaction).toHaveBeenCalledTimes(1);
    // First tx.run is the advisory lock.
    const [lockSql, lockParams] = db.run.mock.calls[0];
    expect(lockSql).toBe('SELECT pg_advisory_xact_lock(hashtext($1))');
    expect(lockParams).toEqual(['login:a@b.com']);
  });

  it('runs the per-(email,ip) lockout COUNT after the advisory lock', async () => {
    db.get
      .mockResolvedValueOnce({ cnt: '0' })
      .mockResolvedValueOnce({ cnt: '0' })
      .mockResolvedValueOnce(null);

    await attemptLogin('e@x', 'pass', '1.2.3.4');

    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toContain('SELECT COUNT(*) AS cnt FROM login_attempts');
    expect(sql).toContain('WHERE email = $1 AND ip = $2 AND success = FALSE');
    expect(params).toEqual(['e@x', '1.2.3.4', expect.any(Number)]);
  });

  it('falls back to email-only count when no ip is provided', async () => {
    db.get
      .mockResolvedValueOnce({ cnt: '0' })
      .mockResolvedValueOnce(null);

    await attemptLogin('e@x', 'pass', null);

    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toContain('WHERE email = $1 AND success = FALSE');
    expect(sql).not.toContain('ip =');
    expect(params).toEqual(['e@x', expect.any(Number)]);
  });

  it('returns 429 when the per-(email,ip) count is at or above MAX_FAILED_ATTEMPTS', async () => {
    // MAX_FAILED_ATTEMPTS is 10; signal 10 prior failures.
    db.get.mockResolvedValueOnce({ cnt: '10' });

    const result = await attemptLogin('e@x', 'pass', '1.2.3.4');
    expect(result.status).toBe(429);
    expect(result.error).toMatch(/too many/i);
  });

  it('records the failure INSIDE the tx (so the next lock-holder sees it)', async () => {
    db.get
      .mockResolvedValueOnce({ cnt: '0' })
      .mockResolvedValueOnce({ cnt: '0' })
      .mockResolvedValueOnce(null); // user not found -> auth fails

    await attemptLogin('e@x', 'pass', '1.2.3.4');

    // After the lock (call[0]), the last tx.run is the failure INSERT.
    const insertCall = db.run.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO login_attempts'));
    expect(insertCall).toBeDefined();
    expect(insertCall[1]).toEqual(['e@x', '1.2.3.4', false]);
  });
});

describe('registerUser queries', () => {
  it('SELECT id FROM users WHERE email = $1 with normalised email', async () => {
    db.get.mockResolvedValueOnce(null);
    await registerUser('A@B.com', 'Bob', TEST_PW);
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toBe('SELECT id FROM users WHERE email = $1');
    expect(params).toEqual(['a@b.com']);
  });

  it('INSERT INTO users (id, email, name, password_hash, email_verified) VALUES ... FALSE', async () => {
    db.get.mockResolvedValueOnce(null);
    await registerUser('a@b.com', 'Alice', TEST_PW);
    const [sql, params] = db.run.mock.calls[0];
    expect(sql).toBe(
      'INSERT INTO users (id, email, name, password_hash, email_verified) VALUES ($1, $2, $3, $4, FALSE)',
    );
    expect(params).toHaveLength(4);
    // [id, email, safeName, password_hash]
    expect(params[1]).toBe('a@b.com');
    expect(params[2]).toBe('Alice');
  });
});

describe('authenticateUser queries', () => {
  it('SELECT id, email, name, password_hash, totp_enabled, totp_secret, is_admin, email_verified, deleted_at FROM users WHERE email = $1', async () => {
    db.get.mockResolvedValueOnce(null);
    await authenticateUser('A@B.com', TEST_PW);
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toBe(
      'SELECT id, email, name, password_hash, totp_enabled, totp_secret, is_admin, email_verified, deleted_at FROM users WHERE email = $1',
    );
    expect(params).toEqual(['a@b.com']);
  });
});

describe('getCurrentUser queries', () => {
  it('SELECT id, email, name, totp_enabled, is_admin, compile_location FROM users WHERE id = $1', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', email: 'e', name: 'n', totp_enabled: false, is_admin: false });
    await getCurrentUser('u');
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toBe('SELECT id, email, name, totp_enabled, is_admin, compile_location FROM users WHERE id = $1');
    expect(params).toEqual(['u']);
  });
});

describe('updateProfile queries', () => {
  it('UPDATE users SET name = $1 WHERE id = $2', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', email: 'e', name: 'n', totp_enabled: false, is_admin: false });
    await updateProfile('u', { name: 'New Name' });
    const [sql, params] = db.run.mock.calls[0];
    expect(sql).toBe('UPDATE users SET name = $1 WHERE id = $2');
    expect(params).toEqual(['New Name', 'u']);
  });
});

describe('setupTotp queries', () => {
  it('SELECT id, email, totp_enabled FROM users WHERE id = $1', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', email: 'e@x', totp_enabled: false });
    await setupTotp('u');
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toBe('SELECT id, email, totp_enabled FROM users WHERE id = $1');
    expect(params).toEqual(['u']);
  });

  it('UPDATE users SET totp_secret = $1 WHERE id = $2', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', email: 'e@x', totp_enabled: false });
    await setupTotp('u');
    const [sql, params] = db.run.mock.calls[0];
    expect(sql).toBe('UPDATE users SET totp_secret = $1 WHERE id = $2');
    expect(params[1]).toBe('u');
    expect(params[0]).toMatch(/^encrypted:/); // mocked encrypt prefix
  });
});

describe('verifyAndEnableTotp queries', () => {
  it('SELECT id, totp_secret, totp_enabled FROM users WHERE id = $1', async () => {
    db.get.mockResolvedValueOnce(null);
    await expect(verifyAndEnableTotp('u', '123456')).rejects.toBeDefined();
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toBe('SELECT id, totp_secret, totp_enabled FROM users WHERE id = $1');
    expect(params).toEqual(['u']);
  });
});

describe('disableTotp queries', () => {
  it('SELECT id, password_hash, totp_enabled FROM users WHERE id = $1', async () => {
    db.get.mockResolvedValueOnce(null);
    await expect(disableTotp('u', TEST_PW)).rejects.toBeDefined();
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toBe('SELECT id, password_hash, totp_enabled FROM users WHERE id = $1');
    expect(params).toEqual(['u']);
  });

  it('UPDATE users SET totp_enabled = FALSE, totp_secret = NULL WHERE id = $1', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', password_hash: TEST_HASH, totp_enabled: true });
    await disableTotp('u', TEST_PW);
    const updateCall = db.run.mock.calls.find((c) => c[0].includes('totp_enabled = FALSE'));
    expect(updateCall).toBeTruthy();
    expect(updateCall[0]).toBe('UPDATE users SET totp_enabled = FALSE, totp_secret = NULL WHERE id = $1');
    expect(updateCall[1]).toEqual(['u']);
  });

  it('DELETE FROM trusted_devices WHERE user_id = $1', async () => {
    db.get.mockResolvedValueOnce({ id: 'u', password_hash: TEST_HASH, totp_enabled: true });
    await disableTotp('u', TEST_PW);
    const delCall = db.run.mock.calls.find((c) => c[0].includes('DELETE FROM trusted_devices'));
    expect(delCall[0]).toBe('DELETE FROM trusted_devices WHERE user_id = $1');
    expect(delCall[1]).toEqual(['u']);
  });
});

describe('changePassword queries', () => {
  it('SELECT id, password_hash FROM users WHERE id = $1', async () => {
    db.get.mockResolvedValueOnce(null);
    await expect(changePassword('u', TEST_PW, 'NewPassword1')).rejects.toBeDefined();
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toBe('SELECT id, password_hash FROM users WHERE id = $1');
    expect(params).toEqual(['u']);
  });

  it('UPDATE users SET password_hash = $1 WHERE id = $2', async () => {
    const oldHash = bcrypt.hashSync('OldPass1', 4);
    db.get.mockResolvedValueOnce({ id: 'u', password_hash: oldHash });
    await changePassword('u', 'OldPass1', 'NewPassword1');
    const [sql, params] = db.run.mock.calls[0];
    expect(sql).toBe('UPDATE users SET password_hash = $1 WHERE id = $2');
    expect(params[1]).toBe('u');
  });
});

describe('changeEmail queries', () => {
  it('SELECT id, email, name, password_hash FROM users WHERE id = $1', async () => {
    db.get.mockResolvedValueOnce(null);
    await expect(changeEmail('u', TEST_PW, 'new@x.com')).rejects.toBeDefined();
    expect(db.get.mock.calls[0][0]).toBe('SELECT id, email, name, password_hash FROM users WHERE id = $1');
    expect(db.get.mock.calls[0][1]).toEqual(['u']);
  });

  it('SELECT 1 FROM users WHERE email = $1 (uniqueness check)', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'u', email: 'old@x.com', password_hash: TEST_HASH })
      .mockResolvedValueOnce(null);
    await changeEmail('u', TEST_PW, 'new@x.com');
    const [sql, params] = db.get.mock.calls[1];
    expect(sql).toBe('SELECT 1 FROM users WHERE email = $1');
    expect(params).toEqual(['new@x.com']);
  });

  it('UPDATE users SET email = $1, email_verified = FALSE WHERE id = $2', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'u', email: 'old@x.com', password_hash: TEST_HASH })
      .mockResolvedValueOnce(null);
    await changeEmail('u', TEST_PW, 'new@x.com');
    const [sql, params] = db.run.mock.calls[0];
    expect(sql).toBe('UPDATE users SET email = $1, email_verified = FALSE WHERE id = $2');
    expect(params).toEqual(['new@x.com', 'u']);
  });
});

describe('createEmailVerificationToken queries', () => {
  // GG3 (audit round 18): the rate-limit COUNT + INSERT now runs
  // inside a tx with a per-user advisory lock so N concurrent calls
  // can't all see cnt < 3 and all INSERT.

  it('GG3 — takes pg_advisory_xact_lock on hashtext(verify-token:<userId>) FIRST', async () => {
    db.get.mockResolvedValueOnce({ cnt: '0' });
    await createEmailVerificationToken('u');
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const [lockSql, lockParams] = db.run.mock.calls[0];
    expect(lockSql).toBe('SELECT pg_advisory_xact_lock(hashtext($1))');
    expect(lockParams).toEqual(['verify-token:u']);
  });

  it('rate-limit query selects COUNT(*) AS cnt from email_verification_tokens', async () => {
    db.get.mockResolvedValueOnce({ cnt: '0' });
    await createEmailVerificationToken('u');
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toMatch(/SELECT COUNT\(\*\) AS cnt FROM email_verification_tokens/);
    expect(sql).toContain('user_id = $1');
    expect(sql).toContain("INTERVAL '1 hour'");
    expect(params).toEqual(['u']);
  });

  it('insert SQL writes id, user_id, token_hash, expires_at with 1-hour expiry', async () => {
    db.get.mockResolvedValueOnce({ cnt: '0' });
    await createEmailVerificationToken('u');
    // After the advisory lock (calls[0]), the INSERT is calls[1].
    const insertCall = db.run.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO email_verification_tokens'));
    expect(insertCall).toBeDefined();
    const [sql, params] = insertCall;
    expect(sql).toContain('(id, user_id, token_hash, expires_at)');
    expect(sql).toContain("INTERVAL '1 hour'");
    expect(params[1]).toBe('u');
    expect(params).toHaveLength(3);
  });

  it('GG3 — returns null when 3 tokens issued in last hour (count observed inside tx)', async () => {
    db.get.mockResolvedValueOnce({ cnt: '3' });
    const token = await createEmailVerificationToken('u');
    expect(token).toBeNull();
    // No INSERT happened.
    const insertCall = db.run.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO email_verification_tokens'));
    expect(insertCall).toBeUndefined();
  });
});

describe('verifyEmail queries', () => {
  it('SELECT joins token + user, includes used + FOR UPDATE OF u (GG1)', async () => {
    // GG1 (audit round 18): the whole verify runs in a tx with
    // FOR UPDATE OF u to close FF1's concurrent gap with changeEmail.
    db.get.mockResolvedValueOnce({ user_id: 'u', used: false, email_verified: false });
    await verifyEmail('rawtoken');
    expect(db.transaction).toHaveBeenCalled();
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toMatch(/SELECT[\s\S]+email_verification_tokens/);
    expect(sql).toMatch(/JOIN users/);
    expect(sql).toContain('token_hash = $1');
    expect(sql).toContain('expires_at > NOW()');
    expect(sql).toContain('t.used'); // FF1: read the used flag
    expect(sql).toContain('FOR UPDATE OF u'); // GG1: lock the user row
    expect(params).toHaveLength(1);
    expect(params[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('GG1/FF1 — rejects when row.used=TRUE and email_verified=FALSE (post-change pre-reverify state)', async () => {
    db.get.mockResolvedValueOnce({ user_id: 'u', used: true, email_verified: false });
    await expect(verifyEmail('rawtoken')).rejects.toMatchObject({ status: 400 });
  });

  it('idempotent: returns user_id when already verified (scanner-prefetch path)', async () => {
    db.get.mockResolvedValueOnce({ user_id: 'u', used: true, email_verified: true });
    const result = await verifyEmail('rawtoken');
    expect(result).toBe('u');
  });

  it('UPDATE users SET email_verified = TRUE WHERE id = $1', async () => {
    db.get.mockResolvedValueOnce({ user_id: 'u', email_verified: false });
    await verifyEmail('rawtoken');
    const usersUpdate = db.run.mock.calls.find((c) => c[0].includes('email_verified = TRUE'));
    expect(usersUpdate[0]).toBe('UPDATE users SET email_verified = TRUE WHERE id = $1');
    expect(usersUpdate[1]).toEqual(['u']);
  });

  it('UPDATE email_verification_tokens SET used = TRUE WHERE user_id = $1 (invalidate siblings)', async () => {
    db.get.mockResolvedValueOnce({ user_id: 'u', email_verified: false });
    await verifyEmail('rawtoken');
    const sib = db.run.mock.calls.find(
      (c) => c[0].includes('email_verification_tokens') && c[0].includes('user_id = $1'),
    );
    expect(sib[0]).toBe('UPDATE email_verification_tokens SET used = TRUE WHERE user_id = $1');
    expect(sib[1]).toEqual(['u']);
  });
});

describe('createTrustedDevice queries', () => {
  it('INSERT INTO trusted_devices with id, user_id, token_hash, device_name, expires_at via make_interval(days)', async () => {
    await createTrustedDevice('u', 'Mozilla/5.0');
    const [sql, params] = db.run.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO trusted_devices/);
    expect(sql).toContain('(id, user_id, token_hash, device_name, expires_at)');
    expect(sql).toContain('make_interval(days => $5)');
    expect(params).toHaveLength(5);
    expect(params[1]).toBe('u');
    expect(params[3]).toBe('Mozilla/5.0');
    expect(params[4]).toBe(7); // TRUST_DAYS
  });
});

describe('checkTrustedDevice queries', () => {
  it('SELECT ... FOR UPDATE inside a transaction (CC1 race serialisation)', async () => {
    db.get.mockResolvedValueOnce({ id: 'd1' });
    db.run.mockResolvedValueOnce({});
    await checkTrustedDevice('u', 'cookie');

    // CC1: the rotation must be inside a tx so two parallel logins
    // can't both pass the un-rotated SELECT. The mock harness collapses
    // `tx.get` to the same fn as `db.get`, so we assert on the SQL
    // shape AND that db.transaction was the call site (not bare
    // db.get).
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toBe(
      'SELECT id FROM trusted_devices WHERE token_hash = $1 AND user_id = $2 AND expires_at > NOW() FOR UPDATE',
    );
    expect(params[1]).toBe('u');
  });
});

describe('createPasswordResetToken queries', () => {
  it('SELECT id, email, deleted_at FROM users WHERE email = $1', async () => {
    db.get.mockResolvedValueOnce(null);
    await createPasswordResetToken('e@x');
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toBe('SELECT id, email, deleted_at FROM users WHERE email = $1');
    expect(params).toEqual(['e@x']);
  });

  it('rate-limit SELECT COUNT(*) AS cnt FROM password_reset_tokens with 1-hour window', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'u', email: 'e@x' })
      .mockResolvedValueOnce({ cnt: '0' });
    await createPasswordResetToken('e@x');
    const [sql, params] = db.get.mock.calls[1];
    expect(sql).toMatch(/SELECT COUNT\(\*\) AS cnt FROM password_reset_tokens/);
    expect(sql).toContain("INTERVAL '1 hour'");
    expect(params).toEqual(['u']);
  });

  it('INSERT INTO password_reset_tokens with id, user_id, token_hash, expires_at + 1 hour', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'u', email: 'e@x' })
      .mockResolvedValueOnce({ cnt: '0' });
    await createPasswordResetToken('e@x');
    const insertCall = db.run.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO password_reset_tokens'));
    expect(insertCall).toBeDefined();
    const [sql, params] = insertCall;
    expect(sql).toContain('(id, user_id, token_hash, expires_at)');
    expect(sql).toContain("INTERVAL '1 hour'");
    expect(params).toHaveLength(3);
    expect(params[1]).toBe('u');
  });

  // GG2 (audit round 18): rate-limit COUNT + INSERT now run inside a tx
  // with a per-user advisory lock so concurrent forgot-password
  // submissions can't all see cnt < 3 and all email out.
  it('GG2 — takes pg_advisory_xact_lock on hashtext(reset-token:<userId>) before COUNT', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'u', email: 'e@x' })
      .mockResolvedValueOnce({ cnt: '0' });
    await createPasswordResetToken('e@x');
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const lockCall = db.run.mock.calls.find(([sql]) => sql.startsWith('SELECT pg_advisory_xact_lock'));
    expect(lockCall).toBeDefined();
    expect(lockCall[1]).toEqual(['reset-token:u']);
  });

  it('GG2 — returns null when 3 tokens issued in last hour (count observed inside tx)', async () => {
    db.get
      .mockResolvedValueOnce({ id: 'u', email: 'e@x' })
      .mockResolvedValueOnce({ cnt: '3' });
    const out = await createPasswordResetToken('e@x');
    expect(out).toBeNull();
    const insertCall = db.run.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO password_reset_tokens'));
    expect(insertCall).toBeUndefined();
  });
});

describe('resetPassword queries', () => {
  it('UPDATE password_reset_tokens with token_hash, used=FALSE, RETURNING id, user_id', async () => {
    db.get.mockResolvedValueOnce(null);
    await expect(resetPassword('rawtoken', 'NewPassword1')).rejects.toBeDefined();
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toMatch(/UPDATE password_reset_tokens SET used = TRUE/);
    expect(sql).toContain('token_hash = $1');
    expect(sql).toContain('used = FALSE');
    expect(sql).toContain('expires_at > NOW()');
    expect(sql).toContain('RETURNING id, user_id');
    expect(params[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('SELECT password_hash FROM users WHERE id = $1', async () => {
    db.get
      .mockResolvedValueOnce({ id: 't1', user_id: 'u' })
      .mockResolvedValueOnce({ password_hash: bcrypt.hashSync('OldPass1', 4) });
    await resetPassword('rawtoken', 'NewPassword1');
    const sel = db.get.mock.calls[1];
    expect(sel[0]).toBe('SELECT password_hash FROM users WHERE id = $1');
    expect(sel[1]).toEqual(['u']);
  });

  it('UPDATE users SET password_hash on success', async () => {
    db.get
      .mockResolvedValueOnce({ id: 't1', user_id: 'u' })
      .mockResolvedValueOnce({ password_hash: bcrypt.hashSync('OldPass1', 4) });
    await resetPassword('rawtoken', 'NewPassword1');
    const updateUsers = db.run.mock.calls.find((c) => c[0].includes('users SET password_hash'));
    expect(updateUsers[0]).toBe('UPDATE users SET password_hash = $1 WHERE id = $2');
    expect(updateUsers[1][1]).toBe('u');
  });

  it('invalidates other reset tokens with UPDATE...WHERE user_id = $1 AND id != $2', async () => {
    db.get
      .mockResolvedValueOnce({ id: 't1', user_id: 'u' })
      .mockResolvedValueOnce({ password_hash: bcrypt.hashSync('OldPass1', 4) });
    await resetPassword('rawtoken', 'NewPassword1');
    const inv = db.run.mock.calls.find(
      (c) => c[0].includes('password_reset_tokens') && c[0].includes('id != $2'),
    );
    expect(inv[0]).toBe('UPDATE password_reset_tokens SET used = TRUE WHERE user_id = $1 AND id != $2');
    expect(inv[1]).toEqual(['u', 't1']);
  });

  it('deletes sessions for that user via JSON path sess->>"userId"', async () => {
    db.get
      .mockResolvedValueOnce({ id: 't1', user_id: 'u' })
      .mockResolvedValueOnce({ password_hash: bcrypt.hashSync('OldPass1', 4) });
    await resetPassword('rawtoken', 'NewPassword1');
    const sess = db.run.mock.calls.find((c) => c[0].includes('DELETE FROM session'));
    expect(sess[0]).toBe(`DELETE FROM session WHERE sess->>'userId' = $1`);
    expect(sess[1]).toEqual(['u']);
  });

  it('deletes trusted_devices for that user', async () => {
    db.get
      .mockResolvedValueOnce({ id: 't1', user_id: 'u' })
      .mockResolvedValueOnce({ password_hash: bcrypt.hashSync('OldPass1', 4) });
    await resetPassword('rawtoken', 'NewPassword1');
    const dev = db.run.mock.calls.find((c) => c[0].includes('DELETE FROM trusted_devices'));
    expect(dev[0]).toBe('DELETE FROM trusted_devices WHERE user_id = $1');
    expect(dev[1]).toEqual(['u']);
  });
});

// EE2 (audit round 16): verifyTotpWithLockout wraps verifyTotp +
// lockout-aware record in one tx with the same per-email advisory
// lock as attemptLogin. These tests pin the SQL shape. The decrypt
// mock at the top of this file strips the 'encrypted:' prefix, so
// any valid base32 string with that prefix is a valid secret for
// OTPAuth's decoder.
const VALID_BASE32_SECRET = 'encrypted:JBSWY3DPEHPK3PXP';

describe('verifyTotpWithLockout queries — EE2 per-email advisory lock', () => {
  it('takes pg_advisory_xact_lock on the same login:<email> key as attemptLogin', async () => {
    db.get
      .mockResolvedValueOnce({ cnt: '0' }) // per-(email,ip)
      .mockResolvedValueOnce({ cnt: '0' }); // per-ip
    // '000000' will (almost certainly) fail OTPAuth.validate, so
    // verifyTotp returns an Invalid error before the claim INSERT.
    // That's fine -- we only assert on the advisory lock being the
    // first tx.run call.
    await verifyTotpWithLockout('user-id', '000000', VALID_BASE32_SECRET, 'A@B.com', '1.2.3.4');
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const [lockSql, lockParams] = db.run.mock.calls[0];
    expect(lockSql).toBe('SELECT pg_advisory_xact_lock(hashtext($1))');
    expect(lockParams).toEqual(['login:a@b.com']);
  });

  it('returns 429 when the lockout count is at or above MAX_FAILED_ATTEMPTS', async () => {
    db.get.mockResolvedValueOnce({ cnt: '10' });

    const result = await verifyTotpWithLockout('user-id', '000000', VALID_BASE32_SECRET, 'e@x', '1.2.3.4');
    expect(result.status).toBe(429);
  });

  it('records the failure INSIDE the tx after a TOTP fail', async () => {
    db.get
      .mockResolvedValueOnce({ cnt: '0' }) // per-(email,ip)
      .mockResolvedValueOnce({ cnt: '0' }); // per-ip
    await verifyTotpWithLockout('user-id', '000000', VALID_BASE32_SECRET, 'e@x', '1.2.3.4');
    const insertCall = db.run.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO login_attempts'));
    expect(insertCall).toBeDefined();
    expect(insertCall[1]).toEqual(['e@x', '1.2.3.4', false]);
  });
});
