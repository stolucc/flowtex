// YJS-WORKER-SPLIT phase 2 -- per-room ownership locks.
//
// A consumer group already guarantees that each Stream entry goes to
// exactly one worker. That's not enough on its own -- two different
// entries for the same (projectId, fileId) might still land at two
// different workers, and applying them in parallel would produce
// divergent server-side Y.Docs.
//
// The fix is a lock per room. The worker that wins SET NX EX is the
// sole applier; the worker that loses doesn't XACK the entry, leaving
// it in the consumer group's pending entries list (PEL) so an
// XAUTOCLAIM after a short timeout hands it to the lock-holder (or
// whoever is willing to take it next).
//
// Wire shape:
//
//   Key       flowtex:yjs:lock:<projectId>:<fileId>
//   Value     <consumerId>            (the lock-holder's identity)
//   Acquire   SET key consumerId NX EX <ttlSec>
//   Renew     SET key consumerId XX EX <ttlSec> (idempotent re-arm)
//   Release   EVAL ... (Lua compare-and-DEL)
//
// Release is a Lua script (atomic CAS) so a worker that lost the
// lock and then dies long enough for the lock to expire and be
// re-acquired by another worker can't unlink the new owner's key on
// its slow path back.
//
// Renewal is a "double-take" SET XX so the lock-holder rejects
// stale TTL races: if our key was already deleted (e.g. the worker
// went unresponsive long enough for TTL to expire), the XX rejects
// and we know we lost ownership without ever DELing someone else's
// lock.

const LOCK_PREFIX = 'flowtex:yjs:lock';
const DEFAULT_TTL_SEC = 30;

// Lua: DEL if and only if the value matches the supplied consumerId.
// Returns 1 on successful release, 0 if the lock was held by someone
// else (or expired). Atomic so the GET-and-DEL pair is safe under
// contention.
const RELEASE_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

export function lockKey(projectId, fileId) {
  return `${LOCK_PREFIX}:${projectId}:${fileId}`;
}

/**
 * Attempt to acquire the lock for (projectId, fileId).
 *
 * @param {Redis} redis
 * @param {string} consumerId    this worker's identity
 * @param {string} projectId
 * @param {string} fileId
 * @param {number} [ttlSec=30]
 * @returns {Promise<boolean>} true iff we are now the lock-holder
 */
export async function acquireLock(redis, consumerId, projectId, fileId, ttlSec = DEFAULT_TTL_SEC) {
  if (!redis) return false;
  try {
    const r = await redis.set(lockKey(projectId, fileId), consumerId, 'EX', ttlSec, 'NX');
    return r === 'OK';
  } catch {
    return false;
  }
}

/**
 * Re-arm the TTL on a lock we already hold. SET XX so an
 * expired-and-someone-else-took-it lock doesn't get clobbered.
 *
 * Returns true iff the renewal succeeded (we still own it).
 */
export async function renewLock(redis, consumerId, projectId, fileId, ttlSec = DEFAULT_TTL_SEC) {
  if (!redis) return false;
  try {
    const r = await redis.set(lockKey(projectId, fileId), consumerId, 'EX', ttlSec, 'XX');
    return r === 'OK';
  } catch {
    return false;
  }
}

/**
 * Release the lock atomically (only if the current value matches
 * our consumerId). Safe to call on a lock we never held -- returns
 * false in that case.
 */
export async function releaseLock(redis, consumerId, projectId, fileId) {
  if (!redis) return false;
  try {
    const r = await redis.eval(RELEASE_LUA, 1, lockKey(projectId, fileId), consumerId);
    return r === 1 || r === '1';
  } catch {
    return false;
  }
}

/**
 * Check the current lock holder without modifying anything. Returns
 * the consumerId string, or null if no lock is held.
 */
export async function peekLock(redis, projectId, fileId) {
  if (!redis) return null;
  try {
    return await redis.get(lockKey(projectId, fileId));
  } catch {
    return null;
  }
}

export const _testing = { LOCK_PREFIX, DEFAULT_TTL_SEC, RELEASE_LUA };
