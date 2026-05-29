import { Router } from 'express';
import os from 'os';
import db, { getWriteStats } from '../db.js';
import { compileMetrics } from '../compiler.js';
import { resetTransporter, sendEmail, sendAccountDeletedEmail } from '../utils/email.js';
import { encrypt } from '../utils/crypto.js';
import { adminDeleteUser } from '../services/authService.js';
import { auditLog } from '../utils/audit.js';
import logger from '../logger.js';
import { sendError } from '../middleware/errorHandler.js';

const router = Router();

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** GET /api/admin/stats/overview -- Aggregate counts for users, projects, files, etc. */
router.get('/stats/overview', async (req, res) => {
  const [users, projects, files, versions, comments, chatMessages, githubLinks] = await Promise.all([
    db.get(`SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS last_7d,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') AS last_30d
      FROM users`),
    db.get(`SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE NOT archived AND NOT trashed) AS active,
      COUNT(*) FILTER (WHERE archived) AS archived,
      COUNT(*) FILTER (WHERE trashed) AS trashed
      FROM projects`),
    db.get('SELECT COUNT(*) AS total FROM files'),
    db.get(`SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS last_7d
      FROM project_snapshots`),
    db.get(`SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS last_7d
      FROM comments`),
    db.get(`SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS last_7d
      FROM chat_messages`),
    db.get('SELECT COUNT(*) AS total FROM project_github_links'),
  ]);

  res.json({
    users: { total: +users.total, last7d: +users.last_7d, last30d: +users.last_30d },
    projects: {
      total: +projects.total,
      active: +projects.active,
      archived: +projects.archived,
      trashed: +projects.trashed,
    },
    files: +files.total,
    versions: { total: +versions.total, last7d: +versions.last_7d },
    comments: { total: +comments.total, last7d: +comments.last_7d },
    chatMessages: { total: +chatMessages.total, last7d: +chatMessages.last_7d },
    githubLinks: +githubLinks.total,
  });
});

/**
 * GET /api/admin/stats/db-writes -- In-memory write counters since the
 * server process started. Resets on restart. Categorizes by SQL op
 * (INSERT/UPDATE/DELETE/DDL) and by table. SELECTs are not counted.
 */
router.get('/stats/db-writes', (req, res) => {
  res.json(getWriteStats());
});

/** GET /api/admin/stats/timeseries -- Daily counts for a given metric over N days. */
router.get('/stats/timeseries', async (req, res) => {
  const metric = req.query.metric || 'users';
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);

  const tableMap = {
    users: { table: 'users', col: 'created_at' },
    projects: { table: 'projects', col: 'created_at' },
    snapshots: { table: 'project_snapshots', col: 'created_at' },
    // The client's overview-tab chart asks for "file_versions" — the per-
    // file edit table — so accept that key alongside the existing
    // project-level snapshot one. Both are useful: snapshots is "how
    // many save points", file_versions is "how many individual file
    // edits", roughly an order of magnitude different.
    file_versions: { table: 'file_versions', col: 'created_at' },
    comments: { table: 'comments', col: 'created_at' },
    chat_messages: { table: 'chat_messages', col: 'created_at' },
    logins: { table: 'login_attempts', col: 'created_at', where: 'AND success = TRUE' },
    login_failures: { table: 'login_attempts', col: 'created_at', where: 'AND success = FALSE' },
  };

  const spec = tableMap[metric];
  if (!spec) return res.status(400).json({ error: 'Invalid metric' });

  // spec.table, spec.col, spec.where come from the hardcoded tableMap above (never user input).
  // days is validated as an integer 1–365 and passed as a parameterized value.
  const rows = await db.all(
    `
    SELECT d::date AS date, COALESCE(c.count, 0)::int AS count
    FROM generate_series(
      (NOW() - make_interval(days => $1))::date,
      NOW()::date,
      '1 day'
    ) d
    LEFT JOIN (
      SELECT date_trunc('day', ${spec.col})::date AS day, COUNT(*)::int AS count
      FROM ${spec.table}
      WHERE ${spec.col} > NOW() - make_interval(days => $1) ${spec.where || ''}
      GROUP BY 1
    ) c ON d::date = c.day
    ORDER BY d
  `,
    [days],
  );

  res.json(rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), count: r.count })));
});

/** GET /api/admin/stats/active-users -- Daily active user counts over N days. */
router.get('/stats/active-users', async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);

  const rows = await db.all(
    `
    SELECT d::date AS date, COUNT(DISTINCT uid)::int AS count
    FROM generate_series(
      (NOW() - make_interval(days => $1))::date,
      NOW()::date,
      '1 day'
    ) d
    LEFT JOIN LATERAL (
      SELECT author_id AS uid FROM project_snapshots
        WHERE date_trunc('day', created_at) = d::date AND author_id IS NOT NULL
      UNION
      SELECT author_id FROM comments
        WHERE date_trunc('day', created_at) = d::date AND author_id IS NOT NULL
      UNION
      SELECT user_id FROM chat_messages
        WHERE date_trunc('day', created_at) = d::date
    ) u ON TRUE
    GROUP BY 1 ORDER BY 1
  `,
    [days],
  );

  res.json(rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), count: r.count })));
});

/** GET /api/admin/stats/top-projects -- Most recently active projects with member/file/version counts. */
router.get('/stats/top-projects', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);

  const rows = await db.all(
    `
    SELECT p.id, p.name, p.created_at,
      (SELECT COUNT(*)::int FROM project_members WHERE project_id = p.id) AS member_count,
      (SELECT COUNT(*)::int FROM files WHERE project_id = p.id) AS file_count,
      (SELECT COUNT(*)::int FROM project_snapshots WHERE project_id = p.id) AS version_count,
      (SELECT COUNT(*)::int FROM comments c JOIN files f ON c.file_id = f.id WHERE f.project_id = p.id) AS comment_count,
      (SELECT MAX(created_at) FROM project_snapshots WHERE project_id = p.id) AS last_edit,
      owner.id    AS owner_id,
      owner.name  AS owner_name,
      owner.email AS owner_email
    FROM projects p
    LEFT JOIN LATERAL (
      SELECT u.id, u.name, u.email
        FROM project_members pm
        JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = p.id AND pm.role = 'owner'
       ORDER BY pm.user_id
       LIMIT 1
    ) AS owner ON true
    ORDER BY last_edit DESC NULLS LAST
    LIMIT $1
  `,
    [limit],
  );

  res.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      memberCount: r.member_count,
      fileCount: r.file_count,
      versionCount: r.version_count,
      commentCount: r.comment_count,
      lastEdit: r.last_edit,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      ownerEmail: r.owner_email,
    })),
  );
});

/** GET /api/admin/stats/top-users -- Most active users by edit count.
 *  Returns full emails — admins already see real addresses in the audit
 *  log, user-activity, and SMTP test panel; redacting them here both
 *  hampered support workflows and broke the type-email-to-confirm step
 *  of the delete-user modal. */
router.get('/stats/top-users', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);

  const rows = await db.all(
    `
    SELECT u.id, u.name, u.email, u.created_at,
      (SELECT COUNT(*)::int FROM project_members WHERE user_id = u.id) AS project_count,
      (SELECT COUNT(*)::int FROM project_snapshots WHERE author_id = u.id) AS edit_count,
      (SELECT COUNT(*)::int FROM comments WHERE author_id = u.id) AS comment_count,
      (SELECT MAX(created_at) FROM project_snapshots WHERE author_id = u.id) AS last_edit,
      -- "last active" is the most recent signal we have that this user
      -- did SOMETHING — edits + comments cover collaborative work,
      -- audit_log catches logins, profile changes, settings tweaks, etc.
      -- GREATEST ignores NULLs, so a user with no history shows NULL.
      GREATEST(
        (SELECT MAX(created_at) FROM project_snapshots WHERE author_id = u.id),
        (SELECT MAX(created_at) FROM comments WHERE author_id = u.id),
        (SELECT MAX(created_at) FROM audit_log WHERE user_id = u.id)
      ) AS last_active
    FROM users u
    ORDER BY edit_count DESC
    LIMIT $1
  `,
    [limit],
  );

  res.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      createdAt: r.created_at,
      projectCount: r.project_count,
      editCount: r.edit_count,
      commentCount: r.comment_count,
      lastEdit: r.last_edit,
      lastActive: r.last_active,
    })),
  );
});

/** GET /api/admin/users/:id/activity -- Detailed activity for a single user. */
router.get('/users/:id/activity', async (req, res) => {
  try {
  const userId = req.params.id;
  if (!UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  const [user, projects, recentEdits, recentComments, recentChat, auditEntries, loginHistory] =
    await Promise.all([
      db.get(
        `SELECT id, name, email, created_at, email_verified, totp_enabled, is_admin
         FROM users WHERE id = $1`,
        [userId],
      ),
      db.all(
        `SELECT p.id, p.name, pm.role, pm.created_at AS joined_at,
           COALESCE(e.cnt, 0)::int AS edits,
           COALESCE(c.cnt, 0)::int AS comments
         FROM project_members pm
         JOIN projects p ON p.id = pm.project_id
         LEFT JOIN (SELECT project_id, COUNT(*) AS cnt FROM project_snapshots WHERE author_id = $1 GROUP BY project_id) e ON e.project_id = p.id
         LEFT JOIN (SELECT f.project_id, COUNT(*) AS cnt FROM comments cm JOIN files f ON f.id = cm.file_id WHERE cm.author_id = $1 GROUP BY f.project_id) c ON c.project_id = p.id
         WHERE pm.user_id = $1
         ORDER BY edits DESC`,
        [userId],
      ),
      db.all(
        `SELECT ps.id, ps.created_at, p.name AS project_name, ps.label
         FROM project_snapshots ps
         JOIN projects p ON p.id = ps.project_id
         WHERE ps.author_id = $1
         ORDER BY ps.created_at DESC LIMIT 20`,
        [userId],
      ),
      db.all(
        `SELECT c.id, c.created_at, c.text, c.resolved,
           f.path AS file_path, p.name AS project_name
         FROM comments c
         JOIN files f ON f.id = c.file_id
         JOIN projects p ON p.id = f.project_id
         WHERE c.author_id = $1
         ORDER BY c.created_at DESC LIMIT 20`,
        [userId],
      ),
      db.all(
        `SELECT cm.id, cm.created_at, cm.text, p.name AS project_name
         FROM chat_messages cm
         JOIN projects p ON p.id = cm.project_id
         WHERE cm.user_id = $1
         ORDER BY cm.created_at DESC LIMIT 20`,
        [userId],
      ),
      db.all(
        `SELECT action, detail, ip, created_at
         FROM audit_log WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 30`,
        [userId],
      ),
      db.all(
        `SELECT success, ip, created_at
         FROM login_attempts WHERE email = (SELECT email FROM users WHERE id = $1)
         ORDER BY created_at DESC LIMIT 20`,
        [userId],
      ),
    ]);

  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    user: {
      ...user,
      createdAt: user.created_at,
      emailVerified: user.email_verified,
      totpEnabled: user.totp_enabled,
      isAdmin: user.is_admin,
    },
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      joinedAt: p.joined_at,
      edits: p.edits,
      comments: p.comments,
    })),
    recentEdits: recentEdits.map((e) => ({
      id: e.id,
      createdAt: e.created_at,
      projectName: e.project_name,
      label: e.label,
    })),
    recentComments: recentComments.map((c) => ({
      id: c.id,
      createdAt: c.created_at,
      content: c.text,
      resolved: c.resolved,
      filePath: c.file_path,
      projectName: c.project_name,
    })),
    recentChat: recentChat.map((m) => ({
      id: m.id,
      createdAt: m.created_at,
      message: m.text,
      projectName: m.project_name,
    })),
    auditLog: auditEntries.map((a) => ({
      action: a.action,
      detail: a.detail,
      ip: a.ip,
      createdAt: a.created_at,
    })),
    loginHistory: loginHistory.map((l) => ({
      success: l.success,
      ip: l.ip,
      createdAt: l.created_at,
    })),
  });
  } catch (err) {
    sendError(res, err);
  }
});

/** DELETE /api/admin/users/:userId  body { password }
 *  Admin-initiated permanent deletion of another user. Requires the *admin's*
 *  own password as the final confirmation step. Mirrors the self-delete
 *  cascade: NULLs out author references, drops sole-owner projects, deletes
 *  the user row. Refuses self-delete via this route (admins must use the
 *  self-delete flow). */
router.delete('/users/:userId', async (req, res) => {
  const userId = req.params.userId;
  if (!UUID_RE.test(userId)) return res.status(400).json({ error: 'Invalid user id' });
  try {
    const deleted = await adminDeleteUser(req.session.userId, req.body?.password, userId);
    // Encode id/name/email in detail so the forensic trail survives the
    // admin themselves being deleted (their audit_log rows have user_id
    // nulled out in that case — see purgeUserInTx).
    await auditLog(req.session.userId, 'account_deleted_by_admin', {
      targetType: 'user',
      targetId: userId,
      detail: JSON.stringify({ id: userId, email: deleted.email, name: deleted.name }),
      ip: req.ip,
    }).catch((e) => logger.warn({ err: e }, 'Audit log failed for admin user delete'));
    if (deleted.email) {
      sendAccountDeletedEmail(deleted.email, deleted.name).catch((err) =>
        logger.error({ err }, 'Failed to send admin-delete goodbye email'),
      );
    }
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

/** PATCH /api/admin/users/:userId/admin  body: { isAdmin: boolean }
 *
 *  Promote a user to admin, or revoke admin from one. Guarded so that:
 *   - The acting admin cannot toggle their own row (avoids the foot-gun
 *     of demoting yourself; if you truly want to step down, another
 *     admin has to do it, or you fall back to the SQL escape hatch).
 *   - We never leave the system with zero admins — a demotion that
 *     would drop the count to 0 is refused.
 *  Both rules are checked inside a SERIALIZABLE-equivalent read (count
 *  + update in a single transaction) so two simultaneous demotions can't
 *  race past each other and leave the system orphaned. */
router.patch('/users/:userId/admin', async (req, res) => {
  const userId = req.params.userId;
  if (!UUID_RE.test(userId)) return res.status(400).json({ error: 'Invalid user id' });
  if (typeof req.body?.isAdmin !== 'boolean') {
    return res.status(400).json({ error: 'isAdmin must be a boolean' });
  }
  if (userId === req.session.userId) {
    return res.status(400).json({ error: 'You cannot change your own admin status' });
  }
  const desired = req.body.isAdmin;
  try {
    const result = await db.transaction(async (tx) => {
      const target = await tx.get('SELECT id, email, name, is_admin FROM users WHERE id = $1', [userId]);
      if (!target) return { error: 'User not found', status: 404 };
      if (!!target.is_admin === desired) {
        // No-op — return current state so the client can resync without an error.
        return { ok: true, noop: true, target };
      }
      if (!desired) {
        // Demotion: refuse if this would leave zero admins.
        const countRow = await tx.get('SELECT COUNT(*)::int AS n FROM users WHERE is_admin = TRUE');
        if ((countRow?.n || 0) <= 1) {
          return { error: 'Cannot remove the last admin', status: 409 };
        }
      }
      await tx.run('UPDATE users SET is_admin = $1 WHERE id = $2', [desired, userId]);
      return { ok: true, target };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });

    // Audit only real changes — a no-op toggle isn't worth a row, but
    // do return ok so the client UI stays in sync.
    if (!result.noop) {
      await auditLog(req.session.userId, desired ? 'admin_granted' : 'admin_revoked', {
        targetType: 'user',
        targetId: userId,
        detail: JSON.stringify({ email: result.target.email, name: result.target.name }),
        ip: req.ip,
      }).catch((e) => logger.warn({ err: e }, 'Audit log failed for admin toggle'));
    }
    res.json({ ok: true, isAdmin: desired });
  } catch (err) {
    sendError(res, err);
  }
});

/** GET /api/admin/audit-log -- Paginated audit log with user details. */
router.get('/audit-log', async (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const offset = (page - 1) * limit;

  const [rows, countRow] = await Promise.all([
    db.all(
      `
      SELECT a.id, a.user_id, u.name AS user_name, u.email AS user_email,
        a.action, a.target_type, a.target_id, a.detail, a.ip, a.created_at
      FROM audit_log a
      LEFT JOIN users u ON a.user_id = u.id
      ORDER BY a.created_at DESC
      LIMIT $1 OFFSET $2
    `,
      [limit, offset],
    ),
    db.get('SELECT COUNT(*)::int AS total FROM audit_log'),
  ]);

  res.json({
    entries: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userName: r.user_name,
      userEmail: r.user_email,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      detail: r.detail,
      ip: r.ip,
      createdAt: r.created_at,
    })),
    total: countRow.total,
    page,
    pages: Math.ceil(countRow.total / limit),
  });
});

/** GET /api/admin/audit-log/export -- Export full audit log as CSV. */
router.get('/audit-log/export', async (req, res) => {
  const rows = await db.all(
    `SELECT a.id, a.user_id, u.name AS user_name, u.email AS user_email,
       a.action, a.target_type, a.target_id, a.detail, a.ip, a.created_at
     FROM audit_log a
     LEFT JOIN users u ON a.user_id = u.id
     ORDER BY a.created_at DESC`,
  );

  const escapeCsv = (val) => {
    if (val == null) return '';
    const s = String(val);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = 'ID,User ID,User Name,User Email,Action,Target Type,Target ID,Detail,IP,Created At';
  const lines = rows.map((r) =>
    [r.id, r.user_id, r.user_name, r.user_email, r.action, r.target_type, r.target_id, r.detail, r.ip, r.created_at]
      .map(escapeCsv)
      .join(','),
  );

  const auditName = `flowtex-audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${auditName}"; filename*=UTF-8''${encodeURIComponent(auditName)}`);
  res.send(header + '\n' + lines.join('\n'));
});

/** DELETE /api/admin/audit-log -- Clear all audit log entries. */
router.delete('/audit-log', async (req, res) => {
  await db.run('DELETE FROM audit_log');
  logger.info({ userId: req.session.userId }, 'Audit log cleared by admin');
  res.json({ ok: true });
});

// Live system stats (CPU, memory, compilations)
let prevCpuUsage = process.cpuUsage();
let prevCpuTime = Date.now();

/** GET /api/admin/stats/system -- Live CPU, memory, compilation, and connection stats. */
router.get('/stats/system', async (req, res) => {
  // Process CPU usage since last call
  const cpuNow = process.cpuUsage(prevCpuUsage);
  const elapsedMs = Date.now() - prevCpuTime;
  const cpuPercent = elapsedMs > 0 ? Math.min(100, ((cpuNow.user + cpuNow.system) / 1000 / elapsedMs) * 100) : 0;
  prevCpuUsage = process.cpuUsage();
  prevCpuTime = Date.now();

  // System-wide load averages
  const loadAvg = os.loadavg();
  const cpuCount = os.cpus().length;

  // Memory
  const memUsed = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  // Compilations per minute from recent history
  const oneMinAgo = Date.now() - 60000;
  const recentCompiles = compileMetrics.history.filter((h) => h.time > oneMinAgo);
  const compilesPerMin = recentCompiles.length;
  const avgCompileTime =
    recentCompiles.length > 0
      ? Math.round(recentCompiles.reduce((s, h) => s + h.duration, 0) / recentCompiles.length)
      : 0;

  // Active sessions = unexpired session rows that actually belong to a
  // logged-in user. The session table is also written for anonymous
  // visitors because the CSRF middleware sets a token on every request,
  // which would otherwise inflate this count by every bot / crawler /
  // uptime probe that has hit the site.
  const sessionCount = await db.get(
    `SELECT COUNT(*)::int AS total
       FROM session
      WHERE expire > NOW()
        AND sess->>'userId' IS NOT NULL`,
  );

  // Live WebSocket stats from app
  const liveStats = req.app.getLiveStats ? req.app.getLiveStats() : { wsConnections: 0, wsUniqueUsers: 0 };

  res.json({
    cpu: {
      processPercent: Math.round(cpuPercent * 10) / 10,
      loadAvg: loadAvg.map((l) => Math.round(l * 100) / 100),
      cores: cpuCount,
    },
    memory: {
      processRss: memUsed.rss,
      processHeap: memUsed.heapUsed,
      systemTotal: totalMem,
      systemFree: freeMem,
    },
    compilations: {
      total: compileMetrics.total,
      success: compileMetrics.success,
      failed: compileMetrics.failed,
      active: compileMetrics.active,
      perMinute: compilesPerMin,
      avgDurationMs: avgCompileTime,
    },
    connections: {
      activeSessions: sessionCount?.total || 0,
      wsConnections: liveStats.wsConnections,
      wsUniqueUsers: liveStats.wsUniqueUsers,
    },
    uptime: process.uptime(),
  });
});

// ── Settings ─────────────────────────────────────────────────────────

/** GET /api/admin/settings -- Retrieve all key/value settings. */
router.get('/settings', async (req, res) => {
  const rows = await db.all('SELECT key, value FROM settings');
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  res.json(settings);
});

/** PUT /api/admin/settings -- Update a single setting (compile_timeout, smtp_*). */
router.put('/settings', async (req, res) => {
  const { key, value } = req.body;
  if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' });

  const ALLOWED_KEYS = [
    'compile_timeout',
    'smtp_host',
    'smtp_port',
    'smtp_user',
    'smtp_pass',
    'smtp_secure',
    'smtp_from',
  ];
  if (!ALLOWED_KEYS.includes(key)) return res.status(400).json({ error: 'Unknown setting' });

  // Validate
  if (key === 'compile_timeout') {
    const num = parseInt(value);
    if (isNaN(num) || num < 10 || num > 600) {
      return res.status(400).json({ error: 'Compile timeout must be between 10 and 600 seconds' });
    }
  }
  if (key === 'smtp_port') {
    const num = parseInt(value);
    if (isNaN(num) || num < 1 || num > 65535) {
      return res.status(400).json({ error: 'SMTP port must be between 1 and 65535' });
    }
  }
  if (key === 'smtp_secure') {
    if (value !== 'true' && value !== 'false') {
      return res.status(400).json({ error: 'smtp_secure must be "true" or "false"' });
    }
  }

  const storeValue = key === 'smtp_pass' ? encrypt(String(value)) : String(value);
  await db.run(
    'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()',
    [key, storeValue],
  );

  // Reset cached email transporter when any SMTP setting changes
  if (key.startsWith('smtp_')) {
    resetTransporter();
  }

  res.json({ ok: true });
});

/** POST /api/admin/settings/test-email -- Send a test email to verify SMTP configuration. */
router.post('/settings/test-email', async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email required' });
  try {
    await sendEmail({
      to,
      subject: 'FlowTex SMTP Test',
      text: 'This is a test email from FlowTex. If you received this, your SMTP settings are working correctly.',
      html: '<p>This is a test email from FlowTex.</p><p>If you received this, your SMTP settings are working correctly.</p>',
    });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
