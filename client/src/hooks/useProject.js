import { useState, useCallback, useEffect, useRef } from 'react';
import { get, post, put, patch, del } from '../api.js';

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
 * @param {object|null} user - The authenticated user.
 */
export default function useProject(user) {
  const [project, setProject] = useState(null);
  const [files, setFiles] = useState([]);
  const [activeFile, setActiveFile] = useState(null);
  const [members, setMembers] = useState([]);
  const [newFileCounter, setNewFileCounter] = useState(0);
  const [newFolderCounter, setNewFolderCounter] = useState(0);
  const needsAutoCompile = useRef(false);

  const switchFile = useCallback((f) => {
    setActiveFile(f);
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
          const found = projects.find((p) => p.id === id);
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
      });
  }, [project]);

  // Load members when project changes
  useEffect(() => {
    if (!project) {
      setMembers([]);
      return;
    }
    get(`/api/projects/${project.id}/members`)
      .then((r) => r.json())
      .then((data) => setMembers(Array.isArray(data) ? data : []))
      .catch(() => setMembers([]));
  }, [project]);

  // File operations
  const handleSave = useCallback(
    async (content, tcPositions) => {
      const file = activeFile;
      if (!file) return;
      const body = { content };
      if (Array.isArray(tcPositions) && tcPositions.length > 0) body.tcPositions = tcPositions;
      await put(`/api/projects/files/${file.id}`, body);
      setActiveFile((f) => (f?.id === file.id ? { ...f, content } : f));
      setFiles((fs) => fs.map((f) => (f.id === file.id ? { ...f, content } : f)));
    },
    [activeFile],
  );

  const handleCreateFile = useCallback(
    async (filePath, content) => {
      if (!project) return;
      const res = await post(`/api/projects/${project.id}/files`, { path: filePath, content });
      const file = await res.json();
      setFiles((fs) => [...fs, file]);
      switchFile(file);
    },
    [project, switchFile],
  );

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
    [activeFile, switchFile],
  );

  const handleRenameFile = useCallback(async (fileId, newPath) => {
    await patch(`/api/projects/files/${fileId}`, { path: newPath });
    setFiles((fs) => fs.map((f) => (f.id === fileId ? { ...f, path: newPath } : f)));
  }, []);

  const handleRenameFolder = useCallback(
    async (oldPrefix, newPrefix) => {
      const toRename = files.filter((f) => f.path === oldPrefix || f.path.startsWith(oldPrefix + '/'));
      for (const f of toRename) {
        const newPath = newPrefix + f.path.slice(oldPrefix.length);
        await patch(`/api/projects/files/${f.id}`, { path: newPath });
      }
      setFiles((fs) =>
        fs.map((f) => {
          if (f.path === oldPrefix || f.path.startsWith(oldPrefix + '/')) {
            return { ...f, path: newPrefix + f.path.slice(oldPrefix.length) };
          }
          return f;
        }),
      );
    },
    [files],
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
    [files, activeFile, switchFile],
  );

  const handleSetMainFile = useCallback(
    async (filePath) => {
      if (!project) return;
      await patch(`/api/projects/${project.id}`, { main_file: filePath });
      setProject((p) => ({ ...p, main_file: filePath }));
    },
    [project],
  );

  return {
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
    goBack,
    handleSave,
    handleCreateFile,
    handleDeleteFile,
    handleRenameFile,
    handleRenameFolder,
    handleDeleteFolder,
    handleSetMainFile,
  };
}
