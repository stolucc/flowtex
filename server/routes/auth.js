import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { auditLog } from '../utils/audit.js';
import { sendPasswordResetEmail } from '../utils/email.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import logger from '../logger.js';

const router = Router();

function decryptTotpSecret(encrypted) {
  if (!encrypted) return null;
  try {
    return decrypt(encrypted);
  } catch {
    // Legacy plaintext secret — return as-is, will be re-encrypted on next setup
    return encrypted;
  }
}

const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_WINDOW_MINUTES = 15;

// Track used TOTP codes to prevent replay within their validity window (~90s)
// Uses DB for horizontal scaling; in-memory fallback cleaned up periodically
const usedTotpCodes = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, expiry] of usedTotpCodes) {
    if (now > expiry) usedTotpCodes.delete(key);
  }
  // Clean up DB entries older than 2 minutes
  db.run("DELETE FROM used_totp_codes WHERE expires_at < NOW()").catch(() => {});
}, 60000).unref();

async function isTotpUsed(userId, code) {
  // Check in-memory first (fast path)
  const key = `${userId}:${code}`;
  if (usedTotpCodes.has(key)) return true;
  // Check DB for cross-instance replay prevention
  const row = await db.get(
    'SELECT 1 FROM used_totp_codes WHERE user_id = $1 AND code = $2 AND expires_at > NOW()',
    [userId, code]
  ).catch(() => null);
  return !!row;
}

async function markTotpUsed(userId, code) {
  const key = `${userId}:${code}`;
  usedTotpCodes.set(key, Date.now() + 90000);
  await db.run(
    "INSERT INTO used_totp_codes (user_id, code, expires_at) VALUES ($1, $2, NOW() + INTERVAL '90 seconds') ON CONFLICT DO NOTHING",
    [userId, code]
  ).catch(() => {});
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  if (password.length > 128) {
    return 'Password must be at most 128 characters';
  }
  if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain a number';
  return null;
}

async function isAccountLocked(email) {
  const result = await db.get(
    `SELECT COUNT(*) AS cnt FROM login_attempts
     WHERE email = $1 AND success = FALSE
       AND created_at > NOW() - INTERVAL '${LOCKOUT_WINDOW_MINUTES} minutes'`,
    [email]
  );
  return (parseInt(result?.cnt || 0)) >= MAX_FAILED_ATTEMPTS;
}

async function recordLoginAttempt(email, ip, success) {
  await db.run(
    'INSERT INTO login_attempts (email, ip, success) VALUES ($1, $2, $3)',
    [email, ip || null, success]
  );
  // Clear old attempts on success
  if (success) {
    await db.run(
      'DELETE FROM login_attempts WHERE email = $1 AND success = FALSE',
      [email]
    );
  }
}

function regenerateSession(req, res) {
  return new Promise((resolve, reject) => {
    const userId = req.session.userId;
    req.session.regenerate((err) => {
      if (err) return reject(err);
      // Restore user ID and generate a fresh CSRF token for the new session
      req.session.userId = userId;
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      // Set the fresh CSRF cookie so the client has it immediately
      res.cookie('csrf-token', req.session.csrfToken, {
        httpOnly: false,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
      });
      // Persist to DB before responding — prevents race where the client's
      // next request arrives before the session is saved to PostgreSQL
      req.session.save((saveErr) => {
        if (saveErr) return reject(saveErr);
        resolve();
      });
    });
  });
}

// Register
router.post('/register', async (req, res) => {
  const { email, name, password } = req.body;
  if (!email || !name || !password) {
    return res.status(400).json({ error: 'Email, name, and password are required' });
  }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 200) {
    return res.status(400).json({ error: 'Name must be 1–200 characters' });
  }
  const pwError = validatePassword(password);
  if (pwError) return res.status(400).json({ error: pwError });

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await db.get('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
  if (existing) {
    return res.status(409).json({ error: 'Unable to create account. Please try a different email or log in.' });
  }

  const id = uuid();
  const password_hash = await bcrypt.hash(password, 12);
  await db.run(
    'INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)',
    [id, normalizedEmail, name.trim(), password_hash]
  );

  req.session.userId = id;
  await regenerateSession(req, res);
  await auditLog(id, 'register', { ip: req.ip });
  res.json({ id, email: normalizedEmail, name: name.trim(), totpEnabled: false, isAdmin: false });
});

// Login
router.post('/login', async (req, res) => {
  const { email, password, totpCode, trustDevice } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Check account lockout
  if (await isAccountLocked(normalizedEmail)) {
    return res.status(429).json({ error: `Too many failed attempts. Please try again in ${LOCKOUT_WINDOW_MINUTES} minutes.` });
  }

  const user = await db.get(
    'SELECT id, email, name, password_hash, totp_enabled, totp_secret, is_admin FROM users WHERE email = $1',
    [normalizedEmail]
  );
  if (!user) {
    await recordLoginAttempt(normalizedEmail, req.ip, false);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    await recordLoginAttempt(normalizedEmail, req.ip, false);
    await auditLog(user.id, 'login_failed', { ip: req.ip });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // If MFA is enabled, check for trusted device or require TOTP code
  if (user.totp_enabled) {
    // Check for trusted device cookie
    const trustCookie = req.cookies?.['trusted-device'];
    let deviceTrusted = false;
    if (trustCookie) {
      const tokenHash = crypto.createHash('sha256').update(trustCookie).digest('hex');
      const device = await db.get(
        'SELECT id FROM trusted_devices WHERE token_hash = $1 AND user_id = $2 AND expires_at > NOW()',
        [tokenHash, user.id]
      );
      if (device) deviceTrusted = true;
    }

    if (!deviceTrusted) {
      if (!totpCode) {
        return res.status(200).json({ mfaRequired: true });
      }

      const totp = new OTPAuth.TOTP({
        secret: OTPAuth.Secret.fromBase32(decryptTotpSecret(user.totp_secret)),
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
      });

      const delta = totp.validate({ token: totpCode, window: 1 });
      if (delta === null) {
        await recordLoginAttempt(normalizedEmail, req.ip, false);
        return res.status(401).json({ error: 'Invalid verification code' });
      }

      // Prevent TOTP replay — reject codes already used within their validity window
      if (await isTotpUsed(user.id, totpCode)) {
        await recordLoginAttempt(normalizedEmail, req.ip, false);
        return res.status(401).json({ error: 'Verification code already used' });
      }
      await markTotpUsed(user.id, totpCode);

      // If user wants to trust this device, create a trust token
      if (trustDevice) {
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const deviceName = req.headers['user-agent']?.substring(0, 200) || 'Unknown device';
        const TRUST_DAYS = 30;
        await db.run(
          `INSERT INTO trusted_devices (id, user_id, token_hash, device_name, expires_at)
           VALUES ($1, $2, $3, $4, NOW() + INTERVAL '${TRUST_DAYS} days')`,
          [uuid(), user.id, tokenHash, deviceName]
        );
        res.cookie('trusted-device', token, {
          httpOnly: true,
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
          maxAge: TRUST_DAYS * 24 * 60 * 60 * 1000,
          path: '/',
        });
      }
    }
  }

  // Successful login — record, regenerate session
  await recordLoginAttempt(normalizedEmail, req.ip, true);
  req.session.userId = user.id;
  await regenerateSession(req, res);
  await auditLog(user.id, 'login', { ip: req.ip });
  res.json({ id: user.id, email: user.email, name: user.name, totpEnabled: !!user.totp_enabled, isAdmin: !!user.is_admin });
});

// Logout
router.post('/logout', (req, res) => {
  const userId = req.session?.userId;
  // Keep trusted-device cookie so MFA is skipped on next login
  req.session.destroy(async () => {
    res.clearCookie('__session', { path: '/' });
    if (userId) await auditLog(userId, 'logout', { ip: req.ip }).catch(() => {});
    res.json({ ok: true });
  });
});

// Get current user
router.get('/me', requireAuth, async (req, res) => {
  const user = await db.get('SELECT id, email, name, totp_enabled, is_admin FROM users WHERE id = $1', [req.session.userId]);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }
  res.json({ id: user.id, email: user.email, name: user.name, totpEnabled: !!user.totp_enabled, isAdmin: !!user.is_admin });
});

// ── TOTP MFA endpoints ──────────────────────────────────────────────────

// Generate TOTP secret and QR code for setup
router.post('/totp/setup', requireAuth, async (req, res) => {
  const user = await db.get('SELECT id, email, totp_enabled FROM users WHERE id = $1', [req.session.userId]);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (user.totp_enabled) return res.status(400).json({ error: 'MFA is already enabled' });

  const secret = new OTPAuth.Secret();
  const totp = new OTPAuth.TOTP({
    issuer: 'FlowTex',
    label: user.email,
    secret,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });

  const otpauthUrl = totp.toString();
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl);

  await db.run('UPDATE users SET totp_secret = $1 WHERE id = $2', [encrypt(secret.base32), user.id]);

  res.json({
    secret: secret.base32,
    qrCode: qrDataUrl,
  });
});

// Verify TOTP code to enable MFA
router.post('/totp/verify', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Verification code required' });

  const user = await db.get('SELECT id, totp_secret, totp_enabled FROM users WHERE id = $1', [req.session.userId]);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (!user.totp_secret) return res.status(400).json({ error: 'Run setup first' });
  if (user.totp_enabled) return res.status(400).json({ error: 'MFA is already enabled' });

  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(user.totp_secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });

  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) {
    return res.status(400).json({ error: 'Invalid code. Please try again.' });
  }

  await db.run('UPDATE users SET totp_enabled = TRUE WHERE id = $1', [user.id]);
  await auditLog(user.id, 'mfa_enabled', { ip: req.ip });
  res.json({ ok: true });
});

// Disable MFA (requires current password)
router.post('/totp/disable', requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  const user = await db.get('SELECT id, password_hash, totp_enabled FROM users WHERE id = $1', [req.session.userId]);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (!user.totp_enabled) return res.status(400).json({ error: 'MFA is not enabled' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid password' });

  await db.run('UPDATE users SET totp_enabled = FALSE, totp_secret = NULL WHERE id = $1', [user.id]);
  await db.run('DELETE FROM trusted_devices WHERE user_id = $1', [user.id]);
  res.clearCookie('trusted-device', { path: '/' });
  await auditLog(user.id, 'mfa_disabled', { ip: req.ip });
  res.json({ ok: true });
});

// ── Forgot password ───────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const normalizedEmail = email.toLowerCase().trim();
  const user = await db.get('SELECT id, email FROM users WHERE email = $1', [normalizedEmail]);

  // Always return success to prevent user enumeration
  if (!user) {
    return res.json({ ok: true });
  }

  // Rate limit: max 3 reset tokens per user per hour
  const recentTokens = await db.get(
    `SELECT COUNT(*) AS cnt FROM password_reset_tokens
     WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [user.id]
  );
  if (parseInt(recentTokens?.cnt || 0) >= 3) {
    return res.json({ ok: true }); // Silent — don't reveal rate limit
  }

  // Generate a secure random token
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const id = uuid();

  await db.run(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')`,
    [id, user.id, tokenHash]
  );

  const baseUrl = process.env.APP_URL || `http://localhost:3001`;
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;

  try {
    await sendPasswordResetEmail(user.email, resetUrl);
  } catch (err) {
    logger.error({ err }, 'Failed to send reset email');
  }

  await auditLog(user.id, 'password_reset_requested', { ip: req.ip });
  res.json({ ok: true });
});

// Reset password with token
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: 'Token and new password are required' });
  }

  const pwError = validatePassword(password);
  if (pwError) return res.status(400).json({ error: pwError });

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  // Atomically claim the token to prevent race conditions (TOCTOU)
  const resetToken = await db.get(
    `UPDATE password_reset_tokens SET used = TRUE
     WHERE token_hash = $1 AND used = FALSE AND expires_at > NOW()
     RETURNING id, user_id`,
    [tokenHash]
  );

  if (!resetToken) {
    return res.status(400).json({ error: 'Invalid or expired reset link' });
  }

  // Prevent reusing current password
  const currentUser = await db.get('SELECT password_hash FROM users WHERE id = $1', [resetToken.user_id]);
  if (currentUser && await bcrypt.compare(password, currentUser.password_hash)) {
    // Un-claim the token so user can retry with a different password
    await db.run('UPDATE password_reset_tokens SET used = FALSE WHERE id = $1', [resetToken.id]);
    return res.status(400).json({ error: 'New password must be different from your current password' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await db.run('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, resetToken.user_id]);

  // Invalidate all other reset tokens for this user
  await db.run(
    'UPDATE password_reset_tokens SET used = TRUE WHERE user_id = $1 AND id != $2',
    [resetToken.user_id, resetToken.id]
  );

  // Invalidate all existing sessions for this user
  await db.run(
    `DELETE FROM session WHERE sess->>'userId' = $1`,
    [resetToken.user_id]
  );

  // Invalidate all trusted devices so MFA is re-required
  await db.run('DELETE FROM trusted_devices WHERE user_id = $1', [resetToken.user_id]);

  await auditLog(resetToken.user_id, 'password_reset', { ip: req.ip });
  res.json({ ok: true });
});

// ── Change email ─────────────────────────────────────────────────────
router.post('/change-email', requireAuth, async (req, res) => {
  const { password, newEmail } = req.body;
  if (!password || !newEmail) {
    return res.status(400).json({ error: 'Password and new email are required' });
  }

  const normalizedEmail = newEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const user = await db.get('SELECT id, email, password_hash FROM users WHERE id = $1', [req.session.userId]);
  if (!user) return res.status(401).json({ error: 'User not found' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Incorrect password' });

  if (normalizedEmail === user.email) {
    return res.status(400).json({ error: 'New email is the same as your current email' });
  }

  const existing = await db.get('SELECT 1 FROM users WHERE email = $1', [normalizedEmail]);
  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  await db.run('UPDATE users SET email = $1 WHERE id = $2', [normalizedEmail, user.id]);
  await auditLog(user.id, 'email_changed', { ip: req.ip, oldEmail: user.email, newEmail: normalizedEmail });
  res.json({ ok: true, email: normalizedEmail });
});

// ── Change password ───────────────────────────────────────────────────
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }

  const user = await db.get('SELECT id, password_hash FROM users WHERE id = $1', [req.session.userId]);
  if (!user) return res.status(401).json({ error: 'User not found' });

  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'New password must be different from your current password' });
  }

  const pwError = validatePassword(newPassword);
  if (pwError) return res.status(400).json({ error: pwError });

  const newHash = await bcrypt.hash(newPassword, 12);
  await db.run('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);

  await auditLog(user.id, 'password_changed', { ip: req.ip });
  res.json({ ok: true });
});

// ── Delete account ─────────────────────────────────────────────────────
router.post('/delete-account', requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  const user = await db.get('SELECT id, email, password_hash FROM users WHERE id = $1', [req.session.userId]);
  if (!user) return res.status(401).json({ error: 'User not found' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid password' });

  await db.transaction(async (tx) => {
    // Nullify author references so comments/replies/versions aren't lost
    await tx.run('UPDATE comments SET author_id = NULL WHERE author_id = $1', [user.id]);
    await tx.run('UPDATE comment_replies SET author_id = NULL WHERE author_id = $1', [user.id]);
    await tx.run('UPDATE file_versions SET author_id = NULL WHERE author_id = $1', [user.id]);
    await tx.run('UPDATE project_snapshots SET author_id = NULL WHERE author_id = $1', [user.id]);

    // Clean up records without CASCADE
    await tx.run('DELETE FROM project_invitations WHERE inviter_id = $1', [user.id]);
    await tx.run('DELETE FROM project_github_links WHERE linked_by = $1', [user.id]);
    await tx.run('UPDATE audit_log SET user_id = NULL WHERE user_id = $1', [user.id]);
    await tx.run('DELETE FROM login_attempts WHERE email = $1', [user.email]);

    // Delete projects owned solely by this user (no other members)
    await tx.run(`
      DELETE FROM projects WHERE id IN (
        SELECT p.id FROM projects p
        JOIN project_members pm ON p.id = pm.project_id
        WHERE pm.user_id = $1 AND pm.role = 'owner'
          AND NOT EXISTS (
            SELECT 1 FROM project_members pm2
            WHERE pm2.project_id = p.id AND pm2.user_id != $1
          )
      )
    `, [user.id]);

    // The user row deletion cascades to: project_members, github_tokens, tags
    await tx.run('DELETE FROM users WHERE id = $1', [user.id]);
  });

  await auditLog(user.id, 'account_deleted', { ip: req.ip }).catch(() => {});

  // Destroy the session
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

export default router;
