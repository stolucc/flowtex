// Phase B of the blob-storage migration. Two sweeps, both safe to run
// concurrently with normal uploads/reads:
//
//   1) Refcount sweep — for every project_blobs row with ref_count <= 0
//      AND no files row referencing it, DELETE the row and unlink the
//      blob. Cheap; runs daily.
//
//   2) Reconciliation sweep — walk every project's _blobs/ directory on
//      disk and unlink files that have NO project_blobs row at all AND
//      whose mtime is older than a grace window. This catches the
//      rollback-orphan case: writeBlob lands a blob on disk, the
//      surrounding DB transaction then fails, leaving an unreferenced
//      blob. Heavier (one stat per blob); runs weekly.
//
// Both sweeps are paranoid about not deleting referenced data: the
// refcount value is treated as a *hint*, not the source of truth — we
// always LEFT JOIN against files.binary_sha256 and only delete blobs
// the join confirms are unreferenced. Under-counted refcounts (which
// would otherwise lose data) are therefore harmless.

import { readdir, stat, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import db from '../db.js';
import logger from '../logger.js';
import { PROJECTS_DIR } from '../compiler.js';
import { deleteBlob, blobsDir } from './blobStore.js';

const SHA256_RE = /^[0-9a-f]{64}$/;

// Grace window before reconciliation will touch an on-disk blob. A
// freshly-uploaded blob exists on disk BEFORE the DB transaction that
// would insert the project_blobs row commits — if the sweep ran at the
// exact wrong moment we could nuke an in-flight upload. One hour is
// generous; the upload transaction takes milliseconds.
const RECONCILE_GRACE_MS = 60 * 60 * 1000;

/**
 * Refcount sweep. Deletes project_blobs rows whose ref_count <= 0 and
 * which have no surviving file reference, then unlinks the on-disk blob.
 *
 * Returns a per-project breakdown of how many blobs were collected,
 * for logging.
 */
export async function sweepOrphanRefcounts({ limit = 500 } = {}) {
  // The LEFT JOIN is the safety net: even if ref_count is wrong, we
  // refuse to delete a blob that any file still points at.
  const candidates = await db.all(
    `SELECT pb.project_id, pb.sha256
       FROM project_blobs pb
       LEFT JOIN files f
         ON f.project_id = pb.project_id
        AND f.binary_sha256 = pb.sha256
      WHERE pb.ref_count <= 0
        AND f.id IS NULL
        AND pb.created_at < NOW() - INTERVAL '5 minutes'
      ORDER BY pb.created_at
      LIMIT $1`,
    [limit],
  );

  let collected = 0;
  for (const row of candidates) {
    if (!SHA256_RE.test(row.sha256)) continue; // defence-in-depth
    try {
      // Delete the row first. If the unlink fails (e.g. disk error), we
      // still have NO DB reference to the file — the reconciliation
      // sweep will pick it up later.
      await db.run(
        'DELETE FROM project_blobs WHERE project_id = $1 AND sha256 = $2 AND ref_count <= 0',
        [row.project_id, row.sha256],
      );
      await deleteBlob(row.project_id, row.sha256);
      collected += 1;
    } catch (err) {
      logger.warn(
        { err, projectId: row.project_id, sha256: row.sha256 },
        'blobGc: failed to collect orphan blob',
      );
    }
  }
  return { candidates: candidates.length, collected };
}

/**
 * Reconciliation sweep. Walks `server/projects/*` and, for each
 * `_blobs/<prefix>/<sha256>` file, checks the DB. Removes anything
 * older than RECONCILE_GRACE_MS that has no project_blobs row.
 *
 * Idempotent and safe to interrupt: each blob is checked + deleted
 * independently.
 */
export async function reconcileOnDiskBlobs() {
  let walked = 0;
  let orphaned = 0;
  let projects = 0;
  const now = Date.now();

  let projectDirs;
  try {
    projectDirs = await readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return { walked, orphaned, projects };
    throw err;
  }

  for (const ent of projectDirs) {
    if (!ent.isDirectory()) continue;
    // Project ids are UUIDs; skip anything that doesn't look like one to
    // avoid wandering into unrelated directories the user might have
    // dropped under PROJECTS_DIR.
    if (!/^[0-9a-f-]{36}$/i.test(ent.name)) continue;
    const projectId = ent.name;
    const root = blobsDir(projectId);
    let shards;
    try {
      shards = await readdir(root, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }
    projects += 1;

    for (const shard of shards) {
      if (!shard.isDirectory()) continue;
      // Skip the in-flight upload staging dir; writeBlob owns it and
      // the rollback-orphan case there is handled in writeBlob itself.
      if (shard.name === '_tmp') continue;
      // Two-hex shard names only — defence-in-depth against accidental
      // sibling dirs.
      if (!/^[0-9a-f]{2}$/.test(shard.name)) continue;

      const shardPath = path.join(root, shard.name);
      let files;
      try {
        files = await readdir(shardPath, { withFileTypes: true });
      } catch (err) {
        if (err && err.code === 'ENOENT') continue;
        throw err;
      }

      for (const file of files) {
        if (!file.isFile()) continue;
        if (!SHA256_RE.test(file.name)) continue; // ignore anything weird
        walked += 1;

        const filePath = path.join(shardPath, file.name);
        let s;
        try {
          s = await stat(filePath);
        } catch {
          continue;
        }
        if (now - s.mtimeMs < RECONCILE_GRACE_MS) continue;

        const ref = await db.get(
          'SELECT 1 FROM project_blobs WHERE project_id = $1 AND sha256 = $2',
          [projectId, file.name],
        );
        if (ref) continue;

        try {
          await unlink(filePath);
          orphaned += 1;
        } catch (err) {
          if (!err || err.code !== 'ENOENT') {
            logger.warn(
              { err, projectId, sha256: file.name },
              'blobGc: failed to unlink reconcile-orphan blob',
            );
          }
        }
      }
      // Best-effort: try to remove now-empty shard dirs to keep the
      // tree tidy. Ignore ENOTEMPTY/ENOENT.
      await rmdir(shardPath).catch(() => {});
    }
  }

  return { walked, orphaned, projects };
}
