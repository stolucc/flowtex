// Integration: user lifecycle against the real DB.
// Each test wraps in a transaction (see setup.js); nothing persists.

import { describe, it, expect } from 'vitest';
import { seedUser } from './setup.js';
import db from '../../db.js';
import {
  registerUser,
  authenticateUser,
  changePassword,
  createPasswordResetToken,
  resetPassword,
  deleteAccount,
  createTrustedDevice,
  checkTrustedDevice,
} from '../../services/authService.js';

describe('users — registration and login', () => {
  it('registers a new user and stores them in users', async () => {
    const email = `it-reg-${Date.now()}@example.test`;
    const user = await registerUser(email, 'Reg User', 'TestPass123');
    expect(user.id).toBeTruthy();
    expect(user.email).toBe(email);
    expect(user.alreadyExisted).toBe(false);
    const row = await db.get('SELECT email, name, email_verified FROM users WHERE id = $1', [user.id]);
    expect(row.email).toBe(email);
    expect(row.email_verified).toBe(false);
  });

  it('returns alreadyExisted=true for duplicate emails (no enumeration leak)', async () => {
    const email = `it-dup-${Date.now()}@example.test`;
    await registerUser(email, 'First', 'TestPass123');
    const second = await registerUser(email, 'Second', 'TestPass123');
    expect(second.alreadyExisted).toBe(true);
    expect(second.id).toBeNull();
    const count = await db.get('SELECT COUNT(*)::int AS n FROM users WHERE email = $1', [email]);
    expect(count.n).toBe(1);
  });

  it('authenticates a verified user with the right password', async () => {
    const email = `it-auth-${Date.now()}@example.test`;
    const created = await registerUser(email, 'Auth', 'TestPass123');
    await db.run('UPDATE users SET email_verified = TRUE WHERE id = $1', [created.id]);
    const result = await authenticateUser(email, 'TestPass123');
    expect(result.error).toBeUndefined();
    expect(result.user.email).toBe(email);
  });

  it('rejects wrong password with timing-equalized response', async () => {
    const email = `it-wrong-${Date.now()}@example.test`;
    const created = await registerUser(email, 'Wrong', 'TestPass123');
    await db.run('UPDATE users SET email_verified = TRUE WHERE id = $1', [created.id]);
    const result = await authenticateUser(email, 'WrongPass456');
    expect(result.error).toBe('Invalid credentials');
    expect(result.status).toBe(401);
  });

  it('refuses to log in unverified accounts (and flags unverified=true)', async () => {
    const email = `it-unver-${Date.now()}@example.test`;
    await registerUser(email, 'Unver', 'TestPass123');
    const result = await authenticateUser(email, 'TestPass123');
    expect(result.unverified).toBe(true);
    expect(result.userId).toBeTruthy();
  });
});

describe('users — password change & reset', () => {
  it('changePassword rejects wrong current password', async () => {
    const email = `it-cp-${Date.now()}@example.test`;
    const u = await registerUser(email, 'CP', 'OrigPass1A');
    const wrong = await changePassword(u.id, 'NotTheRightOne', 'NewPass1234').catch((e) => e);
    expect(wrong).toBeInstanceOf(Error);
    expect(wrong.status).toBe(401);
  });

  it('changePassword succeeds with the right current password', async () => {
    const email = `it-cp2-${Date.now()}@example.test`;
    const u = await registerUser(email, 'CP', 'OrigPass1A');
    await changePassword(u.id, 'OrigPass1A', 'NewPass1234');
    // The new password should authenticate
    await db.run('UPDATE users SET email_verified = TRUE WHERE id = $1', [u.id]);
    const result = await authenticateUser(email, 'NewPass1234');
    expect(result.user).toBeTruthy();
  });

  it('resetPassword consumes the token and invalidates trusted devices', async () => {
    const email = `it-reset-${Date.now()}@example.test`;
    await registerUser(email, 'Reset', 'OrigPass1');
    const tok = await createPasswordResetToken(email);
    expect(tok).toBeTruthy();
    expect(tok.token).toMatch(/^[0-9a-f]{64}$/);
    // Seed a trusted device for this user
    const td = await createTrustedDevice(tok.userId, 'TestAgent');
    expect(await checkTrustedDevice(tok.userId, td.token)).not.toBeNull();
    // Reset
    const userId = await resetPassword(tok.token, 'NewPass1234');
    expect(userId).toBe(tok.userId);
    // Trusted device should be gone after reset
    expect(await checkTrustedDevice(tok.userId, td.token)).toBeNull();
    // Token can't be replayed
    await expect(resetPassword(tok.token, 'AnotherPass5')).rejects.toThrow(/Invalid or expired/);
  });

  it('createPasswordResetToken returns null for unknown emails (no enumeration)', async () => {
    const result = await createPasswordResetToken(`nobody-${Date.now()}@example.test`);
    expect(result).toBeNull();
  });
});

describe('users — deletion', () => {
  it('deleteAccount removes the user row', async () => {
    const email = `it-del-${Date.now()}@example.test`;
    const u = await registerUser(email, 'Del', 'TestPass123');
    await db.run('UPDATE users SET email_verified = TRUE WHERE id = $1', [u.id]);
    await deleteAccount(u.id, 'TestPass123');
    const remaining = await db.get('SELECT id FROM users WHERE id = $1', [u.id]);
    expect(remaining).toBeUndefined();
  });
});

describe('users — trusted devices', () => {
  it('rotates the trusted-device token on every use', async () => {
    const u = await seedUser();
    const { token: t1, maxAge } = await createTrustedDevice(u.id, 'TestAgent');
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect(maxAge).toBe(7 * 24 * 60 * 60 * 1000); // 7 days, post-hardening
    const rotated = await checkTrustedDevice(u.id, t1);
    expect(rotated).not.toBeNull();
    expect(rotated.token).not.toBe(t1); // rotated
    // Old token is no longer valid (its hash isn't in the table anymore)
    const old = await checkTrustedDevice(u.id, t1);
    expect(old).toBeNull();
    // The rotated token IS valid
    const again = await checkTrustedDevice(u.id, rotated.token);
    expect(again).not.toBeNull();
    expect(again.token).not.toBe(rotated.token);
  });
});
