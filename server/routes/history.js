import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { gunzipSync, gzipSync } from 'node:zlib';
import db from '../db.js';
import { isProjectMember } from '../middleware/auth.js';

const router = Router();

const MAX_SNAPSHOT_SIZE = 100 * 1024 * 1024; // 100MB decompressed limit

/** Decompress a snapshot's data BYTEA into a parsed object */
function decompressSnapshot(buf) {
  try {
    const decompressed = gunzipSync(Buffer.from(buf), { maxOutputLength: MAX_SNAPSHOT_SIZE });
    return JSON.parse(decompressed.toString('utf8'));
  } catch (err) {
    throw new Error('Failed to decompress snapshot: ' + err.message);
  }
}

// List snapshots for a project (metadata only, no data)
router.get('/:projectId', async (req, res) => {
  const member = await isProjectMember(req.params.projectId, req.session.userId);
  if (!member) return res.status(403).json({ error: 'No access to this project' });

  const snapshots = await db.all(`
    SELECT id, author_name, label, created_at
    FROM project_snapshots
    WHERE project_id = $1
    ORDER BY created_at DESC
    LIMIT 500
  `, [req.params.projectId]);
  res.json(snapshots);
});

// Get snapshot details: file list, which files changed vs previous snapshot, and a specific file's diff
router.get('/snapshot/:snapshotId', async (req, res) => {
  const snap = await db.get('SELECT * FROM project_snapshots WHERE id = $1', [req.params.snapshotId]);
  if (!snap) return res.status(404).json({ error: 'Snapshot not found' });

  const member = await isProjectMember(snap.project_id, req.session.userId);
  if (!member) return res.status(403).json({ error: 'No access to this project' });

  const current = decompressSnapshot(snap.data);

  // Get previous snapshot
  const prevSnap = await db.get(`
    SELECT data FROM project_snapshots
    WHERE project_id = $1 AND created_at < $2
    ORDER BY created_at DESC LIMIT 1
  `, [snap.project_id, snap.created_at]);

  const previous = prevSnap ? decompressSnapshot(prevSnap.data) : { files: [] };

  // Build lookup maps
  const prevMap = new Map(previous.files.map(f => [f.id, f]));
  const curMap = new Map(current.files.map(f => [f.id, f]));

  // Determine which files changed
  const editedFileIds = [];
  for (const f of current.files) {
    const prev = prevMap.get(f.id);
    if (!prev || prev.content !== f.content) {
      editedFileIds.push(f.id);
    }
  }
  // Files that were deleted (in prev but not in current)
  for (const f of previous.files) {
    if (!curMap.has(f.id)) {
      editedFileIds.push(f.id);
    }
  }

  res.json({
    files: current.files.map(f => ({ id: f.id, path: f.path, is_binary: f.is_binary })),
    editedFileIds,
    snapshotTime: snap.created_at,
  });
});

// Get diff for a specific file between a snapshot and its predecessor
router.get('/snapshot/:snapshotId/file/:fileId', async (req, res) => {
  const { snapshotId, fileId } = req.params;
  const snap = await db.get('SELECT * FROM project_snapshots WHERE id = $1', [snapshotId]);
  if (!snap) return res.status(404).json({ error: 'Snapshot not found' });

  const member = await isProjectMember(snap.project_id, req.session.userId);
  if (!member) return res.status(403).json({ error: 'No access to this project' });

  const current = decompressSnapshot(snap.data);
  const curFile = current.files.find(f => f.id === fileId);

  // Get previous snapshot
  const prevSnap = await db.get(`
    SELECT data FROM project_snapshots
    WHERE project_id = $1 AND created_at < $2
    ORDER BY created_at DESC LIMIT 1
  `, [snap.project_id, snap.created_at]);

  const previous = prevSnap ? decompressSnapshot(prevSnap.data) : { files: [] };
  const prevFile = previous.files.find(f => f.id === fileId);

  res.json({
    currentContent: curFile?.content || '',
    previousContent: prevFile?.content || '',
  });
});

// Restore entire project to a snapshot's state
router.post('/restore/:snapshotId', async (req, res) => {
  const snap = await db.get('SELECT * FROM project_snapshots WHERE id = $1', [req.params.snapshotId]);
  if (!snap) return res.status(404).json({ error: 'Snapshot not found' });

  const member = await isProjectMember(snap.project_id, req.session.userId);
  if (!member) return res.status(403).json({ error: 'No access to this project' });
  if (member.role === 'viewer') return res.status(403).json({ error: 'Only editors can restore snapshots' });

  const projectId = snap.project_id;

  const user = req.session?.userId
    ? await db.get('SELECT id, name FROM users WHERE id = $1', [req.session.userId])
    : null;

  // First, create a snapshot of the current state so the restore can be undone
  const currentFiles = await db.all(
    'SELECT id, path, content, is_binary FROM files WHERE project_id = $1 ORDER BY path',
    [projectId]
  );
  const preRestorePayload = JSON.stringify({ files: currentFiles });
  const preRestoreCompressed = gzipSync(Buffer.from(preRestorePayload, 'utf8'));
  await db.run(
    'INSERT INTO project_snapshots (id, project_id, data, author_id, author_name, label) VALUES ($1, $2, $3, $4, $5, $6)',
    [uuid(), projectId, preRestoreCompressed, user?.id || null, user?.name || 'Unknown', 'Before restore']
  );

  // Decompress the target snapshot
  const target = decompressSnapshot(snap.data);
  const targetFileIds = new Set(target.files.map(f => f.id));
  const currentFileIds = new Set(currentFiles.map(f => f.id));

  await db.transaction(async (tx) => {
    // Delete files that don't exist in the target snapshot
    for (const cf of currentFiles) {
      if (!targetFileIds.has(cf.id)) {
        await tx.run('DELETE FROM files WHERE id = $1', [cf.id]);
      }
    }

    // Restore/create each file from the snapshot
    for (const f of target.files) {
      if (currentFileIds.has(f.id)) {
        await tx.run('UPDATE files SET content = $1, path = $2, updated_at = NOW() WHERE id = $3', [f.content, f.path, f.id]);
      } else {
        await tx.run(
          'INSERT INTO files (id, project_id, path, content, is_binary, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())',
          [f.id, projectId, f.path, f.content, f.is_binary || false]
        );
      }
    }
  });

  // Create a post-restore snapshot
  const postRestorePayload = JSON.stringify({ files: target.files });
  const postRestoreCompressed = gzipSync(Buffer.from(postRestorePayload, 'utf8'));
  await db.run(
    'INSERT INTO project_snapshots (id, project_id, data, author_id, author_name, label) VALUES ($1, $2, $3, $4, $5, $6)',
    [uuid(), projectId, postRestoreCompressed, user?.id || null, user?.name || 'Unknown', 'Restored snapshot']
  );

  // Return the full restored file list
  const restoredFiles = await db.all('SELECT * FROM files WHERE project_id = $1', [projectId]);
  res.json({ ok: true, files: restoredFiles });
});

export default router;
