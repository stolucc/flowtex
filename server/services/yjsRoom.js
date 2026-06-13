// @ts-check
// YJS-MIGRATION phase 2 — server-side Y.Doc room.
//
// Holds one Y.Doc per (project_id, file_id) for the duration that at
// least one WebSocket client is collaborating on it. Tasks:
//
//   1. Load the latest persisted state from `files.content_yjs`
//      (BYTEA) when a room is created.
//   2. Apply every incoming `yjs-update` (validated upstream by
//      handleYjsUpdate) to the in-memory Y.Doc so the server-held
//      state stays in lockstep with the clients.
//   3. Snapshot to `files.content_yjs` on a debounce so:
//        - a late-joining client can be brought up to date by
//          reading the current Y.Doc state out of memory (and the
//          server doesn't lose anything across a restart);
//        - the on-disk row stays bounded -- the BYTEA replaces the
//          accumulated update log rather than appending to it.
//   4. Release the room when the last client leaves (best-effort
//      cleanup; the next room creation will re-load from PG).
//
// Out of scope for this commit:
//   - Multi-instance fan-out (Redis pub/sub already covers WS
//     broadcasts; the Y.Doc itself is single-instance until that's
//     wired -- documented in YJS-MIGRATION.md).
//   - Lazy initialisation from `files.content` when content_yjs is
//     NULL (phase 3).
//   - Background GC of long-running rooms.

import * as Y from 'yjs';
import db from '../db.js';
import logger from '../logger.js';
import { backfillCommentAnchors, backfillTcMarkAnchors } from './yjsAnchors.js';
import { recordYjsApply, setYjsRoomsActive, recordYjsSnapshotBytes } from './metrics.js';
import { withSpan } from '../tracing.js';

const SNAPSHOT_DEBOUNCE_MS = 2000;
// Defensive ceiling on the BYTEA we persist. A pathological Y.Doc
// history shouldn't crash the persistence path; if we ever exceed
// this we log and drop the snapshot rather than insert. In practice
// a realistic LaTeX project's Y.Doc state is well under 1 MB.
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

// Map (project_id, file_id) -> room
//   room.ydoc            Y.Doc holding the canonical state
//   room.refCount        number of WS clients currently joined
//   room.snapshotTimer   pending setTimeout id (or null)
//   room.dirty           true iff there are unpersisted updates
/**
 * @typedef {{
 *   projectId: string,
 *   fileId: string,
 *   ydoc: import('yjs').Doc,
 *   refCount: number,
 *   snapshotTimer: ReturnType<typeof setTimeout> | null,
 *   dirty: boolean,
 * }} Room
 */

/** @type {Map<string, Room>} */
const rooms = new Map();
/**
 * @param {string} projectId
 * @param {string} fileId
 * @returns {string}
 */
const keyFor = (projectId, fileId) => `${projectId}:${fileId}`;

/** For tests / observability. */
export function _peekRoomCount() { return rooms.size; }
/**
 * @param {string} projectId
 * @param {string} fileId
 */
export function _peekRoom(projectId, fileId) { return rooms.get(keyFor(projectId, fileId)); }

/**
 * Public "do we have this room cached locally" probe. Same surface
 * as yjsRoomClient.peekRoom so the selector can route either one --
 * anchor-resolution call sites (routes/comments, services/projectService)
 * go through services/yjsRoomSelector rather than importing
 * `_peekRoom` directly. The underscore-prefixed variants remain for
 * tests + observability scripts.
 */
/**
 * @param {string} projectId
 * @param {string} fileId
 */
export function peekRoom(projectId, fileId) {
  return rooms.get(keyFor(projectId, fileId));
}
export function _clearRooms() {
  for (const room of rooms.values()) {
    if (room.snapshotTimer) clearTimeout(room.snapshotTimer);
    try { room.ydoc.destroy(); } catch { /* ignore */ }
  }
  rooms.clear();
}

/**
 * Acquire (or create) the room for the given (project_id, file_id),
 * bumping its refCount. Loads the persisted Y.Doc state from
 * `files.content_yjs` on first acquisition.
 *
 * Returns null if the file row is missing (caller should treat that
 * as "drop the message" -- handleYjsUpdate has already verified the
 * fileId belongs to the project, so a missing row here means the
 * file was deleted between the upstream check and this lookup).
 */
/**
 * @param {string} projectId
 * @param {string} fileId
 * @returns {Promise<Room | null | undefined>}
 */
export async function acquireRoom(projectId, fileId) {
  const k = keyFor(projectId, fileId);
  let room = rooms.get(k);
  if (room) {
    room.refCount += 1;
    return room;
  }
  const ydoc = new Y.Doc();
  let dirty = false;
  // Load persisted Y.Doc state if present, otherwise seed from the
  // file's plain `content` so the canonical room state is non-empty.
  // Seeding server-side (not client-side) is what guarantees every
  // late joiner gets the same content under the same client-id --
  // multiple clients seeding their own Y.Docs from plain text would
  // produce N independent copies of the seed that the merge can't
  // collapse.
  try {
    const row = await db.get(
      'SELECT content_yjs, content FROM files WHERE id = $1 AND project_id = $2',
      [fileId, projectId],
    );
    if (!row) return null;
    let loadedFromYjs = false;
    if (row.content_yjs && row.content_yjs.length > 0) {
      Y.applyUpdateV2(ydoc, new Uint8Array(row.content_yjs), 'persist-load');
      loadedFromYjs = true;
    }
    // Seed from plain `content` when there's no persisted Y.Doc OR when
    // the persisted Y.Doc decodes to EMPTY but `content` still holds
    // text. The latter recovers files damaged by a pre-guard empty
    // snapshot (a transient blank editor that wrote an empty Y.Doc):
    // content_yjs is a non-zero buffer encoding nothing, so without
    // this the room would serve empty and the editor would stay blank.
    const yjsEmpty = ydoc.getText('content').length === 0;
    if (yjsEmpty && typeof row.content === 'string' && row.content.length > 0) {
      if (loadedFromYjs) {
        logger.warn(
          { projectId, fileId },
          'yjsRoom: persisted Y.Doc was empty but content column has text — reseeding from content (recovering prior blank)',
        );
      }
      const ytext = ydoc.getText('content');
      ydoc.transact(() => {
        ytext.insert(0, row.content);
      }, 'persist-seed');
      dirty = true;
    }
  } catch (err) {
    logger.warn({ err, projectId, fileId }, 'yjsRoom: failed to load persisted state');
    // Continue with an empty Y.Doc -- clients can still collaborate
    // and the next snapshot will overwrite whatever was there.
  }
  room = {
    projectId,
    fileId,
    ydoc,
    refCount: 1,
    snapshotTimer: null,
    dirty,
  };
  rooms.set(k, room);
  setYjsRoomsActive(rooms.size);
  if (dirty) scheduleSnapshot(room);
  // YJS-MIGRATION phase 4.5 + 5: opportunistically anchor any
  // pre-phase-4 comment rows AND pre-phase-5 tc_marks entries now
  // that the Y.Doc is loaded. Runs once per room (we just created
  // it). Failures here are logged inside the helpers and never
  // propagated -- legacy from_pos / to_pos / from / to remain
  // authoritative for unanchored rows.
  backfillCommentAnchors(projectId, fileId, ydoc).catch((err) =>
    logger.warn({ err, projectId, fileId }, 'yjsRoom: backfillCommentAnchors threw'),
  );
  backfillTcMarkAnchors(projectId, fileId, ydoc).catch((err) =>
    logger.warn({ err, projectId, fileId }, 'yjsRoom: backfillTcMarkAnchors threw'),
  );
  return room;
}

/**
 * Apply a client-originated Y.js update (already-decoded Uint8Array)
 * to the room's Y.Doc, then schedule a debounced snapshot. The room
 * is identified by (project_id, file_id); if it doesn't exist this
 * is a no-op (handleYjsUpdate didn't find one to broadcast against
 * either -- can happen if the room was released between dispatch and
 * apply).
 */
/**
 * @param {string} projectId
 * @param {string} fileId
 * @param {Uint8Array} updateBytes
 */
export function applyUpdate(projectId, fileId, updateBytes) {
  const room = rooms.get(keyFor(projectId, fileId));
  if (!room) return;
  // SAAS-FOUNDATIONS item 5: observe apply latency so the dashboard
  // can flag a slow Y.Doc (typically a sign of unbounded history
  // growth or a deeply-conflicted merge) before users notice. The
  // trace span carries the projectId / fileId / update size so a
  // tail-latency outlier in the histogram can be drilled into the
  // specific room that hit it.
  return withSpan('yjs.applyUpdate', (span) => {
    span.setAttribute('flowtex.project_id', projectId);
    span.setAttribute('flowtex.file_id', fileId);
    span.setAttribute('flowtex.update_bytes', updateBytes?.byteLength ?? 0);
    const start = process.hrtime.bigint();
    try {
      Y.applyUpdateV2(room.ydoc, updateBytes, 'client');
    } catch (err) {
      logger.warn({ err, projectId, fileId }, 'yjsRoom: applyUpdate failed');
      recordYjsApply(Number(process.hrtime.bigint() - start) / 1e6, 'err');
      span.recordException(err);
      span.setStatus({ code: 2, message: 'Y.applyUpdateV2 threw' });
      return;
    }
    recordYjsApply(Number(process.hrtime.bigint() - start) / 1e6, 'ok');
    room.dirty = true;
    scheduleSnapshot(room);
  });
}

/**
 * Encode the room's current Y.Doc as a single update -- the format
 * the client's `applyUpdateV2` expects on the wire when bringing a
 * late joiner up to date.
 */
/**
 * @param {string} projectId
 * @param {string} fileId
 */
export function encodeStateAsUpdate(projectId, fileId) {
  const room = rooms.get(keyFor(projectId, fileId));
  if (!room) return null;
  return Y.encodeStateAsUpdateV2(room.ydoc);
}

/**
 * Release a reference on the room. When the last referrer leaves,
 * flush a final snapshot synchronously and free the in-memory Y.Doc.
 * Safe to call with a never-acquired (project, file) -- treated as a
 * no-op.
 */
/**
 * @param {string} projectId
 * @param {string} fileId
 */
export async function releaseRoom(projectId, fileId) {
  const k = keyFor(projectId, fileId);
  const room = rooms.get(k);
  if (!room) return;
  room.refCount = Math.max(0, room.refCount - 1);
  if (room.refCount > 0) return;
  // Last client left -- flush whatever's pending and tear down.
  if (room.snapshotTimer) {
    clearTimeout(room.snapshotTimer);
    room.snapshotTimer = null;
  }
  if (room.dirty) {
    await persistSnapshot(room).catch((err) =>
      logger.warn({ err, projectId, fileId }, 'yjsRoom: final snapshot failed'),
    );
  }
  try { room.ydoc.destroy(); } catch { /* ignore */ }
  rooms.delete(k);
  setYjsRoomsActive(rooms.size);
}

/** @param {Room} room */
function scheduleSnapshot(room) {
  if (room.snapshotTimer) return;
  room.snapshotTimer = setTimeout(() => {
    room.snapshotTimer = null;
    persistSnapshot(room).catch((err) =>
      logger.warn({ err, projectId: room.projectId, fileId: room.fileId },
        'yjsRoom: scheduled snapshot failed'),
    );
  }, SNAPSHOT_DEBOUNCE_MS);
  // Don't keep the event loop alive just for this timer -- if the
  // process is shutting down, the next acquireRoom from a restarted
  // peer will load the latest snapshot from before this tick.
  if (typeof room.snapshotTimer.unref === 'function') room.snapshotTimer.unref();
}

/** @param {Room} room */
async function persistSnapshot(room) {
  if (!room.dirty) return;
  const bytes = Y.encodeStateAsUpdateV2(room.ydoc);
  if (bytes.length > MAX_SNAPSHOT_BYTES) {
    logger.warn(
      { projectId: room.projectId, fileId: room.fileId, size: bytes.length },
      'yjsRoom: snapshot exceeds MAX_SNAPSHOT_BYTES, refusing to persist',
    );
    return;
  }
  // YJS-MIGRATION phase 3: also write the current text view back to
  // `content` so non-yjs read paths (HTTP file GET, compile, export
  // ZIP, GitHub push, search) see the latest collaborative content.
  // Both columns end up consistent; the plain-text column lags the
  // Y.Doc by at most SNAPSHOT_DEBOUNCE_MS.
  const text = room.ydoc.getText('content').toString();

  // Data-loss guard: refuse to overwrite a non-empty stored file with
  // an EMPTY Y.Doc. A transient blank editor (e.g. a remount that
  // re-seeds empty, or a client whose binding diffed against an empty
  // doc and emitted a delete-all update) would otherwise wipe both
  // columns and the content would be unrecoverable except via
  // project_snapshots. A genuine "select-all + delete" is rare and the
  // user can retype; silently losing a whole file is far worse. Skip
  // the write and log loudly so it's visible.
  if (text.length === 0) {
    const cur = await db.get(
      'SELECT content FROM files WHERE id = $1 AND project_id = $2',
      [room.fileId, room.projectId],
    );
    if (cur && typeof cur.content === 'string' && cur.content.length > 0) {
      logger.warn(
        { projectId: room.projectId, fileId: room.fileId, storedLen: cur.content.length },
        'yjsRoom: refusing to persist EMPTY Y.Doc over non-empty content (suspected transient blank); keeping stored content',
      );
      // Leave dirty=false so we don't spin retrying; the next real edit
      // re-marks dirty and a legitimate non-empty state will persist.
      room.dirty = false;
      return;
    }
  }

  await db.run(
    'UPDATE files SET content_yjs = $1, content = $2, updated_at = NOW() WHERE id = $3 AND project_id = $4',
    [Buffer.from(bytes), text, room.fileId, room.projectId],
  );
  recordYjsSnapshotBytes(bytes.length);
  room.dirty = false;
}
