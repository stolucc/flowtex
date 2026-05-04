// Seed helpers: create verified users, projects, and memberships directly via
// Postgres. Also pre-seeds an express-session row + the matching signed
// cookie value so tests can skip the login form entirely (avoids the 20/15min
// auth rate limiter, and shaves the bcrypt cost off every test).
//
// SAFETY: This file inserts an admin user (`ensureAdminExists`) and bypasses
// password hashing. It must NEVER run in production. The hard guard below
// makes a misconfigured deploy fail loudly instead of silently establishing
// a backdoor admin.
if (process.env.NODE_ENV === 'production') {
  throw new Error('e2e/_seed.js must never be loaded in production');
}
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const PASSWORD = 'TestPass123';
let _pool;
function pool() {
  if (!_pool) {
    _pool = new pg.Pool({
      database: process.env.PGDATABASE || 'flowtex',
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432', 10),
      max: 3,
    });
  }
  return _pool;
}

function signCookie(sessionId) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET must be set in env');
  const mac = crypto.createHmac('sha256', secret).update(sessionId).digest('base64').replace(/=+$/, '');
  return `s:${sessionId}.${mac}`;
}

// First-run setup gate: the SPA shows the setup wizard instead of the login
// form whenever `users WHERE is_admin = TRUE` is empty. Tests that don't
// care about admin still need the gate cleared, so we ensure one admin
// exists the first time any seedUser() call runs in this process.
let _adminEnsured = false;
async function ensureAdminExists() {
  if (_adminEnsured) return;
  const c = await pool().connect();
  try {
    const existing = await c.query('SELECT 1 FROM users WHERE is_admin = TRUE LIMIT 1');
    if (existing.rowCount === 0) {
      await c.query(
        `INSERT INTO users (id,email,name,password_hash,email_verified,is_admin)
         VALUES ($1,$2,$3,$4,TRUE,TRUE)`,
        [crypto.randomUUID(), 'e2e-bootstrap-admin@test.local', 'E2E Bootstrap Admin', 'x'],
      );
    }
    _adminEnsured = true;
  } finally { c.release(); }
}

/**
 * Create a verified user AND a server-side session row, returning the
 * cookie string a Playwright context can inject. Bypasses the login form
 * (and its rate limiter) entirely.
 */
export async function seedUser(email, name) {
  await ensureAdminExists();
  const userId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const passHash = await bcrypt.hash(PASSWORD, 12);
  const c = await pool().connect();
  try {
    await c.query(`DELETE FROM users WHERE email = $1`, [email]);
    await c.query(
      `INSERT INTO users (id,email,name,password_hash,email_verified) VALUES ($1,$2,$3,$4,TRUE)`,
      [userId, email, name, passHash],
    );
    const sess = JSON.stringify({
      cookie: {
        originalMaxAge: 86400000,
        expires: new Date(Date.now() + 86400000).toISOString(),
        httpOnly: true,
        path: '/',
      },
      userId,
      csrfToken,
      createdAt: Date.now(),
    });
    await c.query(
      `INSERT INTO session (sid,sess,expire) VALUES ($1,$2::json,$3)
       ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
      [sessionId, sess, new Date(Date.now() + 86400000)],
    );
    return {
      userId,
      email,
      password: PASSWORD,
      sessionId,
      csrfToken,
      cookieValue: signCookie(sessionId),
    };
  } finally { c.release(); }
}

export async function seedProject({ name, ownerId, members = [] }) {
  const projectId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const c = await pool().connect();
  try {
    await c.query(`INSERT INTO projects (id,name,main_file) VALUES ($1,$2,'main.tex')`, [projectId, name]);
    await c.query(
      `INSERT INTO files (id,project_id,path,content) VALUES ($1,$2,'main.tex',$3)`,
      [fileId, projectId, '\\documentclass{article}\n\\begin{document}\nHello FlowTex.\n\\end{document}\n'],
    );
    await c.query(`INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,'owner')`, [projectId, ownerId]);
    for (const { userId, role = 'editor' } of members) {
      await c.query(
        `INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,$3)`,
        [projectId, userId, role],
      );
    }
    return { projectId, fileId };
  } finally { c.release(); }
}

export async function cleanup(emails) {
  const c = await pool().connect();
  try {
    await c.query(`DELETE FROM users WHERE email = ANY($1)`, [emails]);
  } finally { c.release(); }
}

export async function close() {
  if (_pool) { await _pool.end(); _pool = null; }
}
