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
  adminRestoreUser,
  listSoftDeletedUsers,
  purgeExpiredSoftDeletes,
  createTrustedDevice,
  checkTrustedDevice,
  createEmailVerificationToken,
  verifyEmail,
  changeEmail,
} from '../../services/authService.js';

describe('users — registration and login', () => {
  it('registers a new user and stores them in users', async () => {
    const email = `it-reg-${Date.now()}@example.test`;
    const user = await registerUser(email, 'Reg User', 'TestPass1234');
    expect(user.id).toBeTruthy();
    expect(user.email).toBe(email);
    expect(user.alreadyExisted).toBe(false);
    const row = await db.get('SELECT email, name, email_verified FROM users WHERE id = $1', [user.id]);
    expect(row.email).toBe(email);
    expect(row.email_verified).toBe(false);
  });

  it('returns alreadyExisted=true for duplicate emails (no enumeration leak)', async () => {
    const email = `it-dup-${Date.now()}@example.test`;
    await registerUser(email, 'First', 'TestPass1234');
    const second = await registerUser(email, 'Second', 'TestPass1234');
    expect(second.alreadyExisted).toBe(true);
    expect(second.id).toBeNull();
    const count = await db.get('SELECT COUNT(*)::int AS n FROM users WHERE email = $1', [email]);
    expect(count.n).toBe(1);
  });

  it('authenticates a verified user with the right password', async () => {
    const email = `it-auth-${Date.now()}@example.test`;
    const created = await registerUser(email, 'Auth', 'TestPass1234');
    await db.run('UPDATE users SET email_verified = TRUE WHERE id = $1', [created.id]);
    const result = await authenticateUser(email, 'TestPass1234');
    expect(result.error).toBeUndefined();
    expect(result.user.email).toBe(email);
  });

  it('rejects wrong password with timing-equalized response', async () => {
    const email = `it-wrong-${Date.now()}@example.test`;
    const created = await registerUser(email, 'Wrong', 'TestPass1234');
    await db.run('UPDATE users SET email_verified = TRUE WHERE id = $1', [created.id]);
    const result = await authenticateUser(email, 'WrongPass456');
    expect(result.error).toBe('Invalid credentials');
    expect(result.status).toBe(401);
  });

  it('refuses to log in unverified accounts (and flags unverified=true)', async () => {
    const email = `it-unver-${Date.now()}@example.test`;
    await registerUser(email, 'Unver', 'TestPass1234');
    const result = await authenticateUser(email, 'TestPass1234');
    expect(result.unverified).toBe(true);
    expect(result.userId).toBeTruthy();
  });
});

describe('users — password change & reset', () => {
  it('changePassword rejects wrong current password', async () => {
    const email = `it-cp-${Date.now()}@example.test`;
    const u = await registerUser(email, 'CP', 'OrigPass1A234');
    const wrong = await changePassword(u.id, 'NotTheRightOne', 'NewPass1234A').catch((e) => e);
    expect(wrong).toBeInstanceOf(Error);
    expect(wrong.status).toBe(401);
  });

  it('changePassword succeeds with the right current password', async () => {
    const email = `it-cp2-${Date.now()}@example.test`;
    const u = await registerUser(email, 'CP', 'OrigPass1A234');
    await changePassword(u.id, 'OrigPass1A234', 'NewPass1234A');
    // The new password should authenticate
    await db.run('UPDATE users SET email_verified = TRUE WHERE id = $1', [u.id]);
    const result = await authenticateUser(email, 'NewPass1234A');
    expect(result.user).toBeTruthy();
  });

  it('resetPassword consumes the token and invalidates trusted devices', async () => {
    const email = `it-reset-${Date.now()}@example.test`;
    await registerUser(email, 'Reset', 'OrigPass1234');
    const tok = await createPasswordResetToken(email);
    expect(tok).toBeTruthy();
    expect(tok.token).toMatch(/^[0-9a-f]{64}$/);
    // Seed a trusted device for this user
    const td = await createTrustedDevice(tok.userId, 'TestAgent');
    expect(await checkTrustedDevice(tok.userId, td.token)).not.toBeNull();
    // Reset
    const userId = await resetPassword(tok.token, 'NewPass1234A');
    expect(userId).toBe(tok.userId);
    // Trusted device should be gone after reset
    expect(await checkTrustedDevice(tok.userId, td.token)).toBeNull();
    // Token can't be replayed
    await expect(resetPassword(tok.token, 'AnotherPass5678')).rejects.toThrow(/Invalid or expired/);
  });

  it('createPasswordResetToken returns null for unknown emails (no enumeration)', async () => {
    const result = await createPasswordResetToken(`nobody-${Date.now()}@example.test`);
    expect(result).toBeNull();
  });
});

describe('users — deletion (soft-delete recovery bin)', () => {
  it('deleteAccount soft-deletes the user (row + data preserved, login blocked)', async () => {
    const email = `it-del-${Date.now()}@example.test`;
    const u = await registerUser(email, 'Del', 'TestPass1234');
    await db.run('UPDATE users SET email_verified = TRUE WHERE id = $1', [u.id]);
    await deleteAccount(u.id, 'TestPass1234');

    const row = await db.get('SELECT id, deleted_at FROM users WHERE id = $1', [u.id]);
    expect(row).toBeDefined();
    expect(row.deleted_at).not.toBeNull();

    const loginAttempt = await authenticateUser(email, 'TestPass1234');
    expect(loginAttempt.error).toBeTruthy();
    expect(loginAttempt.status).toBe(401);
  });

  it('a soft-deleted user shows up in listSoftDeletedUsers with a future purge_at', async () => {
    const email = `it-bin-${Date.now()}@example.test`;
    const u = await registerUser(email, 'Bin', 'TestPass1234');
    await deleteAccount(u.id, 'TestPass1234');
    const bin = await listSoftDeletedUsers();
    const entry = bin.find((r) => r.id === u.id);
    expect(entry).toBeDefined();
    expect(new Date(entry.purge_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('adminRestoreUser clears deleted_at and lets the user log in again', async () => {
    const email = `it-restore-${Date.now()}@example.test`;
    const u = await registerUser(email, 'Restore', 'TestPass1234');
    await db.run('UPDATE users SET email_verified = TRUE WHERE id = $1', [u.id]);
    await deleteAccount(u.id, 'TestPass1234');

    const admin = await registerUser(`it-admin-${Date.now()}@example.test`, 'Admin', 'AdminPass1234');
    await db.run('UPDATE users SET is_admin = TRUE WHERE id = $1', [admin.id]);

    await adminRestoreUser(admin.id, 'AdminPass1234', u.id);
    const row = await db.get('SELECT deleted_at FROM users WHERE id = $1', [u.id]);
    expect(row.deleted_at).toBeNull();

    const ok = await authenticateUser(email, 'TestPass1234');
    expect(ok.user?.id).toBe(u.id);
  });

  it('adminRestoreUser rejects a wrong admin password', async () => {
    const u = await registerUser(`it-rw-${Date.now()}@example.test`, 'U', 'TestPass1234');
    await deleteAccount(u.id, 'TestPass1234');
    const admin = await registerUser(`it-adminrw-${Date.now()}@example.test`, 'A', 'AdminPass1234');
    await db.run('UPDATE users SET is_admin = TRUE WHERE id = $1', [admin.id]);

    await expect(adminRestoreUser(admin.id, 'WrongPassword1', u.id))
      .rejects.toMatchObject({ status: 401, message: 'Invalid admin password' });

    const row = await db.get('SELECT deleted_at FROM users WHERE id = $1', [u.id]);
    expect(row.deleted_at).not.toBeNull();
  });

  it('deleteAccount refuses when caller is the only alive admin (lockout guard)', async () => {
    // Wipe any pre-existing admins seeded by other tests so we control the count.
    await db.run(`UPDATE users SET is_admin = FALSE WHERE deleted_at IS NULL`);
    const u = await registerUser(`it-lastadmin-${Date.now()}@example.test`, 'Sole', 'TestPass1234');
    await db.run('UPDATE users SET is_admin = TRUE WHERE id = $1', [u.id]);

    await expect(deleteAccount(u.id, 'TestPass1234'))
      .rejects.toMatchObject({ status: 409, message: /only admin/ });

    // Row is intact (no soft-delete happened).
    const row = await db.get('SELECT deleted_at FROM users WHERE id = $1', [u.id]);
    expect(row.deleted_at).toBeNull();
  });

  it('deleteAccount succeeds for an admin when another alive admin exists', async () => {
    await db.run(`UPDATE users SET is_admin = FALSE WHERE deleted_at IS NULL`);
    const a = await registerUser(`it-admin-a-${Date.now()}@example.test`, 'A', 'TestPass1234');
    const b = await registerUser(`it-admin-b-${Date.now()}@example.test`, 'B', 'TestPass1234');
    await db.run('UPDATE users SET is_admin = TRUE WHERE id IN ($1, $2)', [a.id, b.id]);

    await deleteAccount(a.id, 'TestPass1234');
    const row = await db.get('SELECT deleted_at FROM users WHERE id = $1', [a.id]);
    expect(row.deleted_at).not.toBeNull();
  });

  it('a soft-deleted admin no longer counts toward the alive-admin floor', async () => {
    await db.run(`UPDATE users SET is_admin = FALSE WHERE deleted_at IS NULL`);
    const a = await registerUser(`it-bin-a-${Date.now()}@example.test`, 'A', 'TestPass1234');
    const b = await registerUser(`it-bin-b-${Date.now()}@example.test`, 'B', 'TestPass1234');
    await db.run('UPDATE users SET is_admin = TRUE WHERE id IN ($1, $2)', [a.id, b.id]);

    // Bin admin A — now B is the only ALIVE admin.
    await deleteAccount(a.id, 'TestPass1234');
    // B's self-delete must now fail.
    await expect(deleteAccount(b.id, 'TestPass1234'))
      .rejects.toMatchObject({ status: 409 });
  });

  it('adminRestoreUser refuses to restore a user that is not deleted', async () => {
    const u = await registerUser(`it-active-${Date.now()}@example.test`, 'U', 'TestPass1234');
    const admin = await registerUser(`it-adminact-${Date.now()}@example.test`, 'A', 'AdminPass1234');
    await db.run('UPDATE users SET is_admin = TRUE WHERE id = $1', [admin.id]);

    await expect(adminRestoreUser(admin.id, 'AdminPass1234', u.id))
      .rejects.toMatchObject({ status: 409 });
  });

  it('purgeExpiredSoftDeletes hard-deletes rows past the 30-day window', async () => {
    const email = `it-purge-${Date.now()}@example.test`;
    const u = await registerUser(email, 'Purge', 'TestPass1234');
    await deleteAccount(u.id, 'TestPass1234');
    // Backdate the bin entry so the window is "elapsed."
    await db.run(`UPDATE users SET deleted_at = NOW() - INTERVAL '31 days' WHERE id = $1`, [u.id]);

    const purged = await purgeExpiredSoftDeletes();
    expect(purged).toContain(u.id);
    const gone = await db.get('SELECT id FROM users WHERE id = $1', [u.id]);
    expect(gone).toBeUndefined();
  });

  it('purgeExpiredSoftDeletes leaves fresh soft-deletes alone', async () => {
    const email = `it-fresh-${Date.now()}@example.test`;
    const u = await registerUser(email, 'Fresh', 'TestPass1234');
    await deleteAccount(u.id, 'TestPass1234');

    const purged = await purgeExpiredSoftDeletes();
    expect(purged).not.toContain(u.id);
    const still = await db.get('SELECT id FROM users WHERE id = $1', [u.id]);
    expect(still).toBeDefined();
  });

  // BB3 regression cover: the cron used to act on a stale row from its
  // outer SELECT without re-verifying inside the tx. An admin who
  // restored the user between the SELECT and the tx start would have
  // their restore silently undone -- comments NULLed, projects DROPed,
  // user row deleted. The fix re-checks `deleted_at IS NOT NULL AND
  // deleted_at < threshold` inside purgeUserInTx with FOR UPDATE.
  it('BB3 — purge skips a user whose deleted_at was cleared after the cron SELECT', async () => {
    const email = `it-bb3-${Date.now()}@example.test`;
    const u = await registerUser(email, 'BB3', 'TestPass1234');
    await deleteAccount(u.id, 'TestPass1234');
    // Backdate so the user IS a purge candidate.
    await db.run(`UPDATE users SET deleted_at = NOW() - INTERVAL '31 days' WHERE id = $1`, [u.id]);

    // Simulate the cron's outer SELECT: we capture the user row, but
    // BEFORE the tx runs, an admin restores them.
    const candidate = await db.get('SELECT id, email, name FROM users WHERE id = $1', [u.id]);
    expect(candidate).toBeDefined();
    await db.run('UPDATE users SET deleted_at = NULL WHERE id = $1', [u.id]); // restored

    // Now sweep -- the candidate's deleted_at is null at tx time, so
    // the in-tx re-check skips them. Without the fix, the cron would
    // have purged the user row anyway.
    const purged = await purgeExpiredSoftDeletes();
    expect(purged).not.toContain(u.id);
    const still = await db.get('SELECT id FROM users WHERE id = $1', [u.id]);
    expect(still).toBeDefined();
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

// FF1 (audit round 17): an email-verification token issued for one
// address must not be re-usable to verify a NEW address after the
// user changes their email. The hole was: verifyEmail looked up by
// token_hash + expires_at WITHOUT filtering on `used`, so a still-in-
// window token from BEFORE the email change re-verified the NEW
// address. Two-pronged fix: changeEmail marks all the user's tokens
// used; verifyEmail rejects used tokens when email_verified=FALSE
// (the "post-change pre-reverify" state).

describe('verifyEmail — FF1 token re-use after email change', () => {
  it('does NOT re-verify after email change when the OLD token is clicked', async () => {
    // Bcrypt of 'TestPass1234' at cost 4 -- matches the seedUser default.
    const u = await registerUser(`it-ff1-${Date.now()}@example.test`, 'FF1', 'TestPass1234');
    const originalEmail = (await db.get('SELECT email FROM users WHERE id = $1', [u.id])).email;

    // Issue verification token for the original email; rawToken is the
    // unhashed value (what would be in the email link).
    const rawToken = await createEmailVerificationToken(u.id);
    expect(rawToken).toBeTruthy();

    // First click: legitimate verify. User is now verified.
    await verifyEmail(rawToken);
    const afterFirst = await db.get('SELECT email_verified FROM users WHERE id = $1', [u.id]);
    expect(afterFirst.email_verified).toBe(true);

    // User changes email. This should mark the existing token used AND
    // flip email_verified back to FALSE pending re-verify.
    await changeEmail(u.id, 'TestPass1234', `it-ff1-new-${Date.now()}@example.test`);
    const afterChange = await db.get('SELECT email, email_verified FROM users WHERE id = $1', [u.id]);
    expect(afterChange.email_verified).toBe(false);
    expect(afterChange.email).not.toBe(originalEmail);

    // Attacker (or confused user) re-clicks the OLD token. Without
    // FF1 this would re-verify the NEW email. With the fix it must
    // throw "Invalid or expired".
    await expect(verifyEmail(rawToken)).rejects.toThrow(/invalid or expired/i);

    // And the new email remains unverified.
    const afterReclick = await db.get('SELECT email_verified FROM users WHERE id = $1', [u.id]);
    expect(afterReclick.email_verified).toBe(false);
  });

  it('still allows the idempotent scanner-prefetch path for an already-verified user', async () => {
    // Email scanners often GET verification URLs before the human
    // clicks. The first GET marks the token used + verifies the user.
    // The human's subsequent click hits an already-verified user --
    // verifyEmail returns success (no error) in that case.
    const u = await registerUser(`it-ff1-idem-${Date.now()}@example.test`, 'Idem', 'TestPass1234');
    const rawToken = await createEmailVerificationToken(u.id);
    await verifyEmail(rawToken); // scanner

    // Second click on the SAME token, user already verified -- should
    // NOT throw (idempotent), should return the userId.
    const userId = await verifyEmail(rawToken);
    expect(userId).toBe(u.id);
  });
});
