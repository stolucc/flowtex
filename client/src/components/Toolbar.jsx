import React, { useState, useRef, useEffect } from 'react';
import Avatar from './Avatar.jsx';
import useClickOutside from '../hooks/useClickOutside.js';
import { HomeIcon, LogoutIcon } from './Icons.jsx';

/** Generic toolbar dropdown menu that opens on click and follows hover when another menu is already open. */
function DropdownMenu({ label, items, menuId, activeMenu, setActiveMenu }) {
  const ref = useRef(null);
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
          {items.map((item, i) =>
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

/** Main menu bar with File, Edit, Insert, View, Format, Tools, and Help dropdowns plus collaborator avatars. */
export default function Toolbar({
  projectName,
  projectId,
  onBack,
  users,
  currentUser,
  onShare,
  onLogout,
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
  theme,
  onToggleTheme,
  notificationsSlot,
}) {
  const zipInputRef = useRef(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(projectName);
  const inputRef = useRef(null);
  const [activeMenu, setActiveMenu] = useState(null);
  const menuBarRef = useRef(null);

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
    ...(spellLanguages || []).map((l) => ({
      label: `${spellLang === l.code ? '✓ ' : '  '}${l.label}`,
      action: () => onSpellLangChange?.(l.code),
    })),
  ];

  const helpMenuItems = [
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
            label="File"
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
            onChange={(e) => setName(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
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
            .filter((u) => u.id !== currentUser?.id)
            .map((u) => (
              <span
                key={u.id || u.name}
                className={onUserClick ? 'toolbar-avatar-clickable' : ''}
                onMouseDown={(e) => {
                  if (e.detail > 1) e.preventDefault();
                }}
                onClick={(e) => {
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
        {onLogout && (
          <button className="toolbar-btn toolbar-btn-logout" onClick={onLogout} title="Log out">
            <LogoutIcon size={18} />
          </button>
        )}
      </div>
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUploadZip?.(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}
