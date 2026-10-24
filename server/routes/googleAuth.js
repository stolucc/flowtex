// @ts-check
// Google sign-in routes, mounted at /api/auth/google.
//
//   GET  /available     -- is Google sign-in configured here?
//   GET  /login         -- start sign-in (redirects to Google)
//   POST /link-start    -- logged-in user, re-enters password, gets a
//                          Google URL to link their account
//   GET  /callback      -- Google redirects back here
//   GET  /pending       -- interstitial state for the client
//   POST /confirm-link  -- password (+TOTP) to link an existing account
//   POST /mfa           -- TOTP step for a Google sign-in
//   POST /cancel        -- drop any pending Google state
//   POST /unlink        -- logged-in user removes the Google link
//
// Every per-flow secret (state, nonce, PKCE verifier) lives in the
// server-side session, never in a cookie or the URL. Pending
// interstitial state has a 10-minute TTL. The session is regenerated
// at the moment a user is actually signed in (session fixation).

import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import validateBody from '../middleware/validateBody.js';
import { errInfo } from '../middleware/errorHandler.js';
import * as google from '../services/googleAuthService.js';
import * as authService from '../services/authService.js';
import { auditLog } from '../utils/audit.js';
import logger from '../logger.js';
import db from '../db.js';

const router = Router();

const PENDING_TTL_MS = 10 * 60 * 1000;

const passwordField = z.string().min(1).max(1024);
const totpCodeField = z.string().regex(/^\d{6}$/);
const linkStartSchema = z.object({ password: passwordField }).strict();
const confirmLinkSchema = z.object({
  password: passwordField,
  totpCode: totpCodeField.optional(),
  trustDevice: z.boolean().optional(),
}).strict();
const mfaSchema = z.object({
  totpCode: totpCodeField,
  trustDevice: z.boolean().optional(),
}).strict();
const unlinkSchema = z.object({ password: passwordField }).strict();

function appUrl() {
  return process.env.APP_URL || 'http://localhost:3001';
}
function callbackUrl() {
  return `${appUrl()}/api/auth/google/callback`;
}

/** Same-origin relative path or '/'. Mirrors safeRelayState in
 *  routes/saml.js and also refuses to loop back into this router.
 *  @param {unknown} raw */
function safeReturnTo(raw) {
  if (typeof raw !== 'string') return '/';
  if (raw.length === 0 || raw.length > 1024) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || raw.includes('\0')) return '/';
  if (raw.startsWith('/api/')) return '/';
  try {
    const base = new URL(appUrl());
    if (new URL(raw, base).origin !== base.origin) return '/';
  } catch {
    return '/';
  }
  return raw;
}

/** @param {import('express').Request} req */
function saveSession(req) {
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  }));
}

/** Sign the user in: fresh session id, fresh CSRF token.
 *  @param {import('express').Request} req
 *  @param {import('express').Response} res
 *  @param {{ id: string, name: string }} user */
function establishSession(req, res, user) {
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) {
        req.session.destroy(() => {});
        return reject(err);
      }
      req.session.userId = user.id;
      req.session.userName = user.name;
      req.session.authMethod = 'google';
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      res.cookie('csrf-token', req.session.csrfToken, {
        httpOnly: false,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
      });
      req.session.save((saveErr) => {
        if (saveErr) {
          req.session.destroy(() => {});
          return reject(saveErr);
        }
        resolve();
      });
    });
  }));
}

/** @param {import('express').Response} res @param {{ token: string, maxAge: number }} t */
function setTrustedDeviceCookie(res, t) {
  res.cookie('trusted-device', t.token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: t.maxAge,
    path: '/',
  });
}

/** Valid trusted-device cookie? Rotates it on success (same as the
 *  password login path).
 *  @param {import('express').Request} req @param {import('express').Response} res @param {string} userId */
async function trustedDeviceOk(req, res, userId) {
  const rotated = await authService.checkTrustedDevice(userId, req.cookies?.['trusted-device']);
  if (rotated) {
    setTrustedDeviceCookie(res, rotated);
    return true;
  }
  return false;
}

/** @param {import('express').Request} req @param {import('express').Response} res @param {string} userId */
async function maybeTrustDevice(req, res, userId) {
  const t = await authService.createTrustedDevice(userId, req.headers['user-agent']);
  setTrustedDeviceCookie(res, t);
  await auditLog(userId, 'mfa_trust_device_created', {
    ip: req.ip,
    detail: req.headers['user-agent']?.substring(0, 200) || null,
  });
}

/** Clear all pre-auth Google state from the session.
 *  @param {import('express').Request} req */
function clearPending(req) {
  delete req.session.googleOAuth;
  delete req.session.pendingGoogleLink;
  delete req.session.pendingGoogleMfa;
}

/** @param {import('express').Response} res @param {string} code */
function loginError(res, code) {
  res.redirect(`/login?google_error=${encodeURIComponent(code)}`);
}

// ─── GET /available ────────────────────────────────────────────────────
router.get('/available', (req, res) => {
  res.json({ available: google.isGoogleAuthEnabled() });
});

// ─── GET /login ────────────────────────────────────────────────────────
router.get('/login', async (req, res) => {
  if (!google.isGoogleAuthEnabled()) return res.status(404).json({ error: 'Google sign-in is not enabled' });
  try {
    const { url, state, nonce, codeVerifier } = await google.buildAuthRequest(callbackUrl());
    clearPending(req);
    req.session.googleOAuth = {
      mode: 'login',
      state,
      nonce,
      codeVerifier,
      returnTo: safeReturnTo(req.query.returnTo),
      expiresAt: Date.now() + PENDING_TTL_MS,
    };
    await saveSession(req);
    res.redirect(url);
  } catch (err) {
    logger.error({ err }, 'Google sign-in start failed');
    loginError(res, 'unavailable');
  }
});

// ─── POST /link-start ──────────────────────────────────────────────────
// Linking adds a permanent new way into the account, so a stolen
// session alone must not be enough: require the current password
// (through the same lockout as the login form).
router.post('/link-start', requireAuth, validateBody(linkStartSchema), async (req, res) => {
  if (!google.isGoogleAuthEnabled()) return res.status(404).json({ error: 'Google sign-in is not enabled' });
  const userId = /** @type {string} */ (req.session.userId);
  try {
    const me = await db.get('SELECT email, password_hash, google_sub, auth_method FROM users WHERE id = $1', [userId]);
    if (!me) return res.status(401).json({ error: 'Not authenticated' });
    if (me.auth_method === 'saml') {
      return res.status(409).json({ error: 'This account signs in through your organisation and cannot use Google sign-in.' });
    }
    if (me.google_sub) return res.status(409).json({ error: 'A Google account is already linked.' });
    if (!me.password_hash) return res.status(400).json({ error: 'Set a password first.' });

    const auth = await authService.attemptLogin(me.email, req.body.password, req.ip);
    if (auth.error || auth.user?.id !== userId) {
      return res.status(auth.status === 429 ? 429 : 401).json({ error: auth.status === 429 ? auth.error : 'Incorrect password' });
    }

    const { url, state, nonce, codeVerifier } = await google.buildAuthRequest(callbackUrl());
    req.session.googleOAuth = {
      mode: 'link',
      userId,
      state,
      nonce,
      codeVerifier,
      returnTo: '/',
      expiresAt: Date.now() + PENDING_TTL_MS,
    };
    await saveSession(req);
    res.json({ url });
  } catch (err) {
    logger.error({ err }, 'Google link start failed');
    res.status(500).json({ error: 'Google sign-in is temporarily unavailable.' });
  }
});

// ─── GET /callback ─────────────────────────────────────────────────────
router.get('/callback', async (req, res) => {
  const pending = req.session?.googleOAuth;
  // One-shot: consumed whatever happens next.
  if (req.session) delete req.session.googleOAuth;

  if (!pending || pending.expiresAt < Date.now()) return loginError(res, 'expired');
  const linkMode = pending.mode === 'link';
  const fail = (/** @type {string} */ code) =>
    linkMode ? res.redirect(`/?google_error=${encodeURIComponent(code)}`) : loginError(res, code);

  // User pressed "Cancel" at Google, or Google refused.
  if (typeof req.query.error === 'string') return fail('cancelled');

  let identity;
  try {
    const current = new URL(req.originalUrl, appUrl());
    identity = await google.exchangeCallback(current, pending);
  } catch (err) {
    const e = errInfo(err);
    logger.warn({ err: e.message }, 'Google callback rejected');
    return fail(e.status === 400 && /not verified/.test(e.message || '') ? 'unverified_email' : 'failed');
  }

  try {
    if (linkMode) {
      // The account that started the link must still be the one signed in.
      if (!req.session.userId || req.session.userId !== pending.userId) return fail('session_changed');
      try {
        await google.linkGoogleToUser(pending.userId, identity.sub);
      } catch (err) {
        const e = errInfo(err);
        if (e.status === 409) return fail('already_linked');
        throw err;
      }
      await auditLog(pending.userId, 'google_link', { ip: req.ip, detail: { via: 'settings', email: identity.email } });
      await saveSession(req);
      return res.redirect('/?google=linked');
    }

    const result = await google.resolveGoogleLogin(identity);

    if (result.kind === 'refused') return loginError(res, result.reason);

    if (result.kind === 'needs_link') {
      req.session.pendingGoogleLink = {
        userId: result.userId,
        sub: identity.sub,
        email: result.email,
        existingName: result.existingName,
        returnTo: pending.returnTo,
        expiresAt: Date.now() + PENDING_TTL_MS,
      };
      await saveSession(req);
      return res.redirect('/login/link-google');
    }

    const { user } = result;
    if (result.isNew) {
      await auditLog(user.id, 'google_register', { ip: req.ip, detail: { email: user.email } });
    } else if (result.claimed) {
      await auditLog(user.id, 'google_claim_unverified', { ip: req.ip, detail: { email: user.email } });
    }

    if (user.totp_enabled && !(await trustedDeviceOk(req, res, user.id))) {
      req.session.pendingGoogleMfa = {
        userId: user.id,
        returnTo: pending.returnTo,
        expiresAt: Date.now() + PENDING_TTL_MS,
      };
      await saveSession(req);
      return res.redirect('/login/google-mfa');
    }

    await establishSession(req, res, user);
    await auditLog(user.id, 'login', { ip: req.ip, detail: { method: 'google' } });
    res.redirect(pending.returnTo || '/');
  } catch (err) {
    logger.error({ err }, 'Google callback handler error');
    fail('failed');
  }
});

// ─── GET /pending ──────────────────────────────────────────────────────
// Read by the interstitial pages. Exposes only what the holder of this
// session already knows (they just signed in to that Google account).
router.get('/pending', async (req, res) => {
  const link = req.session?.pendingGoogleLink;
  if (link && link.expiresAt > Date.now()) {
    const u = await db.get('SELECT totp_enabled FROM users WHERE id = $1', [link.userId]);
    return res.json({ kind: 'link', email: link.email, existingName: link.existingName, totpEnabled: !!u?.totp_enabled });
  }
  const mfa = req.session?.pendingGoogleMfa;
  if (mfa && mfa.expiresAt > Date.now()) return res.json({ kind: 'mfa' });
  res.status(404).json({ error: 'Nothing pending' });
});

// ─── POST /confirm-link ────────────────────────────────────────────────
router.post('/confirm-link', validateBody(confirmLinkSchema), async (req, res) => {
  const pending = req.session?.pendingGoogleLink;
  if (!pending || pending.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'This link request expired. Sign in with Google again.' });
  }
  const { password, totpCode, trustDevice } = req.body;
  try {
    // attemptLogin = per-email lockout + timing-equalised password check.
    const auth = await authService.attemptLogin(pending.email, password, req.ip);
    if (auth.error) return res.status(auth.status === 429 ? 429 : 401).json({ error: auth.status === 429 ? auth.error : 'Incorrect password' });
    const user = auth.user;
    if (user.id !== pending.userId) {
      // Email moved to a different account since the callback. Start over.
      delete req.session.pendingGoogleLink;
      return res.status(409).json({ error: 'Account changed. Sign in with Google again.' });
    }

    if (user.totp_enabled && !(await trustedDeviceOk(req, res, user.id))) {
      if (!totpCode) return res.json({ mfaRequired: true });
      const t = await authService.verifyTotpWithLockout(user.id, totpCode, user.totp_secret, pending.email, req.ip);
      if (t.error) return res.status(t.status).json({ error: t.error });
      if (trustDevice) await maybeTrustDevice(req, res, user.id);
    }

    let linked;
    try {
      linked = await google.linkGoogleToUser(user.id, pending.sub);
    } catch (err) {
      const e = errInfo(err);
      delete req.session.pendingGoogleLink;
      if (e.status === 409 || e.status === 404) return res.status(409).json({ error: e.message });
      throw err;
    }
    const returnTo = pending.returnTo || '/';
    await authService.recordLoginAttempt(pending.email, req.ip, true);
    await establishSession(req, res, linked);
    await auditLog(linked.id, 'google_link', { ip: req.ip, detail: { via: 'sign-in', email: pending.email } });
    await auditLog(linked.id, 'login', { ip: req.ip, detail: { method: 'google' } });
    res.json({ ok: true, redirect: returnTo });
  } catch (err) {
    logger.error({ err }, 'Google confirm-link failed');
    res.status(500).json({ error: 'Account link failed. Please try again.' });
  }
});

// ─── POST /mfa ─────────────────────────────────────────────────────────
router.post('/mfa', validateBody(mfaSchema), async (req, res) => {
  const pending = req.session?.pendingGoogleMfa;
  if (!pending || pending.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'This sign-in expired. Sign in with Google again.' });
  }
  try {
    const user = await db.get(
      'SELECT id, email, name, totp_enabled, totp_secret, deleted_at FROM users WHERE id = $1',
      [pending.userId],
    );
    if (!user || user.deleted_at) {
      delete req.session.pendingGoogleMfa;
      return res.status(400).json({ error: 'This sign-in expired. Sign in with Google again.' });
    }
    if (user.totp_enabled) {
      const t = await authService.verifyTotpWithLockout(user.id, req.body.totpCode, user.totp_secret, user.email, req.ip);
      if (t.error) return res.status(t.status).json({ error: t.error });
      if (req.body.trustDevice) await maybeTrustDevice(req, res, user.id);
    }
    const returnTo = pending.returnTo || '/';
    await establishSession(req, res, user);
    await auditLog(user.id, 'login', { ip: req.ip, detail: { method: 'google' } });
    res.json({ ok: true, redirect: returnTo });
  } catch (err) {
    logger.error({ err }, 'Google MFA step failed');
    res.status(500).json({ error: 'Sign-in failed. Please try again.' });
  }
});

// ─── POST /cancel ──────────────────────────────────────────────────────
router.post('/cancel', (req, res) => {
  if (req.session) {
    clearPending(req);
    req.session.save(() => {});
  }
  res.json({ ok: true });
});

// ─── POST /unlink ──────────────────────────────────────────────────────
router.post('/unlink', requireAuth, validateBody(unlinkSchema), async (req, res) => {
  const userId = /** @type {string} */ (req.session.userId);
  try {
    await google.unlinkGoogle(userId, req.body.password);
    await auditLog(userId, 'google_unlink', { ip: req.ip });
    res.json({ ok: true });
  } catch (err) {
    const e = errInfo(err);
    if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message });
    logger.error({ err }, 'Google unlink failed');
    res.status(500).json({ error: 'Unlink failed. Please try again.' });
  }
});

export const _testing = { safeReturnTo };

export default router;
