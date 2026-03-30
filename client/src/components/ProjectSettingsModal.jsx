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
    </>
  );
}

function EditorSection({ trackChangesMode, onTrackChangesChange, editorInverted, setEditorInverted }) {
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
    </>
  );
}

function CompilerSection({ showBoxWarnings, setShowBoxWarnings, texDistribution, setTexDistribution, distributions }) {
  return (
    <>
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
    </>
  );
}

function GitHubSection({ githubLinked, autoSaveOn, onAutoSaveChange }) {
  if (!githubLinked) {
    return (
      <div className="settings-group">
        <p className="settings-hint">
          No GitHub repository is linked to this project. Use Tools &gt; Git Sync to connect one.
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

const CATEGORIES = [
  { id: 'project', label: 'Project', icon: '📁' },
  { id: 'editor', label: 'Editor', icon: '✏️' },
  { id: 'compiler', label: 'Compiler', icon: '⚙️' },
  { id: 'pdfviewer', label: 'PDF Viewer', icon: '📄' },
  { id: 'github', label: 'GitHub', icon: '🔗' },
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
  const [texDistribution, setTexDistribution] = useState(project.tex_distribution || null);
  const [distributions, setDistributions] = useState([]);
  const [activeCategory, setActiveCategory] = useState(initialTab || 'project');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const overlayRef = useRef(null);

  useEffect(() => {
    get('/api/compile/texlive-distributions')
      .then((r) => r.json())
      .then(setDistributions)
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
      window.dispatchEvent(
        new CustomEvent('flowtex:settings-changed', { detail: { showBoxWarnings, editorInverted, pdfInverted } }),
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
              />
            )}

            {activeCategory === 'editor' && (
              <EditorSection
                trackChangesMode={trackChangesMode}
                onTrackChangesChange={onTrackChangesChange}
                editorInverted={editorInverted}
                setEditorInverted={setEditorInverted}
              />
            )}

            {activeCategory === 'compiler' && (
              <CompilerSection
                showBoxWarnings={showBoxWarnings}
                setShowBoxWarnings={setShowBoxWarnings}
                texDistribution={texDistribution}
                setTexDistribution={setTexDistribution}
                distributions={distributions}
              />
            )}

            {activeCategory === 'pdfviewer' && (
              <PdfViewerSection pdfInverted={pdfInverted} setPdfInverted={setPdfInverted} />
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
