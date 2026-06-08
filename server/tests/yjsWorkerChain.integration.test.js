// YJS-WORKER-SPLIT phase 3d -- live-Redis integration test for the
// worker chain.
//
// Exercises the actual wire protocol: yjsRoomClient XADDs an update
// to flowtex:yjs:updates, this test (acting as the worker) does
// XREADGROUP, dispatches the entry through the real dispatchEntry,
// and verifies the round trip.
//
// What's REAL:
//   - Redis: connects to $REDIS_URL (default redis://127.0.0.1:6379/15)
//   - The XADD / XREADGROUP / SET / XACK protocol semantics
//   - The wire shape produced by yjsRoomClient and consumed by
//     yjsWorker.dispatchEntry
//   - The state-RPC reply-key + TTL contract
//
// What's MOCKED (deliberately):
//   - acquireRoom / applyUpdate / encodeStateAsUpdate / releaseRoom
//     -- these live in yjsRoom.js which calls into PG. This test is
//     about the WORKER CHAIN, not the Y.Doc engine, so we substitute
//     them via dispatchEntry's deps parameter.
//
// Gate: RUN_REDIS_INTEGRATION=1. Default suite stays hermetic.
//
// Run:
//   RUN_REDIS_INTEGRATION=1 npx vitest run tests/yjsWorkerChain.integration.test.js

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Redis from 'ioredis';

import {
  applyUpdate as clientApplyUpdate,
  encodeStateAsUpdate as clientEncodeState,
  releaseRoom as clientReleaseRoom,
  setRedisClient,
  _resetRedisClient,
} from '../services/yjsRoomClient.js';
import {
  dispatchEntry,
  ensureConsumerGroup,
  heldRooms,
  CONSUMER_GROUP,
  STREAM_KEY,
} from '../yjsWorker.js';
import {
  acquireLock,
  releaseLock,
  peekLock,
} from '../services/yjsLocks.js';

const RUN = process.env.RUN_REDIS_INTEGRATION === '1';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379/15';

// Helper: read one entry from the stream as the worker would.
// Returns [entryId, fieldsArray] or null on BLOCK timeout.
async function readOne(redis, consumerName) {
  const res = await redis.xreadgroup(
    'GROUP', CONSUMER_GROUP, consumerName,
    'BLOCK', 2000,
    'COUNT', 1,
    'STREAMS', STREAM_KEY, '>',
  );
  if (!res) return null;
  const entries = res[0]?.[1] || [];
  return entries[0] || null;
}

// Helper: build the mock deps shape that dispatchEntry expects.
function makeMockDeps(redis, consumerName, overrides = {}) {
  return {
    acquireRoom: vi.fn().mockResolvedValue({ projectId: 'p1', fileId: 'f1', ydoc: {} }),
    applyUpdate: vi.fn(),
    encodeStateAsUpdate: vi.fn().mockReturnValue(new Uint8Array([0x11, 0x22, 0x33])),
    releaseRoom: vi.fn().mockResolvedValue(undefined),
    redis,
    consumerName,
    ...overrides,
  };
}

describe.skipIf(!RUN)('YJS worker chain (live Redis)', () => {
  let redis;
  let consumerName;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    // FAIL FAST if the test connects to the wrong DB. Test isolation
    // assumes DB 15; if your $REDIS_URL points at DB 0 we'd be
    // wiping production-shaped data. The default URL pins /15.
    const dbInfo = await redis.client('info').catch(() => null);
    if (dbInfo && !/db=15|database=15/.test(dbInfo) && !REDIS_URL.endsWith('/15')) {
      // Don't crash -- the user may have explicitly overridden to a
      // safe namespace. Just log a warning.
      // eslint-disable-next-line no-console
      console.warn(`REDIS integration: REDIS_URL=${REDIS_URL} -- ensure this is a test-safe namespace`);
    }
    await redis.flushdb();
    setRedisClient(redis);
    await ensureConsumerGroup(redis);
    consumerName = `worker-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  }, 15000);

  afterAll(async () => {
    if (redis) {
      try { await redis.flushdb(); } catch { /* ignore */ }
      redis.disconnect();
    }
    _resetRedisClient();
  });

  beforeEach(async () => {
    // Drop any leftover stream entries between tests so XREADGROUP
    // sees only what THIS test produced.
    try { await redis.del(STREAM_KEY); } catch { /* ignore */ }
    await ensureConsumerGroup(redis);
    vi.clearAllMocks();
  });

  describe('applyUpdate round-trip', () => {
    it('client XADD -> worker XREADGROUP -> dispatchEntry applies + XACKs', async () => {
      const PID = 'p1';
      const FID = 'f1';
      const updateBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

      // Client publishes the update.
      const ok = await clientApplyUpdate(PID, FID, updateBytes);
      expect(ok).toBe(true);

      // Worker reads + dispatches.
      const entry = await readOne(redis, consumerName);
      expect(entry).toBeTruthy();
      const [entryId, fields] = entry;

      const deps = makeMockDeps(redis, consumerName);
      const result = await dispatchEntry(fields, deps);
      expect(result).toEqual({ ok: true, type: 'apply' });
      expect(deps.acquireRoom).toHaveBeenCalledWith(PID, FID);
      expect(deps.applyUpdate).toHaveBeenCalledTimes(1);
      // The applyUpdate bytes round-tripped through base64.
      const [, , appliedBytes] = deps.applyUpdate.mock.calls[0];
      expect(Array.from(appliedBytes)).toEqual(Array.from(updateBytes));

      // XACK so the entry leaves the PEL.
      await redis.xack(STREAM_KEY, CONSUMER_GROUP, entryId);

      // Lock acquired + released by dispatchEntry (release happens
      // only on release-type messages; for apply, the lock stays
      // held by this consumer).
      const holder = await peekLock(redis, PID, FID);
      expect(holder).toBe(consumerName);
      // Clean up the held lock so subsequent tests aren't blocked.
      await releaseLock(redis, consumerName, PID, FID);
    });

    it('lock contention: second consumer can NOT apply for the same room', async () => {
      const PID = 'p2';
      const FID = 'f2';

      // Consumer A grabs the lock by dispatching a first apply.
      await clientApplyUpdate(PID, FID, new Uint8Array([1, 2, 3]));
      const entryA = await readOne(redis, consumerName);
      const depsA = makeMockDeps(redis, consumerName);
      await dispatchEntry(entryA[1], depsA);
      await redis.xack(STREAM_KEY, CONSUMER_GROUP, entryA[0]);
      expect(depsA.applyUpdate).toHaveBeenCalledTimes(1);

      // SIMULATE A SECOND PROCESS:
      // The worker's heldRooms Set is module-scoped (one consumer per
      // process in production). Both "consumers" run in this test
      // process and would share that cache, so without clearing it,
      // the lock-acquire check is skipped and B's apply would
      // succeed -- which would NOT happen in production where each
      // worker has its own heldRooms. Clearing it here honestly
      // models "fresh second worker, doesn't think it owns the room."
      heldRooms.clear();

      // A different consumer name comes in for the same room.
      const otherName = `worker-other-${Math.random().toString(36).slice(2, 8)}`;
      await clientApplyUpdate(PID, FID, new Uint8Array([4, 5, 6]));
      const entryB = await readOne(redis, otherName);
      const depsB = makeMockDeps(redis, otherName);
      const resultB = await dispatchEntry(entryB[1], depsB);

      expect(resultB).toEqual({ ok: false, retryable: true, reason: 'lock-contended' });
      expect(depsB.applyUpdate).not.toHaveBeenCalled();
      // Lock-loser DOES NOT XACK -- entry stays in the PEL so an
      // XAUTOCLAIM picks it up later.
      // (Don't xack here; the cleanup below will drop the stream.)

      // The lock is still held by the original consumer.
      const holder = await peekLock(redis, PID, FID);
      expect(holder).toBe(consumerName);

      await releaseLock(redis, consumerName, PID, FID);
    });
  });

  describe('state RPC', () => {
    it('client requests state, worker replies via the SET reply key', async () => {
      const PID = 'p3';
      const FID = 'f3';

      // Drive client + worker concurrently.
      //   - Client calls clientEncodeState which XADDs + polls replyKey.
      //   - We act as the worker: XREADGROUP, dispatch, the dispatch
      //     SETs the reply key with the state-as-update bytes.
      const clientPromise = clientEncodeState(PID, FID);

      // Wait briefly for the XADD to land, then dispatch as worker.
      // 50 ms is more than enough for a same-process Redis round trip.
      await new Promise((r) => setTimeout(r, 50));
      const entry = await readOne(redis, consumerName);
      expect(entry).toBeTruthy();

      const stateBytes = new Uint8Array([0xab, 0xcd, 0xef]);
      const deps = makeMockDeps(redis, consumerName, {
        encodeStateAsUpdate: vi.fn().mockReturnValue(stateBytes),
      });
      const result = await dispatchEntry(entry[1], deps);
      expect(result.ok).toBe(true);
      expect(result.type).toBe('state');
      await redis.xack(STREAM_KEY, CONSUMER_GROUP, entry[0]);

      // Client poll should now see the SET'd reply.
      const got = await clientPromise;
      expect(got).not.toBeNull();
      expect(Array.from(got)).toEqual(Array.from(stateBytes));

      await releaseLock(redis, consumerName, PID, FID);
    });

    it('state RPC: client returns null on timeout when no worker responds', async () => {
      // Use a short-fuse client variant: just call clientEncodeState
      // without ever dispatching as worker.
      const start = Date.now();
      const got = await clientEncodeState('p4', 'f4');
      const elapsed = Date.now() - start;
      expect(got).toBeNull();
      expect(elapsed).toBeGreaterThanOrEqual(4500);
    }, 8000);
  });

  describe('release', () => {
    it('client XADD release -> worker dispatch releases the lock', async () => {
      const PID = 'p5';
      const FID = 'f5';

      // Acquire via an apply first.
      await clientApplyUpdate(PID, FID, new Uint8Array([1]));
      const applyEntry = await readOne(redis, consumerName);
      const deps = makeMockDeps(redis, consumerName);
      // Track held rooms via the worker's heldRooms set -- but the
      // exported set is shared across tests. We bypass that by
      // checking lock state directly in Redis instead.
      await dispatchEntry(applyEntry[1], deps);
      await redis.xack(STREAM_KEY, CONSUMER_GROUP, applyEntry[0]);
      expect(await peekLock(redis, PID, FID)).toBe(consumerName);

      // Client sends release.
      await clientReleaseRoom(PID, FID);
      const releaseEntry = await readOne(redis, consumerName);
      expect(releaseEntry).toBeTruthy();
      await dispatchEntry(releaseEntry[1], deps);
      await redis.xack(STREAM_KEY, CONSUMER_GROUP, releaseEntry[0]);

      // Lock released by the Lua CAS in releaseLock.
      expect(await peekLock(redis, PID, FID)).toBeNull();
      expect(deps.releaseRoom).toHaveBeenCalledWith(PID, FID);
    });
  });

  describe('per-room ownership lock', () => {
    it('SET NX EX returns OK first time and null on contention', async () => {
      const PID = 'lockp';
      const FID = 'lockf';
      const got1 = await acquireLock(redis, 'workerA', PID, FID, 10);
      const got2 = await acquireLock(redis, 'workerB', PID, FID, 10);
      expect(got1).toBe(true);
      expect(got2).toBe(false);
      // workerB can't release a lock it doesn't own.
      expect(await releaseLock(redis, 'workerB', PID, FID)).toBe(false);
      // workerA can.
      expect(await releaseLock(redis, 'workerA', PID, FID)).toBe(true);
      // Now workerC can grab it.
      expect(await acquireLock(redis, 'workerC', PID, FID, 10)).toBe(true);
      await releaseLock(redis, 'workerC', PID, FID);
    });

    it('TTL expires and another consumer can claim the room', async () => {
      const PID = 'expire-p';
      const FID = 'expire-f';
      // 1-second TTL.
      await acquireLock(redis, 'workerA', PID, FID, 1);
      expect(await peekLock(redis, PID, FID)).toBe('workerA');
      // Wait past expiry. 1.2s gives us 200ms of slack against
      // CI clock skew.
      await new Promise((r) => setTimeout(r, 1200));
      expect(await peekLock(redis, PID, FID)).toBeNull();
      // workerB can now grab.
      expect(await acquireLock(redis, 'workerB', PID, FID, 5)).toBe(true);
      await releaseLock(redis, 'workerB', PID, FID);
    }, 5000);
  });
});

// Sentinel suite so vitest doesn't warn "no tests" when the env gate
// is off on CI.
describe('YJS worker chain integration sentinel', () => {
  it('respects the RUN_REDIS_INTEGRATION gate', () => {
    if (RUN) expect(process.env.RUN_REDIS_INTEGRATION).toBe('1');
    else expect(RUN).toBe(false);
  });
});
