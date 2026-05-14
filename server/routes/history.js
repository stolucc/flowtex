import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { gunzipSync, gzipSync } from 'node:zlib';
import db from '../db.js';
import { isProjectMember } from '../middleware/auth.js';
import { auditLog } from '../utils/audit.js';

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

// Snapshots are immutable, so once decompressed we can cache the parsed
// object. Selecting a snapshot in the History panel triggers two requests
// back-to-back (`/snapshot/:id` and `/snapshot/:id/file/:fileId`), each of
// which decompresses both the snapshot and its predecessor. With this LRU
// the second request hits warm cache on both, turning the click latency
// from "decompress 4 archives" into "decompress 0".
const SNAPSHOT_CACHE_MAX = 16;
const snapshotCache = new Map();
function cacheSnapshot(id, parsed) {
  if (snapshotCache.has(id)) snapshotCache.delete(id); // re-insert to bump LRU position
  snapshotCache.set(id, parsed);
  while (snapshotCache.size > SNAPSHOT_CACHE_MAX) {
    snapshotCache.delete(snapshotCache.keys().next().value);
  }
}

/** Fetch a snapshot row + decompressed payload, cached by id. */
async function loadSnapshot(snapshotId) {
  const cached = snapshotCache.get(snapshotId);
  if (cached) {
    snapshotCache.delete(snapshotId);
    snapshotCache.set(snapshotId, cached);
    return cached;
  }
  const row = await db.get('SELECT id, project_id, created_at, author_id, data FROM project_snapshots WHERE id = $1', [snapshotId]);
  if (!row) return null;
  const parsed = { meta: row, body: decompressSnapshot(row.data) };
  cacheSnapshot(snapshotId, parsed);
  return parsed;
}

/** Find + decompress the snapshot immediately preceding the given one (if any). */
async function loadPreviousSnapshot(projectId, beforeCreatedAt) {
  const row = await db.get(
    `SELECT id, project_id, created_at, data FROM project_snapshots
     WHERE project_id = $1 AND created_at < $2
     ORDER BY created_at DESC LIMIT 1`,
    [projectId, beforeCreatedAt],
  );
  if (!row) return { files: [] };
  const cached = snapshotCache.get(row.id);
  if (cached) {
    snapshotCache.delete(row.id);
    snapshotCache.set(row.id, cached);
    return cached.body;
  }
  const body = decompressSnapshot(row.data);
  cacheSnapshot(row.id, { meta: row, body });
  return body;
}

/** GET /api/history/:projectId -- List version snapshots for a project (metadata only). */
router.get('/:projectId', async (req, res) => {
  const member = await isProjectMember(req.params.projectId, req.session.userId);
  if (!member) return res.status(403).json({ error: 'No access to this project' });

  const snapshots = await db.all(
    `
    SELECT id, author_name, label, created_at
    FROM project_snapshots
    WHERE project_id = $1
    ORDER BY created_at DESC
    LIMIT 500
  `,
    [req.params.projectId],
  );
  res.json(snapshots);
});

/** GET /api/history/snapshot/:snapshotId -- Get snapshot details: file list and which files changed vs previous. */
router.get('/snapshot/:snapshotId', async (req, res) => {
  const snap = await loadSnapshot(req.params.snapshotId);
  if (!snap) return res.status(404).json({ error: 'Snapshot not found' });

  const member = await isProjectMember(snap.meta.project_id, req.session.userId);
  if (!member) return res.status(403).json({ error: 'No access to this project' });

  const current = snap.body;
  const previous = await loadPreviousSnapshot(snap.meta.project_id, snap.meta.created_at);

  const prevMap = new Map(previous.files.map((f) => [f.id, f]));
  const curMap = new Map(current.files.map((f) => [f.id, f]));

  const editedFileIds = [];
  for (const f of current.files) {
    const prev = prevMap.get(f.id);
    if (!prev || prev.content !== f.content) editedFileIds.push(f.id);
  }
  for (const f of previous.files) {
    if (!curMap.has(f.id)) editedFileIds.push(f.id);
  }

  res.json({
    files: current.files.map((f) => ({ id: f.id, path: f.path, is_binary: f.is_binary })),
    editedFileIds,
    snapshotTime: snap.meta.created_at,
  });
});

/** GET /api/history/snapshot/:snapshotId/file/:fileId -- Get a file's content diff between a snapshot and its predecessor. */
router.get('/snapshot/:snapshotId/file/:fileId', async (req, res) => {
  const { snapshotId, fileId } = req.params;
  const snap = await loadSnapshot(snapshotId);
  if (!snap) return res.status(404).json({ error: 'Snapshot not found' });

  const member = await isProjectMember(snap.meta.project_id, req.session.userId);
  if (!member) return res.status(403).json({ error: 'No access to this project' });

  const curFile = snap.body.files.find((f) => f.id === fileId);
  const previous = await loadPreviousSnapshot(snap.meta.project_id, snap.meta.created_at);
  const prevFile = previous.files.find((f) => f.id === fileId);

  res.json({
    currentContent: curFile?.content || '',
    previousContent: prevFile?.content || '',
  });
});

/** POST /api/history/restore/:snapshotId -- Restore the entire project to a snapshot's state (creates pre/post-restore snapshots). */
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
    [projectId],
  );
  const preRestorePayload = JSON.stringify({ files: currentFiles });
  const preRestoreCompressed = gzipSync(Buffer.from(preRestorePayload, 'utf8'));
  await db.run(
    'INSERT INTO project_snapshots (id, project_id, data, author_id, author_name, label) VALUES ($1, $2, $3, $4, $5, $6)',
    [uuid(), projectId, preRestoreCompressed, user?.id || null, user?.name || 'Unknown', 'Before restore'],
  );

  // Decompress the target snapshot
  const target = decompressSnapshot(snap.data);
  const targetFileIds = new Set(target.files.map((f) => f.id));
  const currentFileIds = new Set(currentFiles.map((f) => f.id));

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
        await tx.run('UPDATE files SET content = $1, path = $2, updated_at = NOW() WHERE id = $3', [
          f.content,
          f.path,
          f.id,
        ]);
      } else {
        await tx.run(
          'INSERT INTO files (id, project_id, path, content, is_binary, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())',
          [f.id, projectId, f.path, f.content, f.is_binary || false],
        );
      }
    }
  });

  // Create a post-restore snapshot
  const postRestorePayload = JSON.stringify({ files: target.files });
  const postRestoreCompressed = gzipSync(Buffer.from(postRestorePayload, 'utf8'));
  await db.run(
    'INSERT INTO project_snapshots (id, project_id, data, author_id, author_name, label) VALUES ($1, $2, $3, $4, $5, $6)',
    [uuid(), projectId, postRestoreCompressed, user?.id || null, user?.name || 'Unknown', 'Restored snapshot'],
  );

  await auditLog(req.session.userId, 'snapshot_restored', {
    targetType: 'project',
    targetId: projectId,
    detail: req.params.snapshotId,
    ip: req.ip,
  });

  // Return the full restored file list
  const restoredFiles = await db.all('SELECT * FROM files WHERE project_id = $1', [projectId]);
  res.json({ ok: true, files: restoredFiles });
});

/** DELETE /api/history/snapshots -- Bulk delete snapshots by id list. */
router.delete('/snapshots', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === 'string') : null;
  if (!ids || ids.length === 0) return res.status(400).json({ error: 'ids required' });
  if (ids.length > 500) return res.status(400).json({ error: 'too many ids (max 500)' });

  const rows = await db.all('SELECT id, project_id FROM project_snapshots WHERE id = ANY($1)', [ids]);
  if (rows.length === 0) return res.status(404).json({ error: 'No snapshots found' });

  // UI invariant: bulk-delete is scoped to one project. If a future caller
  // mixes projects we want a 400 rather than a silent partial check.
  const projectIds = new Set(rows.map((r) => r.project_id));
  if (projectIds.size > 1) return res.status(400).json({ error: 'snapshots span multiple projects' });
  const projectId = [...projectIds][0];

  const member = await isProjectMember(projectId, req.session.userId);
  if (!member) return res.status(403).json({ error: 'No access to this project' });
  if (member.role === 'viewer') return res.status(403).json({ error: 'Only editors can delete snapshots' });

  // Guard against wiping out every restore point in one call. Use COUNT(*)
  // rather than comparing array lengths so it's correct even if duplicate
  // ids were submitted.
  const totalRow = await db.get('SELECT COUNT(*) AS count FROM project_snapshots WHERE project_id = $1', [projectId]);
  const foundIds = rows.map((r) => r.id);
  if (Number(totalRow.count) <= foundIds.length) {
    return res.status(409).json({ error: 'Cannot delete every snapshot of a project' });
  }

  await db.run('DELETE FROM project_snapshots WHERE id = ANY($1)', [foundIds]);
  for (const id of foundIds) snapshotCache.delete(id);

  await auditLog(req.session.userId, 'snapshots_bulk_deleted', {
    targetType: 'project',
    targetId: projectId,
    detail: foundIds.join(','),
    ip: req.ip,
  });

  res.json({ ok: true, deleted: foundIds.length });
});

/** DELETE /api/history/snapshot/:snapshotId -- Delete a single snapshot. */
router.delete('/snapshot/:snapshotId', async (req, res) => {
  const snap = await db.get('SELECT id, project_id FROM project_snapshots WHERE id = $1', [req.params.snapshotId]);
  if (!snap) return res.status(404).json({ error: 'Snapshot not found' });

  const member = await isProjectMember(snap.project_id, req.session.userId);
  if (!member) return res.status(403).json({ error: 'No access to this project' });
  if (member.role === 'viewer') return res.status(403).json({ error: 'Only editors can delete snapshots' });

  // Refuse to delete the project's only restore point.
  const totalRow = await db.get('SELECT COUNT(*) AS count FROM project_snapshots WHERE project_id = $1', [snap.project_id]);
  if (Number(totalRow.count) <= 1) {
    return res.status(409).json({ error: 'Cannot delete the only remaining snapshot' });
  }

  await db.run('DELETE FROM project_snapshots WHERE id = $1', [snap.id]);
  snapshotCache.delete(snap.id);

  await auditLog(req.session.userId, 'snapshot_deleted', {
    targetType: 'project',
    targetId: snap.project_id,
    detail: snap.id,
    ip: req.ip,
  });

  res.json({ ok: true });
});

export default router;
