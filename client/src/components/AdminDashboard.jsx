import React, { useState, useEffect, useCallback, useRef } from 'react';
import { get, put, post } from '../api.js';
import { ChevronLeftIcon, RedoIcon } from './Icons.jsx';

function StatCard({ label, value, sub }) {
  return (
    <div className="admin-card">
      <div className="admin-card-value">{value}</div>
      <div className="admin-card-label">{label}</div>
      {sub && <div className="admin-card-sub">{sub}</div>}
    </div>
  );
}

function BarChart({ data, label, color = 'var(--accent)' }) {
  if (!data || !data.length) return null;
  const max = Math.max(...data.map((d) => d.count), 1);
  const step = Math.max(Math.floor(data.length / 6), 1);

  return (
    <div className="admin-chart">
      <div className="admin-chart-title">{label}</div>
      <div className="admin-chart-body">
        <div className="admin-chart-y">
          <span>{max}</span>
          <span>{Math.round(max / 2)}</span>
          <span>0</span>
        </div>
        <div className="admin-chart-area">
          <div className="admin-chart-bars">
            {data.map((d, i) => (
              <div key={d.date} className="admin-chart-bar-col" title={`${d.date}: ${d.count}`}>
                <div className="admin-chart-bar" style={{ height: `${(d.count / max) * 100}%`, background: color }} />
              </div>
            ))}
          </div>
          <div className="admin-chart-x">
            {data.map((d, i) => (
              <span key={d.date} className="admin-chart-x-label">
                {i % step === 0 ? d.date.slice(5) : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniLineChart({ data, valueKey, label, color = 'var(--accent)', maxVal }) {
  if (!data || data.length < 2) return null;
  const values = data.map((d) => d[valueKey]);
  const max = maxVal || Math.max(...values, 1);
  const w = 100;
  const h = 40;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - (v / max) * h;
      return `${x},${y}`;
    })
    .join(' ');
  const areaPoints = `0,${h} ${points} ${w},${h}`;

  return (
    <div className="admin-minichart">
      <div className="admin-minichart-header">
        <span className="admin-minichart-label">{label}</span>
        <span className="admin-minichart-value" style={{ color }}>
          {values[values.length - 1]}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="admin-minichart-svg">
        <polygon points={areaPoints} fill={color} opacity="0.15" />
        <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

function DataTable({ columns, rows, emptyMsg = 'No data' }) {
  if (!rows || !rows.length) return <div className="admin-empty">{emptyMsg}</div>;
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id || i}>
              {columns.map((c) => (
                <td key={c.key}>{c.render ? c.render(row) : row[c.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(1) + ' GB';
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString();
}

function formatDateTime(d) {
  if (!d) return '-';
  return new Date(d).toLocaleString();
}

function UserActivityDetail({ activity }) {
  const { user, projects = [], recentEdits = [], recentComments = [], recentChat = [], auditLog = [], loginHistory = [] } = activity;
  if (!user) return <div className="admin-user-detail-loading">No user data available</div>;
  return (
    <div className="admin-user-detail">
      <div className="admin-user-detail-header">
        <div>
          <strong>{user.name}</strong> <span className="admin-user-detail-email">{user.email}</span>
        </div>
        <div className="admin-user-detail-badges">
          {user.isAdmin && <span className="admin-badge admin-badge-admin">Admin</span>}
          {user.emailVerified ? (
            <span className="admin-badge admin-badge-ok">Email verified</span>
          ) : (
            <span className="admin-badge admin-badge-warn">Email unverified</span>
          )}
          {user.totpEnabled && <span className="admin-badge admin-badge-ok">2FA enabled</span>}
          <span className="admin-badge">Joined {formatDate(user.createdAt)}</span>
        </div>
      </div>

      <div className="admin-user-detail-grid">
        {/* Projects */}
        <div className="admin-user-detail-section">
          <h4>Projects ({projects.length})</h4>
          {projects.length === 0 ? (
            <div className="admin-user-detail-empty">No projects</div>
          ) : (
            <table className="admin-table admin-table-compact">
              <thead>
                <tr><th>Project</th><th>Role</th><th>Edits</th><th>Comments</th></tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{p.role}</td>
                    <td>{p.edits}</td>
                    <td>{p.comments}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Recent Edits */}
        <div className="admin-user-detail-section">
          <h4>Recent Edits ({recentEdits.length})</h4>
          {recentEdits.length === 0 ? (
            <div className="admin-user-detail-empty">No edits</div>
          ) : (
            <table className="admin-table admin-table-compact">
              <thead>
                <tr><th>Time</th><th>Project</th><th>Label</th></tr>
              </thead>
              <tbody>
                {recentEdits.map((e) => (
                  <tr key={e.id}>
                    <td>{formatDateTime(e.createdAt)}</td>
                    <td>{e.projectName}</td>
                    <td>{e.label || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Recent Comments */}
        <div className="admin-user-detail-section">
          <h4>Recent Comments ({recentComments.length})</h4>
          {recentComments.length === 0 ? (
            <div className="admin-user-detail-empty">No comments</div>
          ) : (
            <table className="admin-table admin-table-compact">
              <thead>
                <tr><th>Time</th><th>Project</th><th>File</th><th>Comment</th></tr>
              </thead>
              <tbody>
                {recentComments.map((c) => (
                  <tr key={c.id}>
                    <td>{formatDateTime(c.createdAt)}</td>
                    <td>{c.projectName}</td>
                    <td>{c.filePath}</td>
                    <td className="admin-user-detail-comment">{c.content?.slice(0, 80)}{c.content?.length > 80 ? '…' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Recent Chat */}
        <div className="admin-user-detail-section">
          <h4>Recent Chat ({recentChat.length})</h4>
          {recentChat.length === 0 ? (
            <div className="admin-user-detail-empty">No messages</div>
          ) : (
            <table className="admin-table admin-table-compact">
              <thead>
                <tr><th>Time</th><th>Project</th><th>Message</th></tr>
              </thead>
              <tbody>
                {recentChat.map((m) => (
                  <tr key={m.id}>
                    <td>{formatDateTime(m.createdAt)}</td>
                    <td>{m.projectName}</td>
                    <td>{m.message?.slice(0, 80)}{m.message?.length > 80 ? '…' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Login History */}
        <div className="admin-user-detail-section">
          <h4>Login History</h4>
          {loginHistory.length === 0 ? (
            <div className="admin-user-detail-empty">No logins</div>
          ) : (
            <table className="admin-table admin-table-compact">
              <thead>
                <tr><th>Time</th><th>IP</th><th>Result</th></tr>
              </thead>
              <tbody>
                {loginHistory.map((l, i) => (
                  <tr key={i}>
                    <td>{formatDateTime(l.createdAt)}</td>
                    <td>{l.ip}</td>
                    <td>{l.success ? 'Success' : <span style={{ color: 'var(--red)' }}>Failed</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Audit Log */}
        <div className="admin-user-detail-section">
          <h4>Audit Log</h4>
          {auditLog.length === 0 ? (
            <div className="admin-user-detail-empty">No entries</div>
          ) : (
            <table className="admin-table admin-table-compact">
              <thead>
                <tr><th>Time</th><th>Action</th><th>IP</th></tr>
              </thead>
              <tbody>
                {auditLog.map((a, i) => (
                  <tr key={i}>
                    <td>{formatDateTime(a.createdAt)}</td>
                    <td>{a.action}</td>
                    <td>{a.ip}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AdminDashboard({ onBack }) {
  const [overview, setOverview] = useState(null);
  const [days, setDays] = useState(30);
  const [timeseries, setTimeseries] = useState({});
  const [activeUsers, setActiveUsers] = useState([]);
  const [topProjects, setTopProjects] = useState([]);
  const [topUsers, setTopUsers] = useState([]);
  const [auditLog, setAuditLog] = useState({ entries: [], total: 0, page: 1, pages: 1 });
  const [auditPage, setAuditPage] = useState(1);
  const [tab, setTab] = useState('overview');
  const [adminSettings, setAdminSettings] = useState({});
  const [settingsMsg, setSettingsMsg] = useState('');
  const [expandedUser, setExpandedUser] = useState(null);
  const [userActivity, setUserActivity] = useState(null);
  const [userActivityLoading, setUserActivityLoading] = useState(false);
  const [live, setLive] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [system, setSystem] = useState(null);
  const [cpuHistory, setCpuHistory] = useState([]);
  const [compileHistory, setCompileHistory] = useState([]);
  const liveRef = useRef(live);
  liveRef.current = live;
  const MAX_SYSTEM_POINTS = 60;

  const fetchSystem = useCallback(() => {
    get('/api/admin/stats/system')
      .then((r) => r.json())
      .then((data) => {
        if (!data?.cpu) return;
        setSystem(data);
        const now = new Date().toLocaleTimeString();
        setCpuHistory((prev) => {
          const next = [...prev, { time: now, value: data.cpu.processPercent, load: data.cpu.loadAvg[0] }];
          return next.length > MAX_SYSTEM_POINTS ? next.slice(-MAX_SYSTEM_POINTS) : next;
        });
        setCompileHistory((prev) => {
          const next = [
            ...prev,
            {
              time: now,
              active: data.compilations.active,
              perMin: data.compilations.perMinute,
              total: data.compilations.total,
              sessions: data.connections?.activeSessions || 0,
              wsUsers: data.connections?.wsUniqueUsers || 0,
              wsConns: data.connections?.wsConnections || 0,
            },
          ];
          return next.length > MAX_SYSTEM_POINTS ? next.slice(-MAX_SYSTEM_POINTS) : next;
        });
      });
  }, []);

  const fetchAll = useCallback(() => {
    get('/api/admin/stats/overview')
      .then((r) => r.json())
      .then(setOverview);
    get('/api/admin/stats/top-projects?limit=20')
      .then((r) => r.json())
      .then(setTopProjects);
    get('/api/admin/stats/top-users?limit=20')
      .then((r) => r.json())
      .then(setTopUsers);
    const metrics = ['users', 'projects', 'file_versions', 'comments', 'logins', 'login_failures'];
    metrics.forEach((m) => {
      get(`/api/admin/stats/timeseries?metric=${m}&days=${days}`)
        .then((r) => r.json())
        .then((data) => setTimeseries((prev) => ({ ...prev, [m]: data })));
    });
    get(`/api/admin/stats/active-users?days=${days}`)
      .then((r) => r.json())
      .then(setActiveUsers);
    get(`/api/admin/audit-log?page=${auditPage}&limit=50`)
      .then((r) => r.json())
      .then(setAuditLog);
    fetchSystem();
    setLastRefresh(new Date());
  }, [days, auditPage, fetchSystem]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (tab === 'settings') {
      get('/api/admin/settings')
        .then((r) => r.json())
        .then(setAdminSettings)
        .catch(() => {});
    }
  }, [tab]);

  // Live auto-refresh: system stats every 1s, full data (all tabs) every 5s
  useEffect(() => {
    if (!live) return;
    const fastId = setInterval(() => {
      if (liveRef.current) fetchSystem();
    }, 1000);
    const slowId = setInterval(() => {
      if (liveRef.current) fetchAll();
    }, 5000);
    return () => {
      clearInterval(fastId);
      clearInterval(slowId);
    };
  }, [live, fetchAll, fetchSystem]);

  const liveTag = live ? <span className="admin-live-indicator">Live</span> : null;

  const projectCols = [
    { key: 'name', label: 'Project' },
    { key: 'memberCount', label: 'Members' },
    { key: 'fileCount', label: 'Files' },
    { key: 'versionCount', label: 'Edits' },
    { key: 'commentCount', label: 'Comments' },
    { key: 'lastEdit', label: 'Last Edit', render: (r) => formatDate(r.lastEdit) },
  ];

  const userCols = [
    { key: 'name', label: 'Name' },
    { key: 'email', label: 'Email' },
    { key: 'projectCount', label: 'Projects' },
    { key: 'editCount', label: 'Edits' },
    { key: 'commentCount', label: 'Comments' },
    { key: 'createdAt', label: 'Joined', render: (r) => formatDate(r.createdAt) },
  ];

  const auditCols = [
    { key: 'createdAt', label: 'Time', render: (r) => formatDateTime(r.createdAt) },
    { key: 'userName', label: 'User', render: (r) => r.userName || r.userEmail || r.userId || '-' },
    { key: 'action', label: 'Action' },
    { key: 'ip', label: 'IP' },
  ];

  return (
    <div className="admin-dashboard">
      <h1 className="admin-title">Admin Dashboard</h1>
      <div className="admin-header">
        <button className="admin-back" onClick={onBack}>
          <ChevronLeftIcon />
          Back
        </button>
        <button className={`admin-live-btn ${live ? 'active' : ''}`} onClick={() => setLive((l) => !l)}>
          <span className={`admin-live-dot ${live ? 'pulse' : ''}`} />
          {live ? 'Live' : 'Live'}
        </button>
        <button className="admin-refresh-btn" onClick={fetchAll} title="Refresh now">
          <RedoIcon />
        </button>
        <div className="admin-period">
          {[7, 30, 90].map((d) => (
            <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className="admin-tabs">
        {['overview', 'system', 'projects', 'users', 'audit', 'settings'].map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'overview' && overview && (
        <>
          <div className="admin-cards">
            <StatCard label="Total Users" value={overview.users.total} sub={`+${overview.users.last7d} this week`} />
            <StatCard
              label="Active Projects"
              value={overview.projects.active}
              sub={`${overview.projects.total} total`}
            />
            <StatCard
              label="Edits This Week"
              value={overview.versions.last7d}
              sub={`${overview.versions.total} all time`}
            />
            <StatCard
              label="Comments This Week"
              value={overview.comments.last7d}
              sub={`${overview.comments.total} all time`}
            />
            <StatCard
              label="Chat Messages"
              value={overview.chatMessages.total}
              sub={`+${overview.chatMessages.last7d} this week`}
            />
            <StatCard label="GitHub Links" value={overview.githubLinks} />
          </div>

          <div className="admin-charts">
            <BarChart data={timeseries.users} label="New Users" color="var(--accent)" />
            <BarChart data={activeUsers} label="Daily Active Users" color="var(--green)" />
            <BarChart data={timeseries.file_versions} label="Edits" color="var(--yellow)" />
            <BarChart data={timeseries.projects} label="New Projects" color="#cba6f7" />
            <BarChart data={timeseries.logins} label="Successful Logins" color="var(--green)" />
            <BarChart data={timeseries.login_failures} label="Failed Logins" color="var(--red)" />
          </div>
        </>
      )}

      {tab === 'system' && (
        <div className="admin-section">
          <h2>System Monitor {liveTag}</h2>
          {system && (
            <>
              <div className="admin-cards">
                <StatCard
                  label="CPU (process)"
                  value={`${system.cpu.processPercent}%`}
                  sub={`Load: ${system.cpu.loadAvg[0]} / ${system.cpu.cores} cores`}
                />
                <StatCard
                  label="Active Compiles"
                  value={system.compilations.active}
                  sub={`${system.compilations.perMinute}/min`}
                />
                <StatCard
                  label="Total Compiles"
                  value={system.compilations.total}
                  sub={`${system.compilations.success} ok, ${system.compilations.failed} failed`}
                />
                <StatCard
                  label="Avg Compile Time"
                  value={
                    system.compilations.avgDurationMs
                      ? `${(system.compilations.avgDurationMs / 1000).toFixed(1)}s`
                      : '-'
                  }
                  sub="last minute"
                />
                <StatCard
                  label="Active Sessions"
                  value={system.connections?.activeSessions || 0}
                  sub="logged-in users"
                />
                <StatCard
                  label="WebSocket Users"
                  value={system.connections?.wsUniqueUsers || 0}
                  sub={`${system.connections?.wsConnections || 0} connections`}
                />
                <StatCard
                  label="Memory (RSS)"
                  value={formatBytes(system.memory.processRss)}
                  sub={`Heap: ${formatBytes(system.memory.processHeap)}`}
                />
                <StatCard
                  label="System Memory"
                  value={`${Math.round((1 - system.memory.systemFree / system.memory.systemTotal) * 100)}%`}
                  sub={`${formatBytes(system.memory.systemFree)} free of ${formatBytes(system.memory.systemTotal)}`}
                />
                <StatCard label="Uptime" value={formatUptime(system.uptime)} />
              </div>
              <div className="admin-system-charts">
                <MiniLineChart data={cpuHistory} valueKey="value" label="CPU %" color="var(--accent)" maxVal={100} />
                <MiniLineChart data={cpuHistory} valueKey="load" label="Load Avg" color="var(--yellow)" />
                <MiniLineChart data={compileHistory} valueKey="active" label="Active Compiles" color="var(--green)" />
                <MiniLineChart data={compileHistory} valueKey="perMin" label="Compiles/min" color="#cba6f7" />
                <MiniLineChart
                  data={compileHistory}
                  valueKey="sessions"
                  label="Active Sessions"
                  color="var(--yellow)"
                />
                <MiniLineChart data={compileHistory} valueKey="wsUsers" label="WebSocket Users" color="var(--accent)" />
              </div>
            </>
          )}
          {!system && <div className="admin-empty">Loading system stats...</div>}
        </div>
      )}

      {tab === 'projects' && (
        <div className="admin-section">
          <h2>Most Active Projects {liveTag}</h2>
          <DataTable columns={projectCols} rows={topProjects} />
        </div>
      )}

      {tab === 'users' && (
        <div className="admin-section">
          <h2>Most Active Users {liveTag}</h2>
          <div className={`admin-users-layout ${expandedUser ? 'has-panel' : ''}`}>
            <div className="admin-users-list">
              {!topUsers?.length ? (
                <div className="admin-empty">No data</div>
              ) : (
                <div className="admin-table-wrap">
                  <table className="admin-table admin-table-clickable">
                    <thead>
                      <tr>
                        {userCols.map((c) => (
                          <th key={c.key}>{c.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {topUsers.map((row) => (
                        <tr
                          key={row.id}
                          className={expandedUser === row.id ? 'admin-row-expanded' : ''}
                          onClick={() => {
                            if (expandedUser === row.id) {
                              setExpandedUser(null);
                              setUserActivity(null);
                            } else {
                              setExpandedUser(row.id);
                              setUserActivity(null);
                              setUserActivityLoading(true);
                              get(`/api/admin/users/${row.id}/activity`)
                                .then((r) => {
                                  if (!r.ok) throw new Error('Failed');
                                  return r.json();
                                })
                                .then(setUserActivity)
                                .catch(() => setUserActivity(null))
                                .finally(() => setUserActivityLoading(false));
                            }
                          }}
                        >
                          {userCols.map((c) => (
                            <td key={c.key}>{c.render ? c.render(row) : row[c.key]}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {expandedUser && (
              <div className="admin-users-panel">
                <button className="admin-users-panel-close" onClick={() => { setExpandedUser(null); setUserActivity(null); }}>&times;</button>
                {userActivityLoading ? (
                  <div className="admin-user-detail-loading">Loading activity…</div>
                ) : userActivity ? (
                  <UserActivityDetail activity={userActivity} />
                ) : (
                  <div className="admin-user-detail-loading">Failed to load activity</div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'audit' && (
        <div className="admin-section">
          <h2>Audit Log {liveTag}</h2>
          <DataTable columns={auditCols} rows={auditLog.entries} />
          {auditLog.pages > 1 && (
            <div className="admin-pagination">
              <button disabled={auditPage <= 1} onClick={() => setAuditPage((p) => p - 1)}>
                Prev
              </button>
              <span>
                Page {auditLog.page} of {auditLog.pages} ({auditLog.total} entries)
              </span>
              <button disabled={auditPage >= auditLog.pages} onClick={() => setAuditPage((p) => p + 1)}>
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {tab === 'settings' && (
        <div className="admin-section">
          <h2>Settings</h2>
          {settingsMsg && (
            <div
              style={{
                color: settingsMsg.startsWith('Error') ? 'var(--red)' : 'var(--green)',
                marginBottom: 12,
                fontSize: 13,
              }}
            >
              {settingsMsg}
            </div>
          )}
          <div className="admin-setting-row">
            <label className="admin-setting-label">
              Maximum compile time (seconds)
              <span className="admin-setting-hint">
                How long a LaTeX compilation can run before being terminated (10–600)
              </span>
            </label>
            <div className="admin-setting-input">
              <input
                type="number"
                min="10"
                max="600"
                value={adminSettings.compile_timeout || '120'}
                onChange={(e) => setAdminSettings((s) => ({ ...s, compile_timeout: e.target.value }))}
                className="auth-input"
                style={{ width: 100 }}
              />
              <button
                className="auth-button"
                style={{ marginLeft: 8 }}
                onClick={async () => {
                  setSettingsMsg('');
                  const res = await put('/api/admin/settings', {
                    key: 'compile_timeout',
                    value: adminSettings.compile_timeout,
                  });
                  const d = await res.json();
                  if (res.ok) {
                    setSettingsMsg('Saved');
                    setTimeout(() => setSettingsMsg(''), 2000);
                  } else {
                    setSettingsMsg(d.error || 'Failed');
                  }
                }}
              >
                Save
              </button>
            </div>
          </div>

          <h3 style={{ marginTop: 28, marginBottom: 12 }}>Email (SMTP)</h3>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
            Configure outgoing email for project invitations and password resets. Leave blank to log emails to console
            (development mode).
          </p>

          {[
            { key: 'smtp_host', label: 'SMTP Host', placeholder: 'smtp.example.com', type: 'text' },
            { key: 'smtp_port', label: 'Port', placeholder: '587', type: 'number', width: 100 },
            { key: 'smtp_user', label: 'Username', placeholder: 'user@example.com', type: 'text' },
            { key: 'smtp_pass', label: 'Password', placeholder: '••••••••', type: 'password' },
            { key: 'smtp_from', label: 'From Address', placeholder: 'FlowTex <noreply@example.com>', type: 'text' },
          ].map(({ key, label, placeholder, type, width }) => (
            <div className="admin-setting-row" key={key}>
              <label className="admin-setting-label">{label}</label>
              <div className="admin-setting-input">
                <input
                  type={type}
                  value={adminSettings[key] || ''}
                  onChange={(e) => setAdminSettings((s) => ({ ...s, [key]: e.target.value }))}
                  placeholder={placeholder}
                  className="auth-input"
                  style={{ width: width || 260 }}
                />
              </div>
            </div>
          ))}

          <div className="admin-setting-row">
            <label className="admin-setting-label">Use TLS/SSL (port 465)</label>
            <div className="admin-setting-input">
              <button
                type="button"
                className={`settings-toggle ${adminSettings.smtp_secure === 'true' ? 'on' : ''}`}
                onClick={() =>
                  setAdminSettings((s) => ({ ...s, smtp_secure: s.smtp_secure === 'true' ? 'false' : 'true' }))
                }
                role="switch"
                aria-checked={adminSettings.smtp_secure === 'true'}
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              className="auth-button"
              onClick={async () => {
                setSettingsMsg('');
                const smtpKeys = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_secure', 'smtp_from'];
                try {
                  for (const k of smtpKeys) {
                    if (adminSettings[k] !== undefined && adminSettings[k] !== '') {
                      const res = await put('/api/admin/settings', { key: k, value: adminSettings[k] });
                      if (!res.ok) {
                        const d = await res.json();
                        setSettingsMsg(`Error: ${d.error || 'Failed to save ' + k}`);
                        return;
                      }
                    }
                  }
                  setSettingsMsg('SMTP settings saved');
                  setTimeout(() => setSettingsMsg(''), 3000);
                } catch (err) {
                  setSettingsMsg('Error: ' + (err.message || 'Failed'));
                }
              }}
            >
              Save SMTP Settings
            </button>
            <button
              className="auth-button"
              style={{ background: 'var(--bg-hover)' }}
              onClick={async () => {
                const to = prompt('Send test email to:');
                if (!to) return;
                setSettingsMsg('');
                try {
                  const res = await post('/api/admin/settings/test-email', { to });
                  const d = await res.json();
                  if (res.ok) {
                    setSettingsMsg('Test email sent successfully');
                    setTimeout(() => setSettingsMsg(''), 3000);
                  } else {
                    setSettingsMsg('Error: ' + (d.error || 'Failed to send'));
                  }
                } catch (err) {
                  setSettingsMsg('Error: ' + (err.message || 'Failed'));
                }
              }}
            >
              Send Test Email
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
