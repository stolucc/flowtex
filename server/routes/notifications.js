import { Router } from 'express';
import db from '../db.js';
import { UUID_RE } from '../middleware/auth.js';
import { sendError } from '../middleware/errorHandler.js';

const router = Router();

/** GET /api/notifications/mentions — unseen + recent-seen @mentions for the current user. */
router.get('/mentions', async (req, res) => {
  try {
    // LEFT JOIN on users so a deleted mentioner (NULL mentioner_user_id)
    // still shows the mention with a NULL mentioner_name — the client
    // renders a "(deleted user)" tombstone in that case.
    const rows = await db.all(
      `SELECT cm.id, cm.comment_id, cm.reply_id, cm.chat_message_id,
              cm.project_id, cm.snippet,
              cm.created_at, cm.seen_at,
              u.name AS mentioner_name,
              p.name AS project_name,
              f.id   AS file_id, f.path AS file_path
         FROM comment_mentions cm
         LEFT JOIN users u    ON u.id = cm.mentioner_user_id
         JOIN projects p ON p.id = cm.project_id
         LEFT JOIN comments c ON c.id = cm.comment_id
         LEFT JOIN files f    ON f.id = c.file_id
        WHERE cm.mentioned_user_id = $1
          AND (cm.seen_at IS NULL OR cm.created_at > NOW() - INTERVAL '7 days')
        ORDER BY cm.created_at DESC
        LIMIT 50`,
      [req.session.userId],
    );
    res.json(rows);
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/notifications/mentions/:id/seen — mark a single mention as seen. */
router.post('/mentions/:id/seen', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid mention id' });
  try {
    const row = await db.get(
      'SELECT id FROM comment_mentions WHERE id = $1 AND mentioned_user_id = $2',
      [req.params.id, req.session.userId],
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    await db.run(
      'UPDATE comment_mentions SET seen_at = NOW() WHERE id = $1 AND seen_at IS NULL',
      [req.params.id],
    );
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/notifications/mentions/seen-all — mark all the user's mentions as seen. */
router.post('/mentions/seen-all', async (req, res) => {
  try {
    await db.run(
      'UPDATE comment_mentions SET seen_at = NOW() WHERE mentioned_user_id = $1 AND seen_at IS NULL',
      [req.session.userId],
    );
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
