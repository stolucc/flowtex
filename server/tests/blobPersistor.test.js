import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stub the FS-backed blobStore so the selector tests don't touch disk.
vi.mock('../services/blobStore.js', () => ({
  writeBlob: vi.fn().mockResolvedValue({ sha256: 'aaa', size: 1, deduped: false }),
  statBlob: vi.fn().mockResolvedValue({ size: 1, mtimeMs: 0 }),
  readBlobStream: vi.fn().mockReturnValue('fs-stream'),
  deleteBlob: vi.fn().mockResolvedValue(undefined),
}));

// Stub the S3 backend so the fallback-chain tests can use s3 as a
// pretend backend without installing the AWS SDK.
const s3Mock = {
  writeBlob: vi.fn().mockResolvedValue({ sha256: 'bbb', size: 1, deduped: false }),
  statBlob: vi.fn().mockResolvedValue(null),
  readBlobStream: vi.fn().mockResolvedValue('s3-stream'),
  deleteBlob: vi.fn().mockResolvedValue(undefined),
};
vi.mock('../services/blobPersistorS3.js', () => ({
  makeS3Backend: () => Promise.resolve({
    name: 's3',
    info: () => ({ backend: 's3' }),
    ...s3Mock,
  }),
}));

import {
  getBlobPersistor,
  getActiveBackendName,
  getFallbackBackendName,
  _resetBlobPersistor,
  writeBlob,
  statBlob,
  readBlobStream,
  deleteBlob,
  loadBlobBytes,
} from '../services/blobPersistor.js';
import * as fsBackend from '../services/blobStore.js';

const PRESERVE = ['FLOWTEX_BLOB_BACKEND', 'FLOWTEX_BLOB_FALLBACK_BACKEND'];
const saved = {};
beforeEach(() => {
  vi.clearAllMocks();
  _resetBlobPersistor();
  for (const k of PRESERVE) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of PRESERVE) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('blobPersistor selector', () => {
  it('defaults to the fs backend when FLOWTEX_BLOB_BACKEND is unset', async () => {
    delete process.env.FLOWTEX_BLOB_BACKEND;
    const b = await getBlobPersistor();
    expect(b.name).toBe('fs');
    expect(getActiveBackendName()).toBe('fs');
  });

  it('is idempotent -- second call returns the same instance', async () => {
    const b1 = await getBlobPersistor();
    const b2 = await getBlobPersistor();
    expect(b2).toBe(b1);
  });

  it('routes through the fs backend writeBlob', async () => {
    delete process.env.FLOWTEX_BLOB_BACKEND;
    const result = await writeBlob('proj-1', 'STREAM', { maxBytes: 10 });
    expect(fsBackend.writeBlob).toHaveBeenCalledWith('proj-1', 'STREAM', { maxBytes: 10 });
    expect(result).toEqual({ sha256: 'aaa', size: 1, deduped: false });
  });

  it('routes statBlob, readBlobStream, deleteBlob to the fs backend', async () => {
    delete process.env.FLOWTEX_BLOB_BACKEND;
    await statBlob('proj-1', 'sha');
    expect(fsBackend.statBlob).toHaveBeenCalledWith('proj-1', 'sha');

    const stream = await readBlobStream('proj-1', 'sha');
    expect(stream).toBe('fs-stream');

    await deleteBlob('proj-1', 'sha');
    expect(fsBackend.deleteBlob).toHaveBeenCalledWith('proj-1', 'sha');
  });

  it('throws on an unknown backend identifier', async () => {
    process.env.FLOWTEX_BLOB_BACKEND = 'azure';
    await expect(getBlobPersistor()).rejects.toThrow(/not a recognised backend/);
  });

  it('case-insensitive on FLOWTEX_BLOB_BACKEND', async () => {
    process.env.FLOWTEX_BLOB_BACKEND = 'FS';
    const b = await getBlobPersistor();
    expect(b.name).toBe('fs');
  });
});

describe('blobPersistor fallback chain (phase 2.5)', () => {
  beforeEach(() => {
    s3Mock.statBlob.mockReset().mockResolvedValue(null);
    s3Mock.readBlobStream.mockReset().mockResolvedValue('s3-stream');
    s3Mock.writeBlob.mockReset().mockResolvedValue({ sha256: 'bbb', size: 1, deduped: false });
    s3Mock.deleteBlob.mockReset().mockResolvedValue(undefined);
  });

  it('returns null fallback name when FLOWTEX_BLOB_FALLBACK_BACKEND is unset', async () => {
    delete process.env.FLOWTEX_BLOB_FALLBACK_BACKEND;
    await getBlobPersistor();
    expect(getFallbackBackendName()).toBeNull();
  });

  it('loads both primary and fallback when both env vars are set', async () => {
    process.env.FLOWTEX_BLOB_BACKEND = 's3';
    process.env.FLOWTEX_BLOB_FALLBACK_BACKEND = 'fs';
    await getBlobPersistor();
    expect(getActiveBackendName()).toBe('s3');
    expect(getFallbackBackendName()).toBe('fs');
  });

  it('refuses fallback == primary', async () => {
    process.env.FLOWTEX_BLOB_BACKEND = 'fs';
    process.env.FLOWTEX_BLOB_FALLBACK_BACKEND = 'fs';
    await expect(getBlobPersistor()).rejects.toThrow(/must differ/);
  });

  it('statBlob: primary hit -- does not consult fallback', async () => {
    process.env.FLOWTEX_BLOB_BACKEND = 's3';
    process.env.FLOWTEX_BLOB_FALLBACK_BACKEND = 'fs';
    s3Mock.statBlob.mockResolvedValueOnce({ size: 42, mtimeMs: 0 });
    const result = await statBlob('proj', 'sha');
    expect(result).toEqual({ size: 42, mtimeMs: 0 });
    expect(fsBackend.statBlob).not.toHaveBeenCalled();
  });

  it('statBlob: primary miss -- falls back to secondary backend', async () => {
    process.env.FLOWTEX_BLOB_BACKEND = 's3';
    process.env.FLOWTEX_BLOB_FALLBACK_BACKEND = 'fs';
    s3Mock.statBlob.mockResolvedValueOnce(null);
    fsBackend.statBlob.mockResolvedValueOnce({ size: 99, mtimeMs: 0 });
    const result = await statBlob('proj', 'sha');
    expect(result).toEqual({ size: 99, mtimeMs: 0 });
    expect(s3Mock.statBlob).toHaveBeenCalled();
    expect(fsBackend.statBlob).toHaveBeenCalledWith('proj', 'sha');
  });

  it('statBlob: both miss -- returns null', async () => {
    process.env.FLOWTEX_BLOB_BACKEND = 's3';
    process.env.FLOWTEX_BLOB_FALLBACK_BACKEND = 'fs';
    s3Mock.statBlob.mockResolvedValueOnce(null);
    fsBackend.statBlob.mockResolvedValueOnce(null);
    const result = await statBlob('proj', 'sha');
    expect(result).toBeNull();
  });

  it('readBlobStream: primary stat hit -- reads from primary backend', async () => {
    process.env.FLOWTEX_BLOB_BACKEND = 's3';
    process.env.FLOWTEX_BLOB_FALLBACK_BACKEND = 'fs';
    s3Mock.statBlob.mockResolvedValueOnce({ size: 1, mtimeMs: 0 });
    const stream = await readBlobStream('proj', 'sha');
    expect(stream).toBe('s3-stream');
    expect(fsBackend.readBlobStream).not.toHaveBeenCalled();
  });

  it('readBlobStream: primary stat miss -- reads from fallback', async () => {
    process.env.FLOWTEX_BLOB_BACKEND = 's3';
    process.env.FLOWTEX_BLOB_FALLBACK_BACKEND = 'fs';
    s3Mock.statBlob.mockResolvedValueOnce(null);
    fsBackend.statBlob.mockResolvedValueOnce({ size: 1, mtimeMs: 0 });
    const stream = await readBlobStream('proj', 'sha');
    expect(stream).toBe('fs-stream');
  });

  it('readBlobStream: both stats miss -- returns null', async () => {
    process.env.FLOWTEX_BLOB_BACKEND = 's3';
    process.env.FLOWTEX_BLOB_FALLBACK_BACKEND = 'fs';
    s3Mock.statBlob.mockResolvedValueOnce(null);
    fsBackend.statBlob.mockResolvedValueOnce(null);
    const stream = await readBlobStream('proj', 'sha');
    expect(stream).toBeNull();
  });

  it('writeBlob: only ever targets the primary backend', async () => {
    process.env.FLOWTEX_BLOB_BACKEND = 's3';
    process.env.FLOWTEX_BLOB_FALLBACK_BACKEND = 'fs';
    await writeBlob('proj', 'stream');
    expect(s3Mock.writeBlob).toHaveBeenCalled();
    expect(fsBackend.writeBlob).not.toHaveBeenCalled();
  });

  it('deleteBlob: only ever targets the primary backend', async () => {
    process.env.FLOWTEX_BLOB_BACKEND = 's3';
    process.env.FLOWTEX_BLOB_FALLBACK_BACKEND = 'fs';
    await deleteBlob('proj', 'sha');
    expect(s3Mock.deleteBlob).toHaveBeenCalled();
    expect(fsBackend.deleteBlob).not.toHaveBeenCalled();
  });
});

describe('loadBlobBytes (phase 2.5)', () => {
  function readableFromChunks(chunks) {
    const { Readable } = require('node:stream');
    return Readable.from(chunks);
  }

  it('streams the blob to a Buffer when primary backend has it', async () => {
    delete process.env.FLOWTEX_BLOB_FALLBACK_BACKEND;
    fsBackend.readBlobStream.mockReturnValueOnce(
      readableFromChunks([Buffer.from('hello'), Buffer.from(' world')]),
    );
    const bytes = await loadBlobBytes('proj', 'sha');
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString('utf-8')).toBe('hello world');
  });

  it('returns null when the readBlobStream call returns null', async () => {
    process.env.FLOWTEX_BLOB_BACKEND = 's3';
    process.env.FLOWTEX_BLOB_FALLBACK_BACKEND = 'fs';
    s3Mock.statBlob.mockResolvedValueOnce(null);
    fsBackend.statBlob.mockResolvedValueOnce(null);
    const bytes = await loadBlobBytes('proj', 'sha');
    expect(bytes).toBeNull();
  });

  it('returns null when the stream emits ENOENT', async () => {
    delete process.env.FLOWTEX_BLOB_FALLBACK_BACKEND;
    const { Readable } = await import('node:stream');
    const erroring = new Readable({
      read() {
        const err = new Error('not found');
        err.code = 'ENOENT';
        this.destroy(err);
      },
    });
    fsBackend.readBlobStream.mockReturnValueOnce(erroring);
    const bytes = await loadBlobBytes('proj', 'sha');
    expect(bytes).toBeNull();
  });
});
