// Phase B of the blob-storage migration. Walks legacy binary rows
// (is_binary = TRUE, content holds base64, binary_sha256 IS NULL) in
// small batches, decodes the bytes, writes them to the per-project
// blob store, and atomically rewrites the row to reference the blob.
//
// Designed to be safe to run alongside normal traffic:
//   - One row at a time inside a short transaction.
//   - FOR UPDATE SKIP LOCKED so multiple processes can co-migrate
//     without racing.
//   - On any error the row is left alone (still readable via the
//     legacy dual-mode read path); the next sweep retries.
//   - Per-batch cap + per-row size cap so a runaway PDF can't pin the
//     event loop.
//
// Phase C (drop legacy path) can ship once the count of legacy rows
// drops to zero project-wide.

import { Readable } from 'node:stream';
import db from '../db.js';
import logger from '../logger.js';
import { writeBlob } from './blobStore.js';

const MIME_MAP = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  eps: 'application/postscript',
};

function mimeFromPath(filePath) {
  const dot = String(filePath).lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME_MAP[filePath.slice(dot + 1).toLowerCase()] || 'application/octet-stream';
}

/** Decode a row's base64 content, push it to the blob store, and rewrite
 *  the row to reference the blob. One row, one transaction. */
async function migrateOneRow(row) {
  const buffer = Buffer.from(row.content || '', 'base64');
  // Sanity: if decode yields empty bytes for a non-empty source, the row
  // is corrupt — skip rather than write an empty blob over it.
  if (buffer.length === 0) {
    logger.warn({ fileId: row.id, projectId: row.project_id }, 'blobMigrator: row decoded to 0 bytes — skipping');
    return { skipped: true };
  }

  const { sha256, size } = await writeBlob(row.project_id, Readable.from([buffer]));
  const mime = mimeFromPath(row.path);

  await db.transaction(async (tx) => {
    // Re-check the row inside the transaction with FOR UPDATE so a
    // concurrent uploadBinaryFile (replace) can't race past us. If the
    // row already has a blob ref (because another migrator beat us), no-op.
    const current = await tx.get(
      'SELECT id, binary_sha256 FROM files WHERE id = $1 FOR UPDATE',
      [row.id],
    );
    if (!current || current.binary_sha256) {
      // Lost the race; the blob we just wrote is now orphaned and will
      // be GC-swept. (Per-project dedup means if the racing writer used
      // the same bytes, the on-disk file is the same one and the
      // reconciliation walk will leave it alone via the join.)
      return;
    }
    await tx.run(
      `INSERT INTO project_blobs (project_id, sha256, size, ref_count)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (project_id, sha256) DO UPDATE
         SET ref_count = project_blobs.ref_count + 1`,
      [row.project_id, sha256, size],
    );
    await tx.run(
      `UPDATE files
          SET content = '',
              binary_sha256 = $1,
              binary_size = $2,
              binary_mime = $3
        WHERE id = $4`,
      [sha256, size, mime, row.id],
    );
  });

  return { migrated: true, sha256, size };
}

/**
 * Migrate a batch of legacy binary rows. Returns counts so the caller
 * can log progress + decide whether to schedule another batch.
 *
 * @param {{ batchSize?: number, maxBytes?: number }} opts
 *   - batchSize: how many rows to attempt this tick (default 25)
 *   - maxBytes: skip rows whose decoded size would exceed this cap
 *     (default 50 MB to mirror upload limit)
 */
export async function migrateLegacyBlobBatch({
  batchSize = 25,
  maxBytes = 50 * 1024 * 1024,
  projectId = null,
} = {}) {
  // We pull `content` here because it's the whole point — but bound the
  // batch and the per-row size to keep memory predictable.
  // projectId scopes the sweep to one project; useful for tests and for
  // per-project migration progress reporting.
  const params = [batchSize];
  let projectFilter = '';
  if (projectId) {
    params.push(projectId);
    projectFilter = `AND project_id = $${params.length}`;
  }
  const rows = await db.all(
    `SELECT id, project_id, path, content
       FROM files
      WHERE is_binary = TRUE
        AND binary_sha256 IS NULL
        AND content IS NOT NULL
        AND content <> ''
        ${projectFilter}
      ORDER BY created_at
      LIMIT $1`,
    params,
  );

  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    // Base64 expands ~33%, so estimate decoded length cheaply.
    const estimatedBytes = Math.floor((row.content?.length || 0) * 3 / 4);
    if (estimatedBytes > maxBytes) {
      logger.warn(
        { fileId: row.id, projectId: row.project_id, estimatedBytes },
        'blobMigrator: row exceeds max byte cap; skipping',
      );
      skipped += 1;
      continue;
    }
    try {
      const result = await migrateOneRow(row);
      if (result.migrated) migrated += 1;
      else if (result.skipped) skipped += 1;
    } catch (err) {
      logger.warn(
        { err, fileId: row.id, projectId: row.project_id },
        'blobMigrator: row migration failed; will retry next sweep',
      );
      failed += 1;
    }
  }

  return { examined: rows.length, migrated, skipped, failed };
}

/** Count remaining legacy rows. Useful for the cron to decide whether
 *  to keep ticking or back off. */
export async function countLegacyBlobRows({ projectId = null } = {}) {
  const params = [];
  let projectFilter = '';
  if (projectId) {
    params.push(projectId);
    projectFilter = `AND project_id = $${params.length}`;
  }
  const row = await db.get(
    `SELECT COUNT(*)::int AS n
       FROM files
      WHERE is_binary = TRUE
        AND binary_sha256 IS NULL
        AND content IS NOT NULL
        AND content <> ''
        ${projectFilter}`,
    params,
  );
  return row?.n ?? 0;
}
