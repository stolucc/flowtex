import React, { useState, useRef, useEffect } from 'react';
import Avatar from './Avatar.jsx';

function DropdownMenu({ label, items, menuId, activeMenu, setActiveMenu }) {
  const ref = useRef(null);
  const open = activeMenu === menuId;

  return (
    <div className="toolbar-dropdown" ref={ref}>
      <button
        className={`toolbar-menu-btn ${open ? 'active' : ''}`}
        onClick={() => setActiveMenu(open ? null : menuId)}
        onMouseEnter={() => { if (activeMenu !== null) setActiveMenu(menuId); }}
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
                onClick={() => { setActiveMenu(null); item.action?.(); }}
              >
                {item.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

function formatSyncDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const dateDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  let dayPart;
  if (dateDay.getTime() === today.getTime()) dayPart = 'Today';
  else if (dateDay.getTime() === yesterday.getTime()) dayPart = 'Yesterday';
  else {
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    dayPart = `${d.getDate()} ${months[d.getMonth()]}, ${d.getFullYear()}`;
  }
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';
  return `${dayPart} at ${h}:${m} ${ampm}`;
}

export default function Toolbar({ projectName, projectId, onBack, users, currentUser, onShare, onLogout, onUserClick, onRename, isOwner, activeFile, onPrettyPrint, onNewFile, onNewFolder, onSearch, onHistory, onUploadZip, onGitHubSync, onInsert, onSymbolPicker, onToggleComments, onToggleLineNumbers, onToggleWordWrap, onHelp, showComments, showLineNumbers, wordWrap, onCompareFiles, trackChangesMode, onToggleTrackChanges, githubLink, autoSyncStatus, onToggleAutoSync, lastSyncAt, onBibEnrich, onZotero, spellLanguages, spellLang, onSpellLangChange }) {
  const zipInputRef = useRef(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(projectName);
  const inputRef = useRef(null);
  const [activeMenu, setActiveMenu] = useState(null);
  const menuBarRef = useRef(null);

  // Close menu when clicking outside the menu bar
  useEffect(() => {
    if (activeMenu === null) return;
    const handler = (e) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target)) {
        setActiveMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [activeMenu]);

  useEffect(() => { setName(projectName); }, [projectName]);

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
    { label: 'Download as ZIP', action: () => { window.location.href = `/api/projects/${projectId}/zip`; } },
  ];

  const editMenuItems = [
    { label: 'Find & Replace', action: onSearch },
    { label: 'Pretty Print BibTeX', action: onPrettyPrint, disabled: !isBib },
  ];

  const insertMenuItems = [
    { label: 'Section', action: () => onInsert?.('\\section{', '}') },
    { label: 'Subsection', action: () => onInsert?.('\\subsection{', '}') },
    { label: 'Subsubsection', action: () => onInsert?.('\\subsubsection{', '}') },
    { label: 'separator' },
    { label: 'Itemize', action: () => onInsert?.('\\begin{itemize}\n  \\item ', '\n\\end{itemize}') },
    { label: 'Enumerate', action: () => onInsert?.('\\begin{enumerate}\n  \\item ', '\n\\end{enumerate}') },
    { label: 'separator' },
    { label: 'Figure', action: () => onInsert?.('\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\textwidth]{', '}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}') },
    { label: 'Table', action: () => onInsert?.('\\begin{table}[htbp]\n  \\centering\n  \\begin{tabular}{lcc}\n    \\hline\n    ', ' \\\\\\\\\n    \\hline\n  \\end{tabular}\n  \\caption{}\n  \\label{tab:}\n\\end{table}') },
    { label: 'Equation', action: () => onInsert?.('\\begin{equation}\n  ', '\n\\end{equation}') },
    { label: 'Citation — \\cite{}', action: () => onInsert?.('\\cite{', '}') },
    { label: 'Reference — \\ref{}', action: () => onInsert?.('\\ref{', '}') },
    { label: 'separator' },
    { label: 'Special Symbol…', action: () => onSymbolPicker?.() },
  ];

  const viewMenuItems = [
    { label: `${showComments ? '✓ ' : ''}Comments Panel`, action: onToggleComments },
    { label: `${trackChangesMode ? '✓ ' : ''}Track Changes`, action: onToggleTrackChanges },
  ];

  const formatMenuItems = [
    { label: 'Bold', action: () => onInsert?.('\\textbf{', '}') },
    { label: 'Italic', action: () => onInsert?.('\\textit{', '}') },
    { label: 'Underline', action: () => onInsert?.('\\underline{', '}') },
    { label: 'Monospace', action: () => onInsert?.('\\texttt{', '}') },
    { label: 'Emphasis', action: () => onInsert?.('\\emph{', '}') },
    { label: 'separator' },
    { label: 'Inline Math', action: () => onInsert?.('$', '$') },
    { label: 'Display Math', action: () => onInsert?.('\\[\n  ', '\n\\]') },
  ];

  const toolsMenuItems = [
    { label: 'Git Sync', action: () => onGitHubSync?.() },
    { label: 'Compare Files (latexdiff)', action: onCompareFiles },
    ...(onBibEnrich ? [{ label: 'Complete Bibliography', action: onBibEnrich }] : []),
    { label: 'Zotero Import', action: () => onZotero?.() },
    { label: 'separator' },
    { label: `${githubLink?.autoPush ? '✓ ' : ''}Auto-save`, action: onToggleAutoSync, disabled: !githubLink?.linked },
    { label: 'separator' },
    ...(spellLanguages || []).map((l) => ({
      label: `${spellLang === l.code ? '✓ ' : '  '}${l.label}`,
      action: () => onSpellLangChange?.(l.code),
    })),
  ];

  const helpMenuItems = [
    { label: 'Keyboard Shortcuts', action: () => onHelp?.('shortcuts') },
    { label: 'LaTeX Reference', action: () => window.open('https://www.overleaf.com/learn', '_blank') },
    { label: 'About FlowTex', action: () => onHelp?.('about') },
  ];

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <button className="toolbar-back" onClick={onBack}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 5, verticalAlign: -2 }}>
            <path d="M3 9.5L12 3l9 6.5V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
          Home
        </button>
        <span ref={menuBarRef} className="toolbar-menu-bar">
          <DropdownMenu label="File" items={fileMenuItems} menuId="file" activeMenu={activeMenu} setActiveMenu={setActiveMenu} />
          <DropdownMenu label="Edit" items={editMenuItems} menuId="edit" activeMenu={activeMenu} setActiveMenu={setActiveMenu} />
          <DropdownMenu label="Insert" items={insertMenuItems} menuId="insert" activeMenu={activeMenu} setActiveMenu={setActiveMenu} />
          <DropdownMenu label="View" items={viewMenuItems} menuId="view" activeMenu={activeMenu} setActiveMenu={setActiveMenu} />
          <DropdownMenu label="Format" items={formatMenuItems} menuId="format" activeMenu={activeMenu} setActiveMenu={setActiveMenu} />
          <DropdownMenu label="Tools" items={toolsMenuItems} menuId="tools" activeMenu={activeMenu} setActiveMenu={setActiveMenu} />
          <DropdownMenu label="Help" items={helpMenuItems} menuId="help" activeMenu={activeMenu} setActiveMenu={setActiveMenu} />
        </span>
      </div>

      <div className="toolbar-center">
        {editing ? (
          <input
            ref={inputRef}
            className="toolbar-title-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setName(projectName); setEditing(false); } }}
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
          {(users || []).filter((u) => u.id !== currentUser?.id).map((u) => (
            <span
              key={u.id || u.name}
              className={onUserClick ? 'toolbar-avatar-clickable' : ''}
              onMouseDown={(e) => { if (e.detail > 1) e.preventDefault(); }}
              onClick={(e) => { e.preventDefault(); onUserClick && onUserClick(u); }}
              onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
              title={u.name + ' — click to jump to their position'}
            >
              <Avatar name={u.name} size={30} />
            </span>
          ))}
        </div>
        {onHistory && (
          <button className="toolbar-btn" onClick={onHistory} title="Version history">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 5, verticalAlign: -2 }}>
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            History
          </button>
        )}
        {onShare && (
          <button className="toolbar-btn toolbar-btn-share" onClick={onShare}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 5, verticalAlign: -2 }}>
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
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
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
