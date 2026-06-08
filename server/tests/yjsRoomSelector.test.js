import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../services/yjsRoom.js', () => ({
  acquireRoom: vi.fn().mockResolvedValue({ kind: 'in-process-stub' }),
  applyUpdate: vi.fn(),
  encodeStateAsUpdate: vi.fn().mockReturnValue(new Uint8Array([1])),
  releaseRoom: vi.fn(),
  peekRoom: vi.fn().mockReturnValue({ kind: 'in-process-peek', ydoc: { fake: true } }),
}));

vi.mock('../services/yjsRoomClient.js', () => ({
  acquireRoom: vi.fn().mockResolvedValue({ kind: 'remote-stub' }),
  applyUpdate: vi.fn().mockResolvedValue(true),
  encodeStateAsUpdate: vi.fn().mockResolvedValue(new Uint8Array([2])),
  releaseRoom: vi.fn().mockResolvedValue(undefined),
  peekRoom: vi.fn().mockReturnValue(null),
}));

import * as inProcess from '../services/yjsRoom.js';
import * as remote from '../services/yjsRoomClient.js';
import {
  acquireRoom,
  applyUpdate,
  encodeStateAsUpdate,
  releaseRoom,
  peekRoom,
  isWorkerSplitEnabled,
  getYjsBackend,
  _resetForTests,
} from '../services/yjsRoomSelector.js';

const saved = {};
const PRESERVE = ['FLOWTEX_YJS_WORKER', 'FLOWTEX_INSTANCE_MODE', 'REDIS_URL'];

beforeEach(() => {
  for (const k of PRESERVE) saved[k] = process.env[k];
  // Each test starts with a clean slate for all three env vars so
  // tests for one mode aren't influenced by the other.
  for (const k of PRESERVE) delete process.env[k];
  _resetForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  for (const k of PRESERVE) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('yjsRoomSelector', () => {
  it('defaults to the in-process backend when all env vars are unset (dev / single-VPS)', async () => {
    expect(isWorkerSplitEnabled()).toBe(false);
    expect(getYjsBackend().kind).toBe('in-process');
  });

  it('routes through the remote client when FLOWTEX_YJS_WORKER=enabled (explicit opt-in)', async () => {
    process.env.FLOWTEX_YJS_WORKER = 'enabled';
    expect(isWorkerSplitEnabled()).toBe(true);
  });

  it('uses the remote client by DEFAULT in cluster mode with REDIS_URL set (phase 3 cutover)', async () => {
    process.env.FLOWTEX_INSTANCE_MODE = 'cluster';
    process.env.REDIS_URL = 'redis://example:6379/0';
    expect(isWorkerSplitEnabled()).toBe(true);
    expect(getYjsBackend().kind).toBe('remote');
  });

  it('FALLS BACK to in-process in cluster mode if REDIS_URL is missing', async () => {
    // Defensive: cluster + no Redis is misconfigured. websocket.js
    // refuses to boot in this state, but the selector should still
    // pick the safe default rather than failing later in the apply
    // path with a confusing "no redis client" error.
    process.env.FLOWTEX_INSTANCE_MODE = 'cluster';
    delete process.env.REDIS_URL;
    expect(isWorkerSplitEnabled()).toBe(false);
  });

  it('honours an explicit FLOWTEX_YJS_WORKER=disabled even in cluster mode', async () => {
    process.env.FLOWTEX_INSTANCE_MODE = 'cluster';
    process.env.REDIS_URL = 'redis://example:6379/0';
    process.env.FLOWTEX_YJS_WORKER = 'disabled';
    expect(isWorkerSplitEnabled()).toBe(false);
  });

  it('accepts truthy / falsy variants of FLOWTEX_YJS_WORKER', async () => {
    for (const truthy of ['enabled', '1', 'true', 'TRUE', 'Enabled']) {
      _resetForTests();
      process.env.FLOWTEX_YJS_WORKER = truthy;
      expect(isWorkerSplitEnabled()).toBe(true);
    }
    for (const falsy of ['disabled', '0', 'false', 'FALSE']) {
      _resetForTests();
      process.env.FLOWTEX_YJS_WORKER = falsy;
      expect(isWorkerSplitEnabled()).toBe(false);
    }
  });

  it('routes acquireRoom to the in-process impl by default', async () => {
    delete process.env.FLOWTEX_YJS_WORKER;
    const room = await acquireRoom('p1', 'f1');
    expect(room).toEqual({ kind: 'in-process-stub' });
    expect(inProcess.acquireRoom).toHaveBeenCalledWith('p1', 'f1');
    expect(remote.acquireRoom).not.toHaveBeenCalled();
  });

  it('routes acquireRoom to the remote impl when worker split is on', async () => {
    process.env.FLOWTEX_YJS_WORKER = 'enabled';
    const room = await acquireRoom('p1', 'f1');
    expect(room).toEqual({ kind: 'remote-stub' });
    expect(remote.acquireRoom).toHaveBeenCalledWith('p1', 'f1');
    expect(inProcess.acquireRoom).not.toHaveBeenCalled();
  });

  it('applyUpdate routes by backend and resolves with true (in-process and remote)', async () => {
    delete process.env.FLOWTEX_YJS_WORKER;
    const local = await applyUpdate('p1', 'f1', new Uint8Array([1]));
    expect(local).toBe(true);
    expect(inProcess.applyUpdate).toHaveBeenCalled();
    // Belt-and-braces: the OTHER backend must NOT have been called.
    // Without this, mutation tests show that "force in-process branch"
    // and "force remote branch" both survive because the unused
    // backend's mock returns a value that happens to satisfy the
    // return-value assertion above. The "not called" check is what
    // actually pins the routing decision.
    expect(remote.applyUpdate).not.toHaveBeenCalled();

    _resetForTests();
    vi.clearAllMocks();
    process.env.FLOWTEX_YJS_WORKER = 'enabled';
    const remoteResult = await applyUpdate('p1', 'f1', new Uint8Array([1]));
    expect(remoteResult).toBe(true);
    expect(remote.applyUpdate).toHaveBeenCalled();
    expect(inProcess.applyUpdate).not.toHaveBeenCalled();
  });

  it('encodeStateAsUpdate / releaseRoom dispatch through the active backend', async () => {
    delete process.env.FLOWTEX_YJS_WORKER;
    const local = await encodeStateAsUpdate('p1', 'f1');
    expect(Array.from(local)).toEqual([1]);
    expect(inProcess.encodeStateAsUpdate).toHaveBeenCalled();
    expect(remote.encodeStateAsUpdate).not.toHaveBeenCalled();
    await releaseRoom('p1', 'f1');
    expect(inProcess.releaseRoom).toHaveBeenCalled();
    expect(remote.releaseRoom).not.toHaveBeenCalled();

    _resetForTests();
    vi.clearAllMocks();
    process.env.FLOWTEX_YJS_WORKER = 'enabled';
    const remoteBytes = await encodeStateAsUpdate('p1', 'f1');
    expect(Array.from(remoteBytes)).toEqual([2]);
    expect(remote.encodeStateAsUpdate).toHaveBeenCalled();
    expect(inProcess.encodeStateAsUpdate).not.toHaveBeenCalled();
    await releaseRoom('p1', 'f1');
    expect(remote.releaseRoom).toHaveBeenCalled();
    expect(inProcess.releaseRoom).not.toHaveBeenCalled();
  });

  it('getYjsBackend caches the routing decision across calls', async () => {
    // Mutation test surfaced: the `if (active) return active` cache
    // guard had no test backing it. Without the cache, a mid-process
    // env-var change would silently flip the routing -- the cached
    // value is the contract that the decision is set once at first
    // call and stays.
    delete process.env.FLOWTEX_YJS_WORKER;
    expect(getYjsBackend().kind).toBe('in-process');
    process.env.FLOWTEX_YJS_WORKER = 'enabled';        // would flip without cache
    expect(getYjsBackend().kind).toBe('in-process');   // still in-process
    _resetForTests();
    expect(getYjsBackend().kind).toBe('remote');       // fresh evaluation post-reset
  });

  it('classifyExplicitFlag: unknown values fall through to env-based logic', async () => {
    // Mutation testing surfaced: (raw || '').toLowerCase() -- the
    // empty-string fallback is unobservable without a test that pins
    // the "no env set" path explicitly. Without this assertion, a
    // mutation to `(raw || 'enabled')` would silently flip the default.
    delete process.env.FLOWTEX_YJS_WORKER;
    expect(isWorkerSplitEnabled()).toBe(false);
    _resetForTests();
    process.env.FLOWTEX_YJS_WORKER = 'gibberish';  // unrecognised -> fall through
    expect(isWorkerSplitEnabled()).toBe(false);    // no cluster mode either -> in-process
  });

  it('peekRoom: in-process returns the local room; remote returns null', async () => {
    delete process.env.FLOWTEX_YJS_WORKER;
    const local = peekRoom('p1', 'f1');
    expect(local).toEqual({ kind: 'in-process-peek', ydoc: { fake: true } });
    expect(inProcess.peekRoom).toHaveBeenCalledWith('p1', 'f1');

    _resetForTests();
    process.env.FLOWTEX_YJS_WORKER = 'enabled';
    const remoteResult = peekRoom('p1', 'f1');
    expect(remoteResult).toBeNull();
    expect(remote.peekRoom).toHaveBeenCalledWith('p1', 'f1');
  });
});
