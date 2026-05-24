import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import ProjectList from './components/ProjectList.jsx';
// Editor/PdfViewer/HistoryView/ChatPanel/CommentsSidebar/BinaryPreview
// only render once a project is loaded. Lazy-loading them keeps the
// 300+ KB of CodeMirror, pdfjs, and diff/decoration code out of the
// first paint on the ProjectList / AuthPage screens.
const Editor = lazy(() => import('./components/Editor.jsx'));
const PdfViewer = lazy(() => import('./components/PdfViewer.jsx'));
const HistoryView = lazy(() => import('./components/HistoryView.jsx'));
const ChatPanel = lazy(() => import('./components/ChatPanel.jsx'));
const CommentsSidebar = lazy(() => import('./components/CommentsSidebar.jsx'));
const BinaryPreview = lazy(() => import('./components/BinaryPreview.jsx'));
import FileTree from './components/FileTree.jsx';
import SyncArrows from './components/SyncArrows.jsx';
import ResizeHandle from './components/ResizeHandle.jsx';
import Toolbar from './components/Toolbar.jsx';
import AuthPage from './components/AuthPage.jsx';
import SetupWizard from './components/SetupWizard.jsx';
import { getMimeType } from './utils/mimeType.js';
import ModalContainer from './components/ModalContainer.jsx';
import { ChevronLeftIcon, CloseIcon, FileDocumentIcon, FolderIcon } from './components/Icons.jsx';

const AdminDashboard = lazy(() => import('./components/AdminDashboard.jsx'));
import { get, post, patch, upload } from './api.js';
import prettyBib from './utils/prettyBib.js';
import { LANGUAGES, getLanguage, setLanguage } from './utils/spellcheck.js';
import { getSetting, setSetting } from './utils/settings.js';

import { useAuth, AuthProvider } from './contexts/AuthContext.jsx';
import { EditorRefProvider } from './contexts/EditorRefContext.jsx';
import { ProjectProvider } from './contexts/ProjectContext.jsx';
import useProject from './hooks/useProject.js';
import useWebSocket from './hooks/useWebSocket.js';
import useCompilation from './hooks/useCompilation.js';
import useHelperStatus from './hooks/useHelperStatus.js';
import { HelperStatusProvider } from './contexts/HelperStatusContext.jsx';
import useTrackedChanges from './hooks/useTrackedChanges.js';
import TrackChangesBar from './components/TrackChangesBar.jsx';
import TrackChangesPanel from './components/TrackChangesPanel.jsx';
import NotificationBell from './components/NotificationBell.jsx';
import useComments from './hooks/useComments.js';
import useGitHubSync from './hooks/useGitHubSync.js';
import useNotifications from './hooks/useNotifications.js';
import useUIState from './hooks/useUIState.js';
import useClickOutside from './hooks/useClickOutside.js';
import useEditorActions from './hooks/useEditorActions.js';
import { formatSyncDate } from './utils/dateFormat.js';

/** Context menu for generated files, allowing download. */
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

/** Strips the compile-job hash suffix from a generated filename for display. */
function stripJobSuffix(filename) {
  return filename.replace(/_[0-9a-f]{8}(?=\.)/, '').replace(/^__diff__/, 'diff');
}

/** Toast that pops up in the editor when a new invitation arrives while
 *  the user is inside a project. The dashboard's pending-invitation banner
 *  is the canonical surface; this toast is the temporary heads-up for
 *  recipients who happen to be mid-edit. Auto-dismisses; or click "Open
 *  dashboard" to jump straight to the banner. */
function InvitationToast({ invitation, onDismiss, onOpen }) {
  return (
    <div className="invitation-toast" role="status">
      <div className="invitation-toast-icon" aria-hidden="true">✉</div>
      <div className="invitation-toast-body">
        <div className="invitation-toast-title">New invitation</div>
        <div className="invitation-toast-detail">
          <strong>{invitation.inviter_name || 'Someone'}</strong> invited you to{' '}
          <strong>{invitation.project_name || 'a project'}</strong>
        </div>
        <button type="button" className="invitation-toast-open" onClick={onOpen}>
          Open dashboard
        </button>
      </div>
      <button
        type="button"
        className="invitation-toast-close"
        onClick={onDismiss}
        aria-label="Dismiss invitation notification"
      >
        ×
      </button>
    </div>
  );
}

/** Main application shell: wires together all hooks and renders the editor layout. */
function AppInner() {
  const { user, setUser, authChecked, handleLogout, needsSetup, setNeedsSetup } = useAuth();
  const [showAdmin, setShowAdmin] = useState(window.location.pathname === '/admin');

  // Once the user is authenticated, prefetch the two largest lazy
  // chunks (Editor and PdfViewer) in the background. The user is
  // overwhelmingly likely to open a project from ProjectList; by the
  // time they click, the chunks are already cached so the first paint
  // of the editor view doesn't pay the network round-trip. The import
  // promises are intentionally not awaited — failures here just mean
  // we fall back to the regular Suspense fetch.
  useEffect(() => {
    if (!user) return;
    import('./components/Editor.jsx').catch(() => {});
    import('./components/PdfViewer.jsx').catch(() => {});
  }, [user]);

  // In-editor toasts for invitations that arrive while a user is mid-edit.
  // The dashboard's banner is still the canonical surface — these are
  // ephemeral heads-ups so the recipient sees the invite without having
  // to return to the dashboard themselves.
  const [invitationToasts, setInvitationToasts] = useState([]);
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
    handleCreateFolder,
    emptyFolders,
    handleSetMainFile,
  } = useProject(user);

  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;

  // Mirror of `project` for cross-async use. The auto-compile + side-load
  // effect below captures the project id at start and uses this ref to
  // detect mid-flight project switches and drop the stale payload.
  const projectRef = useRef(project);
  projectRef.current = project;

  const sendWsRef = useRef(null);

  const [historyVersion, setHistoryVersion] = useState(0);
  const [mainFileChanged, setMainFileChanged] = useState(false);

  // Bell-notification deep-link target. Set when the user clicks a mention
  // in the dropdown; cleared once the editor has scrolled to the comment.
  // Held in a ref AND mirror state so we can both kick effects and read
  // the latest value inside async chains.
  const pendingMentionNavRef = useRef(null);
  const [pendingMentionNavTick, setPendingMentionNavTick] = useState(0);

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
    handleReactComment,
    handleReactReply,
    updateCommentPositions,
  } = useComments(activeFile, sendWsRef, editorRef);

  const {
    trackChangesMode,
    setTrackChangesMode,
    pendingChanges,
    tcPositions,
    updateTcPositions,
    refreshFromDoc,
    handleAcceptAllChanges,
    handleRejectAllChanges,
    reviewing,
    reviewIndex,
    reviewCurrentChange,
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
  } = useWebSocket(user, project, activeFileRef, { setComments, setHistoryVersion });

  sendWsRef.current = sendWsMessage;

  const {
    mentions: notifMentions,
    unreadCount: notifUnread,
    refresh: refreshNotifications,
    markSeen: notifMarkSeen,
    markAllSeen: notifMarkAllSeen,
  } = useNotifications(user);

  const [showTrackedChangesInPdf, setShowTrackedChangesInPdf] = useState(false);

  // Single helper-status probe loop for the whole app. Enabled whenever
  // the operator has the feature flag on — every place that wants to
  // show "is the helper paired" or compute a compile choice reads from
  // the same context, so they cant disagree. The cost is one fetch
  // every 3 s (not green) or 60 s (green) against localhost; for users
  // on the server flag off this hook is fully inert.
  const helperStatusHook = useHelperStatus({
    enabled: !!user?.serverFeatures?.localCompile,
  });
  const helperStatusForCompile = helperStatusHook.status;

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
    compileChoice,
  } = useCompilation(project, activeFile, handleSave, editorRef, {
    showTrackedChanges: showTrackedChangesInPdf,
    user,
    helperStatus: helperStatusForCompile,
    files,
  });

  const { githubLink, setGithubLink, hasGithubToken, autoSyncStatus, handleToggleAutoSync } =
    useGitHubSync(project);
  const autoSaveActive = !!hasGithubToken && !!githubLink?.linked && !!githubLink?.autoPush;

  const ui = useUIState();

  const [showBoxWarnings, setShowBoxWarnings] = useState(true);
  const [showLintWarnings, setShowLintWarnings] = useState(true);
  const [groupFilesByType, setGroupFilesByType] = useState(true);
  const [tapsEnabled, setTapsEnabled] = useState(false);
  const [projectSettingsTab, setProjectSettingsTab] = useState(null);
  const [spellLang, setSpellLangState] = useState(() => getLanguage());

  const {
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
    formatWarning,
    setFormatWarning,
    handleWordCount,
    citeKeys,
    labelKeys,
    mainFilePath,
  } = useEditorActions({
    project,
    files,
    activeFile,
    switchFile,
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
    handleStopCompile,
  });

  const handleUploadBinary = useCallback(
    async (file, fileName) => {
      if (!project) return;
      const formData = new FormData();
      formData.append('file', file);
      formData.append('path', fileName);
      try {
        const res = await upload(`/api/projects/${project.id}/upload-file`, formData);
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
    [project, handleCompile, setFiles],
  );

  useEffect(() => {
    if (project?.id) {
      const stored = getSetting(`show-box-warnings-${project.id}`);
      if (stored !== null) setShowBoxWarnings(stored === 'true');
      const lintStored = getSetting(`show-lint-warnings-${project.id}`);
      if (lintStored !== null) setShowLintWarnings(lintStored === 'true');
      const groupStored = getSetting(`group-files-${project.id}`);
      if (groupStored !== null) setGroupFilesByType(groupStored !== 'false');
      const tapsStored = getSetting(`taps-enabled-${project.id}`);
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
      editorRef.current?.applyRemoteChanges(
        e.detail.fileId,
        e.detail.changes,
        e.detail.tracked,
        e.detail.deletions,
        e.detail.tcMarks,
      );
    };
    const removedHandler = () => {
      alert('You have been removed from this project.');
      goBack();
    };
    window.addEventListener('ws:changes', changesHandler);
    window.addEventListener('ws:removed-from-project', removedHandler);
    return () => {
      window.removeEventListener('ws:changes', changesHandler);
      window.removeEventListener('ws:removed-from-project', removedHandler);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!project) return;
    // Capture the project id we're loading FOR. If the user switches to a
    // different project before any of these async calls resolves, the
    // late-arriving payload would otherwise overwrite the new project's
    // state — that's the same bug class as the useCompilation leak
    // (commit b023333). All three branches below check this on resolution
    // and drop the result if the project changed.
    const loadingId = project.id;
    const stillCurrent = () => projectRef.current?.id === loadingId;

    if (needsAutoCompile.current) {
      needsAutoCompile.current = false;
      const autoCompileTimer = setTimeout(() => {
        if (!stillCurrent()) return;
        post(`/api/compile/${loadingId}`)
          .then((r) => r.json())
          .then((data) => {
            if (!stillCurrent()) return;
            setCompileLog(data.log || '');
            if (data.success) setPdfUrl(`/api/compile/${loadingId}/pdf?t=${Date.now()}`);
          });
      }, 100);
      // If the project changes before the timeout fires, the inner check
      // already short-circuits, but we still want the timer cleaned up to
      // avoid leaving a no-op pending.
      return () => clearTimeout(autoCompileTimer);
    }
    get(`/api/compile/${loadingId}/generated-files`)
      .then((r) => r.json())
      .then((d) => { if (stillCurrent()) setGeneratedFiles(d.files || []); })
      .catch((e) => console.warn('Failed to load generated files:', e));
    get(`/api/chat/${loadingId}`)
      .then((r) => r.json())
      .then((msgs) => { if (stillCurrent()) setChatMessages(msgs || []); })
      .catch((e) => console.warn('Failed to load chat messages:', e));
  }, [project, needsAutoCompile, setChatMessages, setCompileLog, setGeneratedFiles, setPdfUrl]);

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

  // Bell-notification deep-link executor. The click handler stashes a target
  // (projectId, fileId, commentId) and ticks the counter. As project +
  // files + comments arrive — possibly across several React renders — this
  // effect picks up the work, advances one step, and re-runs on the next
  // state arrival until either everything matches (scroll + done) or the
  // user navigates away. Tiered to avoid one giant when-everything-is-true
  // gate that would silently misfire if the comment shows up first.
  useEffect(() => {
    const target = pendingMentionNavRef.current;
    if (!target) return;
    // 1. Wait for the correct project to be loaded.
    if (target.projectId && target.projectId !== project?.id) return;
    // 2. Wait for the project's file list to arrive.
    if (!files || files.length === 0) return;
    // 3. If we are not on the right file yet, switch to it.
    const targetFile = files.find((f) => f.id === target.fileId)
      || files.find((f) => f.path === target.filePath);
    if (!targetFile) {
      // File listed in the mention is gone (renamed away or deleted) —
      // give up rather than spin forever.
      pendingMentionNavRef.current = null;
      return;
    }
    if (activeFile?.id !== targetFile.id) {
      setActiveFile(targetFile);
      return; // next render will re-enter the effect with activeFile updated
    }
    // 4. Comments for this file have loaded; find the target comment.
    if (!target.commentId) {
      // Reply mention without a comment id (shouldnt happen for current
      // payloads, but be defensive) — just opened the file, done.
      pendingMentionNavRef.current = null;
      return;
    }
    const targetComment = comments.find((c) => c.id === target.commentId);
    if (!targetComment) {
      // Comments may still be in-flight; another render will retry. But
      // if the comments list is non-empty and our id isnt in it, the
      // comment was deleted — stop retrying.
      if (comments.length > 0) pendingMentionNavRef.current = null;
      return;
    }
    // 5. Scroll the editor to the comments anchor. The sidebars elastic
    //    positioning will follow because it listens to editor scroll.
    const pos = Math.min(targetComment.from_pos, targetComment.to_pos);
    // Small delay so the editor view is mounted + the file content is
    // applied before we ask it to scroll. 50ms matches the initial-scroll
    // settle window used elsewhere in this file.
    setTimeout(() => editorRef.current?.goToPosition(pos), 50);
    pendingMentionNavRef.current = null;
  }, [pendingMentionNavTick, project?.id, files, activeFile?.id, comments, setActiveFile]);

  // Listen for invitation pushes while in an editor view. (When on the
  // dashboard, ProjectList listens separately for the same event and
  // updates its banner — no duplicate handling because the two views
  // are mutually exclusive.) Each toast auto-dismisses after 10s.
  useEffect(() => {
    if (!user || !project) return;
    const onInvitation = (e) => {
      const inv = e.detail;
      if (!inv?.id) return;
      setInvitationToasts((toasts) =>
        toasts.some((t) => t.id === inv.id) ? toasts : [...toasts, inv],
      );
      setTimeout(() => {
        setInvitationToasts((toasts) => toasts.filter((t) => t.id !== inv.id));
      }, 10000);
    };
    window.addEventListener('ws:invitation', onInvitation);
    return () => window.removeEventListener('ws:invitation', onInvitation);
  }, [user, project]);

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
    // ?invite=<inviteId> arrives via email links. We pass it straight to
    // ProjectList, which highlights / locates the matching invitation
    // after its /invitations/mine fetch resolves. Wrong-recipient links
    // fall through to a "not for you" banner.
    const pendingInviteId = new URLSearchParams(window.location.search).get('invite') || null;
    return (
      <HelperStatusProvider value={helperStatusHook}>
        <ProjectList
          onSelect={selectProject}
          user={user}
          onLogout={handleLogoutFull}
          onUserUpdate={setUser}
          pendingInviteId={pendingInviteId}
          onAdmin={() => {
            setShowAdmin(true);
            window.history.pushState(null, '', '/admin');
          }}
        />
      </HelperStatusProvider>
    );
  }

  return (
    <HelperStatusProvider value={helperStatusHook}>
    <EditorRefProvider value={editorRef}>
      <ProjectProvider
        value={{
          project,
          setProject,
          files,
          setFiles,
          activeFile,
          setActiveFile,
          members,
          setMembers,
          switchFile,
        }}
      >
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
          showTrackedChangesInline={ui.showTrackedChangesInline}
          onToggleTrackedChangesInline={() => ui.setShowTrackedChangesInline((v) => !v)}
          showChangesPanel={ui.showChangesPanel}
          onToggleChangesPanel={() => ui.setShowChangesPanel((v) => !v)}
          onToggleLineNumbers={() => ui.setShowLineNumbers((v) => !v)}
          onToggleWordWrap={() => ui.setWordWrap((v) => !v)}
          trackChangesMode={trackChangesMode}
          onToggleTrackChanges={() => setTrackChangesMode((v) => !v)}
          showComments={ui.showComments}
          showLineNumbers={ui.showLineNumbers}
          wordWrap={ui.wordWrap}
          visualMode={ui.visualMode}
          onToggleVisualMode={() => ui.setVisualMode((v) => !v)}
          theme={ui.theme}
          onToggleTheme={() => ui.setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
          notificationsSlot={
            <NotificationBell
              mentions={notifMentions}
              unreadCount={notifUnread}
              currentProjectId={project?.id}
              onOpen={refreshNotifications}
              onMarkSeen={notifMarkSeen}
              onMarkAllSeen={notifMarkAllSeen}
              onNavigate={async (m) => {
                // Record the deep-link target. The effect below executes the
                // remaining steps as state catches up: switch file → wait for
                // comments to load → scroll editor to the comments from_pos.
                pendingMentionNavRef.current = {
                  projectId: m.project_id,
                  fileId: m.file_id,
                  filePath: m.file_path,
                  commentId: m.comment_id,
                };
                setPendingMentionNavTick((t) => t + 1);
                ui.setShowComments(true);
                if (m.project_id && m.project_id !== project?.id) {
                  try {
                    const r = await get('/api/projects');
                    if (r.ok) {
                      const projects = await r.json();
                      const target = projects.find((p) => p.id === m.project_id);
                      if (target) selectProject(target);
                    }
                  } catch (e) {
                    console.warn('Failed to switch project for mention:', e);
                  }
                }
              }}
            />
          }
          onHelp={(topic) => {
            if (topic === 'shortcuts') ui.setShowShortcuts(true);
            else if (topic === 'about') ui.setShowAbout(true);
            else if (topic === 'bug-report') ui.setShowBugReport(true);
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
            setSetting(`show-box-warnings-${project?.id}`, newVal);
          }}
          showChat={showChat}
          onToggleChat={() => setShowChat((v) => !v)}
          onZoomIn={() => editorRef.current?.zoomIn()}
          onZoomOut={() => editorRef.current?.zoomOut()}
          showTrackedChangesInPdf={showTrackedChangesInPdf}
          onToggleTrackedChangesInPdf={() => setShowTrackedChangesInPdf((v) => !v)}
          githubLink={githubLink}
          autoSyncStatus={autoSyncStatus}
          lastSyncAt={githubLink?.lastSyncAt}
          onToggleAutoSync={handleToggleAutoSync}
          spellLanguages={LANGUAGES}
          spellLang={spellLang}
          onSpellLangChange={(code) => {
            setLanguage(code);
            setSpellLangState(code);
          }}
          onUploadZip={async (file) => {
            if (!project) return;
            const formData = new FormData();
            formData.append('file', file);
            const res = await upload(`/api/projects/${project.id}/upload-zip`, formData);
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
                // Wait for editor to mount with the new file before jumping.
                // Always increment `attempts` so we don't loop forever if the
                // editor never mounts (or mounts immediately).
                const tryJump = (attempts = 0) => {
                  if (attempts >= 20) return;
                  const view = editorRef.current;
                  if (view) {
                    setTimeout(() => editorRef.current?.goToPosition(cursor.head), 100);
                  } else {
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
        user={user}
        ui={ui}
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
      {invitationToasts.length > 0 && (
        <div className="invitation-toast-stack">
          {invitationToasts.map((inv) => (
            <InvitationToast
              key={inv.id}
              invitation={inv}
              onDismiss={() => setInvitationToasts((toasts) => toasts.filter((t) => t.id !== inv.id))}
              onOpen={() => {
                // Stash the invitation id so the dashboard highlights it
                // on mount (same hook the email-click path uses).
                window.history.pushState({}, '', `/?invite=${encodeURIComponent(inv.id)}`);
                setInvitationToasts((toasts) => toasts.filter((t) => t.id !== inv.id));
                goBack();
              }}
            />
          ))}
        </div>
      )}
      {formatWarning && (
        <div className="modal-overlay confirm-dialog-overlay" onClick={() => setFormatWarning(null)}>
          <div className="modal-card confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-dialog-message">{formatWarning}</p>
            <div className="confirm-dialog-actions">
              <button className="confirm-dialog-cancel" onClick={() => setFormatWarning(null)}>
                Cancel
              </button>
              <button
                className="confirm-dialog-confirm"
                onClick={() => {
                  setFormatWarning(null);
                  setProjectSettingsTab('editor');
                  ui.setShowProjectSettings(true);
                }}
              >
                Open Settings
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="main-layout">
        {/* One Suspense wraps every lazy editor-side component
            (Editor, PdfViewer, ChatPanel, CommentsSidebar, HistoryView,
            BinaryPreview). The fallback is intentionally minimal —
            chunks are small individually and load quickly; a
            full-screen spinner would be more disruptive than the brief
            blank during the swap. */}
        <Suspense fallback={<div className="main-layout-suspense" />}>
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
                    emptyFolders={emptyFolders}
                    onCreateFolder={handleCreateFolder}
                    onSetMainFile={async (path) => {
                      // handleSetMainFile throws if the PATCH fails — keep the
                      // local-state cleanup gated on success so a 403 / 4xx
                      // doesnt leave the UI claiming a stale main file.
                      try {
                        await handleSetMainFile(path);
                      } catch (err) {
                        alert(err.message || 'Could not set main file');
                        return;
                      }
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
                      // Pretty-print using the file's own content. Reading from the editor after
                      // switchFile + setTimeout races against further file switches and could
                      // pretty-print whichever file the editor happens to show when the timer fires.
                      const source = file.content;
                      if (source == null) return;
                      const pretty = prettyBib(source);
                      switchFile(file);
                      // After the switch settles, push the pretty content into the editor — but
                      // only if the editor is still on this file (use the ref so we observe the
                      // current activeFile, not the closed-over one from click time).
                      setTimeout(() => {
                        if (activeFileRef.current?.id === file.id) {
                          editorRef.current?.replaceContent?.(pretty);
                        }
                      }, 100);
                      handleSave(pretty, file.id);
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
                              } catch (e) {
                                console.warn('Failed to load generated file', e);
                              }
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
                        } catch (e) {
                          console.warn('Failed to download generated file', e);
                        }
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
                  currentUserId={user?.id}
                  members={members}
                  comments={comments}
                  selection={selection}
                  selectionFormTop={selectionFormTop}
                  commentPositions={commentPositions}
                  onAdd={handleAddComment}
                  onResolve={handleResolveComment}
                  onDelete={handleDeleteComment}
                  onEdit={handleEditComment}
                  onReact={handleReactComment}
                  onReactReply={handleReactReply}
                  onCancelComment={() => setSelection(null)}
                  onReply={handleReplyComment}
                  onWheel={(e) => editorRef.current?.scrollBy(e.deltaX, e.deltaY)}
                  onClose={() => ui.setShowComments(false)}
                  style={{ width: ui.commentsWidth }}
                />
                <ResizeHandle onResize={(d) => ui.setCommentsWidth((w) => Math.max(180, Math.min(450, w + d)))} />
              </>
            ) : (
              // Collapsed comments rail: a thin vertical strip that
              // still surfaces WHERE the comments are by rendering a
              // tiny bubble at each comment's y-position. Clicking any
              // bubble (or empty space) re-opens the full panel.
              // commentPositions already filters out resolved comments
              // and gives a `top` in editor-viewport coordinates, so
              // the dots line up with the source lines they annotate.
              <button
                className="comments-toggle-btn comments-rail"
                onClick={() => ui.setShowComments(true)}
                title={commentPositions?.length
                  ? `Show comments (${commentPositions.length})`
                  : 'Show comments'}
                aria-label="Show comments"
              >
                {commentPositions?.map((p) => (
                  <span
                    key={p.id}
                    className="comments-rail-marker"
                    style={{ top: Math.max(0, p.top) }}
                    aria-hidden="true"
                  />
                ))}
                {/* Speech bubble with inner text lines — reads as "annotation"
                    (i.e., comments tied to specific text in the document), to
                    distinguish from the chat icon which is a multi-bubble
                    conversation glyph. */}
                <svg
                  className="comments-rail-icon"
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
                  <line x1="7" y1="9" x2="17" y2="9" />
                  <line x1="7" y1="13" x2="13" y2="13" />
                </svg>
              </button>
            )}
            {ui.showChangesPanel ? (
              <>
                <div style={{ width: ui.changesPanelWidth, flexShrink: 0 }}>
                  <TrackChangesPanel
                    // Read LIVE doc text from the editor (the saved
                    // `activeFile.content` lags behind the debounced save).
                    // pendingChanges is regenerated on every doc change
                    // via refreshFromDoc, so the panel re-renders with
                    // the latest snapshot.
                    docText={editorRef.current?.getContent?.() ?? activeFile?.content ?? ''}
                    pendingChanges={pendingChanges}
                    tcPositions={tcPositions}
                    currentUserId={user?.id}
                    currentUserName={user?.name}
                    onAccept={(id) => acceptAndNext(id)}
                    onReject={(id) => rejectAndNext(id)}
                    onAcceptAll={handleAcceptAllChanges}
                    onRejectAll={handleRejectAllChanges}
                    onGoToPosition={(pos) => editorRef.current?.goToPosition(pos)}
                    onClose={() => ui.setShowChangesPanel(false)}
                  />
                </div>
                <ResizeHandle
                  onResize={(d) => ui.setChangesPanelWidth((w) => Math.max(180, Math.min(450, w + d)))}
                />
              </>
            ) : (
              <button
                className="tc-toggle-btn"
                onClick={() => ui.setShowChangesPanel(true)}
                title={`Show tracked changes panel${pendingChanges.length > 0 ? ` (${pendingChanges.length})` : ''}`}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="8" y1="13" x2="16" y2="13" stroke="#e06c75" strokeWidth="2" />
                  <line x1="8" y1="17" x2="13" y2="17" stroke="#61afef" strokeWidth="2" />
                </svg>
                {pendingChanges.length > 0 && (
                  <span className="tc-toggle-badge">{pendingChanges.length}</span>
                )}
              </button>
            )}
            <div className="editor-area">
              {project && !wsConnected && (
                <div className="ws-disconnected-banner" role="status">
                  <span className="ws-disconnected-dot" aria-hidden="true" />
                  Connection lost — reconnecting. Edits stay local until it&apos;s back.
                </div>
              )}
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
                    currentUserId={user?.id}
                    projectId={project?.id}
                    onSave={handleSave}
                    onLineChange={setEditorLine}
                    onChanges={(changes, tracked, deletions, tcMarks) =>
                      sendWsMessage({
                        type: 'changes',
                        fileId: activeFile?.id,
                        changes,
                        ...(tracked ? { tracked: true } : {}),
                        ...(deletions ? { deletions } : {}),
                        ...(tcMarks ? { tcMarks } : {}),
                      })
                    }
                    onCursorChange={(head, anchor) =>
                      sendWsMessage({ type: 'cursor', fileId: activeFile?.id, head, anchor })
                    }
                    onDocChange={refreshFromDoc}
                    onCompile={handleCompile}
                    onRequestComment={(sel) => {
                      setSelection(sel);
                      ui.setShowComments(true);
                    }}
                    onScroll={() => {
                      updateCommentPositions();
                      updateTcPositions();
                    }}
                    onLintDiagnostics={setLintDiagnostics}
                    showLineNumbers={ui.showLineNumbers}
                    wordWrap={ui.wordWrap}
                    visualMode={ui.visualMode}
                    onToggleVisualMode={() => ui.setVisualMode((v) => !v)}
                    spellLang={spellLang}
                    trackChangesMode={trackChangesMode}
                    onToggleTrackChanges={() => setTrackChangesMode((m) => !m)}
                    showTrackedChangesInline={ui.showTrackedChangesInline}
                    citeKeys={citeKeys}
                    labelKeys={labelKeys}
                    autoSaveOn={autoSaveActive}
                    autoSaveLabel={
                      autoSaveActive
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
                      if (!hasGithubToken) {
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
                      setGithubLink((prev) => (prev ? { ...prev, autoPush: newVal } : prev));
                      await patch(`/api/github/link/${project.id}/auto-push`, { enabled: newVal });
                    }}
                  />
                  <TrackChangesBar
                    pendingChanges={pendingChanges}
                    reviewing={reviewing}
                    reviewIndex={reviewIndex}
                    reviewCurrentChange={reviewCurrentChange}
                    currentUserId={user?.id}
                    currentUserName={user?.name}
                    onStartReview={startReview}
                    onStopReview={stopReview}
                    onReviewNext={reviewNext}
                    onReviewPrev={reviewPrev}
                    onAcceptAndNext={acceptAndNext}
                    onRejectAndNext={rejectAndNext}
                    onAcceptAll={handleAcceptAllChanges}
                    onRejectAll={handleRejectAllChanges}
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
              compileChoice={compileChoice}
              localCompileFeatureOn={!!user?.serverFeatures?.localCompile}
              projectCompileLocation={project?.compile_location ?? null}
              onSetProjectCompileLocation={async (loc) => {
                if (!project) return;
                // Send '' for null so the server-side coerces it to NULL
                // (inherit user default). Matches the contract enforced
                // by updateProject in projectService.
                try {
                  const res = await patch(`/api/projects/${project.id}`, {
                    compile_location: loc == null ? '' : loc,
                  });
                  if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    alert(data.error || 'Could not change compile location');
                    return;
                  }
                  // Updated project echoes the new value; mirror it into
                  // local state so the dropdowns checkmark + the compile
                  // button label refresh without a reload.
                  const updated = await res.json();
                  setProject((p) => (p ? { ...p, ...updated } : p));
                } catch (err) {
                  alert(err?.message || 'Could not change compile location');
                }
              }}
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
                setCompileLog('');
                setLintDiagnostics([]);
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
              onToggleBoxWarnings={() => {
                const newVal = !showBoxWarnings;
                setShowBoxWarnings(newVal);
                setSetting(`show-box-warnings-${project?.id}`, newVal);
              }}
              mainFileExists={files.some((f) => f.path === mainFilePath)}
              mainFileChanged={mainFileChanged}
              onOpenSettings={(tab) => {
                setProjectSettingsTab(tab || null);
                ui.setShowProjectSettings(true);
              }}
              showTrackedChangesInPdf={showTrackedChangesInPdf}
              onToggleTrackedChangesInPdf={() => setShowTrackedChangesInPdf((v) => !v)}
            />
            {showChat ? (
              <ChatPanel
                messages={chatMessages}
                currentUser={user}
                onSend={(text) => sendWsMessage({ type: 'chat', text })}
                onReact={(messageId, emoji) => sendWsMessage({ type: 'chat-react', messageId, emoji })}
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
                {/* Two overlapping speech bubbles — reads as "conversation
                    between people", distinct from the single-bubble-with-
                    text-lines used for comments. */}
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
                  <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2z" />
                  <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
                </svg>
                {unreadChat > 0 && <span className="chat-badge">{unreadChat}</span>}
              </button>
            )}
          </>
        )}
        </Suspense>
      </div>
        </div>
      </ProjectProvider>
    </EditorRefProvider>
    </HelperStatusProvider>
  );
}

/** Top-level App component that wraps AppInner with the AuthProvider. */
export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  );
}
