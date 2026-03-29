import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';
import cookie from 'cookie';
import logger from './logger.js';
import db from './db.js';
import { UUID_RE } from './middleware/auth.js';

// ── Redis pub/sub for horizontal scaling (optional) ─────────────────────
let redisPub = null;
let redisSub = null;
const REDIS_CHANNEL = 'flowtex:ws';
const SERVER_ID = crypto.randomUUID();

// ── Room management ─────────────────────────────────────────────────────
const projectRooms = new Map();

function getRoom(projectId) {
  if (!projectRooms.has(projectId)) {
    projectRooms.set(projectId, new Set());
  }
  return projectRooms.get(projectId);
}

// ── Message sanitization ────────────────────────────────────────────────
function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sanitizeValue(val) {
  if (typeof val === 'string') return sanitizeString(val);
  if (Array.isArray(val)) return val.map(sanitizeValue);
  if (val && typeof val === 'object') return sanitizeMessage(val);
  return val;
}

function sanitizeMessage(msg) {
  const sanitized = {};
  for (const [key, val] of Object.entries(msg)) {
    sanitized[key] = sanitizeValue(val);
  }
  return sanitized;
}

function broadcastToRoom(projectId, message, excludeWs) {
  const sanitized = sanitizeMessage(message);
  const room = projectRooms.get(projectId);
  if (room) {
    const data = JSON.stringify(sanitized);
    for (const client of room) {
      if (client.ws !== excludeWs && client.ws.readyState === 1) {
        client.ws.send(data);
      }
    }
  }
  if (redisPub) {
    redisPub.publish(REDIS_CHANNEL, JSON.stringify({
      projectId,
      message: sanitized,
      fromServer: SERVER_ID,
    })).catch(() => {});
  }
}

function disconnectUserFromProject(projectId, userId) {
  const room = projectRooms.get(projectId);
  if (!room) return;
  for (const client of room) {
    if (client.userId === userId) {
      client.ws.close(4003, 'Removed from project');
    }
  }
}

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
function unsignCookie(signedValue, secret) {
  if (!signedValue.startsWith('s:')) return null;
  const val = signedValue.slice(2);
  const dotIdx = val.lastIndexOf('.');
  if (dotIdx === -1) return null;
  const id = val.slice(0, dotIdx);
  const mac = val.slice(dotIdx + 1);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(id)
    .digest('base64')
    .replace(/=+$/, '');
  if (mac.length !== expected.length) return null;
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expected);
  if (!crypto.timingSafeEqual(macBuf, expectedBuf)) return null;
  return id;
}

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

    const row = await db.get('SELECT sess FROM session WHERE sid = $1', [sessionId]);
    if (!row) return null;

    const sess = typeof row.sess === 'string' ? JSON.parse(row.sess) : row.sess;
    return sess;
  } catch (err) {
    logger.warn({ err }, 'WS session parse error');
    return null;
  }
}

// ── Message handlers ────────────────────────────────────────────────────
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

  const member = await db.get(
    'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
    [state.projectId, state.authenticatedUserId]
  );
  if (!member) {
    ws.send(JSON.stringify({ type: 'error', error: 'No access' }));
    ws.close();
    return;
  }

  state.memberRole = member.role;
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

function handleChanges(msg, state, ws) {
  if (!Array.isArray(msg.changes) || msg.changes.length > 1000) return;
  const valid = msg.changes.every(c =>
    c && typeof c === 'object' &&
    (c.from === undefined || typeof c.from === 'number') &&
    (c.to === undefined || typeof c.to === 'number') &&
    (c.insert === undefined || (typeof c.insert === 'string' && c.insert.length <= 500000))
  );
  if (!valid) return;

  broadcastToRoom(state.projectId, {
    type: 'changes',
    fileId: msg.fileId,
    changes: msg.changes,
    userId: state.clientEntry.userId,
  }, ws);
}

function handleCursor(msg, state, ws) {
  state.clientEntry.cursor = { fileId: msg.fileId, head: msg.head, anchor: msg.anchor };
  broadcastToRoom(state.projectId, {
    type: 'cursor',
    fileId: msg.fileId,
    userId: state.clientEntry.userId,
    userName: state.clientEntry.userName,
    head: msg.head,
    anchor: msg.anchor,
  }, ws);
}

function handleComment(msg, state, ws) {
  if (!msg.comment || JSON.stringify(msg.comment).length > 10000) return;
  broadcastToRoom(state.projectId, { type: 'comment', fileId: msg.fileId, comment: msg.comment }, ws);
}

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

function handleTrackedChange(msg, state, ws) {
  broadcastToRoom(state.projectId, { type: 'tracked-change', fileId: msg.fileId, change: msg.change }, ws);
}

function handleTrackedChangeResolve(msg, state, ws) {
  if (!['accepted', 'rejected'].includes(msg.status)) return;
  broadcastToRoom(state.projectId, { type: 'tracked-change-resolve', changeId: msg.changeId, status: msg.status }, ws);
}

async function handleChat(msg, state) {
  const id = crypto.randomUUID();
  const text = (msg.text || '').trim().slice(0, 5000);
  if (!text) return;
  try {
    await db.run(
      'INSERT INTO chat_messages (id, project_id, user_id, user_name, text) VALUES ($1, $2, $3, $4, $5)',
      [id, state.projectId, state.authenticatedUserId, state.authenticatedUserName, text]
    );
    const chatMsg = { type: 'chat', id, userId: state.authenticatedUserId, userName: state.authenticatedUserName, text, created_at: new Date().toISOString() };
    broadcastToRoom(state.projectId, chatMsg);
  } catch (e) {
    logger.error({ err: e }, 'Chat insert error');
  }
}

const writeTypes = new Set(['changes', 'comment', 'comment-reply', 'comment-resolve', 'comment-delete', 'comment-edit', 'tracked-change', 'tracked-change-resolve']);

const messageHandlers = {
  changes: handleChanges,
  cursor: handleCursor,
  comment: handleComment,
  'comment-reply': handleCommentReply,
  'comment-resolve': handleCommentResolve,
  'comment-delete': handleCommentDelete,
  'comment-edit': handleCommentEdit,
  'tracked-change': handleTrackedChange,
  'tracked-change-resolve': handleTrackedChangeResolve,
  chat: handleChat,
};

// ── Main export ─────────────────────────────────────────────────────────
const WS_RATE_WINDOW = 1000;
const WS_RATE_MAX = 30;
const MAX_WS_PER_USER = 10;
const WS_HEARTBEAT_INTERVAL = 30000;

const wsConnectionCounts = new Map();

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

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

  // Expose helpers on app.locals
  app.locals.broadcastToRoom = broadcastToRoom;
  app.locals.disconnectUserFromProject = disconnectUserFromProject;

  // Expose live stats
  app.getLiveStats = () => ({
    wsConnections: wss.clients.size,
    wsUniqueUsers: wsConnectionCounts.size,
    wsConnectionCounts: Object.fromEntries(wsConnectionCounts),
  });

  // Heartbeat
  const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, WS_HEARTBEAT_INTERVAL);

  wss.on('close', () => clearInterval(heartbeatTimer));

  // Connection handler
  wss.on('connection', async (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

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
      ws.send(JSON.stringify({ type: 'error', error: 'Not authenticated' }));
      ws.close();
      return;
    }
    const authenticatedUserId = sess.userId;

    const userRow = await db.get('SELECT name FROM users WHERE id = $1', [authenticatedUserId]);
    if (!userRow) {
      ws.send(JSON.stringify({ type: 'error', error: 'Not authenticated' }));
      ws.close();
      return;
    }
    const authenticatedUserName = userRow.name;

    // Connection count per user
    const currentCount = wsConnectionCounts.get(authenticatedUserId) || 0;
    if (currentCount >= MAX_WS_PER_USER) {
      ws.send(JSON.stringify({ type: 'error', error: 'Too many connections' }));
      ws.close();
      return;
    }
    wsConnectionCounts.set(authenticatedUserId, currentCount + 1);
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
      try { msg = JSON.parse(raw.toString()); } catch { return; }

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
