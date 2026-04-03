import { Router } from 'express';
import db from '../db.js';
import { registerUser } from '../services/authService.js';
import { encrypt } from '../utils/crypto.js';
import logger from '../logger.js';

const router = Router();

// Check if setup is needed (no admin exists)
router.get('/status', async (req, res) => {
  try {
    const admin = await db.get('SELECT id FROM users WHERE is_admin = TRUE LIMIT 1');
    res.json({ needsSetup: !admin });
  } catch (err) {
    logger.error({ err }, 'Setup status check failed');
    res.status(500).json({ error: 'Failed to check setup status' });
  }
});

// Create first admin account — only works when no admin exists
router.post('/init', async (req, res) => {
  try {
    // Guard: only works if no admin exists yet
    const existing = await db.get('SELECT id FROM users WHERE is_admin = TRUE LIMIT 1');
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
      await db.run(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
        [key, value],
      );
    }

    // Log the user in with session regeneration to prevent fixation
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });
    req.session.userId = result.id;
    req.session.userName = name.trim();

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
    logger.error({ err }, 'Setup init failed');
    res.status(500).json({ error: 'Setup failed' });
  }
});

export default router;
