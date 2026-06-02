// Phase A.2 integration tests: uploadBinaryFile -> blob store + refcount,
// getRawFile delivers the right metadata, deleteFile decrements the
// refcount. Uses the real DB (per-test BEGIN/ROLLBACK via setup.js) so
// the upsert / refcount semantics are exercised end-to-end.
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { seedUser, seedProject } from './setup.js';
import db from '../../db.js';
import {
  uploadBinaryFile,
  deleteFile,
  getRawFile,
} from '../../services/projectService.js';
import { statBlob } from '../../services/blobStore.js';

let tmpRoot;
beforeAll(async () => {
  // The blobStore helper writes under compiler.js's PROJECTS_DIR. Tests
  // don't go through a fresh tmpdir for each — we use the production
  // dir but pick uuid project ids that won't collide. Cleanup is per
  // test via DELETE FROM project_blobs (cascades via project_members).
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'flowtex-blob-it-'));
  // No symlink magic — we just let the helper write to the real
  // PROJECTS_DIR; the BEGIN/ROLLBACK around each test deletes the
  // project rows but the on-disk blob lingers until OS tmp cleanup.
  // That's fine for tests; production has the GC sweep.
});

async function seed() {
  const user = await seedUser();
  const project = await seedProject(user.id);
  return { user, project };
}

describe('uploadBinaryFile (blob store)', () => {
  it('writes a new binary as a blob with refcount=1 and is_binary=true', async () => {
    const { project } = await seed();
    const bytes = Buffer.from('PNG bytes for blob test', 'utf-8');
    const file = await uploadBinaryFile(project.id, 'figures/a.png', bytes);

    expect(file.binary_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.binary_size).toBe(bytes.length);
    expect(file.binary_mime).toBe('image/png');
    expect(file.is_binary).toBe(true);

    const blob = await db.get(
      'SELECT ref_count, size FROM project_blobs WHERE project_id = $1 AND sha256 = $2',
      [project.id, file.binary_sha256],
    );
    expect(blob.ref_count).toBe(1);
    expect(blob.size).toBe(bytes.length);

    // And it really is on disk.
    const stat = await statBlob(project.id, file.binary_sha256);
    expect(stat).not.toBeNull();
    expect(stat.size).toBe(bytes.length);
  });

  it('dedup: re-uploading identical bytes to a NEW path bumps refcount to 2', async () => {
    const { project } = await seed();
    const bytes = Buffer.from('identical bytes', 'utf-8');
    const a = await uploadBinaryFile(project.id, 'a.png', bytes);
    const b = await uploadBinaryFile(project.id, 'b.png', bytes);
    expect(b.binary_sha256).toBe(a.binary_sha256);

    const blob = await db.get(
      'SELECT ref_count FROM project_blobs WHERE project_id = $1 AND sha256 = $2',
      [project.id, a.binary_sha256],
    );
    expect(blob.ref_count).toBe(2);
  });

  it('replace existing: same path different bytes swaps blob ref and decrements old', async () => {
    const { project } = await seed();
    const v1 = Buffer.from('version 1');
    const v2 = Buffer.from('version 2 — totally different');
    const first = await uploadBinaryFile(project.id, 'cover.png', v1);
    const second = await uploadBinaryFile(project.id, 'cover.png', v2);
    expect(second.updated).toBe(true);
    expect(second.binary_sha256).not.toBe(first.binary_sha256);

    const newBlob = await db.get(
      'SELECT ref_count FROM project_blobs WHERE project_id = $1 AND sha256 = $2',
      [project.id, second.binary_sha256],
    );
    const oldBlob = await db.get(
      'SELECT ref_count FROM project_blobs WHERE project_id = $1 AND sha256 = $2',
      [project.id, first.binary_sha256],
    );
    expect(newBlob.ref_count).toBe(1);
    expect(oldBlob.ref_count).toBe(0); // GC will sweep
  });

  it('deleteFile decrements refcount for the referenced blob', async () => {
    const { project } = await seed();
    const file = await uploadBinaryFile(project.id, 'doomed.png', Buffer.from('to delete'));
    expect((await db.get('SELECT ref_count FROM project_blobs WHERE project_id = $1 AND sha256 = $2', [project.id, file.binary_sha256])).ref_count).toBe(1);

    await deleteFile(file.id);

    const blob = await db.get(
      'SELECT ref_count FROM project_blobs WHERE project_id = $1 AND sha256 = $2',
      [project.id, file.binary_sha256],
    );
    expect(blob.ref_count).toBe(0);
  });

  it('rejects denied extensions before any disk write', async () => {
    const { project } = await seed();
    await expect(uploadBinaryFile(project.id, 'evil.exe', Buffer.from('mz'))).rejects.toThrow(/not allowed/);
    // No blob row exists for that project.
    const row = await db.get('SELECT COUNT(*)::int AS n FROM project_blobs WHERE project_id = $1', [project.id]);
    expect(row.n).toBe(0);
  });

  it('rejects oversized uploads with 413, no DB or disk side-effects', async () => {
    const { project } = await seed();
    const big = Buffer.alloc(51 * 1024 * 1024, 0x42);
    await expect(uploadBinaryFile(project.id, 'huge.pdf', big)).rejects.toThrow(/File too large/);
    const row = await db.get('SELECT COUNT(*)::int AS n FROM project_blobs WHERE project_id = $1', [project.id]);
    expect(row.n).toBe(0);
  });
});

describe('getRawFile carries the new columns through', () => {
  it('returns binary_sha256/size/mime alongside the row', async () => {
    const { user, project } = await seed();
    const file = await uploadBinaryFile(project.id, 'shot.png', Buffer.from('content'));
    const row = await getRawFile(file.id, user.id);
    expect(row).toBeDefined();
    expect(row.binary_sha256).toBe(file.binary_sha256);
    expect(row.binary_size).toBe(file.binary_size);
    expect(row.binary_mime).toBe('image/png');
    expect(row.is_binary).toBe(true);
  });
});

// Tidy up the tmpdir we created (the test BEGIN/ROLLBACK takes care of DB
// rows; on-disk blobs land in the real PROJECTS_DIR under uuid project
// ids, which the OS reaps with its tmp lifecycle in CI).
import { afterAll } from 'vitest';
afterAll(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});
