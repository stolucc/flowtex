import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { isProjectMember } from '../middleware/auth.js';

const router = Router();

async function requireFileAccess(fileId, userId, res, { requireEditor = false } = {}) {
  const file = await db.get('SELECT id, project_id, path FROM files WHERE id = $1', [fileId]);
  if (!file) {
    res.status(404).json({ error: 'File not found' });
    return null;
  }
  const member = await isProjectMember(file.project_id, userId);
  if (!member) {
    res.status(403).json({ error: 'No access to this project' });
    return null;
  }
  if (requireEditor && member.role === 'viewer') {
    res.status(403).json({ error: 'Viewers cannot modify comments' });
    return null;
  }
  return file;
}

async function requireCommentAccess(commentId, userId, res, opts = {}) {
  const comment = await db.get('SELECT id, file_id, author_id FROM comments WHERE id = $1', [commentId]);
  if (!comment) {
    res.status(404).json({ error: 'Comment not found' });
    return null;
  }
  const file = await requireFileAccess(comment.file_id, userId, res, opts);
  if (!file) return null;
  return comment;
}

// Get comments for a file (with replies)
router.get('/:fileId', async (req, res) => {
  if (!(await requireFileAccess(req.params.fileId, req.session.userId, res))) return;

  const comments = await db.all('SELECT * FROM comments WHERE file_id = $1 ORDER BY from_pos', [req.params.fileId]);

  // Batch-fetch replies for all comments (avoids N+1)
  if (comments.length > 0) {
    const commentIds = comments.map((c) => c.id);
    const placeholders = commentIds.map((_, i) => `$${i + 1}`).join(',');
    const allReplies = await db.all(
      `SELECT * FROM comment_replies WHERE comment_id IN (${placeholders}) ORDER BY created_at`,
      commentIds,
    );
    const repliesByComment = {};
    for (const r of allReplies) {
      if (!repliesByComment[r.comment_id]) repliesByComment[r.comment_id] = [];
      repliesByComment[r.comment_id].push(r);
    }
    for (const c of comments) {
      c.replies = repliesByComment[c.id] || [];
    }
  } else {
    // no comments, no replies
  }

  res.json(comments);
});

// Add a comment
router.post('/:fileId', async (req, res) => {
  if (!(await requireFileAccess(req.params.fileId, req.session.userId, res, { requireEditor: true }))) return;

  const { from_pos, to_pos, text } = req.body;
  if (!Number.isInteger(from_pos) || !Number.isInteger(to_pos) || from_pos < 0 || to_pos < 0) {
    return res.status(400).json({ error: 'Invalid position values' });
  }
  if (!text || typeof text !== 'string' || text.trim().length === 0 || text.length > 10000) {
    return res.status(400).json({ error: 'Comment text must be 1-10000 characters' });
  }
  const id = uuid();

  const author =
    req.session.userName ||
    (await db.get('SELECT name FROM users WHERE id = $1', [req.session.userId]))?.name ||
    'User';

  await db.run(
    'INSERT INTO comments (id, file_id, from_pos, to_pos, text, author, author_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [id, req.params.fileId, from_pos, to_pos, text, author, req.session.userId],
  );

  const comment = await db.get('SELECT * FROM comments WHERE id = $1', [id]);
  res.json(comment);
});

// Resolve/unresolve a comment
router.patch('/:commentId/resolve', async (req, res) => {
  if (!(await requireCommentAccess(req.params.commentId, req.session.userId, res, { requireEditor: true }))) return;

  const { resolved } = req.body;
  await db.run('UPDATE comments SET resolved = $1 WHERE id = $2', [!!resolved, req.params.commentId]);
  res.json({ ok: true });
});

// Edit a comment's text (only by author)
router.patch('/:commentId', async (req, res) => {
  const comment = await requireCommentAccess(req.params.commentId, req.session.userId, res);
  if (!comment) return;
  if (comment.author_id !== req.session.userId) {
    return res.status(403).json({ error: 'Only the comment author can edit' });
  }

  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Text required' });
  await db.run('UPDATE comments SET text = $1 WHERE id = $2', [text.trim(), req.params.commentId]);
  res.json({ ok: true, text: text.trim() });
});

// Add a reply to a comment
router.post('/:commentId/reply', async (req, res) => {
  if (!(await requireCommentAccess(req.params.commentId, req.session.userId, res, { requireEditor: true }))) return;

  const { text } = req.body;
  if (!text || typeof text !== 'string' || text.trim().length === 0 || text.length > 10000) {
    return res.status(400).json({ error: 'Reply text must be 1-10000 characters' });
  }
  const id = uuid();
  const author =
    req.session.userName ||
    (await db.get('SELECT name FROM users WHERE id = $1', [req.session.userId]))?.name ||
    'User';
  await db.run('INSERT INTO comment_replies (id, comment_id, text, author, author_id) VALUES ($1, $2, $3, $4, $5)', [
    id,
    req.params.commentId,
    text,
    author,
    req.session.userId,
  ]);
  const reply = await db.get('SELECT * FROM comment_replies WHERE id = $1', [id]);
  res.json(reply);
});

// Delete a comment (only by author)
router.delete('/:commentId', async (req, res) => {
  const comment = await requireCommentAccess(req.params.commentId, req.session.userId, res);
  if (!comment) return;
  if (comment.author_id !== req.session.userId) {
    return res.status(403).json({ error: 'Only the comment author can delete' });
  }

  await db.run('DELETE FROM comments WHERE id = $1', [req.params.commentId]);
  res.json({ ok: true });
});

export default router;
