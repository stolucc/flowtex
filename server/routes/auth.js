import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { auditLog } from '../utils/audit.js';
import { sendPasswordResetEmail, sendEmailVerificationEmail } from '../utils/email.js';
import logger from '../logger.js';
import db from '../db.js';
import * as authService from '../services/authService.js';
import { sendError } from '../middleware/errorHandler.js';

const router = Router();

function regenerateSession(req, res) {
  return new Promise((resolve, reject) => {
    const { userId, userName } = req.session;
    req.session.regenerate((err) => {
      if (err) {
        // Destroy the broken session to prevent inconsistent state
        req.session.destroy(() => {});
        return reject(new Error('Session regeneration failed'));
      }
      req.session.userId = userId;
      req.session.userName = userName;
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      res.cookie('csrf-token', req.session.csrfToken, {
        httpOnly: false,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
      });
      req.session.save((saveErr) => {
        if (saveErr) {
          // Destroy on save failure to prevent half-initialized session
          req.session.destroy(() => {});
          return reject(new Error('Session save failed'));
        }
        resolve();
      });
    });
  });
}

// Register
router.post('/register', async (req, res) => {
  const { email, name, password } = req.body;
  if (!email || !name || !password) return res.status(400).json({ error: 'Email, name, and password are required' });
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Invalid email format' });
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 200)
    return res.status(400).json({ error: 'Name must be 1–200 characters' });
  try {
    const user = await authService.registerUser(email, name, password);
    await auditLog(user.id, 'register', { ip: req.ip });

    // Send verification email
    const baseUrl = process.env.APP_URL || 'http://localhost:3001';
    const token = await authService.createEmailVerificationToken(user.id);
    if (token) {
      try {
        await sendEmailVerificationEmail(user.email, `${baseUrl}/?verify=${token}`);
      } catch (err) {
        logger.error({ err }, 'Failed to send verification email');
      }
    }

    res.json({ needsVerification: true, email: user.email });
  } catch (err) {
    sendError(res, err);
  }
});

// Verify email
router.get('/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Verification token is required' });
  try {
    const userId = await authService.verifyEmail(token);
    await auditLog(userId, 'email_verified', { ip: req.ip });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Resend verification email
router.post('/resend-verification', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  const normalizedEmail = email.toLowerCase().trim();
  const user = await db.get('SELECT id, email, email_verified FROM users WHERE email = $1', [normalizedEmail]);
  if (!user || user.email_verified) {
    // Don't reveal whether user exists or is already verified
    return res.json({ ok: true });
  }
  const token = await authService.createEmailVerificationToken(user.id);
  if (token) {
    const baseUrl = process.env.APP_URL || 'http://localhost:3001';
    try {
      await sendEmailVerificationEmail(user.email, `${baseUrl}/?verify=${token}`);
    } catch (err) {
      logger.error({ err }, 'Failed to send verification email');
    }
  }
  res.json({ ok: true });
});

// Login
router.post('/login', async (req, res) => {
  const { email, password, totpCode, trustDevice } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const normalizedEmail = email.toLowerCase().trim();

  if (await authService.isAccountLocked(normalizedEmail)) {
    return res.status(429).json({ error: 'Too many failed attempts. Please try again in 15 minutes.' });
  }

  const authResult = await authService.authenticateUser(email, password);
  if (authResult.error) {
    await authService.recordLoginAttempt(normalizedEmail, req.ip, false);
    if (authResult.unverified) {
      return res.status(authResult.status).json({ error: authResult.error, unverified: true });
    }
    return res.status(authResult.status).json({ error: authResult.error });
  }

  const { user } = authResult;

  // MFA check
  if (user.totp_enabled) {
    const deviceTrusted = await authService.checkTrustedDevice(user.id, req.cookies?.['trusted-device']);
    if (!deviceTrusted) {
      if (!totpCode) return res.status(200).json({ mfaRequired: true });

      const totpResult = await authService.verifyTotp(user.id, totpCode, user.totp_secret);
      if (totpResult.error) {
        await authService.recordLoginAttempt(normalizedEmail, req.ip, false);
        return res.status(totpResult.status).json({ error: totpResult.error });
      }

      if (trustDevice) {
        const { token, maxAge } = await authService.createTrustedDevice(user.id, req.headers['user-agent']);
        res.cookie('trusted-device', token, {
          httpOnly: true,
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
          maxAge,
          path: '/',
        });
      }
    }
  }

  await authService.recordLoginAttempt(normalizedEmail, req.ip, true);
  req.session.userId = user.id;
  req.session.userName = user.name;
  await regenerateSession(req, res);
  await auditLog(user.id, 'login', { ip: req.ip });
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    totpEnabled: !!user.totp_enabled,
    isAdmin: !!user.is_admin,
  });
});

// Logout
router.post('/logout', (req, res) => {
  const userId = req.session?.userId;
  req.session.destroy(async () => {
    res.clearCookie('__session', { path: '/' });
    if (userId) await auditLog(userId, 'logout', { ip: req.ip }).catch(() => {});
    res.json({ ok: true });
  });
});

// Get current user
router.get('/me', requireAuth, async (req, res) => {
  const user = await authService.getCurrentUser(req.session.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json(user);
});

// --- TOTP MFA ---
router.post('/totp/setup', requireAuth, async (req, res) => {
  try {
    res.json(await authService.setupTotp(req.session.userId));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/totp/verify', requireAuth, async (req, res) => {
  if (!req.body.code) return res.status(400).json({ error: 'Verification code required' });
  try {
    await authService.verifyAndEnableTotp(req.session.userId, req.body.code);
    await auditLog(req.session.userId, 'mfa_enabled', { ip: req.ip });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/totp/disable', requireAuth, async (req, res) => {
  if (!req.body.password) return res.status(400).json({ error: 'Password required' });
  try {
    await authService.disableTotp(req.session.userId, req.body.password);
    res.clearCookie('trusted-device', { path: '/' });
    await auditLog(req.session.userId, 'mfa_disabled', { ip: req.ip });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Forgot/reset password ---
router.post('/forgot-password', async (req, res) => {
  if (!req.body.email) return res.status(400).json({ error: 'Email is required' });
  const result = await authService.createPasswordResetToken(req.body.email);
  if (result) {
    const baseUrl = process.env.APP_URL || 'http://localhost:3001';
    try {
      await sendPasswordResetEmail(result.email, `${baseUrl}/reset-password?token=${result.token}`);
    } catch (err) {
      logger.error({ err }, 'Failed to send reset email');
    }
    await auditLog(result.userId, 'password_reset_requested', { ip: req.ip });
  }
  res.json({ ok: true }); // Always return success
});

router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and new password are required' });
  try {
    const userId = await authService.resetPassword(token, password);
    await auditLog(userId, 'password_reset', { ip: req.ip });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Change email/password ---
router.post('/change-email', requireAuth, async (req, res) => {
  const { password, newEmail } = req.body;
  if (!password || !newEmail) return res.status(400).json({ error: 'Password and new email are required' });
  try {
    const result = await authService.changeEmail(req.session.userId, password, newEmail);
    await auditLog(req.session.userId, 'email_changed', {
      ip: req.ip,
      oldEmail: result.oldEmail,
      newEmail: result.email,
    });
    res.json({ ok: true, email: result.email });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required' });
  try {
    await authService.changePassword(req.session.userId, currentPassword, newPassword);
    await auditLog(req.session.userId, 'password_changed', { ip: req.ip });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Delete account ---
router.post('/delete-account', requireAuth, async (req, res) => {
  if (!req.body.password) return res.status(400).json({ error: 'Password required' });
  try {
    await authService.deleteAccount(req.session.userId, req.body.password);
    await auditLog(req.session.userId, 'account_deleted', { ip: req.ip }).catch(() => {});
    req.session.destroy(() => res.json({ ok: true }));
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
