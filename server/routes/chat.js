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
    // Hydrate read cursors so the client can decide which own-messages
    // count as "seen by N" and which still need a marker. We include
    // every project member (not just the ones with a cursor row) so
    // the client knows the total recipient count up-front; members
    // who've never opened the panel just have lastReadAt = null.
    //
    // The query is wrapped in its own try/catch and the response
    // degrades gracefully on failure: a missing table (deploy without
    // a server restart, so the schema migration hasn't fired yet) or
    // any other DB hiccup must NOT take chat history down with it.
    // Receipts are a nice-to-have; messages are load-bearing.
    let cursors = [];
    try {
      cursors = await db.all(
        `SELECT pm.user_id AS "userId", rc.last_read_at AS "lastReadAt"
         FROM project_members pm
         LEFT JOIN chat_read_cursors rc
           ON rc.project_id = pm.project_id AND rc.user_id = pm.user_id
         WHERE pm.project_id = $1`,
        [projectId],
      );
    } catch (cursorErr) {
      // Log + continue. The client treats an empty readCursors array
      // as "nobody has read anything yet" — receipts disappear,
      // messages stay visible.
      console.warn('chat read-cursors query failed:', cursorErr.message);
    }

    res.json({ messages, readCursors: cursors });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
