import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import logger from '../logger.js';
import { isProjectMember } from '../middleware/auth.js';
import { recordMentions } from '../utils/mentions.js';

const router = Router();

/** Fire-and-forget WebSocket push for fresh mentions. Failure to push must not
 *  break the HTTP response — the DB row is already persisted and the digest
 *  job will email the mention later if the user is offline. */
function pushMentionNotifications(app, mentions, { mentionerName }) {
  const send = app.locals.sendToUser;
  if (!send || !mentions?.length) return;
  for (const m of mentions) {
    try {
      send(m.mentionedUserId, {
        type: 'mention',
        mention: {
          id: m.id,
          projectId: m.projectId,
          commentId: m.commentId,
          replyId: m.replyId,
          snippet: m.snippet,
          mentionerName,
          createdAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      logger.warn({ err, mentionedUserId: m.mentionedUserId }, 'mention WS push failed');
    }
  }
}

/** Verify the user has access to the file's project; optionally require editor role. Returns the file or null. */
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

/** Verify the user has access to the comment's file/project. Returns the comment or null. */
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

/** GET /api/comments/:fileId -- List all comments for a file, including replies. */
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

    // Hydrate reactions in one query (same shape as chat: emoji/count/users).
    const reactionRows = await db.all(
      `SELECT comment_id AS "commentId", emoji, user_id AS "userId", user_name AS "userName"
         FROM comment_reactions WHERE comment_id = ANY($1) ORDER BY created_at ASC`,
      [commentIds],
    );
    const grouped = new Map();
    for (const r of reactionRows) {
      if (!grouped.has(r.commentId)) grouped.set(r.commentId, new Map());
      const byEmoji = grouped.get(r.commentId);
      if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
      byEmoji.get(r.emoji).push({ id: r.userId, name: r.userName });
    }
    for (const c of comments) {
      const byEmoji = grouped.get(c.id);
      c.reactions = byEmoji
        ? Array.from(byEmoji.entries()).map(([emoji, users]) => ({ emoji, count: users.length, users }))
        : [];
    }

    // Hydrate reply reactions in one query.
    const replyIds = allReplies.map((r) => r.id);
    if (replyIds.length > 0) {
      const replyReactionRows = await db.all(
        `SELECT reply_id AS "replyId", emoji, user_id AS "userId", user_name AS "userName"
           FROM reply_reactions WHERE reply_id = ANY($1) ORDER BY created_at ASC`,
        [replyIds],
      );
      const replyGrouped = new Map();
      for (const r of replyReactionRows) {
        if (!replyGrouped.has(r.replyId)) replyGrouped.set(r.replyId, new Map());
        const byEmoji = replyGrouped.get(r.replyId);
        if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
        byEmoji.get(r.emoji).push({ id: r.userId, name: r.userName });
      }
      for (const c of comments) {
        for (const r of c.replies) {
          const byEmoji = replyGrouped.get(r.id);
          r.reactions = byEmoji
            ? Array.from(byEmoji.entries()).map(([emoji, users]) => ({ emoji, count: users.length, users }))
            : [];
        }
      }
    } else {
      for (const c of comments) for (const r of c.replies) r.reactions = [];
    }
  }

  res.json(comments);
});

/** POST /api/comments/:fileId -- Add a new comment at a text range in a file. */
router.post('/:fileId', async (req, res) => {
  if (!(await requireFileAccess(req.params.fileId, req.session.userId, res, { requireEditor: true }))) return;

  const { from_pos, to_pos, text, assigned_to } = req.body;
  if (!Number.isInteger(from_pos) || !Number.isInteger(to_pos) || from_pos < 0 || to_pos < 0) {
    return res.status(400).json({ error: 'Invalid position values' });
  }
  if (from_pos > to_pos) {
    return res.status(400).json({ error: 'Comment range start is after its end' });
  }
  if (!text || typeof text !== 'string' || text.trim().length === 0 || text.length > 10000) {
    return res.status(400).json({ error: 'Comment text must be 1-10000 characters' });
  }
  const id = uuid();
  // Pull content alongside project_id so we can bound-check the range
  // against the file's actual length. A stale client (e.g. selection
  // captured against the previous active file then the user switches
  // files) could otherwise write a comment at offsets past EOF, producing
  // an orphan bubble that never lines up with any text.
  const file = await db.get('SELECT project_id, content FROM files WHERE id = $1', [req.params.fileId]);
  if (file && typeof file.content === 'string' && to_pos > file.content.length) {
    return res.status(400).json({ error: 'Comment range is past end of file' });
  }

  const author =
    req.session.userName ||
    (await db.get('SELECT name FROM users WHERE id = $1', [req.session.userId]))?.name ||
    'User';

  await db.run(
    'INSERT INTO comments (id, file_id, from_pos, to_pos, text, author, author_id, assigned_to) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [id, req.params.fileId, from_pos, to_pos, text, author, req.session.userId, assigned_to || null],
  );

  // Record @mentions for batched email notification + real-time in-app push.
  // Also notify the assignee (if any): assignment is an explicit subscription,
  // so the assignee gets a row even when self-assigning. Dedupe happens
  // inside recordMentions so an assignee who is also @-mentioned only
  // produces one row + one email.
  if (file) {
    const mentions = await recordMentions({
      text,
      commentId: id,
      mentionerUserId: req.session.userId,
      projectId: file.project_id,
      assignedToUserId: assigned_to || null,
    });
    pushMentionNotifications(req.app, mentions, { mentionerName: author });
  }

  const comment = await db.get('SELECT * FROM comments WHERE id = $1', [id]);
  comment.replies = [];
  res.json(comment);
});

/** PATCH /api/comments/:commentId/resolve -- Toggle the resolved status of a comment. */
router.patch('/:commentId/resolve', async (req, res) => {
  if (!(await requireCommentAccess(req.params.commentId, req.session.userId, res, { requireEditor: true }))) return;

  const { resolved } = req.body;
  await db.run('UPDATE comments SET resolved = $1 WHERE id = $2', [!!resolved, req.params.commentId]);
  res.json({ ok: true });
});

/** PATCH /api/comments/:commentId -- Edit a comment's text (author only). */
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

/** POST /api/comments/:commentId/reply -- Add a reply to an existing comment. */
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

  // Record @mentions in reply
  const parentComment = await db.get(
    'SELECT c.id, f.project_id FROM comments c JOIN files f ON c.file_id = f.id WHERE c.id = $1',
    [req.params.commentId],
  );
  if (parentComment) {
    const mentions = await recordMentions({
      text,
      replyId: id,
      commentId: req.params.commentId,
      mentionerUserId: req.session.userId,
      projectId: parentComment.project_id,
    });
    pushMentionNotifications(req.app, mentions, { mentionerName: author });
  }

  const reply = await db.get('SELECT * FROM comment_replies WHERE id = $1', [id]);
  res.json(reply);
});

/** DELETE /api/comments/:commentId -- Delete a comment (author only). */
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
