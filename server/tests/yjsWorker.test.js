import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ORIG_ARGV = process.argv;
beforeEach(() => {
  vi.clearAllMocks();
  process.argv = ['node', '/some/other/script.js'];
});
afterEach(() => { process.argv = ORIG_ARGV; });

import { dispatchEntry, heldRooms } from '../yjsWorker.js';

function makeRedis(overrides = {}) {
  return {
    // SET ... NX EX returns 'OK' on first acquire (success) and null on contention.
    set: vi.fn().mockResolvedValue('OK'),
    // EVAL is the Lua compare-and-DEL used by releaseLock.
    eval: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  return {
    acquireRoom: vi.fn().mockResolvedValue({ projectId: 'p1', fileId: 'f1' }),
    applyUpdate: vi.fn(),
    encodeStateAsUpdate: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
    releaseRoom: vi.fn().mockResolvedValue(undefined),
    redis: makeRedis(),
    consumerName: 'worker-test',
    ...overrides,
  };
}

function entry(fields) {
  const flat = [];
  for (const [k, v] of Object.entries(fields)) flat.push(k, v);
  return flat;
}

beforeEach(() => { heldRooms.clear(); });

describe('yjsWorker dispatchEntry — apply', () => {
  it('rejects entries missing required fields', async () => {
    const result = await dispatchEntry(entry({ type: 'apply' }), makeDeps());
    expect(result).toEqual({ ok: false, retryable: false, reason: 'missing-required-fields' });
  });

  it('acquires the lock + room on first use, then calls applyUpdate', async () => {
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
    // Lock attempt
    expect(deps.redis.set).toHaveBeenCalledTimes(1);
    const [k, v, ex, ttl, mode] = deps.redis.set.mock.calls[0];
    expect(k).toBe('flowtex:yjs:lock:p1:f1');
    expect(v).toBe('worker-test');
    expect(ex).toBe('EX');
    expect(ttl).toBe(30);
    expect(mode).toBe('NX');
    // Room acquisition + update application
    expect(deps.acquireRoom).toHaveBeenCalledWith('p1', 'f1');
    expect(deps.applyUpdate).toHaveBeenCalledTimes(1);
    expect(heldRooms.has('p1:f1')).toBe(true);
  });

  it('skips lock attempt + acquireRoom on the second update for the same room', async () => {
    const deps = makeDeps();
    await dispatchEntry(
      entry({ type: 'apply', projectId: 'p1', fileId: 'f1', update: Buffer.from([1]).toString('base64') }),
      deps,
    );
    await dispatchEntry(
      entry({ type: 'apply', projectId: 'p1', fileId: 'f1', update: Buffer.from([2]).toString('base64') }),
      deps,
    );
    // SET NX called once -- we already hold the lock for the second
    // entry so we skip the attempt.
    expect(deps.redis.set).toHaveBeenCalledTimes(1);
    expect(deps.acquireRoom).toHaveBeenCalledTimes(1);
    expect(deps.applyUpdate).toHaveBeenCalledTimes(2);
  });

  it('returns lock-contended (retryable) when another worker holds the lock', async () => {
    // SET NX returns null on contention.
    const deps = makeDeps({ redis: makeRedis({ set: vi.fn().mockResolvedValue(null) }) });
    const result = await dispatchEntry(
      entry({ type: 'apply', projectId: 'p1', fileId: 'f1', update: Buffer.from([1]).toString('base64') }),
      deps,
    );
    expect(result).toEqual({ ok: false, retryable: true, reason: 'lock-contended' });
    expect(deps.acquireRoom).not.toHaveBeenCalled();
    expect(deps.applyUpdate).not.toHaveBeenCalled();
    expect(heldRooms.has('p1:f1')).toBe(false);
  });

  it('releases the lock if acquireRoom returns null after we won', async () => {
    const deps = makeDeps({ acquireRoom: vi.fn().mockResolvedValue(null) });
    const result = await dispatchEntry(
      entry({ type: 'apply', projectId: 'p1', fileId: 'f1', update: Buffer.from([1]).toString('base64') }),
      deps,
    );
    expect(result).toEqual({ ok: false, retryable: false, reason: 'file-missing' });
    // Lock acquired, then released via EVAL (the Lua CAS).
    expect(deps.redis.eval).toHaveBeenCalledTimes(1);
  });

  it('drops empty updates as a poison-pill (non-retryable)', async () => {
    const deps = makeDeps();
    const result = await dispatchEntry(
      entry({ type: 'apply', projectId: 'p1', fileId: 'f1', update: '' }),
      deps,
    );
    expect(result).toEqual({ ok: false, retryable: false, reason: 'empty-update' });
  });
});

describe('yjsWorker dispatchEntry — state', () => {
  it('encodes state and writes it to the reply key', async () => {
    const deps = makeDeps();
    const result = await dispatchEntry(
      entry({
        type: 'state', projectId: 'p1', fileId: 'f1',
        replyTo: 'flowtex:yjs:state-reply:550e8400-e29b-41d4-a716-446655440000',
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.type).toBe('state');
    // Last call to redis.set is the reply SET (the lock SET was first).
    const setCalls = deps.redis.set.mock.calls;
    const lastSet = setCalls[setCalls.length - 1];
    expect(lastSet[0]).toBe('flowtex:yjs:state-reply:550e8400-e29b-41d4-a716-446655440000');
    expect(lastSet[2]).toBe('EX');
    expect(lastSet[3]).toBe(10);
  });

  it('rejects replyTo without the canonical prefix (anti-key-injection)', async () => {
    const deps = makeDeps();
    const result = await dispatchEntry(
      entry({
        type: 'state', projectId: 'p1', fileId: 'f1',
        replyTo: 'attacker-controlled-key',
      }),
      deps,
    );
    expect(result).toEqual({ ok: false, retryable: false, reason: 'bad-replyTo' });
    // No SET should have happened to the reply key.
    // The lock SET still happens before the replyTo check; that's
    // intentional -- the lock guards the encode call.
  });

  it('rejects replyTo with the canonical prefix but non-UUID suffix (anti-prefix-overflow)', async () => {
    // Tightened in the security audit pass: the prefix-only check
    // (added originally) prevented arbitrary-key writes but still
    // accepted any `flowtex:yjs:state-reply:*`. Narrowed to require
    // a 36-char UUID-shaped suffix so a Redis-write-only attacker
    // can't collide with adjacent keys we might add in this
    // namespace later. Legitimate clients use crypto.randomUUID()
    // so they always match.
    for (const badSuffix of [
      'abc',
      '12345',
      'not-a-uuid',
      '550e8400-e29b-41d4-a716-44665544000G',          // bad hex
      '550e8400-e29b-41d4-a716-446655440000-extra',    // overflow
      '550e8400e29b41d4a716446655440000',              // no dashes
      '',                                              // empty
    ]) {
      const deps = makeDeps();
      const result = await dispatchEntry(
        entry({
          type: 'state', projectId: 'p1', fileId: 'f1',
          replyTo: `flowtex:yjs:state-reply:${badSuffix}`,
        }),
        deps,
      );
      expect(result).toEqual({ ok: false, retryable: false, reason: 'bad-replyTo' });
    }
  });

  it('returns no-state (non-retryable) if encode returns null', async () => {
    const deps = makeDeps({ encodeStateAsUpdate: vi.fn().mockReturnValue(null) });
    const result = await dispatchEntry(
      entry({ type: 'state', projectId: 'p1', fileId: 'f1', replyTo: 'flowtex:yjs:state-reply:550e8400-e29b-41d4-a716-446655440000' }),
      deps,
    );
    expect(result).toEqual({ ok: false, retryable: false, reason: 'no-state' });
  });

  it('returns lock-contended (retryable) if another worker holds the lock', async () => {
    const deps = makeDeps({ redis: makeRedis({ set: vi.fn().mockResolvedValue(null) }) });
    const result = await dispatchEntry(
      entry({ type: 'state', projectId: 'p1', fileId: 'f1', replyTo: 'flowtex:yjs:state-reply:550e8400-e29b-41d4-a716-446655440000' }),
      deps,
    );
    expect(result).toEqual({ ok: false, retryable: true, reason: 'lock-contended' });
  });
});

describe('yjsWorker dispatchEntry — release', () => {
  it('calls releaseRoom + releases the lock when the room was held', async () => {
    const deps = makeDeps();
    // Pretend we acquired through an apply.
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
    // EVAL is the Lua compare-and-DEL for releaseLock.
    expect(deps.redis.eval).toHaveBeenCalled();
  });

  it('is a no-op (still ok) when the room was never held', async () => {
    const deps = makeDeps();
    const result = await dispatchEntry(
      entry({ type: 'release', projectId: 'p1', fileId: 'f1' }),
      deps,
    );
    expect(result).toEqual({ ok: true, type: 'release', noop: true });
    expect(deps.releaseRoom).not.toHaveBeenCalled();
  });

  it('release is lockless — does not call SET NX even when room is unheld', async () => {
    const deps = makeDeps();
    await dispatchEntry(
      entry({ type: 'release', projectId: 'p1', fileId: 'f1' }),
      deps,
    );
    // No SET calls (release isn't gated by the lock acquire path).
    expect(deps.redis.set).not.toHaveBeenCalled();
  });
});

describe('yjsWorker dispatchEntry — unknown', () => {
  it('rejects unknown types as poison-pill (non-retryable)', async () => {
    const result = await dispatchEntry(entry({ type: 'haxx', projectId: 'p1', fileId: 'f1' }), makeDeps());
    expect(result).toEqual({ ok: false, retryable: false, reason: 'unknown-type' });
  });
});
