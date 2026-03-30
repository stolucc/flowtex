import React, { useState, useRef, useEffect } from 'react';
import { get, patch } from '../api.js';

function Toggle({ on, onChange, disabled }) {
  return (
    <button
      type="button"
      className={`settings-toggle ${on ? 'on' : ''}`}
      onClick={() => !disabled && onChange(!on)}
      role="switch"
      aria-checked={on}
      disabled={disabled}
    >
      <span className="settings-toggle-knob" />
    </button>
  );
}

function ProjectSection({
  project,
  files,
  isOwner,
  name,
  setName,
  mainFile,
  setMainFile,
  snapshotInterval,
  setSnapshotInterval,
  groupFilesByType,
  setGroupFilesByType,
}) {
  const texFiles = files
    .filter((f) => f.path.endsWith('.tex'))
    .map((f) => f.path)
    .sort();

  return (
    <>
      <div className="settings-group">
        <label className="settings-label">Project Name</label>
        <input
          type="text"
          className="settings-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!isOwner}
        />
      </div>

      <div className="settings-group">
        <label className="settings-label">Main File</label>
        <select
          className="settings-input"
          value={mainFile}
          onChange={(e) => setMainFile(e.target.value)}
          disabled={!isOwner}
        >
          {texFiles.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
          {!texFiles.includes(mainFile) && <option value={mainFile}>{mainFile} (missing)</option>}
        </select>
      </div>

      <div className="settings-group">
        <label className="settings-label">History Snapshot Interval</label>
        <select
          className="settings-input"
          value={snapshotInterval}
          onChange={(e) => setSnapshotInterval(parseInt(e.target.value))}
          disabled={!isOwner}
        >
          <option value={10}>10 seconds</option>
          <option value={30}>30 seconds</option>
          <option value={60}>1 minute</option>
          <option value={120}>2 minutes</option>
          <option value={300}>5 minutes</option>
          <option value={600}>10 minutes</option>
        </select>
      </div>

      <div className="settings-group">
        <div className="settings-toggle-row">
          <span className="settings-toggle-label">Group files by type</span>
          <Toggle on={groupFilesByType} onChange={setGroupFilesByType} />
        </div>
        <p className="settings-hint">Organise the file panel into sections (TeX, Bibliography, Images, Style, Other)</p>
      </div>
    </>
  );
}

function EditorSection({
  trackChangesMode,
  onTrackChangesChange,
  editorInverted,
  setEditorInverted,
  latexFormatter,
  setLatexFormatter,
  formatters,
}) {
  return (
    <>
      <div className="settings-group">
        <div className="settings-toggle-row">
          <span className="settings-toggle-label">Track changes</span>
          <Toggle on={trackChangesMode} onChange={onTrackChangesChange} />
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-toggle-row">
          <span className="settings-toggle-label">Invert colors</span>
          <Toggle on={editorInverted} onChange={setEditorInverted} />
        </div>
      </div>
      <div className="settings-group">
        <label className="settings-label">LaTeX Formatter</label>
        <select
          className="settings-input"
          value={latexFormatter || ''}
          onChange={(e) => setLatexFormatter(e.target.value || '')}
        >
          <option value="">None</option>
          {formatters.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} {f.version ? `(${f.version})` : ''}
            </option>
          ))}
        </select>
        {formatters.length === 0 && (
          <p className="settings-hint">No LaTeX formatters detected on the server.</p>
        )}
      </div>
    </>
  );
}

function CompilerSection({ compiler, setCompiler, showBoxWarnings, setShowBoxWarnings, showLintWarnings, setShowLintWarnings, serverLinter, setServerLinter, texDistribution, setTexDistribution, distributions }) {
  return (
    <>
      <div className="settings-group">
        <label className="settings-label">Compiler</label>
        <select
          className="settings-input"
          value={compiler}
          onChange={(e) => setCompiler(e.target.value)}
        >
          <option value="pdflatex">pdfLaTeX</option>
          <option value="xelatex">XeLaTeX</option>
          <option value="lualatex">LuaLaTeX</option>
        </select>
      </div>
      <div className="settings-group">
        <label className="settings-label">TeX Live Distribution</label>
        <select
          className="settings-input"
          value={texDistribution || ''}
          onChange={(e) => setTexDistribution(e.target.value || null)}
        >
          <option value="">Latest available</option>
          {distributions.map((d) => (
            <option key={d.year} value={d.year}>
              {d.year} — {d.version}
            </option>
          ))}
        </select>
      </div>
      <div className="settings-group">
        <div className="settings-toggle-row">
          <span className="settings-toggle-label">Show underfull/overfull box warnings</span>
          <Toggle on={showBoxWarnings} onChange={setShowBoxWarnings} />
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-toggle-row">
          <span className="settings-toggle-label">Client-side linter</span>
          <Toggle on={showLintWarnings} onChange={setShowLintWarnings} />
        </div>
      </div>
      <div className="settings-group">
        <label className="settings-label">Server-side Linter</label>
        <select
          className="settings-input"
          value={serverLinter}
          onChange={(e) => setServerLinter(e.target.value)}
        >
          <option value="">None</option>
          <option value="chktex">ChkTeX</option>
          <option value="lacheck">lacheck</option>
        </select>
      </div>
    </>
  );
}

function GitHubSection({ githubLinked, autoSaveOn, onAutoSaveChange }) {
  if (!githubLinked) {
    return (
      <div className="settings-group">
        <p className="settings-hint">
          Connect your GitHub account first in Account Settings (gear icon on the dashboard sidebar), then use
          Tools &gt; Git Sync to link a repository.
        </p>
      </div>
    );
  }
  return (
    <>
      <div className="settings-group">
        <div className="settings-toggle-row">
          <span className="settings-toggle-label">Auto-save to GitHub</span>
          <Toggle on={autoSaveOn} onChange={onAutoSaveChange} />
        </div>
      </div>
    </>
  );
}

function PublishersSection({ tapsEnabled, setTapsEnabled }) {
  return (
    <>
      <div className="settings-group">
        <div className="settings-toggle-row">
          <span className="settings-toggle-label">ACM TAPS compliance check</span>
          <Toggle on={tapsEnabled} onChange={setTapsEnabled} />
        </div>
        <p className="settings-hint">
          Check that all LaTeX packages used in the project are on the ACM TAPS approved list.
          Violations appear as warnings in the PDF viewer panel.
        </p>
      </div>
    </>
  );
}

function PdfViewerSection({ pdfInverted, setPdfInverted }) {
  return (
    <>
      <div className="settings-group">
        <div className="settings-toggle-row">
          <span className="settings-toggle-label">Invert colors</span>
          <Toggle on={pdfInverted} onChange={setPdfInverted} />
        </div>
      </div>
    </>
  );
}

const svgIcon = (d) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);

const CATEGORIES = [
  { id: 'project', label: 'Project', icon: svgIcon(<><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></>) },
  { id: 'editor', label: 'Editor', icon: svgIcon(<><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></>) },
  { id: 'compiler', label: 'Compiler', icon: svgIcon(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>) },
  { id: 'pdfviewer', label: 'PDF Viewer', icon: svgIcon(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>) },
  { id: 'publishers', label: 'Publishers', icon: svgIcon(<><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></>) },
  { id: 'github', label: 'GitHub', icon: svgIcon(<><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>) },
];

export default function ProjectSettingsModal({
  project,
  files,
  isOwner,
  members,
  onClose,
  onUpdate,
  trackChangesMode,
  onTrackChangesChange,
  autoSaveOn,
  onAutoSaveChange,
  githubLinked,
  initialTab,
}) {
  const [name, setName] = useState(project.name);
  const [mainFile, setMainFile] = useState(project.main_file || 'main.tex');
  const [snapshotInterval, setSnapshotInterval] = useState(project.snapshot_interval_sec || 30);
  const [showBoxWarnings, setShowBoxWarnings] = useState(() => {
    const stored = localStorage.getItem(`flowtex-show-box-warnings-${project.id}`);
    return stored === null ? true : stored === 'true';
  });
  const [editorInverted, setEditorInverted] = useState(
    () => localStorage.getItem('flowtex-editor-inverted') === 'true',
  );
  const [pdfInverted, setPdfInverted] = useState(() => localStorage.getItem('flowtex-pdf-inverted') === 'true');
  const [compiler, setCompiler] = useState(project.compiler || 'pdflatex');
  const [texDistribution, setTexDistribution] = useState(project.tex_distribution || null);
  const [distributions, setDistributions] = useState([]);
  const [latexFormatter, setLatexFormatter] = useState(() => localStorage.getItem('flowtex-latex-formatter') || '');
  const [formatters, setFormatters] = useState([]);
  const [showLintWarnings, setShowLintWarnings] = useState(
    () => localStorage.getItem(`flowtex-show-lint-warnings-${project.id}`) !== 'false',
  );
  const [serverLinter, setServerLinter] = useState(
    () => localStorage.getItem(`flowtex-server-linter-${project.id}`) || '',
  );
  const [groupFilesByType, setGroupFilesByType] = useState(
    () => localStorage.getItem(`flowtex-group-files-${project.id}`) !== 'false',
  );
  const [tapsEnabled, setTapsEnabled] = useState(
    () => localStorage.getItem(`flowtex-taps-enabled-${project.id}`) !== 'false',
  );
  const [activeCategory, setActiveCategory] = useState(initialTab || 'project');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const overlayRef = useRef(null);

  useEffect(() => {
    get('/api/compile/texlive-distributions')
      .then((r) => r.json())
      .then(setDistributions)
      .catch(() => {});
    get('/api/compile/formatters')
      .then((r) => r.json())
      .then(setFormatters)
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const updates = {};
      if (name.trim() && name.trim() !== project.name) updates.name = name.trim();
      if (mainFile !== (project.main_file || 'main.tex')) updates.main_file = mainFile;
      if (snapshotInterval !== (project.snapshot_interval_sec || 30)) updates.snapshot_interval_sec = snapshotInterval;
      if ((texDistribution || null) !== (project.tex_distribution || null))
        updates.tex_distribution = texDistribution || '';
      if (compiler !== (project.compiler || 'pdflatex')) updates.compiler = compiler;

      if (Object.keys(updates).length > 0) {
        const res = await patch(`/api/projects/${project.id}`, updates);
        if (!res.ok) {
          const data = await res.json();
          setError(data.error || 'Failed to save');
          setSaving(false);
          return;
        }
        const updated = await res.json();
        onUpdate(updated);
      }

      localStorage.setItem(`flowtex-show-box-warnings-${project.id}`, showBoxWarnings);
      localStorage.setItem('flowtex-editor-inverted', String(editorInverted));
      localStorage.setItem('flowtex-pdf-inverted', String(pdfInverted));
      localStorage.setItem('flowtex-latex-formatter', latexFormatter);
      localStorage.setItem(`flowtex-show-lint-warnings-${project.id}`, String(showLintWarnings));
      localStorage.setItem(`flowtex-server-linter-${project.id}`, serverLinter);
      localStorage.setItem(`flowtex-group-files-${project.id}`, String(groupFilesByType));
      localStorage.setItem(`flowtex-taps-enabled-${project.id}`, String(tapsEnabled));
      window.dispatchEvent(
        new CustomEvent('flowtex:settings-changed', { detail: { showBoxWarnings, showLintWarnings, serverLinter, editorInverted, pdfInverted, latexFormatter, groupFilesByType, tapsEnabled } }),
      );

      onClose();
    } catch (e) {
      setError(e.message);
    }
    setSaving(false);
  };

  return (
    <div
      className="modal-overlay"
      ref={overlayRef}
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="modal project-settings-modal">
        <div className="modal-header">
          <h2>Project Settings</h2>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="settings-layout">
          <nav className="settings-sidebar">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                className={`settings-nav-item ${activeCategory === cat.id ? 'active' : ''}`}
                onClick={() => setActiveCategory(cat.id)}
              >
                <span className="settings-nav-icon">{cat.icon}</span>
                <span className="settings-nav-label">{cat.label}</span>
              </button>
            ))}
          </nav>
          <div className="settings-content">
            <h3 className="settings-content-title">{CATEGORIES.find((c) => c.id === activeCategory)?.label}</h3>

            {activeCategory === 'project' && (
              <ProjectSection
                project={project}
                files={files}
                isOwner={isOwner}
                name={name}
                setName={setName}
                mainFile={mainFile}
                setMainFile={setMainFile}
                snapshotInterval={snapshotInterval}
                setSnapshotInterval={setSnapshotInterval}
                groupFilesByType={groupFilesByType}
                setGroupFilesByType={setGroupFilesByType}
              />
            )}

            {activeCategory === 'editor' && (
              <EditorSection
                trackChangesMode={trackChangesMode}
                onTrackChangesChange={onTrackChangesChange}
                editorInverted={editorInverted}
                setEditorInverted={setEditorInverted}
                latexFormatter={latexFormatter}
                setLatexFormatter={setLatexFormatter}
                formatters={formatters}
              />
            )}

            {activeCategory === 'compiler' && (
              <CompilerSection
                compiler={compiler}
                setCompiler={setCompiler}
                showBoxWarnings={showBoxWarnings}
                setShowBoxWarnings={setShowBoxWarnings}
                showLintWarnings={showLintWarnings}
                setShowLintWarnings={setShowLintWarnings}
                serverLinter={serverLinter}
                setServerLinter={setServerLinter}
                texDistribution={texDistribution}
                setTexDistribution={setTexDistribution}
                distributions={distributions}
              />
            )}

            {activeCategory === 'pdfviewer' && (
              <PdfViewerSection pdfInverted={pdfInverted} setPdfInverted={setPdfInverted} />
            )}

            {activeCategory === 'publishers' && (
              <PublishersSection tapsEnabled={tapsEnabled} setTapsEnabled={setTapsEnabled} />
            )}

            {activeCategory === 'github' && (
              <GitHubSection githubLinked={githubLinked} autoSaveOn={autoSaveOn} onAutoSaveChange={onAutoSaveChange} />
            )}

            {error && <div className="settings-error">{error}</div>}
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn modal-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="modal-btn modal-btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
