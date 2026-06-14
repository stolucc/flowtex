// @ts-check
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
//   Renew     EVAL ... (Lua compare-and-SET: re-arm only if we own it)
//   Release   EVAL ... (Lua compare-and-DEL)
//
// Release and renew are both Lua compare-and-set scripts so they act
// only on a lock THIS worker still owns. A plain `SET ... XX` for
// renewal was a bug: XX checks key existence, not ownership, so it
// would happily overwrite (steal) another worker's lock value and
// re-arm its TTL -- the opposite of the intended "reject if not ours".

import logger from '../logger.js';

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

// Lua: re-arm the TTL ONLY if we still own the lock (value matches).
// Returns 1 on successful renew, 0 if the lock vanished (TTL expired)
// or is held by someone else. Atomic compare-and-set so we never
// clobber another worker's lock value -- a plain `SET ... XX` would
// overwrite the holder's id because XX checks existence, not ownership.
const RENEW_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return 1
else
  return 0
end
`;

/** @typedef {import('ioredis').Redis} Redis */

/**
 * @param {string} projectId
 * @param {string} fileId
 * @returns {string}
 */
export function lockKey(projectId, fileId) {
  return `${LOCK_PREFIX}:${projectId}:${fileId}`;
}

/**
 * Attempt to acquire the lock for (projectId, fileId).
 *
 * @param {Redis | undefined} redis
 * @param {string} consumerId    this worker's identity
 * @param {string} projectId
 * @param {string} fileId
 * @param {number} [ttlSec=30]
 * @returns {Promise<boolean>} true iff we are now the lock-holder
 */
export async function acquireLock(redis, consumerId, projectId, fileId, ttlSec = DEFAULT_TTL_SEC) {
  // Null-redis is a programming error (yjsWorker exits at boot if
  // REDIS_URL is unset, so a null reaching here means a wiring bug).
  // Throw rather than silently returning false -- the old behavior
  // was equivalent to the catch-block fallback below and mutation
  // testing flagged it as unobservable. Failing loud here also
  // prevents a partial-rollout where the lock module silently
  // becomes a no-op on a misconfigured deploy.
  if (!redis) throw new Error('yjsLocks.acquireLock: redis client is required');
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
 *
 * @param {Redis | undefined} redis
 * @param {string} consumerId
 * @param {string} projectId
 * @param {string} fileId
 * @param {number} [ttlSec]
 * @returns {Promise<boolean>}
 */
export async function renewLock(redis, consumerId, projectId, fileId, ttlSec = DEFAULT_TTL_SEC) {
  if (!redis) throw new Error('yjsLocks.renewLock: redis client is required');
  try {
    const r = await redis.eval(RENEW_LUA, 1, lockKey(projectId, fileId), consumerId, String(ttlSec));
    return r === 1 || r === '1';
  } catch (err) {
    // A transient Redis error (blip, brief disconnect) is NOT proof we
    // lost the lock -- the TTL almost certainly still has many seconds
    // left (renew interval << TTL). Returning false here would make the
    // worker needlessly DROP and re-acquire the room, which re-seeds its
    // Y.Doc and can fork live collaborators. Assume we still hold it;
    // the next renewal tick re-checks authoritatively.
    logger.warn({ err, projectId, fileId }, 'yjsLocks.renewLock: transient error, assuming still held');
    return true;
  }
}

/**
 * Release the lock atomically (only if the current value matches
 * our consumerId). Safe to call on a lock we never held -- returns
 * false in that case.
 *
 * @param {Redis | undefined} redis
 * @param {string} consumerId
 * @param {string} projectId
 * @param {string} fileId
 * @returns {Promise<boolean>}
 */
export async function releaseLock(redis, consumerId, projectId, fileId) {
  if (!redis) throw new Error('yjsLocks.releaseLock: redis client is required');
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
 *
 * @param {Redis | undefined} redis
 * @param {string} projectId
 * @param {string} fileId
 * @returns {Promise<string | null>}
 */
export async function peekLock(redis, projectId, fileId) {
  if (!redis) throw new Error('yjsLocks.peekLock: redis client is required');
  try {
    return await redis.get(lockKey(projectId, fileId));
  } catch {
    return null;
  }
}

export const _testing = { LOCK_PREFIX, DEFAULT_TTL_SEC, RELEASE_LUA, RENEW_LUA };
