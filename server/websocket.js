import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';
import cookie from 'cookie';
import signature from 'cookie-signature';
import logger from './logger.js';
import db from './db.js';
import { UUID_RE, isProjectMember } from './middleware/auth.js';
import { recordMentions } from './utils/mentions.js';
import {
  acquireRoom as yjsAcquireRoom,
  applyUpdate as yjsApplyUpdate,
  encodeStateAsUpdate as yjsEncodeStateAsUpdate,
  releaseRoom as yjsReleaseRoom,
  isWorkerSplitEnabled,
} from './services/yjsRoomSelector.js';
import { setRedisClient as setYjsRoomClientRedis } from './services/yjsRoomClient.js';
import { setWsConnectionsActive, recordWsFrame } from './services/metrics.js';
import { captureException as reportException } from './services/errorReporter.js';

let wsConnectionGauge = 0;
function bumpConnections(delta) {
  wsConnectionGauge = Math.max(0, wsConnectionGauge + delta);
  setWsConnectionsActive(wsConnectionGauge);
}

// sendToUser is a closure inside createWebSocketServer; the chat handler
// (module-scoped) needs to push @mention notifications to specific users
// across all their connections, including connections currently joined
// to a different project. Capture a module-scoped reference once the WS
// server initialises so handleChat can call it.
let sendToUserFn = null;

// ── Redis pub/sub for horizontal scaling (optional) ─────────────────────
let redisPub = null;
let redisSub = null;
const REDIS_CHANNEL = 'flowtex:ws';
// Separate control channel for cluster-wide WS commands (kick a user
// from a project, kick all sessions for a user). Carried on a
// dedicated channel rather than piggybacking on the broadcast
// channel so consumers can validate the message shape strictly
// (vs. the broadcast channel which proxies arbitrary client-facing
// payloads).
const REDIS_CONTROL_CHANNEL = 'flowtex:ws:control';
const SERVER_ID = crypto.randomUUID();

// ── Room management ─────────────────────────────────────────────────────
const projectRooms = new Map();

/** Get or create the Set of clients for a project room. */
function getRoom(projectId) {
  if (!projectRooms.has(projectId)) {
    projectRooms.set(projectId, new Set());
  }
  return projectRooms.get(projectId);
}

// React's JSX escaping handles output encoding — server-side HTML encoding
// would cause double-encoding. Message length limits are enforced in handlers.

/** Broadcast a message to all clients in a project room, optionally excluding one. */
function broadcastToRoom(projectId, message, excludeWs) {
  const outMessage = message;
  const room = projectRooms.get(projectId);
  if (room) {
    const data = JSON.stringify(outMessage);
    for (const client of room) {
      if (client.ws !== excludeWs && client.ws.readyState === 1) {
        client.ws.send(data);
      }
    }
  }
  if (redisPub) {
    redisPub
      .publish(
        REDIS_CHANNEL,
        JSON.stringify({
          projectId,
          message: outMessage,
          fromServer: SERVER_ID,
        }),
      )
      .catch((e) => logger.warn({ err: e }, 'Redis publish failed'));
  }
}

/** Close all WebSocket connections for a user in a specific project room
 *  ON THIS INSTANCE. Use disconnectUserFromProjectClusterWide() in cluster
 *  mode to also kick connections held by peer web instances.
 */
function disconnectUserFromProjectLocal(projectId, userId) {
  const room = projectRooms.get(projectId);
  if (!room) return;
  for (const client of room) {
    if (client.userId === userId) {
      client.ws.close(4003, 'Removed from project');
    }
  }
}

/**
 * Cluster-aware variant. Closes the local matches AND publishes a
 * control message so peer instances do the same. Without this fan-out,
 * a user removed from a project whose WS is held by a different
 * instance keeps receiving broadcasts until natural disconnect (real
 * audit finding 2026-06-09).
 */
function disconnectUserFromProject(projectId, userId) {
  disconnectUserFromProjectLocal(projectId, userId);
  if (redisPub) {
    redisPub
      .publish(
        REDIS_CONTROL_CHANNEL,
        JSON.stringify({
          type: 'kick-user-from-project',
          projectId,
          userId,
          fromServer: SERVER_ID,
        }),
      )
      .catch((e) => logger.warn({ err: e }, 'Redis publish kick failed'));
  }
}

/** Send an updated presence list (unique users) to all clients in a room. */
function broadcastPresence(projectId) {
  const room = projectRooms.get(projectId);
  if (!room) return;
  const users = [...room].map((c) => ({ id: c.userId, name: c.userName }));
  const unique = [...new Map(users.map((u) => [u.id, u])).values()];
  const data = JSON.stringify({ type: 'presence', users: unique });
  for (const client of room) {
    if (client.ws.readyState === 1) client.ws.send(data);
  }
}

// ── Session auth for WebSocket upgrades ─────────────────────────────────
/** Verify and extract the session ID from a signed cookie value.
 *  Delegates to `cookie-signature` (the same library express-session uses) so
 *  the MAC check stays in lockstep with upstream and we don't carry our own
 *  bespoke crypto routine. The leading "s:" prefix is express-session's
 *  encoding marker; cookie-signature itself doesn't expect it. */
function unsignCookie(signedValue, secret) {
  if (typeof signedValue !== 'string' || !signedValue.startsWith('s:')) return null;
  const unsigned = signature.unsign(signedValue.slice(2), secret);
  return unsigned === false ? null : unsigned;
}

/** Parse the session cookie from a raw HTTP request and load session data from DB. */
async function getSessionFromRequest(req, sessionSecret) {
  try {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;
    const cookies = cookie.parse(cookieHeader);
    const raw = cookies['__session'];
    if (!raw) return null;

    const sessionId = unsignCookie(raw, sessionSecret);
    if (!sessionId) {
      logger.warn('WS session: invalid cookie signature');
      return null;
    }

    // Enforce session expiry in-query. The HTTP middleware also enforces
    // the 7-day absolute lifetime, but the WS path bypasses Express
    // entirely — without this check, a cookie whose `expire` has elapsed
    // would still authenticate WS connections until connect-pg-simple's
    // cleanup cron (every 15 min) deletes the row.
    const row = await db.get('SELECT sess FROM session WHERE sid = $1 AND expire > NOW()', [sessionId]);
    if (!row) return null;

    const sess = typeof row.sess === 'string' ? JSON.parse(row.sess) : row.sess;
    // Expose the sid alongside the session payload so the WS pump can
    // tag the connection with it. Used by disconnectUserSessionsExcept
    // to skip the WS belonging to the session the caller wants to keep
    // (e.g. the user who just changed their password on this device).
    return sess ? { ...sess, _sid: sessionId } : null;
  } catch (err) {
    logger.warn({ err }, 'WS session parse error');
    return null;
  }
}

// ── Message handlers ────────────────────────────────────────────────────

/**
 * Verify msg.fileId belongs to the project the WS connection joined.
 * Caches valid IDs per-connection to avoid a DB hit on every keystroke
 * broadcast; falls back to a single DB lookup on cache miss (handles new
 * files created mid-session). Returns true on valid, false otherwise.
 */
async function isFileInProject(state, fileId) {
  if (typeof fileId !== 'string' || !UUID_RE.test(fileId)) return false;
  if (!state.projectId) return false;
  if (!state.fileIds) state.fileIds = new Set();
  if (state.fileIds.has(fileId)) return true;
  const row = await db.get('SELECT 1 FROM files WHERE id = $1 AND project_id = $2', [fileId, state.projectId]);
  if (!row) return false;
  state.fileIds.add(fileId);
  return true;
}

/** Handle a 'join' message: verify membership and add client to the project room. */
async function handleJoin(ws, msg, state) {
  if (typeof msg.projectId !== 'string' || !UUID_RE.test(msg.projectId)) return;

  // Leave previous room if re-joining a different project
  if (state.projectId && state.clientEntry) {
    const oldRoom = projectRooms.get(state.projectId);
    if (oldRoom) {
      oldRoom.delete(state.clientEntry);
      if (oldRoom.size === 0) projectRooms.delete(state.projectId);
      broadcastPresence(state.projectId);
    }
  }

  state.projectId = msg.projectId;

  const member = await db.get('SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2', [
    state.projectId,
    state.authenticatedUserId,
  ]);
  if (!member) {
    ws.send(JSON.stringify({ type: 'error', error: 'No access' }));
    ws.close();
    return;
  }

  state.memberRole = member.role;
  // Seed the per-connection file-id allowlist with the current project's
  // files so subsequent keystroke broadcasts validate against an in-memory
  // set instead of hitting the DB. Misses fall back to a one-shot DB lookup
  // (covers files created mid-session by other clients).
  const fileRows = await db.all('SELECT id FROM files WHERE project_id = $1', [state.projectId]);
  state.fileIds = new Set(Array.isArray(fileRows) ? fileRows.map((r) => r.id) : []);
  state.clientEntry = { ws, userId: state.authenticatedUserId, userName: state.authenticatedUserName, cursor: null };
  getRoom(state.projectId).add(state.clientEntry);
  ws.send(JSON.stringify({ type: 'joined', userId: state.authenticatedUserId, userName: state.authenticatedUserName }));

  const room = projectRooms.get(state.projectId);
  if (room) {
    for (const c of room) {
      if (c !== state.clientEntry && c.cursor) {
        ws.send(JSON.stringify({ type: 'cursor', userId: c.userId, userName: c.userName, ...c.cursor }));
      }
    }
  }
  broadcastPresence(state.projectId);
}

/** Broadcast editor changes (+ optional TC mark mutations) to other clients in the room. */
async function handleChanges(msg, state, ws) {
  if (!Array.isArray(msg.changes) || msg.changes.length > 1000) return;
  const valid = msg.changes.every(
    (c) =>
      c &&
      typeof c === 'object' &&
      (c.from === undefined || typeof c.from === 'number') &&
      (c.to === undefined || typeof c.to === 'number') &&
      (c.insert === undefined || (typeof c.insert === 'string' && c.insert.length <= 500000)),
  );
  if (!valid) return;
  if (!(await isFileInProject(state, msg.fileId))) return;

  // tcMarks is { added: [TcEntry...], removed: [id...] } — V2 broadcast
  // for real-time collaborative tracked changes. Validate shape AND
  // overwrite authorId/authorName on each added entry with the
  // server-authenticated user. Without this, a malicious client could
  // forge tracked-change attribution to any other user via the WS
  // wire (security audit finding 2026-06-09).
  let tcMarks;
  if (msg.tcMarks && typeof msg.tcMarks === 'object') {
    const rawAdded = Array.isArray(msg.tcMarks.added) ? msg.tcMarks.added.slice(0, 1000) : [];
    const added = rawAdded
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({
        ...e,
        authorId: state.authenticatedUserId,
        authorName: state.authenticatedUserName,
      }));
    const removed = Array.isArray(msg.tcMarks.removed)
      ? msg.tcMarks.removed.filter((x) => typeof x === 'string').slice(0, 1000)
      : [];
    if (added.length > 0 || removed.length > 0) {
      // Cap each entry's serialized size defensively.
      if (JSON.stringify({ added, removed }).length <= 200000) {
        tcMarks = { added, removed };
      }
    }
  }

  broadcastToRoom(
    state.projectId,
    {
      type: 'changes',
      fileId: msg.fileId,
      changes: msg.changes,
      userId: state.clientEntry.userId,
      // Preserve the sender's per-tab origin so they can filter echoes of
      // their own edits on reconnect (zombie ws in the room would otherwise
      // bounce the change back to the same browser tab — see useWebSocket).
      ...(typeof msg.originId === 'string' ? { originId: msg.originId } : {}),
      ...(msg.tracked ? { tracked: true } : {}),
      ...(Array.isArray(msg.deletions) ? { deletions: msg.deletions } : {}),
      ...(tcMarks ? { tcMarks } : {}),
    },
    ws,
  );
}

/**
 * Phase-2 relay+apply for Y.js CRDT updates. Mirrors `handleChanges`
 * for room/role checks, plus:
 *   - Decodes the base64 payload and applies it to the server-side
 *     Y.Doc held by yjsRoom (which schedules a debounced snapshot to
 *     files.content_yjs).
 *   - Then broadcasts the original base64 payload unchanged to room
 *     peers. Peers reconstruct the same Y.Doc state from this update;
 *     the server-side apply keeps the room canonical for late
 *     joiners and survives a restart.
 *
 * Hardening (unchanged from phase 1):
 *   - Caller is auth + role-gated via writeTypes/isAllowedWriteRole.
 *   - fileId must belong to the project.
 *   - update payload capped at MAX_YJS_UPDATE_B64.
 *   - originId capped at 64 chars.
 */
const MAX_YJS_UPDATE_B64 = 256 * 1024; // 256 KB base64 ≈ 192 KB of Y.js update bytes
async function handleYjsUpdate(msg, state, ws) {
  if (typeof msg.update !== 'string') return;
  if (msg.update.length === 0 || msg.update.length > MAX_YJS_UPDATE_B64) return;
  if (!(await isFileInProject(state, msg.fileId))) return;

  // Make sure this WS holds a reference to the room so the in-memory
  // Y.Doc stays alive at least until disconnect. Tracked per-WS so
  // we know how many releases to issue on close.
  if (!(await ensureRoomSubscribed(state, msg.fileId))) return;

  // Decode base64 -> Uint8Array and apply to the server-side room.
  // Malformed base64 is treated as a dropped frame (no broadcast).
  let bytes;
  try {
    const buf = Buffer.from(msg.update, 'base64');
    bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch {
    return;
  }
  // Fire-and-forget through the selector. In single-instance the
  // in-process applyUpdate runs synchronously; in cluster mode the
  // selector XADDs to Redis and returns a Promise we don't need to
  // await on this hot path. Errors land in the selector's recorded
  // metrics + tracing span, not on the WS handler.
  void yjsApplyUpdate(state.projectId, msg.fileId, bytes);

  broadcastToRoom(
    state.projectId,
    {
      type: 'yjs-update',
      fileId: msg.fileId,
      update: msg.update,
      userId: state.clientEntry.userId,
      ...(typeof msg.originId === 'string' && msg.originId.length <= 64
        ? { originId: msg.originId }
        : {}),
    },
    ws,
  );
}

/**
 * Phase-2 catch-up for Y.js late joiners. Client sends
 *   { type: 'yjs-request-state', fileId }
 * after opening a file with the yjs flag on. Server replies just
 * to that client with
 *   { type: 'yjs-state', fileId, state }
 * containing a base64 of the room's current encodeStateAsUpdateV2.
 * The client merges that into its local Y.Doc, which is the correct
 * way to bring an empty doc up to room state in one round-trip.
 *
 * If there's no active room (no one else editing) the server first
 * acquires the room from PG (loads files.content_yjs) so the client
 * still gets the durable state, then immediately releases it.
 */
async function handleYjsRequestState(msg, state, ws) {
  if (!(await isFileInProject(state, msg.fileId))) return;
  // The client is about to start editing this file -- hold a room
  // reference for the rest of the connection. handleYjsUpdate would
  // acquire it anyway on the first keystroke; doing it here means
  // the late-joiner state we send below already reflects whatever
  // was persisted to PG even if no one else is editing.
  if (!(await ensureRoomSubscribed(state, msg.fileId))) return;

  // encodeStateAsUpdate via the selector: in-process returns
  // immediately; remote does a Redis round-trip with a poll-key
  // contract and resolves with the bytes. Must be awaited because
  // we send the bytes back to the client.
  const bytes = await yjsEncodeStateAsUpdate(state.projectId, msg.fileId);
  if (!bytes) return;
  const b64 = Buffer.from(bytes).toString('base64');
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'yjs-state', fileId: msg.fileId, state: b64 }));
}

/**
 * Lazy room acquisition keyed on (state.ws, fileId). state.yjsRoomsHeld
 * tracks the fileIds this connection is responsible for releasing on
 * close. Returns true on success (room is held), false if the file
 * row went missing between isFileInProject and acquireRoom.
 */
async function ensureRoomSubscribed(state, fileId) {
  if (!state.yjsRoomsHeld) state.yjsRoomsHeld = new Set();
  if (state.yjsRoomsHeld.has(fileId)) return true;
  const room = await yjsAcquireRoom(state.projectId, fileId);
  if (!room) return false;
  state.yjsRoomsHeld.add(fileId);
  return true;
}

/**
 * Release every (project, fileId) room this connection acquired.
 * Called from the WS close handler so the in-memory Y.Doc can be
 * freed (and a final snapshot flushed) when the last client leaves.
 */
export async function releaseYjsRoomsForState(state) {
  if (!state || !state.yjsRoomsHeld || state.yjsRoomsHeld.size === 0) return;
  const fileIds = [...state.yjsRoomsHeld];
  state.yjsRoomsHeld.clear();
  for (const fileId of fileIds) {
    await yjsReleaseRoom(state.projectId, fileId);
  }
}

/** Broadcast cursor position updates to other clients. */
async function handleCursor(msg, state, ws) {
  if (typeof msg.head !== 'number' || typeof msg.anchor !== 'number') return;
  if (!(await isFileInProject(state, msg.fileId))) return;
  state.clientEntry.cursor = { fileId: msg.fileId, head: msg.head, anchor: msg.anchor };
  broadcastToRoom(
    state.projectId,
    {
      type: 'cursor',
      fileId: msg.fileId,
      userId: state.clientEntry.userId,
      userName: state.clientEntry.userName,
      head: msg.head,
      anchor: msg.anchor,
      // Preserve per-tab origin so the sender can filter their own echoes.
      ...(typeof msg.originId === 'string' ? { originId: msg.originId } : {}),
    },
    ws,
  );
}

// (Removed 2026-06-04) handleComment / handleCommentReply /
// handleCommentResolve / handleCommentDelete / handleCommentEdit
// used to rebroadcast sender-supplied payloads on these message
// types. The actual persistence lives in /api/comments routes which
// enforce author-only / commenter-or-better access; the WS broadcast
// was a UX optimisation but trusted the sender to describe what was
// persisted. A malicious editor (or commenter, with the new role)
// could emit a `comment-delete` for any commentId in their project
// and other clients would hide it from local state until refresh.
// Replaced by server-originated broadcasts from the HTTP routes
// (see broadcastCommentEvent in routes/comments.js). Older client
// builds keep sending these types; the messageHandlers lookup just
// no-ops them.

// (Removed 2026-05-16) The old WS handlers `tracked-change`,
// `tracked-change-resolve`, `tracked-change-delete`, `tc-delete-mark`
// belonged to the V1 tracked-changes pipeline that was rebuilt against
// the in-file `tc_marks` JSON sidecar — no client emits these frame
// types any more. Keeping the handlers around left unnecessary write
// surface (a malicious authenticated room member could broadcast
// arbitrary tracked-change payloads).

/** Build the current reaction summary for an editor comment. */
async function fetchCommentReactionsFor(commentId) {
  const rows = await db.all(
    `SELECT emoji, user_id AS "userId", user_name AS "userName"
     FROM comment_reactions WHERE comment_id = $1
     ORDER BY created_at ASC`,
    [commentId],
  );
  const byEmoji = new Map();
  for (const r of rows) {
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
    byEmoji.get(r.emoji).push({ id: r.userId, name: r.userName });
  }
  return Array.from(byEmoji.entries()).map(([emoji, users]) => ({ emoji, count: users.length, users }));
}

/** Toggle the current user's reaction on a comment. Confirms the comment
 *  belongs to a file in the sender's room, then rebroadcasts the full
 *  reaction list so every client converges. */
async function handleCommentReact(msg, state) {
  const commentId = typeof msg.commentId === 'string' ? msg.commentId : null;
  const emoji = typeof msg.emoji === 'string' ? msg.emoji.trim() : '';
  if (!commentId || !emoji || emoji.length > 32) return;
  const owned = await db.get(
    `SELECT 1 FROM comments c JOIN files f ON c.file_id = f.id
      WHERE c.id = $1 AND f.project_id = $2`,
    [commentId, state.projectId],
  );
  if (!owned) return;
  try {
    const inserted = await db.run(
      `INSERT INTO comment_reactions (id, comment_id, user_id, user_name, emoji)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (comment_id, user_id, emoji) DO NOTHING`,
      [crypto.randomUUID(), commentId, state.authenticatedUserId, state.authenticatedUserName, emoji],
    );
    if (!inserted?.rowCount) {
      await db.run(
        'DELETE FROM comment_reactions WHERE comment_id = $1 AND user_id = $2 AND emoji = $3',
        [commentId, state.authenticatedUserId, emoji],
      );
    }
  } catch (err) {
    logger.error({ err }, 'Comment reaction toggle error');
    return;
  }
  const reactions = await fetchCommentReactionsFor(commentId);
  broadcastToRoom(state.projectId, { type: 'comment-reaction-update', commentId, reactions });
}

/** Build the current reaction summary for a comment reply. */
async function fetchReplyReactionsFor(replyId) {
  const rows = await db.all(
    `SELECT emoji, user_id AS "userId", user_name AS "userName"
     FROM reply_reactions WHERE reply_id = $1
     ORDER BY created_at ASC`,
    [replyId],
  );
  const byEmoji = new Map();
  for (const r of rows) {
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
    byEmoji.get(r.emoji).push({ id: r.userId, name: r.userName });
  }
  return Array.from(byEmoji.entries()).map(([emoji, users]) => ({ emoji, count: users.length, users }));
}

/** Toggle the current user's reaction on a comment reply. Confirms the reply
 *  belongs to a comment in a file in the sender's room. */
async function handleReplyReact(msg, state) {
  const replyId = typeof msg.replyId === 'string' ? msg.replyId : null;
  const emoji = typeof msg.emoji === 'string' ? msg.emoji.trim() : '';
  if (!replyId || !emoji || emoji.length > 32) return;
  const owned = await db.get(
    `SELECT cr.comment_id AS "commentId"
       FROM comment_replies cr
       JOIN comments c ON c.id = cr.comment_id
       JOIN files f    ON f.id = c.file_id
      WHERE cr.id = $1 AND f.project_id = $2`,
    [replyId, state.projectId],
  );
  if (!owned) return;
  try {
    const inserted = await db.run(
      `INSERT INTO reply_reactions (id, reply_id, user_id, user_name, emoji)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (reply_id, user_id, emoji) DO NOTHING`,
      [crypto.randomUUID(), replyId, state.authenticatedUserId, state.authenticatedUserName, emoji],
    );
    if (!inserted?.rowCount) {
      await db.run(
        'DELETE FROM reply_reactions WHERE reply_id = $1 AND user_id = $2 AND emoji = $3',
        [replyId, state.authenticatedUserId, emoji],
      );
    }
  } catch (err) {
    logger.error({ err }, 'Reply reaction toggle error');
    return;
  }
  const reactions = await fetchReplyReactionsFor(replyId);
  broadcastToRoom(state.projectId, {
    type: 'reply-reaction-update',
    commentId: owned.commentId,
    replyId,
    reactions,
  });
}

/** Build the current reaction summary for a chat message: one row per emoji
 *  with the list of users who reacted with it. */
async function fetchReactionsFor(messageId) {
  const rows = await db.all(
    `SELECT emoji, user_id AS "userId", user_name AS "userName"
     FROM chat_message_reactions WHERE message_id = $1
     ORDER BY created_at ASC`,
    [messageId],
  );
  const byEmoji = new Map();
  for (const r of rows) {
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
    byEmoji.get(r.emoji).push({ id: r.userId, name: r.userName });
  }
  return Array.from(byEmoji.entries()).map(([emoji, users]) => ({ emoji, count: users.length, users }));
}

/** Toggle the current user's reaction (emoji) on a chat message; rebroadcasts
 *  the full reaction list for that message so every client lands on the same
 *  state regardless of arrival order. */
async function handleChatReact(msg, state) {
  const messageId = typeof msg.messageId === 'string' ? msg.messageId : null;
  const emoji = typeof msg.emoji === 'string' ? msg.emoji.trim() : '';
  if (!messageId || !emoji || emoji.length > 32) return;
  // Confirm the target message belongs to the room the sender claims to be in.
  const owned = await db.get(
    'SELECT 1 FROM chat_messages WHERE id = $1 AND project_id = $2',
    [messageId, state.projectId],
  );
  if (!owned) return;
  try {
    // Toggle: try to insert; on conflict (already reacted), delete instead.
    const inserted = await db.run(
      `INSERT INTO chat_message_reactions (id, message_id, user_id, user_name, emoji)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
      [crypto.randomUUID(), messageId, state.authenticatedUserId, state.authenticatedUserName, emoji],
    );
    if (!inserted?.rowCount) {
      await db.run(
        'DELETE FROM chat_message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
        [messageId, state.authenticatedUserId, emoji],
      );
    }
  } catch (err) {
    logger.error({ err }, 'Chat reaction toggle error');
    return;
  }
  const reactions = await fetchReactionsFor(messageId);
  broadcastToRoom(state.projectId, { type: 'chat-reaction-update', messageId, reactions });
}

/** Persist a chat message to DB and broadcast it to the project room.
 *  Also extracts any @-mentions and records them in the comment_mentions
 *  inbox (chat_message_id non-null), then pushes a live `mention` WS event
 *  to each mentioned user so the bell badge updates without a refresh. */
async function handleChat(msg, state) {
  const id = crypto.randomUUID();
  const text = (msg.text || '').trim().slice(0, 5000);
  if (!text) return;
  try {
    await db.run('INSERT INTO chat_messages (id, project_id, user_id, user_name, text) VALUES ($1, $2, $3, $4, $5)', [
      id,
      state.projectId,
      state.authenticatedUserId,
      state.authenticatedUserName,
      text,
    ]);
    const chatMsg = {
      type: 'chat',
      id,
      userId: state.authenticatedUserId,
      userName: state.authenticatedUserName,
      text,
      created_at: new Date().toISOString(),
    };
    broadcastToRoom(state.projectId, chatMsg);

    // @-mention recording is best-effort — failures must not affect the
    // chat message itself (already persisted + broadcast above).
    try {
      const recorded = await recordMentions({
        text,
        chatMessageId: id,
        mentionerUserId: state.authenticatedUserId,
        projectId: state.projectId,
      });
      if (recorded.length && sendToUserFn) {
        for (const r of recorded) {
          sendToUserFn(r.mentionedUserId, {
            type: 'mention',
            mention: {
              id: r.id,
              projectId: r.projectId,
              chatMessageId: r.chatMessageId,
              snippet: r.snippet,
              mentionerName: state.authenticatedUserName,
              createdAt: new Date().toISOString(),
            },
          });
        }
      }
    } catch (mentionErr) {
      logger.warn({ err: mentionErr }, 'Chat mention recording failed');
    }
  } catch (err) {
    logger.error({ err }, 'Chat insert error');
  }
}

/** Update the sender's chat-read cursor for the joined project, then
 *  broadcast so other clients can flip their own-message "seen by N"
 *  indicators live. The client typically fires this when the chat
 *  panel mounts, when it receives a new message while visible, or on
 *  scroll-to-bottom — coarse-grained so the cursor write rate stays
 *  manageable.
 */
async function handleChatRead(_msg, state) {
  if (!state.projectId || !state.authenticatedUserId) return;
  try {
    const row = await db.get(
      `INSERT INTO chat_read_cursors (project_id, user_id, last_read_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (project_id, user_id)
         DO UPDATE SET last_read_at = NOW()
       RETURNING last_read_at AS "lastReadAt"`,
      [state.projectId, state.authenticatedUserId],
    );
    broadcastToRoom(state.projectId, {
      type: 'chat-read',
      userId: state.authenticatedUserId,
      lastReadAt: row.lastReadAt,
    });
  } catch (err) {
    logger.error({ err }, 'Chat read-cursor update error');
  }
}

// Message types that mutate project state. Each is gated by a role
// check on the sending connection (see writeRoleFor below). `changes`
// is editor-only (modifies file content). `comment-react` /
// `reply-react` / `chat` / `chat-react` are commenter-or-better
// (project conversation, not file content). The legacy `comment` /
// `comment-reply` / `comment-resolve` / `comment-delete` /
// `comment-edit` types are no longer dispatched (broadcasts now
// come from the HTTP routes), but old client builds still send
// them — keep them on the list so any future re-introduction
// inherits the role check by default.
const writeTypes = new Set([
  'changes',
  'yjs-update',
  'comment',
  'comment-reply',
  'comment-resolve',
  'comment-delete',
  'comment-edit',
  'comment-react',
  'reply-react',
  'chat',
  'chat-react',
]);

// Per-message minimum role. Editor-only types (changes) require
// editor-or-better; commenter-or-better types require commenter,
// editor, or owner. Enumerates ALLOWED roles, NOT rejected ones,
// so an unknown future role (or a corrupted row) defaults to denied
// instead of silently inheriting writer permissions. Mirrors the
// service-layer EDITOR_ROLES / COMMENTER_OR_BETTER_ROLES sets.
const editorOnlyWriteTypes = new Set(['changes', 'yjs-update']);
const EDITOR_WS_ROLES = new Set(['owner', 'editor']);
const COMMENTER_WS_ROLES = new Set(['owner', 'editor', 'commenter']);
function isAllowedWriteRole(type, role) {
  if (editorOnlyWriteTypes.has(type)) return EDITOR_WS_ROLES.has(role);
  return COMMENTER_WS_ROLES.has(role);
}

/** Predicate: should this client be disconnected by a "disconnect every
 *  session except `keepSessionId`" sweep?
 *
 *  Hardening: if `keepSessionId` is falsy the caller hasn't named a
 *  session to keep, so fall back to "disconnect every WS for this
 *  user" -- safer than silently keeping an unidentified WS (one
 *  whose `_flowtexSessionId` is also null/undefined) up after a
 *  privilege change. The real callers always pass req.sessionID so
 *  this only fires on misuse, but the fail-closed posture matters.
 */
export function shouldDisconnectExcept(client, userId, keepSessionId) {
  if (client._flowtexUserId !== userId) return false;
  if (!keepSessionId) return true;
  return client._flowtexSessionId !== keepSessionId;
}

/** Broadcast a typing indicator to other clients in the room. */
function handleTyping(msg, state, ws) {
  broadcastToRoom(
    state.projectId,
    {
      type: 'typing',
      userId: state.authenticatedUserId,
      userName: state.authenticatedUserName,
    },
    ws,
  );
}

const messageHandlers = {
  changes: handleChanges,
  'yjs-update': handleYjsUpdate,
  'yjs-request-state': handleYjsRequestState,
  cursor: handleCursor,
  // comment / comment-reply / comment-resolve / comment-delete /
  // comment-edit handlers were removed when their broadcasts moved
  // to the HTTP routes (see routes/comments.js). Older client builds
  // may still send these types; falling through here is intentional.
  'comment-react': handleCommentReact,
  'reply-react': handleReplyReact,
  chat: handleChat,
  'chat-react': handleChatReact,
  'chat-read': handleChatRead,
  typing: handleTyping,
};

// ── Main export ─────────────────────────────────────────────────────────
const WS_RATE_WINDOW = 1000;
const WS_RATE_MAX = 30;
const MAX_WS_PER_USER = 10;
const WS_HEARTBEAT_INTERVAL = 30000;

const wsConnectionCounts = new Map();

/**
 * Initialize the WebSocket server with session auth, room management, and optional Redis pub/sub.
 * @param {import('http').Server} server
 * @param {import('express').Application} app
 * @param {string} sessionSecret
 * @returns {{wss: WebSocketServer, redisPub: Redis|null, redisSub: Redis|null}}
 */
export function initWebSocket(server, app, sessionSecret) {
  // SAAS-FOUNDATIONS item 4: in cluster mode Redis pub/sub is the
  // only thing keeping broadcasts from diverging across instances.
  // Refuse to boot a clustered node without it so a misconfigured
  // multi-instance deploy fails loudly at start rather than silently
  // delivering different room state to clients pinned to different
  // backends.
  const instanceMode = (process.env.FLOWTEX_INSTANCE_MODE || 'single').toLowerCase();
  if (instanceMode === 'cluster' && !process.env.REDIS_URL) {
    logger.error(
      { instanceMode },
      'FLOWTEX_INSTANCE_MODE=cluster requires REDIS_URL to be set ' +
      '(WebSocket broadcasts would diverge across instances without it).',
    );
    throw new Error(
      'FLOWTEX_INSTANCE_MODE=cluster requires REDIS_URL',
    );
  }
  // Belt-and-braces against Y.Doc split-brain:
  // In cluster mode, EVERY web instance broadcasts Y.Doc updates to
  // its peers via Redis pub/sub. If the Y.Doc selector ALSO holds
  // each project's room in-process, peers will each maintain their
  // own copy of the room and concurrently apply the same updates --
  // including the initial seed insert for the boilerplate template.
  // Y.js converges those as concurrent inserts, so you end up with
  // every initial insert duplicated per instance ("the boilerplate
  // appeared twice" is the canonical symptom).
  //
  // Refuse to boot in this combination so the operator can't
  // accidentally trip into it. They have two ways out:
  //   1. Set FLOWTEX_YJS_WORKER=enabled (and run the worker) so the
  //      selector picks the remote backend.
  //   2. Take cluster mode off (single-VPS shape).
  if (instanceMode === 'cluster' && !isWorkerSplitEnabled()) {
    logger.error(
      { instanceMode },
      'FLOWTEX_INSTANCE_MODE=cluster requires the Y.Doc worker tier ' +
      '(set FLOWTEX_YJS_WORKER=enabled and run server/yjsWorker.js). ' +
      'Without it, each web instance holds its own copy of every ' +
      'Y.Doc room and the pub/sub broadcast causes split-brain ' +
      'duplication (boilerplate text appears N times for N instances).',
    );
    throw new Error(
      'FLOWTEX_INSTANCE_MODE=cluster requires FLOWTEX_YJS_WORKER=enabled (or cluster+REDIS_URL defaults, post-cutover)',
    );
  }

  // Redis setup
  if (process.env.REDIS_URL) {
    redisPub = new Redis(process.env.REDIS_URL);
    redisSub = new Redis(process.env.REDIS_URL);

    // Wire the same Redis connection into yjsRoomClient so its
    // XADD calls land somewhere. Without this, every applyUpdate
    // / encodeStateAsUpdate / releaseRoom in the remote backend
    // throws "Redis client not configured" -- caught by the
    // catch() inside the client and logged as a warn, so the
    // operator sees the WS frame counter tick but the stream
    // stays at XLEN=0. The 2026-06-08 Shape-2.5 live test surfaced
    // this gap.
    setYjsRoomClientRedis(redisPub);

    redisSub.subscribe(REDIS_CHANNEL);
    redisSub.subscribe(REDIS_CONTROL_CHANNEL);
    redisSub.on('message', (channel, raw) => {
      try {
        // Control-channel messages MUST be parsed and validated
        // strictly. Unlike the broadcast channel (which proxies
        // arbitrary client-facing payloads), the control channel
        // takes server-authoritative actions (closing connections),
        // so an unexpected shape silently does nothing.
        if (channel === REDIS_CONTROL_CHANNEL) {
          const ctrl = JSON.parse(raw);
          if (!ctrl || ctrl.fromServer === SERVER_ID) return;
          if (ctrl.type === 'kick-user-from-project'
              && typeof ctrl.projectId === 'string'
              && typeof ctrl.userId === 'string') {
            disconnectUserFromProjectLocal(ctrl.projectId, ctrl.userId);
          }
          return;
        }
        const { projectId, message, fromServer } = JSON.parse(raw);
        if (fromServer === SERVER_ID) return;
        const room = projectRooms.get(projectId);
        if (!room) return;
        const data = JSON.stringify(message);
        for (const client of room) {
          if (client.ws.readyState === 1) client.ws.send(data);
        }
      } catch (err) {
        logger.warn({ err, channel }, 'Redis message handler error');
      }
    });

    redisPub.on('error', (err) => logger.error({ err }, 'Redis pub error'));
    redisSub.on('error', (err) => logger.error({ err }, 'Redis sub error'));

    logger.info(
      { instanceMode },
      'Redis pub/sub enabled for WebSocket scaling',
    );
  } else {
    logger.info(
      { instanceMode },
      'No REDIS_URL set; running single-instance WebSocket broadcasts',
    );
  }

  // Verify Origin header to prevent cross-site WebSocket hijacking
  const appUrl = process.env.APP_URL || '';
  const allowedOrigins = new Set();
  if (appUrl) {
    try {
      const parsed = new URL(appUrl);
      allowedOrigins.add(parsed.origin);
    } catch {}
  }
  // Allow localhost connections only in explicit dev/test mode
  const isDevMode = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  if (isDevMode) {
    allowedOrigins.add(`https://localhost:${process.env.PORT || 3001}`);
    allowedOrigins.add(`http://localhost:${process.env.PORT || 3001}`);
  }

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    // 4 MiB ceiling: covers full-document replacements (e.g. "Format bibtex"
    // on a large .bib file dispatches the whole new content in a single OT
    // frame). Anything beyond this is almost certainly malicious.
    maxPayload: 4 * 1024 * 1024,
    verifyClient: ({ req }, cb) => {
      const origin = req.headers.origin;
      // Require Origin header outside explicit dev/test to prevent CSWSH.
      // Defaults to strict when NODE_ENV is unset.
      if (!origin) {
        if (!isDevMode) {
          logger.warn('WS connection rejected: missing origin');
          cb(false, 403, 'Forbidden');
          return;
        }
        cb(true);
        return;
      }
      if (!allowedOrigins.has(origin)) {
        logger.warn({ origin }, 'WS connection rejected: invalid origin');
        cb(false, 403, 'Forbidden');
        return;
      }
      cb(true);
    },
  });

  // Send a message to a specific user across all their WS connections
  function sendToUser(userId, message) {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client._flowtexUserId === userId && client.readyState === 1) {
        client.send(data);
      }
    }
  }

  // Forcibly close all of a user's WS connections (used when a user is
  // soft-deleted or restored — any in-flight session must not continue
  // reading data after auth state changes).
  function disconnectUserEverywhere(userId) {
    for (const client of wss.clients) {
      if (client._flowtexUserId === userId) {
        try {
          client.close(1000, 'session-revoked');
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Close every WS for `userId` EXCEPT the one tagged with `keepSessionId`.
  // Used after privilege-envelope changes (change-password,
  // change-email, totp-enable, totp-disable) where the calling device's
  // own WS should stay up — the user just authenticated to make the
  // change — but every OTHER device's WS must terminate, mirroring the
  // DELETE-FROM-session-WHERE-sid<>current pattern those routes use for
  // HTTP. Without this, an attacker holding a stolen session whose HTTP
  // path was just killed could keep editing files via their already-
  // upgraded WS until natural disconnect.
  function disconnectUserSessionsExcept(userId, keepSessionId) {
    for (const client of wss.clients) {
      if (shouldDisconnectExcept(client, userId, keepSessionId)) {
        try {
          client.close(1000, 'session-revoked');
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Expose helpers on app.locals
  app.locals.broadcastToRoom = broadcastToRoom;
  app.locals.disconnectUserFromProject = disconnectUserFromProject;
  app.locals.disconnectUserEverywhere = disconnectUserEverywhere;
  app.locals.disconnectUserSessionsExcept = disconnectUserSessionsExcept;
  app.locals.sendToUser = sendToUser;
  // Capture for module-scoped use (handleChat pushes mention notifications).
  sendToUserFn = sendToUser;

  // Expose live stats — only the aggregate counts are needed by the admin
  // dashboard. The per-user wsConnectionCounts map is intentionally NOT
  // surfaced: dumping userId → connection count to the admin live-monitor
  // is information disclosure with no UI consumer.
  app.getLiveStats = () => ({
    wsConnections: wss.clients.size,
    wsUniqueUsers: wsConnectionCounts.size,
  });

  // Heartbeat. .unref() so a lingering WS server in a test process can
  // still let the event loop exit (the wss.on('close') handler still
  // clears the timer on a clean shutdown).
  const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, WS_HEARTBEAT_INTERVAL).unref();

  wss.on('close', () => clearInterval(heartbeatTimer));

  // Server-level error: never let a single malformed frame take down the
  // process. The `ws` library emits 'wsClientError' for frame-decoding errors
  // (e.g. a payload larger than maxPayload). Logging + closing the socket is
  // the right response, not crashing the whole Node process.
  wss.on('wsClientError', (err, socket) => {
    logger.warn({ err: err.message, code: err.code }, 'WS client error — closing socket');
    try { socket.destroy(); } catch {}
  });
  wss.on('error', (err) => {
    logger.error({ err }, 'WS server error');
  });

  // Connection handler
  wss.on('connection', async (ws, req) => {
    bumpConnections(+1);
    ws.once('close', () => bumpConnections(-1));
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', (err) => {
      logger.warn({ err: err.message, code: err.code }, 'WS socket error — closing');
      try { ws.terminate(); } catch {}
    });

    // Buffer messages that arrive during async auth so they aren't
    // lost. Capped (count + per-message size) so a client that
    // floods bytes during the ~10-100 ms auth window can't blow
    // node's memory. Origin allowlist on verifyClient gates which
    // sites can even open the WS, so this is mainly a defence
    // against a logged-in user DoS'ing the box they're connected to.
    const MAX_PENDING_MESSAGES = 64;
    const MAX_PRE_AUTH_MESSAGE_BYTES = 256 * 1024;
    const pendingMessages = [];
    let preAuthAbort = false;
    let authenticated = false;
    ws.on('message', (raw) => {
      if (authenticated) {
        handleMessage(raw);
        return;
      }
      if (preAuthAbort) return;
      if (raw.length > MAX_PRE_AUTH_MESSAGE_BYTES) {
        preAuthAbort = true;
        pendingMessages.length = 0;
        try { ws.close(1009, 'Message too large'); } catch { /* already closed */ }
        return;
      }
      if (pendingMessages.length >= MAX_PENDING_MESSAGES) {
        preAuthAbort = true;
        pendingMessages.length = 0;
        try { ws.close(1008, 'Too many pre-auth messages'); } catch { /* already closed */ }
        return;
      }
      pendingMessages.push(raw);
    });

    const sess = await getSessionFromRequest(req, sessionSecret);
    if (!sess?.userId) {
      pendingMessages.length = 0;
      ws.send(JSON.stringify({ type: 'error', error: 'Not authenticated' }));
      ws.close();
      return;
    }
    const authenticatedUserId = sess.userId;

    const userRow = await db.get('SELECT name FROM users WHERE id = $1', [authenticatedUserId]);
    if (!userRow) {
      pendingMessages.length = 0;
      ws.send(JSON.stringify({ type: 'error', error: 'Not authenticated' }));
      ws.close();
      return;
    }
    const authenticatedUserName = userRow.name;

    // Connection count per user
    const currentCount = wsConnectionCounts.get(authenticatedUserId) || 0;
    if (currentCount >= MAX_WS_PER_USER) {
      pendingMessages.length = 0;
      ws.send(JSON.stringify({ type: 'error', error: 'Too many connections' }));
      ws.close();
      return;
    }
    wsConnectionCounts.set(authenticatedUserId, currentCount + 1);
    ws._flowtexUserId = authenticatedUserId;
    ws._flowtexSessionId = sess._sid || null;
    ws.on('close', () => {
      const c = (wsConnectionCounts.get(authenticatedUserId) || 1) - 1;
      if (c <= 0) wsConnectionCounts.delete(authenticatedUserId);
      else wsConnectionCounts.set(authenticatedUserId, c);
    });

    // Per-connection state
    const state = {
      authenticatedUserId,
      authenticatedUserName,
      projectId: null,
      clientEntry: null,
      memberRole: null,
    };

    let wsRateStart = Date.now();
    let wsRateCount = 0;

    async function handleMessage(raw) {
      // Rate limiting
      const now = Date.now();
      if (now - wsRateStart > WS_RATE_WINDOW) {
        wsRateCount = 0;
        wsRateStart = now;
      }
      wsRateCount++;
      if (wsRateCount > WS_RATE_MAX) return;

      if (raw.length > 256 * 1024) return;

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Basic message schema validation
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

      // A handler throwing (e.g. a transient DB error inside isFileInProject)
      // must not escape as an unhandled rejection — contain it per-message so
      // one bad message can't disrupt the connection's message pump.
      try {
        if (msg.type === 'join') {
          await handleJoin(ws, msg, state);
          return;
        }

        if (!state.projectId || !state.clientEntry) return;

        // Viewers can only send cursor / typing updates. For
        // write-types we re-check membership against the 5 s-TTL
        // cache (cheap when hot, refreshes after invalidateMembership).
        // This closes the "user role downgraded while WS open" gap
        // without making the cursor path pay for the lookup — cursor
        // frames are by far the chattiest message type and the
        // membership was already verified at join time. The
        // commenter role can use comment-react / reply-react / chat
        // / chat-react but NOT changes.
        if (writeTypes.has(msg.type)) {
          const member = await isProjectMember(state.projectId, state.authenticatedUserId);
          if (!member || !isAllowedWriteRole(msg.type, member.role)) return;
          // Refresh state.memberRole so a future read of it stays current
          // (e.g. handlers that gate on owner-only sub-actions).
          state.memberRole = member.role;
        }

        const handler = messageHandlers[msg.type];
        if (handler) {
          recordWsFrame(msg.type || 'unknown', 'in');
          await handler(msg, state, ws);
        }
      } catch (err) {
        logger.error(
          { err, msgType: msg.type, userId: state.authenticatedUserId },
          'WS message handler error',
        );
        reportException(err, {
          surface: 'ws-handler',
          msgType: msg?.type,
          userId: state.authenticatedUserId,
        });
      }
    }

    // Auth complete — drain buffered messages
    authenticated = true;
    for (const raw of pendingMessages) handleMessage(raw);
    pendingMessages.length = 0;

    ws.on('close', () => {
      if (state.projectId && state.clientEntry) {
        const room = projectRooms.get(state.projectId);
        if (room) {
          room.delete(state.clientEntry);
          if (room.size === 0) projectRooms.delete(state.projectId);
          else broadcastPresence(state.projectId);
        }
      }
      // YJS-MIGRATION phase 2: release every Y.Doc room this
      // connection was holding. The room service ref-counts these,
      // so the final close also flushes a snapshot to PG.
      releaseYjsRoomsForState(state).catch((err) =>
        logger.warn({ err }, 'releaseYjsRoomsForState failed'),
      );
    });
  });

  return { wss, redisPub, redisSub };
}

// Test exports — only populated in NODE_ENV=test so production callers see undefined.
export const _testing = process.env.NODE_ENV === 'test' ? {
  unsignCookie,
  handleChanges,
  handleYjsUpdate,
  handleYjsRequestState,
  ensureRoomSubscribed,
  releaseYjsRoomsForState,
  handleCursor,
  // handleComment / handleCommentReply / handleCommentResolve /
  // handleCommentDelete / handleCommentEdit were removed when their
  // broadcasts moved to the HTTP comment routes (see commit notes).
  handleChat,
  handleChatReact,
  handleCommentReact,
  handleReplyReact,
  handleTyping,
  handleJoin,
  writeTypes,
  isAllowedWriteRole,
  shouldDisconnectExcept,
  projectRooms,
  broadcastToRoom,
  getRoom,
  WS_RATE_WINDOW,
  WS_RATE_MAX,
} : undefined;
