import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import db from '../db.js';
import { encrypt, decrypt } from '../utils/crypto.js';

const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_WINDOW_MINUTES = 15;

// Track used TOTP codes to prevent replay
const usedTotpCodes = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of usedTotpCodes) {
    if (now > expiry) usedTotpCodes.delete(key);
  }
  db.run('DELETE FROM used_totp_codes WHERE expires_at < NOW()').catch(() => {});
}, 60000).unref();

export function decryptTotpSecret(encrypted) {
  if (!encrypted) return null;
  try {
    return decrypt(encrypted);
  } catch {
    return encrypted;
  }
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 128) return 'Password must be at most 128 characters';
  if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain a number';
  return null;
}

export async function isAccountLocked(email) {
  const result = await db.get(
    `SELECT COUNT(*) AS cnt FROM login_attempts WHERE email = $1 AND success = FALSE AND created_at > NOW() - INTERVAL '${LOCKOUT_WINDOW_MINUTES} minutes'`,
    [email],
  );
  return parseInt(result?.cnt || 0) >= MAX_FAILED_ATTEMPTS;
}

export async function recordLoginAttempt(email, ip, success) {
  await db.run('INSERT INTO login_attempts (email, ip, success) VALUES ($1, $2, $3)', [email, ip || null, success]);
  if (success) await db.run('DELETE FROM login_attempts WHERE email = $1 AND success = FALSE', [email]);
}

async function isTotpUsed(userId, code) {
  const key = `${userId}:${code}`;
  if (usedTotpCodes.has(key)) return true;
  const row = await db
    .get('SELECT 1 FROM used_totp_codes WHERE user_id = $1 AND code = $2 AND expires_at > NOW()', [userId, code])
    .catch(() => null);
  return !!row;
}

async function markTotpUsed(userId, code) {
  const key = `${userId}:${code}`;
  usedTotpCodes.set(key, Date.now() + 90000);
  await db
    .run(
      "INSERT INTO used_totp_codes (user_id, code, expires_at) VALUES ($1, $2, NOW() + INTERVAL '90 seconds') ON CONFLICT DO NOTHING",
      [userId, code],
    )
    .catch(() => {});
}

// --- Core auth operations ---

export async function registerUser(email, name, password) {
  const pwError = validatePassword(password);
  if (pwError) throw Object.assign(new Error(pwError), { status: 400 });

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await db.get('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
  if (existing)
    throw Object.assign(new Error('Unable to create account. Please try a different email or log in.'), {
      status: 409,
    });

  const id = uuid();
  const password_hash = await bcrypt.hash(password, 12);
  await db.run('INSERT INTO users (id, email, name, password_hash, email_verified) VALUES ($1, $2, $3, $4, FALSE)', [
    id,
    normalizedEmail,
    name.trim(),
    password_hash,
  ]);
  return { id, email: normalizedEmail, name: name.trim(), totpEnabled: false, isAdmin: false, emailVerified: false };
}

export async function createEmailVerificationToken(userId) {
  // Rate limit: max 3 tokens per hour
  const recent = await db.get(
    `SELECT COUNT(*) AS cnt FROM email_verification_tokens WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [userId],
  );
  if (parseInt(recent?.cnt || 0) >= 3) return null;

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await db.run(
    `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
    [uuid(), userId, tokenHash],
  );
  return token;
}

export async function verifyEmail(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = await db.get(
    `UPDATE email_verification_tokens SET used = TRUE
     WHERE token_hash = $1 AND used = FALSE AND expires_at > NOW()
     RETURNING user_id`,
    [tokenHash],
  );
  if (!row) throw Object.assign(new Error('Invalid or expired verification link'), { status: 400 });

  await db.run('UPDATE users SET email_verified = TRUE WHERE id = $1', [row.user_id]);
  // Invalidate other tokens for this user
  await db.run('UPDATE email_verification_tokens SET used = TRUE WHERE user_id = $1', [row.user_id]);
  return row.user_id;
}

export async function authenticateUser(email, password) {
  const normalizedEmail = email.toLowerCase().trim();
  const user = await db.get(
    'SELECT id, email, name, password_hash, totp_enabled, totp_secret, is_admin, email_verified FROM users WHERE email = $1',
    [normalizedEmail],
  );
  if (!user) return { error: 'Invalid credentials', status: 401 };

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return { error: 'Invalid credentials', status: 401 };

  if (!user.email_verified) {
    return { error: 'Please verify your email address before signing in. Check your inbox for a verification link.', status: 403, unverified: true, userId: user.id };
  }

  return { user };
}

export async function verifyTotp(userId, code, totpSecret) {
  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(decryptTotpSecret(totpSecret)),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) return { error: 'Invalid verification code', status: 401 };
  if (await isTotpUsed(userId, code)) return { error: 'Verification code already used', status: 401 };
  await markTotpUsed(userId, code);
  return { ok: true };
}

export async function createTrustedDevice(userId, userAgent) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const deviceName = userAgent?.substring(0, 200) || 'Unknown device';
  const TRUST_DAYS = 30;
  await db.run(
    `INSERT INTO trusted_devices (id, user_id, token_hash, device_name, expires_at) VALUES ($1, $2, $3, $4, NOW() + INTERVAL '${TRUST_DAYS} days')`,
    [uuid(), userId, tokenHash, deviceName],
  );
  return { token, maxAge: TRUST_DAYS * 24 * 60 * 60 * 1000 };
}

export async function checkTrustedDevice(userId, trustCookie) {
  if (!trustCookie) return false;
  const tokenHash = crypto.createHash('sha256').update(trustCookie).digest('hex');
  const device = await db.get(
    'SELECT id FROM trusted_devices WHERE token_hash = $1 AND user_id = $2 AND expires_at > NOW()',
    [tokenHash, userId],
  );
  return !!device;
}

export async function getCurrentUser(userId) {
  const user = await db.get('SELECT id, email, name, totp_enabled, is_admin FROM users WHERE id = $1', [userId]);
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    totpEnabled: !!user.totp_enabled,
    isAdmin: !!user.is_admin,
  };
}

// --- TOTP management ---

export async function setupTotp(userId) {
  const user = await db.get('SELECT id, email, totp_enabled FROM users WHERE id = $1', [userId]);
  if (!user) throw Object.assign(new Error('User not found'), { status: 401 });
  if (user.totp_enabled) throw Object.assign(new Error('MFA is already enabled'), { status: 400 });

  const secret = new OTPAuth.Secret();
  const totp = new OTPAuth.TOTP({
    issuer: 'FlowTex',
    label: user.email,
    secret,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
  const qrDataUrl = await QRCode.toDataURL(totp.toString());
  await db.run('UPDATE users SET totp_secret = $1 WHERE id = $2', [encrypt(secret.base32), user.id]);
  return { secret: secret.base32, qrCode: qrDataUrl };
}

export async function verifyAndEnableTotp(userId, code) {
  const user = await db.get('SELECT id, totp_secret, totp_enabled FROM users WHERE id = $1', [userId]);
  if (!user) throw Object.assign(new Error('User not found'), { status: 401 });
  if (!user.totp_secret) throw Object.assign(new Error('Run setup first'), { status: 400 });
  if (user.totp_enabled) throw Object.assign(new Error('MFA is already enabled'), { status: 400 });

  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(user.totp_secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) throw Object.assign(new Error('Invalid code. Please try again.'), { status: 400 });

  await db.run('UPDATE users SET totp_enabled = TRUE WHERE id = $1', [user.id]);
}

export async function disableTotp(userId, password) {
  const user = await db.get('SELECT id, password_hash, totp_enabled FROM users WHERE id = $1', [userId]);
  if (!user) throw Object.assign(new Error('User not found'), { status: 401 });
  if (!user.totp_enabled) throw Object.assign(new Error('MFA is not enabled'), { status: 400 });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw Object.assign(new Error('Invalid password'), { status: 401 });

  await db.run('UPDATE users SET totp_enabled = FALSE, totp_secret = NULL WHERE id = $1', [user.id]);
  await db.run('DELETE FROM trusted_devices WHERE user_id = $1', [user.id]);
}

// --- Password management ---

export async function createPasswordResetToken(email) {
  const normalizedEmail = email.toLowerCase().trim();
  const user = await db.get('SELECT id, email FROM users WHERE email = $1', [normalizedEmail]);
  if (!user) return null; // Don't reveal user existence

  const recentTokens = await db.get(
    `SELECT COUNT(*) AS cnt FROM password_reset_tokens WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [user.id],
  );
  if (parseInt(recentTokens?.cnt || 0) >= 3) return null;

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await db.run(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')`,
    [uuid(), user.id, tokenHash],
  );
  return { token, userId: user.id, email: user.email };
}

export async function resetPassword(token, newPassword) {
  const pwError = validatePassword(newPassword);
  if (pwError) throw Object.assign(new Error(pwError), { status: 400 });

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const resetToken = await db.get(
    `UPDATE password_reset_tokens SET used = TRUE WHERE token_hash = $1 AND used = FALSE AND expires_at > NOW() RETURNING id, user_id`,
    [tokenHash],
  );
  if (!resetToken) throw Object.assign(new Error('Invalid or expired reset link'), { status: 400 });

  const currentUser = await db.get('SELECT password_hash FROM users WHERE id = $1', [resetToken.user_id]);
  if (currentUser && (await bcrypt.compare(newPassword, currentUser.password_hash))) {
    await db.run('UPDATE password_reset_tokens SET used = FALSE WHERE id = $1', [resetToken.id]);
    throw Object.assign(new Error('New password must be different from your current password'), { status: 400 });
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db.run('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, resetToken.user_id]);
  await db.run('UPDATE password_reset_tokens SET used = TRUE WHERE user_id = $1 AND id != $2', [
    resetToken.user_id,
    resetToken.id,
  ]);
  await db.run(`DELETE FROM session WHERE sess->>'userId' = $1`, [resetToken.user_id]);
  await db.run('DELETE FROM trusted_devices WHERE user_id = $1', [resetToken.user_id]);
  return resetToken.user_id;
}

export async function changeEmail(userId, password, newEmail) {
  const normalizedEmail = newEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))
    throw Object.assign(new Error('Invalid email address'), { status: 400 });

  const user = await db.get('SELECT id, email, password_hash FROM users WHERE id = $1', [userId]);
  if (!user) throw Object.assign(new Error('User not found'), { status: 401 });
  if (!(await bcrypt.compare(password, user.password_hash)))
    throw Object.assign(new Error('Incorrect password'), { status: 401 });
  if (normalizedEmail === user.email)
    throw Object.assign(new Error('New email is the same as your current email'), { status: 400 });

  const existing = await db.get('SELECT 1 FROM users WHERE email = $1', [normalizedEmail]);
  if (existing) throw Object.assign(new Error('An account with this email already exists'), { status: 409 });

  await db.run('UPDATE users SET email = $1 WHERE id = $2', [normalizedEmail, user.id]);
  return { email: normalizedEmail, oldEmail: user.email };
}

export async function changePassword(userId, currentPassword, newPassword) {
  const user = await db.get('SELECT id, password_hash FROM users WHERE id = $1', [userId]);
  if (!user) throw Object.assign(new Error('User not found'), { status: 401 });
  if (!(await bcrypt.compare(currentPassword, user.password_hash)))
    throw Object.assign(new Error('Current password is incorrect'), { status: 401 });
  if (currentPassword === newPassword)
    throw Object.assign(new Error('New password must be different from your current password'), { status: 400 });

  const pwError = validatePassword(newPassword);
  if (pwError) throw Object.assign(new Error(pwError), { status: 400 });

  const newHash = await bcrypt.hash(newPassword, 12);
  await db.run('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);
}

export async function deleteAccount(userId, password) {
  const user = await db.get('SELECT id, email, password_hash FROM users WHERE id = $1', [userId]);
  if (!user) throw Object.assign(new Error('User not found'), { status: 401 });
  if (!(await bcrypt.compare(password, user.password_hash)))
    throw Object.assign(new Error('Invalid password'), { status: 401 });

  await db.transaction(async (tx) => {
    await tx.run('UPDATE comments SET author_id = NULL WHERE author_id = $1', [user.id]);
    await tx.run('UPDATE comment_replies SET author_id = NULL WHERE author_id = $1', [user.id]);
    await tx.run('UPDATE file_versions SET author_id = NULL WHERE author_id = $1', [user.id]);
    await tx.run('UPDATE project_snapshots SET author_id = NULL WHERE author_id = $1', [user.id]);
    await tx.run('DELETE FROM project_invitations WHERE inviter_id = $1', [user.id]);
    await tx.run('DELETE FROM project_github_links WHERE linked_by = $1', [user.id]);
    await tx.run('UPDATE audit_log SET user_id = NULL WHERE user_id = $1', [user.id]);
    await tx.run('DELETE FROM login_attempts WHERE email = $1', [user.email]);
    await tx.run(
      `DELETE FROM projects WHERE id IN (
      SELECT p.id FROM projects p JOIN project_members pm ON p.id = pm.project_id
      WHERE pm.user_id = $1 AND pm.role = 'owner'
        AND NOT EXISTS (SELECT 1 FROM project_members pm2 WHERE pm2.project_id = p.id AND pm2.user_id != $1)
    )`,
      [user.id],
    );
    await tx.run('DELETE FROM users WHERE id = $1', [user.id]);
  });
}
