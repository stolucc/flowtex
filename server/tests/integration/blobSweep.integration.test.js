// Integration tests for the blob-storage GC sweeps. Real DB
// (BEGIN/ROLLBACK per test via setup.js); on-disk side effects land in
// PROJECTS_DIR under uuid project ids that the OS reaps with its tmp
// lifecycle.
import { describe, it, expect } from 'vitest';
import { v4 as uuid } from 'uuid';
import db from '../../db.js';
import { seedUser, seedProject } from './setup.js';
import { uploadBinaryFile, deleteFile } from '../../services/projectService.js';
import {
  sweepOrphanRefcounts,
  reconcileOnDiskBlobs,
} from '../../services/blobGc.js';
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

