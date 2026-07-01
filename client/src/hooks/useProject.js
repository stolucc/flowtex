// @ts-check
import { useState, useCallback, useEffect, useRef } from 'react';
import { get, post, put, patch, del } from '../api.js';
import { useAlert } from '../contexts/AlertContext.jsx';
import { buildFileSaveBody } from '../utils/saveBody.js';

/** Extracts the project ID from the current URL pathname. */
function getProjectIdFromUrl() {
  const match = window.location.pathname.match(/^\/project\/([^/]+)/);
  return match ? match[1] : null;
}

/** Extracts the file ID from the current URL query string. */
function getFileIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('file');
}

/**
 * Core project state hook: manages project/file/member data, URL-based routing, and file CRUD operations.
 * @param {any} user - The authenticated user.
 */
export default function useProject(user) {
  const { alert: showAlert } = useAlert();
  const [project, setProject] = useState(/** @type {any} */ (null));
  const [files, setFiles] = useState(/** @type {any[]} */ ([]));
  // Tracks whether the files HTTP response for the current project has
  // arrived. Used by the PDF viewer to avoid flashing "No main file
  // found" during the brief render where project is set but files is
  // still []. Set false on every project change, true once setFiles
  // runs from the load effect.
  const [filesLoaded, setFilesLoaded] = useState(false);
  // Bumping this re-runs the files-load effect without changing project
  // identity — used after unlocking an encrypted project so the now-
  // decryptable content gets re-fetched.
  const [filesReloadKey, setFilesReloadKey] = useState(0);
  // Mirror of `files` for handleSave's cross-file baseVersion lookup —
  // keeping the read-only handle in a ref avoids cascading dep updates
  // through handleSave → handleCompile every time the user types.
  const filesRef = useRef(files);
  filesRef.current = files;
  // Mirror of `project` for async resolvers — lets late-arriving fetches
  // detect a project switch and drop their result instead of overwriting
  // the new project's state.
  /** @type {React.MutableRefObject<any>} */
  const projectRef = useRef(null);
  const [emptyFolders, setEmptyFolders] = useState(/** @type {any[]} */ ([]));
  const [activeFile, setActiveFile] = useState(/** @type {any} */ (null));
  const [members, setMembers] = useState(/** @type {any[]} */ ([]));
  const [newFileCounter, setNewFileCounter] = useState(0);
  const [newFolderCounter, setNewFolderCounter] = useState(0);
  const needsAutoCompile = useRef(false);

  const switchFile = useCallback((/** @type {any} */ f) => {
    setActiveFile(f);
    if (f) {
      const url = new URL(window.location.href);
      url.searchParams.set('file', f.id);
      window.history.replaceState(null, '', url);
    }
  }, []);

  const selectProject = useCallback((/** @type {any} */ p) => {
    setProject(p);
    setFilesLoaded(false);
    needsAutoCompile.current = true;
    window.history.pushState(null, '', `/project/${p.id}`);
  }, []);

  const goBack = useCallback(() => {
    setProject(null);
    setActiveFile(null);
    setFiles([]);
    setFilesLoaded(false);
    setMembers([]);
    window.history.pushState(null, '', '/');
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
          const found = projects.find((/** @type {any} */ p) => p.id === id);
          if (found) setProject(found);
          else window.history.replaceState(null, '', '/');
        });
    }
  }, [user]);

  // Handle browser back/forward
  useEffect(() => {
    const onPopState = () => {
      const id = getProjectIdFromUrl();
      if (!id) {
        setProject(null);
        setActiveFile(null);
        setFiles([]);
        setFilesLoaded(false);
      } else if (project?.id !== id) {
        setFilesLoaded(false);
        get('/api/projects')
          .then((r) => r.json())
          .then((projects) => {
            const found = projects.find((/** @type {any} */ p) => p.id === id);
            if (found) setProject(found);
          });
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [project]);

  // Keep projectRef synced with current project so the async file-load
  // resolver (and any future late-arriving fetcher) can compare against
  // the latest value rather than the value captured when the effect
  // started.
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  // Load project files
  useEffect(() => {
    if (!project) return;
    // Capture the project id we're loading for so a late response from a
    // previous project doesn't overwrite the new one (the user can switch
    // projects faster than the HTTP call resolves).
    const loadingProjectId = project.id;
    get(`/api/projects/${project.id}/files`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} loading files for ${loadingProjectId}`);
        const loadedFiles = await r.json();
        if (!Array.isArray(loadedFiles)) {
          throw new Error('files response was not an array');
        }
        // Drop the result if the user has since switched projects.
        if (projectRef.current?.id !== loadingProjectId) return;
        setFiles(loadedFiles);
        setFilesLoaded(true);
        if (loadedFiles.length > 0 && !activeFile) {
          const fileId = getFileIdFromUrl();
          const target = fileId && loadedFiles.find((/** @type {any} */ f) => f.id === fileId);
          if (target) {
            setActiveFile(target);
          } else {
            const mainName = project.main_file || 'main.tex';
            const mainFile = loadedFiles.find((/** @type {any} */ f) => f.path === mainName);
            setActiveFile(mainFile || loadedFiles[0]);
          }
        }
      })
      .catch((err) => {
        // Visible error: log with context so a future "files are gone"
        // report has something to attach. Also flip filesLoaded so the
        // UI doesn't sit forever in the suppress-banner load state.
        console.error('Failed to load files for project', loadingProjectId, err);
        if (projectRef.current?.id === loadingProjectId) {
          setFilesLoaded(true);
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, filesReloadKey]);

  // Load explicit empty folders for the project. Folders that contain files
  // already show up via the file tree's path-derived nodes; this list only
  // adds the empty ones the user created but hasn't put anything into yet.
  useEffect(() => {
    if (!project) {
      setEmptyFolders([]);
      return;
    }
    get(`/api/projects/${project.id}/folders`)
      .then((r) => r.json())
      .then((rows) => setEmptyFolders(Array.isArray(rows) ? rows : []))
      .catch(() => setEmptyFolders([]));
  }, [project]);

  // Load members when project changes, and whenever the server signals a
  // membership change (e.g. someone accepted an invite / was removed) —
  // so @-mention autocomplete and avatar list refresh without a reload.
  useEffect(() => {
    if (!project) {
      setMembers([]);
      return;
    }
    const refresh = () =>
      get(`/api/projects/${project.id}/members`)
        .then((r) => r.json())
        .then((data) => setMembers(Array.isArray(data) ? data : []))
        .catch(() => setMembers([]));
    refresh();
    const onMembersUpdate = () => refresh();
    window.addEventListener('ws:members-update', onMembersUpdate);
    return () => window.removeEventListener('ws:members-update', onMembersUpdate);
  }, [project]);

  // Mirror other users' folder ops into our local emptyFolders / files
  // state so the tree reflects them without a page reload. Files state
  // is also rewritten for delete/rename because those endpoints affect
  // file paths server-side.
  useEffect(() => {
    const handler = (/** @type {any} */ e) => {
      const msg = e.detail || {};
      if (msg.type === 'folder-create') {
        if (typeof msg.path !== 'string' || !msg.path) return;
        setEmptyFolders((prev) => (prev.includes(msg.path) ? prev : [...prev, msg.path]));
      } else if (msg.type === 'folder-delete') {
        const path = msg.path;
        if (typeof path !== 'string' || !path) return;
        setEmptyFolders((prev) => prev.filter((p) => p !== path && !p.startsWith(path + '/')));
        setFiles((fs) => fs.filter((f) => f.path !== path && !f.path.startsWith(path + '/')));
      } else if (msg.type === 'folder-rename') {
        const oldP = msg.oldPath;
        const newP = msg.newPath;
        if (typeof oldP !== 'string' || typeof newP !== 'string') return;
        setEmptyFolders((prev) =>
          prev.map((p) => (p === oldP || p.startsWith(oldP + '/') ? newP + p.slice(oldP.length) : p)),
        );
        setFiles((fs) =>
          fs.map((f) =>
            f.path === oldP || f.path.startsWith(oldP + '/')
              ? { ...f, path: newP + f.path.slice(oldP.length) }
              : f,
          ),
        );
      }
    };
    window.addEventListener('ws:folder', handler);
    return () => window.removeEventListener('ws:folder', handler);
  }, []);

  // File operations
  const handleSave = useCallback(
    /**
     * @param {string | undefined} content  undefined = marks-only save (Y.js owns the text)
     * @param {string} [fileId]
     * @param {any[]} [tcMarks]
     */
    async (content, fileId, tcMarks) => {
      // Caller may pass an explicit fileId. The editor *must* do this for
      // debounced saves and file-switch flushes — otherwise this falls back
      // to whichever file is *currently* active, which can race the user's
      // file switch and save the old file's text to the new file's id.
      const targetId = fileId ?? activeFile?.id;
      if (!targetId) return;
      // V2-3: include baseVersion so the server can detect stale saves.
      // Look up the file's current updated_at from the in-memory list —
      // when the caller passes an explicit fileId that's NOT the active
      // file (the documented hot path: debounced save / file-switch
      // flush), we need to find it in `files` instead of falling through
      // to undefined and silently losing conflict detection.
      const target = activeFile?.id === targetId ? activeFile : filesRef.current.find((/** @type {any} */ f) => f.id === targetId);
      const baseVersion = target?.updated_at ?? undefined;
      // The send/skip decision (incl. the Y.js marks-only handling where
      // content === undefined) is pure logic in buildFileSaveBody so it
      // can be mutation-tested without a React render.
      const { skip, contentless, body } = buildFileSaveBody({ content, tcMarks, baseVersion });
      if (skip) return;
      const res = await put(`/api/projects/files/${targetId}`, body);
      if (res.status === 409) {
        // Stale save — somebody else (or a different tab) wrote to this
        // file between our load and this PUT. Don't try to merge; surface
        // the conflict so the caller can refetch / warn the user.
         
        console.warn('[useProject] save conflict on', targetId, '— file changed remotely');
        return;
      }
      let nextVersion = baseVersion;
      try {
        const data = await res.json();
        if (data?.version) nextVersion = data.version;
      } catch {
        // Body wasn't JSON; keep baseVersion as-is.
      }
      setActiveFile((/** @type {any} */ f) =>
        f?.id === targetId
          ? {
              ...f,
              ...(contentless ? {} : { content }),
              ...(tcMarks ? { tc_marks: tcMarks } : {}),
              ...(nextVersion ? { updated_at: nextVersion } : {}),
            }
          : f,
      );
      setFiles((fs) =>
        fs.map((/** @type {any} */ f) =>
          f.id === targetId
            ? {
                ...f,
                ...(contentless ? {} : { content }),
                ...(tcMarks ? { tc_marks: tcMarks } : {}),
                ...(nextVersion ? { updated_at: nextVersion } : {}),
              }
            : f,
        ),
      );
    },
    [activeFile],
  );

  // Update a file's in-memory `content` WITHOUT a server write. Under Y.js
  // the HTTP autosave is marks-only, so `files[].content` would otherwise
  // stay frozen at its project-load value while the real text lives in the
  // Y.Doc. That stale copy is what the editor mounts from on a file switch
  // (a brief flash of old text before the Y.Text reconcile) and what
  // client-side global search reads. The editor calls this (debounced + on
  // file-switch flush) so the in-memory copy tracks the canonical text.
  const setLocalContent = useCallback(
    (/** @type {string} */ fileId, /** @type {string} */ content) => {
      if (!fileId || typeof content !== 'string') return;
      setActiveFile((/** @type {any} */ f) => (f?.id === fileId ? { ...f, content } : f));
      setFiles((fs) => fs.map((/** @type {any} */ f) => (f.id === fileId ? { ...f, content } : f)));
    },
    [setActiveFile, setFiles],
  );

  const handleCreateFile = useCallback(
    async (/** @type {string} */ filePath, /** @type {string} */ content) => {
      if (!project) return;
      const res = await post(`/api/projects/${project.id}/files`, { path: filePath, content });
      const file = await res.json();
      setFiles((fs) => [...fs, file]);
      switchFile(file);
    },
    [project, switchFile],
  );

  const handleDeleteFile = useCallback(
    async (/** @type {string} */ fileId) => {
      await del(`/api/projects/files/${fileId}`);
      setFiles((fs) => {
        const remaining = fs.filter((/** @type {any} */ f) => f.id !== fileId);
        if (activeFile?.id === fileId) {
          switchFile(remaining[0] || null);
        }
        return remaining;
      });
    },
    [activeFile, switchFile],
  );

  const handleRenameFile = useCallback(
    async (/** @type {string} */ fileId, /** @type {string} */ newPath) => {
      const old = files.find((/** @type {any} */ f) => f.id === fileId);
      await patch(`/api/projects/files/${fileId}`, { path: newPath });
      setFiles((fs) => fs.map((/** @type {any} */ f) => (f.id === fileId ? { ...f, path: newPath } : f)));
      // Editor header reads activeFile.path directly; if the renamed file is the
      // open one, update activeFile too so the header reflects the new name.
      setActiveFile((/** @type {any} */ f) => (f?.id === fileId ? { ...f, path: newPath } : f));
      // If we just renamed the project's main file, follow the rename in client
      // state too. The server-side rename does the same DB update, so this keeps
      // the two in sync without a refetch.
      if (old && project && project.main_file === old.path) {
        setProject((/** @type {any} */ p) => (p ? { ...p, main_file: newPath } : p));
      }
    },
    [files, project],
  );

  const handleRenameFolder = useCallback(
    async (/** @type {string} */ oldPrefix, /** @type {string} */ newPrefix) => {
      if (!project) return;
      // Single atomic server call: rewrites every file path under the
      // prefix AND every explicit folder row, plus main_file if it's
      // affected. Replaces the previous per-file PATCH loop.
      const res = await patch(`/api/projects/${project.id}/folders`, {
        oldPath: oldPrefix,
        newPath: newPrefix,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showAlert(data.error || 'Rename failed', { title: 'Rename folder' });
        return;
      }
      setFiles((fs) =>
        fs.map((/** @type {any} */ f) => {
          if (f.path === oldPrefix || f.path.startsWith(oldPrefix + '/')) {
            return { ...f, path: newPrefix + f.path.slice(oldPrefix.length) };
          }
          return f;
        }),
      );
      setEmptyFolders((/** @type {string[]} */ prev) =>
        prev.map((/** @type {string} */ p) => {
          if (p === oldPrefix || p.startsWith(oldPrefix + '/')) {
            return newPrefix + p.slice(oldPrefix.length);
          }
          return p;
        }),
      );
      setActiveFile((/** @type {any} */ f) => {
        if (!f) return f;
        if (f.path === oldPrefix || f.path.startsWith(oldPrefix + '/')) {
          return { ...f, path: newPrefix + f.path.slice(oldPrefix.length) };
        }
        return f;
      });
      // Folder rename can move the main file along with everything else.
      if (project.main_file && (project.main_file === oldPrefix || project.main_file.startsWith(oldPrefix + '/'))) {
        const newMain = newPrefix + project.main_file.slice(oldPrefix.length);
        setProject((/** @type {any} */ p) => (p ? { ...p, main_file: newMain } : p));
      }
    },
    [project, showAlert],
  );

  const handleDeleteFolder = useCallback(
    async (/** @type {string} */ folderPath) => {
      if (!project) return;
      // Single server call: deletes all files under the prefix AND any
      // explicit folder rows for the same prefix, atomically.
      await del(`/api/projects/${project.id}/folders`, { path: folderPath });
      setFiles((fs) => {
        const remaining = fs.filter(
          (/** @type {any} */ f) => f.path !== folderPath && !f.path.startsWith(folderPath + '/'),
        );
        if (
          activeFile &&
          (activeFile.path === folderPath || activeFile.path.startsWith(folderPath + '/'))
        ) {
          switchFile(remaining[0] || null);
        }
        return remaining;
      });
      setEmptyFolders((prev) =>
        prev.filter((/** @type {string} */ p) => p !== folderPath && !p.startsWith(folderPath + '/')),
      );
    },
    [project, activeFile, switchFile],
  );

  const handleCreateFolder = useCallback(
    async (/** @type {string} */ folderPath) => {
      if (!project) return;
      const trimmed = (folderPath || '').trim();
      if (!trimmed) return;
      const res = await post(`/api/projects/${project.id}/folders`, { path: trimmed });
      if (!res.ok) return;
      const data = await res.json().catch(() => ({ path: trimmed }));
      const stored = data.path || trimmed;
      setEmptyFolders((prev) => (prev.includes(stored) ? prev : [...prev, stored]));
    },
    [project],
  );

  const handleSetMainFile = useCallback(
    async (/** @type {string} */ filePath) => {
      if (!project) return;
      // Verify the PATCH actually persisted before flipping local state.
      // The previous version updated optimistically and swallowed errors,
      // which made auth/validation failures invisible: the file tree said
      // "main" until the next hard refresh, then quietly snapped back to
      // the server's actual value. Surface the error instead.
      const res = await patch(`/api/projects/${project.id}`, { main_file: filePath });
      if (!res.ok) {
        let msg = 'Failed to set main file';
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch { /* keep default */ }
        throw new Error(msg);
      }
      setProject((/** @type {any} */ p) => ({ ...p, main_file: filePath }));
    },
    [project],
  );

  return {
    project,
    setProject,
    files,
    setFiles,
    filesLoaded,
    reloadFiles: () => setFilesReloadKey((k) => k + 1),
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
    goBack,
    handleSave,
    setLocalContent,
    handleCreateFile,
    handleDeleteFile,
    handleRenameFile,
    handleRenameFolder,
    handleDeleteFolder,
    handleCreateFolder,
    handleSetMainFile,
    emptyFolders,
    setEmptyFolders,
  };
}
