import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { auditLog } from '../utils/audit.js';
import { sendPasswordResetEmail, sendPasswordChangedEmail, sendEmailVerificationEmail, sendAccountDeletedEmail, sendEmailChangedNotice } from '../utils/email.js';
import logger from '../logger.js';
import db from '../db.js';
import * as authService from '../services/authService.js';
import { sendError } from '../middleware/errorHandler.js';
import { isLocalCompileEnabled } from '../utils/featureFlags.js';
import validateBody from '../middleware/validateBody.js';

const router = Router();

// Shared field shapes. authService also runs deeper checks (HIBP, password
// complexity, name CR/LF stripping); these schemas are the cheap-up-front
// gate that catches malformed shapes before any DB call. Auth-service
// validation is the source of truth for security-relevant rules; schemas
// here are about REQUEST SHAPE, not policy.
const emailField    = z.string().trim().toLowerCase().email().max(254);
const passwordField = z.string().min(1).max(1024); // policy enforced server-side
const nameField     = z.string().min(1).max(200);
const totpCodeField = z.string().regex(/^\d{6}$/);

const registerSchema = z.object({
  email: emailField,
  name: nameField,
  password: passwordField,
  inviteId: z.string().uuid().optional(),
}).strict();
const loginSchema = z.object({
  email: emailField,
  password: passwordField,
  totpCode: totpCodeField.optional(),
  // Optional "remember this device for 7 days" checkbox; sets the
  // trusted-device cookie that bypasses MFA on future logins.
  trustDevice: z.boolean().optional(),
}).strict();
const resendVerificationSchema = z.object({
  email: emailField,
}).strict();
const forgotPasswordSchema = z.object({
  email: emailField,
}).strict();
const resetPasswordSchema = z.object({
  token: z.string().min(1).max(256),
  password: passwordField,
}).strict();
const changeEmailSchema = z.object({
  password: passwordField,
  newEmail: emailField,
}).strict();
const changePasswordSchema = z.object({
  currentPassword: passwordField,
  newPassword: passwordField,
}).strict();
const deleteAccountSchema = z.object({
  password: passwordField,
}).strict();

/** Regenerate the session after login, preserving userId/userName and issuing a new CSRF token. */
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

/** POST /api/auth/register -- Create a new user account and send a verification email. */
router.post('/register', validateBody(registerSchema), async (req, res) => {
  const { email, name, password } = req.body;
  if (!email || !name || !password) return res.status(400).json({ error: 'Email, name, and password are required' });
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Invalid email format' });
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 200)
    return res.status(400).json({ error: 'Name must be 1–200 characters' });
  try {
    const user = await authService.registerUser(email, name, password);
    // If the email was already registered, registerUser returns
    // { alreadyExisted: true } without creating anything. We still respond
    // with the same shape as the success path to avoid leaking which
    // emails have an account (account-enumeration defense).
    if (user.alreadyExisted) {
      await auditLog(null, 'register_duplicate', { ip: req.ip, email: user.email });
      return res.json({ needsVerification: true, email: user.email });
    }
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

/** GET /api/auth/verify-email -- Verify a user's email address via token. */
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

/** POST /api/auth/resend-verification -- Resend the email verification link (silent no-op if already verified). */
router.post('/resend-verification', validateBody(resendVerificationSchema), async (req, res) => {
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

/** POST /api/auth/login -- Authenticate user with email/password and optional TOTP. */
router.post('/login', validateBody(loginSchema), async (req, res) => {
  const { email, password, totpCode, trustDevice } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const normalizedEmail = email.toLowerCase().trim();

  if (await authService.isAccountLocked(normalizedEmail, req.ip)) {
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
    const rotated = await authService.checkTrustedDevice(user.id, req.cookies?.['trusted-device']);
    if (rotated) {
      // Cookie was valid; rotate it so a stolen replica only works once.
      res.cookie('trusted-device', rotated.token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        maxAge: rotated.maxAge,
        path: '/',
      });
    } else {
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
          sameSite: 'strict',
          secure: process.env.NODE_ENV === 'production',
          maxAge,
          path: '/',
        });
        await auditLog(user.id, 'mfa_trust_device_created', { ip: req.ip, detail: req.headers['user-agent']?.substring(0, 200) || null });
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

/** POST /api/auth/logout -- Destroy the session and clear the session cookie. */
router.post('/logout', (req, res) => {
  const userId = req.session?.userId;
  req.session.destroy(async () => {
    res.clearCookie('__session', { path: '/' });
    res.clearCookie('trusted-device', { path: '/' });
    if (userId) await auditLog(userId, 'logout', { ip: req.ip }).catch((e) => logger.warn({ err: e }, 'Audit log failed for logout'));
    res.json({ ok: true });
  });
});

/** GET /api/auth/me -- Return the currently authenticated user's profile. */
router.get('/me', requireAuth, async (req, res) => {
  const user = await authService.getCurrentUser(req.session.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.set({ 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache' });
  res.json(user);
});

/** POST /api/auth/totp/setup -- Generate a TOTP secret and QR code for MFA enrollment. */
router.post('/totp/setup', requireAuth, async (req, res) => {
  try {
    res.set({ 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache' });
    res.json(await authService.setupTotp(req.session.userId));
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * Drop every session for `userId` EXCEPT `keepSessionId`. Used after a
 * privilege-envelope change (MFA enabled/disabled) so a session that
 * was created BEFORE the change can't continue at the new envelope —
 * the user must re-authenticate on every other device. ASVS V3.5.1.
 * Best-effort: log on failure, don't fail the calling request.
 */
async function dropOtherSessions(userId, keepSessionId) {
  try {
    await db.run(
      `DELETE FROM session WHERE sess->>'userId' = $1 AND sid <> $2`,
      [userId, keepSessionId],
    );
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to drop other sessions after MFA toggle');
  }
}

/** POST /api/auth/totp/verify -- Verify a TOTP code and enable MFA for the user. */
router.post('/totp/verify', requireAuth, async (req, res) => {
  if (!req.body.code) return res.status(400).json({ error: 'Verification code required' });
  try {
    await authService.verifyAndEnableTotp(req.session.userId, req.body.code);
    // Privilege envelope changed (now requires TOTP on next sign-in).
    // Invalidate every other session for this user so a pre-existing
    // session can't keep acting under the old, no-MFA envelope.
    await dropOtherSessions(req.session.userId, req.sessionID);
    await auditLog(req.session.userId, 'mfa_enabled', { ip: req.ip });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/auth/totp/disable -- Disable TOTP MFA after password confirmation. */
router.post('/totp/disable', requireAuth, async (req, res) => {
  if (!req.body.password) return res.status(400).json({ error: 'Password required' });
  try {
    await authService.disableTotp(req.session.userId, req.body.password);
    res.clearCookie('trusted-device', { path: '/' });
    // Same rationale as enable: the envelope changed (no longer
    // requires TOTP). A session that was created before the change
    // shouldn't keep running silently — force re-auth elsewhere.
    await dropOtherSessions(req.session.userId, req.sessionID);
    await auditLog(req.session.userId, 'mfa_disabled', { ip: req.ip });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/auth/forgot-password -- Send a password reset email (always returns success to prevent enumeration). */
router.post('/forgot-password', validateBody(forgotPasswordSchema), async (req, res) => {
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

/** POST /api/auth/reset-password -- Reset password using a token and invalidate all existing sessions. */
router.post('/reset-password', validateBody(resetPasswordSchema), async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and new password are required' });
  try {
    const userId = await authService.resetPassword(token, password);
    // Invalidate all sessions for this user (attacker may hold a stolen session)
    await db.run(`DELETE FROM session WHERE sess->>'userId' = $1`, [userId]);
    await auditLog(userId, 'password_reset', { ip: req.ip });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/auth/change-email -- Change the user's email address after password verification. */
/** PATCH /api/auth/me -- Update the current user's profile.
 *
 *  Always-allowed fields: `name`.
 *  Flag-gated fields: `compile_location` (FEATURE_LOCAL_COMPILE). When the
 *  flag is off the field is silently dropped — legacy clients see no change.
 */
router.patch('/me', requireAuth, async (req, res) => {
  const updates = {};
  if (req.body.name !== undefined) {
    if (typeof req.body.name !== 'string' || !req.body.name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    updates.name = req.body.name;
  }
  if (isLocalCompileEnabled() && req.body.compile_location !== undefined) {
    updates.compile_location = req.body.compile_location;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Nothing to update' });
  }
  try {
    const user = await authService.updateProfile(req.session.userId, updates);
    await auditLog(req.session.userId, 'profile_updated', { ip: req.ip });
    res.json(user);
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/change-email', requireAuth, validateBody(changeEmailSchema), async (req, res) => {
  const { password, newEmail } = req.body;
  if (!password || !newEmail) return res.status(400).json({ error: 'Password and new email are required' });
  try {
    const result = await authService.changeEmail(req.session.userId, password, newEmail);
    await auditLog(req.session.userId, 'email_changed', {
      ip: req.ip,
      oldEmail: result.oldEmail,
      newEmail: result.email,
    });
    // Notify the OLD address so a stolen-credentials attacker can't
    // silently move the account email to one they control. Best-
    // effort: log on failure, don't block the response (the email
    // change itself already committed).
    try {
      await sendEmailChangedNotice(result.oldEmail, {
        name: result.name,
        newEmail: result.email,
      });
    } catch (noticeErr) {
      logger.error({ err: noticeErr }, 'Failed to send email-changed notice to old address');
    }
    // Send verification email to the new address
    try {
      const token = await authService.createEmailVerificationToken(req.session.userId);
      if (token) {
        const baseUrl = process.env.APP_URL || 'http://localhost:3001';
        await sendEmailVerificationEmail(result.email, `${baseUrl}/?verify=${token}`);
      }
    } catch (verifyErr) {
      logger.error({ err: verifyErr }, 'Failed to send verification email after email change');
    }
    res.json({ ok: true, email: result.email, needsVerification: true });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/auth/change-password -- Change password and invalidate all other sessions. */
router.post('/change-password', requireAuth, validateBody(changePasswordSchema), async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required' });
  try {
    await authService.changePassword(req.session.userId, currentPassword, newPassword);
    // Invalidate all other sessions for this user
    const currentSid = req.sessionID;
    await db.run(`DELETE FROM session WHERE sess->>'userId' = $1 AND sid != $2`, [req.session.userId, currentSid]);
    await auditLog(req.session.userId, 'password_changed', { ip: req.ip });
    // Notify user by email
    try {
      const user = await authService.getCurrentUser(req.session.userId);
      if (user?.email) await sendPasswordChangedEmail(user.email, user.name || 'there');
    } catch (emailErr) {
      logger.error({ err: emailErr }, 'Failed to send password-changed notification');
    }
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/auth/delete-account -- Soft-delete the user's account after password
 *  confirmation. The account enters the 30-day recovery bin: login is blocked,
 *  sessions/tokens are revoked, but data is preserved until the cron purge. */
router.post('/delete-account', requireAuth, validateBody(deleteAccountSchema), async (req, res) => {
  if (!req.body.password) return res.status(400).json({ error: 'Password required' });
  const userId = req.session.userId;
  try {
    const { email, name } = await authService.deleteAccount(userId, req.body.password);
    // Force-close any live WS *first* — the soft-delete is committed but the
    // user's existing socket can still receive messages until we close it;
    // shrinking that window before any further awaits is the cheap defence.
    req.app?.locals?.disconnectUserEverywhere?.(userId);
    await auditLog(userId, 'account_deleted', { ip: req.ip }).catch((e) => logger.warn({ err: e }, 'Audit log failed for account deletion'));
    if (email) {
      const purgeAt = new Date(Date.now() + authService.SOFT_DELETE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      sendAccountDeletedEmail(email, name, { purgeAt }).catch((err) =>
        logger.error({ err }, 'Failed to send account deletion email'),
      );
    }
    req.session.destroy(() => res.json({ ok: true }));
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
