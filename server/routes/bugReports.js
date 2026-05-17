import { Router } from 'express';
import db from '../db.js';
import logger from '../logger.js';
import { sendBugReportEmail } from '../utils/email.js';
import { auditLog } from '../utils/audit.js';
import { sendError } from '../middleware/errorHandler.js';

const router = Router();

const MAX_DESCRIPTION_LEN = 10000;
const MAX_FEATURES = 20;

/** POST /api/bug-reports
 *  body: { description: string, features?: string[] }
 *
 *  Captures a free-text bug report from the authenticated user, identifies
 *  one or more feature areas, and emails it to every admin user (those
 *  with `is_admin = TRUE`). If no admin users exist, falls back to the
 *  bootstrap ADMIN_EMAIL env var. The email name+email of the reporter is
 *  included so the admin can follow up directly. */
router.post('/', async (req, res) => {
  try {
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    if (!description) {
      return res.status(400).json({ error: 'A bug description is required' });
    }
    if (description.length > MAX_DESCRIPTION_LEN) {
      return res.status(400).json({ error: `Description must be ${MAX_DESCRIPTION_LEN} characters or fewer` });
    }
    // features: optional array of short strings ("Track changes", "Editor", etc.)
    let features = [];
    if (Array.isArray(req.body?.features)) {
      features = req.body.features
        .filter((f) => typeof f === 'string')
        .map((f) => f.trim())
        .filter((f) => f.length > 0 && f.length <= 64)
        .slice(0, MAX_FEATURES);
    }

    // Resolve the reporter's profile.
    const reporter = await db.get('SELECT id, name, email FROM users WHERE id = $1', [req.session.userId]);
    if (!reporter) return res.status(401).json({ error: 'Not logged in' });

    // Resolve admin recipients: every active admin, with the bootstrap
    // ADMIN_EMAIL as a fallback if the table is somehow empty.
    const adminRows = await db.all('SELECT email FROM users WHERE is_admin = TRUE');
    let adminEmails = adminRows.map((r) => r.email).filter(Boolean);
    if (adminEmails.length === 0 && process.env.ADMIN_EMAIL) {
      adminEmails = [process.env.ADMIN_EMAIL.trim()];
    }
    if (adminEmails.length === 0) {
      logger.warn({ userId: reporter.id }, 'Bug report submitted but no admin recipient is configured');
      return res.status(503).json({
        error: 'No admin recipient is configured on this server. Please contact your administrator another way.',
      });
    }

    await sendBugReportEmail(adminEmails, { reporter, description, features });

    // Audit row: targetId is a stable summary (recipient count), not the
    // raw email list. Storing the raw list duplicates admin PII into the
    // audit table on every report and risks overflowing the column on
    // deployments with many admins. The detail payload keeps the count
    // and a short feature breakdown for forensic value.
    await auditLog(reporter.id, 'bug_report_submitted', {
      targetType: 'admins',
      targetId: `count:${adminEmails.length}`,
      detail: JSON.stringify({ features, length: description.length, recipientCount: adminEmails.length }),
      ip: req.ip,
    }).catch((e) => logger.warn({ err: e }, 'Audit log failed for bug report'));

    res.json({ ok: true });
  } catch (err) {
    logger.warn({ err }, 'Failed to send bug-report email');
    sendError(res, err);
  }
});

export default router;
