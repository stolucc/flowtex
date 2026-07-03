// @ts-check
// Per-BOX LaTeX compile concurrency limiter.
//
// LaTeX runs as a forked child process (CPU-heavy, bursty), so on a
// multi-instance host the N web processes must SHARE one compile budget
// sized to that host's cores — otherwise each process independently
// allows MAX_CONCURRENT_COMPILES and the box oversubscribes (4 instances
// x 10 = 40 concurrent latexmk on a 6-core box).
//
// The budget is PER HOST, not global: the Redis key is namespaced by the
// host id (os.hostname by default), so all instances on the same box
// converge on one limit while different hosts stay independent — add a
// box, it gets its own budget matching its own cores.
//
// Coordination is via Redis (already present in cluster mode). Without
// REDIS_URL (a single-instance deploy) it degrades to an in-process
// counter — which on a one-process box IS per-box.
//
// Self-healing: slots are a ZSET scored by acquire time; each acquire
// first prunes entries older than SLOT_TTL_MS, so a crashed instance or a
// missed release can't leak the budget permanently.

import os from 'node:os';
import Redis from 'ioredis';
import logger from '../logger.js';

const LIMIT = Math.max(1, parseInt(process.env.MAX_CONCURRENT_COMPILES || '10', 10));
const HOST_ID = process.env.FLOWTEX_HOST_ID || os.hostname() || 'host';
const KEY = `flowtex:compile:slots:${HOST_ID}`;
// A held slot older than this is presumed dead and pruned. The compile
// wall timeout is <= a couple of minutes; 10 min is generous headroom.
const SLOT_TTL_MS = Math.max(60000, parseInt(process.env.COMPILE_SLOT_TTL_MS || '600000', 10));

// Atomic: prune stale (score < now-ttl), count, add-if-under-limit.
// Returns 1 if the slot was acquired, 0 if the box is at its limit.
const ACQUIRE_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local n = redis.call('ZCARD', KEYS[1])
if n >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
return 1
`;

/** @type {import('ioredis').Redis | null} */
let redis = null;
if (process.env.REDIS_URL) {
  try {
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
    redis.on('error', (err) => logger.warn({ err }, 'compileSemaphore: redis error'));
  } catch (err) {
    logger.warn({ err }, 'compileSemaphore: redis init failed — using in-process compile limit');
    redis = null;
  }
}

let localActive = 0; // in-process fallback (single-instance box)

/**
 * Try to reserve a compile slot for this box. Returns false when the box
 * is already at MAX_CONCURRENT_COMPILES.
 * @param {string} id  unique per-compile id (released with releaseCompileSlot)
 * @returns {Promise<boolean>}
 */
export async function acquireCompileSlot(id) {
  if (redis) {
    try {
      const now = Date.now();
      const r = await redis.eval(ACQUIRE_LUA, 1, KEY, String(now - SLOT_TTL_MS), String(LIMIT), String(now), id);
      return r === 1 || r === '1';
    } catch (err) {
      // Fail-open: a Redis blip must not block all compiles. Each compile
      // is still individually bounded by prlimit (CPU-seconds + memory),
      // so the worst case is brief CPU contention, not a runaway.
      logger.warn({ err }, 'compileSemaphore: acquire failed, allowing (fail-open)');
      return true;
    }
  }
  if (localActive >= LIMIT) return false;
  localActive += 1;
  return true;
}

/**
 * Release a previously acquired slot. Best-effort — a missed release is
 * reclaimed by the TTL prune on the next acquire.
 * @param {string} id
 */
export async function releaseCompileSlot(id) {
  if (redis) {
    try { await redis.zrem(KEY, id); } catch (err) {
      logger.warn({ err }, 'compileSemaphore: release failed (slot will TTL-prune)');
    }
    return;
  }
  localActive = Math.max(0, localActive - 1);
}

export const _testing = { KEY, LIMIT, SLOT_TTL_MS, ACQUIRE_LUA, HOST_ID };
