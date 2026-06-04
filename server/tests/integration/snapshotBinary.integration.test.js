// F1 regression: snapshots must capture binary metadata, hold a
// reference to the underlying blob so it isn't GC'd, and restore
// reconstructs the file row with the correct binary_sha256 so /raw
// can serve it again.
//
// Pre-F1 the snapshot SELECT was `id, path, content, is_binary` --
// post-C.3 `content` is '' for binaries, so the snapshot serialised
// empty strings and restore re-INSERTed rows with `is_binary = TRUE`
// and `binary_sha256 = NULL`, which the read path explicitly refuses.
import { describe, it, expect } from 'vitest';
import { v4 as uuid } from 'uuid';
import { gzipSync } from 'node:zlib';
import db from '../../db.js';
import { seedUser, seedProject } from './setup.js';
import { uploadBinaryFile, deleteFile } from '../../services/projectService.js';
import { statBlob } from '../../services/blobStore.js';
import { sweepOrphanRefcounts } from '../../services/blobGc.js';

/** Helper: build a snapshot from the current files in a project. Mirrors
 *  the createSnapshotWithRefs flow inside the restore route. */
async function takeSnapshot(projectId, label) {
  const allFiles = await db.all(
    'SELECT id, path, content, is_binary, binary_sha256, binary_size, binary_mime FROM files WHERE project_id = $1 ORDER BY path',
    [projectId],
  );
  const snapshotId = uuid();
  const compressed = gzipSync(Buffer.from(JSON.stringify({ files: allFiles }), 'utf8'));
  await db.run(
    'INSERT INTO project_snapshots (id, project_id, data, author_id, author_name, label) VALUES ($1, $2, $3, NULL, $4, $5)',
    [snapshotId, projectId, compressed, 'Test', label],
  );
  const uniqueSha = new Set(
    allFiles.filter((f) => f.is_binary && f.binary_sha256).map((f) => f.binary_sha256),
  );
  for (const sha of uniqueSha) {
    await db.run(
      'INSERT INTO snapshot_blob_refs (snapshot_id, project_id, sha256) VALUES ($1, $2, $3)',
      [snapshotId, projectId, sha],
    );
  }
  return { id: snapshotId, files: allFiles };
}

async function seed() {
  const user = await seedUser();
  const project = await seedProject(user.id);
  return { user, project };
}

describe('snapshot_blob_refs trigger', () => {
  it('INSERT into snapshot_blob_refs bumps project_blobs.ref_count', async () => {
    const { project } = await seed();
    const file = await uploadBinaryFile(project.id, 'cover.png', Buffer.from('image bytes'));
    const before = await db.get(
      'SELECT ref_count FROM project_blobs WHERE project_id = $1 AND sha256 = $2',
      [project.id, file.binary_sha256],
    );
    expect(before.ref_count).toBe(1);

    // Create a snapshot directly (manually inserting the row + the
    // refs the way the createSnapshotWithRefs helper does).
    const snapshotId = uuid();
    await db.run(
      'INSERT INTO project_snapshots (id, project_id, data, author_name) VALUES ($1, $2, $3, $4)',
      [snapshotId, project.id, Buffer.from('{}'), 'Test'],
    );
    await db.run(
      'INSERT INTO snapshot_blob_refs (snapshot_id, project_id, sha256) VALUES ($1, $2, $3)',
      [snapshotId, project.id, file.binary_sha256],
    );

    const after = await db.get(
      'SELECT ref_count FROM project_blobs WHERE project_id = $1 AND sha256 = $2',
      [project.id, file.binary_sha256],
    );
    expect(after.ref_count).toBe(2);
  });

  it('DELETE from snapshot_blob_refs decrements project_blobs.ref_count', async () => {
    const { project } = await seed();
    const file = await uploadBinaryFile(project.id, 'cover.png', Buffer.from('image bytes'));
    const snapshotId = uuid();
    await db.run(
      'INSERT INTO project_snapshots (id, project_id, data, author_name) VALUES ($1, $2, $3, $4)',
      [snapshotId, project.id, Buffer.from('{}'), 'Test'],
    );
    await db.run(
      'INSERT INTO snapshot_blob_refs (snapshot_id, project_id, sha256) VALUES ($1, $2, $3)',
      [snapshotId, project.id, file.binary_sha256],
    );

    // Snapshot delete CASCADEs to snapshot_blob_refs which fires the
    // DELETE trigger; refcount should return to 1 (just the file row).
    await db.run('DELETE FROM project_snapshots WHERE id = $1', [snapshotId]);
    const row = await db.get(
      'SELECT ref_count FROM project_blobs WHERE project_id = $1 AND sha256 = $2',
      [project.id, file.binary_sha256],
    );
    expect(row.ref_count).toBe(1);
  });
});

describe('snapshot retains the blob even after the file row is deleted', () => {
  it('blob stays on disk because the snapshot holds a ref', async () => {
    const { project } = await seed();
    const bytes = Buffer.from('keep this around');
    const file = await uploadBinaryFile(project.id, 'figure.png', bytes);
    await takeSnapshot(project.id, 'with-figure');

    // Delete the file -- refcount drops by 1, but the snapshot still
    // holds a ref so the blob isn't GC-eligible.
    await deleteFile(file.id);
    const blob = await db.get(
      'SELECT ref_count FROM project_blobs WHERE project_id = $1 AND sha256 = $2',
      [project.id, file.binary_sha256],
    );
    expect(blob.ref_count).toBe(1); // 1 from the snapshot

    // Backdate the project_blobs row so the freshness grace window passes,
    // then ask the sweep to take a pass. It should NOT collect this blob.
    await db.run(
      `UPDATE project_blobs SET created_at = NOW() - INTERVAL '10 minutes' WHERE project_id = $1 AND sha256 = $2`,
      [project.id, file.binary_sha256],
    );
    await sweepOrphanRefcounts();
    expect(await statBlob(project.id, file.binary_sha256)).not.toBeNull();
  });
});

describe('F4 CHECK constraint: is_binary requires binary_sha256', () => {
  it('rejects a direct INSERT with is_binary=TRUE and binary_sha256=NULL', async () => {
    const { project } = await seed();
    await expect(
      db.run(
        `INSERT INTO files (id, project_id, path, content, is_binary, binary_sha256) VALUES ($1, $2, $3, '', TRUE, NULL)`,
        [uuid(), project.id, 'bad.png'],
      ),
    ).rejects.toThrow(/files_binary_has_sha/);
  });

  it('allows a direct INSERT with is_binary=FALSE and NULL binary_sha256', async () => {
    const { project } = await seed();
    await expect(
      db.run(
        `INSERT INTO files (id, project_id, path, content, is_binary) VALUES ($1, $2, $3, $4, FALSE)`,
        [uuid(), project.id, 'main.tex', 'hello'],
      ),
    ).resolves.toBeDefined();
  });
});
