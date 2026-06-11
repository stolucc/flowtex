// @ts-check
import { Router } from 'express';
import crypto from 'crypto';
import db from '../db.js';
import { registerUser } from '../services/authService.js';
import { encrypt } from '../utils/crypto.js';
import logger from '../logger.js';
import { sendError } from '../middleware/errorHandler.js';

const router = Router();

/** GET /api/setup/status -- Check whether first-run setup is needed (no users exist yet). */
router.get('/status', async (req, res) => {
  try {
    const anyUser = await db.get('SELECT id FROM users LIMIT 1');
    res.json({ needsSetup: !anyUser });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/setup/init -- Create the first admin account and save initial settings. Only works when no users exist. */
router.post('/init', async (req, res) => {
  try {
    const { email, name, password, appUrl, smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom } = req.body;

    if (!email || !name || !password) {
      return res.status(400).json({ error: 'Email, name, and password are required' });
    }

    // Serialise concurrent /init calls so two parallel requests on a
    // fresh install can't both pass the existence check before either
    // inserts and both end up admin. The advisory lock is held for the
    // tx; the existence re-check inside the tx is the actual guard.
    // Checking "no admin exists" instead of "no user exists" would let
    // any authenticated non-admin re-init themselves as admin if an
    // operator ever cleared is_admin from every account (e.g. demoting
    // the sole admin via SQL).
    const result = await db.transaction(async (tx) => {
      await tx.run('SELECT pg_advisory_xact_lock(hashtext($1))', ['setup:init']);
      const existing = await tx.get('SELECT id FROM users LIMIT 1');
      if (existing) {
        const err = /** @type {Error & { status: number }} */ (new Error('Setup already completed'));
        err.status = 403;
        throw err;
      }
      // Create the admin user (skip email verification). registerUser
      // does its own writes via the default pool; that's safe here
      // because the advisory lock pins the critical region — the
      // second caller stays blocked until we commit and then loses
      // the existence re-check above.
      // registerUser throws on policy reject (HIBP, validation). The
      // (now-removed) `{ error: string }` branch was leftover from an
      // earlier API shape -- tsc surfaced it as dead code when
      // authService landed in @ts-check.
      const reg = await registerUser(email, name, password);
      // Promote to admin and mark email as verified
      await tx.run('UPDATE users SET is_admin = TRUE, email_verified = TRUE WHERE id = $1', [reg.id]);
      return reg;
    });

    // Save optional settings
    const settings = [];
    if (appUrl) settings.push(['app_url', appUrl]);
    if (smtpHost) settings.push(['smtp_host', smtpHost]);
    if (smtpPort) settings.push(['smtp_port', String(smtpPort)]);
    if (smtpUser) settings.push(['smtp_user', smtpUser]);
    if (smtpPass) settings.push(['smtp_pass', encrypt(smtpPass)]);
    if (smtpFrom) settings.push(['smtp_from', smtpFrom]);

    for (const [key, value] of settings) {
      await db.run('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [
        key,
        value,
      ]);
    }

    // Log the user in with session regeneration to prevent fixation
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      req.session.regenerate((/** @type {Error | null} */ err) => (err ? reject(err) : resolve()));
    }));
    // First-run setup just inserted the admin row so `id` is non-null;
    // registerUser's union return type accommodates the
    // alreadyExisted=true arm that's unreachable here.
    req.session.userId = /** @type {string} */ (result.id);
    req.session.userName = name.trim();
    // Mint a CSRF token + cookie up front so the very next state-changing
    // request from the client (e.g. creating their first project) has
    // something to send in the X-CSRF-Token header. The global CSRF
    // middleware would set this on the next request, but the cookie
    // wouldn't reach the client until that response — too late.
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    res.cookie('csrf-token', req.session.csrfToken, {
      httpOnly: false,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });

    logger.info({ userId: result.id, email }, 'First-run setup completed');

    res.json({
      id: result.id,
      email: result.email,
      name: name.trim(),
      isAdmin: true,
      totpEnabled: false,
      emailVerified: true,
    });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
