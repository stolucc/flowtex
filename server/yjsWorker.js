// YJS-WORKER-SPLIT phase 2 -- standalone Y.Doc worker process with
// consumer groups + per-room ownership locks.
//
// Run with:
//
//   node --env-file=.env server/yjsWorker.js
//
// Reads the `flowtex:yjs:updates` Stream via a consumer group so
// each entry is delivered to exactly one worker. For every entry we:
//
//   1. Try to acquire the per-room lock (flowtex:yjs:lock:<p>:<f>).
//   2. If we win, dispatch the entry, XACK, and renew the lock on a
//      timer so a long-lived room stays with the same worker.
//   3. If we lose, DO NOT XACK -- the entry stays in the consumer
//      group's pending list; an XAUTOCLAIM after the visibility
//      timeout hands it to whoever ends up free.
//
// Persistence reuses the existing PG path. Snapshots fire on the
// same debounce as before.
//
// Graceful shutdown:
//   - SIGTERM / SIGINT: stop reading the stream, release every lock
//     atomically (Lua CAS so we never DEL someone else's), call
//     releaseRoom on each (which flushes the final snapshot), then
//     exit 0.

import Redis from 'ioredis';
import logger from './logger.js';
import { setDefaultSurface } from './services/metrics.js';
import {
  acquireRoom,
  applyUpdate,
  encodeStateAsUpdate,
  releaseRoom,
  _peekRoomCount,
} from './services/yjsRoom.js';
import { acquireLock, renewLock, releaseLock } from './services/yjsLocks.js';

const STREAM_KEY = 'flowtex:yjs:updates';
const CONSUMER_GROUP = 'flowtex-yjs-workers';
const CONSUMER_NAME = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const BLOCK_MS = 5000;
const STATE_REPLY_TTL_SEC = 10;
const LOCK_TTL_SEC = 30;
const LOCK_RENEW_INTERVAL_MS = 10000;
// Reclaim entries from dead consumers after they've been pending for
// this long. Should be > BLOCK_MS + a healthy margin so a worker
// that's mid-XREADGROUP doesn't get its entries stolen.
const PEL_RECLAIM_AFTER_MS = 30000;
const PEL_RECLAIM_INTERVAL_MS = 15000;

const heldRooms = new Set();
const keyFor = (p, f) => `${p}:${f}`;

let stopRequested = false;
let redis;
let renewTimer = null;
let reclaimTimer = null;

// ── Consumer-group setup ─────────────────────────────────────────────────

async function ensureConsumerGroup(client) {
  try {
    // MKSTREAM creates the stream if it doesn't exist yet so a
    // worker booted before any web write doesn't get BUSYGROUP /
    // NOGROUP confusion.
    await client.xgroup('CREATE', STREAM_KEY, CONSUMER_GROUP, '$', 'MKSTREAM');
    logger.info({ stream: STREAM_KEY, group: CONSUMER_GROUP }, 'yjsWorker: consumer group created');
  } catch (err) {
    if (err && /BUSYGROUP/.test(err.message || '')) {
      // Group already exists -- expected on every boot after the
      // first.
      logger.info({ stream: STREAM_KEY, group: CONSUMER_GROUP }, 'yjsWorker: consumer group already exists');
    } else {
      throw err;
    }
  }
}

// ── Pure dispatch ────────────────────────────────────────────────────────

/**
 * Dispatch one Stream entry. Pure function (deps injected) so unit
 * tests can exercise routing without Redis. Returns:
 *
 *   { ok: true,  ... }        applied, caller should XACK
 *   { ok: false, retryable }  caller should NOT XACK if retryable;
 *                             otherwise XACK (poison-pill entry).
 */
export async function dispatchEntry(rawFields, deps = { acquireRoom, applyUpdate, encodeStateAsUpdate, releaseRoom, redis, consumerName: CONSUMER_NAME }) {
  const fields = {};
  for (let i = 0; i < rawFields.length; i += 2) fields[rawFields[i]] = rawFields[i + 1];

  const { type, projectId, fileId } = fields;
  if (!type || !projectId || !fileId) {
    logger.warn({ fields }, 'yjsWorker: malformed entry');
    return { ok: false, retryable: false, reason: 'missing-required-fields' };
  }

  // Lock check happens here for apply / state (anything that mutates
  // or reads the canonical Y.Doc). release is metadata-only and
  // intentionally lockless.
  if (type === 'apply' || type === 'state') {
    if (!heldRooms.has(keyFor(projectId, fileId))) {
      const acquired = await acquireLock(
        deps.redis,
        deps.consumerName,
        projectId,
        fileId,
        LOCK_TTL_SEC,
      );
      if (!acquired) {
        // Someone else owns this room. Leave the entry unacked so
        // an XAUTOCLAIM after PEL_RECLAIM_AFTER_MS hands it to the
        // current lock-holder.
        return { ok: false, retryable: true, reason: 'lock-contended' };
      }
    }
  }

  switch (type) {
    case 'apply': {
      if (typeof fields.update !== 'string' || fields.update.length === 0) {
        return { ok: false, retryable: false, reason: 'empty-update' };
      }
      if (!heldRooms.has(keyFor(projectId, fileId))) {
        const room = await deps.acquireRoom(projectId, fileId);
        if (!room) {
          // We hold the lock but the file row is gone -- release the
          // lock so a future creation can take it.
          await releaseLock(deps.redis, deps.consumerName, projectId, fileId);
          return { ok: false, retryable: false, reason: 'file-missing' };
        }
        heldRooms.add(keyFor(projectId, fileId));
      }
      const bytes = new Uint8Array(Buffer.from(fields.update, 'base64'));
      deps.applyUpdate(projectId, fileId, bytes);
      return { ok: true, type: 'apply' };
    }
    case 'state': {
      if (typeof fields.replyTo !== 'string' || !fields.replyTo.startsWith('flowtex:yjs:state-reply:')) {
        return { ok: false, retryable: false, reason: 'bad-replyTo' };
      }
      if (!heldRooms.has(keyFor(projectId, fileId))) {
        const room = await deps.acquireRoom(projectId, fileId);
        if (!room) {
          await releaseLock(deps.redis, deps.consumerName, projectId, fileId);
          return { ok: false, retryable: false, reason: 'file-missing' };
        }
        heldRooms.add(keyFor(projectId, fileId));
      }
      const stateBytes = deps.encodeStateAsUpdate(projectId, fileId);
      if (!stateBytes) return { ok: false, retryable: false, reason: 'no-state' };
      const b64 = Buffer.from(stateBytes).toString('base64');
      if (deps.redis) {
        try {
          await deps.redis.set(fields.replyTo, b64, 'EX', STATE_REPLY_TTL_SEC);
        } catch (err) {
          logger.warn({ err, replyTo: fields.replyTo }, 'yjsWorker: state reply SET failed');
          return { ok: false, retryable: true, reason: 'reply-set-failed' };
        }
      }
      return { ok: true, type: 'state', size: b64.length };
    }
    case 'release': {
      if (!heldRooms.has(keyFor(projectId, fileId))) {
        return { ok: true, type: 'release', noop: true };
      }
      heldRooms.delete(keyFor(projectId, fileId));
      await deps.releaseRoom(projectId, fileId);
      // Also release the ownership lock so another worker can take
      // over on the next apply.
      await releaseLock(deps.redis, deps.consumerName, projectId, fileId);
      return { ok: true, type: 'release' };
    }
    default:
      logger.warn({ type }, 'yjsWorker: unknown entry type');
      return { ok: false, retryable: false, reason: 'unknown-type' };
  }
}

// ── Read loop ────────────────────────────────────────────────────────────

async function readStreamLoop() {
  await ensureConsumerGroup(redis);
  while (!stopRequested) {
    let res;
    try {
      // ">" tells Redis "give me entries delivered after my last
      // XREADGROUP". That's the canonical consumer-group call.
      res = await redis.xreadgroup(
        'GROUP', CONSUMER_GROUP, CONSUMER_NAME,
        'BLOCK', BLOCK_MS,
        'COUNT', 32,
        'STREAMS', STREAM_KEY, '>',
      );
    } catch (err) {
      logger.warn({ err }, 'yjsWorker: XREADGROUP failed, backing off');
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (!res) continue;

    for (const [, entries] of res) {
      for (const [id, fields] of entries) {
        let result;
        try {
          result = await dispatchEntry(fields, {
            acquireRoom, applyUpdate, encodeStateAsUpdate, releaseRoom,
            redis, consumerName: CONSUMER_NAME,
          });
        } catch (err) {
          logger.warn({ err, entryId: id }, 'yjsWorker: dispatch threw');
          result = { ok: false, retryable: false, reason: 'threw' };
        }
        // Only XACK when the entry was handled (or is a poison pill
        // that no retry will help). Lock-contended entries stay
        // pending; the PEL reclaimer below will hand them to whoever
        // currently holds the lock (or releases it later).
        if (result.ok || !result.retryable) {
          try {
            await redis.xack(STREAM_KEY, CONSUMER_GROUP, id);
          } catch (err) {
            logger.warn({ err, entryId: id }, 'yjsWorker: XACK failed');
          }
        }
      }
    }
  }
}

// ── PEL reclaimer ────────────────────────────────────────────────────────

/**
 * Periodically XAUTOCLAIM entries that have been pending in the
 * consumer group for too long (worker crash, network blip, etc.).
 * After claiming, dispatch them just like a freshly-delivered entry.
 *
 * Idempotent: claiming is per-consumer-group, and Y.js applies are
 * commutative even if the original worker already processed the
 * entry before crashing.
 */
async function reclaimStaleEntries() {
  if (!redis) return;
  let cursor = '0-0';
  while (true) {
    let res;
    try {
      // XAUTOCLAIM <key> <group> <consumer> <min-idle-time> <start>
      //   [COUNT n] [JUSTID]
      res = await redis.xautoclaim(
        STREAM_KEY, CONSUMER_GROUP, CONSUMER_NAME,
        PEL_RECLAIM_AFTER_MS, cursor,
        'COUNT', 32,
      );
    } catch (err) {
      if (err && /NOGROUP/.test(err.message || '')) {
        // Group was deleted between boots -- recreate and try again.
        await ensureConsumerGroup(redis).catch(() => { /* ignore */ });
      } else {
        logger.warn({ err }, 'yjsWorker: XAUTOCLAIM failed');
      }
      return;
    }
    // ioredis returns [nextCursor, entries, deletedIds?]; we only
    // need cursor + entries.
    const nextCursor = Array.isArray(res) ? res[0] : '0-0';
    const entries = Array.isArray(res) && res[1] ? res[1] : [];
    for (const [id, fields] of entries) {
      try {
        const result = await dispatchEntry(fields, {
          acquireRoom, applyUpdate, encodeStateAsUpdate, releaseRoom,
          redis, consumerName: CONSUMER_NAME,
        });
        if (result.ok || !result.retryable) {
          await redis.xack(STREAM_KEY, CONSUMER_GROUP, id);
        }
      } catch (err) {
        logger.warn({ err, entryId: id }, 'yjsWorker: reclaim dispatch threw');
      }
    }
    if (!entries.length || nextCursor === '0-0') break;
    cursor = nextCursor;
  }
}

// ── Lock renewal ─────────────────────────────────────────────────────────

async function renewHeldLocks() {
  if (!redis) return;
  const now = Date.now();
  for (const key of heldRooms) {
    const [projectId, fileId] = key.split(':');
    const ok = await renewLock(redis, CONSUMER_NAME, projectId, fileId, LOCK_TTL_SEC);
    if (!ok) {
      // We lost the lock (e.g. process was paused long enough for
      // TTL to expire and another worker to grab it). Drop the room
      // from heldRooms so the next entry for it re-acquires
      // cleanly. We do NOT releaseRoom here because that would
      // snapshot stale state on top of whoever's now writing.
      heldRooms.delete(key);
      logger.warn({ projectId, fileId, now }, 'yjsWorker: lost room lock during renewal');
    }
  }
}

// ── Shutdown ─────────────────────────────────────────────────────────────

async function shutdown(signal) {
  if (stopRequested) return;
  stopRequested = true;
  logger.info({ signal, heldRooms: heldRooms.size }, 'yjsWorker: shutdown initiated');
  if (renewTimer) clearInterval(renewTimer);
  if (reclaimTimer) clearInterval(reclaimTimer);

  // Snapshot every held room then release the ownership lock so
  // another worker can pick up immediately.
  const drained = [...heldRooms];
  heldRooms.clear();
  for (const key of drained) {
    const [projectId, fileId] = key.split(':');
    try { await releaseRoom(projectId, fileId); } catch (err) {
      logger.warn({ err, key }, 'yjsWorker: releaseRoom on shutdown failed');
    }
    try { await releaseLock(redis, CONSUMER_NAME, projectId, fileId); } catch (err) {
      logger.warn({ err, key }, 'yjsWorker: releaseLock on shutdown failed');
    }
  }
  if (redis) {
    try { await redis.quit(); } catch { /* ignore */ }
  }
  logger.info({ remainingRooms: _peekRoomCount() }, 'yjsWorker: shutdown complete');
  process.exit(0);
}

function isMainEntrypoint() {
  return typeof process !== 'undefined' && process.argv?.[1]?.endsWith('yjsWorker.js');
}

if (isMainEntrypoint()) {
  if (!process.env.REDIS_URL) {
    console.error('yjsWorker: REDIS_URL is required.');
    process.exit(2);
  }
  // Label every Y.Doc apply in this process as `surface=worker` so
  // the Prometheus dashboard can split worker-tier latency from
  // web-tier in-process latency in the same histogram.
  setDefaultSurface('worker');
  redis = new Redis(process.env.REDIS_URL);
  redis.on('error', (err) => logger.error({ err }, 'yjsWorker: Redis error'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  logger.info({ consumer: CONSUMER_NAME, group: CONSUMER_GROUP }, 'yjsWorker: starting');

  renewTimer = setInterval(() => {
    renewHeldLocks().catch((err) => logger.warn({ err }, 'yjsWorker: renew loop'));
  }, LOCK_RENEW_INTERVAL_MS);
  renewTimer.unref?.();

  reclaimTimer = setInterval(() => {
    reclaimStaleEntries().catch((err) => logger.warn({ err }, 'yjsWorker: reclaim loop'));
  }, PEL_RECLAIM_INTERVAL_MS);
  reclaimTimer.unref?.();

  readStreamLoop().catch((err) => {
    logger.error({ err }, 'yjsWorker: stream loop crashed');
    process.exit(1);
  });
}

export {
  CONSUMER_NAME,
  CONSUMER_GROUP,
  STREAM_KEY,
  LOCK_TTL_SEC,
  heldRooms,
  ensureConsumerGroup,
  reclaimStaleEntries,
  renewHeldLocks,
};
