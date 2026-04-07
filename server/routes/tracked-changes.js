import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { isProjectMember } from '../middleware/auth.js';

const router = Router();

/** Verify the user has editor access to the file's project. Returns the file or null. */
async function requireFileEditor(fileId, userId, res) {
  const file = await db.get('SELECT project_id FROM files WHERE id = $1', [fileId]);
  if (!file) {
    res.status(404).json({ error: 'File not found' });
    return null;
  }
  const member = await isProjectMember(file.project_id, userId);
  if (!member) {
    res.status(403).json({ error: 'No access' });
    return null;
  }
  if (member.role === 'viewer') {
    res.status(403).json({ error: 'Viewers cannot modify tracked changes' });
    return null;
  }
  return file;
}

/** Verify the user has editor access to the tracked change's project. Returns the change or null. */
async function requireChangeEditor(changeId, userId, res) {
  const change = await db.get('SELECT * FROM tracked_changes WHERE id = $1', [changeId]);
  if (!change) {
    res.status(404).json({ error: 'Change not found' });
    return null;
  }
  const member = await isProjectMember(change.project_id, userId);
  if (!member) {
    res.status(403).json({ error: 'No access' });
    return null;
  }
  if (member.role === 'viewer') {
    res.status(403).json({ error: 'Viewers cannot modify tracked changes' });
    return null;
  }
  return change;
}

/** GET /api/tracked-changes/:fileId -- List all tracked changes for a file. */
router.get('/:fileId', async (req, res) => {
  const file = await db.get('SELECT project_id FROM files WHERE id = $1', [req.params.fileId]);
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (!(await isProjectMember(file.project_id, req.session.userId))) {
    return res.status(403).json({ error: 'No access' });
  }
  const changes = await db.all('SELECT * FROM tracked_changes WHERE file_id = $1 ORDER BY from_pos ASC', [
    req.params.fileId,
  ]);
  res.json(changes);
});

/** GET /api/tracked-changes/project/:projectId -- List all pending tracked changes across the project. */
router.get('/project/:projectId', async (req, res) => {
  if (!(await isProjectMember(req.params.projectId, req.session.userId))) {
    return res.status(403).json({ error: 'No access' });
  }
  const changes = await db.all(
    `SELECT tc.*, f.path as file_path FROM tracked_changes tc
     JOIN files f ON tc.file_id = f.id
     WHERE tc.project_id = $1 AND tc.status = 'pending'
     ORDER BY tc.created_at DESC`,
    [req.params.projectId],
  );
  res.json(changes);
});

/** POST /api/tracked-changes/:fileId -- Create a new tracked change (insertion/deletion) in a file. */
router.post('/:fileId', async (req, res) => {
  const { from_pos, to_pos, inserted_text, deleted_text } = req.body;
  if (!Number.isInteger(from_pos) || !Number.isInteger(to_pos) || from_pos < 0 || to_pos < 0) {
    return res.status(400).json({ error: 'Invalid position values' });
  }
  const file = await requireFileEditor(req.params.fileId, req.session.userId, res);
  if (!file) return;

  const authorName =
    req.session.userName ||
    (await db.get('SELECT name FROM users WHERE id = $1', [req.session.userId]))?.name ||
    'Unknown';
  const id = uuid();
  await db.run(
    `INSERT INTO tracked_changes (id, file_id, project_id, from_pos, to_pos, inserted_text, deleted_text, author_id, author_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      req.params.fileId,
      file.project_id,
      from_pos,
      to_pos,
      inserted_text || '',
      deleted_text || '',
      req.session.userId,
      authorName,
    ],
  );

  const change = await db.get('SELECT * FROM tracked_changes WHERE id = $1', [id]);
  res.json(change);
});

/** POST /api/tracked-changes/:changeId/accept -- Accept a pending tracked change (with optimistic locking). */
router.post('/:changeId/accept', async (req, res) => {
  const change = await requireChangeEditor(req.params.changeId, req.session.userId, res);
  if (!change) return;
  if (change.status !== 'pending') return res.status(409).json({ error: 'Change already resolved' });

  const result = await db.run(
    'UPDATE tracked_changes SET status = $1, resolved_by = $2 WHERE id = $3 AND status = $4',
    ['accepted', req.session.userId, change.id, 'pending'],
  );
  if (result.rowCount === 0) return res.status(409).json({ error: 'Change already resolved' });
  res.json({ ok: true, id: change.id, status: 'accepted' });
});

/** POST /api/tracked-changes/:changeId/reject -- Reject a pending tracked change (with optimistic locking). */
router.post('/:changeId/reject', async (req, res) => {
  const change = await requireChangeEditor(req.params.changeId, req.session.userId, res);
  if (!change) return;
  if (change.status !== 'pending') return res.status(409).json({ error: 'Change already resolved' });

  const result = await db.run(
    'UPDATE tracked_changes SET status = $1, resolved_by = $2 WHERE id = $3 AND status = $4',
    ['rejected', req.session.userId, change.id, 'pending'],
  );
  if (result.rowCount === 0) return res.status(409).json({ error: 'Change already resolved' });
  res.json({ ok: true, id: change.id, status: 'rejected' });
});

/** PATCH /api/tracked-changes/:changeId -- Update a pending tracked change's positions or text. */
router.patch('/:changeId', async (req, res) => {
  const change = await requireChangeEditor(req.params.changeId, req.session.userId, res);
  if (!change) return;
  if (change.status !== 'pending') return res.status(400).json({ error: 'Change already resolved' });

  const { from_pos, to_pos, inserted_text, deleted_text } = req.body;
  await db.run(
    'UPDATE tracked_changes SET from_pos = $1, to_pos = $2, inserted_text = $3, deleted_text = $4 WHERE id = $5',
    [
      from_pos ?? change.from_pos,
      to_pos ?? change.to_pos,
      inserted_text ?? change.inserted_text,
      deleted_text ?? change.deleted_text,
      change.id,
    ],
  );
  const updated = await db.get('SELECT * FROM tracked_changes WHERE id = $1', [change.id]);
  res.json(updated);
});

/** DELETE /api/tracked-changes/:changeId -- Delete a tracked change. */
router.delete('/:changeId', async (req, res) => {
  const change = await requireChangeEditor(req.params.changeId, req.session.userId, res);
  if (!change) return;
  await db.run('DELETE FROM tracked_changes WHERE id = $1', [change.id]);
  res.json({ ok: true });
});

/** POST /api/tracked-changes/file/:fileId/accept-all -- Bulk accept all pending changes for a file. */
router.post('/file/:fileId/accept-all', async (req, res) => {
  const file = await requireFileEditor(req.params.fileId, req.session.userId, res);
  if (!file) return;
  await db.run(
    "UPDATE tracked_changes SET status = 'accepted', resolved_by = $1 WHERE file_id = $2 AND status = 'pending'",
    [req.session.userId, req.params.fileId],
  );
  res.json({ ok: true });
});

/** POST /api/tracked-changes/file/:fileId/reject-all -- Bulk reject all pending changes for a file. */
router.post('/file/:fileId/reject-all', async (req, res) => {
  const file = await requireFileEditor(req.params.fileId, req.session.userId, res);
  if (!file) return;
  await db.run(
    "UPDATE tracked_changes SET status = 'rejected', resolved_by = $1 WHERE file_id = $2 AND status = 'pending'",
    [req.session.userId, req.params.fileId],
  );
  res.json({ ok: true });
});

/** POST /api/tracked-changes/file/:fileId/adjust-positions -- Shift positions of pending changes after a document edit. */
router.post('/file/:fileId/adjust-positions', async (req, res) => {
  const { afterPos, delta } = req.body;
  if (!Number.isInteger(afterPos) || !Number.isInteger(delta)) {
    return res.status(400).json({ error: 'Invalid afterPos or delta' });
  }
  const file = await requireFileEditor(req.params.fileId, req.session.userId, res);
  if (!file) return;
  await db.run(
    `UPDATE tracked_changes SET from_pos = from_pos + $1, to_pos = to_pos + $1
     WHERE file_id = $2 AND status = 'pending' AND from_pos >= $3`,
    [delta, req.params.fileId, afterPos],
  );
  res.json({ ok: true });
});

export default router;
