// @ts-check
import React, { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import ProjectList from './components/ProjectList.jsx';
// Editor/PdfViewer/HistoryView/ChatPanel/CommentsSidebar/BinaryPreview
// only render once a project is loaded. Lazy-loading them keeps the
// 300+ KB of CodeMirror, pdfjs, and diff/decoration code out of the
// first paint on the ProjectList / AuthPage screens.
const Editor = lazy(() => import('./components/Editor.jsx'));
const PdfViewer = lazy(() => import('./components/PdfViewer.jsx'));
const HistoryView = lazy(() => import('./components/HistoryView.jsx'));
// CommentsSidebar + ChatPanel: NOT lazy, even though the route-level
// pattern is. Both are tiny (~2-3 KB gzipped) and toggled live during
// a session, so the Suspense boundary swap + lazy-resolve microtask
// produce a perceptible "slight lag" on first open that users notice.
// The prefetch-on-auth dance the lazy versions needed (and the inner
// Suspense wrapping around each) is unnecessary at this size --
// the chunks would just join the main bundle anyway. TrackChangesPanel
// is eager for the same reason.
import CommentsSidebar from './components/CommentsSidebar.jsx';
import ChatPanel from './components/ChatPanel.jsx';
const BinaryPreview = lazy(() => import('./components/BinaryPreview.jsx'));
import FileTree from './components/FileTree.jsx';
import OutlinePanel from './components/OutlinePanel.jsx';
import SyncArrows from './components/SyncArrows.jsx';
import ResizeHandle from './components/ResizeHandle.jsx';
import Toolbar from './components/Toolbar.jsx';
import AuthPage from './components/AuthPage.jsx';
import SetupWizard from './components/SetupWizard.jsx';
import ModalContainer from './components/ModalContainer.jsx';
import { ChevronLeftIcon, CloseIcon, FileDocumentIcon, FolderIcon } from './components/Icons.jsx';

const AdminDashboard = lazy(() => import('./components/AdminDashboard.jsx'));
const AccountSettingsModal = lazy(() => import('./components/AccountSettingsModal.jsx'));
const ProjectUnlockModal = lazy(() => import('./components/ProjectUnlockModal.jsx'));
const EnableEncryptionModal = lazy(() => import('./components/EnableEncryptionModal.jsx'));
import { get, post, patch, upload } from './api.js';
import prettyBib from './utils/prettyBib.js';
import { LANGUAGES, getLanguage, setLanguage } from './utils/spellcheck.js';
import { getSetting, setSetting } from './utils/settings.js';
import { shouldShowRailMarker } from './utils/commentsRail.js';
import {
  applyAddUsepackage,
  applyRemoveUsepackage,
  applyRenameEndEnv,
  applyAddGraphicspath,
  applySwapImageExtension,
  findGraphicspathCandidate,
  findBibFile,
  appendCitationSkeleton,
  extractContextLines,
  buildExplainPrompt,
} from './utils/latexQuickFixes.js';

import { useAuth, AuthProvider } from './contexts/AuthContext.jsx';
import { AlertProvider, useAlert } from './contexts/AlertContext.jsx';
import { EditorRefProvider } from './contexts/EditorRefContext.jsx';
import { ProjectProvider } from './contexts/ProjectContext.jsx';
import useProject from './hooks/useProject.js';
import useWebSocket from './hooks/useWebSocket.js';
import useYjsSync from './hooks/useYjsSync.js';
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
import { isReadOnlyForUser, getProjectRole } from './utils/projectRole.js';

/**
 * Context menu for generated files, allowing download.
 * @param {any} props
 */
function GenFileContextMenu({ x, y, name, onClose, onDownload }) {
  const ref = React.useRef(/** @type {any} */ (null));
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
/** @param {any} filename */
/** @param {any} filename */
function stripJobSuffix(filename) {
  return filename.replace(/_[0-9a-f]{8}(?=\.)/, '').replace(/^__diff__/, 'diff');
}

/** Toast that pops up in the editor when a new invitation arrives while
 *  the user is inside a project. The dashboard's pending-invitation banner
 *  is the canonical surface; this toast is the temporary heads-up for
 *  recipients who happen to be mid-edit. Auto-dismisses; or click "Open
 * @param {any} props
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
  const { alert: showAlert, confirm: showConfirm } = useAlert();
  // Files touched in the editor since the last compile. The PdfViewer
  // uses this to fade error rows whose line locations are now
  // potentially stale (the user already started fixing it).
  const [staleFilePaths, setStaleFilePaths] = useState(/** @type {Set<string>} */ (new Set()));

  // Helper for orchestrator fixes: when an "already-present" path
  // fires, give the user a one-click recompile instead of just text.
  // Defined as a ref-passthrough so the orchestrator body (defined
  // inline below) can call it without restructuring the closure.
  const handleCompileRef = useRef(/** @type {(() => void) | null} */ (null));
  const [showAdmin, setShowAdmin] = useState(window.location.pathname === '/admin');
  const [showAccountSettings, setShowAccountSettings] = useState(false);
  // Per-project encryption UI state.
  const [showUnlockModal, setShowUnlockModal] = useState(false);
  const [showEnableEncryptModal, setShowEnableEncryptModal] = useState(false);

  // Once the user is authenticated, prefetch the still-lazy chunks the
  // user is likely to need shortly. Editor and PdfViewer always paint
  // on project open and their chunks are large enough (~60KB and ~14KB
  // gzipped) that keeping them lazy is worthwhile -- prefetching here
  // means the chunk is in cache by the time the user opens a project
  // so the Suspense fallback rarely paints. Import promises are
  // intentionally not awaited; failures fall back to the regular
  // Suspense fetch on click. ChatPanel + CommentsSidebar are now
  // eagerly imported (tiny chunks) so no prefetch needed.
  useEffect(() => {
    if (!user) return;
    import('./components/Editor.jsx').catch(() => {});
    import('./components/PdfViewer.jsx').catch(() => {});
  }, [user]);

  // In-editor toasts for invitations that arrive while a user is mid-edit.
  // The dashboard's banner is still the canonical surface — these are
  // ephemeral heads-ups so the recipient sees the invite without having
  // to return to the dashboard themselves.
  const [invitationToasts, setInvitationToasts] = useState(/** @type {any[]} */ ([]));
  const editorRef = useRef(/** @type {any} */ (null));
  const pdfRef = useRef(/** @type {any} */ (null));

  // --- Core hooks ---
  const {
    project,
    setProject,
    files,
    setFiles,
    filesLoaded,
    reloadFiles,
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
    setLocalContent,
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

  const sendWsRef = useRef(/** @type {any} */ (null));

  const [historyVersion, setHistoryVersion] = useState(0);
  const [mainFileChanged, setMainFileChanged] = useState(false);

  // Bell-notification deep-link target. Set when the user clicks a mention
  // in the dropdown; cleared once the editor has scrolled to the comment.
  // Held in a ref AND mirror state so we can both kick effects and read
  // the latest value inside async chains.
  const pendingMentionNavRef = useRef(/** @type {any} */ (null));
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
    chatReadCursors,
    setChatReadCursors,
    unreadChat,
    setUnreadChat,
    showChat,
    setShowChat,
    typingUsers,
    sendWsMessage,
    wsConnected,
    originId: wsOriginId,
  } = useWebSocket(user, project, activeFileRef, { setComments, setHistoryVersion });

  sendWsRef.current = sendWsMessage;

  // YJS-MIGRATION phase 1.5: when the feature flag is on, create a
  // Y.js binding for the active file. The hook is a no-op (returns
  // enabled=false, extension=null) when the flag is off, so the
  // legacy `changes` flow runs unchanged on default builds.
  const yjs = useYjsSync(activeFile, sendWsMessage, wsOriginId, !!project?.encrypted);
  // Hold the yCollab extension back until the binding has resolved its
  // canonical content (yjs.hydrated). The editor mounts immediately from
  // file.content (no flicker); once hydrated, attaching the extension runs
  // Editor's reconcile-in-same-transaction so the doc matches the Y.Text
  // without a duplicate insert. Attaching before hydration would let
  // yCollab insert the canonical state ON TOP of file.content (doubling).
  const editorExtraExtensions = useMemo(
    () => (yjs.enabled && yjs.hydrated && yjs.extension ? [yjs.extension] : []),
    [yjs.enabled, yjs.hydrated, yjs.extension],
  );

  // When Y.js sync is on, the doc text is persisted by the server-side
  // Y.Doc snapshot (services/yjsRoom.js) — NOT by this HTTP PUT. Sending
  // content here would null content_yjs and 409 against the snapshot's
  // version bump on every keystroke, and desync live collaborators. So
  // drop content and persist only the tc_marks sidecar (which the Y.Doc
  // snapshot does not carry). handleSave no-ops a marks-only call with
  // no marks, so plain text edits make no HTTP request at all under Y.js.
  const handleSaveYjsAware = useCallback(
    (/** @type {string} */ content, /** @type {string} */ fileId, /** @type {any[]} */ tcMarks) => {
      if (!yjs.enabled) return handleSave(content, fileId, tcMarks);
      // Keep the in-memory copy current (mount-on-switch reads it, as does
      // client-side search) even though the text isn't sent to the server
      // here — the Y.Doc snapshot persists it. Without this the editor
      // briefly flashes the stale load-time text before the Y.Text
      // reconcile on every file switch.
      if (typeof content === 'string' && fileId) setLocalContent(fileId, content);
      return handleSave(undefined, fileId, tcMarks);
    },
    [yjs.enabled, handleSave, setLocalContent],
  );

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
    compileProfile,
    rebuildReason,
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
  // Keep the ref in sync so the orchestrator's closure can invoke
  // it without being recreated on every render.
  handleCompileRef.current = handleCompile;

  // Reset the "edited since compile" set every time a fresh compile
  // log lands -- the new errors are fresh and shouldn't be faded.
  useEffect(() => {
    if (compileLog) {
      setStaleFilePaths(new Set());
      // Also drop pending fix-ack glows -- the user has now compiled
      // past the fix and explicit acknowledgement is no longer needed.
      editorRef.current?.clearFixAcks?.();
    }
  }, [compileLog]);

  const { githubLink, setGithubLink, hasGithubToken, autoSyncStatus, handleToggleAutoSync } =
    useGitHubSync(project);
  const autoSaveActive = !!hasGithubToken && !!githubLink?.linked && !!githubLink?.autoPush;

  const ui = useUIState();

  const [showBoxWarnings, setShowBoxWarnings] = useState(true);
  const [showLintWarnings, setShowLintWarnings] = useState(true);
  const [groupFilesByType, setGroupFilesByType] = useState(true);
  const [tapsEnabled, setTapsEnabled] = useState(false);
  const [projectSettingsTab, setProjectSettingsTab] = useState(/** @type {any} */ (null));
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
    showTrackedChangesInPdf,
  });

  const handleUploadBinary = useCallback(
    async (/** @type {any} */ file, /** @type {any} */ fileName) => {
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
            fs.map((/** @type {any} */ f) => (f.id === result.id ? { ...f, content: result.content, is_binary: true } : f)),
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
    const handler = (/** @type {any} */ e) => {
      if (e.detail.showBoxWarnings !== undefined) setShowBoxWarnings(e.detail.showBoxWarnings);
      if (e.detail.showLintWarnings !== undefined) setShowLintWarnings(e.detail.showLintWarnings);
      if (e.detail.groupFilesByType !== undefined) setGroupFilesByType(e.detail.groupFilesByType);
      if (e.detail.tapsEnabled !== undefined) setTapsEnabled(e.detail.tapsEnabled);
    };
    window.addEventListener('flowtex:settings-changed', handler);
    return () => window.removeEventListener('flowtex:settings-changed', handler);
  }, []);

  // Encrypted-but-locked: api.js dispatches `project:locked` on any 423.
  // Pop the unlock modal (only when a project is open).
  useEffect(() => {
    const onLocked = () => {
      if (projectRef.current) setShowUnlockModal(true);
    };
    const onEnable = () => {
      if (projectRef.current) setShowEnableEncryptModal(true);
    };
    const onLockNow = async () => {
      const p = projectRef.current;
      if (!p) return;
      try { await post(`/api/projects/${p.id}/lock`); } catch { /* ignore */ }
      // Drop in-memory plaintext + force the unlock prompt for any
      // further access.
      setFiles([]);
      setShowUnlockModal(true);
    };
    window.addEventListener('project:locked', onLocked);
    window.addEventListener('flowtex:enable-encryption', onEnable);
    window.addEventListener('flowtex:lock-project', onLockNow);
    return () => {
      window.removeEventListener('project:locked', onLocked);
      window.removeEventListener('flowtex:enable-encryption', onEnable);
      window.removeEventListener('flowtex:lock-project', onLockNow);
    };
  }, []);

  // --- Effects that wire hooks together ---

  useEffect(() => {
    const changesHandler = (/** @type {any} */ e) => {
      editorRef.current?.applyRemoteChanges(
        e.detail.fileId,
        e.detail.changes,
        e.detail.tracked,
        e.detail.deletions,
        e.detail.tcMarks,
      );
    };
    const removedHandler = () => {
      showAlert('You have been removed from this project.', { title: 'Project access removed' });
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

    let autoCompileTimer = null;
    if (needsAutoCompile.current) {
      needsAutoCompile.current = false;
      autoCompileTimer = setTimeout(() => {
        if (!stillCurrent()) return;
        post(`/api/compile/${loadingId}`)
          .then((/** @type {any} */ r) => r.json())
          .then((/** @type {any} */ data) => {
            if (!stillCurrent()) return;
            setCompileLog(data.log || '');
            if (data.success) setPdfUrl(`/api/compile/${loadingId}/pdf?t=${Date.now()}`);
          });
      }, 100);
      // Auto-compile is fire-and-forget alongside the other fetches —
      // it used to early-return here, which had the side effect of
      // skipping the chat-history and generated-files fetches on every
      // project-reload (because needsAutoCompile is true on first load
      // of any URL-deep-linked project). Symptom: hard-refresh on a
      // project page → chat history empty until next live message.
    }
    get(`/api/compile/${loadingId}/generated-files`)
      .then((/** @type {any} */ r) => r.json())
      .then((/** @type {any} */ d) => { if (stillCurrent()) setGeneratedFiles(d.files || []); })
      .catch((/** @type {any} */ e) => console.warn('Failed to load generated files:', e));
    get(`/api/chat/${loadingId}`)
      .then((/** @type {any} */ r) => r.json())
      .then((/** @type {any} */ data) => {
        if (!stillCurrent()) return;
        // New response shape is { messages, readCursors }. Tolerate the
        // old shape (plain array) so a stale client briefly running
        // against a fresh server doesn't crash.
        const msgs = Array.isArray(data) ? data : data?.messages || [];
        const cursors = Array.isArray(data) ? [] : data?.readCursors || [];
        setChatMessages(msgs);
        /** @type {Record<string, any>} */
        const map = {};
        for (const c of cursors) map[c.userId] = c.lastReadAt;
        setChatReadCursors(map);
      })
      .catch((/** @type {any} */ e) => console.warn('Failed to load chat messages:', e));
    return () => { if (autoCompileTimer) clearTimeout(autoCompileTimer); };
  }, [project, needsAutoCompile, setChatMessages, setChatReadCursors, setCompileLog, setGeneratedFiles, setPdfUrl]);

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
    const targetFile = files.find((/** @type {any} */ f) => f.id === target.fileId)
      || files.find((/** @type {any} */ f) => f.path === target.filePath);
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
    const targetComment = comments.find((/** @type {any} */ c) => c.id === target.commentId);
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
    const onInvitation = (/** @type {any} */ e) => {
      const inv = e.detail;
      if (!inv?.id) return;
      setInvitationToasts((toasts) =>
        toasts.some((/** @type {any} */ t) => t.id === inv.id) ? toasts : [...toasts, inv],
      );
      setTimeout(() => {
        setInvitationToasts((toasts) => toasts.filter((/** @type {any} */ t) => t.id !== inv.id));
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
        onComplete={(/** @type {any} */ u) => {
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
          {!filesLoaded && (
            // Project just opened: file list, file tree, and editor are
            // all empty until the /files response lands. For projects
            // with many or large text files this takes a perceptible
            // moment. Show a centred overlay so the user knows the app
            // is working, not stuck. Disappears as soon as setFilesLoaded
            // flips true (see useProject.js).
            <div className="project-loading-overlay" role="status" aria-live="polite">
              <div className="project-loading-card">
                <div className="zip-import-spinner" aria-hidden="true" />
                <div className="project-loading-title">Loading project…</div>
                <div className="project-loading-subtitle">{project.name}</div>
              </div>
            </div>
          )}
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
          isOwner={members.some((/** @type {any} */ m) => m.id === user?.id && m.role === 'owner')}
          onRename={async (/** @type {any} */ newName) => {
            await patch(`/api/projects/${project.id}`, { name: newName });
            setProject((/** @type {any} */ p) => ({ ...p, name: newName }));
          }}
          onShare={() => ui.setShowShareModal(true)}
          onLogout={handleLogoutFull}
          onOpenAccountSettings={() => setShowAccountSettings(true)}
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
          onInsert={(/** @type {any} */ before, /** @type {any} */ after) => editorRef.current?.insertSnippet(before, after)}
          onSymbolPicker={() => editorRef.current?.openSymbolPicker()}
          onToggleComments={() => ui.setShowComments((v) => !v)}
          showTrackedChangesInline={ui.showTrackedChangesInline}
          onToggleTrackedChangesInline={() => ui.setShowTrackedChangesInline((v) => !v)}
          showChangesPanel={ui.showChangesPanel}
          onToggleChangesPanel={() => ui.setShowChangesPanel((v) => !v)}
          layoutMode={ui.layoutMode}
          onSetLayoutMode={ui.setLayoutMode}
          onOpenPdfInNewTab={() => {
            if (!project) return;
            // New tab inherits the project URL with ?layout=pdf so
            // useUIState's initialiser picks it up and lands directly
            // in the PDF-only view. Includes the active file id so
            // SyncTeX click-to-source can later wire back if we add
            // cross-tab messaging. noopener+noreferrer per OWASP.
            const url = `/project/${project.id}?layout=pdf`;
            window.open(url, '_blank', 'noopener,noreferrer');
          }}
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
              onNavigate={async (/** @type {any} */ m) => {
                // Chat mentions open the chat panel; comment mentions open
                // the comments sidebar and deep-link to the comment. Branch
                // on chat_message_id since both share the same inbox.
                if (m.chat_message_id) {
                  setShowChat(true);
                } else {
                  // Record the deep-link target. The effect below executes the
                  // remaining steps as state catches up: switch file → wait
                  // for comments to load → scroll editor to the from_pos.
                  pendingMentionNavRef.current = {
                    projectId: m.project_id,
                    fileId: m.file_id,
                    filePath: m.file_path,
                    commentId: m.comment_id,
                  };
                  setPendingMentionNavTick((t) => t + 1);
                  ui.setShowComments(true);
                }
                if (m.project_id && m.project_id !== project?.id) {
                  try {
                    const r = await get('/api/projects');
                    if (r.ok) {
                      const projects = await r.json();
                      const target = projects.find((/** @type {any} */ p) => p.id === m.project_id);
                      if (target) selectProject(target);
                    }
                  } catch (e) {
                    console.warn('Failed to switch project for mention:', e);
                  }
                }
              }}
            />
          }
          onHelp={(/** @type {any} */ topic) => {
            if (topic === 'shortcuts') ui.setShowShortcuts(true);
            else if (topic === 'about') ui.setShowAbout(true);
            else if (topic === 'bug-report') ui.setShowBugReport(true);
            else if (topic === 'helper-guide' || topic === 'user-guide') {
              // Both docs are pre-rendered at build time from
              // USER_GUIDE.md / HELPER_GUIDE.md into static HTML
              // (client/scripts/build-docs.mjs) and served at
              // /docs/<name>.html. New tab keeps the user's editor
              // session intact. Helper-guide WAS an in-app modal but
              // got promoted to a static page — same content, easier
              // to deep-link / search-in-page / share by URL.
              const file = topic === 'user-guide' ? 'user-guide.html' : 'helper-guide.html';
              window.open(`/docs/${file}`, '_blank', 'noopener');
            }
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
          onSpellLangChange={(/** @type {any} */ code) => {
            setLanguage(code);
            setSpellLangState(code);
          }}
          onUploadZip={async (/** @type {any} */ file) => {
            if (!project) return;
            const formData = new FormData();
            formData.append('file', file);
            const res = await upload(`/api/projects/${project.id}/upload-zip`, formData);
            if (res.ok) {
              const data = await res.json();
              setFiles(data.files);
            }
          }}
          onUserClick={(/** @type {any} */ u) => {
            const cursor = remoteCursors[u.id];
            if (!cursor) return;
            if (cursor.fileId === activeFile?.id) {
              editorRef.current?.goToPosition(cursor.head);
            } else {
              const f = files.find((/** @type {any} */ f) => f.id === cursor.fileId);
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
      {showAccountSettings && (
        <Suspense fallback={null}>
          <AccountSettingsModal
            user={user}
            onClose={() => setShowAccountSettings(false)}
            onUpdate={setUser}
            onAccountDeleted={handleLogoutFull}
          />
        </Suspense>
      )}
      {showUnlockModal && project && (
        <Suspense fallback={null}>
          <ProjectUnlockModal
            projectId={project.id}
            onUnlocked={() => {
              setShowUnlockModal(false);
              reloadFiles();
              handleCompileRef.current?.(); // refresh PDF now that we can read
            }}
            onCancel={() => { setShowUnlockModal(false); goBack(); }}
          />
        </Suspense>
      )}
      {showEnableEncryptModal && project && (
        <Suspense fallback={null}>
          <EnableEncryptionModal
            projectId={project.id}
            onClose={() => setShowEnableEncryptModal(false)}
            onEnabled={() => reloadFiles()}
          />
        </Suspense>
      )}
      {invitationToasts.length > 0 && (
        <div className="invitation-toast-stack">
          {invitationToasts.map((/** @type {any} */ inv) => (
            <InvitationToast
              key={inv.id}
              invitation={inv}
              onDismiss={() => setInvitationToasts((toasts) => toasts.filter((/** @type {any} */ t) => t.id !== inv.id))}
              onOpen={() => {
                // Stash the invitation id so the dashboard highlights it
                // on mount (same hook the email-click path uses).
                window.history.pushState({}, '', `/?invite=${encodeURIComponent(inv.id)}`);
                setInvitationToasts((toasts) => toasts.filter((/** @type {any} */ t) => t.id !== inv.id));
                goBack();
              }}
            />
          ))}
        </div>
      )}
      {formatWarning && (
        <div className="modal-overlay confirm-dialog-overlay" onClick={() => setFormatWarning(null)}>
          <div className="modal-card confirm-dialog" onClick={(/** @type {any} */ e) => e.stopPropagation()}>
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
        {/* Outer Suspense catches Editor and PdfViewer (loaded together
            on project open). Each side-panel below has its own inner
            Suspense with fallback={null} so first-time-toggle chunk
            loads don't unmount the editor/PDF — keeps the layout from
            blinking. The two outer chunks are prefetched on auth, so
            this fallback rarely paints in practice. */}
        <Suspense fallback={<div className="main-layout-suspense" />}>
        {ui.showHistory && (
          <Suspense fallback={null}>
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
          </Suspense>
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
                    onSetMainFile={async (/** @type {any} */ path) => {
                      // handleSetMainFile throws if the PATCH fails — keep the
                      // local-state cleanup gated on success so a 403 / 4xx
                      // doesnt leave the UI claiming a stale main file.
                      try {
                        await handleSetMainFile(path);
                      } catch (err) {
                        showAlert((err instanceof Error ? err.message : null) || 'Could not set main file', { title: 'Set main file failed' });
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
                    onDownload={(/** @type {any} */ file) => {
                      const fileName = file.path.split('/').pop();
                      if (file.is_binary) {
                        // Binary content is no longer shipped with the
                        // initial file list (it dominated the payload).
                        // Stream from /raw instead — the browser handles
                        // download via Content-Disposition + download attr.
                        const a = document.createElement('a');
                        a.href = `/api/projects/files/${file.id}/raw`;
                        a.download = fileName;
                        a.click();
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
                    onPrettyPrint={(/** @type {any} */ file) => {
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
                  <OutlinePanel
                    files={files}
                    mainFilePath={project?.main_file || 'main.tex'}
                    activeFile={activeFile}
                    height={ui.outlinePanelHeight}
                    onResize={ui.setOutlinePanelHeight}
                    onJump={(/** @type {any} */ path, /** @type {any} */ line) => {
                      // Cross-file: switch to the file holding the
                      // section, then go to line. Same-file shortcut
                      // skips the switch.
                      if (path !== activeFile?.path) {
                        const target = files.find((/** @type {any} */ f) => f.path === path);
                        if (target) {
                          switchFile(target);
                          setTimeout(() => editorRef.current?.goToLine(line), 60);
                          return;
                        }
                      }
                      editorRef.current?.goToLine(line);
                    }}
                  />
                  {generatedFiles.length > 0 && (
                    <div className="generated-files-panel" style={{ height: ui.genPanelHeight }}>
                      <div
                        className="generated-files-resize-handle"
                        onMouseDown={(/** @type {any} */ e) => {
                          e.preventDefault();
                          let startY = e.clientY;
                          const onMove = (/** @type {any} */ ev) => {
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
                        {generatedFiles.map((/** @type {any} */ gf) => (
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
                            onContextMenu={(/** @type {any} */ e) => {
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
                      onDownload={async (/** @type {any} */ name) => {
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
                <ResizeHandle onResize={(/** @type {any} */ d) => ui.setFileTreeWidth((w) => Math.max(120, Math.min(400, w + d)))} />
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
                  onWheel={(/** @type {any} */ e) => editorRef.current?.scrollBy(e.deltaX, e.deltaY)}
                  onClose={() => ui.setShowComments(false)}
                  style={{ width: ui.commentsWidth }}
                />
                <ResizeHandle onResize={(/** @type {any} */ d) => ui.setCommentsWidth((w) => Math.max(180, Math.min(450, w + d)))} />
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
                {/* Per-comment markers rendered first so they paint
                    BENEATH the opaque rail-header below. The filter
                    drops markers whose y is in the header zone before
                    rendering; the header's opaque background then acts
                    as a visual hard-stop for anything that slips past
                    (e.g. markers landing right at the boundary). */}
                {commentPositions?.filter((/** @type {any} */ p) => shouldShowRailMarker(p.top)).map((/** @type {any} */ p) => (
                  <svg
                    key={p.id}
                    className="comments-rail-marker"
                    style={{ top: p.top }}
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    {/* Same speech-bubble glyph as the rail's top icon
                        so the dot reads unambiguously as "a comment
                        sits here" rather than a generic marker. */}
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                ))}
                {/* Header (icon + count badge). Wrapped in an opaque
                    sticky div so it always occludes any marker that
                    visually lands in the header zone — independent of
                    whether the rail and editor top edges align. */}
                <div className="comments-rail-header">
                  {/* Icon + corner-badge wrapper. The wrapper is the
                      relative anchor so the badge overlaps the icon's
                      top-right corner consistently with the
                      track-changes toggle badge (same pattern as
                      iOS / macOS / GitHub corner counters). */}
                  <span className="comments-rail-icon-wrap">
                    {/* Speech bubble with inner text lines — reads as
                        "annotation" (comments tied to specific text in
                        the document), to distinguish from the chat icon
                        which is a multi-bubble conversation glyph. */}
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
                    {commentPositions?.length > 0 && (
                      <span className="comments-badge">
                        {commentPositions.length > 99 ? '99+' : commentPositions.length}
                      </span>
                    )}
                  </span>
                </div>
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
                    onAccept={(/** @type {any} */ id) => acceptAndNext(id)}
                    onReject={(/** @type {any} */ id) => rejectAndNext(id)}
                    onAcceptAll={handleAcceptAllChanges}
                    onRejectAll={handleRejectAllChanges}
                    onGoToPosition={(/** @type {any} */ pos) => editorRef.current?.goToPosition(pos)}
                    onClose={() => ui.setShowChangesPanel(false)}
                  />
                </div>
                <ResizeHandle
                  onResize={(/** @type {any} */ d) => ui.setChangesPanelWidth((w) => Math.max(180, Math.min(450, w + d)))}
                />
              </>
            ) : (
              <button
                className="tc-toggle-btn"
                onClick={() => ui.setShowChangesPanel(true)}
                title={`Show tracked changes panel${pendingChanges.length > 0 ? ` (${pendingChanges.length})` : ''}`}
              >
                {/* Matches the PDF viewer's "Show tracked changes in PDF"
                    button: document with red-strike + blue-underline rows,
                    plus a small magnifying-glass loupe pinned bottom-right
                    to read as VIEW changes (not edit them). */}
                <span className="pdf-tc-btn-icon">
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
                  <svg
                    className="pdf-tc-btn-loupe"
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="10" cy="10" r="7" />
                    <line x1="21" y1="21" x2="15.5" y2="15.5" />
                  </svg>
                </span>
                {pendingChanges.length > 0 && (
                  <span className="tc-toggle-badge">{pendingChanges.length}</span>
                )}
              </button>
            )}
            <div
              className="editor-area"
              style={ui.layoutMode === 'pdf' ? { display: 'none' } : undefined}
            >
              {project && !wsConnected && (
                <div className="ws-disconnected-banner" role="status">
                  <span className="ws-disconnected-dot" aria-hidden="true" />
                  Connection lost — reconnecting. Edits stay local until it&apos;s back.
                </div>
              )}
              {activeFile?.is_binary ? (
                <Suspense fallback={null}>
                  <BinaryPreview file={activeFile} />
                </Suspense>
              ) : (
                <>
                  {/* Read-only banner: a non-blocking strip above the
                      editor that explains WHY typing does nothing.
                      Otherwise a commenter who clicks into the file
                      and starts typing sees nothing happen and has no
                      idea why. The role string drives the message so
                      commenters know they can still post comments. */}
                  {(() => {
                    const role = getProjectRole(members, user?.id);
                    if (role !== 'commenter' && role !== 'viewer') return null;
                    return (
                      <div className={`editor-readonly-banner editor-readonly-banner-${role}`}>
                        {role === 'commenter' ? (
                          <span>
                            You&rsquo;re a <strong>commenter</strong> on this project &mdash;
                            you can read the file and post comments, but cannot edit the content.
                            Ask the project owner if you need editor access.
                          </span>
                        ) : (
                          <span>
                            You&rsquo;re a <strong>viewer</strong> on this project &mdash;
                            you can read the file but cannot edit it or post comments.
                          </span>
                        )}
                      </div>
                    );
                  })()}
                  <Editor
                    ref={editorRef}
                    file={activeFile}
                    comments={comments}
                    currentUserName={user?.name}
                    currentUserId={user?.id}
                    projectId={project?.id}
                    // Read-only for viewers and commenters. Cursor stays
                    // live (see Editor.jsx -- EditorState.readOnly only,
                    // no EditorView.editable=false) so they can still
                    // place their caret, drag-select, and run the
                    // floating Comment button on a selection. Server is
                    // the actual gate; this is the "don't let me type
                    // into the void" affordance.
                    readOnly={isReadOnlyForUser(members, user?.id)}
                    extraExtensions={editorExtraExtensions}
                    yjsEnabled={yjs.enabled}
                    yjsIsApplyingRemote={yjs.isApplyingRemote}
                    yjsGetText={yjs.getText}
                    yjsSyncLocalText={yjs.syncLocalText}
                    onSave={handleSaveYjsAware}
                    onLineChange={setEditorLine}
                    onChanges={(/** @type {any} */ changes, /** @type {any} */ tracked, /** @type {any} */ deletions, /** @type {any} */ tcMarks) => {
                      // Mark this file as "edited since last compile" so
                      // the error panel can fade rows whose locations
                      // are now potentially stale.
                      if (activeFile?.path) {
                        setStaleFilePaths((prev) => {
                          if (prev.has(activeFile.path)) return prev;
                          const next = new Set(prev);
                          next.add(activeFile.path);
                          return next;
                        });
                      }

                      // YJS-MIGRATION phase 1.5: when Y.js sync is on,
                      // doc text already flows over the `yjs-update`
                      // channel — broadcasting `changes` too would
                      // double-apply. Still send tracked-changes mark
                      // mutations though: those are out of the Y.Doc's
                      // scope until phase 5 re-anchors them, so the
                      // legacy broadcast keeps them in sync.
                      if (yjs.enabled && (!tcMarks || tcMarks.added.length + tcMarks.removed.length === 0)) {
                        return;
                      }
                      sendWsMessage({
                        type: 'changes',
                        fileId: activeFile?.id,
                        // Drop doc-content changes when yjs is on; only
                        // the tcMarks payload is relevant here.
                        changes: yjs.enabled ? [] : changes,
                        ...(tracked ? { tracked: true } : {}),
                        ...(deletions ? { deletions } : {}),
                        ...(tcMarks ? { tcMarks } : {}),
                      });
                    }}
                    onCursorChange={(/** @type {any} */ head, /** @type {any} */ anchor) =>
                      sendWsMessage({ type: 'cursor', fileId: activeFile?.id, head, anchor })
                    }
                    onDocChange={refreshFromDoc}
                    onCompile={handleCompile}
                    onAddPackage={(/** @type {string} */ pkg) => {
                      // Same primitive as the LaTeX-error "Fix" pill:
                      // add \usepackage{pkg} to the project's main file,
                      // mark the inserted line as a pending fix-ack.
                      // Used by the table builder's ⚠ button when a
                      // required package (booktabs, longtable, etc.)
                      // is missing from the preamble.
                      //
                      // Defensive: gate on a strict CTAN-name shape so
                      // a future caller that forwards untrusted input
                      // can't inject a `}` (or worse) into the
                      // \usepackage{...} brace and write arbitrary
                      // LaTeX into the user's source.
                      if (!pkg || !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(pkg)) return;
                      const mainFile = files.find((/** @type {any} */ f) => f.path === mainFilePath);
                      if (!mainFile) {
                        showAlert(
                          `Couldn't find the main file (${mainFilePath}) to add \\usepackage{${pkg}} to.`,
                          { title: 'Apply fix failed' },
                        );
                        return;
                      }
                      const currentContent =
                        activeFile?.id === mainFile.id
                          ? (editorRef.current?.getContent() ?? mainFile.content ?? '')
                          : (mainFile.content ?? '');
                      const apply = (/** @type {string} */ content) => {
                        const result = applyAddUsepackage(content, pkg);
                        if (!result.changed) {
                          showAlert(
                            `\\usepackage{${pkg}} is already in ${mainFilePath}.`,
                            { title: 'Already added' },
                          );
                          return;
                        }
                        const snippet = result.newContent.slice(
                          result.insertAt,
                          result.insertAt + result.insertLength,
                        );
                        editorRef.current?.replaceRange(result.insertAt, result.insertAt, snippet);
                        if (snippet.length > 0) {
                          setTimeout(
                            () => editorRef.current?.markFixApplied(result.insertAt, result.insertAt + snippet.length),
                            0,
                          );
                        }
                        setTimeout(
                          () => editorRef.current?.goToPosition(result.insertAt + result.insertLength),
                          50,
                        );
                      };
                      if (activeFile?.id === mainFile.id) {
                        apply(currentContent);
                      } else {
                        switchFile(mainFile);
                        setTimeout(() => apply(currentContent), 80);
                      }
                    }}
                    onRequestComment={(/** @type {any} */ sel) => {
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
                    onGoToFile={(/** @type {any} */ fileId, /** @type {any} */ line, /** @type {any} */ col) => {
                      const f = files.find((/** @type {any} */ f) => f.id === fileId);
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
                      setGithubLink((/** @type {any} */ prev) => (prev ? { ...prev, autoPush: newVal } : prev));
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
              {/* Generated-file viewer (compile .log/.aux/etc). Rendered
                  as an OVERLAY on top of the editor rather than replacing
                  it — unmounting the editor to show a read-only log was
                  destroying its in-memory document (esp. under Y.js,
                  where the remounted editor re-inits empty), so closing
                  the log left a blank editor. Overlaying keeps the
                  editor mounted underneath. */}
              {activeGenFile && (
                <div className="generated-file-viewer generated-file-overlay">
                  <div className="editor-header">
                    <span className="editor-header-filename">{stripJobSuffix(activeGenFile.name)}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>generated file (read-only)</span>
                    <button className="editor-header-btn" onClick={() => setActiveGenFile(null)} title="Close">
                      <CloseIcon />
                    </button>
                  </div>
                  <pre className="generated-file-content">{activeGenFile.content}</pre>
                </div>
              )}
            </div>
            {ui.layoutMode !== 'editor' && (
              <>
                <div className="sync-arrows-wrapper">
                  <SyncArrows
                    onSyncForward={handleSyncForward}
                    onSyncInverse={handleSyncInverseFromArrow}
                    hasPdf={!!pdfUrl}
                    hasPdfPosition={!!pdfClickPos}
                  />
                </div>
                <ResizeHandle
                  onResize={(/** @type {number} */ d) =>
                    ui.setPdfWidth((/** @type {number} */ w) => {
                      const el = /** @type {HTMLElement | null} */ (document.querySelector('.pdf-viewer'));
                      const current = w || el?.offsetWidth || 500;
                      return Math.max(250, current - d);
                    })
                  }
                />
              </>
            )}
            {ui.layoutMode !== 'editor' && (
            <PdfViewer
              ref={pdfRef}
              url={pdfUrl}
              projectName={project?.name}
              compiling={compiling}
              compileChoice={compileChoice}
              localCompileFeatureOn={!!user?.serverFeatures?.localCompile}
              projectCompileLocation={project?.compile_location ?? null}
              onSetProjectCompileLocation={async (/** @type {any} */ loc) => {
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
                    showAlert(data.error || 'Could not change compile location', { title: 'Compile location' });
                    return;
                  }
                  // Updated project echoes the new value; mirror it into
                  // local state so the dropdowns checkmark + the compile
                  // button label refresh without a reload.
                  const updated = await res.json();
                  setProject((/** @type {any} */ p) => (p ? { ...p, ...updated } : p));
                } catch (err) {
                  showAlert((err instanceof Error ? err.message : null) || 'Could not change compile location', { title: 'Compile location' });
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
              staleFilePaths={staleFilePaths}
              compileProfile={compileProfile}
              rebuildReason={rebuildReason}
              consoleOutput={consoleOutput}
              lintDiagnostics={showLintWarnings ? lintDiagnostics : []}
              style={
                ui.layoutMode === 'pdf'
                  ? { flex: 1 } // PDF-only mode: ignore the resize-handle width
                  : ui.pdfWidth
                    ? { flex: 'none', width: ui.pdfWidth }
                    : undefined
              }
              onGoToLine={(/** @type {any} */ line, /** @type {any} */ col) => editorRef.current?.goToLine(line, col)}
              onGoToFileAndLine={(/** @type {any} */ filePath, /** @type {any} */ line, /** @type {any} */ col) => {
                const f = files.find((/** @type {any} */ f) => f.path === filePath);
                if (f) {
                  switchFile(f);
                  setTimeout(() => editorRef.current?.goToLine(line, col), 50);
                } else editorRef.current?.goToLine(line, col);
              }}
              onExplainErrorWithAi={(/** @type {any} */ payload) => {
                // payload: { message, file, line } from LogItem.
                // Build the LLM prompt + a snippet of surrounding source
                // and stash it in UI state; the modal reads + streams.
                const targetFile = payload.file
                  ? files.find((/** @type {any} */ f) => f.path === payload.file)
                  : activeFile;
                let snippet = '';
                let snippetFirst = 0;
                if (targetFile?.content || (activeFile?.id === targetFile?.id && editorRef.current)) {
                  const fileContent =
                    activeFile?.id === targetFile?.id
                      ? (editorRef.current?.getContent() ?? targetFile?.content ?? '')
                      : (targetFile?.content ?? '');
                  if (typeof payload.line === 'number' && payload.line > 0) {
                    const ctx = extractContextLines(fileContent, payload.line);
                    snippet = ctx.snippet;
                    snippetFirst = ctx.firstLine;
                  }
                }
                const { instruction, input } = buildExplainPrompt({
                  errorText: String(payload.message ?? ''),
                  filePath: payload.file || targetFile?.path || null,
                  line: typeof payload.line === 'number' ? payload.line : null,
                  contextSnippet: snippet || undefined,
                  contextFirstLine: snippet ? snippetFirst : undefined,
                });
                ui.setExplainAi({
                  instruction,
                  input,
                  errorText: String(payload.message ?? ''),
                  filePath: payload.file || targetFile?.path || null,
                  line: typeof payload.line === 'number' ? payload.line : null,
                });
              }}
              onApplyQuickFix={(/** @type {any} */ fix) => {
                if (!fix?.kind) return;

                // ── Helpers shared across fix kinds ──────────────
                /** @param {any} targetFile @param {(content: string) => void} onReady */
                const withEditor = (targetFile, onReady) => {
                  const currentContent =
                    activeFile?.id === targetFile.id
                      ? (editorRef.current?.getContent() ?? targetFile.content ?? '')
                      : (targetFile.content ?? '');
                  if (activeFile?.id === targetFile.id) {
                    onReady(currentContent);
                  } else {
                    switchFile(targetFile);
                    setTimeout(() => onReady(currentContent), 80);
                  }
                };
                /** @param {number} from @param {number} to @param {string} text @param {number} anchor */
                const dispatchEdit = (from, to, text, anchor) => {
                  editorRef.current?.replaceRange(from, to, text);
                  // After the dispatch, mark the inserted span as a
                  // pending fix-ack so the user sees a glow + ✓ next
                  // to the new line. The next CodeMirror tick is when
                  // the range exists; defer via setTimeout(0).
                  if (text && text.length > 0) {
                    setTimeout(() => editorRef.current?.markFixApplied(from, from + text.length), 0);
                  }
                  setTimeout(() => editorRef.current?.goToPosition(anchor), 50);
                };

                // ── Dispatch by fix kind ─────────────────────────
                if (fix.kind === 'add-usepackage' && fix.package) {
                  const mainFile = files.find((/** @type {any} */ f) => f.path === mainFilePath);
                  if (!mainFile) {
                    showAlert(
                      `Couldn't find the main file (${mainFilePath}) to add \\usepackage{${fix.package}} to.`,
                      { title: 'Apply fix failed' },
                    );
                    return;
                  }
                  withEditor(mainFile, (currentContent) => {
                    const result = applyAddUsepackage(currentContent, fix.package);
                    if (!result.changed) {
                      // The package is already there but the compile
                      // log still flagged the error -- stale cache is
                      // the most likely culprit. Offer a one-click
                      // recompile to clear it.
                      showConfirm(
                        `\\usepackage{${fix.package}} is already in ${mainFilePath}. The error is likely from a stale compile cache.`,
                        {
                          title: 'No changes needed',
                          confirmLabel: 'Recompile now',
                          cancelLabel: 'Close',
                        },
                      ).then((wants) => {
                        if (wants) handleCompileRef.current?.();
                      });
                      return;
                    }
                    const snippet = result.newContent.slice(
                      result.insertAt,
                      result.insertAt + result.insertLength,
                    );
                    dispatchEdit(
                      result.insertAt,
                      result.insertAt,
                      snippet,
                      result.insertAt + result.insertLength,
                    );
                  });
                  return;
                }

                if (fix.kind === 'remove-usepackage' && fix.package) {
                  const mainFile = files.find((/** @type {any} */ f) => f.path === mainFilePath);
                  if (!mainFile) {
                    showAlert(
                      `Couldn't find the main file (${mainFilePath}).`,
                      { title: 'Apply fix failed' },
                    );
                    return;
                  }
                  withEditor(mainFile, (currentContent) => {
                    const result = applyRemoveUsepackage(currentContent, fix.package);
                    if (!result.changed) {
                      const msg =
                        result.reason === 'grouped-with-other-packages'
                          ? `\\usepackage{${fix.package}} is bundled in a multi-package brace (e.g. \\usepackage{foo,${fix.package},bar}). Edit the line by hand to remove just this one.`
                          : `Couldn't find \\usepackage{${fix.package}} in ${mainFilePath} — the package may already be removed.`;
                      showAlert(msg, { title: 'No changes made' });
                      return;
                    }
                    // The "edit" is a pure deletion: replace [from,to]
                    // with empty text. Anchor at the deletion point so
                    // the viewport doesn't jump.
                    dispatchEdit(result.removedFrom, result.removedTo, '', result.removedFrom);
                  });
                  return;
                }

                if (fix.kind === 'rename-env-end' && fix.beginName && fix.endName) {
                  // Mismatched-environment fixes always edit the file the
                  // user is currently looking at (the error location), so
                  // operate on activeFile, not mainFile.
                  if (!activeFile) {
                    showAlert(
                      'Open a file before applying this fix.',
                      { title: 'Apply fix failed' },
                    );
                    return;
                  }
                  const currentContent = editorRef.current?.getContent() ?? activeFile.content ?? '';
                  const result = applyRenameEndEnv(currentContent, fix.beginName, fix.endName);
                  if (!result.changed) {
                    const msg =
                      result.reason === 'no-end-found'
                        ? `Couldn't find \\end{${fix.endName}} in the active file — the source may have already been edited.`
                        : `No matching \\begin{...} was found before the \\end{${fix.endName}}.`;
                    showAlert(msg, { title: 'No changes made' });
                    return;
                  }
                  dispatchEdit(
                    result.replaceAt,
                    result.replaceAt + result.replaceLength,
                    result.insertedText,
                    result.replaceAt + result.insertedText.length,
                  );
                  return;
                }

                if (fix.kind === 'add-graphicspath' && fix.missingFile) {
                  // Look up the missing image's basename in the project to
                  // see if it's just sitting in a different directory.
                  const dir = findGraphicspathCandidate(fix.missingFile, files);
                  if (!dir) {
                    showAlert(
                      `Couldn't find a matching image for "${fix.missingFile}" elsewhere in the project. Add the file, or update the \\includegraphics path by hand.`,
                      { title: 'No matching file' },
                    );
                    return;
                  }
                  const mainFile = files.find((/** @type {any} */ f) => f.path === mainFilePath);
                  if (!mainFile) {
                    showAlert(
                      `Couldn't find the main file (${mainFilePath}).`,
                      { title: 'Apply fix failed' },
                    );
                    return;
                  }
                  withEditor(mainFile, (currentContent) => {
                    const result = applyAddGraphicspath(currentContent, dir);
                    if (!result.changed) {
                      showAlert(
                        `\\graphicspath is already defined in ${mainFilePath}. Edit the existing definition to include "${dir}" by hand.`,
                        { title: 'No changes made' },
                      );
                      return;
                    }
                    const snippet = result.newContent.slice(
                      result.insertAt,
                      result.insertAt + result.insertLength,
                    );
                    dispatchEdit(
                      result.insertAt,
                      result.insertAt,
                      snippet,
                      result.insertAt + result.insertLength,
                    );
                  });
                  return;
                }

                if (fix.kind === 'open-bib-with-skeleton' && fix.citationKey) {
                  // Find a .bib file in the project. Prefer one
                  // referenced from main.tex.
                  const mainFile = files.find((/** @type {any} */ f) => f.path === mainFilePath);
                  const mainContent =
                    activeFile?.id === mainFile?.id
                      ? (editorRef.current?.getContent() ?? mainFile?.content ?? '')
                      : (mainFile?.content ?? '');
                  const bibHit = findBibFile(files, mainContent);
                  if (!bibHit) {
                    showAlert(
                      `No .bib file found in this project. Create one (e.g. references.bib) and reference it with \\addbibresource{references.bib}.`,
                      { title: 'No .bib file' },
                    );
                    return;
                  }
                  const bibFile = files.find((/** @type {any} */ f) => f.path === bibHit.path);
                  if (!bibFile) {
                    showAlert(
                      `Couldn't locate the .bib file (${bibHit.path}).`,
                      { title: 'Apply fix failed' },
                    );
                    return;
                  }
                  withEditor(bibFile, (bibContent) => {
                    const result = appendCitationSkeleton(bibContent, fix.citationKey);
                    // The skeleton is always inserted (no "already
                    // present" case -- the citation key was reported
                    // undefined, so we're sure it's not already there).
                    const snippet = result.newContent.slice(
                      result.insertAt,
                      result.insertAt + result.insertLength,
                    );
                    // Replace the WHOLE file content: the helper may
                    // also have stripped trailing whitespace. To keep
                    // the undo step single, we dispatch a replaceRange
                    // spanning the entire doc.
                    const docLen = bibContent.length;
                    editorRef.current?.replaceRange(0, docLen, result.newContent);
                    setTimeout(
                      () => editorRef.current?.goToPosition(result.insertAt + result.insertLength),
                      50,
                    );
                    void snippet;
                  });
                  return;
                }

                if (fix.kind === 'open-zotero-for-key' && fix.citationKey) {
                  // Set the search hint, then open the modal. The
                  // modal reads ui.zoteroInitialSearch on mount.
                  ui.setZoteroInitialSearch(fix.citationKey);
                  ui.setShowZotero(true);
                  return;
                }

                if (fix.kind === 'swap-image-ext' && fix.badName) {
                  // Image-extension swaps edit the error site in the
                  // ACTIVE file (where \includegraphics lives). The
                  // LogItem provides the error's line as part of the
                  // click handler's fix-with-line shape -- the
                  // descriptor currently only carries badName; we read
                  // the line out of the fix payload when present.
                  if (!activeFile) {
                    showAlert(
                      'Open a file before applying this fix.',
                      { title: 'Apply fix failed' },
                    );
                    return;
                  }
                  const currentContent = editorRef.current?.getContent() ?? activeFile.content ?? '';
                  // The line is attached by the LogItem wiring below
                  // (we'll pass it through via fix.line). If absent,
                  // fall back to line 1 -- findIncludegraphicsAtLine
                  // tolerates fuzz so this still finds the first
                  // \includegraphics in the file.
                  const line = typeof fix.line === 'number' ? fix.line : 1;
                  const result = applySwapImageExtension(currentContent, line, fix.badName, files);
                  if (!result.changed) {
                    const msg =
                      result.reason === 'no-sibling'
                        ? `Couldn't find a pdflatex-friendly sibling for "${fix.badName}" in the project. Convert the image manually.`
                        : result.reason === 'name-mismatch'
                        ? `The \\includegraphics on the error line doesn't reference "${fix.badName}". Source may already be edited.`
                        : `Couldn't locate an \\includegraphics token near the error line.`;
                    showAlert(msg, { title: 'No changes made' });
                    return;
                  }
                  dispatchEdit(
                    result.replaceAt,
                    result.replaceAt + result.replaceLength,
                    result.insertedText,
                    result.replaceAt + result.insertedText.length,
                  );
                  return;
                }
              }}
              tapsDiagnostics={tapsEnabled ? tapsDiagnostics : []}
              showBoxWarnings={showBoxWarnings}
              onToggleBoxWarnings={() => {
                const newVal = !showBoxWarnings;
                setShowBoxWarnings(newVal);
                setSetting(`show-box-warnings-${project?.id}`, newVal);
              }}
              mainFileExists={!filesLoaded || files.some((/** @type {any} */ f) => f.path === mainFilePath)}
              mainFileChanged={mainFileChanged}
              onOpenSettings={(/** @type {any} */ tab) => {
                setProjectSettingsTab(tab || null);
                ui.setShowProjectSettings(true);
              }}
              showTrackedChangesInPdf={showTrackedChangesInPdf}
              onToggleTrackedChangesInPdf={() => setShowTrackedChangesInPdf((v) => !v)}
            />
            )}
            {showChat ? (
              <ChatPanel
                messages={chatMessages}
                currentUser={user}
                members={members}
                readCursors={chatReadCursors}
                onSend={(/** @type {any} */ text) => sendWsMessage({ type: 'chat', text })}
                onReact={(/** @type {any} */ messageId, /** @type {any} */ emoji) => sendWsMessage({ type: 'chat-react', messageId, emoji })}
                onRead={() => sendWsMessage({ type: 'chat-read' })}
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
    <AlertProvider>
      <AuthProvider>
        <AppInner />
      </AuthProvider>
    </AlertProvider>
  );
}
