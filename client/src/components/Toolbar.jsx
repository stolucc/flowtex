// @ts-check
import React, { useState, useRef, useEffect } from 'react';
import Avatar from './Avatar.jsx';
import useClickOutside from '../hooks/useClickOutside.js';
import HelperStatusIndicator from './HelperStatusIndicator.jsx';
import { HomeIcon } from './Icons.jsx';

/** Avatar-triggered user menu in the editor toolbar: opens to Account
 *  settings + Sign out. Replaces the standalone log-out icon so the user
 *  has the same access to settings inside a project that they have on the
 * @param {any} props
 *  dashboard sidebar. */
function UserMenu({ user, onOpenSettings, onSignOut }) {
  const ref = useRef(/** @type {any} */ (null));
  const [open, setOpen] = useState(false);
  useClickOutside(ref, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div className="toolbar-user-menu" ref={ref}>
      <button
        type="button"
        className="toolbar-user-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        title={user?.name ? `${user.name} — account menu` : 'Account menu'}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Avatar name={user?.name || user?.email || '?'} size={30} />
      </button>
      {open && (
        <div className="toolbar-dropdown-menu toolbar-user-menu-dropdown" role="menu">
          {user && (
            <div className="toolbar-user-menu-header">
              <div className="toolbar-user-menu-name">{user.name}</div>
              <div className="toolbar-user-menu-email">{user.email}</div>
            </div>
          )}
          <button role="menuitem" onClick={() => { setOpen(false); onOpenSettings?.(); }}>
            Account settings
          </button>
          <div className="toolbar-dropdown-separator" />
          <button role="menuitem" onClick={() => { setOpen(false); onSignOut?.(); }}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** Icon-triggered "layout" menu in the right-hand toolbar cluster.
 *  Mirrors UserMenu's pattern (click to open, click-outside / Escape
 *  to close) so the affordance is consistent. The dropdown lets the
 *  user pick Split / Editor only / PDF only, plus a one-shot "Open
 * @param {any} props
 *  PDF in new tab" action. */
function LayoutMenu({ layoutMode, onSetLayoutMode, onOpenPdfInNewTab }) {
  const ref = useRef(/** @type {any} */ (null));
  const [open, setOpen] = useState(false);
  useClickOutside(ref, () => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  const label = layoutMode === 'editor'
    ? 'Layout: editor only'
    : layoutMode === 'pdf'
      ? 'Layout: PDF only'
      : 'Layout: split view';
  return (
    <div className="toolbar-layout-menu" ref={ref}>
      <button
        type="button"
        className={`toolbar-btn toolbar-layout-trigger${open ? ' active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {/* Side-by-side rectangles icon to suggest "panes". */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="8" height="16" rx="1" />
          <rect x="13" y="4" width="8" height="16" rx="1" />
        </svg>
      </button>
      {open && (
        <div className="toolbar-dropdown-menu toolbar-layout-dropdown" role="menu">
          <button role="menuitem" onClick={() => { setOpen(false); onSetLayoutMode?.('split'); }}>
            {layoutMode === 'split' ? '✓ ' : ''}Split view
          </button>
          <button role="menuitem" onClick={() => { setOpen(false); onSetLayoutMode?.('editor'); }}>
            {layoutMode === 'editor' ? '✓ ' : ''}Editor only
          </button>
          <button role="menuitem" onClick={() => { setOpen(false); onSetLayoutMode?.('pdf'); }}>
            {layoutMode === 'pdf' ? '✓ ' : ''}PDF only
          </button>
          <div className="toolbar-dropdown-separator" />
          <button role="menuitem" onClick={() => { setOpen(false); onOpenPdfInNewTab?.(); }}>
            Open PDF in new tab
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Generic toolbar dropdown menu that opens on click and follows hover when another menu is already open.
 * @param {any} props
 */
function DropdownMenu({ label, items, menuId, activeMenu, setActiveMenu }) {
  const ref = useRef(/** @type {any} */ (null));
  const open = activeMenu === menuId;

  return (
    <div className="toolbar-dropdown" ref={ref}>
      <button
        className={`toolbar-menu-btn ${open ? 'active' : ''}`}
        onClick={() => setActiveMenu(open ? null : menuId)}
        onMouseEnter={() => {
          if (activeMenu !== null) setActiveMenu(menuId);
        }}
      >
        {label}
      </button>
      {open && (
        <div className="toolbar-dropdown-menu">
          {items.map((/** @type {any} */ item, /** @type {any} */ i) =>
            item.label === 'separator' ? (
              <div key={i} className="toolbar-dropdown-separator" />
            ) : (
              <button
                key={i}
                disabled={item.disabled}
                onClick={() => {
                  setActiveMenu(null);
                  item.action?.();
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Main menu bar with File, Edit, Insert, View, Format, Tools, and Help dropdowns plus collaborator avatars.
 * @param {any} props
 */
export default function Toolbar({
  projectName,
  projectId,
  onBack,
  users,
  currentUser,
  onShare,
  onLogout,
  onOpenAccountSettings,
  onUserClick,
  onRename,
  isOwner,
  activeFile,
  onPrettyPrint,
  onNewFile,
  onNewFolder,
  onUndo,
  onRedo,
  onSearch,
  onHistory,
  onUploadZip,
  onGitHubSync,
  onInsert,
  onSymbolPicker,
  onToggleComments,
  onToggleVisualMode,
  onToggleTrackedChangesInline,
  showTrackedChangesInline,
  onToggleChangesPanel,
  showChangesPanel,
  onHelp,
  showComments,
  visualMode,
  onCompareFiles,
  githubLink,
  onToggleAutoSync,
  onBibEnrich,
  onZotero,
  spellLanguages,
  spellLang,
  onSpellLangChange,
  onTapsCheck,
  onWordCount,
  onProjectSettings,
  onFormatDocument,
  showBoxWarnings,
  onToggleBoxWarnings,
  showChat,
  onToggleChat,
  onZoomIn,
  onZoomOut,
  showTrackedChangesInPdf,
  onToggleTrackedChangesInPdf,
  layoutMode,
  onSetLayoutMode,
  onOpenPdfInNewTab,
  theme,
  onToggleTheme,
  notificationsSlot,
}) {
  const zipInputRef = useRef(/** @type {any} */ (null));
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(projectName);
  const inputRef = useRef(/** @type {any} */ (null));
  const [activeMenu, setActiveMenu] = useState(/** @type {any} */ (null));
  const menuBarRef = useRef(/** @type {any} */ (null));

  useClickOutside(menuBarRef, () => setActiveMenu(null), activeMenu !== null);

  useEffect(() => {
    setName(projectName);
  }, [projectName]);

  const startEditing = () => {
    if (!isOwner || !onRename) return;
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const save = () => {
    setEditing(false);
    const trimmed = name.trim();
    if (trimmed && trimmed !== projectName) {
      onRename(trimmed);
    } else {
      setName(projectName);
    }
  };

  const isBib = activeFile?.path?.endsWith('.bib');

  const fileMenuItems = [
    { label: 'New File', action: onNewFile },
    { label: 'New Folder', action: onNewFolder },
    { label: 'separator' },
    { label: 'Upload ZIP', action: () => zipInputRef.current?.click() },
    {
      label: 'Download as ZIP',
      action: () => {
        window.location.href = `/api/projects/${projectId}/zip`;
      },
    },
    {
      label: 'Download for Submission',
      action: () => {
        window.location.href = `/api/projects/${projectId}/zip-used`;
      },
    },
    { label: 'separator' },
    {
      // Mirrors the inline-rename triggered by clicking the project name;
      // surfaced in the Project menu so the action is discoverable from the
      // keyboard / for users who never click the name field. Owner-only,
      // matching startEditing's gate.
      label: 'Rename Project…',
      action: startEditing,
      disabled: !isOwner || !onRename,
    },
    { label: 'Project Settings', action: () => onProjectSettings?.() },
  ];

  const editMenuItems = [
    { label: 'Undo', action: onUndo },
    { label: 'Redo', action: onRedo },
    { label: 'separator' },
    { label: 'Find & Replace', action: onSearch },
  ];

  const insertMenuItems = [
    { label: 'Section', action: () => onInsert?.('\\section{', '}') },
    { label: 'Subsection', action: () => onInsert?.('\\subsection{', '}') },
    { label: 'Subsubsection', action: () => onInsert?.('\\subsubsection{', '}') },
    { label: 'separator' },
    { label: 'Itemize', action: () => onInsert?.('\\begin{itemize}\n  \\item ', '\n\\end{itemize}') },
    { label: 'Enumerate', action: () => onInsert?.('\\begin{enumerate}\n  \\item ', '\n\\end{enumerate}') },
    { label: 'separator' },
    {
      label: 'Figure',
      action: () =>
        onInsert?.(
          '\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\textwidth]{',
          '}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}',
        ),
    },
    {
      label: 'Table',
      action: () =>
        onInsert?.(
          '\\begin{table}[htbp]\n  \\centering\n  \\begin{tabular}{lcc}\n    \\hline\n    ',
          ' \\\\\\\\\n    \\hline\n  \\end{tabular}\n  \\caption{}\n  \\label{tab:}\n\\end{table}',
        ),
    },
    { label: 'Equation', action: () => onInsert?.('\\begin{equation}\n  ', '\n\\end{equation}') },
    { label: 'Citation — \\cite{}', action: () => onInsert?.('\\cite{', '}') },
    { label: 'Reference — \\ref{}', action: () => onInsert?.('\\ref{', '}') },
    { label: 'separator' },
    { label: 'Special Symbol…', action: () => onSymbolPicker?.() },
  ];

  const viewMenuItems = [
    { label: `${layoutMode === 'split' ? '✓ ' : ''}Split view`, action: () => onSetLayoutMode?.('split') },
    { label: `${layoutMode === 'editor' ? '✓ ' : ''}Editor only`, action: () => onSetLayoutMode?.('editor') },
    { label: `${layoutMode === 'pdf' ? '✓ ' : ''}PDF only`, action: () => onSetLayoutMode?.('pdf') },
    { label: 'Open PDF in new tab', action: onOpenPdfInNewTab },
    { label: 'separator' },
    { label: `${showComments ? '✓ ' : ''}Comments Panel`, action: onToggleComments },
    { label: `${showChat ? '✓ ' : ''}Chat`, action: onToggleChat },
    { label: `${showBoxWarnings ? '✓ ' : ''}Overfull/Underfull Warnings`, action: onToggleBoxWarnings },
    { label: 'separator' },
    { label: `${showTrackedChangesInline ? '✓ ' : ''}Show Tracked Changes Inline`, action: onToggleTrackedChangesInline },
    { label: `${showChangesPanel ? '✓ ' : ''}Tracked Changes Panel`, action: onToggleChangesPanel },
    { label: `${showTrackedChangesInPdf ? '✓ ' : ''}Show Changes in PDF`, action: onToggleTrackedChangesInPdf },
    { label: 'separator' },
    {
      label: `${theme === 'light' ? '✓ ' : ''}Light Theme`,
      action: onToggleTheme,
    },
    { label: 'separator' },
    { label: 'Zoom In', action: onZoomIn },
    { label: 'Zoom Out', action: onZoomOut },
  ];

  const formatMenuItems = [
    { label: 'Bold', action: () => onInsert?.('\\textbf{', '}') },
    { label: 'Italic', action: () => onInsert?.('\\textit{', '}') },
    { label: 'Underline', action: () => onInsert?.('\\underline{', '}') },
    { label: 'Monospace', action: () => onInsert?.('\\texttt{', '}') },
    { label: 'Emphasis', action: () => onInsert?.('\\emph{', '}') },
    { label: 'Highlight', action: () => onInsert?.('\\hl{', '}') },
    { label: 'separator' },
    { label: 'Inline Math', action: () => onInsert?.('$', '$') },
    { label: 'Display Math', action: () => onInsert?.('\\[\n  ', '\n\\]') },
  ];

  const toolsMenuItems = [
    { label: 'GitHub…', action: () => onGitHubSync?.() },
    { label: 'Compare Files', action: onCompareFiles },
    { label: 'Format Document', action: onFormatDocument, disabled: !activeFile?.path?.endsWith('.tex') },
    { label: 'Format BibTeX', action: onPrettyPrint, disabled: !isBib },
    ...(onBibEnrich ? [{ label: 'Complete Bibliography', action: onBibEnrich }] : []),
    { label: 'Zotero Import', action: () => onZotero?.() },
    ...(onTapsCheck ? [{ label: 'ACM TAPS Check', action: onTapsCheck }] : []),
    { label: 'Word Count', action: () => onWordCount?.() },
    { label: 'separator' },
    { label: `${githubLink?.autoPush ? '✓ ' : ''}Auto-push to GitHub`, action: onToggleAutoSync, disabled: !githubLink?.linked },
    { label: 'separator' },
    ...(spellLanguages || []).map((/** @type {any} */ l) => ({
      label: `${spellLang === l.code ? '✓ ' : '  '}${l.label}`,
      action: () => onSpellLangChange?.(l.code),
    })),
  ];

  const helpMenuItems = [
    { label: 'User guide', action: () => onHelp?.('user-guide') },
    { label: 'Keyboard Shortcuts', action: () => onHelp?.('shortcuts') },
    { label: 'separator' },
    { label: 'Helper setup guide…', action: () => onHelp?.('helper-guide') },
    { label: 'separator' },
    { label: 'Report a bug…', action: () => onHelp?.('bug-report') },
    { label: 'separator' },
    { label: 'About FlowTex', action: () => onHelp?.('about') },
  ];

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <button className="toolbar-back" onClick={onBack} title="Home" aria-label="Home">
          <HomeIcon style={{ verticalAlign: -2 }} />
        </button>
        <span ref={menuBarRef} className="toolbar-menu-bar">
          <DropdownMenu
            label="Project"
            items={fileMenuItems}
            menuId="file"
            activeMenu={activeMenu}
            setActiveMenu={setActiveMenu}
          />
          <DropdownMenu
            label="Edit"
            items={editMenuItems}
            menuId="edit"
            activeMenu={activeMenu}
            setActiveMenu={setActiveMenu}
          />
          <DropdownMenu
            label="Insert"
            items={insertMenuItems}
            menuId="insert"
            activeMenu={activeMenu}
            setActiveMenu={setActiveMenu}
          />
          <DropdownMenu
            label="View"
            items={viewMenuItems}
            menuId="view"
            activeMenu={activeMenu}
            setActiveMenu={setActiveMenu}
          />
          <DropdownMenu
            label="Format"
            items={formatMenuItems}
            menuId="format"
            activeMenu={activeMenu}
            setActiveMenu={setActiveMenu}
          />
          <DropdownMenu
            label="Tools"
            items={toolsMenuItems}
            menuId="tools"
            activeMenu={activeMenu}
            setActiveMenu={setActiveMenu}
          />
          <DropdownMenu
            label="Help"
            items={helpMenuItems}
            menuId="help"
            activeMenu={activeMenu}
            setActiveMenu={setActiveMenu}
          />
        </span>
        <button
          className={`toolbar-btn toolbar-btn-visual${visualMode ? ' toolbar-btn-active' : ''}`}
          onClick={onToggleVisualMode}
          title="Toggle Visual Mode (⌘⇧V)"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ marginRight: 4, verticalAlign: -2 }}
          >
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          Visual
        </button>
      </div>

      <div className="toolbar-center">
        {editing ? (
          <input
            ref={inputRef}
            className="toolbar-title-input"
            value={name}
            onChange={(/** @type {any} */ e) => setName(e.target.value)}
            onBlur={save}
            onKeyDown={(/** @type {any} */ e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') {
                setName(projectName);
                setEditing(false);
              }
            }}
            autoFocus
          />
        ) : (
          <div
            className={`toolbar-title ${isOwner ? 'toolbar-title-editable' : ''}`}
            onDoubleClick={startEditing}
            title={isOwner ? 'Double-click to rename' : undefined}
          >
            {projectName}
          </div>
        )}
      </div>

      <div className="toolbar-right">
        <div className="toolbar-users">
          {(users || [])
            .filter((/** @type {any} */ u) => u.id !== currentUser?.id)
            .map((/** @type {any} */ u) => (
              <span
                key={u.id || u.name}
                className={onUserClick ? 'toolbar-avatar-clickable' : ''}
                onMouseDown={(/** @type {any} */ e) => {
                  if (e.detail > 1) e.preventDefault();
                }}
                onClick={(/** @type {any} */ e) => {
                  e.preventDefault();
                  onUserClick && onUserClick(u);
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                title={u.name + ' — click to jump to their position'}
              >
                <Avatar name={u.name} size={30} />
              </span>
            ))}
        </div>
        <LayoutMenu
          layoutMode={layoutMode}
          onSetLayoutMode={onSetLayoutMode}
          onOpenPdfInNewTab={onOpenPdfInNewTab}
        />
        {notificationsSlot}
        {onHistory && (
          <button className="toolbar-btn toolbar-btn-history" onClick={onHistory} title="Version history">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ marginRight: 5, verticalAlign: -2 }}
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            History
          </button>
        )}
        {onShare && (
          <button className="toolbar-btn toolbar-btn-share" onClick={onShare}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ marginRight: 5, verticalAlign: -2 }}
            >
              <circle cx="7" cy="5.5" r="3" />
              <path d="M1.5 14.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
              <line x1="13" y1="3" x2="13" y2="8" />
              <line x1="10.5" y1="5.5" x2="15.5" y2="5.5" />
            </svg>
            Share
          </button>
        )}
        {currentUser?.serverFeatures?.localCompile && (
          <HelperStatusIndicator
            onOpenSettings={onOpenAccountSettings}
            onOpenGuide={() => onHelp?.('helper-guide')}
          />
        )}
        {onLogout && (
          <UserMenu
            user={currentUser}
            onOpenSettings={onOpenAccountSettings}
            onSignOut={onLogout}
          />
        )}
      </div>
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip"
        style={{ display: 'none' }}
        onChange={(/** @type {any} */ e) => {
          const file = e.target.files?.[0];
          if (file) onUploadZip?.(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}
