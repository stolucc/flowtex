import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Reset the module (and its env-derived consts + in-process counter)
// between tests. compileSemaphore reads REDIS_URL / MAX_CONCURRENT_COMPILES
// / FLOWTEX_HOST_ID at import time.
const ORIG = { ...process.env };
beforeEach(() => { vi.resetModules(); });
afterEach(() => { process.env = { ...ORIG }; vi.doUnmock('ioredis'); });

describe('compileSemaphore — per-box key', () => {
  it('namespaces the Redis key by host id (so boxes stay independent)', async () => {
    delete process.env.REDIS_URL;
    process.env.FLOWTEX_HOST_ID = 'boxA';
    const { _testing } = await import('../services/compileSemaphore.js');
    expect(_testing.KEY).toBe('flowtex:compile:slots:boxA');
  });
});

describe('compileSemaphore — in-process fallback (single-instance box)', () => {
  it('caps at MAX_CONCURRENT_COMPILES and frees on release', async () => {
    delete process.env.REDIS_URL;
    process.env.MAX_CONCURRENT_COMPILES = '2';
    const { acquireCompileSlot, releaseCompileSlot } = await import('../services/compileSemaphore.js');

    expect(await acquireCompileSlot('a')).toBe(true);
    expect(await acquireCompileSlot('b')).toBe(true);
    expect(await acquireCompileSlot('c')).toBe(false); // at the limit
    await releaseCompileSlot('a');
    expect(await acquireCompileSlot('c')).toBe(true);   // slot freed
  });

  it('never drops below zero on over-release', async () => {
    delete process.env.REDIS_URL;
    process.env.MAX_CONCURRENT_COMPILES = '1';
    const { acquireCompileSlot, releaseCompileSlot } = await import('../services/compileSemaphore.js');
    await releaseCompileSlot('x'); // release with nothing held
    await releaseCompileSlot('x');
    expect(await acquireCompileSlot('a')).toBe(true);   // still one slot available
    expect(await acquireCompileSlot('b')).toBe(false);
  });
});

describe('compileSemaphore — Redis path (multi-instance box)', () => {
  function mockRedis(evalImpl) {
    const zrem = vi.fn().mockResolvedValue(1);
    const evalFn = vi.fn(evalImpl);
    vi.doMock('ioredis', () => ({
      default: class {
        eval = evalFn;
        zrem = zrem;
        on() {}
      },
    }));
    return { evalFn, zrem };
  }

  it('acquires via the atomic Lua script and releases via ZREM', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.MAX_CONCURRENT_COMPILES = '3';
    process.env.FLOWTEX_HOST_ID = 'boxB';
    const { evalFn, zrem } = mockRedis(async () => 1);
    const { acquireCompileSlot, releaseCompileSlot, _testing } = await import('../services/compileSemaphore.js');

    expect(await acquireCompileSlot('job1')).toBe(true);
    const [script, numkeys, key, , limit, , member] = evalFn.mock.calls[0];
    expect(script).toBe(_testing.ACQUIRE_LUA);
    expect(numkeys).toBe(1);
    expect(key).toBe('flowtex:compile:slots:boxB');
    expect(limit).toBe('3');
    expect(member).toBe('job1');

    await releaseCompileSlot('job1');
    expect(zrem).toHaveBeenCalledWith('flowtex:compile:slots:boxB', 'job1');
  });

  it('returns false when the box is at its limit (Lua returns 0)', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    mockRedis(async () => 0);
    const { acquireCompileSlot } = await import('../services/compileSemaphore.js');
    expect(await acquireCompileSlot('job')).toBe(false);
  });

  it('fails OPEN on a Redis error (a blip must not block all compiles)', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    mockRedis(async () => { throw new Error('redis down'); });
    const { acquireCompileSlot } = await import('../services/compileSemaphore.js');
    expect(await acquireCompileSlot('job')).toBe(true);
  });
});
