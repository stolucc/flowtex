import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import ProjectList from './components/ProjectList.jsx';
import Editor from './components/Editor.jsx';
import PdfViewer from './components/PdfViewer.jsx';
import FileTree from './components/FileTree.jsx';
import CommentsSidebar from './components/CommentsSidebar.jsx';
import SyncArrows from './components/SyncArrows.jsx';
import ResizeHandle from './components/ResizeHandle.jsx';
import Toolbar from './components/Toolbar.jsx';
import AuthPage from './components/AuthPage.jsx';
import SetupWizard from './components/SetupWizard.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import BinaryPreview, { getMimeType } from './components/BinaryPreview.jsx';
import { TrackChangesPopup, TrackChangesReviewBar } from './components/TrackChangesBar.jsx';
import ModalContainer from './components/ModalContainer.jsx';
import HistoryView from './components/HistoryView.jsx';
import { ChevronLeftIcon, CloseIcon, FileDocumentIcon, FolderIcon } from './components/Icons.jsx';

const AdminDashboard = lazy(() => import('./components/AdminDashboard.jsx'));
import { get, post, patch, getCsrfToken } from './api.js';
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
import useEditorActions from './hooks/useEditorActions.js';
import { formatSyncDate } from './utils/dateFormat.js';

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
  const { user, setUser, authChecked, handleLogout, needsSetup, setNeedsSetup } = useAuth();
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
  const [mainFileChanged, setMainFileChanged] = useState(false);

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
    handleUndoInsertions,
    handleAcceptChange,
    handleRejectChange,
    handleAcceptAllChanges,
    handleRejectAllChanges,
    reviewing,
    reviewIndex,
    reviewCurrentChange,
    pendingChanges,
    startReview,
    stopReview,
    reviewNext,
    reviewPrev,
    acceptAndNext,
    rejectAndNext,
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
    typingUsers,
    sendWsMessage,
    wsConnected,
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
    handleStopCompile,
    handleDiff,
  } = useCompilation(project, activeFile, handleSave, editorRef);

  const { githubLink, setGithubLink, hasGithubToken, setHasGithubToken, autoSyncStatus, handleToggleAutoSync } =
    useGitHubSync(project);

  const ui = useUIState();

  const [showBoxWarnings, setShowBoxWarnings] = useState(true);
  const [showLintWarnings, setShowLintWarnings] = useState(true);
  const [groupFilesByType, setGroupFilesByType] = useState(true);
  const [tapsEnabled, setTapsEnabled] = useState(false);
  const [projectSettingsTab, setProjectSettingsTab] = useState(null);

  const {
    editorLine,
    setEditorLine,
    pdfClickPos,
    setPdfClickPos,
    wordCountState,
    setWordCountState,
    handleOverwriteFile,
    handleSyncForward,
    handleSyncInverse,
    handleSyncInverseFromArrow,
    goBack,
    handleLogoutFull,
    tapsDiagnostics,
    handleTapsCheck,
    handleFormatDocument,
    handleWordCount,
    citeKeys,
    labelKeys,
    mainFilePath,
  } = useEditorActions({
    project,
    files,
    activeFile,
    switchFile,
    trackedChanges,
    setTrackedChanges,
    setFiles,
    setActiveFile,
    editorRef,
    pdfRef,
    pdfUrl,
    setPdfUrl,
    setConsoleOutput,
    setComments,
    projectGoBack,
    handleLogout,
    handleSave,
    setProject,
    handleCompile,
  });

  const handleUploadBinary = useCallback(
    async (file, fileName) => {
      if (!project) return;
      const formData = new FormData();
      formData.append('file', file);
      formData.append('path', fileName);
      try {
        const res = await fetch(`/api/projects/${project.id}/upload-file`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'X-CSRF-Token': getCsrfToken() },
          body: formData,
        });
        if (!res.ok) return;
        const result = await res.json();
        if (result.updated) {
          setFiles((fs) =>
            fs.map((f) => (f.id === result.id ? { ...f, content: result.content, is_binary: true } : f)),
          );
        } else {
          setFiles((fs) => [...fs, result]);
        }
        handleCompile?.();
      } catch (err) {
        console.error('Binary upload failed:', err);
      }
    },
    [project, handleCompile],
  );

  useEffect(() => {
    if (project?.id) {
      const stored = localStorage.getItem(`flowtex-show-box-warnings-${project.id}`);
      if (stored !== null) setShowBoxWarnings(stored === 'true');
      const lintStored = localStorage.getItem(`flowtex-show-lint-warnings-${project.id}`);
      if (lintStored !== null) setShowLintWarnings(lintStored === 'true');
      const groupStored = localStorage.getItem(`flowtex-group-files-${project.id}`);
      if (groupStored !== null) setGroupFilesByType(groupStored !== 'false');
      const tapsStored = localStorage.getItem(`flowtex-taps-enabled-${project.id}`);
      if (tapsStored !== null) setTapsEnabled(tapsStored !== 'false');
    }
  }, [project?.id]);

  useEffect(() => {
    const handler = (e) => {
      if (e.detail.showBoxWarnings !== undefined) setShowBoxWarnings(e.detail.showBoxWarnings);
      if (e.detail.showLintWarnings !== undefined) setShowLintWarnings(e.detail.showLintWarnings);
      if (e.detail.groupFilesByType !== undefined) setGroupFilesByType(e.detail.groupFilesByType);
      if (e.detail.tapsEnabled !== undefined) setTapsEnabled(e.detail.tapsEnabled);
    };
    window.addEventListener('flowtex:settings-changed', handler);
    return () => window.removeEventListener('flowtex:settings-changed', handler);
  }, []);

  // --- Effects that wire hooks together ---

  useEffect(() => {
    const changesHandler = (e) => {
      editorRef.current?.applyRemoteChanges(e.detail.fileId, e.detail.changes, e.detail.tracked, e.detail.deletions);
    };
    const tcDeleteHandler = (e) => {
      editorRef.current?.applyRemoteTcDelete(e.detail.fileId, e.detail.from, e.detail.to);
    };
    const removedHandler = () => {
      alert('You have been removed from this project.');
      goBack();
    };
    window.addEventListener('ws:changes', changesHandler);
    window.addEventListener('ws:tc-delete-mark', tcDeleteHandler);
    window.addEventListener('ws:removed-from-project', removedHandler);
    return () => {
      window.removeEventListener('ws:changes', changesHandler);
      window.removeEventListener('ws:tc-delete-mark', tcDeleteHandler);
      window.removeEventListener('ws:removed-from-project', removedHandler);
    };
  }, []);

  // TC resolve: editor content is synced via normal OT from resolveTrackedChangeEdit,
  // so receiving user only needs the status update (handled in useWebSocket)

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

  // --- Render ---

  if (!authChecked) return <div className="auth-loading">Loading...</div>;
  if (needsSetup)
    return (
      <SetupWizard
        onComplete={(u) => {
          setNeedsSetup(false);
          setUser(u);
        }}
      />
    );
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
            <ChevronLeftIcon />
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
          onUndo={() => editorRef.current?.undo()}
          onRedo={() => editorRef.current?.redo()}
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
            if (topic === 'shortcuts') ui.setShowShortcuts(true);
            else if (topic === 'about') ui.setShowAbout(true);
          }}
          onCompareFiles={() => ui.setShowCompareFiles(true)}
          onGitHubSync={() => ui.setShowGitHubSync(true)}
          onBibEnrich={activeFile?.path?.endsWith('.bib') ? () => ui.setShowBibEnrich(true) : null}
          onZotero={() => ui.setShowZotero(true)}
          onTapsCheck={tapsEnabled ? handleTapsCheck : null}
          onWordCount={handleWordCount}
          onProjectSettings={() => ui.setShowProjectSettings(true)}
          onFormatDocument={handleFormatDocument}
          showBoxWarnings={showBoxWarnings}
          onToggleBoxWarnings={() => {
            const newVal = !showBoxWarnings;
            setShowBoxWarnings(newVal);
            localStorage.setItem(`flowtex-show-box-warnings-${project?.id}`, newVal);
          }}
          showChat={showChat}
          onToggleChat={() => setShowChat((v) => !v)}
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
            if (!cursor) return;
            if (cursor.fileId === activeFile?.id) {
              editorRef.current?.goToPosition(cursor.head);
            } else {
              const f = files.find((f) => f.id === cursor.fileId);
              if (f) {
                switchFile(f);
                // Wait for editor to mount with the new file before jumping
                const tryJump = (attempts = 0) => {
                  const view = editorRef.current;
                  if (view && attempts < 20) {
                    setTimeout(() => {
                      editorRef.current?.goToPosition(cursor.head);
                    }, 100);
                  } else if (attempts < 20) {
                    setTimeout(() => tryJump(attempts + 1), 50);
                  }
                };
                tryJump();
              }
            }
          }}
        />
      )}
      <ModalContainer
        project={project}
        files={files}
        activeFile={activeFile}
        user={user}
        members={members}
        ui={ui}
        setProject={setProject}
        setMembers={setMembers}
        setFiles={setFiles}
        setActiveFile={setActiveFile}
        switchFile={switchFile}
        editorRef={editorRef}
        trackChangesMode={trackChangesMode}
        setTrackChangesMode={setTrackChangesMode}
        githubLink={githubLink}
        setGithubLink={setGithubLink}
        hasGithubToken={hasGithubToken}
        handleDiff={handleDiff}
        handleSave={handleSave}
        wordCountState={wordCountState}
        setWordCountState={setWordCountState}
        projectSettingsTab={projectSettingsTab}
        setProjectSettingsTab={setProjectSettingsTab}
      />
      <div className="main-layout">
        {ui.showHistory && (
          <HistoryView
            project={project}
            files={files}
            activeFile={activeFile}
            user={user}
            ui={ui}
            historyVersion={historyVersion}
            setProject={setProject}
            setFiles={setFiles}
            setActiveFile={setActiveFile}
            editorRef={editorRef}
          />
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
                    groupByType={groupFilesByType}
                    onSelect={switchFile}
                    onCreate={handleCreateFile}
                    onOverwrite={handleOverwriteFile}
                    onUploadBinary={handleUploadBinary}
                    onDelete={handleDeleteFile}
                    onRename={handleRenameFile}
                    onRenameFolder={handleRenameFolder}
                    onDeleteFolder={handleDeleteFolder}
                    onSetMainFile={(path) => {
                      handleSetMainFile(path);
                      setPdfUrl(null);
                      setMainFileChanged(true);
                      setCompileLog('');
                      setConsoleOutput('');
                      setLintDiagnostics([]);
                    }}
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
                            <FileDocumentIcon />
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
                <FolderIcon />
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
            {project && !wsConnected && (
              <div className="ws-disconnected-banner">
                Connection lost — reconnecting. Changes are saved locally and will sync when the connection is restored.
              </div>
            )}
            <div className="editor-area">
              {activeGenFile ? (
                <div className="generated-file-viewer">
                  <div className="editor-header">
                    <span className="editor-header-filename">{stripJobSuffix(activeGenFile.name)}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>generated file (read-only)</span>
                    <button className="editor-header-btn" onClick={() => setActiveGenFile(null)} title="Close">
                      <CloseIcon />
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
                    onChanges={(changes, tracked, deletions) =>
                      sendWsMessage({
                        type: 'changes',
                        fileId: activeFile?.id,
                        changes,
                        ...(tracked ? { tracked: true } : {}),
                        ...(deletions ? { deletions } : {}),
                      })
                    }
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
                    reviewingChangeId={reviewCurrentChange?.id || null}
                    onTrackChange={handleTrackChange}
                    onTrackedChangeClick={(changeId, pos) =>
                      setTcPopup((prev) => (prev?.changeId === changeId ? null : { changeId, x: pos.x, y: pos.y }))
                    }
                    onDeleteInsertionChar={handleDeleteInsertionChar}
                    onUndoInsertions={handleUndoInsertions}
                    onTrackDeletion={(from, to) =>
                      sendWsMessage({ type: 'tc-delete-mark', fileId: activeFile?.id, from, to })
                    }
                    onToggleTrackChanges={() => setTrackChangesMode((m) => !m)}
                    pendingChangesCount={pendingChanges.length}
                    reviewing={reviewing}
                    reviewIndex={reviewIndex}
                    reviewCurrentChange={reviewCurrentChange}
                    onStartReview={startReview}
                    onStopReview={stopReview}
                    onAcceptAndNext={acceptAndNext}
                    onRejectAndNext={rejectAndNext}
                    onAcceptAll={handleAcceptAllChanges}
                    onRejectAll={handleRejectAllChanges}
                    onReviewNext={reviewNext}
                    onReviewPrev={reviewPrev}
                    citeKeys={citeKeys}
                    labelKeys={labelKeys}
                    autoSaveOn={!!hasGithubToken && !!githubLink?.linked && !!githubLink?.autoPush}
                    autoSaveLabel={
                      hasGithubToken && githubLink?.linked && githubLink?.autoPush
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
                    onToggleAutoSave={async () => {
                      // Always re-check token freshly
                      let tokenOk = hasGithubToken;
                      try {
                        const r = await get('/api/github/token');
                        const d = await r.json();
                        tokenOk = !!d.hasToken;
                        setHasGithubToken(tokenOk);
                      } catch {}

                      if (!tokenOk) {
                        // No GitHub account connected — send to GitHub settings
                        ui.setShowProjectSettings(true);
                        setProjectSettingsTab('github');
                        return;
                      }
                      if (!githubLink?.linked) {
                        // GitHub connected but no repo linked — open Git Sync modal
                        ui.setShowGitHubSync(true);
                        return;
                      }
                      const newVal = !githubLink.autoPush;
                      await patch(`/api/github/link/${project.id}/auto-push`, { enabled: newVal });
                      setGithubLink((prev) => (prev ? { ...prev, autoPush: newVal } : prev));
                    }}
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
                    reviewing={reviewing}
                    reviewIndex={reviewIndex}
                    reviewCurrentChange={reviewCurrentChange}
                    pendingChanges={pendingChanges}
                    onStartReview={startReview}
                    onStopReview={stopReview}
                    onReviewNext={reviewNext}
                    onReviewPrev={reviewPrev}
                    onAcceptAndNext={acceptAndNext}
                    onRejectAndNext={rejectAndNext}
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
              onCompile={() => {
                setMainFileChanged(false);
                handleCompile();
              }}
              onStopCompile={handleStopCompile}
              onCleanCompile={async () => {
                if (!project || compiling) return;
                setConsoleOutput('Cleaning generated files...\n');
                const res = await post(`/api/compile/${project.id}/clean`);
                const data = await res.json();
                setConsoleOutput(`Deleted ${data.deleted} generated file(s). Recompiling from scratch...\n`);
                await handleCompile();
              }}
              onCleanFiles={async () => {
                if (!project || compiling) return;
                const res = await post(`/api/compile/${project.id}/clean`);
                const data = await res.json();
                setConsoleOutput(`Deleted ${data.deleted} generated file(s).`);
                setPdfUrl(null);
                setGeneratedFiles([]);
                setActiveGenFile(null);
              }}
              onPdfClick={handleSyncInverse}
              onPdfPositionChange={setPdfClickPos}
              compileLog={compileLog}
              consoleOutput={consoleOutput}
              lintDiagnostics={showLintWarnings ? lintDiagnostics : []}
              style={ui.pdfWidth ? { flex: 'none', width: ui.pdfWidth } : undefined}
              onGoToLine={(line, col) => editorRef.current?.goToLine(line, col)}
              onGoToFileAndLine={(filePath, line, col) => {
                const f = files.find((f) => f.path === filePath);
                if (f) {
                  switchFile(f);
                  setTimeout(() => editorRef.current?.goToLine(line, col), 50);
                } else editorRef.current?.goToLine(line, col);
              }}
              tapsDiagnostics={tapsEnabled ? tapsDiagnostics : []}
              showBoxWarnings={showBoxWarnings}
              mainFileExists={files.some((f) => f.path === mainFilePath)}
              mainFileChanged={mainFileChanged}
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
                onTyping={() => sendWsMessage({ type: 'typing' })}
                typingUsers={typingUsers}
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
