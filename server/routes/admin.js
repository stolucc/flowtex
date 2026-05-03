import { Router } from 'express';
import os from 'os';
import db from '../db.js';
import { compileMetrics } from '../compiler.js';
import { resetTransporter, sendEmail } from '../utils/email.js';
import { encrypt } from '../utils/crypto.js';
import logger from '../logger.js';
import { sendError } from '../middleware/errorHandler.js';

const router = Router();

/** GET /api/admin/stats/overview -- Aggregate counts for users, projects, files, etc. */
router.get('/stats/overview', async (req, res) => {
  const [users, projects, files, versions, comments, chatMessages, trackedChanges, githubLinks] = await Promise.all([
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
    db.get('SELECT COUNT(*) AS total FROM tracked_changes'),
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
    trackedChanges: +trackedChanges.total,
    githubLinks: +githubLinks.total,
  });
});

/** GET /api/admin/stats/timeseries -- Daily counts for a given metric over N days. */
router.get('/stats/timeseries', async (req, res) => {
  const metric = req.query.metric || 'users';
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);

  const tableMap = {
    users: { table: 'users', col: 'created_at' },
    projects: { table: 'projects', col: 'created_at' },
    snapshots: { table: 'project_snapshots', col: 'created_at' },
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
      (SELECT MAX(created_at) FROM project_snapshots WHERE project_id = p.id) AS last_edit
    FROM projects p
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
    })),
  );
});

/** GET /api/admin/stats/top-users -- Most active users by edit count with redacted emails. */
router.get('/stats/top-users', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);

  const rows = await db.all(
    `
    SELECT u.id, u.name, u.email, u.created_at,
      (SELECT COUNT(*)::int FROM project_members WHERE user_id = u.id) AS project_count,
      (SELECT COUNT(*)::int FROM project_snapshots WHERE author_id = u.id) AS edit_count,
      (SELECT COUNT(*)::int FROM comments WHERE author_id = u.id) AS comment_count,
      (SELECT MAX(created_at) FROM project_snapshots WHERE author_id = u.id) AS last_edit
    FROM users u
    ORDER BY edit_count DESC
    LIMIT $1
  `,
    [limit],
  );

  res.json(
    rows.map((r) => {
      // Partially redact email for privacy
      const [local, domain] = (r.email || '').split('@');
      const redacted = local ? local[0] + '***@' + (domain || '') : r.email;
      return {
        id: r.id,
        name: r.name,
        email: redacted,
        createdAt: r.created_at,
        projectCount: r.project_count,
        editCount: r.edit_count,
        commentCount: r.comment_count,
        lastEdit: r.last_edit,
      };
    }),
  );
});

/** GET /api/admin/users/:id/activity -- Detailed activity for a single user. */
router.get('/users/:id/activity', async (req, res) => {
  try {
  const userId = req.params.id;

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

  // Active sessions from DB
  const sessionCount = await db.get('SELECT COUNT(*)::int AS total FROM session WHERE expire > NOW()');

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
