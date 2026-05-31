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
} from '../services/authService.js';

const TEST_PW = 'Password1';
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
    await expect(changePassword('u', TEST_PW, 'NewPass1')).rejects.toBeDefined();
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toBe('SELECT id, password_hash FROM users WHERE id = $1');
    expect(params).toEqual(['u']);
  });

  it('UPDATE users SET password_hash = $1 WHERE id = $2', async () => {
    const oldHash = bcrypt.hashSync('OldPass1', 4);
    db.get.mockResolvedValueOnce({ id: 'u', password_hash: oldHash });
    await changePassword('u', 'OldPass1', 'NewPass1');
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
    // Window deliberately tightened from 24h → 1h: the verify endpoint
    // is now idempotent (mail-scanner GETs don't lock out the human),
    // so the token is reusable inside its window. Smaller window =
    // smaller exposure if the user's inbox is ever compromised. Users
    // who let it lapse hit Resend (rate-limited at 3/hour).
    db.get.mockResolvedValueOnce({ cnt: '0' });
    await createEmailVerificationToken('u');
    const [sql, params] = db.run.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO email_verification_tokens/);
    expect(sql).toContain('(id, user_id, token_hash, expires_at)');
    expect(sql).toContain("INTERVAL '1 hour'");
    // params: [uuid, userId, tokenHash]
    expect(params[1]).toBe('u');
    expect(params).toHaveLength(3);
  });
});

describe('verifyEmail queries', () => {
  it('SELECT joins token + user.email_verified for an idempotency check', async () => {
    // Updated lookup: a JOIN that surfaces the user's current verified
    // state. The old UPDATE…RETURNING was single-use, so email-scanner
    // prefetches (Outlook Safe Links etc.) consumed the token before
    // the human clicked.
    db.get.mockResolvedValueOnce({ user_id: 'u', email_verified: false });
    await verifyEmail('rawtoken');
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toMatch(/SELECT[\s\S]+email_verification_tokens/);
    expect(sql).toMatch(/JOIN users/);
    expect(sql).toContain('token_hash = $1');
    expect(sql).toContain('expires_at > NOW()');
    // params is the SHA-256 hash of 'rawtoken'
    expect(params).toHaveLength(1);
    expect(params[0]).toMatch(/^[0-9a-f]{64}$/);
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
  it('SELECT id FROM trusted_devices WHERE token_hash = $1 AND user_id = $2 AND expires_at > NOW()', async () => {
    db.get.mockResolvedValueOnce({ id: 'd1' });
    await checkTrustedDevice('u', 'cookie');
    const [sql, params] = db.get.mock.calls[0];
    expect(sql).toBe(
      'SELECT id FROM trusted_devices WHERE token_hash = $1 AND user_id = $2 AND expires_at > NOW()',
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
    const [sql, params] = db.run.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO password_reset_tokens/);
    expect(sql).toContain('(id, user_id, token_hash, expires_at)');
    expect(sql).toContain("INTERVAL '1 hour'");
    expect(params).toHaveLength(3);
    expect(params[1]).toBe('u');
  });
});

describe('resetPassword queries', () => {
  it('UPDATE password_reset_tokens with token_hash, used=FALSE, RETURNING id, user_id', async () => {
    db.get.mockResolvedValueOnce(null);
    await expect(resetPassword('rawtoken', 'NewPass1')).rejects.toBeDefined();
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
    await resetPassword('rawtoken', 'NewPass1');
    const sel = db.get.mock.calls[1];
    expect(sel[0]).toBe('SELECT password_hash FROM users WHERE id = $1');
    expect(sel[1]).toEqual(['u']);
  });

  it('UPDATE users SET password_hash on success', async () => {
    db.get
      .mockResolvedValueOnce({ id: 't1', user_id: 'u' })
      .mockResolvedValueOnce({ password_hash: bcrypt.hashSync('OldPass1', 4) });
    await resetPassword('rawtoken', 'NewPass1');
    const updateUsers = db.run.mock.calls.find((c) => c[0].includes('users SET password_hash'));
    expect(updateUsers[0]).toBe('UPDATE users SET password_hash = $1 WHERE id = $2');
    expect(updateUsers[1][1]).toBe('u');
  });

  it('invalidates other reset tokens with UPDATE...WHERE user_id = $1 AND id != $2', async () => {
    db.get
      .mockResolvedValueOnce({ id: 't1', user_id: 'u' })
      .mockResolvedValueOnce({ password_hash: bcrypt.hashSync('OldPass1', 4) });
    await resetPassword('rawtoken', 'NewPass1');
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
    await resetPassword('rawtoken', 'NewPass1');
    const sess = db.run.mock.calls.find((c) => c[0].includes('DELETE FROM session'));
    expect(sess[0]).toBe(`DELETE FROM session WHERE sess->>'userId' = $1`);
    expect(sess[1]).toEqual(['u']);
  });

  it('deletes trusted_devices for that user', async () => {
    db.get
      .mockResolvedValueOnce({ id: 't1', user_id: 'u' })
      .mockResolvedValueOnce({ password_hash: bcrypt.hashSync('OldPass1', 4) });
    await resetPassword('rawtoken', 'NewPass1');
    const dev = db.run.mock.calls.find((c) => c[0].includes('DELETE FROM trusted_devices'));
    expect(dev[0]).toBe('DELETE FROM trusted_devices WHERE user_id = $1');
    expect(dev[1]).toEqual(['u']);
  });
});
