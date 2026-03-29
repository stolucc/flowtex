import express from 'express';
import compression from 'compression';
import cors from 'cors';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import http from 'http';
import https from 'https';
import fs from 'fs';
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';
import pinoHttp from 'pino-http';
import cookie from 'cookie';
import logger from './logger.js';
import db from './db.js';
import projectsRouter from './routes/projects.js';
import compileRouter from './routes/compile.js';
import commentsRouter from './routes/comments.js';
import authRouter from './routes/auth.js';
import historyRouter from './routes/history.js';
import githubRouter from './routes/github.js';
import tagsRouter from './routes/tags.js';
import trackedChangesRouter from './routes/tracked-changes.js';
import adminRouter from './routes/admin.js';
import bibRouter from './routes/bib.js';
import zoteroRouter from './routes/zotero.js';
import cookieParser from 'cookie-parser';
import { requireAuth, requireAdmin, UUID_RE } from './middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3001;

// ── TLS enforcement in production ────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

// ── Security headers ────────────────────────────────────────────────────
const isProduction = process.env.NODE_ENV === 'production';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'self'", "blob:"],
      frameSrc: ["'self'", "blob:"],
      frameAncestors: ["'none'"],
      // Only upgrade insecure requests in production (breaks localhost on Safari)
      upgradeInsecureRequests: isProduction ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  // Disable HSTS in development (forces HTTPS, breaks localhost on Safari)
  strictTransportSecurity: isProduction,
}));

// ── CORS — restrict to known origins ────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3001,https://localhost:3001').split(',');
app.use(cors({
  origin(origin, cb) {
    // Allow requests with no origin in development (mobile apps, curl, same-origin)
    // In production, require a valid origin to prevent sandboxed-iframe attacks
    if (!origin && process.env.NODE_ENV !== 'production') return cb(null, true);
    if (origin && allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// ── Request logging ──────────────────────────────────────────────────────
app.use(pinoHttp({
  logger,
  autoLogging: { ignore: (req) => req.url === '/api/health' },
}));

// ── Session ─────────────────────────────────────────────────────────────
const SESSION_SECRET = process.env.SESSION_SECRET || 'flowtex-dev-secret-change-in-production';
const PgStore = pgSession(session);
const sessionMiddleware = session({
  name: '__session',
  store: new PgStore({ pool: db.pool, tableName: 'session' }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  },
});
app.use(sessionMiddleware);

// ── CSRF protection via double-submit token ─────────────────────────────
app.use((req, res, next) => {
  // Generate a CSRF token and set it as a readable cookie
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.cookie('csrf-token', req.session.csrfToken, {
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });

  // Verify on state-changing requests
  const csrfExempt = ['/api/auth/login', '/api/auth/register', '/api/auth/forgot-password', '/api/auth/reset-password'];
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.path.startsWith('/api/')) {
    if (csrfExempt.includes(req.path)) {
      // For CSRF-exempt endpoints, validate Origin header to prevent cross-site login attacks
      const origin = req.headers.origin;
      if (!origin) {
        return res.status(403).json({ error: 'Origin header required' });
      }
      const host = req.headers.host;
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          return res.status(403).json({ error: 'Origin mismatch' });
        }
      } catch {
        return res.status(403).json({ error: 'Invalid origin' });
      }
    } else {
      const token = req.headers['x-csrf-token'];
      if (token !== req.session.csrfToken) {
        return res.status(403).json({ error: 'Invalid CSRF token' });
      }
    }
  }
  next();
});

// ── Rate limiting ───────────────────────────────────────────────────────
const skipRateLimit = process.env.DISABLE_RATE_LIMIT === '1' && process.env.NODE_ENV !== 'production';
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipRateLimit,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipRateLimit,
});

// Auth routes (public, rate-limited)
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api/auth', authRouter);

// Protected API routes (general rate limit)
app.use('/api/', apiLimiter);
app.use('/api/projects', requireAuth, projectsRouter);
app.use('/api/compile', requireAuth, compileRouter);
app.use('/api/comments', requireAuth, commentsRouter);
app.use('/api/history', requireAuth, historyRouter);
app.use('/api/github', (req, res, next) => {
  // OAuth callback must bypass auth — user returns from GitHub redirect with a valid session
  if (req.path === '/oauth/callback') return next();
  requireAuth(req, res, next);
}, githubRouter);
app.use('/api/tags', requireAuth, tagsRouter);
app.use('/api/tracked-changes', requireAuth, trackedChangesRouter);
app.use('/api/bib', requireAuth, bibRouter);
app.use('/api/zotero', requireAuth, zoteroRouter);
app.use('/api/admin', requireAuth, requireAdmin, adminRouter);

// ── Chat history ────────────────────────────────────────────────────────
app.get('/api/chat/:projectId', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    if (!UUID_RE.test(projectId)) return res.status(400).json({ error: 'Invalid project ID' });
    const member = await db.get('SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, req.session.userId]);
    if (!member) return res.status(403).json({ error: 'Not a member' });
    const messages = await db.all(
      'SELECT id, user_id as "userId", user_name as "userName", text, created_at FROM chat_messages WHERE project_id = $1 ORDER BY created_at DESC LIMIT 500',
      [projectId]
    );
    messages.reverse();
    res.json(messages);
  } catch (err) {
    logger.error({ err }, 'Chat history error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Global search across project files ────────────────────────────────
app.get('/api/projects/:projectId/search', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    if (!UUID_RE.test(projectId)) return res.status(400).json({ error: 'Invalid project ID' });
    const member = await db.get('SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, req.session.userId]);
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const q = (req.query.q || '').trim();
    const scope = req.query.scope || 'all'; // 'tex' or 'all'
    const cs = req.query.cs === '1'; // case sensitive
    if (!q) return res.json([]);

    const files = await db.all(
      'SELECT id, path, content FROM files WHERE project_id = $1 AND is_binary = false',
      [projectId]
    );

    const results = [];
    const searchStr = cs ? q : q.toLowerCase();

    for (const file of files) {
      if (scope === 'tex' && !file.path.endsWith('.tex')) continue;
      if (!file.content) continue;

      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const haystack = cs ? line : line.toLowerCase();
        let pos = 0;
        while (pos < haystack.length) {
          const idx = haystack.indexOf(searchStr, pos);
          if (idx === -1) break;
          results.push({
            fileId: file.id,
            filePath: file.path,
            line: i + 1,
            col: idx,
            text: line.trim(),
          });
          pos = idx + 1;
          if (results.length >= 500) break;
        }
        if (results.length >= 500) break;
      }
      if (results.length >= 500) break;
    }

    res.json(results);
  } catch (err) {
    logger.error({ err }, 'Project search error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Health check endpoints (before catch-all) ───────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/ready', async (req, res) => {
  try {
    await db.get('SELECT 1');
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not ready', error: 'database unreachable' });
  }
});

// Serve built client in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(clientDist, 'index.html'));
  }
});

// Use HTTPS if certs are available, otherwise fall back to HTTP
const certPath = path.join(__dirname, 'certs', 'cert.pem');
const keyPath = path.join(__dirname, 'certs', 'key.pem');
const useHttps = fs.existsSync(certPath) && fs.existsSync(keyPath);
const server = useHttps
  ? https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
  : http.createServer(app);

// ── Redis pub/sub for horizontal scaling (optional) ─────────────────────
let redisPub = null;
let redisSub = null;
const REDIS_CHANNEL = 'flowtex:ws';
const SERVER_ID = crypto.randomUUID();

if (process.env.REDIS_URL) {
  redisPub = new Redis(process.env.REDIS_URL);
  redisSub = new Redis(process.env.REDIS_URL);

  redisSub.subscribe(REDIS_CHANNEL);
  redisSub.on('message', (channel, raw) => {
    try {
      const { projectId, message, fromServer } = JSON.parse(raw);
      if (fromServer === SERVER_ID) return; // Ignore own messages
      // Deliver to local clients
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

// ── WebSocket with session-based auth ───────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 /* 256KB */ });

// Map: projectId -> Set of { ws, userId, userName }
const projectRooms = new Map();

function getRoom(projectId) {
  if (!projectRooms.has(projectId)) {
    projectRooms.set(projectId, new Set());
  }
  return projectRooms.get(projectId);
}

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
  // Publish to Redis for other server instances
  if (redisPub) {
    redisPub.publish(REDIS_CHANNEL, JSON.stringify({
      projectId,
      message: sanitized,
      fromServer: SERVER_ID,
    })).catch(() => {});
  }
}

app.locals.broadcastToRoom = broadcastToRoom;

// Disconnect a specific user from a project's WebSocket room
app.locals.disconnectUserFromProject = function(projectId, userId) {
  const room = projectRooms.get(projectId);
  if (!room) return;
  for (const client of room) {
    if (client.userId === userId) {
      client.ws.close(4003, 'Removed from project');
    }
  }
};

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

// Parse session directly from the WebSocket upgrade request cookie.
// We bypass sessionMiddleware entirely because connect-pg-simple's store
// silently hangs when used outside a real Express request/response cycle.
// Instead we parse the __session cookie, verify its HMAC signature,
// and look up the session row in PostgreSQL directly.
function unsignCookie(signedValue, secret) {
  // express-session signs cookies as s:<id>.<base64url-hmac>
  // The raw cookie value (after URL-decoding) starts with "s:"
  if (!signedValue.startsWith('s:')) return null;
  const val = signedValue.slice(2); // remove "s:"
  const dotIdx = val.lastIndexOf('.');
  if (dotIdx === -1) return null;
  const id = val.slice(0, dotIdx);
  const mac = val.slice(dotIdx + 1);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(id)
    .digest('base64')
    .replace(/=+$/, '');
  // Timing-safe comparison
  if (mac.length !== expected.length) return null;
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expected);
  if (!crypto.timingSafeEqual(macBuf, expectedBuf)) return null;
  return id;
}

async function getSessionFromRequest(req) {
  try {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;
    const cookies = cookie.parse(cookieHeader);
    const raw = cookies['__session'];
    if (!raw) return null;

    const sessionId = unsignCookie(raw, SESSION_SECRET);
    if (!sessionId) {
      logger.warn('WS session: invalid cookie signature');
      return null;
    }

    // Look up session directly from PostgreSQL
    const row = await db.get('SELECT sess FROM session WHERE sid = $1', [sessionId]);
    if (!row) return null;

    const sess = typeof row.sess === 'string' ? JSON.parse(row.sess) : row.sess;
    return sess;
  } catch (err) {
    logger.warn({ err }, 'WS session parse error');
    return null;
  }
}

// ── WebSocket heartbeat — detect dead connections ────────────────────────
const WS_HEARTBEAT_INTERVAL = 30000;
const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, WS_HEARTBEAT_INTERVAL);

wss.on('close', () => clearInterval(heartbeatTimer));

// Track WebSocket connections per user for DoS prevention
const wsConnectionCounts = new Map();
const MAX_WS_PER_USER = 10;

// Expose live connection stats for admin dashboard
app.getLiveStats = () => ({
  wsConnections: wss.clients.size,
  wsUniqueUsers: wsConnectionCounts.size,
  wsConnectionCounts: Object.fromEntries(wsConnectionCounts),
});

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

  // Authenticate via session cookie (not client-supplied userId)
  const sess = await getSessionFromRequest(req);
  if (!sess?.userId) {
    ws.send(JSON.stringify({ type: 'error', error: 'Not authenticated' }));
    ws.close();
    return;
  }

  const authenticatedUserId = sess.userId;

  // Limit connections per user
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

  // Look up user name
  const userRow = await db.get('SELECT name FROM users WHERE id = $1', [authenticatedUserId]);
  const authenticatedUserName = userRow?.name || 'Unknown';

  let projectId = null;
  let clientEntry = null;

  // Per-connection rate limiting: max 30 messages/second
  const WS_RATE_WINDOW = 1000;
  const WS_RATE_MAX = 30;
  let wsRateCount = 0;
  let wsRateStart = Date.now();
  let memberRole = null; // set after join

  authenticated = true;
  // Drain any messages that arrived during auth
  for (const raw of pendingMessages) handleMessage(raw);
  pendingMessages.length = 0;

  async function handleMessage(raw) {
    // Rate limiting
    const now = Date.now();
    if (now - wsRateStart > WS_RATE_WINDOW) {
      wsRateCount = 0;
      wsRateStart = now;
    }
    wsRateCount++;
    if (wsRateCount > WS_RATE_MAX) return;

    // Reject oversized messages (max 1MB)
    if (raw.length > 256 * 1024) return;

    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'join') {
      if (typeof msg.projectId !== 'string' || !UUID_RE.test(msg.projectId)) return;

      // Leave previous room if re-joining a different project
      if (projectId && clientEntry) {
        const oldRoom = projectRooms.get(projectId);
        if (oldRoom) {
          oldRoom.delete(clientEntry);
          if (oldRoom.size === 0) projectRooms.delete(projectId);
          broadcastPresence(projectId);
        }
      }

      projectId = msg.projectId;

      // Verify project membership and role using authenticated session user
      const member = await db.get(
        'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
        [projectId, authenticatedUserId]
      );
      if (!member) {
        ws.send(JSON.stringify({ type: 'error', error: 'No access' }));
        ws.close();
        return;
      }

      memberRole = member.role;
      clientEntry = { ws, userId: authenticatedUserId, userName: authenticatedUserName, cursor: null };
      getRoom(projectId).add(clientEntry);
      ws.send(JSON.stringify({ type: 'joined', userId: authenticatedUserId, userName: authenticatedUserName }));
      // Send existing cursor positions to the newly joined client
      const room = projectRooms.get(projectId);
      if (room) {
        for (const c of room) {
          if (c !== clientEntry && c.cursor) {
            ws.send(JSON.stringify({ type: 'cursor', userId: c.userId, userName: c.userName, ...c.cursor }));
          }
        }
      }
      broadcastPresence(projectId);
      return;
    }

    if (!projectId || !clientEntry) return;

    // Viewers can only send cursor updates — all other writes require editor/owner role
    const isViewer = memberRole === 'viewer';
    const writeTypes = ['changes', 'comment', 'comment-reply', 'comment-resolve', 'comment-delete', 'comment-edit', 'tracked-change', 'tracked-change-resolve'];
    if (isViewer && writeTypes.includes(msg.type)) return;

    if (msg.type === 'changes') {
      // Validate changes structure
      if (!Array.isArray(msg.changes) || msg.changes.length > 1000) return;
      const valid = msg.changes.every(c =>
        c && typeof c === 'object' &&
        (c.from === undefined || typeof c.from === 'number') &&
        (c.to === undefined || typeof c.to === 'number') &&
        (c.insert === undefined || (typeof c.insert === 'string' && c.insert.length <= 500000))
      );
      if (!valid) return;

      broadcastToRoom(projectId, {
        type: 'changes',
        fileId: msg.fileId,
        changes: msg.changes,
        userId: clientEntry.userId,
      }, ws);
    }

    if (msg.type === 'cursor') {
      clientEntry.cursor = { fileId: msg.fileId, head: msg.head, anchor: msg.anchor };
      broadcastToRoom(projectId, {
        type: 'cursor',
        fileId: msg.fileId,
        userId: clientEntry.userId,
        userName: clientEntry.userName,
        head: msg.head,
        anchor: msg.anchor,
      }, ws);
    }

    if (msg.type === 'comment') {
      if (!msg.comment || JSON.stringify(msg.comment).length > 10000) return;
      broadcastToRoom(projectId, {
        type: 'comment',
        fileId: msg.fileId,
        comment: msg.comment,
      }, ws);
    }

    if (msg.type === 'comment-reply') {
      if (!msg.reply || JSON.stringify(msg.reply).length > 10000) return;
      broadcastToRoom(projectId, {
        type: 'comment-reply',
        commentId: msg.commentId,
        reply: msg.reply,
      }, ws);
    }

    if (msg.type === 'comment-resolve') {
      if (typeof msg.resolved !== 'boolean') return;
      broadcastToRoom(projectId, {
        type: 'comment-resolve',
        commentId: msg.commentId,
        resolved: msg.resolved,
      }, ws);
    }

    if (msg.type === 'comment-delete') {
      if (!msg.commentId) return;
      broadcastToRoom(projectId, {
        type: 'comment-delete',
        commentId: msg.commentId,
      }, ws);
    }

    if (msg.type === 'comment-edit') {
      if (typeof msg.text !== 'string' || msg.text.length > 10000) return;
      broadcastToRoom(projectId, {
        type: 'comment-edit',
        commentId: msg.commentId,
        text: msg.text,
      }, ws);
    }

    if (msg.type === 'tracked-change') {
      broadcastToRoom(projectId, {
        type: 'tracked-change',
        fileId: msg.fileId,
        change: msg.change,
      }, ws);
    }

    if (msg.type === 'tracked-change-resolve') {
      if (!['accepted', 'rejected'].includes(msg.status)) return;
      broadcastToRoom(projectId, {
        type: 'tracked-change-resolve',
        changeId: msg.changeId,
        status: msg.status,
      }, ws);
    }

    if (msg.type === 'chat') {
      const id = crypto.randomUUID();
      const text = (msg.text || '').trim().slice(0, 5000);
      if (!text) return;
      try {
        await db.run(
          'INSERT INTO chat_messages (id, project_id, user_id, user_name, text) VALUES ($1, $2, $3, $4, $5)',
          [id, projectId, authenticatedUserId, authenticatedUserName, text]
        );
        const chatMsg = { type: 'chat', id, userId: authenticatedUserId, userName: authenticatedUserName, text, created_at: new Date().toISOString() };
        broadcastToRoom(projectId, chatMsg);
      } catch (e) {
        logger.error({ err: e }, 'Chat insert error');
      }
    }
  }

  ws.on('close', () => {
    if (projectId && clientEntry) {
      const room = projectRooms.get(projectId);
      if (room) {
        room.delete(clientEntry);
        if (room.size === 0) projectRooms.delete(projectId);
        else broadcastPresence(projectId);
      }
    }
  });
});

// ── Global error handlers ────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  process.exit(1);
});

// ── Graceful shutdown ────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);

  // Force exit after 10 seconds if graceful shutdown stalls
  setTimeout(() => {
    logger.warn('Shutdown timeout — forcing exit');
    process.exit(1);
  }, 10000).unref();

  // 1. Stop accepting new connections
  server.close(() => logger.info('HTTP server closed'));

  // 2. Close all WebSocket connections
  for (const client of wss.clients) {
    client.close(1001, 'Server shutting down');
  }

  // 3. Close Redis connections
  if (redisPub) { redisPub.disconnect(); }
  if (redisSub) { redisSub.disconnect(); }

  // 4. Drain the database pool
  await db.pool.end().catch(() => {});

  logger.info('Cleanup complete — exiting');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Startup env-var validation ────────────────────────────────────────────
{
  const isProduction = process.env.NODE_ENV === 'production';
  // Production: require all secrets
  if (isProduction) {
    const required = ['SESSION_SECRET', 'ENCRYPTION_KEY'];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length) {
      logger.fatal(`Missing required env vars: ${missing.join(', ')}`);
      process.exit(1);
    }
  }
  // Any environment: reject known default/weak secrets
  const defaults = ['flowtex-dev-secret-change-in-production', 'underleaf-dev-secret-change-in-production'];
  if (isProduction && defaults.includes(process.env.SESSION_SECRET)) {
    logger.fatal('SESSION_SECRET must be changed from the default in production');
    process.exit(1);
  }
  // Warn on short secrets (< 32 bytes = 64 hex chars)
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 32) {
    logger.warn('SESSION_SECRET is very short (< 32 chars) — use at least 64 hex chars');
  }
  if (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length < 32) {
    logger.warn('ENCRYPTION_KEY is very short (< 32 chars) — use at least 64 hex chars');
  }
  // Warn if ENCRYPTION_KEY is missing in dev
  if (!isProduction && !process.env.ENCRYPTION_KEY) {
    logger.warn('ENCRYPTION_KEY not set — using insecure dev fallback. Set it in .env');
  }
}

// Initialize database schema, then start server
db.initSchema().then(() => {
  server.listen(PORT, () => {
    const proto = useHttps ? 'https' : 'http';
    logger.info(`FlowTex server running on ${proto}://localhost:${PORT}`);
  });
}).catch((err) => {
  logger.fatal({ err }, 'Failed to initialize database');
  process.exit(1);
});
