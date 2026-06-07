// YJS-WORKER-SPLIT phase 1 -- standalone Y.Doc worker process.
//
// Run with:
//
//   node --env-file=.env server/yjsWorker.js
//
// Subscribes to the `flowtex:yjs:updates` Redis Stream and dispatches
// each entry to the in-process room logic from `services/yjsRoom.js`.
// Phase 1 does NOT yet implement ownership locks: any worker process
// receiving a message applies it. This is correct for a single
// worker, and the test plan covers it; multi-worker ownership lands
// in phase 2 alongside the consumer-group plumbing.
//
// Persistence reuses the existing PG path. Snapshots fire on the
// same debounce as before; the worker calls them via the same
// internal function the web tier used to call.
//
// Graceful shutdown:
//   - SIGTERM / SIGINT: stop reading the stream, flush snapshots
//     for every room currently held, exit 0.
//   - Snapshot flush happens via releaseRoom on each held room.

import Redis from 'ioredis';
import logger from './logger.js';
import {
  acquireRoom,
  applyUpdate,
  encodeStateAsUpdate,
  releaseRoom,
  _peekRoomCount,
} from './services/yjsRoom.js';

const STREAM_KEY = 'flowtex:yjs:updates';
const CONSUMER_NAME = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const BLOCK_MS = 5000;
const STATE_REPLY_TTL_SEC = 10;

// Set of (projectId, fileId) the worker has acquired for the run.
// Tracked so graceful shutdown can release each one (which triggers
// the final-snapshot flush in yjsRoom).
const heldRooms = new Set();
const keyFor = (p, f) => `${p}:${f}`;

let stopRequested = false;
let redis;

/**
 * Dispatch one Stream entry. Each entry is a flat array of [field,
 * value, field, value, ...] -- this normalises it into an object.
 * Pure dispatch so unit tests can exercise it without Redis.
 */
export async function dispatchEntry(rawFields, deps = { acquireRoom, applyUpdate, encodeStateAsUpdate, releaseRoom, redis }) {
  const fields = {};
  for (let i = 0; i < rawFields.length; i += 2) fields[rawFields[i]] = rawFields[i + 1];

  const { type, projectId, fileId } = fields;
  if (!type || !projectId || !fileId) {
    logger.warn({ fields }, 'yjsWorker: malformed entry, missing required fields');
    return { ok: false, reason: 'missing-required-fields' };
  }

  switch (type) {
    case 'apply': {
      if (typeof fields.update !== 'string' || fields.update.length === 0) {
        return { ok: false, reason: 'empty-update' };
      }
      if (!heldRooms.has(keyFor(projectId, fileId))) {
        const room = await deps.acquireRoom(projectId, fileId);
        if (!room) return { ok: false, reason: 'file-missing' };
        heldRooms.add(keyFor(projectId, fileId));
      }
      const bytes = new Uint8Array(Buffer.from(fields.update, 'base64'));
      deps.applyUpdate(projectId, fileId, bytes);
      return { ok: true, type: 'apply' };
    }
    case 'state': {
      if (typeof fields.replyTo !== 'string' || !fields.replyTo.startsWith('flowtex:yjs:state-reply:')) {
        return { ok: false, reason: 'bad-replyTo' };
      }
      if (!heldRooms.has(keyFor(projectId, fileId))) {
        const room = await deps.acquireRoom(projectId, fileId);
        if (!room) return { ok: false, reason: 'file-missing' };
        heldRooms.add(keyFor(projectId, fileId));
      }
      const stateBytes = deps.encodeStateAsUpdate(projectId, fileId);
      if (!stateBytes) return { ok: false, reason: 'no-state' };
      const b64 = Buffer.from(stateBytes).toString('base64');
      if (deps.redis) {
        try {
          await deps.redis.set(fields.replyTo, b64, 'EX', STATE_REPLY_TTL_SEC);
        } catch (err) {
          logger.warn({ err, replyTo: fields.replyTo }, 'yjsWorker: state reply SET failed');
          return { ok: false, reason: 'reply-set-failed' };
        }
      }
      return { ok: true, type: 'state', size: b64.length };
    }
    case 'release': {
      if (!heldRooms.has(keyFor(projectId, fileId))) return { ok: true, type: 'release', noop: true };
      heldRooms.delete(keyFor(projectId, fileId));
      await deps.releaseRoom(projectId, fileId);
      return { ok: true, type: 'release' };
    }
    default:
      logger.warn({ type }, 'yjsWorker: unknown entry type');
      return { ok: false, reason: 'unknown-type' };
  }
}

async function readStreamLoop() {
  let lastId = '0';
  while (!stopRequested) {
    let res;
    try {
      // Block up to BLOCK_MS waiting for new entries past lastId. On
      // first iteration we read from the very beginning so a worker
      // that restarts replays any in-flight entries the previous one
      // didn't ack. Phase 2 (consumer groups) makes this exactly-once;
      // phase 1 is at-least-once and idempotent because Y.js applies
      // are commutative.
      res = await redis.xread('BLOCK', BLOCK_MS, 'STREAMS', STREAM_KEY, lastId);
    } catch (err) {
      logger.warn({ err }, 'yjsWorker: XREAD failed, backing off');
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (!res) continue; // BLOCK timeout, no new entries

    for (const [, entries] of res) {
      for (const [id, fields] of entries) {
        lastId = id;
        try {
          await dispatchEntry(fields);
        } catch (err) {
          logger.warn({ err, entryId: id }, 'yjsWorker: dispatch threw');
        }
      }
    }
  }
}

async function shutdown(signal) {
  if (stopRequested) return;
  stopRequested = true;
  logger.info({ signal, heldRooms: heldRooms.size }, 'yjsWorker: shutdown initiated');
  // Release every held room so each one snapshots to PG.
  for (const key of heldRooms) {
    const [projectId, fileId] = key.split(':');
    try { await releaseRoom(projectId, fileId); } catch (err) {
      logger.warn({ err, key }, 'yjsWorker: release-on-shutdown failed');
    }
  }
  heldRooms.clear();
  if (redis) {
    try { await redis.quit(); } catch { /* ignore */ }
  }
  logger.info({ remainingRooms: _peekRoomCount() }, 'yjsWorker: shutdown complete');
  process.exit(0);
}

function isMainEntrypoint() {
  // ESM: process.argv[1] is the script path; compare against the
  // module's URL to detect direct invocation.
  return typeof process !== 'undefined' && process.argv?.[1]?.endsWith('yjsWorker.js');
}

if (isMainEntrypoint()) {
  if (!process.env.REDIS_URL) {
    console.error('yjsWorker: REDIS_URL is required.');
    process.exit(2);
  }
  redis = new Redis(process.env.REDIS_URL);
  redis.on('error', (err) => logger.error({ err }, 'yjsWorker: Redis error'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  logger.info({ consumer: CONSUMER_NAME }, 'yjsWorker: starting');
  readStreamLoop().catch((err) => {
    logger.error({ err }, 'yjsWorker: stream loop crashed');
    process.exit(1);
  });
}

export { CONSUMER_NAME, heldRooms };
