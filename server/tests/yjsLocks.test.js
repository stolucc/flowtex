import { describe, it, expect, vi } from 'vitest';
import {
  acquireLock,
  renewLock,
  releaseLock,
  peekLock,
  lockKey,
  _testing,
} from '../services/yjsLocks.js';

function makeRedis({ setResult = 'OK', evalResult = 1, getResult = null, throwOn = null } = {}) {
  return {
    set: vi.fn(async () => {
      if (throwOn === 'set') throw new Error('boom');
      return setResult;
    }),
    eval: vi.fn(async () => {
      if (throwOn === 'eval') throw new Error('boom');
      return evalResult;
    }),
    get: vi.fn(async () => {
      if (throwOn === 'get') throw new Error('boom');
      return getResult;
    }),
  };
}

describe('lockKey', () => {
  it('namespaces under flowtex:yjs:lock with both ids', () => {
    expect(lockKey('proj-1', 'file-A')).toBe('flowtex:yjs:lock:proj-1:file-A');
  });
});

describe('acquireLock', () => {
  it('returns true when SET NX succeeds', async () => {
    const redis = makeRedis({ setResult: 'OK' });
    const ok = await acquireLock(redis, 'worker-1', 'p1', 'f1');
    expect(ok).toBe(true);
    const args = redis.set.mock.calls[0];
    expect(args[0]).toBe('flowtex:yjs:lock:p1:f1');
    expect(args[1]).toBe('worker-1');
    expect(args[2]).toBe('EX');
    expect(args[3]).toBe(_testing.DEFAULT_TTL_SEC);
    expect(args[4]).toBe('NX');
  });

  it('returns false when SET NX is rejected (someone else holds it)', async () => {
    const redis = makeRedis({ setResult: null });
    expect(await acquireLock(redis, 'worker-1', 'p1', 'f1')).toBe(false);
  });

  it('honours an explicit ttl override', async () => {
    const redis = makeRedis();
    await acquireLock(redis, 'worker-1', 'p1', 'f1', 7);
    expect(redis.set.mock.calls[0][3]).toBe(7);
  });

  it('returns false (no throw) when Redis errors', async () => {
    const redis = makeRedis({ throwOn: 'set' });
    expect(await acquireLock(redis, 'w', 'p', 'f')).toBe(false);
  });

  it('returns false when redis client is missing', async () => {
    expect(await acquireLock(null, 'w', 'p', 'f')).toBe(false);
  });
});

describe('renewLock', () => {
  it('re-arms via SET XX with the same consumerId', async () => {
    const redis = makeRedis({ setResult: 'OK' });
    const ok = await renewLock(redis, 'worker-1', 'p1', 'f1');
    expect(ok).toBe(true);
    const args = redis.set.mock.calls[0];
    expect(args[1]).toBe('worker-1');
    expect(args[4]).toBe('XX');
  });

  it('returns false when the key no longer exists (TTL expired)', async () => {
    // SET XX returns null if the key isn't present.
    const redis = makeRedis({ setResult: null });
    expect(await renewLock(redis, 'worker-1', 'p1', 'f1')).toBe(false);
  });

  it('returns false (no throw) when Redis errors', async () => {
    const redis = makeRedis({ throwOn: 'set' });
    expect(await renewLock(redis, 'w', 'p', 'f')).toBe(false);
  });
});

describe('releaseLock', () => {
  it('issues the Lua CAS script with the lock key and consumerId', async () => {
    const redis = makeRedis({ evalResult: 1 });
    const ok = await releaseLock(redis, 'worker-1', 'p1', 'f1');
    expect(ok).toBe(true);
    const args = redis.eval.mock.calls[0];
    expect(args[0]).toBe(_testing.RELEASE_LUA);
    expect(args[1]).toBe(1); // numkeys
    expect(args[2]).toBe('flowtex:yjs:lock:p1:f1');
    expect(args[3]).toBe('worker-1');
  });

  it('returns false when the lock is held by someone else (CAS rejects)', async () => {
    const redis = makeRedis({ evalResult: 0 });
    expect(await releaseLock(redis, 'worker-1', 'p1', 'f1')).toBe(false);
  });

  it('returns false (no throw) when Redis errors', async () => {
    const redis = makeRedis({ throwOn: 'eval' });
    expect(await releaseLock(redis, 'w', 'p', 'f')).toBe(false);
  });

  it('accepts both numeric and string return shapes from ioredis', async () => {
    expect(await releaseLock(makeRedis({ evalResult: '1' }), 'w', 'p', 'f')).toBe(true);
    expect(await releaseLock(makeRedis({ evalResult: 1 }), 'w', 'p', 'f')).toBe(true);
  });
});

describe('peekLock', () => {
  it('returns the current holder', async () => {
    const redis = makeRedis({ getResult: 'worker-A' });
    expect(await peekLock(redis, 'p1', 'f1')).toBe('worker-A');
    expect(redis.get).toHaveBeenCalledWith('flowtex:yjs:lock:p1:f1');
  });

  it('returns null when no lock exists', async () => {
    const redis = makeRedis({ getResult: null });
    expect(await peekLock(redis, 'p1', 'f1')).toBeNull();
  });

  it('returns null (no throw) when Redis errors', async () => {
    const redis = makeRedis({ throwOn: 'get' });
    expect(await peekLock(redis, 'p', 'f')).toBeNull();
  });
});

describe('two-worker contention scenario', () => {
  // Simulate a single shared "Redis" with one key so the SET NX
  // semantics actually express contention.
  function makeSharedRedis() {
    const store = new Map();
    return {
      set: vi.fn(async (key, value, ...rest) => {
        const args = new Set(rest);
        if (args.has('NX')) {
          if (store.has(key)) return null;
          store.set(key, value);
          return 'OK';
        }
        if (args.has('XX')) {
          if (!store.has(key)) return null;
          store.set(key, value);
          return 'OK';
        }
        store.set(key, value);
        return 'OK';
      }),
      eval: vi.fn(async (_script, _n, key, expected) => {
        if (store.get(key) === expected) {
          store.delete(key);
          return 1;
        }
        return 0;
      }),
      get: vi.fn(async (key) => store.get(key) ?? null),
      _store: store,
    };
  }

  it('only the first acquirer wins; the second loses; release lets a third win', async () => {
    const redis = makeSharedRedis();
    expect(await acquireLock(redis, 'worker-A', 'p1', 'f1')).toBe(true);
    expect(await acquireLock(redis, 'worker-B', 'p1', 'f1')).toBe(false);
    // worker-B cannot release something it doesn't own.
    expect(await releaseLock(redis, 'worker-B', 'p1', 'f1')).toBe(false);
    // worker-A releases; now worker-C can win.
    expect(await releaseLock(redis, 'worker-A', 'p1', 'f1')).toBe(true);
    expect(await acquireLock(redis, 'worker-C', 'p1', 'f1')).toBe(true);
  });

  it('renew fails after release (no key to refresh)', async () => {
    const redis = makeSharedRedis();
    await acquireLock(redis, 'worker-A', 'p1', 'f1');
    await releaseLock(redis, 'worker-A', 'p1', 'f1');
    expect(await renewLock(redis, 'worker-A', 'p1', 'f1')).toBe(false);
  });
});
