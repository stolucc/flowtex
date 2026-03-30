import { useState, useCallback, useMemo } from 'react';
import { get, post, put, del } from '../api.js';
import tapsCheck from '../utils/tapsChecker.js';

export default function useEditorActions({
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
}) {
  const [editorLine, setEditorLine] = useState(1);
  const [pdfClickPos, setPdfClickPos] = useState(null);
  const [wordCountState, setWordCountState] = useState({ open: false, loading: false, data: null, error: null });

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
      setConsoleOutput('ACM TAPS Check: All packages are on the approved list. \u2713');
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
      alert('No LaTeX formatter selected. Set one in Project Settings > Editor.');
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
          detail += detail ? ' \u2014 ' + shortTitle : shortTitle;
        }
        keys.push({ label: entryKey, type: 'text', detail, boost: 1 });
      }
    }
    return keys;
  }, [files]);

  return {
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
    mainFilePath,
  };
}
