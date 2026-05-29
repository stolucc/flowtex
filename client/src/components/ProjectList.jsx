import React, { useState, useEffect, useRef, useCallback } from 'react';
import { get, post, del, getCsrfToken } from '../api.js';
import Avatar from './Avatar.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import MfaSetupModal from './MfaSetupModal.jsx';
import TemplateGallery from './TemplateGallery.jsx';
import useClickOutside from '../hooks/useClickOutside.js';
import { useAlert } from '../contexts/AlertContext.jsx';
import { formatRelativeTime } from '../utils/dateFormat.js';
import {
  SearchIcon,
  FileDocumentIcon,
  UploadIcon,
  DownloadIcon,
  HomeIcon,
  LogoutIcon,
  TagIcon,
  UndoIcon,
  TrashIcon,
  DropdownCaretIcon,
} from './Icons.jsx';

const TAG_COLORS = ['#89b4fa', '#b4befe', '#f9e2af', '#fab387', '#f38ba8', '#cba6f7', '#74c7ec', '#f2cdcd'];

/** Dashboard view listing all projects with filtering, sorting, tagging, bulk actions, and invitations. */
export default function ProjectList({ onSelect, user, onLogout, onUserUpdate, onAdmin, pendingInviteId }) {
  const { alert: showAlert } = useAlert();
  const [projects, setProjects] = useState([]);
  // null = not yet attempted, '' = loaded successfully, otherwise an error
  // message. Drives the visible error banner that replaces the silent
  // empty-list state — historically a failed /api/projects request just
  // left projects at [] and the user saw "no projects" with no clue why.
  const [projectsError, setProjectsError] = useState(null);
  const [invitations, setInvitations] = useState([]);
  // True after /invitations/mine has resolved AND the pendingInviteId is
  // not among the returned ids — i.e. the link in the email was for a
  // different account or the invitation is no longer pending.
  const [pendingInviteUnknown, setPendingInviteUnknown] = useState(false);
  const [highlightInviteId, setHighlightInviteId] = useState(null);
  const invitationRefs = useRef({});
  const [tags, setTags] = useState([]);
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  // copyDialog is non-null while the "Copy project" confirm modal is open.
  // { project, name, includeMembers, members?, submitting }
  const [copyDialog, setCopyDialog] = useState(null);
  const [showMfa, setShowMfa] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('github') === 'connected';
  });
  const [settingsInitialTab, setSettingsInitialTab] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('github') === 'connected' ? 'github' : null;
  });
  const [filter, setFilter] = useState('all');
  const [selectedTag, setSelectedTag] = useState(null);
  const [newTagName, setNewTagName] = useState('');
  const [creatingTag, setCreatingTag] = useState(false);
  const [search, setSearch] = useState('');
  useEffect(() => {
    setSelected(new Set());
  }, [filter, selectedTag]);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, project }
  const contextMenuRef = useRef(null);
  const [sortCol, setSortCol] = useState('updated_at');
  const [sortDir, setSortDir] = useState('desc');
  const [selected, setSelected] = useState(new Set());
  const [showBulkTagMenu, setShowBulkTagMenu] = useState(false);
  const bulkTagRef = useRef(null);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const newMenuRef = useRef(null);
  const zipInputRef = useRef(null);
  const docxInputRef = useRef(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showDocxDialog, setShowDocxDialog] = useState(false);
  const [docxFile, setDocxFile] = useState(null);
  const [docxDocType, setDocxDocType] = useState('book');
  const [docxImporting, setDocxImporting] = useState(false);
  const [docxProgress, setDocxProgress] = useState({ message: '', percent: 0 });
  const docxAbortRef = useRef(null);
  const [showGitHubImport, setShowGitHubImport] = useState(false);
  const [ghImportRepo, setGhImportRepo] = useState('');
  const [ghImportBranch, setGhImportBranch] = useState('');
  const [ghImportLoading, setGhImportLoading] = useState(false);
  const [ghImportError, setGhImportError] = useState('');
  const [ghRepos, setGhRepos] = useState(null);
  const [ghReposLoading, setGhReposLoading] = useState(false);
  const [ghRepoSearch, setGhRepoSearch] = useState('');

  // The fetch + scroll-to-invitation flow is a one-shot mount effect:
  // pendingInviteId is whatever the URL had at first paint, the code
  // strips it from history once consumed, and we don't want to re-fire
  // the entire initial-load sequence if the prop ever changes later.
  // Snapshot via useRef so the effect can legitimately use [] deps
  // without ESLint complaining about a stale closure.
  const initialInviteIdRef = useRef(pendingInviteId);
  useEffect(() => {
    const initialInviteId = initialInviteIdRef.current;
    get('/api/projects')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = await r.json();
        if (!Array.isArray(body)) throw new Error('Response was not an array');
        setProjects(body);
        setProjectsError('');
      })
      .catch((e) => {
        console.warn('Failed to load projects:', e);
        setProjectsError(e.message || 'Unknown error');
      });
    get('/api/projects/invitations/mine')
      .then((r) => r.json())
      .then((rows) => {
        setInvitations(rows);
        if (initialInviteId) {
          const match = rows.find((r) => r.id === initialInviteId);
          if (match) {
            setHighlightInviteId(initialInviteId);
            // Strip the param now so a refresh doesn't re-trigger / leak via referrer.
            window.history.replaceState({}, '', '/');
            // Scroll on next paint, after the cards have rendered.
            requestAnimationFrame(() => {
              invitationRefs.current[initialInviteId]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
            // Drop the highlight after a beat so the user doesn't have to manually clear it.
            setTimeout(() => setHighlightInviteId(null), 4000);
          } else {
            setPendingInviteUnknown(true);
            window.history.replaceState({}, '', '/');
          }
        }
      })
      .catch((e) => console.warn('Failed to load invitations:', e));
    get('/api/tags')
      .then((r) => r.json())
      .then(setTags)
      .catch((e) => console.warn('Failed to load tags:', e));
  }, []);

  // Listen for real-time invitation pushes via WebSocket
  useEffect(() => {
    const handler = (e) => {
      setInvitations((inv) => {
        if (inv.some((i) => i.id === e.detail.id)) return inv;
        return [e.detail, ...inv];
      });
    };
    window.addEventListener('ws:invitation', handler);
    return () => window.removeEventListener('ws:invitation', handler);
  }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    const res = await post('/api/projects', { name: name || 'Untitled' });
    const project = await res.json();
    setName('');
    onSelect(project);
  };

  /** Import a GitHub repository as a new FlowTex project. */
  const handleGitHubImport = async () => {
    if (!ghImportRepo.trim()) return;
    setGhImportLoading(true);
    setGhImportError('');
    try {
      const res = await post('/api/github/import', {
        repo: ghImportRepo.trim(),
        branch: ghImportBranch.trim() || undefined,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Import failed');
      }
      const project = await res.json();
      setShowGitHubImport(false);
      setGhImportRepo('');
      setGhImportBranch('');
      onSelect(project);
    } catch (err) {
      setGhImportError(err.message);
    } finally {
      setGhImportLoading(false);
    }
  };

  /** Open the GitHub import modal and load the user's repositories. */
  const openGitHubImport = async () => {
    setShowNewMenu(false);
    setShowGitHubImport(true);
    setGhImportError('');
    setGhImportRepo('');
    setGhImportBranch('');
    setGhRepoSearch('');
    if (!ghRepos) {
      setGhReposLoading(true);
      try {
        const res = await get('/api/github/repos');
        if (res.ok) setGhRepos(await res.json());
        else setGhRepos([]);
      } catch {
        setGhRepos([]);
      } finally {
        setGhReposLoading(false);
      }
    }
  };

  /** Upload a ZIP file to create a new project from its contents. */
  const handleUploadZip = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/projects/from-zip', {
      method: 'POST',
      body: formData,
      credentials: 'include',
      headers: { 'X-CSRF-Token': getCsrfToken() },
    });
    if (res.ok) {
      const project = await res.json();
      onSelect(project);
    }
  };

  /** Import a .docx file to create a new project. Reads SSE progress events. */
  const handleImportDocx = async (file, options = {}) => {
    setDocxImporting(true);
    setDocxProgress({ message: 'Uploading…', percent: 5 });
    const abortController = new AbortController();
    docxAbortRef.current = abortController;
    const formData = new FormData();
    formData.append('file', file);
    if (options.docType) formData.append('docType', options.docType);
    try {
      const res = await fetch('/api/projects/from-docx', {
        method: 'POST',
        body: formData,
        credentials: 'include',
        headers: { 'X-CSRF-Token': getCsrfToken() },
        signal: abortController.signal,
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Parse SSE lines
        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete line
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'progress') {
              setDocxProgress({ message: evt.message, percent: evt.percent });
            } else if (evt.type === 'result') {
              setDocxImporting(false);
              setShowDocxDialog(false);
              setDocxFile(null);
              onSelect(evt);
              return;
            } else if (evt.type === 'error') {
              setDocxImporting(false);
              showAlert(evt.error || 'Failed to import .docx file', { title: 'DOCX import failed' });
              return;
            }
          } catch { /* ignore parse errors */ }
        }
      }
      // If we get here without a result event, something went wrong
      setDocxImporting(false);
      showAlert('Import failed — no response from server', { title: 'DOCX import failed' });
    } catch (err) {
      setDocxImporting(false);
      docxAbortRef.current = null;
      if (err.name === 'AbortError') return; // user cancelled
      showAlert(err.message || 'Failed to import .docx file', { title: 'DOCX import failed' });
    }
  };

  const isOwner = (project) => project.owner_id === user?.id;

  const handleDelete = async (id) => {
    await del(`/api/projects/${id}`);
    setProjects((ps) => ps.filter((p) => p.id !== id));
    setSelected((s) => { const n = new Set(s); n.delete(id); return n; });
  };

  const handleTrash = async (e, project) => {
    e.stopPropagation();
    await post(`/api/projects/${project.id}/trash`);
    if (isOwner(project)) {
      setProjects((ps) => ps.map((p) => (p.id === project.id ? { ...p, trashed: 1 } : p)));
    } else {
      setProjects((ps) => ps.filter((p) => p.id !== project.id));
    }
    setSelected((s) => { const n = new Set(s); n.delete(project.id); return n; });
  };

  const handleRestore = async (e, project) => {
    e.stopPropagation();
    await post(`/api/projects/${project.id}/restore`);
    setProjects((ps) => ps.map((p) => (p.id === project.id ? { ...p, trashed: 0 } : p)));
  };

  const handleArchive = async (e, project) => {
    e.stopPropagation();
    await post(`/api/projects/${project.id}/archive`);
    if (isOwner(project)) {
      setProjects((ps) => ps.map((p) => (p.id === project.id ? { ...p, archived: 1 } : p)));
    } else {
      setProjects((ps) => ps.filter((p) => p.id !== project.id));
    }
  };

  const handleUnarchive = async (e, project) => {
    e.stopPropagation();
    await post(`/api/projects/${project.id}/unarchive`);
    setProjects((ps) => ps.map((p) => (p.id === project.id ? { ...p, archived: 0 } : p)));
  };

  const handleCopy = async (e, project) => {
    e.stopPropagation();
    // Solo projects: copy directly with no prompt. Shared projects: open
    // the dialog so the user can pick a name and decide whether to bring
    // the collaborators across.
    const memberCount = parseInt(project.member_count) || 1;
    if (memberCount <= 1) {
      const res = await post(`/api/projects/${project.id}/copy`);
      if (res.ok) {
        const copied = await res.json();
        setProjects((ps) => [copied, ...ps]);
      }
      return;
    }
    // Open the dialog. Fetch the actual member list in parallel so we can
    // show their names alongside the share toggle.
    setCopyDialog({
      project,
      name: `${project.name} (Copy)`,
      includeMembers: true,
      members: null,
      submitting: false,
    });
    try {
      const r = await get(`/api/projects/${project.id}/members`);
      if (r.ok) {
        const members = await r.json();
        setCopyDialog((d) => (d && d.project.id === project.id ? { ...d, members } : d));
      }
    } catch {
      // Non-fatal — dialog still works without the names.
    }
  };

  const submitCopy = async () => {
    if (!copyDialog || copyDialog.submitting) return;
    setCopyDialog((d) => ({ ...d, submitting: true }));
    try {
      const res = await post(`/api/projects/${copyDialog.project.id}/copy`, {
        name: copyDialog.name.trim() || undefined,
        includeMembers: copyDialog.includeMembers,
      });
      if (res.ok) {
        const copied = await res.json();
        setProjects((ps) => [copied, ...ps]);
        setCopyDialog(null);
      } else {
        setCopyDialog((d) => ({ ...d, submitting: false }));
      }
    } catch {
      setCopyDialog((d) => ({ ...d, submitting: false }));
    }
  };

  const confirmDeleteProject = (e, project) => {
    e.stopPropagation();
    const owned = isOwner(project);
    setConfirmDelete({
      message: owned
        ? `Are you sure you want to permanently delete "${project.name}"?`
        : `Leave "${project.name}"? You will lose access to this project.`,
      onConfirm: () => {
        handleDelete(project.id);
        setConfirmDelete(null);
      },
    });
  };

  /** Accept a project invitation and refresh the project list. */
  const handleAcceptInvite = async (inviteId) => {
    try {
      const res = await post(`/api/projects/invitations/${inviteId}/accept`);
      if (res.ok) {
        setInvitations((inv) => inv.filter((i) => i.id !== inviteId));
        const projRes = await get('/api/projects');
        setProjects(await projRes.json());
      } else {
        const data = await res.json().catch(() => ({}));
        showAlert(data.error || 'Failed to accept invitation', { title: 'Accept invitation' });
      }
    } catch {
      showAlert('Failed to accept invitation', { title: 'Accept invitation' });
    }
  };

  const handleDeclineInvite = async (inviteId) => {
    try {
      const res = await post(`/api/projects/invitations/${inviteId}/decline`);
      if (res.ok) {
        setInvitations((inv) => inv.filter((i) => i.id !== inviteId));
      } else {
        const data = await res.json().catch(() => ({}));
        showAlert(data.error || 'Failed to decline invitation', { title: 'Decline invitation' });
      }
    } catch {
      showAlert('Failed to decline invitation', { title: 'Decline invitation' });
    }
  };

  /** Create a new tag with an auto-assigned color. */
  const handleCreateTag = async (e) => {
    e.preventDefault();
    if (!newTagName.trim()) return;
    const color = TAG_COLORS[tags.length % TAG_COLORS.length];
    const res = await post('/api/tags', { name: newTagName.trim(), color });
    if (res.ok) {
      const tag = await res.json();
      setTags((t) => [...t, tag]);
      setNewTagName('');
      setCreatingTag(false);
    }
  };

  /** Delete a tag after confirmation, removing it from all projects. */
  const handleDeleteTag = (tagId) => {
    const tag = tags.find((t) => t.id === tagId);
    setConfirmDelete({
      message: `Delete tag "${tag?.name || ''}"? It will be removed from all projects.`,
      onConfirm: async () => {
        await del(`/api/tags/${tagId}`);
        setTags((t) => t.filter((tg) => tg.id !== tagId));
        setProjects((ps) => ps.map((p) => ({ ...p, tags: (p.tags || []).filter((t) => t.id !== tagId) })));
        if (selectedTag === tagId) {
          setSelectedTag(null);
          setFilter('all');
        }
        setConfirmDelete(null);
      },
    });
  };

  /** Toggle a tag on/off for a specific project. */
  const handleToggleProjectTag = async (e, projectId, tagId) => {
    e.stopPropagation();
    const project = projects.find((p) => p.id === projectId);
    const hasTag = project?.tags?.some((t) => t.id === tagId);
    if (hasTag) {
      await del(`/api/projects/${projectId}/tags/${tagId}`);
      setProjects((ps) =>
        ps.map((p) => (p.id === projectId ? { ...p, tags: (p.tags || []).filter((t) => t.id !== tagId) } : p)),
      );
    } else {
      await post(`/api/projects/${projectId}/tags/${tagId}`);
      const tag = tags.find((t) => t.id === tagId);
      setProjects((ps) => ps.map((p) => (p.id === projectId ? { ...p, tags: [...(p.tags || []), tag] } : p)));
    }
  };

  useClickOutside(
    contextMenuRef,
    useCallback(() => setContextMenu(null), []),
    !!contextMenu,
  );
  useClickOutside(
    bulkTagRef,
    useCallback(() => setShowBulkTagMenu(false), []),
    showBulkTagMenu,
  );
  useClickOutside(
    newMenuRef,
    useCallback(() => setShowNewMenu(false), []),
    showNewMenu,
  );

  /** Apply a tag to all currently selected projects. */
  const handleBulkTag = async (tagId) => {
    const tag = tags.find((t) => t.id === tagId);
    for (const id of selected) {
      const project = projects.find((p) => p.id === id);
      if (project && !(project.tags || []).some((t) => t.id === tagId)) {
        await post(`/api/projects/${id}/tags/${tagId}`);
      }
    }
    setProjects((ps) =>
      ps.map((p) => {
        if (!selected.has(p.id)) return p;
        if ((p.tags || []).some((t) => t.id === tagId)) return p;
        return { ...p, tags: [...(p.tags || []), tag] };
      }),
    );
    setShowBulkTagMenu(false);
  };

  // Filter projects
  const filteredProjects = projects.filter((p) => {
    if (filter === 'all' && !p.trashed && !p.archived) {
      /* ok */
    } else if (filter === 'yours' && !p.trashed && !p.archived && p.owner_id === user?.id) {
      /* ok */
    } else if (filter === 'shared' && !p.trashed && !p.archived && p.owner_id !== user?.id) {
      /* ok */
    } else if (filter === 'archived' && p.archived && !p.trashed) {
      /* ok */
    } else if (filter === 'deleted' && p.trashed) {
      /* ok */
    } else if (filter === 'tag' && !p.trashed && (p.tags || []).some((t) => t.id === selectedTag)) {
      /* ok */
    } else return false;
    // Apply search filter
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      return p.name.toLowerCase().includes(q) || (p.owner_name || '').toLowerCase().includes(q);
    }
    return true;
  });

  // Sort
  const sortedProjects = [...filteredProjects].sort((a, b) => {
    let aVal, bVal;
    if (sortCol === 'name') {
      aVal = a.name.toLowerCase();
      bVal = b.name.toLowerCase();
    } else if (sortCol === 'owner') {
      aVal = (a.owner_id === user?.id ? '' : a.owner_name || '').toLowerCase();
      bVal = (b.owner_id === user?.id ? '' : b.owner_name || '').toLowerCase();
    } else if (sortCol === 'created_at') {
      aVal = a.created_at || '';
      bVal = b.created_at || '';
    } else if (sortCol === 'updated_at') {
      aVal = a.updated_at || '';
      bVal = b.updated_at || '';
    } else if (sortCol === 'last_editor') {
      aVal = (a.last_editor || '').toLowerCase();
      bVal = (b.last_editor || '').toLowerCase();
    } else if (sortCol === 'member_count') {
      aVal = parseInt(a.member_count) || 1;
      bVal = parseInt(b.member_count) || 1;
    } else return 0;
    if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const handleSort = (col) => {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir(col === 'updated_at' || col === 'created_at' ? 'desc' : 'asc');
    }
  };

  const SortIcon = ({ col }) => {
    if (sortCol !== col) return <span className="sort-icon inactive">&lsaquo;</span>;
    return <span className="sort-icon">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>;
  };

  const categories = [
    {
      id: 'all',
      label: 'All Projects',
      icon: <HomeIcon />,
    },
    {
      id: 'yours',
      label: 'Your Projects',
      icon: (
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
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      ),
    },
    {
      id: 'shared',
      label: 'Shared with You',
      icon: (
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
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      ),
    },
    {
      id: 'archived',
      label: 'Archived Projects',
      icon: (
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
          <polyline points="21 8 21 21 3 21 3 8" />
          <rect x="1" y="3" width="22" height="5" />
          <line x1="10" y1="12" x2="14" y2="12" />
        </svg>
      ),
    },
    {
      id: 'deleted',
      label: 'Deleted Projects',
      icon: <TrashIcon size={16} />,
    },
  ];

  if (showTemplates) {
    return <TemplateGallery onSelect={onSelect} onBack={() => setShowTemplates(false)} />;
  }

  return (
    <div className="dashboard">
      <div className="dashboard-sidebar">
        <div className="dashboard-logo">
          <h1>FlowTex</h1>
          <p>Make Your Tex Flow</p>
        </div>

        <div className="new-project-btn-group" ref={newMenuRef}>
          <button className="sidebar-new-project-btn" onClick={() => handleCreate({ preventDefault: () => {} })}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Project
          </button>
          <button className="new-project-menu-toggle" onClick={() => setShowNewMenu(!showNewMenu)}>
            <DropdownCaretIcon />
          </button>
          {showNewMenu && (
            <div className="new-project-dropdown-menu">
              <button
                onClick={() => {
                  setShowNewMenu(false);
                  handleCreate({ preventDefault: () => {} });
                }}
              >
                <FileDocumentIcon size={14} />
                Blank Project
              </button>
              <button
                onClick={() => {
                  setShowNewMenu(false);
                  zipInputRef.current?.click();
                }}
              >
                <UploadIcon />
                Upload ZIP
              </button>
              <button
                onClick={() => {
                  setShowNewMenu(false);
                  docxInputRef.current?.click();
                }}
              >
                <UploadIcon />
                Import .docx
              </button>
              <button onClick={openGitHubImport}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
                </svg>
                Import from GitHub
              </button>
              <button
                onClick={() => {
                  setShowNewMenu(false);
                  setShowTemplates(true);
                }}
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
                >
                  <rect x="3" y="3" width="7" height="7" />
                  <rect x="14" y="3" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" />
                </svg>
                From Template
              </button>
            </div>
          )}
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleUploadZip(file);
              e.target.value = '';
            }}
          />
          <input
            ref={docxInputRef}
            type="file"
            accept=".docx,.doc"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                setDocxFile(file);
                setDocxDocType('book');
                setShowDocxDialog(true);
              }
              e.target.value = '';
            }}
          />
        </div>

        <div className="sidebar-categories">
          {categories.map((cat) => (
            <button
              key={cat.id}
              className={`sidebar-category ${filter === cat.id && !selectedTag ? 'active' : ''}`}
              onClick={() => {
                setFilter(cat.id);
                setSelectedTag(null);
              }}
            >
              {cat.icon}
              <span>{cat.label}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-tags-section">
          <div className="sidebar-tags-header">
            <span className="sidebar-section-label">Tags</span>
            <button className="sidebar-add-tag-btn" onClick={() => setCreatingTag(!creatingTag)} title="Create tag">
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
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
          {creatingTag && (
            <form className="sidebar-new-tag-form" onSubmit={handleCreateTag}>
              <input
                type="text"
                placeholder="Tag name..."
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                autoFocus
                onBlur={() => {
                  if (!newTagName.trim()) setCreatingTag(false);
                }}
              />
            </form>
          )}
          <div className="sidebar-tags-list">
            {tags.map((tag) => (
              <button
                key={tag.id}
                className={`sidebar-tag ${filter === 'tag' && selectedTag === tag.id ? 'active' : ''}`}
                onClick={() => {
                  setFilter('tag');
                  setSelectedTag(tag.id);
                }}
              >
                <span className="sidebar-tag-dot" style={{ background: tag.color }} />
                <span className="sidebar-tag-name">
                  {tag.name} ({projects.filter((p) => !p.trashed && (p.tags || []).some((t) => t.id === tag.id)).length}
                  )
                </span>
                <span
                  className="sidebar-tag-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteTag(tag.id);
                  }}
                  title="Delete tag"
                >
                  &times;
                </span>
              </button>
            ))}
          </div>
        </div>

        {user && (
          <div className="sidebar-user">
            <Avatar name={user.name} size={28} />
            <span className="sidebar-user-name">{user.name}</span>
            {user.isAdmin && onAdmin && (
              <button className="sidebar-icon-btn" onClick={onAdmin} title="Admin Dashboard">
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
                  <path d="M12 20V10" />
                  <path d="M18 20V4" />
                  <path d="M6 20v-4" />
                </svg>
              </button>
            )}
            <button className="sidebar-icon-btn" onClick={() => setShowMfa(true)} title="Settings">
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
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <button className="sidebar-icon-btn" onClick={onLogout} title="Log out">
              <LogoutIcon />
            </button>
          </div>
        )}
      </div>

      <div className="dashboard-main">
        <div className="dashboard-topbar">
          <h2 className="dashboard-view-title">
            {filter === 'tag' && selectedTag
              ? tags.find((t) => t.id === selectedTag)?.name || 'Tag'
              : categories.find((c) => c.id === filter)?.label || 'All Projects'}
          </h2>
        </div>
        <div className="project-search-bar">
          <SearchIcon />
          <input
            type="text"
            // Defensive — browser password managers otherwise treat any
            // generic text input as a "username" candidate when a password
            // field appears anywhere on the page (e.g. the GitHub-PAT
            // input in Account Settings). autocomplete="off" + the search
            // semantics keep saved github.com usernames out of this box.
            autoComplete="off"
            name="project-search"
            inputMode="search"
            placeholder="Search projects..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {selected.size > 0 && (
          <div className="bulk-actions-bar">
            <span className="bulk-actions-count">{selected.size} selected</span>
            <button
              className="bulk-action-btn"
              onClick={() => {
                selected.forEach((id) => window.open(`/api/projects/${id}/zip`, '_blank'));
              }}
              title="Download"
            >
              <DownloadIcon />
              Download
            </button>
            <div className="bulk-tag-wrapper" ref={bulkTagRef}>
              <button className="bulk-action-btn" onClick={() => setShowBulkTagMenu((v) => !v)} title="Assign tag">
                <TagIcon />
                Tag
              </button>
              {showBulkTagMenu && (
                <div className="bulk-tag-dropdown">
                  {tags.length === 0 ? (
                    <div className="bulk-tag-empty">No tags yet</div>
                  ) : (
                    tags.map((tag) => (
                      <button key={tag.id} className="bulk-tag-option" onClick={() => handleBulkTag(tag.id)}>
                        <span className="sidebar-tag-dot" style={{ background: tag.color }} />
                        {tag.name}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            {filter !== 'archived' && filter !== 'deleted' && (
              <button
                className="bulk-action-btn"
                onClick={async () => {
                  for (const id of selected) await post(`/api/projects/${id}/archive`);
                  setProjects((ps) => ps.map((p) => (selected.has(p.id) ? { ...p, archived: 1 } : p)));
                  setSelected(new Set());
                }}
                title="Archive"
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
                >
                  <polyline points="21 8 21 21 3 21 3 8" />
                  <rect x="1" y="3" width="22" height="5" />
                  <line x1="10" y1="12" x2="14" y2="12" />
                </svg>
                Archive
              </button>
            )}
            {filter === 'archived' && (
              <button
                className="bulk-action-btn"
                onClick={async () => {
                  for (const id of selected) await post(`/api/projects/${id}/unarchive`);
                  setProjects((ps) => ps.map((p) => (selected.has(p.id) ? { ...p, archived: 0 } : p)));
                  setSelected(new Set());
                }}
                title="Unarchive"
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
                >
                  <polyline points="21 8 21 21 3 21 3 8" />
                  <rect x="1" y="3" width="22" height="5" />
                  <line x1="10" y1="12" x2="14" y2="12" />
                </svg>
                Unarchive
              </button>
            )}
            {filter === 'deleted' ? (
              <>
                <button
                  className="bulk-action-btn"
                  onClick={async () => {
                    for (const id of selected) await post(`/api/projects/${id}/restore`);
                    setProjects((ps) => ps.map((p) => (selected.has(p.id) ? { ...p, trashed: 0 } : p)));
                    setSelected(new Set());
                  }}
                  title="Restore"
                >
                  <UndoIcon />
                  Restore
                </button>
                <button
                  className="bulk-action-btn bulk-action-danger"
                  onClick={() =>
                    setConfirmDelete({
                      message: `Permanently delete ${selected.size} project(s)? This cannot be undone.`,
                      onConfirm: async () => {
                        for (const id of selected) await del(`/api/projects/${id}`);
                        setProjects((ps) => ps.filter((p) => !selected.has(p.id)));
                        setSelected(new Set());
                        setConfirmDelete(null);
                      },
                    })
                  }
                  title="Delete permanently"
                >
                  <TrashIcon />
                  Delete permanently
                </button>
              </>
            ) : (
              <button
                className="bulk-action-btn bulk-action-danger"
                onClick={() =>
                  setConfirmDelete({
                    message: `Are you sure you want to delete ${selected.size} project(s)?`,
                    onConfirm: async () => {
                      for (const id of selected) await post(`/api/projects/${id}/trash`);
                      setProjects((ps) => ps.map((p) => (selected.has(p.id) ? { ...p, trashed: 1 } : p)));
                      setSelected(new Set());
                      setConfirmDelete(null);
                    },
                  })
                }
                title="Delete"
              >
                <TrashIcon />
                Delete
              </button>
            )}
            <button className="bulk-action-btn-clear" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        )}

        {pendingInviteUnknown && (
          <div className="invite-mismatch-banner" role="alert">
            This invitation link isn&apos;t for your account, or it&apos;s no longer pending. Ask the inviter to send a new one to the email you signed in with.
            <button className="invite-mismatch-dismiss" onClick={() => setPendingInviteUnknown(false)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}

        {invitations.length > 0 && (
          <div className="invitations-section">
            <h3 className="invitations-title">Pending Invitations</h3>
            <div className="invitations-list">
              {invitations.map((inv) => (
                <div
                  key={inv.id}
                  ref={(el) => {
                    if (el) invitationRefs.current[inv.id] = el;
                    else delete invitationRefs.current[inv.id];
                  }}
                  className={`invitation-card${highlightInviteId === inv.id ? ' invitation-card-highlight' : ''}`}
                >
                  <div className="invitation-info">
                    <span className="invitation-project-name">{inv.project_name}</span>
                    <span className="invitation-meta">
                      Invited by {inv.inviter_name} as {inv.role} &middot; {formatRelativeTime(inv.created_at)}
                    </span>
                  </div>
                  <div className="invitation-actions">
                    <button className="invitation-accept-btn" onClick={() => handleAcceptInvite(inv.id)}>
                      Accept
                    </button>
                    <button className="invitation-decline-btn" onClick={() => handleDeclineInvite(inv.id)}>
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {projectsError ? (
          <div className="project-table-empty" style={{ color: 'var(--accent)' }}>
            Couldn&apos;t load projects ({projectsError}).{' '}
            <button
              type="button"
              className="project-tag-clickable"
              onClick={() => window.location.reload()}
              style={{ marginLeft: 8 }}
            >
              Retry
            </button>
          </div>
        ) : sortedProjects.length === 0 ? (
          <div className="project-table-empty">No projects in this view.</div>
        ) : (
          <table className="project-table">
            <thead>
              <tr>
                <th className="project-table-check-col">
                  <input
                    type="checkbox"
                    checked={sortedProjects.length > 0 && sortedProjects.every((p) => selected.has(p.id))}
                    onChange={(e) => {
                      if (e.target.checked) setSelected(new Set(sortedProjects.map((p) => p.id)));
                      else setSelected(new Set());
                    }}
                  />
                </th>
                <th className="project-table-sortable" onClick={() => handleSort('name')}>
                  Title <SortIcon col="name" />
                </th>
                <th className="project-table-sortable" onClick={() => handleSort('owner')}>
                  Owner <SortIcon col="owner" />
                </th>
                <th className="project-table-sortable" onClick={() => handleSort('member_count')}>
                  Members <SortIcon col="member_count" />
                </th>
                <th className="project-table-sortable" onClick={() => handleSort('created_at')}>
                  Created <SortIcon col="created_at" />
                </th>
                <th className="project-table-sortable" onClick={() => handleSort('updated_at')}>
                  Last Modified <SortIcon col="updated_at" />
                </th>
                <th className="project-table-sortable" onClick={() => handleSort('last_editor')}>
                  Modified By <SortIcon col="last_editor" />
                </th>
                <th className="project-table-actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedProjects.map((p) => (
                <tr
                  key={p.id}
                  className={`project-table-row ${selected.has(p.id) ? 'selected' : ''}`}
                  onClick={() => !p.trashed && onSelect(p)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, project: p });
                  }}
                >
                  <td className="project-table-check" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() =>
                        setSelected((s) => {
                          const next = new Set(s);
                          if (next.has(p.id)) next.delete(p.id);
                          else next.add(p.id);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td className="project-table-title">
                    <span className="project-table-name">
                      {p.name}
                      {p.github_repo && (
                        <svg
                          className="project-github-icon"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          title={p.github_repo}
                        >
                          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
                        </svg>
                      )}
                    </span>
                    {(p.tags || []).length > 0 && (
                      <span className="project-table-tags">
                        {p.tags.map((t) => (
                          <span
                            key={t.id}
                            className="project-tag-chip"
                            style={{ background: t.color + '33', color: t.color }}
                          >
                            {t.name}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="project-table-cell">{p.owner_id === user?.id ? 'You' : p.owner_name || ''}</td>
                  <td className="project-table-cell">{p.member_count || 1}</td>
                  <td className="project-table-cell">{formatRelativeTime(p.created_at)}</td>
                  <td className="project-table-cell">{formatRelativeTime(p.updated_at)}</td>
                  <td className="project-table-cell">{p.last_editor === user?.name ? 'You' : p.last_editor || ''}</td>
                  <td className="project-table-cell project-table-actions" onClick={(e) => e.stopPropagation()}>
                    {filter === 'deleted' ? (
                      <>
                        <button className="project-action-btn" onClick={(e) => handleRestore(e, p)} title="Restore">
                          <UndoIcon size={15} />
                        </button>
                        <button
                          className="project-action-btn project-action-danger"
                          onClick={(e) => confirmDeleteProject(e, p)}
                          title="Delete permanently"
                        >
                          <TrashIcon size={15} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="project-action-btn" onClick={(e) => handleCopy(e, p)} title="Copy">
                          <svg
                            width="15"
                            height="15"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        </button>
                        <button
                          className="project-action-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            window.location.href = `/api/projects/${p.id}/zip`;
                          }}
                          title="Download ZIP"
                        >
                          <DownloadIcon size={15} />
                        </button>
                        {p.archived ? (
                          <button
                            className="project-action-btn"
                            onClick={(e) => handleUnarchive(e, p)}
                            title="Unarchive"
                          >
                            <svg
                              width="15"
                              height="15"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <polyline points="21 8 21 21 3 21 3 8" />
                              <rect x="1" y="3" width="22" height="5" />
                              <line x1="10" y1="12" x2="14" y2="12" />
                            </svg>
                          </button>
                        ) : (
                          <button className="project-action-btn" onClick={(e) => handleArchive(e, p)} title="Archive">
                            <svg
                              width="15"
                              height="15"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <polyline points="21 8 21 21 3 21 3 8" />
                              <rect x="1" y="3" width="22" height="5" />
                              <line x1="10" y1="12" x2="14" y2="12" />
                            </svg>
                          </button>
                        )}
                        <button
                          className="project-action-btn project-action-danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDelete({
                              message: `Are you sure you want to delete "${p.name}"?`,
                              onConfirm: () => {
                                handleTrash(e, p);
                                setConfirmDelete(null);
                              },
                            });
                          }}
                          title="Delete"
                        >
                          <TrashIcon size={15} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {contextMenu && (
        <div ref={contextMenuRef} className="project-context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
          <div className="context-menu-header">Tags</div>
          {tags.length === 0 && <div className="context-menu-empty">No tags yet</div>}
          {tags.map((tag) => {
            const hasTag = (contextMenu.project.tags || []).some((t) => t.id === tag.id);
            return (
              <button
                key={tag.id}
                className="context-menu-item"
                onClick={(e) => {
                  handleToggleProjectTag(e, contextMenu.project.id, tag.id);
                  setContextMenu(null);
                }}
              >
                <span className={`context-menu-check ${hasTag ? 'checked' : ''}`}>{hasTag ? '\u2713' : ''}</span>
                <span className="sidebar-tag-dot" style={{ background: tag.color }} />
                <span>{tag.name}</span>
              </button>
            );
          })}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          message={confirmDelete.message}
          onConfirm={confirmDelete.onConfirm}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      {copyDialog && (
        <div
          className="modal-overlay"
          onClick={(e) => { if (e.target === e.currentTarget && !copyDialog.submitting) setCopyDialog(null); }}
        >
          <div className="modal copy-project-modal">
            <div className="modal-header">
              <h2>Copy project</h2>
            </div>
            <form
              className="copy-project-body"
              onSubmit={(e) => { e.preventDefault(); submitCopy(); }}
            >
              <label className="copy-project-field">
                <span>Name of the copy</span>
                <input
                  type="text"
                  autoFocus
                  value={copyDialog.name}
                  onChange={(e) => setCopyDialog((d) => ({ ...d, name: e.target.value }))}
                  maxLength={200}
                />
              </label>
              {(() => {
                // Always exclude the caller from "other collaborators" —
                // member_count and the /members response both include them.
                const others = copyDialog.members
                  ? copyDialog.members.filter((m) => m.id !== user?.id)
                  : null;
                const otherCount = others
                  ? others.length
                  : Math.max(0, (parseInt(copyDialog.project.member_count) || 1) - 1);
                return (
                  <>
                    <label className="copy-project-check">
                      <input
                        type="checkbox"
                        checked={copyDialog.includeMembers}
                        onChange={(e) =>
                          setCopyDialog((d) => ({ ...d, includeMembers: e.target.checked }))
                        }
                      />
                      <span>
                        Also share with the {otherCount} other collaborator{otherCount === 1 ? '' : 's'} on the original
                      </span>
                    </label>
                    {others && others.length > 0 && (
                      <ul className="copy-project-members">
                        {others.map((m) => (
                          <li key={m.id}>
                            {m.name}
                            {m.role && m.role !== 'editor' ? ` (${m.role})` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                );
              })()}
              <div className="copy-project-actions">
                <button
                  type="button"
                  onClick={() => setCopyDialog(null)}
                  disabled={copyDialog.submitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="copy-project-confirm"
                  disabled={copyDialog.submitting || !copyDialog.name.trim()}
                >
                  {copyDialog.submitting ? 'Copying…' : 'Copy'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {showMfa && (
        <MfaSetupModal
          user={user}
          onClose={() => {
            setShowMfa(false);
            setSettingsInitialTab(null);
          }}
          onUpdate={(updatedUser) => onUserUpdate?.(updatedUser)}
          onAccountDeleted={onLogout}
          initialTab={settingsInitialTab}
        />
      )}
      {showDocxDialog && (
        <div className="modal-overlay" onClick={docxImporting ? undefined : () => { setShowDocxDialog(false); setDocxFile(null); }}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>Import .docx</h2>
            <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-secondary)' }}>
              {docxFile?.name}
            </p>
            {docxImporting ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  {docxProgress.message}
                </div>
                <div style={{
                  height: 6, borderRadius: 3,
                  background: 'var(--bg-tertiary, var(--bg-secondary))',
                  overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%', borderRadius: 3,
                    background: 'var(--accent)',
                    width: `${docxProgress.percent}%`,
                    transition: 'width 0.3s ease',
                  }} />
                </div>
                <button
                  className="modal-btn modal-btn-secondary"
                  style={{ marginTop: 12 }}
                  onClick={() => {
                    docxAbortRef.current?.abort();
                    docxAbortRef.current = null;
                    setDocxImporting(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, display: 'block' }}>Document type</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                  {[
                    { value: 'book', label: 'Book / Thesis' },
                    { value: 'report', label: 'Report' },
                    { value: 'journal', label: 'Journal paper' },
                    { value: 'conference', label: 'Conference paper' },
                  ].map((opt) => (
                    <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="docType"
                        value={opt.value}
                        checked={docxDocType === opt.value}
                        onChange={() => setDocxDocType(opt.value)}
                        style={{ accentColor: 'var(--accent)' }}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button className="modal-btn modal-btn-secondary" onClick={() => { setShowDocxDialog(false); setDocxFile(null); }}>Cancel</button>
                  <button className="modal-btn modal-btn-primary" onClick={() => {
                    handleImportDocx(docxFile, { docType: docxDocType });
                  }}>Import</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {showGitHubImport && (
        <div className="modal-overlay" onClick={() => setShowGitHubImport(false)}>
          <div className="modal-card github-import-modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>Import from GitHub</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {ghImportError && (
                <div
                  style={{
                    padding: '8px 12px',
                    background: 'rgba(243,139,168,0.15)',
                    color: '#f38ba8',
                    borderRadius: 'var(--radius)',
                    fontSize: 13,
                  }}
                >
                  {ghImportError}
                </div>
              )}
              <label style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Repository</label>
              <input
                type="text"
                className="auth-input"
                placeholder="owner/repo"
                value={ghImportRepo}
                onChange={(e) => setGhImportRepo(e.target.value)}
              />
              {ghReposLoading && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading your repos...</div>}
              {ghRepos && ghRepos.length > 0 && (
                <>
                  <input
                    type="text"
                    className="auth-input"
                    placeholder="Search your repos..."
                    value={ghRepoSearch}
                    onChange={(e) => setGhRepoSearch(e.target.value)}
                  />
                  <div className="github-import-repo-list">
                    {ghRepos
                      .filter((r) => !ghRepoSearch || r.fullName.toLowerCase().includes(ghRepoSearch.toLowerCase()))
                      .slice(0, 50)
                      .map((r) => (
                        <button
                          key={r.fullName}
                          className={`github-import-repo-item ${ghImportRepo === r.fullName ? 'active' : ''}`}
                          onClick={() => {
                            setGhImportRepo(r.fullName);
                            setGhImportBranch(r.defaultBranch || 'main');
                          }}
                        >
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {r.fullName}
                          </span>
                          {r.private && (
                            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>private</span>
                          )}
                        </button>
                      ))}
                  </div>
                </>
              )}
              <label style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Branch</label>
              <input
                type="text"
                className="auth-input"
                placeholder="main"
                value={ghImportBranch}
                onChange={(e) => setGhImportBranch(e.target.value)}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                <button
                  className="auth-button"
                  style={{ background: 'var(--bg-hover)', color: 'var(--text-primary)' }}
                  onClick={() => setShowGitHubImport(false)}
                >
                  Cancel
                </button>
                <button
                  className="auth-button"
                  onClick={handleGitHubImport}
                  disabled={!ghImportRepo.trim() || ghImportLoading}
                >
                  {ghImportLoading ? 'Importing...' : 'Import'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
