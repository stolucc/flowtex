import React, { useState, useEffect, useCallback, useRef } from 'react';
import { get, put } from '../api.js';

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
  const max = Math.max(...data.map(d => d.count), 1);
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
              <div
                key={d.date}
                className="admin-chart-bar-col"
                title={`${d.date}: ${d.count}`}
              >
                <div
                  className="admin-chart-bar"
                  style={{ height: `${(d.count / max) * 100}%`, background: color }}
                />
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
  const values = data.map(d => d[valueKey]);
  const max = maxVal || Math.max(...values, 1);
  const w = 100;
  const h = 40;
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - (v / max) * h;
    return `${x},${y}`;
  }).join(' ');
  const areaPoints = `0,${h} ${points} ${w},${h}`;

  return (
    <div className="admin-minichart">
      <div className="admin-minichart-header">
        <span className="admin-minichart-label">{label}</span>
        <span className="admin-minichart-value" style={{ color }}>{values[values.length - 1]}</span>
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
          <tr>{columns.map(c => <th key={c.key}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id || i}>
              {columns.map(c => <td key={c.key}>{c.render ? c.render(row) : row[c.key]}</td>)}
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
  const [live, setLive] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [system, setSystem] = useState(null);
  const [cpuHistory, setCpuHistory] = useState([]);
  const [compileHistory, setCompileHistory] = useState([]);
  const liveRef = useRef(live);
  liveRef.current = live;
  const MAX_SYSTEM_POINTS = 60;

  const fetchSystem = useCallback(() => {
    get('/api/admin/stats/system').then(r => r.json()).then(data => {
      setSystem(data);
      const now = new Date().toLocaleTimeString();
      setCpuHistory(prev => {
        const next = [...prev, { time: now, value: data.cpu.processPercent, load: data.cpu.loadAvg[0] }];
        return next.length > MAX_SYSTEM_POINTS ? next.slice(-MAX_SYSTEM_POINTS) : next;
      });
      setCompileHistory(prev => {
        const next = [...prev, {
          time: now,
          active: data.compilations.active,
          perMin: data.compilations.perMinute,
          total: data.compilations.total,
          sessions: data.connections?.activeSessions || 0,
          wsUsers: data.connections?.wsUniqueUsers || 0,
          wsConns: data.connections?.wsConnections || 0,
        }];
        return next.length > MAX_SYSTEM_POINTS ? next.slice(-MAX_SYSTEM_POINTS) : next;
      });
    });
  }, []);

  const fetchAll = useCallback(() => {
    get('/api/admin/stats/overview').then(r => r.json()).then(setOverview);
    get('/api/admin/stats/top-projects?limit=20').then(r => r.json()).then(setTopProjects);
    get('/api/admin/stats/top-users?limit=20').then(r => r.json()).then(setTopUsers);
    const metrics = ['users', 'projects', 'file_versions', 'comments', 'logins', 'login_failures'];
    metrics.forEach(m => {
      get(`/api/admin/stats/timeseries?metric=${m}&days=${days}`)
        .then(r => r.json())
        .then(data => setTimeseries(prev => ({ ...prev, [m]: data })));
    });
    get(`/api/admin/stats/active-users?days=${days}`)
      .then(r => r.json())
      .then(setActiveUsers);
    get(`/api/admin/audit-log?page=${auditPage}&limit=50`)
      .then(r => r.json())
      .then(setAuditLog);
    fetchSystem();
    setLastRefresh(new Date());
  }, [days, auditPage, fetchSystem]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  useEffect(() => {
    if (tab === 'settings') {
      get('/api/admin/settings').then(r => r.json()).then(setAdminSettings).catch(() => {});
    }
  }, [tab]);

  // Live auto-refresh: system stats every 2s, full data every 10s
  useEffect(() => {
    if (!live) return;
    const fastId = setInterval(() => {
      if (liveRef.current) fetchSystem();
    }, 1000);
    const slowId = setInterval(() => {
      if (liveRef.current) fetchAll();
    }, 5000);
    return () => { clearInterval(fastId); clearInterval(slowId); };
  }, [live, fetchAll, fetchSystem]);

  const projectCols = [
    { key: 'name', label: 'Project' },
    { key: 'memberCount', label: 'Members' },
    { key: 'fileCount', label: 'Files' },
    { key: 'versionCount', label: 'Edits' },
    { key: 'commentCount', label: 'Comments' },
    { key: 'lastEdit', label: 'Last Edit', render: r => formatDate(r.lastEdit) },
  ];

  const userCols = [
    { key: 'name', label: 'Name' },
    { key: 'email', label: 'Email' },
    { key: 'projectCount', label: 'Projects' },
    { key: 'editCount', label: 'Edits' },
    { key: 'commentCount', label: 'Comments' },
    { key: 'createdAt', label: 'Joined', render: r => formatDate(r.createdAt) },
  ];

  const auditCols = [
    { key: 'createdAt', label: 'Time', render: r => formatDateTime(r.createdAt) },
    { key: 'userName', label: 'User', render: r => r.userName || r.userEmail || r.userId || '-' },
    { key: 'action', label: 'Action' },
    { key: 'ip', label: 'IP' },
  ];

  return (
    <div className="admin-dashboard">
      <h1 className="admin-title">Admin Dashboard</h1>
      <div className="admin-header">
        <button className="admin-back" onClick={onBack}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </button>
        <button className={`admin-live-btn ${live ? 'active' : ''}`} onClick={() => setLive(l => !l)}>
          <span className={`admin-live-dot ${live ? 'pulse' : ''}`} />
          {live ? 'Live' : 'Live'}
        </button>
        <button className="admin-refresh-btn" onClick={fetchAll} title="Refresh now">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
        <div className="admin-period">
          {[7, 30, 90].map(d => (
            <button
              key={d}
              className={days === d ? 'active' : ''}
              onClick={() => setDays(d)}
            >{d}d</button>
          ))}
        </div>
      </div>

      <div className="admin-tabs">
        {['overview', 'system', 'projects', 'users', 'audit', 'settings'].map(t => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'overview' && overview && (
        <>
          <div className="admin-cards">
            <StatCard label="Total Users" value={overview.users.total} sub={`+${overview.users.last7d} this week`} />
            <StatCard label="Active Projects" value={overview.projects.active} sub={`${overview.projects.total} total`} />
            <StatCard label="Edits This Week" value={overview.versions.last7d} sub={`${overview.versions.total} all time`} />
            <StatCard label="Comments This Week" value={overview.comments.last7d} sub={`${overview.comments.total} all time`} />
            <StatCard label="Chat Messages" value={overview.chatMessages.total} sub={`+${overview.chatMessages.last7d} this week`} />
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
          <h2>System Monitor {live && <span className="admin-live-indicator">Updating every 2s</span>}</h2>
          {system && (
            <>
              <div className="admin-cards">
                <StatCard label="CPU (process)" value={`${system.cpu.processPercent}%`} sub={`Load: ${system.cpu.loadAvg[0]} / ${system.cpu.cores} cores`} />
                <StatCard label="Active Compiles" value={system.compilations.active} sub={`${system.compilations.perMinute}/min`} />
                <StatCard label="Total Compiles" value={system.compilations.total} sub={`${system.compilations.success} ok, ${system.compilations.failed} failed`} />
                <StatCard label="Avg Compile Time" value={system.compilations.avgDurationMs ? `${(system.compilations.avgDurationMs / 1000).toFixed(1)}s` : '-'} sub="last minute" />
                <StatCard label="Active Sessions" value={system.connections?.activeSessions || 0} sub="logged-in users" />
                <StatCard label="WebSocket Users" value={system.connections?.wsUniqueUsers || 0} sub={`${system.connections?.wsConnections || 0} connections`} />
                <StatCard label="Memory (RSS)" value={formatBytes(system.memory.processRss)} sub={`Heap: ${formatBytes(system.memory.processHeap)}`} />
                <StatCard label="System Memory" value={`${Math.round((1 - system.memory.systemFree / system.memory.systemTotal) * 100)}%`} sub={`${formatBytes(system.memory.systemFree)} free of ${formatBytes(system.memory.systemTotal)}`} />
                <StatCard label="Uptime" value={formatUptime(system.uptime)} />
              </div>
              <div className="admin-system-charts">
                <MiniLineChart data={cpuHistory} valueKey="value" label="CPU %" color="var(--accent)" maxVal={100} />
                <MiniLineChart data={cpuHistory} valueKey="load" label="Load Avg" color="var(--yellow)" />
                <MiniLineChart data={compileHistory} valueKey="active" label="Active Compiles" color="var(--green)" />
                <MiniLineChart data={compileHistory} valueKey="perMin" label="Compiles/min" color="#cba6f7" />
                <MiniLineChart data={compileHistory} valueKey="sessions" label="Active Sessions" color="var(--yellow)" />
                <MiniLineChart data={compileHistory} valueKey="wsUsers" label="WebSocket Users" color="var(--accent)" />
              </div>
            </>
          )}
          {!system && <div className="admin-empty">Loading system stats...</div>}
        </div>
      )}

      {tab === 'projects' && (
        <div className="admin-section">
          <h2>Most Active Projects</h2>
          <DataTable columns={projectCols} rows={topProjects} />
        </div>
      )}

      {tab === 'users' && (
        <div className="admin-section">
          <h2>Most Active Users</h2>
          <DataTable columns={userCols} rows={topUsers} />
        </div>
      )}

      {tab === 'audit' && (
        <div className="admin-section">
          <h2>Audit Log</h2>
          <DataTable columns={auditCols} rows={auditLog.entries} />
          {auditLog.pages > 1 && (
            <div className="admin-pagination">
              <button disabled={auditPage <= 1} onClick={() => setAuditPage(p => p - 1)}>Prev</button>
              <span>Page {auditLog.page} of {auditLog.pages} ({auditLog.total} entries)</span>
              <button disabled={auditPage >= auditLog.pages} onClick={() => setAuditPage(p => p + 1)}>Next</button>
            </div>
          )}
        </div>
      )}

      {tab === 'settings' && (
        <div className="admin-section">
          <h2>Settings</h2>
          {settingsMsg && <div style={{ color: 'var(--green)', marginBottom: 12, fontSize: 13 }}>{settingsMsg}</div>}
          <div className="admin-setting-row">
            <label className="admin-setting-label">
              Maximum compile time (seconds)
              <span className="admin-setting-hint">How long a LaTeX compilation can run before being terminated (10–600)</span>
            </label>
            <div className="admin-setting-input">
              <input
                type="number"
                min="10"
                max="600"
                value={adminSettings.compile_timeout || '120'}
                onChange={(e) => setAdminSettings(s => ({ ...s, compile_timeout: e.target.value }))}
                className="auth-input"
                style={{ width: 100 }}
              />
              <button
                className="auth-button"
                style={{ marginLeft: 8 }}
                onClick={async () => {
                  setSettingsMsg('');
                  const res = await put('/api/admin/settings', { key: 'compile_timeout', value: adminSettings.compile_timeout });
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
        </div>
      )}
    </div>
  );
}
