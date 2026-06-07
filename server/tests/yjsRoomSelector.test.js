import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../services/yjsRoom.js', () => ({
  acquireRoom: vi.fn().mockResolvedValue({ kind: 'in-process-stub' }),
  applyUpdate: vi.fn(),
  encodeStateAsUpdate: vi.fn().mockReturnValue(new Uint8Array([1])),
  releaseRoom: vi.fn(),
}));

vi.mock('../services/yjsRoomClient.js', () => ({
  acquireRoom: vi.fn().mockResolvedValue({ kind: 'remote-stub' }),
  applyUpdate: vi.fn().mockResolvedValue(true),
  encodeStateAsUpdate: vi.fn().mockResolvedValue(new Uint8Array([2])),
  releaseRoom: vi.fn().mockResolvedValue(undefined),
}));

import * as inProcess from '../services/yjsRoom.js';
import * as remote from '../services/yjsRoomClient.js';
import {
  acquireRoom,
  applyUpdate,
  encodeStateAsUpdate,
  releaseRoom,
  isWorkerSplitEnabled,
  getYjsBackend,
  _resetForTests,
} from '../services/yjsRoomSelector.js';

const saved = {};
const PRESERVE = ['FLOWTEX_YJS_WORKER'];

beforeEach(() => {
  for (const k of PRESERVE) saved[k] = process.env[k];
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
  it('defaults to the in-process backend when FLOWTEX_YJS_WORKER is unset', async () => {
    delete process.env.FLOWTEX_YJS_WORKER;
    expect(isWorkerSplitEnabled()).toBe(false);
    expect(getYjsBackend().kind).toBe('in-process');
  });

  it('routes through the remote client when FLOWTEX_YJS_WORKER=enabled', async () => {
    process.env.FLOWTEX_YJS_WORKER = 'enabled';
    expect(isWorkerSplitEnabled()).toBe(true);
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

    _resetForTests();
    process.env.FLOWTEX_YJS_WORKER = 'enabled';
    const remoteResult = await applyUpdate('p1', 'f1', new Uint8Array([1]));
    expect(remoteResult).toBe(true);
    expect(remote.applyUpdate).toHaveBeenCalled();
  });

  it('encodeStateAsUpdate / releaseRoom dispatch through the active backend', async () => {
    delete process.env.FLOWTEX_YJS_WORKER;
    const local = await encodeStateAsUpdate('p1', 'f1');
    expect(Array.from(local)).toEqual([1]);
    await releaseRoom('p1', 'f1');
    expect(inProcess.releaseRoom).toHaveBeenCalled();

    _resetForTests();
    process.env.FLOWTEX_YJS_WORKER = 'enabled';
    const remoteBytes = await encodeStateAsUpdate('p1', 'f1');
    expect(Array.from(remoteBytes)).toEqual([2]);
    await releaseRoom('p1', 'f1');
    expect(remote.releaseRoom).toHaveBeenCalled();
  });
});
