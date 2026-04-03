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
import pinoHttp from 'pino-http';
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
import setupRouter from './routes/setup.js';
import bibRouter from './routes/bib.js';
import zoteroRouter from './routes/zotero.js';
import chatRouter from './routes/chat.js';
import cookieParser from 'cookie-parser';
import { requireAuth, requireAdmin } from './middleware/auth.js';
import { initWebSocket } from './websocket.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3001;

// Trust reverse proxy (Caddy) — required for secure cookies and correct IP detection
app.set('trust proxy', 1);

// ── TLS enforcement in production ────────────────────────────────────────
if (process.env.NODE_ENV === 'production' && !process.env.DISABLE_TLS_REDIRECT) {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

// ── Security headers ────────────────────────────────────────────────────
const isProduction = process.env.NODE_ENV === 'production';
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", ...(isProduction ? [] : ['ws:', 'wss:'])],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'self'", 'blob:'],
        frameSrc: ["'self'", 'blob:'],
        frameAncestors: ["'none'"],
        // Only upgrade insecure requests in production (breaks localhost on Safari)
        upgradeInsecureRequests: isProduction ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    // Disable HSTS in development (forces HTTPS, breaks localhost on Safari)
    strictTransportSecurity: isProduction,
  }),
);

// Additional security headers not covered by Helmet defaults
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

// ── CORS — restrict to known origins ────────────────────────────────────
const allowedOrigins = (
  process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3001,https://localhost:3001'
).split(',');
app.use(
  cors({
    origin(origin, cb) {
      // No Origin header = same-origin request (browser navigation, fetch from same host, curl, healthchecks)
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }),
);

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// ── Request logging ──────────────────────────────────────────────────────
app.use(
  pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === '/api/health' },
  }),
);

// ── Session ─────────────────────────────────────────────────────────────
if (!process.env.SESSION_SECRET) {
  logger.fatal("SESSION_SECRET must be set. Generate one with: node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\"");
  process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET;
const PgStore = pgSession(session);
const sessionMiddleware = session({
  name: '__session',
  store: new PgStore({ pool: db.pool, tableName: 'session' }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true, // Reset maxAge on every request (activity-based expiry)
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours of inactivity
    sameSite: 'lax',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  },
});
app.use(sessionMiddleware);

// Enforce absolute session lifetime (7 days) regardless of activity
const ABSOLUTE_SESSION_MAX = 7 * 24 * 60 * 60 * 1000;
app.use((req, res, next) => {
  if (req.session.userId && req.session.createdAt) {
    if (Date.now() - req.session.createdAt > ABSOLUTE_SESSION_MAX) {
      return req.session.destroy(() => res.status(401).json({ error: 'Session expired' }));
    }
  }
  if (req.session.userId && !req.session.createdAt) {
    req.session.createdAt = Date.now();
  }
  next();
});

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
  const csrfExempt = ['/api/auth/login', '/api/auth/register', '/api/auth/forgot-password', '/api/auth/reset-password', '/api/setup/init'];
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

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many uploads, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipRateLimit,
});

// Auth routes (public, rate-limited)
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api/auth/resend-verification', authLimiter);
app.use('/api/auth', authRouter);

// Setup routes (public, rate-limited — only functional before first admin exists)
app.use('/api/setup/init', authLimiter);
app.use('/api/setup', setupRouter);

// Upload rate limits (stricter — 10 per 15 minutes)
app.use('/api/projects/from-zip', uploadLimiter);
app.post('/api/projects/:id/upload-zip', uploadLimiter);
app.post('/api/projects/:id/upload-file', uploadLimiter);

// Protected API routes (general rate limit)
app.use('/api/', apiLimiter);
app.use('/api/projects', requireAuth, projectsRouter);
app.use('/api/compile', requireAuth, compileRouter);
app.use('/api/comments', requireAuth, commentsRouter);
app.use('/api/history', requireAuth, historyRouter);
app.use(
  '/api/github',
  (req, res, next) => {
    // OAuth callback must bypass auth — user returns from GitHub redirect with a valid session
    if (req.path === '/oauth/callback') return next();
    requireAuth(req, res, next);
  },
  githubRouter,
);
app.use('/api/tags', requireAuth, tagsRouter);
app.use('/api/tracked-changes', requireAuth, trackedChangesRouter);
app.use('/api/chat', requireAuth, chatRouter);
app.use('/api/bib', requireAuth, bibRouter);
app.use('/api/zotero', requireAuth, zoteroRouter);
app.use('/api/admin', requireAuth, requireAdmin, adminRouter);

// ── Health check endpoints (before catch-all) ───────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
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
const clientDistPrimary = path.join(__dirname, '..', 'client', 'dist');
const clientDistFallback = path.join(__dirname, 'public');
const clientDist = fs.existsSync(clientDistPrimary) ? clientDistPrimary : clientDistFallback;
app.use(express.static(clientDist));

// Global error handler — catches unhandled errors in route handlers
app.use((err, req, res, _next) => {
  logger.error({ err, method: req.method, url: req.url }, 'Unhandled route error');
  if (!res.headersSent) {
    res.status(err.status || 500).json({ error: 'Internal server error' });
  }
});

// Block common scanner probes — return 404 instead of SPA fallback
const blockedPathPattern = /(?:^|\/)(?:\.env|\.git|\.aws|\.ssh|\.docker|\.kube|\.npmrc|\.htaccess|\.htpasswd|wp-admin|wp-login|wp-includes|phpinfo|phpmyadmin|cgi-bin|config\.env|credentials|\.DS_Store|Thumbs\.db|\.svn|\.hg|web\.config|\.well-known\/(?!acme-challenge))/i;
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return;
  if (blockedPathPattern.test(req.path)) return res.status(404).end();
  res.sendFile(path.join(clientDist, 'index.html'));
});

// Use HTTPS if certs are available, otherwise fall back to HTTP
const certPath = path.join(__dirname, 'certs', 'cert.pem');
const keyPath = path.join(__dirname, 'certs', 'key.pem');
const useHttps = fs.existsSync(certPath) && fs.existsSync(keyPath);
const server = useHttps
  ? https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
  : http.createServer(app);

// ── WebSocket setup ──────────────────────────────────────────────────────
const { wss, redisPub, redisSub } = initWebSocket(server, app, SESSION_SECRET);

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
  if (redisPub) {
    redisPub.disconnect();
  }
  if (redisSub) {
    redisSub.disconnect();
  }

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
  // Warn on short secrets (< 32 bytes = 64 hex chars)
  if (process.env.SESSION_SECRET.length < 32) {
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

// Initialize database schema, seed templates, then start server
import seedPreloadedTemplates from './utils/seedTemplates.js';
import { initCrypto } from './utils/crypto.js';
db.initSchema()
  .then(() => initCrypto())
  .then(() => seedPreloadedTemplates())
  .then(() => {
    db.startCleanupJob();
    server.listen(PORT, () => {
      const proto = useHttps ? 'https' : 'http';
      logger.info(`FlowTex server running on ${proto}://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    logger.fatal({ err }, 'Failed to initialize database');
    process.exit(1);
  });
