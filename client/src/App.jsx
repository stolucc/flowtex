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

// Lazy-loaded modals (only fetched when opened)
const HistoryPanel = lazy(() => import('./components/HistoryPanel.jsx'));
const GitHubSyncModal = lazy(() => import('./components/GitHubSyncModal.jsx'));
const BibEnrichModal = lazy(() => import('./components/BibEnrichModal.jsx'));
const ZoteroModal = lazy(() => import('./components/ZoteroModal.jsx'));
const AdminDashboard = lazy(() => import('./components/AdminDashboard.jsx'));
import { get, post, put, patch, del } from './api.js';
import prettyBib from './utils/prettyBib.js';
import { LANGUAGES, getLanguage } from './utils/spellcheck.js';
import * as pdfjsLib from 'pdfjs-dist';

function GenFileContextMenu({ x, y, name, onClose, onDownload }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);
  return (
    <div ref={ref} className="file-tree-context-menu" style={{ position: 'fixed', top: y, left: x, zIndex: 1000 }}>
      <button className="file-tree-context-item" onClick={() => { onClose(); onDownload(name); }}>
        Download
      </button>
    </div>
  );
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.ico', '.webp']);
const PDF_EXTS = new Set(['.pdf']);

function getMimeType(path) {
  const ext = (path || '').split('.').pop().toLowerCase();
  const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', webp: 'image/webp', pdf: 'application/pdf' };
  return map[ext] || 'application/octet-stream';
}

function getFileExt(path) {
  const dot = (path || '').lastIndexOf('.');
  return dot >= 0 ? path.slice(dot).toLowerCase() : '';
}

function BinaryPreview({ file }) {
  const ext = getFileExt(file.path);
  const rawUrl = `/api/projects/files/${file.id}/raw`;
  const isPdf = PDF_EXTS.has(ext);
  const isImage = IMAGE_EXTS.has(ext);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!isPdf) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(rawUrl, { credentials: 'include' });
        if (!resp.ok || cancelled) return;
        const buf = await resp.arrayBuffer();
        if (cancelled) return;
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = '';
        const containerWidth = containerRef.current.clientWidth - 32;
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const unscaledViewport = page.getViewport({ scale: 1 });
          const fitScale = containerWidth > 0 ? containerWidth / unscaledViewport.width : 1;
          const scale = Math.max(0.5, Math.min(fitScale, 2));
          const viewport = page.getViewport({ scale });
          const wrapper = document.createElement('div');
          wrapper.className = 'pdf-page-wrapper';
          wrapper.style.width = viewport.width + 'px';
          wrapper.style.marginBottom = '12px';
          const canvas = document.createElement('canvas');
          const dpr = window.devicePixelRatio || 1;
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.display = 'block';
          canvas.style.width = '100%';
          const ctx = canvas.getContext('2d');
          ctx.scale(dpr, dpr);
          wrapper.appendChild(canvas);
          containerRef.current.appendChild(wrapper);
          await page.render({ canvasContext: ctx, viewport }).promise;
        }
      } catch (e) {
        if (!cancelled && containerRef.current) {
          containerRef.current.textContent = 'Failed to load PDF';
        }
      }
    })();
    return () => { cancelled = true; };
  }, [file.id, isPdf, rawUrl]);

  if (isImage) {
    return (
      <div className="binary-preview">
        <div className="binary-preview-label">{file.path}</div>
        <img src={rawUrl} alt={file.path} className="binary-preview-image" />
      </div>
    );
  }
  if (isPdf) {
    return (
      <div className="binary-preview binary-preview-pdf-container">
        <div className="binary-preview-label">{file.path}</div>
        <div className="binary-preview-pdf-pages" ref={containerRef}>
          <p className="binary-preview-unsupported">Loading PDF...</p>
        </div>
      </div>
    );
  }
  return (
    <div className="binary-preview">
      <div className="binary-preview-label">{file.path}</div>
      <p className="binary-preview-unsupported">Binary file — no preview available</p>
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
  if (dateDay.getTime() === today.getTime()) dayPart = 'today';
  else if (dateDay.getTime() === yesterday.getTime()) dayPart = 'yesterday';
  else {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    dayPart = `${d.getDate()} ${months[d.getMonth()]}`;
  }
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';
  return `${dayPart} at ${h}:${m} ${ampm}`;
}

function getProjectIdFromUrl() {
  const match = window.location.pathname.match(/^\/project\/([^/]+)/);
  return match ? match[1] : null;
}

function getFileIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('file');
}

// Strip per-user job suffixes like _a5d6ac55 and __diff__ prefixes from generated file display names
function stripJobSuffix(filename) {
  return filename.replace(/_[0-9a-f]{8}(?=\.)/, '').replace(/^__diff__/, 'diff');
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [project, setProject] = useState(null);
  const [showAdmin, setShowAdmin] = useState(window.location.pathname === '/admin');
  const [files, setFiles] = useState([]);
  const [activeFile, setActiveFile] = useState(null);
  const [comments, setComments] = useState([]);
  const [compileLog, setCompileLog] = useState('');
  const [consoleOutput, setConsoleOutput] = useState('');
  const [lintDiagnostics, setLintDiagnostics] = useState([]);
  const [compiling, setCompiling] = useState(false);
  const [pdfUrl, setPdfUrl] = useState(null);
  const [selection, setSelection] = useState(null);
  const [selectionFormTop, setSelectionFormTop] = useState(null);
  const [pdfClickPos, setPdfClickPos] = useState(null);
  const [showLog, setShowLog] = useState(false);
  const [editorLine, setEditorLine] = useState(1);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showGitHubSync, setShowGitHubSync] = useState(false);
  const [showBibEnrich, setShowBibEnrich] = useState(false);
  const [showZotero, setShowZotero] = useState(false);
  const [githubLink, setGithubLink] = useState(null);
  const [autoSyncStatus, setAutoSyncStatus] = useState(''); // '' | 'saving' | 'saved' | 'error'
  const autoSyncTimer = useRef(null);
  const [showCompareFiles, setShowCompareFiles] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [historyEditedFileIds, setHistoryEditedFileIds] = useState([]);
  const [historyFiles, setHistoryFiles] = useState(null);
  const [historySelectedFile, setHistorySelectedFile] = useState(null);
  const [members, setMembers] = useState([]);
  const [activeUsers, setActiveUsers] = useState([]);
  const [remoteCursors, setRemoteCursors] = useState({});
  const [commentPositions, setCommentPositions] = useState([]);
  const [generatedFiles, setGeneratedFiles] = useState([]);
  const [activeGenFile, setActiveGenFile] = useState(null); // { name, content }
  const [genPanelHeight, setGenPanelHeight] = useState(150);
  const [genContextMenu, setGenContextMenu] = useState(null); // { x, y, name }
  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [unreadChat, setUnreadChat] = useState(0);
  const showChatRef = useRef(false);
  showChatRef.current = showChat;
  const editorRef = useRef(null);
  const pdfRef = useRef(null);
  const needsAutoCompile = useRef(false);
  const wsRef = useRef(null);
  const compileSourceRef = useRef(null);
  const selectionRef = useRef(null);
  selectionRef.current = selection;

  const [newFileCounter, setNewFileCounter] = useState(0);
  const [newFolderCounter, setNewFolderCounter] = useState(0);
  const [fileTreeWidth, setFileTreeWidth] = useState(200);
  const [showFiles, setShowFiles] = useState(true);
  const [commentsWidth, setCommentsWidth] = useState(260);
  const [showComments, setShowComments] = useState(false);
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const [wordWrap, setWordWrap] = useState(true);
  const [pdfWidth, setPdfWidth] = useState(null); // null = flex to fill
  const [trackChangesMode, setTrackChangesMode] = useState(false);
  const [trackedChanges, setTrackedChanges] = useState([]);
  const [tcPopup, setTcPopup] = useState(null); // { changeId, x, y }

  // Extract citation keys from all .bib files in the project
  const citeKeys = useMemo(() => {
    const bibFiles = files.filter((f) => f.path.endsWith('.bib') && f.content);
    const keys = [];
    const entryPattern = /@\w+\s*\{\s*([\w:.@/+\-]+)/g;
    for (const f of bibFiles) {
      let match;
      entryPattern.lastIndex = 0;
      while ((match = entryPattern.exec(f.content)) !== null) {
        // Extract title/author from the entry for the detail field
        const entryStart = match.index;
        const entryKey = match[1];
        // Find the entry body (up to next @ or end)
        const rest = f.content.slice(entryStart);
        const titleMatch = rest.match(/title\s*=\s*[{"]\s*([^}"]+)/i);
        const authorMatch = rest.match(/author\s*=\s*[{"]\s*([^}"]+)/i);
        const entryType = rest.match(/@(\w+)/)?.[1]?.toLowerCase() || '';
        let detail = entryType;
        if (authorMatch) {
          // Show first author's last name
          const firstAuthor = authorMatch[1].split(/\s+and\s+/i)[0].trim();
          const lastName = firstAuthor.split(',')[0].split(/\s+/).pop();
          detail = lastName;
        }
        if (titleMatch) {
          const shortTitle = titleMatch[1].length > 40
            ? titleMatch[1].slice(0, 40) + '...'
            : titleMatch[1];
          detail += detail ? ' — ' + shortTitle : shortTitle;
        }
        keys.push({
          label: entryKey,
          type: 'text',
          detail,
          boost: 1,
        });
      }
    }
    return keys;
  }, [files]);

  // Check auth on mount
  useEffect(() => {
    get('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => { setUser(u); setAuthChecked(true); })
      .catch(() => setAuthChecked(true));

    const onExpired = () => { setUser(null); setAuthChecked(true); };
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, []);

  // Load project from URL on mount (after auth)
  useEffect(() => {
    if (!user) return;
    const id = getProjectIdFromUrl();
    if (id) {
      needsAutoCompile.current = true;
      get('/api/projects')
        .then((r) => r.json())
        .then((projects) => {
          const found = projects.find((p) => p.id === id);
          if (found) setProject(found);
          else window.history.replaceState(null, '', '/');
        });
    }
  }, [user]);

  // WebSocket connection for real-time collaboration
  useEffect(() => {
    if (!user || !project) {
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
      setActiveUsers([]);
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', projectId: project.id, userId: user.id, userName: user.name }));
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'presence') {
        setActiveUsers(msg.users);
      } else if (msg.type === 'changes') {
        editorRef.current?.applyRemoteChanges(msg.fileId, msg.changes);
      } else if (msg.type === 'cursor') {
        setRemoteCursors((prev) => ({ ...prev, [msg.userId]: { fileId: msg.fileId, head: msg.head, anchor: msg.anchor, userName: msg.userName } }));
      } else if (msg.type === 'comment') {
        if (msg.fileId === activeFileRef.current?.id) {
          setComments((cs) => [...cs, msg.comment]);
        }
      } else if (msg.type === 'comment-reply') {
        setComments((cs) => cs.map((c) =>
          c.id === msg.commentId ? { ...c, replies: [...(c.replies || []), msg.reply] } : c
        ));
      } else if (msg.type === 'comment-resolve') {
        setComments((cs) => cs.map((c) =>
          c.id === msg.commentId ? { ...c, resolved: msg.resolved ? 1 : 0 } : c
        ));
      } else if (msg.type === 'comment-delete') {
        setComments((cs) => cs.filter((c) => c.id !== msg.commentId));
      } else if (msg.type === 'comment-edit') {
        setComments((cs) => cs.map((c) => (c.id === msg.commentId ? { ...c, text: msg.text } : c)));
      } else if (msg.type === 'tracked-change') {
        if (msg.fileId === activeFileRef.current?.id) {
          setTrackedChanges((tc) => [...tc, msg.change]);
        }
      } else if (msg.type === 'tracked-change-resolve') {
        setTrackedChanges((tc) => tc.map((c) =>
          c.id === msg.changeId ? { ...c, status: msg.status } : c
        ));
      } else if (msg.type === 'history_update') {
        setHistoryVersion((v) => (v || 0) + 1);
      } else if (msg.type === 'chat') {
        setChatMessages((prev) => [...prev, msg]);
        if (!showChatRef.current) {
          setUnreadChat((n) => n + 1);
        }
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      setActiveUsers([]);
    };

    return () => { ws.close(); wsRef.current = null; };
  }, [user, project]);

  const sendWsMessage = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }, []);

  const switchFile = useCallback((f) => {
    setActiveFile(f);
    setActiveGenFile(null);
    if (f) {
      const url = new URL(window.location);
      url.searchParams.set('file', f.id);
      window.history.replaceState(null, '', url);
    }
  }, []);

  const selectProject = useCallback((p) => {
    setProject(p);
    needsAutoCompile.current = true;
    window.history.pushState(null, '', `/project/${p.id}`);
  }, []);

  const goBack = useCallback(() => {
    setProject(null);
    setActiveFile(null);
    setFiles([]);
    setPdfUrl(null);
    setComments([]);
    window.history.pushState(null, '', '/');
  }, []);

  // Handle browser back/forward
  useEffect(() => {
    const onPopState = () => {
      setShowAdmin(window.location.pathname === '/admin');
      const id = getProjectIdFromUrl();
      if (!id) {
        setProject(null);
        setActiveFile(null);
        setFiles([]);
        setPdfUrl(null);
        setComments([]);
      } else if (project?.id !== id) {
        get('/api/projects')
          .then((r) => r.json())
          .then((projects) => {
            const found = projects.find((p) => p.id === id);
            if (found) setProject(found);
          });
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [project]);

  // Load project files
  useEffect(() => {
    if (!project) return;
    get(`/api/projects/${project.id}/files`)
      .then((r) => r.json())
      .then((loadedFiles) => {
        setFiles(loadedFiles);
        if (loadedFiles.length > 0 && !activeFile) {
          const fileId = getFileIdFromUrl();
          const target = fileId && loadedFiles.find((f) => f.id === fileId);
          if (target) {
            setActiveFile(target);
          } else {
            const mainName = project.main_file || 'main.tex';
            const mainFile = loadedFiles.find((f) => f.path === mainName);
            setActiveFile(mainFile || loadedFiles[0]);
          }
        }
        if (needsAutoCompile.current) {
          needsAutoCompile.current = false;
          setTimeout(() => {
            post(`/api/compile/${project.id}`)
              .then((r) => r.json())
              .then((data) => {
                setCompileLog(data.log || '');
                if (data.success) {
                  setPdfUrl(`/api/compile/${project.id}/pdf?t=${Date.now()}`);
                }
              });
          }, 100);
        }
      });
    // Also fetch generated files
    get(`/api/compile/${project.id}/generated-files`).then((r) => r.json()).then((d) => setGeneratedFiles(d.files || [])).catch(() => {});
    get(`/api/chat/${project.id}`).then((r) => r.json()).then((msgs) => setChatMessages(msgs || [])).catch(() => {});
  }, [project]);

  // Fetch GitHub link status for auto-push
  useEffect(() => {
    if (!project) { setGithubLink(null); return; }
    get(`/api/github/link/${project.id}`).then(r => r.json()).then(setGithubLink).catch(() => {});
  }, [project]);

  // Auto-push to GitHub on interval
  useEffect(() => {
    if (autoSyncTimer.current) { clearInterval(autoSyncTimer.current); autoSyncTimer.current = null; }
    if (!project || !githubLink?.linked || !githubLink?.autoPush) return;

    const intervalMs = (githubLink.autoPushInterval || 300) * 1000;
    autoSyncTimer.current = setInterval(async () => {
      setAutoSyncStatus('saving');
      try {
        const res = await post(`/api/github/push/${project.id}`, { message: 'Auto-save from FlowTex' });
        const d = await res.json();
        if (res.ok) {
          setAutoSyncStatus('saved');
          setGithubLink(prev => prev ? { ...prev, lastSyncAt: new Date().toISOString(), lastSyncCommit: d.commit } : prev);
        } else {
          setAutoSyncStatus('error');
        }
      } catch {
        setAutoSyncStatus('error');
      }
      setTimeout(() => setAutoSyncStatus(''), 5000);
    }, intervalMs);

    return () => { clearInterval(autoSyncTimer.current); autoSyncTimer.current = null; };
  }, [project, githubLink?.linked, githubLink?.autoPush, githubLink?.autoPushInterval]);

  // Update browser tab title with unread chat count
  useEffect(() => {
    const base = project ? `${project.name} — FlowTex` : 'FlowTex';
    document.title = unreadChat > 0 ? `(${unreadChat}) ${base}` : base;
  }, [unreadChat, project]);

  // Load comments for active file
  useEffect(() => {
    if (!activeFile) return;
    get(`/api/comments/${activeFile.id}`)
      .then((r) => r.json())
      .then(setComments);
  }, [activeFile]);

  // Load tracked changes for active file
  useEffect(() => {
    if (!activeFile) { setTrackedChanges([]); return; }
    get(`/api/tracked-changes/${activeFile.id}`)
      .then((r) => r.json())
      .then(setTrackedChanges)
      .catch(() => setTrackedChanges([]));
  }, [activeFile]);

  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;

  const handleSave = useCallback(
    async (content) => {
      const file = activeFileRef.current;
      if (!file) return;
      await put(`/api/projects/files/${file.id}`, { content });
      setActiveFile((f) => (f?.id === file.id ? { ...f, content } : f));
      setFiles((fs) => fs.map((f) => (f.id === file.id ? { ...f, content } : f)));
    },
    []
  );

  const handleCompile = useCallback(async () => {
    if (!project) return;
    // Save current editor content before compiling
    if (activeFile) {
      const currentContent = editorRef.current?.getContent();
      if (currentContent != null) {
        await handleSave(currentContent);
      }
    }
    setCompiling(true);
    setShowLog(false);
    setConsoleOutput('');

    // Close any previous EventSource
    if (compileSourceRef.current) {
      compileSourceRef.current.close();
      compileSourceRef.current = null;
    }

    try {
      const evtSource = new EventSource(`/api/compile/${project.id}/compile-stream`);
      compileSourceRef.current = evtSource;

      await new Promise((resolve, reject) => {
        evtSource.addEventListener('output', (e) => {
          if (compileSourceRef.current !== evtSource) return;
          const { text } = JSON.parse(e.data);
          setConsoleOutput((prev) => prev + text);
        });

        evtSource.addEventListener('done', (e) => {
          if (compileSourceRef.current !== evtSource) return;
          const data = JSON.parse(e.data);
          setCompileLog(data.log || '');
          if (data.success) {
            setPdfUrl(`/api/compile/${project.id}/pdf?t=${Date.now()}`);
          } else {
            setShowLog(true);
          }
          evtSource.close();
          compileSourceRef.current = null;
          resolve();
        });

        evtSource.onerror = () => {
          evtSource.close();
          compileSourceRef.current = null;
          reject(new Error('Compile stream failed'));
        };
      });
    } catch (err) {
      setCompileLog(err.message);
      setShowLog(true);
    }
    setCompiling(false);
    // Refresh generated files list
    if (project) {
      get(`/api/compile/${project.id}/generated-files`).then((r) => r.json()).then((d) => setGeneratedFiles(d.files || [])).catch(() => {});
    }
  }, [project, activeFile, handleSave]);

  const handleDiff = useCallback((oldFileId, newFileId) => {
    if (!project) return;
    setCompiling(true);
    setConsoleOutput('');

    if (compileSourceRef.current) {
      compileSourceRef.current.close();
      compileSourceRef.current = null;
    }

    const evtSource = new EventSource(
      `/api/compile/${project.id}/diff-stream?oldFileId=${encodeURIComponent(oldFileId)}&newFileId=${encodeURIComponent(newFileId)}`
    );
    compileSourceRef.current = evtSource;

    evtSource.addEventListener('output', (e) => {
      if (compileSourceRef.current !== evtSource) return;
      const { text } = JSON.parse(e.data);
      setConsoleOutput((prev) => prev + text);
    });

    evtSource.addEventListener('done', (e) => {
      if (compileSourceRef.current !== evtSource) return;
      const data = JSON.parse(e.data);
      setCompileLog(data.log || '');
      if (data.success) {
        setPdfUrl(`/api/compile/${project.id}/diff-pdf?t=${Date.now()}`);
      } else {
        setShowLog(true);
      }
      evtSource.close();
      compileSourceRef.current = null;
      setCompiling(false);
    });

    evtSource.onerror = () => {
      evtSource.close();
      compileSourceRef.current = null;
      setCompiling(false);
    };
  }, [project]);

  const handleAddComment = useCallback(
    async (text) => {
      if (!activeFile || !selection) return;
      const res = await post(`/api/comments/${activeFile.id}`, {
        from_pos: selection.from,
        to_pos: selection.to,
        text,
      });
      const comment = await res.json();
      setComments((c) => [...c, comment]);
      setSelection(null);
      sendWsMessage({ type: 'comment', fileId: activeFile.id, comment });
    },
    [activeFile, selection, sendWsMessage]
  );

  const handleResolveComment = useCallback(async (commentId, resolved) => {
    await patch(`/api/comments/${commentId}/resolve`, { resolved });
    setComments((cs) => cs.map((c) => (c.id === commentId ? { ...c, resolved: resolved ? 1 : 0 } : c)));
    sendWsMessage({ type: 'comment-resolve', commentId, resolved });
  }, [sendWsMessage]);

  const handleDeleteComment = useCallback(async (commentId) => {
    await del(`/api/comments/${commentId}`);
    setComments((cs) => cs.filter((c) => c.id !== commentId));
    sendWsMessage({ type: 'comment-delete', commentId });
  }, [sendWsMessage]);

  const handleReplyComment = useCallback(async (commentId, text) => {
    const res = await post(`/api/comments/${commentId}/reply`, { text });
    const reply = await res.json();
    setComments((cs) => cs.map((c) =>
      c.id === commentId ? { ...c, replies: [...(c.replies || []), reply] } : c
    ));
    sendWsMessage({ type: 'comment-reply', commentId, reply });
  }, [sendWsMessage]);

  const handleEditComment = useCallback(async (commentId, text) => {
    await patch(`/api/comments/${commentId}`, { text });
    setComments((cs) => cs.map((c) => (c.id === commentId ? { ...c, text } : c)));
    sendWsMessage({ type: 'comment-edit', commentId, text });
  }, [sendWsMessage]);

  // Track changes handlers
  const trackedChangesRef = useRef(trackedChanges);
  trackedChangesRef.current = trackedChanges;

  const handleTrackChange = useCallback(async (change) => {
    if (!activeFile) return;
    try {
      // Check if this change is purely a deletion that overlaps an existing pending
      // insertion by the same user — if so, update/remove the existing one
      const myPending = trackedChangesRef.current.filter(
        (tc) => tc.status === 'pending' && tc.author_id === user?.id && tc.inserted_text
      );

      // If deleting only (no insertion), look for an overlapping insertion to shrink
      if (change.deleted_text && !change.inserted_text) {
        for (const existing of myPending) {
          // Check if the deletion falls within this insertion's range
          if (change.from_pos >= existing.from_pos && change.from_pos <= existing.to_pos) {
            const offset = change.from_pos - existing.from_pos;
            const delLen = change.deleted_text.length;
            const newInserted = existing.inserted_text.slice(0, offset) + existing.inserted_text.slice(offset + delLen);
            if (!newInserted && !existing.deleted_text) {
              // Entire insertion was deleted — remove the tracked change
              await del(`/api/tracked-changes/${existing.id}`);
              setTrackedChanges((tc) => tc.filter((c) => c.id !== existing.id));
              return;
            }
            // Shrink the insertion
            const res = await patch(`/api/tracked-changes/${existing.id}`, {
              from_pos: existing.from_pos,
              to_pos: existing.from_pos + newInserted.length,
              inserted_text: newInserted,
            });
            const updated = await res.json();
            setTrackedChanges((tc) => tc.map((c) => c.id === existing.id ? updated : c));
            sendWsMessage({ type: 'tracked-change', fileId: activeFile.id, change: updated });
            return;
          }
        }
      }

      // Check if this insertion extends an existing adjacent insertion by same user
      if (change.inserted_text && !change.deleted_text) {
        for (const existing of myPending) {
          if (change.from_pos >= existing.from_pos && change.from_pos <= existing.to_pos) {
            const offset = change.from_pos - existing.from_pos;
            const newInserted = existing.inserted_text.slice(0, offset) + change.inserted_text + existing.inserted_text.slice(offset);
            const res = await patch(`/api/tracked-changes/${existing.id}`, {
              from_pos: existing.from_pos,
              to_pos: existing.from_pos + newInserted.length,
              inserted_text: newInserted,
            });
            const updated = await res.json();
            setTrackedChanges((tc) => tc.map((c) => c.id === existing.id ? updated : c));
            sendWsMessage({ type: 'tracked-change', fileId: activeFile.id, change: updated });
            return;
          }
        }
      }

      // No existing change to merge with — create new
      const res = await post(`/api/tracked-changes/${activeFile.id}`, change);
      const saved = await res.json();
      setTrackedChanges((tc) => [...tc, saved]);
      sendWsMessage({ type: 'tracked-change', fileId: activeFile.id, change: saved });
    } catch (err) {
      // ignore
    }
  }, [activeFile, user, sendWsMessage]);

  const handleDeleteInsertionChar = useCallback(async (pos) => {
    // Find the tracked insertion that contains this position and shrink it
    const tc = trackedChangesRef.current.find(
      (c) => c.status === 'pending' && c.inserted_text && pos >= c.from_pos && pos < c.to_pos
    );
    if (!tc) return;
    const offset = pos - tc.from_pos;
    const newInserted = tc.inserted_text.slice(0, offset) + tc.inserted_text.slice(offset + 1);
    if (!newInserted) {
      // Insertion is now empty — delete the tracked change
      try {
        await del(`/api/tracked-changes/${tc.id}`);
        setTrackedChanges((tcs) => tcs.filter((c) => c.id !== tc.id));
      } catch (e) {}
      return;
    }
    try {
      const res = await patch(`/api/tracked-changes/${tc.id}`, {
        from_pos: tc.from_pos,
        to_pos: tc.from_pos + newInserted.length,
        inserted_text: newInserted,
      });
      const updated = await res.json();
      setTrackedChanges((tcs) => tcs.map((c) => c.id === tc.id ? updated : c));
    } catch (e) {}
  }, []);

  // Shift positions of remaining pending changes after a document edit removes text
  const adjustOtherChanges = useCallback((fileId, changeId, removeFrom, removeTo) => {
    const delta = removeFrom - removeTo; // negative = positions shift left
    if (delta === 0) return;
    // Update local state
    setTrackedChanges((tc) => tc.map((c) => {
      if (c.id === changeId || c.status !== 'pending') return c;
      if (c.from_pos >= removeTo) {
        return { ...c, from_pos: c.from_pos + delta, to_pos: c.to_pos + delta };
      }
      return c;
    }));
    // Update server
    post(`/api/tracked-changes/file/${fileId}/adjust-positions`, { afterPos: removeTo, delta });
  }, []);

  const handleAcceptChange = useCallback(async (changeId) => {
    const change = trackedChangesRef.current.find((c) => c.id === changeId);
    if (!change) return;
    await post(`/api/tracked-changes/${changeId}/accept`);
    if (change.deleted_text) {
      // Accept deletion: remove deleted text from document at [from_pos, to_pos)
      editorRef.current?.replaceRange?.(change.from_pos, change.to_pos, '');
      adjustOtherChanges(change.file_id, changeId, change.from_pos, change.to_pos);
    }
    // Accept insertion: text stays, just remove the highlight. No position shift.
    setTrackedChanges((tc) => tc.map((c) => c.id === changeId ? { ...c, status: 'accepted' } : c));
    setTcPopup(null);
    sendWsMessage({ type: 'tracked-change-resolve', changeId, status: 'accepted' });
  }, [sendWsMessage, adjustOtherChanges]);

  const handleRejectChange = useCallback(async (changeId) => {
    const change = trackedChangesRef.current.find((c) => c.id === changeId);
    if (!change) return;
    await post(`/api/tracked-changes/${changeId}/reject`);
    if (change.inserted_text) {
      // Reject insertion: remove inserted text from document at [from_pos, to_pos)
      editorRef.current?.replaceRange?.(change.from_pos, change.to_pos, '');
      adjustOtherChanges(change.file_id, changeId, change.from_pos, change.to_pos);
    }
    // Reject deletion: text stays in document, just remove the strikethrough. No position shift.
    setTrackedChanges((tc) => tc.map((c) => c.id === changeId ? { ...c, status: 'rejected' } : c));
    setTcPopup(null);
    sendWsMessage({ type: 'tracked-change-resolve', changeId, status: 'rejected' });
  }, [sendWsMessage, adjustOtherChanges]);

  const handleAcceptAllChanges = useCallback(async () => {
    if (!activeFile) return;
    await post(`/api/tracked-changes/file/${activeFile.id}/accept-all`);
    // Accept: keep insertions, remove deletions. Process from end to start to preserve positions.
    const pending = trackedChangesRef.current
      .filter((c) => c.status === 'pending' && c.deleted_text)
      .sort((a, b) => b.from_pos - a.from_pos);
    for (const c of pending) {
      editorRef.current?.replaceRange?.(c.from_pos, c.to_pos, '');
    }
    setTrackedChanges((tc) => tc.map((c) => c.status === 'pending' ? { ...c, status: 'accepted' } : c));
  }, [activeFile]);

  const handleRejectAllChanges = useCallback(async () => {
    if (!activeFile) return;
    await post(`/api/tracked-changes/file/${activeFile.id}/reject-all`);
    // Reject: remove insertions, keep deletions. Process from end to start to preserve positions.
    const pending = trackedChangesRef.current
      .filter((c) => c.status === 'pending' && c.inserted_text)
      .sort((a, b) => b.from_pos - a.from_pos);
    for (const c of pending) {
      editorRef.current?.replaceRange?.(c.from_pos, c.to_pos, '');
    }
    setTrackedChanges((tc) => tc.map((c) => c.status === 'pending' ? { ...c, status: 'rejected' } : c));
  }, [activeFile]);

  const updateCommentPositions = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      setCommentPositions([]);
      setSelectionFormTop(null);
      return;
    }
    const scrollInfo = editor.getScrollInfo();

    // Compute position for the new-comment form
    const sel = selectionRef.current;
    if (sel) {
      const selPos = Math.min(sel.from, sel.to);
      const selTop = editor.getTopForPos(selPos) - scrollInfo.scrollTop;
      setSelectionFormTop(selTop);
    } else {
      setSelectionFormTop(null);
    }

    if (!comments.length) {
      setCommentPositions([]);
      return;
    }
    const positions = comments
      .filter((c) => !c.resolved)
      .map((c) => {
        const pos = Math.min(c.from_pos, c.to_pos);
        const top = editor.getTopForPos(pos) - scrollInfo.scrollTop;
        return { id: c.id, top };
      });
    setCommentPositions(positions);
  }, [comments]);

  // Recompute when comments or selection change
  useEffect(() => {
    updateCommentPositions();
  }, [comments, selection, updateCommentPositions]);

  const handleCreateFile = useCallback(
    async (filePath, content) => {
      if (!project) return;
      const res = await post(`/api/projects/${project.id}/files`, { path: filePath, content });
      const file = await res.json();
      setFiles((fs) => [...fs, file]);
      switchFile(file);
    },
    [project, switchFile]
  );

  const handleOverwriteFile = useCallback(
    async (fileId, content) => {
      await put(`/api/projects/files/${fileId}`, { content });
      setFiles((fs) => fs.map((f) => f.id === fileId ? { ...f, content } : f));
      // Clear tracked changes for this file
      const fileTcs = trackedChanges.filter((c) => c.file_id === fileId && c.status === 'pending');
      for (const tc of fileTcs) {
        await del(`/api/tracked-changes/${tc.id}`);
      }
      setTrackedChanges((tcs) => tcs.filter((c) => c.file_id !== fileId));
      const file = files.find((f) => f.id === fileId);
      if (file) switchFile({ ...file, content });
    },
    [files, switchFile, trackedChanges]
  );

  // Forward sync: editor → PDF
  const handleSyncForward = useCallback(async () => {
    if (!project || !activeFile || !pdfUrl) return;
    try {
      const res = await get(
        `/api/compile/${project.id}/syncforward?line=${editorLine}&column=0&file=${encodeURIComponent(activeFile.path)}`
      );
      if (res.ok) {
        const data = await res.json();
        pdfRef.current?.scrollToPosition(data.page, data.v);
      }
    } catch (err) {
      // ignore
    }
  }, [project, activeFile, pdfUrl, editorLine]);

  // Inverse sync: PDF → editor
  const handleSyncInverse = useCallback(
    async (page, x, y) => {
      if (!project) return;
      try {
        const res = await get(
          `/api/compile/${project.id}/syncinverse?page=${page}&x=${x}&y=${y}`
        );
        if (res.ok) {
          const data = await res.json();
          // Switch to the correct file if different
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
      } catch (err) {
        // ignore
      }
    },
    [project, activeFile, files]
  );

  // Inverse sync from arrow button using last click position
  const handleSyncInverseFromArrow = useCallback(async () => {
    if (!pdfClickPos || !project) return;
    await handleSyncInverse(pdfClickPos.page, pdfClickPos.x, pdfClickPos.y);
  }, [pdfClickPos, project, handleSyncInverse]);

  const handleDeleteFile = useCallback(
    async (fileId) => {
      await del(`/api/projects/files/${fileId}`);
      setFiles((fs) => {
        const remaining = fs.filter((f) => f.id !== fileId);
        if (activeFile?.id === fileId) {
          switchFile(remaining[0] || null);
        }
        return remaining;
      });
    },
    [activeFile, switchFile]
  );

  const handleRenameFile = useCallback(
    async (fileId, newPath) => {
      const res = await patch(`/api/projects/files/${fileId}`, { path: newPath });
      const updated = await res.json();
      setFiles((fs) => fs.map((f) => f.id === fileId ? { ...f, path: newPath } : f));
    },
    []
  );

  const handleRenameFolder = useCallback(
    async (oldPrefix, newPrefix) => {
      // Rename all files that start with oldPrefix/
      const toRename = files.filter((f) => f.path === oldPrefix || f.path.startsWith(oldPrefix + '/'));
      for (const f of toRename) {
        const newPath = newPrefix + f.path.slice(oldPrefix.length);
        await patch(`/api/projects/files/${f.id}`, { path: newPath });
      }
      setFiles((fs) => fs.map((f) => {
        if (f.path === oldPrefix || f.path.startsWith(oldPrefix + '/')) {
          return { ...f, path: newPrefix + f.path.slice(oldPrefix.length) };
        }
        return f;
      }));
    },
    [files]
  );

  const handleDeleteFolder = useCallback(
    async (folderPath) => {
      const toDelete = files.filter((f) => f.path.startsWith(folderPath + '/'));
      for (const f of toDelete) {
        await del(`/api/projects/files/${f.id}`);
      }
      setFiles((fs) => {
        const remaining = fs.filter((f) => !f.path.startsWith(folderPath + '/'));
        if (activeFile && activeFile.path.startsWith(folderPath + '/')) {
          switchFile(remaining[0] || null);
        }
        return remaining;
      });
    },
    [files, activeFile, switchFile]
  );

  const handleSetMainFile = useCallback(
    async (filePath) => {
      if (!project) return;
      await patch(`/api/projects/${project.id}`, { main_file: filePath });
      setProject((p) => ({ ...p, main_file: filePath }));
    },
    [project]
  );

  const handleLogout = useCallback(async () => {
    await post('/api/auth/logout');
    setUser(null);
    setProject(null);
    setFiles([]);
    setActiveFile(null);
    setPdfUrl(null);
    window.history.replaceState(null, '', '/');
  }, []);

  // Load members when project changes
  useEffect(() => {
    if (!project) { setMembers([]); return; }
    get(`/api/projects/${project.id}/members`)
      .then((r) => r.json())
      .then(setMembers)
      .catch(() => {});
  }, [project]);

  // Push remote cursors to editor
  useEffect(() => {
    if (!activeFile) return;
    const cursors = Object.entries(remoteCursors)
      .filter(([uid, c]) => c.fileId === activeFile.id && uid !== user?.id)
      .map(([uid, c]) => ({ userId: uid, userName: c.userName, head: c.head, anchor: c.anchor }));
    editorRef.current?.setRemoteCursors(cursors);
  }, [remoteCursors, activeFile, user]);

  if (!authChecked) {
    return <div className="auth-loading">Loading...</div>;
  }

  if (!user) {
    return <AuthPage onAuth={setUser} />;
  }

  if (showAdmin && user.isAdmin) {
    return <Suspense fallback={<div className="loading-spinner" />}><AdminDashboard onBack={() => { setShowAdmin(false); window.history.pushState(null, '', '/'); }} /></Suspense>;
  }

  if (!project) {
    return <ProjectList onSelect={selectProject} user={user} onLogout={handleLogout} onUserUpdate={setUser} onAdmin={() => { setShowAdmin(true); window.history.pushState(null, '', '/admin'); }} />;
  }

  return (
    <div className="app">
      {showHistory ? (
        <div className="history-toolbar">
          <button className="history-back-btn" onClick={() => setShowHistory(false)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
        onShare={() => setShowShareModal(true)}
        onLogout={handleLogout}
        activeFile={activeFile}
        onPrettyPrint={() => {
          if (!activeFile?.path?.endsWith('.bib')) return;
          const content = editorRef.current?.getContent();
          if (content == null) return;
          const pretty = prettyBib(content);
          // Update editor content
          const view = editorRef.current;
          if (view?.replaceContent) {
            view.replaceContent(pretty);
          }
          handleSave(pretty);
        }}
        onSearch={() => editorRef.current?.openSearch()}
        onHistory={() => setShowHistory(true)}
        onNewFile={() => setNewFileCounter((c) => c + 1)}
        onNewFolder={() => setNewFolderCounter((c) => c + 1)}
        onInsert={(before, after) => editorRef.current?.insertSnippet(before, after)}
        onSymbolPicker={() => editorRef.current?.openSymbolPicker()}
        onToggleComments={() => setShowComments((v) => !v)}
        onToggleLineNumbers={() => setShowLineNumbers((v) => !v)}
        onToggleWordWrap={() => setWordWrap((v) => !v)}
        trackChangesMode={trackChangesMode}
        onToggleTrackChanges={() => setTrackChangesMode((v) => !v)}
        showComments={showComments}
        showLineNumbers={showLineNumbers}
        wordWrap={wordWrap}
        onHelp={(topic) => {
          if (topic === 'shortcuts') {
            alert('Keyboard Shortcuts:\n\nCtrl/Cmd+S — Save & Compile\nCtrl/Cmd+F — Find & Replace\nCtrl/Cmd+Click — Comment on selection');
          } else if (topic === 'about') {
            alert('FlowTex — A collaborative LaTeX editor');
          }
        }}
        onCompareFiles={() => setShowCompareFiles(true)}
        onGitHubSync={() => setShowGitHubSync(true)}
        onBibEnrich={activeFile?.path?.endsWith('.bib') ? () => setShowBibEnrich(true) : null}
        onZotero={() => setShowZotero(true)}
        githubLink={githubLink}
        autoSyncStatus={autoSyncStatus}
        lastSyncAt={githubLink?.lastSyncAt}
        onToggleAutoSync={async () => {
          if (!project || !githubLink?.linked) return;
          const newVal = !githubLink.autoPush;
          await patch(`/api/github/link/${project.id}/auto-push`, { enabled: newVal });
          setGithubLink(prev => prev ? { ...prev, autoPush: newVal } : prev);
        }}
        spellLanguages={LANGUAGES}
        spellLang={editorRef.current?.getSpellLang?.() || getLanguage()}
        onSpellLangChange={(code) => editorRef.current?.setSpellLang(code)}
        onUploadZip={async (file) => {
          if (!project) return;
          const formData = new FormData();
          formData.append('file', file);
          const csrfToken = document.cookie.match(/(?:^|;\s*)csrf-token=([^;]+)/)?.[1] || '';
          const res = await fetch(`/api/projects/${project.id}/upload-zip`, {
            method: 'POST',
            body: formData,
            credentials: 'include',
            headers: { 'X-CSRF-Token': csrfToken },
          });
          if (res.ok) {
            const data = await res.json();
            setFiles(data.files);
          }
        }}
        onUserClick={(u) => {
          const cursor = remoteCursors[u.id];
          if (cursor) {
            // Switch to the file the user is editing if different
            if (cursor.fileId !== activeFile?.id) {
              const f = files.find((f) => f.id === cursor.fileId);
              if (f) switchFile(f);
            }
            // Jump to their cursor position after a tick (in case file switched)
            setTimeout(() => editorRef.current?.goToPosition(cursor.head), 50);
          }
        }}
      />
      )}
      {showShareModal && (
        <ShareModal
          projectId={project.id}
          onClose={() => {
            setShowShareModal(false);
            get(`/api/projects/${project.id}/members`).then((r) => r.json()).then(setMembers).catch(() => {});
          }}
        />
      )}
      {showCompareFiles && (
        <CompareFilesModal
          projectId={project.id}
          files={files}
          onClose={() => setShowCompareFiles(false)}
          onStartDiff={handleDiff}
        />
      )}
      {showGitHubSync && (
        <Suspense fallback={null}><GitHubSyncModal
          projectId={project.id}
          projectName={project.name}
          onClose={() => setShowGitHubSync(false)}
          onFilesUpdated={(files) => setFiles(files)}
          onLinkChanged={(linkData) => setGithubLink(linkData)}
        /></Suspense>
      )}
      {showBibEnrich && activeFile?.path?.endsWith('.bib') && (
        <Suspense fallback={null}><BibEnrichModal
          file={activeFile}
          onClose={() => setShowBibEnrich(false)}
          onApply={(newContent) => {
            handleSave(newContent);
            setFiles((prev) => prev.map((f) =>
              f.id === activeFile.id ? { ...f, content: newContent } : f
            ));
            setActiveFile((prev) => prev ? { ...prev, content: newContent } : prev);
          }}
        /></Suspense>
      )}
      {showZotero && (
        <Suspense fallback={null}><ZoteroModal
          onClose={() => setShowZotero(false)}
          bibFileExists={files.some(f => f.path.endsWith('.bib'))}
          onInsert={async (bibtex) => {
            // Find existing .bib file or create one
            let bibFile = files.find(f => f.path.endsWith('.bib'));
            if (!bibFile) {
              try {
                const res = await post(`/api/projects/${project.id}/files`, { path: 'references.bib', content: bibtex });
                const newFile = await res.json();
                setFiles(prev => [...prev, newFile]);
                switchFile(newFile);
              } catch (e) {
                console.error('Failed to create .bib file', e);
              }
              return;
            }
            // Append to existing .bib file
            const newContent = bibFile.content.trimEnd() + '\n\n' + bibtex;
            setFiles(prev => prev.map(f => f.id === bibFile.id ? { ...f, content: newContent } : f));
            if (activeFile?.id === bibFile.id) {
              setActiveFile(prev => prev ? { ...prev, content: newContent } : prev);
              setTimeout(() => editorRef.current?.replaceContent(newContent), 50);
            }
            // Save to server
            await put(`/api/projects/files/${bibFile.id}`, { content: newContent });
          }}
        /></Suspense>
      )}
      <div className="main-layout">
        {showHistory && (
          <>
          <div className="file-panel history-file-panel" style={{ width: fileTreeWidth, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
            <div className="file-tree-header" style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Files
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
              {(historyFiles || files).map((f) => (
                <div
                  key={f.id}
                  className={`history-file-item ${historySelectedFile?.id === f.id ? 'active' : ''}`}
                  onClick={() => setHistorySelectedFile({ id: f.id, path: f.path })}
                  style={{ padding: '4px 12px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-primary)', cursor: 'pointer' }}
                >
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</span>
                  {historyEditedFileIds.includes(f.id) && (
                    <span className="history-file-edited-badge">Edited</span>
                  )}
                </div>
              ))}
            </div>
          </div>
          <Suspense fallback={null}><HistoryPanel
            projectId={project.id}
            currentUserName={user?.name}
            historyFileId={historySelectedFile?.id}
            historyFilePath={historySelectedFile?.path}
            refreshKey={historyVersion}
            snapshotInterval={project.snapshot_interval_sec || 30}
            onSnapshotIntervalChange={async (val) => {
              const csrfToken = document.cookie.match(/(?:^|;\s*)csrf-token=([^;]+)/)?.[1] || '';
              await fetch(`/api/projects/${project.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
                credentials: 'include',
                body: JSON.stringify({ snapshot_interval_sec: val }),
              });
              setProject((p) => ({ ...p, snapshot_interval_sec: val }));
            }}
            onClose={() => { setShowHistory(false); setHistoryEditedFileIds([]); setHistoryFiles(null); setHistorySelectedFile(null); }}
            onRestore={(restoredFiles) => {
              setFiles(restoredFiles);
              setShowHistory(false);
              setHistoryEditedFileIds([]);
              setHistoryFiles(null);
              setHistorySelectedFile(null);
              // If the active file still exists, update it; otherwise pick a new one
              const stillExists = restoredFiles.find((f) => f.id === activeFile?.id);
              if (stillExists) {
                setActiveFile(stillExists);
                setTimeout(() => editorRef.current?.replaceContent(stillExists.content), 50);
              } else if (restoredFiles.length > 0) {
                const mainFile = restoredFiles.find((f) => f.path === (project?.main_file || 'main.tex'));
                setActiveFile(mainFile || restoredFiles[0]);
                setTimeout(() => editorRef.current?.replaceContent((mainFile || restoredFiles[0]).content), 50);
              } else {
                setActiveFile(null);
              }
            }}
            onSelectVersion={async (snapshot) => {
              setHistorySelectedFile(null);
              try {
                const res = await get(`/api/history/snapshot/${snapshot.id}`);
                const data = await res.json();
                setHistoryEditedFileIds(data.editedFileIds || []);
                setHistoryFiles(data.files || null);
                // Auto-select first edited file for diff viewing
                if (data.editedFileIds?.length > 0) {
                  const firstEdited = data.files?.find(f => f.id === data.editedFileIds[0]);
                  if (firstEdited) {
                    setHistorySelectedFile({ id: firstEdited.id, path: firstEdited.path });
                  }
                }
              } catch {
                setHistoryEditedFileIds([]);
                setHistoryFiles(null);
              }
            }}
          /></Suspense>
          </>
        )}
        {!showHistory && (
        <>
        {showFiles ? (
        <>
        <div className="file-panel" style={{ width: fileTreeWidth, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
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
              const blob = new Blob([Uint8Array.from(atob(file.content), c => c.charCodeAt(0))], { type: mime });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = fileName; a.click();
              URL.revokeObjectURL(url);
            } else {
              const blob = new Blob([file.content || ''], { type: 'text/plain' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = fileName; a.click();
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
              if (editorRef.current?.replaceContent) {
                editorRef.current.replaceContent(pretty);
              }
              handleSave(pretty);
            }, 100);
          }}
          onCollapse={() => setShowFiles(false)}
        />
        {generatedFiles.length > 0 && (
          <div className="generated-files-panel" style={{ height: genPanelHeight }}>
            <div
              className="generated-files-resize-handle"
              onMouseDown={(e) => {
                e.preventDefault();
                let startY = e.clientY;
                const onMove = (ev) => {
                  const delta = startY - ev.clientY;
                  startY = ev.clientY;
                  setGenPanelHeight((h) => Math.max(60, Math.min(400, h + delta)));
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
                      const res = await get(`/api/compile/${project.id}/generated-file?name=${encodeURIComponent(gf.name)}`);
                      const data = await res.json();
                      setActiveGenFile({ name: data.name, content: data.content });
                    } catch {}
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setGenContextMenu({ x: e.clientX, y: e.clientY, name: gf.name });
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.5 }}>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span className="generated-file-name">{stripJobSuffix(gf.name)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {genContextMenu && (
          <GenFileContextMenu
            x={genContextMenu.x}
            y={genContextMenu.y}
            name={genContextMenu.name}
            onClose={() => setGenContextMenu(null)}
            onDownload={async (name) => {
              try {
                const res = await get(`/api/compile/${project.id}/generated-file?name=${encodeURIComponent(name)}`);
                const data = await res.json();
                const blob = new Blob([data.content], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = name; a.click();
                URL.revokeObjectURL(url);
              } catch {}
            }}
          />
        )}
        </div>
        <ResizeHandle onResize={(d) => setFileTreeWidth((w) => Math.max(120, Math.min(400, w + d)))} />
        </>
        ) : (
          <button className="files-toggle-btn" onClick={() => setShowFiles(true)} title="Show files">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        )}
        {showComments ? (
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
              onClose={() => setShowComments(false)}
              style={{ width: commentsWidth }}
            />
            <ResizeHandle onResize={(d) => setCommentsWidth((w) => Math.max(180, Math.min(450, w + d)))} />
          </>
        ) : (
          <button className="comments-toggle-btn" onClick={() => setShowComments(true)} title="Show comments">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
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
              onCursorChange={(head, anchor) => sendWsMessage({ type: 'cursor', fileId: activeFile?.id, head, anchor })}
              onCompile={handleCompile}
              onRequestComment={(sel) => { setSelection(sel); setShowComments(true); }}
              onScroll={updateCommentPositions}
              onLintDiagnostics={setLintDiagnostics}
              showLineNumbers={showLineNumbers}
              wordWrap={wordWrap}
              trackChangesMode={trackChangesMode}
              trackedChanges={trackedChanges}
              onTrackChange={handleTrackChange}
              onTrackedChangeClick={(changeId, pos) => {
                setTcPopup((prev) => prev?.changeId === changeId ? null : { changeId, x: pos.x, y: pos.y });
              }}
              onDeleteInsertionChar={handleDeleteInsertionChar}
              onToggleTrackChanges={() => setTrackChangesMode((m) => !m)}
              citeKeys={citeKeys}
              autoSaveOn={!!githubLink?.autoPush}
              autoSaveLabel={githubLink?.linked && githubLink?.autoPush ? (
                autoSyncStatus === 'saving' ? 'Saving...' :
                autoSyncStatus === 'error' ? 'Save failed' :
                githubLink?.lastSyncAt ? `Saved ${formatSyncDate(githubLink.lastSyncAt)}` :
                null
              ) : null}
              projectFiles={files}
              onGoToFile={(fileId, line, col) => {
                const f = files.find((f) => f.id === fileId);
                if (f) {
                  if (f.id !== activeFile?.id) {
                    switchFile(f);
                    setTimeout(() => editorRef.current?.goToLine(line, col), 100);
                  } else {
                    editorRef.current?.goToLine(line, col);
                  }
                }
              }}
              onToggleAutoSave={githubLink?.linked ? async () => {
                const newVal = !githubLink.autoPush;
                await patch(`/api/github/link/${project.id}/auto-push`, { enabled: newVal });
                setGithubLink(prev => prev ? { ...prev, autoPush: newVal } : prev);
              } : null}
            />
            {tcPopup && (() => {
              const change = trackedChanges.find((c) => c.id === tcPopup.changeId && c.status === 'pending');
              if (!change) return null;
              return (
                <div className="tc-popup" style={{ position: 'fixed', left: tcPopup.x, top: tcPopup.y + 4, zIndex: 1000 }}>
                  <div className="tc-popup-header">
                    <span className="tc-popup-author">{change.author_name}</span>
                    <button className="tc-popup-close" onClick={() => setTcPopup(null)}>&times;</button>
                  </div>
                  {change.inserted_text && (
                    <div className="tc-popup-detail tc-popup-insert">+ {change.inserted_text.length > 60 ? change.inserted_text.slice(0, 60) + '...' : change.inserted_text}</div>
                  )}
                  {change.deleted_text && (
                    <div className="tc-popup-detail tc-popup-delete">- {change.deleted_text.length > 60 ? change.deleted_text.slice(0, 60) + '...' : change.deleted_text}</div>
                  )}
                  <div className="tc-popup-buttons">
                    <button className="tc-btn tc-btn-accept" onClick={() => handleAcceptChange(change.id)}>Accept</button>
                    <button className="tc-btn tc-btn-reject" onClick={() => handleRejectChange(change.id)}>Reject</button>
                  </div>
                </div>
              );
            })()}
            {trackedChanges.filter((c) => c.status === 'pending').length > 0 && (
              <div className="tc-review-bar">
                <span className="tc-review-count">
                  {trackedChanges.filter((c) => c.status === 'pending').length} pending change{trackedChanges.filter((c) => c.status === 'pending').length !== 1 ? 's' : ''}
                </span>
                <div className="tc-review-actions">
                  <button className="tc-btn tc-btn-accept-all" onClick={handleAcceptAllChanges}>Accept All</button>
                  <button className="tc-btn tc-btn-reject-all" onClick={handleRejectAllChanges}>Reject All</button>
                </div>
                <div className="tc-review-list">
                  {trackedChanges.filter((c) => c.status === 'pending').map((c) => (
                    <div key={c.id} className="tc-review-item" onClick={() => editorRef.current?.goToPosition(c.from_pos)}>
                      <span className="tc-review-author">{c.author_name}</span>
                      {c.inserted_text && <span className="tc-review-insert">+{c.inserted_text.length > 30 ? c.inserted_text.slice(0, 30) + '...' : c.inserted_text}</span>}
                      {c.deleted_text && <span className="tc-review-delete">-{c.deleted_text.length > 30 ? c.deleted_text.slice(0, 30) + '...' : c.deleted_text}</span>}
                      <button className="tc-btn tc-btn-accept" onClick={(e) => { e.stopPropagation(); handleAcceptChange(c.id); }} title="Accept">✓</button>
                      <button className="tc-btn tc-btn-reject" onClick={(e) => { e.stopPropagation(); handleRejectChange(c.id); }} title="Reject">✗</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
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
        <ResizeHandle onResize={(d) => setPdfWidth((w) => {
          const current = w || document.querySelector('.pdf-viewer')?.offsetWidth || 500;
          return Math.max(250, current - d);
        })} />
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
          style={pdfWidth ? { flex: 'none', width: pdfWidth } : undefined}
          onGoToLine={(line, col) => editorRef.current?.goToLine(line, col)}
          onGoToFileAndLine={(filePath, line, col) => {
            const f = files.find((f) => f.path === filePath);
            if (f) {
              switchFile(f);
              setTimeout(() => editorRef.current?.goToLine(line, col), 50);
            } else {
              editorRef.current?.goToLine(line, col);
            }
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
          <button className="chat-toggle-btn" onClick={() => { setShowChat(true); setUnreadChat(0); }} title="Open chat">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
