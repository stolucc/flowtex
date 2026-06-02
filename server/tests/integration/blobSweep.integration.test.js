// Phase B integration tests: GC sweeps and the legacy-base64 migrator.
// Real DB (BEGIN/ROLLBACK per test via setup.js); on-disk side effects
// land in PROJECTS_DIR under uuid project ids that the OS reaps with
// its tmp lifecycle. The blob store IS exercised end-to-end.
import { describe, it, expect } from 'vitest';
import { v4 as uuid } from 'uuid';
import db from '../../db.js';
import { seedUser, seedProject } from './setup.js';
import { uploadBinaryFile, deleteFile } from '../../services/projectService.js';
import {
  sweepOrphanRefcounts,
  reconcileOnDiskBlobs,
} from '../../services/blobGc.js';
import {
  migrateLegacyBlobBatch,
  countLegacyBlobRows,
} from '../../services/blobMigrator.js';
import { statBlob, writeBlob, blobPath } from '../../services/blobStore.js';
import { Readable } from 'node:stream';
import { utimes, access } from 'node:fs/promises';

async function seed() {
  const user = await seedUser();
  const project = await seedProject(user.id);
  return { user, project };
}

describe('sweepOrphanRefcounts', () => {
  it('collects a blob whose only file was deleted (ref_count = 0)', async () => {
    const { project } = await seed();
    const file = await uploadBinaryFile(project.id, 'gone.png', Buffer.from('to be orphaned'));
    await deleteFile(file.id);

    // Backdate the blob so the safety window passes.
    await db.run(
      `UPDATE project_blobs SET created_at = NOW() - INTERVAL '10 minutes' WHERE project_id = $1 AND sha256 = $2`,
      [project.id, file.binary_sha256],
    );

    const result = await sweepOrphanRefcounts();
    expect(result.collected).toBeGreaterThanOrEqual(1);

    const row = await db.get(
      'SELECT 1 FROM project_blobs WHERE project_id = $1 AND sha256 = $2',
      [project.id, file.binary_sha256],
    );
    expect(row).toBeUndefined();
    expect(await statBlob(project.id, file.binary_sha256)).toBeNull();
  });

  it('refuses to collect a blob whose ref_count is wrong but files still reference it', async () => {
    const { project } = await seed();
    const file = await uploadBinaryFile(project.id, 'still-here.png', Buffer.from('reachable'));

    // Simulate refcount drift: force it to 0 while the file row still points at it.
    await db.run(
      `UPDATE project_blobs SET ref_count = 0, created_at = NOW() - INTERVAL '10 minutes'
        WHERE project_id = $1 AND sha256 = $2`,
      [project.id, file.binary_sha256],
    );

    await sweepOrphanRefcounts();

    // Blob must survive — the LEFT JOIN safety net should have protected it.
    expect(await statBlob(project.id, file.binary_sha256)).not.toBeNull();
    const stillThere = await db.get(
      'SELECT 1 FROM project_blobs WHERE project_id = $1 AND sha256 = $2',
      [project.id, file.binary_sha256],
    );
    expect(stillThere).toBeDefined();
  });

  it('respects the freshness grace window (does not GC blobs newer than 5 min)', async () => {
    const { project } = await seed();
    const file = await uploadBinaryFile(project.id, 'fresh.png', Buffer.from('just uploaded'));
    await deleteFile(file.id);
    // Leave created_at at its default (now); the sweep should pass it over.
    await sweepOrphanRefcounts();
    expect(await statBlob(project.id, file.binary_sha256)).not.toBeNull();
  });
});

describe('reconcileOnDiskBlobs', () => {
  it('removes on-disk blobs that have no project_blobs row and are past the grace window', async () => {
    // Use a freshly-minted project id so reconciliation can walk over it.
    const projectId = uuid();
    // Write a blob directly (no DB row) — simulates a rollback orphan.
    const { sha256 } = await writeBlob(projectId, Readable.from([Buffer.from('rollback orphan')]));
    const onDisk = blobPath(projectId, sha256);
    await access(onDisk); // sanity: file is there

    // Backdate mtime past the grace window.
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(onDisk, past, past);

    const result = await reconcileOnDiskBlobs();
    expect(result.walked).toBeGreaterThanOrEqual(1);
    expect(result.orphaned).toBeGreaterThanOrEqual(1);
    expect(await statBlob(projectId, sha256)).toBeNull();
  });

  it('leaves a fresh blob untouched even if it has no DB row', async () => {
    const projectId = uuid();
    const { sha256 } = await writeBlob(projectId, Readable.from([Buffer.from('fresh rollback')]));
    await reconcileOnDiskBlobs();
    expect(await statBlob(projectId, sha256)).not.toBeNull();
  });
});

describe('migrateLegacyBlobBatch', () => {
  it('migrates a legacy base64 row to a blob reference', async () => {
    const { project } = await seed();
    const bytes = Buffer.from('legacy PNG bytes');
    // Insert a row in the OLD format directly: content holds base64,
    // binary_sha256 is NULL, is_binary = TRUE.
    const id = uuid();
    await db.run(
      `INSERT INTO files (id, project_id, path, content, is_binary)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [id, project.id, 'legacy/img.png', bytes.toString('base64')],
    );
    expect(await countLegacyBlobRows({ projectId: project.id })).toBeGreaterThanOrEqual(1);

    const result = await migrateLegacyBlobBatch({ batchSize: 10, projectId: project.id });
    expect(result.migrated).toBeGreaterThanOrEqual(1);

    const after = await db.get(
      `SELECT content, binary_sha256, binary_size, binary_mime FROM files WHERE id = $1`,
      [id],
    );
    expect(after.binary_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(after.binary_size).toBe(bytes.length);
    expect(after.binary_mime).toBe('image/png');
    expect(after.content).toBe('');

    const blob = await db.get(
      'SELECT ref_count FROM project_blobs WHERE project_id = $1 AND sha256 = $2',
      [project.id, after.binary_sha256],
    );
    expect(blob.ref_count).toBe(1);
    expect(await statBlob(project.id, after.binary_sha256)).not.toBeNull();
  });

  it('skips already-migrated rows on re-run (idempotent)', async () => {
    const { project } = await seed();
    const id = uuid();
    await db.run(
      `INSERT INTO files (id, project_id, path, content, is_binary)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [id, project.id, 'idem/img.png', Buffer.from('content').toString('base64')],
    );
    await migrateLegacyBlobBatch({ projectId: project.id });
    const second = await migrateLegacyBlobBatch({ projectId: project.id });
    expect(second.migrated).toBe(0);
    expect(second.examined).toBe(0);
  });

  it('skips rows that decode to zero bytes', async () => {
    const { project } = await seed();
    const id = uuid();
    await db.run(
      `INSERT INTO files (id, project_id, path, content, is_binary)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [id, project.id, 'empty/img.png', '!!!'], // invalid base64 → 0 bytes when decoded
    );
    const result = await migrateLegacyBlobBatch({ projectId: project.id });
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    // Row should still be in legacy format (we didn't touch it).
    const after = await db.get(
      'SELECT binary_sha256, content FROM files WHERE id = $1',
      [id],
    );
    expect(after.binary_sha256).toBeNull();
  });
});

describe('countLegacyBlobRows', () => {
  it('returns 0 for a project that has no legacy rows', async () => {
    const { project } = await seed();
    expect(await countLegacyBlobRows({ projectId: project.id })).toBe(0);
  });
});
