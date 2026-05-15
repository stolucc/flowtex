import { Router } from 'express';
import db from '../db.js';
import { UUID_RE } from '../middleware/auth.js';
import { sendError } from '../middleware/errorHandler.js';

const router = Router();

/** GET /api/chat/:projectId -- Retrieve chat message history for a project (last 500 messages). */
router.get('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    if (!UUID_RE.test(projectId)) return res.status(400).json({ error: 'Invalid project ID' });
    const member = await db.get('SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2', [
      projectId,
      req.session.userId,
    ]);
    if (!member) return res.status(403).json({ error: 'Not a member' });
    const messages = await db.all(
      'SELECT id, user_id as "userId", user_name as "userName", text, created_at FROM chat_messages WHERE project_id = $1 ORDER BY created_at DESC LIMIT 500',
      [projectId],
    );
    messages.reverse();

    // Hydrate reactions in one query (no N+1) and bucket them per message.
    if (messages.length > 0) {
      const ids = messages.map((m) => m.id);
      const reactionRows = await db.all(
        `SELECT message_id AS "messageId", emoji, user_id AS "userId", user_name AS "userName"
         FROM chat_message_reactions WHERE message_id = ANY($1) ORDER BY created_at ASC`,
        [ids],
      );
      const grouped = new Map(); // messageId -> Map(emoji -> users[])
      for (const r of reactionRows) {
        if (!grouped.has(r.messageId)) grouped.set(r.messageId, new Map());
        const byEmoji = grouped.get(r.messageId);
        if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
        byEmoji.get(r.emoji).push({ id: r.userId, name: r.userName });
      }
      for (const m of messages) {
        const byEmoji = grouped.get(m.id);
        m.reactions = byEmoji
          ? Array.from(byEmoji.entries()).map(([emoji, users]) => ({ emoji, count: users.length, users }))
          : [];
      }
    }
    res.json(messages);
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
