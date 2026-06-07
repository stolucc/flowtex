import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../services/metrics.js', () => ({
  recordYjsApply: vi.fn(),
}));

import {
  acquireRoom,
  applyUpdate,
  encodeStateAsUpdate,
  releaseRoom,
  setRedisClient,
  _resetRedisClient,
  _testing,
} from '../services/yjsRoomClient.js';

function makeMockRedis(opts = {}) {
  const xaddCalls = [];
  const setCalls = [];
  const getStore = opts.store || new Map();
  return {
    xadd: vi.fn(async (...args) => { xaddCalls.push(args); return '1-0'; }),
    set: vi.fn(async (...args) => { setCalls.push(args); return 'OK'; }),
    get: vi.fn(async (key) => (getStore.has(key) ? getStore.get(key) : null)),
    del: vi.fn(async () => 1),
    _xaddCalls: xaddCalls,
    _setCalls: setCalls,
    _store: getStore,
  };
}

beforeEach(() => { vi.clearAllMocks(); _resetRedisClient(); });

describe('yjsRoomClient acquireRoom', () => {
  it('returns a remote-tagged stub for valid ids', async () => {
    const room = await acquireRoom('proj-1', 'file-1');
    expect(room).toEqual({ projectId: 'proj-1', fileId: 'file-1', refCount: 1, remote: true });
  });

  it('returns null for missing ids', async () => {
    expect(await acquireRoom(null, 'file-1')).toBeNull();
    expect(await acquireRoom('proj-1', null)).toBeNull();
  });
});

describe('yjsRoomClient applyUpdate', () => {
  it('publishes an apply entry to the updates stream', async () => {
    const redis = makeMockRedis();
    setRedisClient(redis);

    const ok = await applyUpdate('proj-1', 'file-1', new Uint8Array([1, 2, 3]));
    expect(ok).toBe(true);
    expect(redis._xaddCalls).toHaveLength(1);

    const fields = redis._xaddCalls[0];
    expect(fields[0]).toBe(_testing.STREAM_KEY);
    // Fields after the id placeholder: [..., 'type', 'apply', 'projectId', ..., 'fileId', ..., 'update', <b64>]
    const flat = fields.slice(2);
    const map = {};
    for (let i = 0; i < flat.length; i += 2) map[flat[i]] = flat[i + 1];
    expect(map.type).toBe('apply');
    expect(map.projectId).toBe('proj-1');
    expect(map.fileId).toBe('file-1');
    expect(map.update).toBe(Buffer.from(new Uint8Array([1, 2, 3])).toString('base64'));
  });

  it('returns false (and never throws) when redis is unconfigured', async () => {
    _resetRedisClient();
    const ok = await applyUpdate('proj-1', 'file-1', new Uint8Array([1]));
    expect(ok).toBe(false);
  });

  it('returns false (and never throws) when XADD throws', async () => {
    const redis = makeMockRedis();
    redis.xadd = vi.fn().mockRejectedValueOnce(new Error('redis dead'));
    setRedisClient(redis);
    const ok = await applyUpdate('proj-1', 'file-1', new Uint8Array([1]));
    expect(ok).toBe(false);
  });
});

describe('yjsRoomClient encodeStateAsUpdate', () => {
  it('returns the worker reply when it arrives within the timeout', async () => {
    const store = new Map();
    const redis = makeMockRedis({ store });
    setRedisClient(redis);

    // Have the worker "reply" immediately by pre-populating the key
    // that XADD will allocate. Use the deterministic prefix.
    redis.xadd = vi.fn(async (...args) => {
      const flat = args.slice(2);
      const map = {};
      for (let i = 0; i < flat.length; i += 2) map[flat[i]] = flat[i + 1];
      // Stash the reply payload so the next GET returns it.
      store.set(map.replyTo, Buffer.from(new Uint8Array([9, 8, 7])).toString('base64'));
      return '1-0';
    });

    const bytes = await encodeStateAsUpdate('proj-1', 'file-1');
    expect(bytes).not.toBeNull();
    expect(Array.from(bytes)).toEqual([9, 8, 7]);
  });

  it('returns null when no reply arrives within the timeout', async () => {
    const redis = makeMockRedis();
    setRedisClient(redis);
    // No store set -- GET will always return null.
    const start = Date.now();
    const bytes = await encodeStateAsUpdate('proj-1', 'file-1');
    const elapsed = Date.now() - start;
    expect(bytes).toBeNull();
    // Should respect the timeout roughly (5 s); allow generous slack.
    expect(elapsed).toBeGreaterThanOrEqual(_testing.REPLY_TIMEOUT_MS - 200);
  }, 8000);

  it('returns null if XADD fails', async () => {
    const redis = makeMockRedis();
    redis.xadd = vi.fn().mockRejectedValueOnce(new Error('boom'));
    setRedisClient(redis);
    const bytes = await encodeStateAsUpdate('proj-1', 'file-1');
    expect(bytes).toBeNull();
  });
});

describe('yjsRoomClient releaseRoom', () => {
  it('publishes a release entry to the updates stream', async () => {
    const redis = makeMockRedis();
    setRedisClient(redis);
    await releaseRoom('proj-1', 'file-1');
    expect(redis._xaddCalls).toHaveLength(1);
    const flat = redis._xaddCalls[0].slice(2);
    const map = {};
    for (let i = 0; i < flat.length; i += 2) map[flat[i]] = flat[i + 1];
    expect(map.type).toBe('release');
    expect(map.projectId).toBe('proj-1');
    expect(map.fileId).toBe('file-1');
  });

  it('is a NOP and never throws when redis is unconfigured', async () => {
    _resetRedisClient();
    await expect(releaseRoom('proj-1', 'file-1')).resolves.toBeUndefined();
  });
});
