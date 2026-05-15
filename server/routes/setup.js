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
    // Guard: only works on a truly fresh install. Checking "no admin exists"
    // would let any authenticated non-admin re-init themselves as admin if
    // an operator ever cleared is_admin from every account (e.g. demoting
    // the sole admin via SQL).
    const existing = await db.get('SELECT id FROM users LIMIT 1');
    if (existing) {
      return res.status(403).json({ error: 'Setup already completed' });
    }

    const { email, name, password, appUrl, smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom } = req.body;

    if (!email || !name || !password) {
      return res.status(400).json({ error: 'Email, name, and password are required' });
    }

    // Create the admin user (skip email verification)
    const result = await registerUser(email, name, password);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    // Promote to admin and mark email as verified
    await db.run('UPDATE users SET is_admin = TRUE, email_verified = TRUE WHERE id = $1', [result.id]);

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
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });
    req.session.userId = result.id;
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
