import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';
import cookie from 'cookie';
import signature from 'cookie-signature';
import logger from './logger.js';
import db from './db.js';
import { UUID_RE } from './middleware/auth.js';
import { recordMentions } from './utils/mentions.js';

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

/** Close all WebSocket connections for a user in a specific project room. */
function disconnectUserFromProject(projectId, userId) {
  const room = projectRooms.get(projectId);
  if (!room) return;
  for (const client of room) {
    if (client.userId === userId) {
      client.ws.close(4003, 'Removed from project');
    }
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
    return sess;
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
  // for real-time collaborative tracked changes. Validate shape but
  // trust contents (server doesn't model TC entries beyond pass-through).
  let tcMarks;
  if (msg.tcMarks && typeof msg.tcMarks === 'object') {
    const added = Array.isArray(msg.tcMarks.added) ? msg.tcMarks.added.slice(0, 1000) : [];
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

/** Broadcast a new comment to other clients in the room. */
async function handleComment(msg, state, ws) {
  if (!msg.comment || JSON.stringify(msg.comment).length > 10000) return;
  if (!(await isFileInProject(state, msg.fileId))) return;
  broadcastToRoom(state.projectId, { type: 'comment', fileId: msg.fileId, comment: msg.comment }, ws);
}

/** Broadcast a comment reply to other clients in the room. */
function handleCommentReply(msg, state, ws) {
  if (!msg.reply || JSON.stringify(msg.reply).length > 10000) return;
  broadcastToRoom(state.projectId, { type: 'comment-reply', commentId: msg.commentId, reply: msg.reply }, ws);
}

function handleCommentResolve(msg, state, ws) {
  if (typeof msg.resolved !== 'boolean') return;
  broadcastToRoom(state.projectId, { type: 'comment-resolve', commentId: msg.commentId, resolved: msg.resolved }, ws);
}

function handleCommentDelete(msg, state, ws) {
  if (!msg.commentId) return;
  broadcastToRoom(state.projectId, { type: 'comment-delete', commentId: msg.commentId }, ws);
}

function handleCommentEdit(msg, state, ws) {
  if (typeof msg.text !== 'string' || msg.text.length > 10000) return;
  broadcastToRoom(state.projectId, { type: 'comment-edit', commentId: msg.commentId, text: msg.text }, ws);
}

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

const writeTypes = new Set([
  'changes',
  'comment',
  'comment-reply',
  'comment-resolve',
  'comment-delete',
  'comment-edit',
  'comment-react',
  'reply-react',
  // chat persists to chat_messages; viewers should be read-only.
  'chat',
  'chat-react',
]);

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
  cursor: handleCursor,
  comment: handleComment,
  'comment-reply': handleCommentReply,
  'comment-resolve': handleCommentResolve,
  'comment-delete': handleCommentDelete,
  'comment-edit': handleCommentEdit,
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
  // Redis setup
  if (process.env.REDIS_URL) {
    redisPub = new Redis(process.env.REDIS_URL);
    redisSub = new Redis(process.env.REDIS_URL);

    redisSub.subscribe(REDIS_CHANNEL);
    redisSub.on('message', (channel, raw) => {
      try {
        const { projectId, message, fromServer } = JSON.parse(raw);
        if (fromServer === SERVER_ID) return;
        const room = projectRooms.get(projectId);
        if (!room) return;
        const data = JSON.stringify(message);
        for (const client of room) {
          if (client.ws.readyState === 1) client.ws.send(data);
        }
      } catch (err) {
        logger.warn({ err }, 'Redis message handler error');
      }
    });

    redisPub.on('error', (err) => logger.error({ err }, 'Redis pub error'));
    redisSub.on('error', (err) => logger.error({ err }, 'Redis sub error'));

    logger.info('Redis pub/sub enabled for WebSocket scaling');
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

  // Expose helpers on app.locals
  app.locals.broadcastToRoom = broadcastToRoom;
  app.locals.disconnectUserFromProject = disconnectUserFromProject;
  app.locals.disconnectUserEverywhere = disconnectUserEverywhere;
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
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', (err) => {
      logger.warn({ err: err.message, code: err.code }, 'WS socket error — closing');
      try { ws.terminate(); } catch {}
    });

    // Buffer messages that arrive during async auth so they aren't lost
    const pendingMessages = [];
    let authenticated = false;
    ws.on('message', (raw) => {
      if (!authenticated) {
        pendingMessages.push(raw);
      } else {
        handleMessage(raw);
      }
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

        // Viewers can only send cursor updates
        if (state.memberRole === 'viewer' && writeTypes.has(msg.type)) return;

        const handler = messageHandlers[msg.type];
        if (handler) {
          await handler(msg, state, ws);
        }
      } catch (err) {
        logger.error(
          { err, msgType: msg.type, userId: state.authenticatedUserId },
          'WS message handler error',
        );
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
    });
  });

  return { wss, redisPub, redisSub };
}

// Test exports — only populated in NODE_ENV=test so production callers see undefined.
export const _testing = process.env.NODE_ENV === 'test' ? {
  unsignCookie,
  handleChanges,
  handleCursor,
  handleComment,
  handleCommentReply,
  handleCommentResolve,
  handleCommentDelete,
  handleCommentEdit,
  handleChat,
  handleChatReact,
  handleCommentReact,
  handleReplyReact,
  handleTyping,
  handleJoin,
  writeTypes,
  projectRooms,
  broadcastToRoom,
  getRoom,
  WS_RATE_WINDOW,
  WS_RATE_MAX,
} : undefined;
