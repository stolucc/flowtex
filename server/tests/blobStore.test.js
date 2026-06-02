// Unit tests for the blob-store helper. Runs against a tmp project dir
// (no real PROJECTS_DIR / DB). Compiler import is mocked so we can
// inject a controlled PROJECTS_DIR for each test.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { stat, readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let TMP_ROOT;

vi.mock('../paths.js', () => ({
  // Read at access time so beforeEach() can swap PROJECTS_DIR per test.
  get PROJECTS_DIR() { return TMP_ROOT; },
}));

const { writeBlob, statBlob, readBlobStream, deleteBlob, blobPath, blobsDir } =
  await import('../services/blobStore.js');

beforeEach(async () => {
  TMP_ROOT = await mkdtemp(path.join(os.tmpdir(), 'flowtex-blobs-'));
  return () => rm(TMP_ROOT, { recursive: true, force: true });
});

function streamOf(buf) {
  return Readable.from([buf]);
}

describe('writeBlob', () => {
  it('writes a blob, returns its sha256, and lays it at the sharded path', async () => {
    const bytes = Buffer.from('hello, blob world');
    const result = await writeBlob('p1', streamOf(bytes));
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.size).toBe(bytes.length);
    expect(result.deduped).toBe(false);

    const onDisk = await readFile(blobPath('p1', result.sha256));
    expect(onDisk.equals(bytes)).toBe(true);

    // Path lives under <project>/_blobs/<prefix>/<full-hash>
    const expectedDir = path.join(blobsDir('p1'), result.sha256.slice(0, 2));
    expect(blobPath('p1', result.sha256)).toBe(path.join(expectedDir, result.sha256));
  });

  it('returns deduped=true on second write of identical bytes (within the same project)', async () => {
    const bytes = Buffer.from('same bytes twice');
    const a = await writeBlob('p1', streamOf(bytes));
    const b = await writeBlob('p1', streamOf(bytes));
    expect(b.sha256).toBe(a.sha256);
    expect(b.deduped).toBe(true);
    expect(b.size).toBe(bytes.length);
  });

  it('does NOT dedup across projects (per-project isolation invariant)', async () => {
    const bytes = Buffer.from('same content, different project');
    const a = await writeBlob('alice-project', streamOf(bytes));
    const b = await writeBlob('bob-project', streamOf(bytes));
    expect(b.sha256).toBe(a.sha256);
    // Both projects have their own copy on disk; deleting one does not
    // affect the other.
    expect((await stat(blobPath('alice-project', a.sha256))).isFile()).toBe(true);
    expect((await stat(blobPath('bob-project', b.sha256))).isFile()).toBe(true);
  });

  it('cleans up the temp file and throws when the byte cap is exceeded', async () => {
    const big = Buffer.alloc(1024, 0x7a);
    await expect(writeBlob('p1', streamOf(big), { maxBytes: 100 })).rejects.toMatchObject({
      status: 413,
      message: /file exceeds/i,
    });
    // No stray files left under _tmp/.
    const tmpDir = path.join(blobsDir('p1'), '_tmp');
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(tmpDir);
    expect(entries.length).toBe(0);
  });

  it('rejects a sha256 that fails the format check (defensive)', () => {
    expect(() => blobPath('p1', 'not-a-sha')).toThrow(/invalid sha256/);
    expect(() => blobPath('p1', 'A'.repeat(64))).toThrow(/invalid sha256/); // upper-case not allowed
  });
});

describe('statBlob / readBlobStream / deleteBlob', () => {
  it('statBlob returns size + mtime for an existing blob, null otherwise', async () => {
    const { sha256, size } = await writeBlob('p1', streamOf(Buffer.from('xyz')));
    const s = await statBlob('p1', sha256);
    expect(s).not.toBeNull();
    expect(s.size).toBe(size);
    expect(s.mtimeMs).toBeGreaterThan(0);
    expect(await statBlob('p1', 'f'.repeat(64))).toBeNull();
  });

  it('readBlobStream yields the original bytes', async () => {
    const bytes = Buffer.from('streamed read content');
    const { sha256 } = await writeBlob('p1', streamOf(bytes));
    const stream = readBlobStream('p1', sha256);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  });

  it('deleteBlob removes the file on disk; second delete is a no-op (no throw)', async () => {
    const { sha256 } = await writeBlob('p1', streamOf(Buffer.from('to delete')));
    await deleteBlob('p1', sha256);
    expect(await statBlob('p1', sha256)).toBeNull();
    await expect(deleteBlob('p1', sha256)).resolves.toBeUndefined();
  });
});
