import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stop yjsWorker from grabbing a real Redis client + starting the
// stream loop on import.
const ORIG_ARGV = process.argv;
beforeEach(() => {
  vi.clearAllMocks();
  process.argv = ['node', '/some/other/script.js'];
});
afterEach(() => { process.argv = ORIG_ARGV; });

import { afterEach } from 'vitest';
import { dispatchEntry, heldRooms } from '../yjsWorker.js';

function makeDeps(overrides = {}) {
  return {
    acquireRoom: vi.fn().mockResolvedValue({ projectId: 'p1', fileId: 'f1' }),
    applyUpdate: vi.fn(),
    encodeStateAsUpdate: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
    releaseRoom: vi.fn().mockResolvedValue(undefined),
    redis: { set: vi.fn().mockResolvedValue('OK') },
    ...overrides,
  };
}

function entry(fields) {
  // Stream entries are flat [field, value, field, value, ...]
  const flat = [];
  for (const [k, v] of Object.entries(fields)) flat.push(k, v);
  return flat;
}

beforeEach(() => { heldRooms.clear(); });

describe('yjsWorker dispatchEntry', () => {
  it('rejects entries missing required fields', async () => {
    const result = await dispatchEntry(entry({ type: 'apply' }), makeDeps());
    expect(result).toEqual({ ok: false, reason: 'missing-required-fields' });
  });

  it('on apply: acquires the room on first use then calls applyUpdate', async () => {
    const deps = makeDeps();
    const result = await dispatchEntry(
      entry({
        type: 'apply',
        projectId: 'p1',
        fileId: 'f1',
        update: Buffer.from(new Uint8Array([1, 2, 3])).toString('base64'),
      }),
      deps,
    );
    expect(result).toEqual({ ok: true, type: 'apply' });
    expect(deps.acquireRoom).toHaveBeenCalledWith('p1', 'f1');
    expect(deps.applyUpdate).toHaveBeenCalledTimes(1);
    expect(heldRooms.has('p1:f1')).toBe(true);
  });

  it('on apply: skips acquireRoom on the second update for the same room', async () => {
    const deps = makeDeps();
    await dispatchEntry(
      entry({
        type: 'apply', projectId: 'p1', fileId: 'f1',
        update: Buffer.from([1]).toString('base64'),
      }),
      deps,
    );
    await dispatchEntry(
      entry({
        type: 'apply', projectId: 'p1', fileId: 'f1',
        update: Buffer.from([2]).toString('base64'),
      }),
      deps,
    );
    expect(deps.acquireRoom).toHaveBeenCalledTimes(1);
    expect(deps.applyUpdate).toHaveBeenCalledTimes(2);
  });

  it('on apply: returns file-missing if acquireRoom returns null', async () => {
    const deps = makeDeps({ acquireRoom: vi.fn().mockResolvedValue(null) });
    const result = await dispatchEntry(
      entry({ type: 'apply', projectId: 'p1', fileId: 'f1', update: Buffer.from([1]).toString('base64') }),
      deps,
    );
    expect(result).toEqual({ ok: false, reason: 'file-missing' });
    expect(deps.applyUpdate).not.toHaveBeenCalled();
  });

  it('on apply: drops empty updates', async () => {
    const deps = makeDeps();
    const result = await dispatchEntry(
      entry({ type: 'apply', projectId: 'p1', fileId: 'f1', update: '' }),
      deps,
    );
    expect(result).toEqual({ ok: false, reason: 'empty-update' });
  });

  it('on state: encodes state and writes it to the reply key', async () => {
    const deps = makeDeps();
    const result = await dispatchEntry(
      entry({
        type: 'state', projectId: 'p1', fileId: 'f1',
        replyTo: 'flowtex:yjs:state-reply:abc',
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.type).toBe('state');
    expect(deps.redis.set).toHaveBeenCalledWith(
      'flowtex:yjs:state-reply:abc',
      Buffer.from(new Uint8Array([1, 2, 3])).toString('base64'),
      'EX',
      10,
    );
  });

  it('on state: rejects replyTo that does not match the prefix (anti-key-injection)', async () => {
    const deps = makeDeps();
    const result = await dispatchEntry(
      entry({
        type: 'state', projectId: 'p1', fileId: 'f1',
        replyTo: 'attacker-controlled-key',
      }),
      deps,
    );
    expect(result).toEqual({ ok: false, reason: 'bad-replyTo' });
    expect(deps.redis.set).not.toHaveBeenCalled();
  });

  it('on state: returns no-state if encode returns null', async () => {
    const deps = makeDeps({ encodeStateAsUpdate: vi.fn().mockReturnValue(null) });
    const result = await dispatchEntry(
      entry({ type: 'state', projectId: 'p1', fileId: 'f1', replyTo: 'flowtex:yjs:state-reply:x' }),
      deps,
    );
    expect(result).toEqual({ ok: false, reason: 'no-state' });
  });

  it('on release: calls releaseRoom and removes from heldRooms', async () => {
    const deps = makeDeps();
    // Pretend we've acquired.
    await dispatchEntry(
      entry({ type: 'apply', projectId: 'p1', fileId: 'f1', update: Buffer.from([1]).toString('base64') }),
      deps,
    );
    expect(heldRooms.has('p1:f1')).toBe(true);
    const result = await dispatchEntry(
      entry({ type: 'release', projectId: 'p1', fileId: 'f1' }),
      deps,
    );
    expect(result).toEqual({ ok: true, type: 'release' });
    expect(deps.releaseRoom).toHaveBeenCalledWith('p1', 'f1');
    expect(heldRooms.has('p1:f1')).toBe(false);
  });

  it('on release: no-op when the room was never held', async () => {
    const deps = makeDeps();
    const result = await dispatchEntry(
      entry({ type: 'release', projectId: 'p1', fileId: 'f1' }),
      deps,
    );
    expect(result).toEqual({ ok: true, type: 'release', noop: true });
    expect(deps.releaseRoom).not.toHaveBeenCalled();
  });

  it('rejects unknown types', async () => {
    const result = await dispatchEntry(entry({ type: 'haxx', projectId: 'p1', fileId: 'f1' }), makeDeps());
    expect(result).toEqual({ ok: false, reason: 'unknown-type' });
  });
});
