// @ts-check
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { get, patch } from '../api.js';
import { getSetting, setSetting } from '../utils/settings.js';
import HelperStatusBadge from './HelperStatusBadge.jsx';
import { useHelperStatusContext } from '../contexts/HelperStatusContext.jsx';

/**
 * Accessible toggle switch button.
 * @param {any} props
 */
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

/**
 * Settings section for project name, main file, snapshot interval, and file grouping.
 * @param {any} props
 */
function ProjectSection({
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
    .filter((/** @type {any} */ f) => f.path.endsWith('.tex'))
    .map((/** @type {any} */ f) => f.path)
    .sort();

  return (
    <>
      <div className="settings-group">
        <label className="settings-label">Project Name</label>
        <input
          type="text"
          className="settings-input"
          value={name}
          onChange={(/** @type {any} */ e) => setName(e.target.value)}
          disabled={!isOwner}
        />
      </div>

      <div className="settings-group">
        <label className="settings-label">Main File</label>
        {/* Main file is intentionally NOT gated on isOwner — any collaborator
            needs to be able to flip the compile target when they switch
            chapters. Other fields above and below remain owner-only. */}
        <select
          className="settings-input"
          value={mainFile}
          onChange={(/** @type {any} */ e) => setMainFile(e.target.value)}
        >
          {texFiles.map((/** @type {any} */ f) => (
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
          onChange={(/** @type {any} */ e) => setSnapshotInterval(parseInt(e.target.value))}
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

/**
 * Settings section for track changes, color inversion, and LaTeX formatter selection.
 * @param {any} props
 */
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
          onChange={(/** @type {any} */ e) => setLatexFormatter(e.target.value || '')}
        >
          <option value="">None</option>
          {formatters.map((/** @type {any} */ f) => (
            <option key={f.id} value={f.id}>
              {f.name} {f.version ? `(${f.version})` : ''}
            </option>
          ))}
        </select>
        {formatters.length === 0 && <p className="settings-hint">No LaTeX formatters detected on the server.</p>}
      </div>
    </>
  );
}

/**
 * Settings section for compiler engine, TeX distribution, and linting options.
 * @param {any} props
 */
function CompilerSection({
  compiler,
  setCompiler,
  showBoxWarnings,
  setShowBoxWarnings,
  showLintWarnings,
  setShowLintWarnings,
  serverLinter,
  setServerLinter,
  texDistribution,
  setTexDistribution,
  distributions,
  // Phase 3: per-project compile-location override. Hidden when the server
  // hasn't enabled FEATURE_LOCAL_COMPILE (serverFeatures.localCompile false).
  compileLocation,
  setCompileLocation,
  userCompileLocation,
  localCompileFeatureOn,
}) {
  // The picker has to be consistent with where compile will actually
  // run, or you can pick a year that doesn't exist on the side that
  // ends up doing the work. Resolution:
  //   - compileLocation === 'server'    → show server-installed years
  //   - compileLocation === 'local'     → show helper-detected years
  //   - compileLocation === null (use my default) → show whichever
  //     the user's account default points to
  // (FEATURE_LOCAL_COMPILE off is handled by the picker still showing
  // server distros, since "local" can't be reached.)
  const { status: helperStatus } = useHelperStatusContext();
  const effectiveLocation = compileLocation || userCompileLocation || 'server';
  const localDistros = useMemo(
    () => (/** @type {any} */ (helperStatus)?.distributionsAvailable || []).map((/** @type {any} */ d) => ({
      year: d.year, version: `TeX Live ${d.year}`,
    })),
    [/** @type {any} */ (helperStatus)?.distributionsAvailable],
  );
  const sortedVisible = useMemo(() => {
    const visible = (localCompileFeatureOn && effectiveLocation === 'local')
      ? localDistros
      : distributions;
    return [...visible].sort((a, b) => (a.year < b.year ? 1 : -1));
  }, [localCompileFeatureOn, effectiveLocation, localDistros, distributions]);

  // Flipping compile-location can invalidate the currently-picked year
  // (e.g. picked "2022 (local-only)", then switched to server-compile
  // where 2022 isn't installed). Without this, the <select> value
  // points at a non-existent option — it visually shows blank but the
  // stale year still lives in state and would save to the DB. Reset
  // to "latest available" whenever the pick falls outside the visible
  // list, so the value the user sees matches what gets saved.
  useEffect(() => {
    if (!texDistribution) return;
    if (sortedVisible.some((/** @type {any} */ d) => d.year === texDistribution)) return;
    setTexDistribution(null);
  }, [sortedVisible, texDistribution, setTexDistribution]);

  return (
    <>
      <div className="settings-group">
        <label className="settings-label">Compiler</label>
        <select className="settings-input" value={compiler} onChange={(/** @type {any} */ e) => setCompiler(e.target.value)}>
          <option value="pdflatex">pdfLaTeX</option>
          <option value="xelatex">XeLaTeX</option>
          <option value="lualatex">LuaLaTeX</option>
        </select>
      </div>
      <div className="settings-group">
        <label className="settings-label">
          TeX Live Distribution
          {localCompileFeatureOn && (
            <span style={{ marginLeft: 6, fontWeight: 400, fontSize: 12, color: 'var(--text-muted)' }}>
              (installed on the {effectiveLocation === 'local' ? 'helper' : 'server'})
            </span>
          )}
        </label>
        <select
          className="settings-input"
          value={texDistribution || ''}
          onChange={(/** @type {any} */ e) => setTexDistribution(e.target.value || null)}
        >
          {/* List is filtered to the side the project will compile
              on, so a pick can never silently fail because the year
              doesn't exist over there. */}
          <option value="">
            {sortedVisible.length > 0
              ? `Latest available — ${sortedVisible[0].year}`
              : (effectiveLocation === 'local' ? 'Helper default' : 'Server default')}
          </option>
          {sortedVisible.map((/** @type {any} */ d) => (
            <option key={d.year} value={d.year}>
              {d.year} — {d.version}
            </option>
          ))}
        </select>
        {localCompileFeatureOn && effectiveLocation === 'local' && sortedVisible.length === 0 && (
          <p className="settings-hint" style={{ marginTop: 6 }}>
            No TeX Live distributions detected on the helper. Compile will use whatever the helper&apos;s default <code>tex</code> resolves to.
          </p>
        )}
      </div>
      {localCompileFeatureOn && (
        <div className="settings-group">
          <label className="settings-label">Compile location for this project</label>
          <div style={{ marginBottom: 8 }}>
            <HelperStatusBadge size="small" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input
                type="radio"
                name="compileLocation"
                checked={!compileLocation}
                onChange={() => setCompileLocation(null)}
              />
              <span>Use my default (currently: <strong>{userCompileLocation === 'local' ? 'Local TeX Live' : 'Server'}</strong>)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input
                type="radio"
                name="compileLocation"
                checked={compileLocation === 'server'}
                onChange={() => setCompileLocation('server')}
              />
              <span>Always FlowTex server</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input
                type="radio"
                name="compileLocation"
                checked={compileLocation === 'local'}
                onChange={() => setCompileLocation('local')}
              />
              <span>Always my local TeX Live</span>
            </label>
          </div>
          <p className="settings-hint" style={{ marginTop: 6 }}>
            If your local helper is missing or its TeX Live year does not match this project, compile silently falls back to the server.
          </p>
        </div>
      )}
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
        <select className="settings-input" value={serverLinter} onChange={(/** @type {any} */ e) => setServerLinter(e.target.value)}>
          <option value="">None</option>
          <option value="chktex">ChkTeX</option>
          <option value="lacheck">lacheck</option>
        </select>
      </div>
    </>
  );
}

/**
 * Settings section for GitHub auto-save toggle.
 * @param {any} props
 */
function GitHubSection({ githubLinked, autoSaveOn, onAutoSaveChange }) {
  if (!githubLinked) {
    return (
      <div className="settings-group">
        <p className="settings-hint">
          Connect your GitHub account first in Account Settings (gear icon on the dashboard sidebar), then use Tools
          &gt; Git Sync to link a repository.
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

/**
 * Settings section for ACM TAPS compliance checking.
 * @param {any} props
 */
function PublishersSection({ tapsEnabled, setTapsEnabled }) {
  return (
    <>
      <div className="settings-group">
        <div className="settings-toggle-row">
          <span className="settings-toggle-label">ACM TAPS compliance check</span>
          <Toggle on={tapsEnabled} onChange={setTapsEnabled} />
        </div>
        <p className="settings-hint">
          Check that all LaTeX packages used in the project are on the ACM TAPS approved list. Violations appear as
          warnings in the PDF viewer panel.
        </p>
      </div>
    </>
  );
}

/**
 * Settings section for PDF viewer color inversion.
 * @param {any} props
 */
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

/** Create a 14x14 SVG icon element from the given child paths. */
const svgIcon = (/** @type {React.ReactNode} */ d) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {d}
  </svg>
);

const CATEGORIES = [
  {
    id: 'project',
    label: 'Project',
    icon: svgIcon(
      <>
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </>,
    ),
  },
  {
    id: 'editor',
    label: 'Editor',
    icon: svgIcon(
      <>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </>,
    ),
  },
  {
    id: 'compiler',
    label: 'Compiler',
    icon: svgIcon(
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </>,
    ),
  },
  {
    id: 'pdfviewer',
    label: 'PDF Viewer',
    icon: svgIcon(
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </>,
    ),
  },
  {
    id: 'publishers',
    label: 'Publishers',
    icon: svgIcon(
      <>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </>,
    ),
  },
  {
    id: 'github',
    label: 'GitHub',
    icon: svgIcon(
      <>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </>,
    ),
  },
];

/**
 * Multi-category project settings modal (project, editor, compiler, PDF viewer, publishers, GitHub).
 * @param {any} props
 */
export default function ProjectSettingsModal({
  project,
  files,
  isOwner,
  user,
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
  // null → "use my default" (inherit from user); 'server'|'local' → explicit override.
  const [compileLocation, setCompileLocation] = useState(project.compile_location ?? null);
  const localCompileFeatureOn = !!user?.serverFeatures?.localCompile;
  const [showBoxWarnings, setShowBoxWarnings] = useState(() => {
    const stored = getSetting(`show-box-warnings-${project.id}`);
    return stored === null ? true : stored === 'true';
  });
  const [editorInverted, setEditorInverted] = useState(
    () => getSetting('editor-inverted') === 'true',
  );
  const [pdfInverted, setPdfInverted] = useState(() => getSetting('pdf-inverted') === 'true');
  const [compiler, setCompiler] = useState(project.compiler || 'pdflatex');
  const [texDistribution, setTexDistribution] = useState(project.tex_distribution || null);
  const [distributions, setDistributions] = useState(/** @type {any[]} */ ([]));
  const [latexFormatter, setLatexFormatter] = useState(() => getSetting('latex-formatter') || '');
  const [formatters, setFormatters] = useState(/** @type {any[]} */ ([]));
  const [showLintWarnings, setShowLintWarnings] = useState(
    () => getSetting(`show-lint-warnings-${project.id}`) !== 'false',
  );
  const [serverLinter, setServerLinter] = useState(
    () => getSetting(`server-linter-${project.id}`) || '',
  );
  const [groupFilesByType, setGroupFilesByType] = useState(
    () => getSetting(`group-files-${project.id}`) !== 'false',
  );
  const [tapsEnabled, setTapsEnabled] = useState(
    () => getSetting(`taps-enabled-${project.id}`) === 'true',
  );
  const [activeCategory, setActiveCategory] = useState(initialTab || 'project');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(/** @type {any} */ (null));
  const overlayRef = useRef(/** @type {any} */ (null));

  useEffect(() => {
    get('/api/compile/texlive-distributions')
      .then((/** @type {any} */ r) => r.json())
      .then(setDistributions)
      .catch((/** @type {any} */ e) => console.warn('Failed to load TeX distributions:', e));
    get('/api/compile/formatters')
      .then((/** @type {any} */ r) => r.json())
      .then(setFormatters)
      .catch((/** @type {any} */ e) => console.warn('Failed to load formatters:', e));
  }, []);

  /** Persist all changed settings to the server and localStorage, then close the modal. */
  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      /** @type {any} */
      const updates = {};
      if (name.trim() && name.trim() !== project.name) updates.name = name.trim();
      if (mainFile !== (project.main_file || 'main.tex')) updates.main_file = mainFile;
      if (snapshotInterval !== (project.snapshot_interval_sec || 30)) updates.snapshot_interval_sec = snapshotInterval;
      if ((texDistribution || null) !== (project.tex_distribution || null))
        updates.tex_distribution = texDistribution || '';
      if (compiler !== (project.compiler || 'pdflatex')) updates.compiler = compiler;
      // compile_location: '' = explicit null on the server (inherit from user).
      // Only send when the value actually changed so we don't burn a PATCH on
      // every Save.
      const initialCompileLocation = project.compile_location ?? null;
      if ((compileLocation ?? null) !== initialCompileLocation) {
        updates.compile_location = compileLocation == null ? '' : compileLocation;
      }

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

      setSetting(`show-box-warnings-${project.id}`, showBoxWarnings);
      setSetting('editor-inverted', editorInverted);
      setSetting('pdf-inverted', pdfInverted);
      setSetting('latex-formatter', latexFormatter);
      setSetting(`show-lint-warnings-${project.id}`, showLintWarnings);
      setSetting(`server-linter-${project.id}`, serverLinter);
      setSetting(`group-files-${project.id}`, groupFilesByType);
      setSetting(`taps-enabled-${project.id}`, tapsEnabled);
      window.dispatchEvent(
        new CustomEvent('flowtex:settings-changed', {
          detail: {
            showBoxWarnings,
            showLintWarnings,
            serverLinter,
            editorInverted,
            pdfInverted,
            latexFormatter,
            groupFilesByType,
            tapsEnabled,
          },
        }),
      );

      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setSaving(false);
  };

  return (
    <div
      className="modal-overlay"
      ref={overlayRef}
      onClick={(/** @type {any} */ e) => {
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
            {CATEGORIES.map((/** @type {any} */ cat) => (
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
            <h3 className="settings-content-title">{CATEGORIES.find((/** @type {any} */ c) => c.id === activeCategory)?.label}</h3>

            {activeCategory === 'project' && (
              <>
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
                {isOwner && !project?.encrypted && (
                  <div className="settings-row settings-encryption-row">
                    <div>
                      <strong>Encryption</strong>
                      <p className="settings-hint">
                        Encrypt this project&apos;s file contents at rest. Protects DB
                        dumps / backups. Requires a passphrase; you get a one-time
                        recovery code.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        onClose?.();
                        window.dispatchEvent(new Event('flowtex:enable-encryption'));
                      }}
                    >
                      Enable encryption…
                    </button>
                  </div>
                )}
                {project?.encrypted && (
                  <div className="settings-row settings-encryption-row">
                    <div>
                      <strong>Encryption</strong>
                      <p className="settings-hint">This project is encrypted. 🔒</p>
                    </div>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        onClose?.();
                        window.dispatchEvent(new Event('flowtex:lock-project'));
                      }}
                    >
                      Lock now
                    </button>
                  </div>
                )}
              </>
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
                compileLocation={compileLocation}
                setCompileLocation={setCompileLocation}
                userCompileLocation={user?.compileLocation || 'server'}
                localCompileFeatureOn={localCompileFeatureOn}
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
