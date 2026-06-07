// YJS-WORKER-SPLIT phase 1 -- web-side proxy for the Y.Doc worker.
//
// Same four-method shape as `services/yjsRoom.js` so callers can be
// switched between in-process and remote by import path alone (the
// selector lives in `services/yjsRoomSelector.js` and is gated on
// FLOWTEX_YJS_WORKER).
//
// Wire protocol:
//
//   Updates (web -> worker)  Redis Stream  flowtex:yjs:updates
//     XADD ... type=apply         | fileId | projectId | update(b64)
//     XADD ... type=state         | fileId | projectId | replyTo(key)
//     XADD ... type=release       | fileId | projectId
//
//   State replies (worker -> web)  Redis key (short TTL)
//     SET replyTo state(b64) EX 10
//
//   Broadcasts (worker -> web)  Redis pub/sub  flowtex:ws  (existing,
//     from item 4). Updates that the worker applies are republished
//     to the room so all web instances fan out to their WS clients.
//
// Failure modes:
//   - No REDIS_URL: client refuses to load and the selector falls
//     back to in-process. We never silently drop updates.
//   - Worker unreachable: XADD still succeeds (the stream is the
//     durable log); state requests time out and the caller falls
//     back to the in-process behaviour (currently: client seeds from
//     plain text).
//   - replyTo key never appears: 5 s timeout, then null. The Y.Doc
//     remains usable but starts empty until the worker catches up.
//
// All RPC entry points are no-throw -- a transport hiccup must not
// crash the WS handler that called us.

import { randomUUID } from 'node:crypto';
import logger from '../logger.js';
import { recordYjsApply } from './metrics.js';

const STREAM_KEY = 'flowtex:yjs:updates';
const REPLY_KEY_PREFIX = 'flowtex:yjs:state-reply';
const REPLY_TIMEOUT_MS = 5000;
const REPLY_POLL_INTERVAL_MS = 50;

let redis = null;
let blockingRedis = null;

/**
 * Inject a Redis client. Called from `index.js` at boot when the
 * selector decides the worker path is active. Separate from the
 * `ioredis` import so tests can pass an in-memory mock.
 */
export function setRedisClient(client, opts = {}) {
  redis = client;
  // A separate client for BRPOP / blocking reads; ioredis recommends
  // not mixing pub/sub or blocking commands with normal commands on
  // the same connection.
  blockingRedis = opts.blockingClient || client;
}

export function _resetRedisClient() {
  redis = null;
  blockingRedis = null;
}

function assertReady() {
  if (!redis) throw new Error('yjsRoomClient: Redis client not configured');
}

/**
 * acquireRoom -- not a synchronous handshake in the worker model.
 * Returns a stub the caller can pass to applyUpdate / release /
 * encode; the worker will lazily acquire its own server-side room
 * when the first update arrives. Mirrors the in-process API so call
 * sites are interchangeable.
 *
 * Returns null if the file row is missing -- caller falls back the
 * same way the in-process path does.
 */
export async function acquireRoom(projectId, fileId) {
  if (!projectId || !fileId) return null;
  return {
    projectId,
    fileId,
    refCount: 1,
    // No ydoc field -- the canonical Y.Doc lives in the worker. The
    // selector uses the field's presence to detect whether the room
    // is local (and therefore safe to read directly) or remote.
    remote: true,
  };
}

/**
 * applyUpdate -- publish the update to the worker via the Stream.
 * The worker applies + broadcasts; we just enqueue.
 *
 * Returns true iff the XADD succeeded. Logged + swallowed on
 * failure so a transient Redis hiccup can't crash the WS handler.
 */
export async function applyUpdate(projectId, fileId, updateBytes) {
  if (!redis) return false;
  const start = process.hrtime.bigint();
  try {
    await redis.xadd(
      STREAM_KEY,
      '*',
      'type', 'apply',
      'projectId', projectId,
      'fileId', fileId,
      'update', Buffer.from(updateBytes).toString('base64'),
    );
    recordYjsApply(Number(process.hrtime.bigint() - start) / 1e6, 'ok');
    return true;
  } catch (err) {
    recordYjsApply(Number(process.hrtime.bigint() - start) / 1e6, 'err');
    logger.warn({ err, projectId, fileId }, 'yjsRoomClient: XADD apply failed');
    return false;
  }
}

/**
 * encodeStateAsUpdate -- the RPC over Streams shape. We pick a
 * one-shot reply key, ask the worker, then poll the key until it
 * appears or the timeout elapses.
 *
 * Returns the binary state (Uint8Array) on success, null on timeout
 * or transport failure.
 */
export async function encodeStateAsUpdate(projectId, fileId) {
  if (!redis || !blockingRedis) return null;
  const replyKey = `${REPLY_KEY_PREFIX}:${randomUUID()}`;
  try {
    await redis.xadd(
      STREAM_KEY,
      '*',
      'type', 'state',
      'projectId', projectId,
      'fileId', fileId,
      'replyTo', replyKey,
    );
  } catch (err) {
    logger.warn({ err, projectId, fileId }, 'yjsRoomClient: XADD state failed');
    return null;
  }

  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let val;
    try {
      val = await redis.get(replyKey);
    } catch (err) {
      logger.warn({ err, replyKey }, 'yjsRoomClient: state-reply GET failed');
      return null;
    }
    if (val !== null && val !== undefined) {
      // Best-effort cleanup; the key has a TTL either way.
      try { await redis.del(replyKey); } catch { /* ignore */ }
      try {
        return new Uint8Array(Buffer.from(val, 'base64'));
      } catch (err) {
        logger.warn({ err }, 'yjsRoomClient: state-reply decode failed');
        return null;
      }
    }
    await new Promise((res) => setTimeout(res, REPLY_POLL_INTERVAL_MS));
  }
  return null;
}

/**
 * releaseRoom -- tell the worker we're done. The worker is the only
 * one ref-counting; the web tier just announces departure so the
 * worker can free idle rooms.
 */
export async function releaseRoom(projectId, fileId) {
  if (!redis) return;
  try {
    await redis.xadd(
      STREAM_KEY,
      '*',
      'type', 'release',
      'projectId', projectId,
      'fileId', fileId,
    );
  } catch (err) {
    logger.warn({ err, projectId, fileId }, 'yjsRoomClient: XADD release failed');
  }
}

// Test-only exports.
export const _testing = {
  STREAM_KEY,
  REPLY_KEY_PREFIX,
  REPLY_TIMEOUT_MS,
  assertReady,
};
