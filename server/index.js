import express from 'express';
import compression from 'compression';
import cors from 'cors';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { isLocalCompileEnabled } from './utils/featureFlags.js';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import http from 'http';
import https from 'https';
import fs from 'fs';
import pinoHttp from 'pino-http';
import logger from './logger.js';
import db from './db.js';
import { abortAllCompilations } from './compiler.js';
import projectsRouter from './routes/projects.js';
import compileRouter from './routes/compile.js';
import commentsRouter from './routes/comments.js';
import authRouter from './routes/auth.js';
import historyRouter from './routes/history.js';
import githubRouter from './routes/github.js';
import tagsRouter from './routes/tags.js';
import adminRouter from './routes/admin.js';
import setupRouter from './routes/setup.js';
import bibRouter from './routes/bib.js';
import zoteroRouter from './routes/zotero.js';
import chatRouter from './routes/chat.js';
import notificationsRouter from './routes/notifications.js';
import bugReportsRouter from './routes/bugReports.js';
import cookieParser from 'cookie-parser';
import { requireAuth, requireAdmin } from './middleware/auth.js';
import { initWebSocket } from './websocket.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

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

// Generate a per-request CSP nonce so the SPA's <script> tags get a unique
// nonce per page load. Combined with `script-src 'self' 'nonce-XXX'`, this
// blocks any accidental inline <script> a future code change might add —
// belt-and-braces over the existing 'self'-only script source.
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          // Nonce is injected into served HTML by the SPA-fallback templating
          // step. Inline scripts without this nonce are blocked.
          (req, res) => `'nonce-${res.locals.cspNonce}'`,
        ],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: [
          "'self'",
          ...(isProduction ? [] : ['ws:', 'wss:']),
          // When local-compile is enabled, the client fetches against the
          // flowtex-helper binary on the user's machine. Both the dev
          // loopback URL (https://localhost:9876) and the planned production
          // hostname (https://helper.localhost.flowtex.click:9876, DNS A
          // → 127.0.0.1) are listed so a switch from self-signed to
          // Let's-Encrypt later does not need a CSP edit. Gated on the
          // feature flag — operators who do not use local compile keep
          // the tighter default.
          ...(isLocalCompileEnabled()
            ? ['https://localhost:9876', 'https://helper.localhost.flowtex.click:9876']
            : []),
        ],
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
      // Disallowed origin: return false (no CORS headers) instead of throwing
      // an Error. Throwing here produces a 500 in the global error handler,
      // which (a) is a worse signal in logs (it's actually expected attacker
      // behaviour) and (b) is downstream of the CSRF Origin-equality check
      // that returns a clean 403. We let CSRF do that.
      cb(null, false);
    },
    credentials: true,
  }),
);

app.use(compression({
  filter: (req, res) => {
    // Don't compress SSE streams — compression buffers the whole response
    if (res.getHeader('Content-Type') === 'text/event-stream') return false;
    return compression.filter(req, res);
  },
}));
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
// Block well-known sample values that an operator might leave in place by
// copying .env.example too literally. These are publicly known strings —
// running production with one is equivalent to having no secret at all.
const SESSION_SECRET_BLOCKLIST = new Set([
  'flowtex-dev-secret-change-in-production',
  'change-me',
  'changeme',
  'secret',
]);
if (!process.env.SESSION_SECRET) {
  logger.fatal(
    "SESSION_SECRET must be set. Generate one with: node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\"",
  );
  process.exit(1);
}
if (
  process.env.NODE_ENV === 'production' &&
  SESSION_SECRET_BLOCKLIST.has(process.env.SESSION_SECRET)
) {
  logger.fatal(
    'SESSION_SECRET is set to a known sample value. Generate a unique secret before starting in production: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"',
  );
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && process.env.SESSION_SECRET.length < 32) {
  logger.fatal('SESSION_SECRET must be at least 32 characters in production.');
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
// ⚠ csrfExempt invariant: every entry MUST be a *pre-authentication* endpoint
// (no session yet → no CSRF token to enforce). The fallback protection for
// these is the Origin-host equality check + browser SameSite=Lax. If you add
// a path here that's reachable while logged in, you silently disable CSRF
// for it. Only legitimate pre-auth flows belong on this list.
const CSRF_EXEMPT_PATHS = Object.freeze([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/resend-verification',
  '/api/setup/init',
]);
// Boot-time assertion so a typo or wrong addition fails loudly at startup
// rather than quietly weakening protection in production.
for (const p of CSRF_EXEMPT_PATHS) {
  if (!p.startsWith('/api/auth/') && p !== '/api/setup/init') {
    throw new Error(`csrfExempt path "${p}" violates pre-auth invariant`);
  }
}

app.use((req, res, next) => {
  // CSRF protection via double-submit token, but only for *authenticated*
  // requests. Touching req.session.csrfToken triggers connect-pg-simple to
  // persist the session row, so doing it for every anonymous visitor used
  // to spawn one DB row per bot / crawler / health-check probe. Now only
  // sessions that actually have a userId get a stored token and a cookie.
  //
  // Anonymous state-changing requests are restricted to CSRF_EXEMPT_PATHS
  // (login, register, forgot-password, reset-password, setup/init), which
  // are protected by an Origin-equality check below instead of a token.
  if (req.session.userId) {
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    res.cookie('csrf-token', req.session.csrfToken, {
      httpOnly: false,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });
  }

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.path.startsWith('/api/')) {
    if (CSRF_EXEMPT_PATHS.includes(req.path)) {
      // For CSRF-exempt endpoints, validate Origin header to prevent
      // cross-site login attacks. (Pre-auth: no CSRF token yet.)
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
      // Authenticated paths require a matching CSRF token. Anonymous users
      // hitting a non-exempt state-changing path won't have a csrfToken
      // and are rejected here (defense in depth — requireAuth would also
      // reject them at the next layer).
      const token = req.headers['x-csrf-token'];
      if (!req.session.csrfToken || token !== req.session.csrfToken) {
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
  // Admin routes have their own (more permissive) bucket below — exempt
  // them here so the dashboard's live-monitoring polls don't burn through
  // the public-API budget meant for catching scraper/bot abuse.
  skip: (req) => skipRateLimit || req.path.startsWith('/admin/'),
});

// Admins are authenticated, authorized, and may legitimately poll the
// monitoring dashboard. Give them headroom — 600/min is ~10/sec, enough
// for a live dashboard plus regular admin operations without throttling
// normal usage. Still bounded so a runaway script can't DoS via abuse.
const adminApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
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

// Bug-report endpoint fans out to every admins inbox per submission, so the
// generic apiLimiter (200/min) is too loose — a single authenticated user
// could spray admins with hundreds of emails. Cap to 5 per hour, keyed by
// userId (not IP) so a user behind NAT cant be silenced by a co-tenant.
const bugReportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many bug reports — please wait before sending another.' },
  standardHeaders: true,
  legacyHeaders: false,
  // IPv6 needs the librarys ipKeyGenerator helper so two callers from the
  // same /64 subnet dont share a bucket (which would let one tenant
  // silence a neighbour). When the user is authenticated we key by userId
  // directly, which is the common path.
  keyGenerator: (req, res) =>
    req.session?.userId ? `user:${req.session.userId}` : `ip:${ipKeyGenerator(req, res)}`,
  skip: () => skipRateLimit,
});

// Comment-create cap. Each new comment can fan-out: @-mention rows, an
// assignee row, a WS push to the assignee + every collaborator open on
// the same project, and a slot in the next mention-digest email batch.
// The generic apiLimiter (200/min) would let an attacker silently spam
// any victim user with up to 200 bell rows per minute. 60/min per author
// is well above honest authoring (a human typing one comment per second
// for a full minute is rare), but cuts the abuse ceiling by ~3x.
const commentCreateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many comments created in a short period. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    req.session?.userId ? `user:${req.session.userId}` : `ip:${ipKeyGenerator(req, res)}`,
  skip: () => skipRateLimit,
  // Only count creates. Resolve/edit/delete/reply on existing comments
  // is throttled by the generic apiLimiter.
  skipFailedRequests: false,
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
// Per-author comment-create cap (see commentCreateLimiter above). Mounted
// method-specifically so resolve/edit/delete/reply on existing comments
// keep using the generic apiLimiter.
app.post('/api/comments/:fileId', commentCreateLimiter);
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
app.use('/api/chat', requireAuth, chatRouter);
app.use('/api/notifications', requireAuth, notificationsRouter);
app.use('/api/bug-reports', requireAuth, bugReportLimiter, bugReportsRouter);
app.use('/api/bib', requireAuth, bibRouter);
app.use('/api/zotero', requireAuth, zoteroRouter);
app.use('/api/admin', adminApiLimiter, requireAuth, requireAdmin, adminRouter);

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
// `index: false` so express.static won't auto-serve index.html for `/` —
// the SPA fallback below handles it so the CSP nonce can be injected.
app.use(express.static(clientDist, { index: false }));

// Cache the SPA shell, invalidated on file mtime change. Caching avoids a
// syscall per request in steady state; mtime-checking means rebuilds are
// picked up without a server restart (the cached template otherwise pins
// the old hashed asset filenames after `vite build` rotates them).
let _indexHtmlTemplate = '';
let _indexHtmlMtimeMs = 0;
function loadIndexTemplate() {
  const indexPath = path.join(clientDist, 'index.html');
  try {
    const { mtimeMs } = fs.statSync(indexPath);
    if (mtimeMs !== _indexHtmlMtimeMs) {
      _indexHtmlTemplate = fs.readFileSync(indexPath, 'utf8');
      _indexHtmlMtimeMs = mtimeMs;
    }
  } catch {
    // Leave whatever we had cached; first call returns ''.
  }
  return _indexHtmlTemplate;
}
function renderIndexWithNonce(nonce) {
  const tpl = loadIndexTemplate();
  // Add nonce attribute to every <script> tag. Vite's output has only
  // src=-loaded module scripts, but adding the attribute future-proofs
  // against any inline-script regression and enables strict-dynamic later.
  return tpl.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);
}

// Global error handler — catches unhandled errors in route handlers
app.use((err, req, res, _next) => {
  logger.error({ err, method: req.method, url: req.url }, 'Unhandled route error');
  if (!res.headersSent) {
    res.status(err.status || 500).json({ error: 'Internal server error' });
  }
});

// Block common scanner probes — return 404 instead of SPA fallback
const blockedPathPattern =
  /(?:^|\/)(?:\.env|\.git|\.aws|\.ssh|\.docker|\.kube|\.npmrc|\.htaccess|\.htpasswd|wp-admin|wp-login|wp-includes|phpinfo|phpmyadmin|cgi-bin|config\.env|credentials|\.DS_Store|Thumbs\.db|\.svn|\.hg|web\.config|\.well-known\/(?!acme-challenge))/i;
app.get('/{*splat}', (req, res) => {
  // Unknown /api/* path: return JSON 404 instead of leaving the request
  // hanging or serving the SPA shell as if it were a real route.
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  if (blockedPathPattern.test(req.path)) return res.status(404).end();
  const html = renderIndexWithNonce(res.locals.cspNonce);
  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
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

/**
 * Graceful shutdown handler: close HTTP, WebSocket, Redis, and DB connections.
 * @param {string} signal - The signal that triggered shutdown (e.g. 'SIGTERM').
 */
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

  // 3. SIGTERM any in-flight latexmk children — otherwise SIGTERM on the
  //    parent leaves them blocked on closed stdio for the host's reap
  //    timeout. We wait up to ~2s per child for a clean exit before
  //    moving on to the DB drain.
  const aborted = await abortAllCompilations(2000).catch((e) => {
    logger.warn({ err: e }, 'Error aborting compilations on shutdown');
    return 0;
  });
  if (aborted > 0) logger.info({ aborted }, 'Aborted in-flight compilations');

  // 4. Close Redis connections
  if (redisPub) {
    redisPub.disconnect();
  }
  if (redisSub) {
    redisSub.disconnect();
  }

  // 5. Drain the database pool
  await db.pool.end().catch((e) => logger.warn({ err: e }, 'DB pool drain error on shutdown'));

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
  // Enforce secret length in production, warn in dev
  if (process.env.SESSION_SECRET.length < 32) {
    if (isProduction) {
      logger.error('SESSION_SECRET must be at least 32 chars in production');
      process.exit(1);
    }
    logger.warn('SESSION_SECRET is very short (< 32 chars) — use at least 64 hex chars');
  }
  if (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length < 32) {
    if (isProduction) {
      logger.error('ENCRYPTION_KEY must be at least 32 chars in production');
      process.exit(1);
    }
    logger.warn('ENCRYPTION_KEY is very short (< 32 chars) — use at least 64 hex chars');
  }
  if (!process.env.ENCRYPTION_KEY) {
    if (isProduction) {
      logger.error('ENCRYPTION_KEY must be set in production');
      process.exit(1);
    }
    logger.warn('ENCRYPTION_KEY not set — using insecure dev fallback. Set it in .env');
  }
}

/**
 * Production startup check: warn loudly if ImageMagick still has the
 * historically-RCE-prone coders enabled. FlowTex pipes attacker-controlled
 * bytes (DOCX uploads) through `convert`; a hardened `policy.xml` is the
 * supported mitigation (see docs/imagemagick-policy.xml). This check just
 * makes a forgotten policy install loud at boot rather than silent until
 * exploitation.
 */
async function warnIfImageMagickPolicyMissing() {
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.DISABLE_IMAGE_CONVERSION === '1') return; // not used; nothing to warn about
  try {
    const { execFile: execFileCb } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFile = promisify(execFileCb);
    const { stdout } = await execFile('convert', ['-list', 'policy'], { timeout: 3000 });
    const dangerous = ['PS', 'EPS', 'PDF', 'XPS', 'MVG', 'MSL', 'URL', 'HTTPS', 'HTTP', 'FTP'];
    // ImageMagick prints policies in two main formats depending on version
    // and locale:
    //   IM7:  Policy: Coder
    //           rights: None
    //           pattern: PS
    //   IM6:  Policy: Coder
    //           name="PS" rights="none"
    // Plus older Path-prefixed builds. We accept any line that mentions the
    // coder name (with or without quotes) and the word "none" / "rights:
    // none" within the same logical block. A coder is "blocked" only if at
    // least one such line exists for it; absence (or "Read|Write|Read|Write"
    // rights) means it's still enabled.
    const stillEnabled = dangerous.filter((coder) => {
      // Match either the IM6 single-line form `name="X"...rights="none"` or
      // the IM7 multi-line form where `pattern:` and `rights:` appear in
      // the same Coder block.
      const im6 = new RegExp(`(?:name=)?"?${coder}"?[^\\n]*\\brights\\s*[:=]\\s*"?none"?`, 'i').test(stdout);
      const im7 = new RegExp(
        `\\bpattern\\s*[:=]\\s*"?${coder}"?[\\s\\S]{0,200}?\\brights\\s*[:=]\\s*"?none"?` +
        `|\\brights\\s*[:=]\\s*"?none"?[\\s\\S]{0,200}?\\bpattern\\s*[:=]\\s*"?${coder}"?`,
        'i',
      ).test(stdout);
      return !(im6 || im7);
    });
    if (stillEnabled.length > 0) {
      logger.warn(
        { stillEnabled },
        `ImageMagick policy.xml does not block ${stillEnabled.join(', ')} coders. ` +
        `Install docs/imagemagick-policy.xml to /etc/ImageMagick-7/policy.xml, ` +
        `or set DISABLE_IMAGE_CONVERSION=1 to skip the DOCX image pipeline. ` +
        `This is the supported mitigation for known ImageMagick RCE classes.`,
      );
    }
  } catch {
    // `convert` not on PATH or returned non-zero — DOCX import will fail
    // cleanly anyway (mediaFiles get marked unconvertible). No warning needed.
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
    import('./utils/mentionDigest.js').then((m) => m.startMentionDigestJob());
    warnIfImageMagickPolicyMissing();
    server.listen(PORT, () => {
      const proto = useHttps ? 'https' : 'http';
      logger.info(`FlowTex server running on ${proto}://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    logger.fatal({ err }, 'Failed to initialize database');
    process.exit(1);
  });
