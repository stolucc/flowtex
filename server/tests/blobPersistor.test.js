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

import {
  getBlobPersistor,
  getActiveBackendName,
  _resetBlobPersistor,
  writeBlob,
  statBlob,
  readBlobStream,
  deleteBlob,
} from '../services/blobPersistor.js';
import * as fsBackend from '../services/blobStore.js';

const PRESERVE = ['FLOWTEX_BLOB_BACKEND'];
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
