import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { isProjectMember } from '../middleware/auth.js';

const router = Router();

// Get all tracked changes for a file
router.get('/:fileId', async (req, res) => {
  const file = await db.get('SELECT project_id FROM files WHERE id = $1', [req.params.fileId]);
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (!(await isProjectMember(file.project_id, req.session.userId))) {
    return res.status(403).json({ error: 'No access' });
  }
  const changes = await db.all(
    'SELECT * FROM tracked_changes WHERE file_id = $1 ORDER BY from_pos ASC',
    [req.params.fileId]
  );
  res.json(changes);
});

// Get all tracked changes for a project (all files)
router.get('/project/:projectId', async (req, res) => {
  if (!(await isProjectMember(req.params.projectId, req.session.userId))) {
    return res.status(403).json({ error: 'No access' });
  }
  const changes = await db.all(
    `SELECT tc.*, f.path as file_path FROM tracked_changes tc
     JOIN files f ON tc.file_id = f.id
     WHERE tc.project_id = $1 AND tc.status = 'pending'
     ORDER BY tc.created_at DESC`,
    [req.params.projectId]
  );
  res.json(changes);
});

// Create a tracked change
router.post('/:fileId', async (req, res) => {
  const { from_pos, to_pos, inserted_text, deleted_text } = req.body;
  if (!Number.isInteger(from_pos) || !Number.isInteger(to_pos) || from_pos < 0 || to_pos < 0) {
    return res.status(400).json({ error: 'Invalid position values' });
  }
  const file = await db.get('SELECT project_id FROM files WHERE id = $1', [req.params.fileId]);
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (!(await isProjectMember(file.project_id, req.session.userId))) {
    return res.status(403).json({ error: 'No access' });
  }

  const user = await db.get('SELECT name FROM users WHERE id = $1', [req.session.userId]);
  const id = uuid();
  await db.run(
    `INSERT INTO tracked_changes (id, file_id, project_id, from_pos, to_pos, inserted_text, deleted_text, author_id, author_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, req.params.fileId, file.project_id, from_pos, to_pos, inserted_text || '', deleted_text || '', req.session.userId, user?.name || 'Unknown']
  );

  const change = await db.get('SELECT * FROM tracked_changes WHERE id = $1', [id]);
  res.json(change);
});

// Accept a tracked change (apply it to the file content)
router.post('/:changeId/accept', async (req, res) => {
  const change = await db.get('SELECT * FROM tracked_changes WHERE id = $1', [req.params.changeId]);
  if (!change) return res.status(404).json({ error: 'Change not found' });
  if (!(await isProjectMember(change.project_id, req.session.userId))) {
    return res.status(403).json({ error: 'No access' });
  }
  if (change.status !== 'pending') return res.status(400).json({ error: 'Change already resolved' });

  await db.run(
    'UPDATE tracked_changes SET status = $1, resolved_by = $2 WHERE id = $3',
    ['accepted', req.session.userId, change.id]
  );

  res.json({ ok: true, id: change.id, status: 'accepted' });
});

// Reject a tracked change (revert the insertion / restore the deletion)
router.post('/:changeId/reject', async (req, res) => {
  const change = await db.get('SELECT * FROM tracked_changes WHERE id = $1', [req.params.changeId]);
  if (!change) return res.status(404).json({ error: 'Change not found' });
  if (!(await isProjectMember(change.project_id, req.session.userId))) {
    return res.status(403).json({ error: 'No access' });
  }
  if (change.status !== 'pending') return res.status(400).json({ error: 'Change already resolved' });

  await db.run(
    'UPDATE tracked_changes SET status = $1, resolved_by = $2 WHERE id = $3',
    ['rejected', req.session.userId, change.id]
  );

  res.json({ ok: true, id: change.id, status: 'rejected' });
});

// Update a tracked change (e.g. merge edits)
router.patch('/:changeId', async (req, res) => {
  const change = await db.get('SELECT * FROM tracked_changes WHERE id = $1', [req.params.changeId]);
  if (!change) return res.status(404).json({ error: 'Change not found' });
  if (!(await isProjectMember(change.project_id, req.session.userId))) {
    return res.status(403).json({ error: 'No access' });
  }
  if (change.status !== 'pending') return res.status(400).json({ error: 'Change already resolved' });

  const { from_pos, to_pos, inserted_text, deleted_text } = req.body;
  await db.run(
    'UPDATE tracked_changes SET from_pos = $1, to_pos = $2, inserted_text = $3, deleted_text = $4 WHERE id = $5',
    [from_pos ?? change.from_pos, to_pos ?? change.to_pos, inserted_text ?? change.inserted_text, deleted_text ?? change.deleted_text, change.id]
  );
  const updated = await db.get('SELECT * FROM tracked_changes WHERE id = $1', [change.id]);
  res.json(updated);
});

// Delete a tracked change
router.delete('/:changeId', async (req, res) => {
  const change = await db.get('SELECT * FROM tracked_changes WHERE id = $1', [req.params.changeId]);
  if (!change) return res.status(404).json({ error: 'Change not found' });
  if (!(await isProjectMember(change.project_id, req.session.userId))) {
    return res.status(403).json({ error: 'No access' });
  }
  await db.run('DELETE FROM tracked_changes WHERE id = $1', [change.id]);
  res.json({ ok: true });
});

// Bulk accept all pending changes for a file
router.post('/file/:fileId/accept-all', async (req, res) => {
  const file = await db.get('SELECT project_id FROM files WHERE id = $1', [req.params.fileId]);
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (!(await isProjectMember(file.project_id, req.session.userId))) {
    return res.status(403).json({ error: 'No access' });
  }

  await db.run(
    "UPDATE tracked_changes SET status = 'accepted', resolved_by = $1 WHERE file_id = $2 AND status = 'pending'",
    [req.session.userId, req.params.fileId]
  );
  res.json({ ok: true });
});

// Bulk reject all pending changes for a file
router.post('/file/:fileId/reject-all', async (req, res) => {
  const file = await db.get('SELECT project_id FROM files WHERE id = $1', [req.params.fileId]);
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (!(await isProjectMember(file.project_id, req.session.userId))) {
    return res.status(403).json({ error: 'No access' });
  }

  await db.run(
    "UPDATE tracked_changes SET status = 'rejected', resolved_by = $1 WHERE file_id = $2 AND status = 'pending'",
    [req.session.userId, req.params.fileId]
  );
  res.json({ ok: true });
});

// Bulk adjust positions for remaining pending changes after a document edit
router.post('/file/:fileId/adjust-positions', async (req, res) => {
  const { afterPos, delta } = req.body;
  if (!Number.isInteger(afterPos) || !Number.isInteger(delta)) {
    return res.status(400).json({ error: 'Invalid afterPos or delta' });
  }
  const file = await db.get('SELECT project_id FROM files WHERE id = $1', [req.params.fileId]);
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (!(await isProjectMember(file.project_id, req.session.userId))) {
    return res.status(403).json({ error: 'No access' });
  }

  await db.run(
    `UPDATE tracked_changes SET from_pos = from_pos + $1, to_pos = to_pos + $1
     WHERE file_id = $2 AND status = 'pending' AND from_pos >= $3`,
    [delta, req.params.fileId, afterPos]
  );
  res.json({ ok: true });
});

export default router;
