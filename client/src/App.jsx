import React, { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import ProjectList from './components/ProjectList.jsx';
import Editor from './components/Editor.jsx';
import PdfViewer from './components/PdfViewer.jsx';
import FileTree from './components/FileTree.jsx';
import CommentsSidebar from './components/CommentsSidebar.jsx';
import SyncArrows from './components/SyncArrows.jsx';
import ResizeHandle from './components/ResizeHandle.jsx';
import Toolbar from './components/Toolbar.jsx';
import AuthPage from './components/AuthPage.jsx';
import ShareModal from './components/ShareModal.jsx';
import CompareFilesModal from './components/CompareFilesModal.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import BinaryPreview, { getMimeType } from './components/BinaryPreview.jsx';
import { TrackChangesPopup, TrackChangesReviewBar } from './components/TrackChangesBar.jsx';
import ProjectSettingsModal from './components/ProjectSettingsModal.jsx';
import WordCountModal from './components/WordCountModal.jsx';

const HistoryPanel = lazy(() => import('./components/HistoryPanel.jsx'));
const GitHubSyncModal = lazy(() => import('./components/GitHubSyncModal.jsx'));
const BibEnrichModal = lazy(() => import('./components/BibEnrichModal.jsx'));
const ZoteroModal = lazy(() => import('./components/ZoteroModal.jsx'));
const AdminDashboard = lazy(() => import('./components/AdminDashboard.jsx'));
import { get, post, put, patch, del, getCsrfToken } from './api.js';
import prettyBib from './utils/prettyBib.js';
import { LANGUAGES, getLanguage } from './utils/spellcheck.js';

import { useAuth, AuthProvider } from './contexts/AuthContext.jsx';
import useProject from './hooks/useProject.js';
import useWebSocket from './hooks/useWebSocket.js';
import useCompilation from './hooks/useCompilation.js';
import useTrackedChanges from './hooks/useTrackedChanges.js';
import useComments from './hooks/useComments.js';
import useGitHubSync from './hooks/useGitHubSync.js';
import useUIState from './hooks/useUIState.js';
import useClickOutside from './hooks/useClickOutside.js';
import { formatSyncDate } from './utils/dateFormat.js';
import tapsCheck from './utils/tapsChecker.js';

function GenFileContextMenu({ x, y, name, onClose, onDownload }) {
  const ref = React.useRef(null);
  useClickOutside(ref, onClose);
  return (
    <div ref={ref} className="file-tree-context-menu" style={{ position: 'fixed', top: y, left: x, zIndex: 1000 }}>
      <button
        className="file-tree-context-item"
        onClick={() => {
          onClose();
          onDownload(name);
        }}
      >
        Download
      </button>
    </div>
  );
}

function stripJobSuffix(filename) {
  return filename.replace(/_[0-9a-f]{8}(?=\.)/, '').replace(/^__diff__/, 'diff');
}

function AppInner() {
  const { user, setUser, authChecked, handleLogout } = useAuth();
  const [showAdmin, setShowAdmin] = useState(window.location.pathname === '/admin');
  const editorRef = useRef(null);
  const pdfRef = useRef(null);

  // --- Core hooks ---
  const {
    project,
    setProject,
    files,
    setFiles,
    activeFile,
    setActiveFile,
    members,
    setMembers,
    newFileCounter,
    setNewFileCounter,
    newFolderCounter,
    setNewFolderCounter,
    needsAutoCompile,
    switchFile,
    selectProject,
    goBack: projectGoBack,
    handleSave,
    handleCreateFile,
    handleDeleteFile,
    handleRenameFile,
    handleRenameFolder,
    handleDeleteFolder,
    handleSetMainFile,
  } = useProject(user);

  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;

  const sendWsRef = useRef(null);

  const [historyVersion, setHistoryVersion] = useState(0);

  const {
    comments,
    setComments,
    selection,
    setSelection,
    selectionFormTop,
    commentPositions,
    handleAddComment,
    handleResolveComment,
    handleDeleteComment,
    handleReplyComment,
    handleEditComment,
    updateCommentPositions,
  } = useComments(activeFile, sendWsRef, editorRef);

  const {
    trackChangesMode,
    setTrackChangesMode,
    trackedChanges,
    setTrackedChanges,
    tcPopup,
    setTcPopup,
    handleTrackChange,
    handleDeleteInsertionChar,
    handleAcceptChange,
    handleRejectChange,
    handleAcceptAllChanges,
    handleRejectAllChanges,
  } = useTrackedChanges(activeFile, user, sendWsRef, editorRef);

  const {
    activeUsers,
    remoteCursors,
    chatMessages,
    setChatMessages,
    unreadChat,
    setUnreadChat,
    showChat,
    setShowChat,
    sendWsMessage,
  } = useWebSocket(user, project, activeFileRef, { setComments, setTrackedChanges, setHistoryVersion });

  sendWsRef.current = sendWsMessage;

  const {
    compiling,
    pdfUrl,
    setPdfUrl,
    compileLog,
    setCompileLog,
    consoleOutput,
    setConsoleOutput,
    lintDiagnostics,
    setLintDiagnostics,
    generatedFiles,
    setGeneratedFiles,
    activeGenFile,
    setActiveGenFile,
    handleCompile,
    handleDiff,
  } = useCompilation(project, activeFile, handleSave, editorRef);

  const { githubLink, setGithubLink, autoSyncStatus, handleToggleAutoSync } = useGitHubSync(project);

  const ui = useUIState();

  const [showBoxWarnings, setShowBoxWarnings] = useState(true);
  const [projectSettingsTab, setProjectSettingsTab] = useState(null);

  useEffect(() => {
    if (project?.id) {
      const stored = localStorage.getItem(`flowtex-show-box-warnings-${project.id}`);
      if (stored !== null) setShowBoxWarnings(stored === 'true');
    }
  }, [project?.id]);

  useEffect(() => {
    const handler = (e) => {
      if (e.detail.showBoxWarnings !== undefined) setShowBoxWarnings(e.detail.showBoxWarnings);
    };
    window.addEventListener('flowtex:settings-changed', handler);
    return () => window.removeEventListener('flowtex:settings-changed', handler);
  }, []);

  // --- Effects that wire hooks together ---

  useEffect(() => {
    const handler = (e) => {
      editorRef.current?.applyRemoteChanges(e.detail.fileId, e.detail.changes);
    };
    window.addEventListener('ws:changes', handler);
    return () => window.removeEventListener('ws:changes', handler);
  }, []);

  useEffect(() => {
    if (!project) return;
    if (needsAutoCompile.current) {
      needsAutoCompile.current = false;
      setTimeout(() => {
        post(`/api/compile/${project.id}`)
          .then((r) => r.json())
          .then((data) => {
            setCompileLog(data.log || '');
            if (data.success) setPdfUrl(`/api/compile/${project.id}/pdf?t=${Date.now()}`);
          });
      }, 100);
    }
    get(`/api/compile/${project.id}/generated-files`)
      .then((r) => r.json())
      .then((d) => setGeneratedFiles(d.files || []))
      .catch(() => {});
    get(`/api/chat/${project.id}`)
      .then((r) => r.json())
      .then((msgs) => setChatMessages(msgs || []))
      .catch(() => {});
  }, [project]);

  const citeKeys = useMemo(() => {
    const bibFiles = files.filter((f) => f.path.endsWith('.bib') && f.content);
    const keys = [];
    const entryPattern = /@\w+\s*\{\s*([\w:.@/+\-]+)/g;
    for (const f of bibFiles) {
      let match;
      entryPattern.lastIndex = 0;
      while ((match = entryPattern.exec(f.content)) !== null) {
        const entryStart = match.index;
        const entryKey = match[1];
        const rest = f.content.slice(entryStart);
        const titleMatch = rest.match(/title\s*=\s*[{"]\s*([^}"]+)/i);
        const authorMatch = rest.match(/author\s*=\s*[{"]\s*([^}"]+)/i);
        const entryType = rest.match(/@(\w+)/)?.[1]?.toLowerCase() || '';
        let detail = entryType;
        if (authorMatch) {
          const firstAuthor = authorMatch[1].split(/\s+and\s+/i)[0].trim();
          const lastName = firstAuthor.split(',')[0].split(/\s+/).pop();
          detail = lastName;
        }
        if (titleMatch) {
          const shortTitle = titleMatch[1].length > 40 ? titleMatch[1].slice(0, 40) + '...' : titleMatch[1];
          detail += detail ? ' — ' + shortTitle : shortTitle;
        }
        keys.push({ label: entryKey, type: 'text', detail, boost: 1 });
      }
    }
    return keys;
  }, [files]);

  useEffect(() => {
    const base = project ? `${project.name} — FlowTex` : 'FlowTex';
    document.title = unreadChat > 0 ? `(${unreadChat}) ${base}` : base;
  }, [unreadChat, project]);

  useEffect(() => {
    if (!activeFile) return;
    const cursors = Object.entries(remoteCursors)
      .filter(([uid, c]) => c.fileId === activeFile.id && uid !== user?.id)
      .map(([uid, c]) => ({ userId: uid, userName: c.userName, head: c.head, anchor: c.anchor }));
    editorRef.current?.setRemoteCursors(cursors);
  }, [remoteCursors, activeFile, user]);

  useEffect(() => {
    const onPopState = () => setShowAdmin(window.location.pathname === '/admin');
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // --- Handlers that bridge hooks ---

  const handleOverwriteFile = useCallback(
    async (fileId, content) => {
      await put(`/api/projects/files/${fileId}`, { content });
      setFiles((fs) => fs.map((f) => (f.id === fileId ? { ...f, content } : f)));
      const fileTcs = trackedChanges.filter((c) => c.file_id === fileId && c.status === 'pending');
      for (const tc of fileTcs) await del(`/api/tracked-changes/${tc.id}`);
      setTrackedChanges((tcs) => tcs.filter((c) => c.file_id !== fileId));
      const file = files.find((f) => f.id === fileId);
      if (file) switchFile({ ...file, content });
    },
    [files, switchFile, trackedChanges],
  );

  const [editorLine, setEditorLine] = useState(1);
  const [pdfClickPos, setPdfClickPos] = useState(null);

  const handleSyncForward = useCallback(async () => {
    if (!project || !activeFile || !pdfUrl) return;
    try {
      const res = await get(
        `/api/compile/${project.id}/syncforward?line=${editorLine}&column=0&file=${encodeURIComponent(activeFile.path)}`,
      );
      if (res.ok) {
        const data = await res.json();
        pdfRef.current?.scrollToPosition(data.page, data.v);
      }
    } catch {}
  }, [project, activeFile, pdfUrl, editorLine]);

  const handleSyncInverse = useCallback(
    async (page, x, y) => {
      if (!project) return;
      try {
        const res = await get(`/api/compile/${project.id}/syncinverse?page=${page}&x=${x}&y=${y}`);
        if (res.ok) {
          const data = await res.json();
          if (data.file && data.file !== activeFile?.path) {
            const f = files.find((f) => f.path === data.file);
            if (f) {
              switchFile(f);
              setTimeout(() => editorRef.current?.goToLine(data.line, data.column), 50);
              return;
            }
          }
          editorRef.current?.goToLine(data.line, data.column);
        }
      } catch {}
    },
    [project, activeFile, files, switchFile],
  );

  const handleSyncInverseFromArrow = useCallback(async () => {
    if (!pdfClickPos || !project) return;
    await handleSyncInverse(pdfClickPos.page, pdfClickPos.x, pdfClickPos.y);
  }, [pdfClickPos, project, handleSyncInverse]);

  const goBack = useCallback(() => {
    projectGoBack();
    setPdfUrl(null);
    setComments([]);
  }, [projectGoBack]);

  const handleLogoutFull = useCallback(async () => {
    await handleLogout();
    setProject(null);
    setFiles([]);
    setActiveFile(null);
    setPdfUrl(null);
  }, [handleLogout]);

  const mainFilePath = project?.main_file || 'main.tex';
  const tapsDiagnostics = useMemo(() => tapsCheck(files, mainFilePath), [files, mainFilePath]);

  const handleTapsCheck = useCallback(() => {
    const results = tapsCheck(files, mainFilePath);
    if (results.length === 0) {
      setConsoleOutput('ACM TAPS Check: All packages are on the approved list. ✓');
    } else {
      const lines = ['ACM TAPS Check: Found ' + results.length + ' issue(s):\n'];
      for (const r of results) {
        lines.push(`${r.file}:${r.line}: ${r.message}`);
      }
      setConsoleOutput(lines.join('\n'));
    }
  }, [files]);

  const handleFormatDocument = useCallback(async () => {
    const formatter = localStorage.getItem('flowtex-latex-formatter');
    if (!formatter) {
      setConsoleOutput('No LaTeX formatter selected. Set one in Project Settings > Editor.');
      return;
    }
    if (!activeFile || !activeFile.path.endsWith('.tex')) return;
    const content = editorRef.current?.getContent?.();
    if (!content) return;
    setConsoleOutput('Formatting...');
    try {
      const res = await post('/api/compile/format', { content, formatter });
      const data = await res.json();
      if (!res.ok) {
        setConsoleOutput(`Format error: ${data.error}`);
        return;
      }
      editorRef.current?.replaceContent(data.formatted);
      setConsoleOutput('Document formatted.');
    } catch (err) {
      setConsoleOutput(`Format error: ${err.message}`);
    }
  }, [activeFile]);

  const [wordCountState, setWordCountState] = useState({ open: false, loading: false, data: null, error: null });

  const handleWordCount = useCallback(async () => {
    setWordCountState({ open: true, loading: true, data: null, error: null });
    try {
      const res = await get(`/api/compile/${project.id}/wordcount`);
      const data = await res.json();
      if (!res.ok) {
        setWordCountState({ open: true, loading: false, data: null, error: data.error || 'Unknown error' });
        return;
      }
      setWordCountState({ open: true, loading: false, data, error: null });
    } catch (e) {
      setWordCountState({ open: true, loading: false, data: null, error: e.message });
    }
  }, [project?.id]);

  // --- Render ---

  if (!authChecked) return <div className="auth-loading">Loading...</div>;
  if (!user) return <AuthPage onAuth={setUser} />;
  if (showAdmin && user.isAdmin) {
    return (
      <Suspense fallback={<div className="loading-spinner" />}>
        <AdminDashboard
          onBack={() => {
            setShowAdmin(false);
            window.history.pushState(null, '', '/');
          }}
        />
      </Suspense>
    );
  }
  if (!project) {
    return (
      <ProjectList
        onSelect={selectProject}
        user={user}
        onLogout={handleLogoutFull}
        onUserUpdate={setUser}
        onAdmin={() => {
          setShowAdmin(true);
          window.history.pushState(null, '', '/admin');
        }}
      />
    );
  }

  return (
    <div className="app">
      {ui.showHistory ? (
        <div className="history-toolbar">
          <button className="history-back-btn" onClick={() => ui.setShowHistory(false)}>
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
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back to editor
          </button>
          <span className="history-toolbar-title">History — {project.name}</span>
        </div>
      ) : (
        <Toolbar
          projectName={project.name}
          projectId={project.id}
          onBack={goBack}
          users={activeUsers}
          currentUser={user}
          isOwner={members.some((m) => m.id === user?.id && m.role === 'owner')}
          onRename={async (newName) => {
            await patch(`/api/projects/${project.id}`, { name: newName });
            setProject((p) => ({ ...p, name: newName }));
          }}
          onShare={() => ui.setShowShareModal(true)}
          onLogout={handleLogoutFull}
          activeFile={activeFile}
          onPrettyPrint={() => {
            if (!activeFile?.path?.endsWith('.bib')) return;
            const content = editorRef.current?.getContent();
            if (content == null) return;
            const pretty = prettyBib(content);
            editorRef.current?.replaceContent?.(pretty);
            handleSave(pretty);
          }}
          onSearch={() => editorRef.current?.openSearch()}
          onHistory={() => ui.setShowHistory(true)}
          onNewFile={() => setNewFileCounter((c) => c + 1)}
          onNewFolder={() => setNewFolderCounter((c) => c + 1)}
          onInsert={(before, after) => editorRef.current?.insertSnippet(before, after)}
          onSymbolPicker={() => editorRef.current?.openSymbolPicker()}
          onToggleComments={() => ui.setShowComments((v) => !v)}
          onToggleLineNumbers={() => ui.setShowLineNumbers((v) => !v)}
          onToggleWordWrap={() => ui.setWordWrap((v) => !v)}
          trackChangesMode={trackChangesMode}
          onToggleTrackChanges={() => setTrackChangesMode((v) => !v)}
          showComments={ui.showComments}
          showLineNumbers={ui.showLineNumbers}
          wordWrap={ui.wordWrap}
          onHelp={(topic) => {
            if (topic === 'shortcuts')
              alert(
                'Keyboard Shortcuts:\n\nCtrl/Cmd+S — Save & Compile\nCtrl/Cmd+F — Find & Replace\nCtrl/Cmd+Click — Comment on selection',
              );
            else if (topic === 'about') alert('FlowTex — A collaborative LaTeX editor');
          }}
          onCompareFiles={() => ui.setShowCompareFiles(true)}
          onGitHubSync={() => ui.setShowGitHubSync(true)}
          onBibEnrich={activeFile?.path?.endsWith('.bib') ? () => ui.setShowBibEnrich(true) : null}
          onZotero={() => ui.setShowZotero(true)}
          onTapsCheck={handleTapsCheck}
          onWordCount={handleWordCount}
          onProjectSettings={() => ui.setShowProjectSettings(true)}
          onFormatDocument={handleFormatDocument}
          githubLink={githubLink}
          autoSyncStatus={autoSyncStatus}
          lastSyncAt={githubLink?.lastSyncAt}
          onToggleAutoSync={handleToggleAutoSync}
          spellLanguages={LANGUAGES}
          spellLang={editorRef.current?.getSpellLang?.() || getLanguage()}
          onSpellLangChange={(code) => editorRef.current?.setSpellLang(code)}
          onUploadZip={async (file) => {
            if (!project) return;
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch(`/api/projects/${project.id}/upload-zip`, {
              method: 'POST',
              body: formData,
              credentials: 'include',
              headers: { 'X-CSRF-Token': getCsrfToken() },
            });
            if (res.ok) {
              const data = await res.json();
              setFiles(data.files);
            }
          }}
          onUserClick={(u) => {
            const cursor = remoteCursors[u.id];
            if (cursor) {
              if (cursor.fileId !== activeFile?.id) {
                const f = files.find((f) => f.id === cursor.fileId);
                if (f) switchFile(f);
              }
              setTimeout(() => editorRef.current?.goToPosition(cursor.head), 50);
            }
          }}
        />
      )}
      {ui.showShareModal && (
        <ShareModal
          projectId={project.id}
          onClose={() => {
            ui.setShowShareModal(false);
            get(`/api/projects/${project.id}/members`)
              .then((r) => r.json())
              .then(setMembers)
              .catch(() => {});
          }}
        />
      )}
      {ui.showProjectSettings && (
        <ProjectSettingsModal
          project={project}
          files={files}
          isOwner={members.some((m) => m.id === user?.id && m.role === 'owner')}
          onClose={() => {
            ui.setShowProjectSettings(false);
            setProjectSettingsTab(null);
          }}
          onUpdate={(updated) => setProject((p) => ({ ...p, ...updated }))}
          trackChangesMode={trackChangesMode}
          onTrackChangesChange={setTrackChangesMode}
          autoSaveOn={!!githubLink?.autoPush}
          onAutoSaveChange={async (val) => {
            await patch(`/api/github/link/${project.id}/auto-push`, { enabled: val });
            setGithubLink((prev) => (prev ? { ...prev, autoPush: val } : prev));
          }}
          githubLinked={!!githubLink?.linked}
          initialTab={projectSettingsTab}
        />
      )}
      {wordCountState.open && (
        <WordCountModal
          data={wordCountState.data}
          loading={wordCountState.loading}
          error={wordCountState.error}
          onClose={() => setWordCountState((s) => ({ ...s, open: false }))}
        />
      )}
      {ui.showCompareFiles && (
        <CompareFilesModal
          projectId={project.id}
          files={files}
          onClose={() => ui.setShowCompareFiles(false)}
          onStartDiff={handleDiff}
        />
      )}
      {ui.showGitHubSync && (
        <Suspense fallback={null}>
          <GitHubSyncModal
            projectId={project.id}
            projectName={project.name}
            onClose={() => ui.setShowGitHubSync(false)}
            onFilesUpdated={(files) => setFiles(files)}
            onLinkChanged={(linkData) => setGithubLink(linkData)}
          />
        </Suspense>
      )}
      {ui.showBibEnrich && activeFile?.path?.endsWith('.bib') && (
        <Suspense fallback={null}>
          <BibEnrichModal
            file={activeFile}
            onClose={() => ui.setShowBibEnrich(false)}
            onApply={(newContent) => {
              handleSave(newContent);
              setFiles((prev) => prev.map((f) => (f.id === activeFile.id ? { ...f, content: newContent } : f)));
              setActiveFile((prev) => (prev ? { ...prev, content: newContent } : prev));
            }}
          />
        </Suspense>
      )}
      {ui.showZotero && (
        <Suspense fallback={null}>
          <ZoteroModal
            onClose={() => ui.setShowZotero(false)}
            bibFileExists={files.some((f) => f.path.endsWith('.bib'))}
            onInsert={async (bibtex) => {
              let bibFile = files.find((f) => f.path.endsWith('.bib'));
              if (!bibFile) {
                try {
                  const res = await post(`/api/projects/${project.id}/files`, {
                    path: 'references.bib',
                    content: bibtex,
                  });
                  const newFile = await res.json();
                  setFiles((prev) => [...prev, newFile]);
                  switchFile(newFile);
                } catch (e) {
                  console.error('Failed to create .bib file', e);
                }
                return;
              }
              const newContent = bibFile.content.trimEnd() + '\n\n' + bibtex;
              setFiles((prev) => prev.map((f) => (f.id === bibFile.id ? { ...f, content: newContent } : f)));
              if (activeFile?.id === bibFile.id) {
                setActiveFile((prev) => (prev ? { ...prev, content: newContent } : prev));
                setTimeout(() => editorRef.current?.replaceContent(newContent), 50);
              }
              await put(`/api/projects/files/${bibFile.id}`, { content: newContent });
            }}
          />
        </Suspense>
      )}
      <div className="main-layout">
        {ui.showHistory && (
          <>
            <div
              className="file-panel history-file-panel"
              style={{ width: ui.fileTreeWidth, display: 'flex', flexDirection: 'column', flexShrink: 0 }}
            >
              <div
                className="file-tree-header"
                style={{
                  padding: '8px 10px',
                  borderBottom: '1px solid var(--border)',
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                }}
              >
                Files
              </div>
              <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
                {(ui.historyFiles || files).map((f) => (
                  <div
                    key={f.id}
                    className={`history-file-item ${ui.historySelectedFile?.id === f.id ? 'active' : ''}`}
                    onClick={() => ui.setHistorySelectedFile({ id: f.id, path: f.path })}
                    style={{
                      padding: '4px 12px',
                      fontSize: 13,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      color: 'var(--text-primary)',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.path}
                    </span>
                    {ui.historyEditedFileIds.includes(f.id) && (
                      <span className="history-file-edited-badge">Edited</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <Suspense fallback={null}>
              <HistoryPanel
                projectId={project.id}
                currentUserName={user?.name}
                historyFileId={ui.historySelectedFile?.id}
                historyFilePath={ui.historySelectedFile?.path}
                refreshKey={historyVersion}
                snapshotInterval={project.snapshot_interval_sec || 30}
                onSnapshotIntervalChange={async (val) => {
                  await fetch(`/api/projects/${project.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
                    credentials: 'include',
                    body: JSON.stringify({ snapshot_interval_sec: val }),
                  });
                  setProject((p) => ({ ...p, snapshot_interval_sec: val }));
                }}
                onClose={() => {
                  ui.setShowHistory(false);
                  ui.setHistoryEditedFileIds([]);
                  ui.setHistoryFiles(null);
                  ui.setHistorySelectedFile(null);
                }}
                onRestore={(restoredFiles) => {
                  setFiles(restoredFiles);
                  ui.setShowHistory(false);
                  ui.setHistoryEditedFileIds([]);
                  ui.setHistoryFiles(null);
                  ui.setHistorySelectedFile(null);
                  const stillExists = restoredFiles.find((f) => f.id === activeFile?.id);
                  if (stillExists) {
                    setActiveFile(stillExists);
                    setTimeout(() => editorRef.current?.replaceContent(stillExists.content), 50);
                  } else if (restoredFiles.length > 0) {
                    const mainFile = restoredFiles.find((f) => f.path === (project?.main_file || 'main.tex'));
                    setActiveFile(mainFile || restoredFiles[0]);
                    setTimeout(() => editorRef.current?.replaceContent((mainFile || restoredFiles[0]).content), 50);
                  } else setActiveFile(null);
                }}
                onSelectVersion={async (snapshot) => {
                  ui.setHistorySelectedFile(null);
                  try {
                    const res = await get(`/api/history/snapshot/${snapshot.id}`);
                    const data = await res.json();
                    ui.setHistoryEditedFileIds(data.editedFileIds || []);
                    ui.setHistoryFiles(data.files || null);
                    if (data.editedFileIds?.length > 0) {
                      const firstEdited = data.files?.find((f) => f.id === data.editedFileIds[0]);
                      if (firstEdited) ui.setHistorySelectedFile({ id: firstEdited.id, path: firstEdited.path });
                    }
                  } catch {
                    ui.setHistoryEditedFileIds([]);
                    ui.setHistoryFiles(null);
                  }
                }}
              />
            </Suspense>
          </>
        )}
        {!ui.showHistory && (
          <>
            {ui.showFiles ? (
              <>
                <div
                  className="file-panel"
                  style={{ width: ui.fileTreeWidth, display: 'flex', flexDirection: 'column', flexShrink: 0 }}
                >
                  <FileTree
                    files={files}
                    activeFile={activeFile}
                    onSelect={switchFile}
                    onCreate={handleCreateFile}
                    onOverwrite={handleOverwriteFile}
                    onDelete={handleDeleteFile}
                    onRename={handleRenameFile}
                    onRenameFolder={handleRenameFolder}
                    onDeleteFolder={handleDeleteFolder}
                    onSetMainFile={handleSetMainFile}
                    mainFile={project?.main_file || 'main.tex'}
                    startAdding={newFileCounter}
                    startAddingFolder={newFolderCounter}
                    style={{ flex: 1, width: '100%' }}
                    onDownload={(file) => {
                      const fileName = file.path.split('/').pop();
                      if (file.is_binary) {
                        const mime = getMimeType(file.path);
                        const blob = new Blob([Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0))], {
                          type: mime,
                        });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = fileName;
                        a.click();
                        URL.revokeObjectURL(url);
                      } else {
                        const blob = new Blob([file.content || ''], { type: 'text/plain' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = fileName;
                        a.click();
                        URL.revokeObjectURL(url);
                      }
                    }}
                    onPrettyPrint={(file) => {
                      if (!file.path.endsWith('.bib')) return;
                      switchFile(file);
                      setTimeout(() => {
                        const content = editorRef.current?.getContent();
                        if (content == null) return;
                        const pretty = prettyBib(content);
                        editorRef.current?.replaceContent?.(pretty);
                        handleSave(pretty);
                      }, 100);
                    }}
                    onCollapse={() => ui.setShowFiles(false)}
                  />
                  {generatedFiles.length > 0 && (
                    <div className="generated-files-panel" style={{ height: ui.genPanelHeight }}>
                      <div
                        className="generated-files-resize-handle"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          let startY = e.clientY;
                          const onMove = (ev) => {
                            const delta = startY - ev.clientY;
                            startY = ev.clientY;
                            ui.setGenPanelHeight((h) => Math.max(60, Math.min(400, h + delta)));
                          };
                          const onUp = () => {
                            document.removeEventListener('mousemove', onMove);
                            document.removeEventListener('mouseup', onUp);
                            document.body.style.cursor = '';
                            document.body.style.userSelect = '';
                          };
                          document.addEventListener('mousemove', onMove);
                          document.addEventListener('mouseup', onUp);
                          document.body.style.cursor = 'row-resize';
                          document.body.style.userSelect = 'none';
                        }}
                      />
                      <div className="generated-files-header">Generated Files</div>
                      <div className="generated-files-list">
                        {generatedFiles.map((gf) => (
                          <div
                            key={gf.name}
                            className={`generated-file-item ${activeGenFile?.name === gf.name ? 'active' : ''}`}
                            onClick={async () => {
                              try {
                                const res = await get(
                                  `/api/compile/${project.id}/generated-file?name=${encodeURIComponent(gf.name)}`,
                                );
                                const data = await res.json();
                                setActiveGenFile({ name: data.name, content: data.content });
                              } catch {}
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              ui.setGenContextMenu({ x: e.clientX, y: e.clientY, name: gf.name });
                            }}
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              style={{ flexShrink: 0, opacity: 0.5 }}
                            >
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                              <polyline points="14 2 14 8 20 8" />
                            </svg>
                            <span className="generated-file-name">{stripJobSuffix(gf.name)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {ui.genContextMenu && (
                    <GenFileContextMenu
                      x={ui.genContextMenu.x}
                      y={ui.genContextMenu.y}
                      name={ui.genContextMenu.name}
                      onClose={() => ui.setGenContextMenu(null)}
                      onDownload={async (name) => {
                        try {
                          const res = await get(
                            `/api/compile/${project.id}/generated-file?name=${encodeURIComponent(name)}`,
                          );
                          const data = await res.json();
                          const blob = new Blob([data.content], { type: 'text/plain' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = name;
                          a.click();
                          URL.revokeObjectURL(url);
                        } catch {}
                      }}
                    />
                  )}
                </div>
                <ResizeHandle onResize={(d) => ui.setFileTreeWidth((w) => Math.max(120, Math.min(400, w + d)))} />
              </>
            ) : (
              <button className="files-toggle-btn" onClick={() => ui.setShowFiles(true)} title="Show files">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            )}
            {ui.showComments ? (
              <>
                <CommentsSidebar
                  currentUserName={user?.name}
                  comments={comments}
                  selection={selection}
                  selectionFormTop={selectionFormTop}
                  commentPositions={commentPositions}
                  onAdd={handleAddComment}
                  onResolve={handleResolveComment}
                  onDelete={handleDeleteComment}
                  onEdit={handleEditComment}
                  onCancelComment={() => setSelection(null)}
                  onReply={handleReplyComment}
                  onWheel={(e) => editorRef.current?.scrollBy(e.deltaX, e.deltaY)}
                  onClose={() => ui.setShowComments(false)}
                  style={{ width: ui.commentsWidth }}
                />
                <ResizeHandle onResize={(d) => ui.setCommentsWidth((w) => Math.max(180, Math.min(450, w + d)))} />
              </>
            ) : (
              <button className="comments-toggle-btn" onClick={() => ui.setShowComments(true)} title="Show comments">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            )}
            <div className="editor-area">
              {activeGenFile ? (
                <div className="generated-file-viewer">
                  <div className="editor-header">
                    <span className="editor-header-filename">{stripJobSuffix(activeGenFile.name)}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>generated file (read-only)</span>
                    <button className="editor-header-btn" onClick={() => setActiveGenFile(null)} title="Close">
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
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                  <pre className="generated-file-content">{activeGenFile.content}</pre>
                </div>
              ) : activeFile?.is_binary ? (
                <BinaryPreview file={activeFile} />
              ) : (
                <>
                  <Editor
                    ref={editorRef}
                    file={activeFile}
                    comments={comments}
                    currentUserName={user?.name}
                    projectId={project?.id}
                    onSave={handleSave}
                    onLineChange={setEditorLine}
                    onChanges={(changes) => sendWsMessage({ type: 'changes', fileId: activeFile?.id, changes })}
                    onCursorChange={(head, anchor) =>
                      sendWsMessage({ type: 'cursor', fileId: activeFile?.id, head, anchor })
                    }
                    onCompile={handleCompile}
                    onRequestComment={(sel) => {
                      setSelection(sel);
                      ui.setShowComments(true);
                    }}
                    onScroll={updateCommentPositions}
                    onLintDiagnostics={setLintDiagnostics}
                    showLineNumbers={ui.showLineNumbers}
                    wordWrap={ui.wordWrap}
                    trackChangesMode={trackChangesMode}
                    trackedChanges={trackedChanges}
                    onTrackChange={handleTrackChange}
                    onTrackedChangeClick={(changeId, pos) =>
                      setTcPopup((prev) => (prev?.changeId === changeId ? null : { changeId, x: pos.x, y: pos.y }))
                    }
                    onDeleteInsertionChar={handleDeleteInsertionChar}
                    onToggleTrackChanges={() => setTrackChangesMode((m) => !m)}
                    citeKeys={citeKeys}
                    autoSaveOn={!!githubLink?.autoPush}
                    autoSaveLabel={
                      githubLink?.linked && githubLink?.autoPush
                        ? autoSyncStatus === 'saving'
                          ? 'Saving...'
                          : autoSyncStatus === 'error'
                            ? 'Save failed'
                            : githubLink?.lastSyncAt
                              ? `Saved ${formatSyncDate(githubLink.lastSyncAt)}`
                              : null
                        : null
                    }
                    projectFiles={files}
                    onGoToFile={(fileId, line, col) => {
                      const f = files.find((f) => f.id === fileId);
                      if (f) {
                        if (f.id !== activeFile?.id) {
                          switchFile(f);
                          setTimeout(() => editorRef.current?.goToLine(line, col), 100);
                        } else editorRef.current?.goToLine(line, col);
                      }
                    }}
                    onToggleAutoSave={
                      githubLink?.linked
                        ? async () => {
                            const newVal = !githubLink.autoPush;
                            await patch(`/api/github/link/${project.id}/auto-push`, { enabled: newVal });
                            setGithubLink((prev) => (prev ? { ...prev, autoPush: newVal } : prev));
                          }
                        : null
                    }
                  />
                  <TrackChangesPopup
                    tcPopup={tcPopup}
                    trackedChanges={trackedChanges}
                    onAccept={handleAcceptChange}
                    onReject={handleRejectChange}
                    onClose={() => setTcPopup(null)}
                  />
                  <TrackChangesReviewBar
                    trackedChanges={trackedChanges}
                    onAcceptAll={handleAcceptAllChanges}
                    onRejectAll={handleRejectAllChanges}
                    onAccept={handleAcceptChange}
                    onReject={handleRejectChange}
                    onGoToPosition={(pos) => editorRef.current?.goToPosition(pos)}
                  />
                </>
              )}
            </div>
            <div className="sync-arrows-wrapper">
              <SyncArrows
                onSyncForward={handleSyncForward}
                onSyncInverse={handleSyncInverseFromArrow}
                hasPdf={!!pdfUrl}
                hasPdfPosition={!!pdfClickPos}
              />
            </div>
            <ResizeHandle
              onResize={(d) =>
                ui.setPdfWidth((w) => {
                  const current = w || document.querySelector('.pdf-viewer')?.offsetWidth || 500;
                  return Math.max(250, current - d);
                })
              }
            />
            <PdfViewer
              ref={pdfRef}
              url={pdfUrl}
              compiling={compiling}
              onCompile={handleCompile}
              onStopCompile={async () => {
                if (project) await post(`/api/compile/${project.id}/stop`);
              }}
              onCleanCompile={async () => {
                if (!project) return;
                setConsoleOutput('Cleaning generated files...\n');
                const res = await post(`/api/compile/${project.id}/clean`);
                const data = await res.json();
                setConsoleOutput(`Deleted ${data.deleted} generated file(s). Recompiling from scratch...\n`);
                handleCompile();
              }}
              onCleanFiles={async () => {
                if (!project) return;
                const res = await post(`/api/compile/${project.id}/clean`);
                const data = await res.json();
                setConsoleOutput(`Deleted ${data.deleted} generated file(s).`);
                setGeneratedFiles([]);
                setActiveGenFile(null);
              }}
              onPdfClick={handleSyncInverse}
              onPdfPositionChange={setPdfClickPos}
              compileLog={compileLog}
              consoleOutput={consoleOutput}
              lintDiagnostics={lintDiagnostics}
              style={ui.pdfWidth ? { flex: 'none', width: ui.pdfWidth } : undefined}
              onGoToLine={(line, col) => editorRef.current?.goToLine(line, col)}
              onGoToFileAndLine={(filePath, line, col) => {
                const f = files.find((f) => f.path === filePath);
                if (f) {
                  switchFile(f);
                  setTimeout(() => editorRef.current?.goToLine(line, col), 50);
                } else editorRef.current?.goToLine(line, col);
              }}
              tapsDiagnostics={tapsDiagnostics}
              showBoxWarnings={showBoxWarnings}
              onOpenSettings={(tab) => {
                setProjectSettingsTab(tab || null);
                ui.setShowProjectSettings(true);
              }}
            />
            {showChat ? (
              <ChatPanel
                messages={chatMessages}
                currentUser={user}
                onSend={(text) => sendWsMessage({ type: 'chat', text })}
                onClose={() => setShowChat(false)}
              />
            ) : (
              <button
                className="chat-toggle-btn"
                onClick={() => {
                  setShowChat(true);
                  setUnreadChat(0);
                }}
                title="Open chat"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                {unreadChat > 0 && <span className="chat-badge">{unreadChat}</span>}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  );
}
