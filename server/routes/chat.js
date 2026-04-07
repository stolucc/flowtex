import { Router } from 'express';
import db from '../db.js';
import { UUID_RE } from '../middleware/auth.js';
import logger from '../logger.js';

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
    res.json(messages);
  } catch (err) {
    logger.error({ err }, 'Chat history error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
