// @ts-check
import { useState, useCallback, useMemo } from 'react';
import { get, post, put } from '../api.js';
import tapsCheck from '../utils/tapsChecker.js';
import { getSetting } from '../utils/settings.js';

/** Provides editor-level actions: SyncTeX, word count, formatting, TAPS checks, and citation/label autocomplete data.
 *  @param {any} props
 */
export default function useEditorActions({
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
  setProject,
  handleCompile,
  handleStopCompile,
  showTrackedChangesInPdf = false,
}) {
  const [editorLine, setEditorLine] = useState(1);
  const [pdfClickPos, setPdfClickPos] = useState(/** @type {any} */ (null));
  /** @type {[any, React.Dispatch<any>]} */
  const [wordCountState, setWordCountState] = useState(/** @type {any} */ ({ open: false, loading: false, data: null, error: null }));
  const [formatWarning, setFormatWarning] = useState(/** @type {any} */ (null));

  const handleOverwriteFile = useCallback(
    async (/** @type {string} */ fileId, /** @type {string} */ content) => {
      await put(`/api/projects/files/${fileId}`, { content });
      setFiles((/** @type {any[]} */ fs) => fs.map((/** @type {any} */ f) => (f.id === fileId ? { ...f, content } : f)));
      const file = files.find((/** @type {any} */ f) => f.id === fileId);
      if (file) switchFile({ ...file, content });
      // Trigger recompile since file content changed on the server
      handleCompile?.();
    },
    [files, switchFile, handleCompile, setFiles],
  );

  // tc query selects which sibling .synctex.gz the server reads — the
  // viewer might be showing the plain or the _tc PDF and forward/inverse
  // sync must point at the matching one.
  const tcQuery = showTrackedChangesInPdf ? '&tc=1' : '';

  const handleSyncForward = useCallback(async () => {
    if (!project || !activeFile || !pdfUrl) return;
    try {
      const res = await get(
        `/api/compile/${project.id}/syncforward?line=${editorLine}&column=0&file=${encodeURIComponent(activeFile.path)}${tcQuery}`,
      );
      if (res.ok) {
        const data = await res.json();
        pdfRef.current?.scrollToPosition(data.page, data.v);
      }
    } catch {}
  }, [project, activeFile, pdfUrl, editorLine, pdfRef, tcQuery]);

  const handleSyncInverse = useCallback(
    async (/** @type {number} */ page, /** @type {number} */ x, /** @type {number} */ y) => {
      if (!project) return;
      try {
        const res = await get(`/api/compile/${project.id}/syncinverse?page=${page}&x=${x}&y=${y}${tcQuery}`);
        if (res.ok) {
          const data = await res.json();
          if (data.file && data.file !== activeFile?.path) {
            const f = files.find((/** @type {any} */ f) => f.path === data.file);
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
    [project, activeFile, files, switchFile, editorRef, tcQuery],
  );

  const handleSyncInverseFromArrow = useCallback(async () => {
    if (!pdfClickPos || !project) return;
    await handleSyncInverse(pdfClickPos.page, pdfClickPos.x, pdfClickPos.y);
  }, [pdfClickPos, project, handleSyncInverse]);

  const goBack = useCallback(() => {
    // Abort any in-flight compile so the server frees its latexmk slot and
    // the user's compile rate-limit isn't held by an abandoned project.
    handleStopCompile?.().catch(() => {});
    projectGoBack();
    setPdfUrl(null);
    setComments([]);
  }, [projectGoBack, setPdfUrl, setComments, handleStopCompile]);

  const handleLogoutFull = useCallback(async () => {
    await handleLogout();
    setProject(null);
    setFiles([]);
    setActiveFile(null);
    setPdfUrl(null);
  }, [handleLogout, setProject, setFiles, setActiveFile, setPdfUrl]);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, setConsoleOutput]);

  const handleFormatDocument = useCallback(async () => {
    const formatter = getSetting('latex-formatter');
    if (!formatter) {
      setFormatWarning('No LaTeX formatter selected. Set one in Project Settings > Editor.');
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
      setConsoleOutput(`Format error: ${err instanceof Error ? err.message : err}`);
    }
  }, [activeFile, editorRef, setConsoleOutput]);

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
      setWordCountState({ open: true, loading: false, data: null, error: e instanceof Error ? e.message : String(e) });
    }
  }, [project?.id]);

  const citeKeys = useMemo(() => {
    const bibFiles = files.filter((/** @type {any} */ f) => f.path.endsWith('.bib') && f.content);
    /** @type {any[]} */
    const keys = [];
    const entryPattern = /@\w+\s*\{\s*([\w:.@/+-]+)/g;
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

  const labelKeys = useMemo(() => {
    // Build a path → file map for fast lookup
    /** @type {Map<string, any>} */
    const fileMap = new Map(files.map((/** @type {any} */ f) => [f.path, f]));

    // Resolve a relative \input/\include path against the directory of the current file
    /**
     * @param {any} currentPath
     * @param {any} included
     */
    function resolvePath(currentPath, included) {
      const dir = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/') + 1) : '';
      const resolved = dir + included;
      // Try as-is, then with .tex extension appended
      return fileMap.has(resolved) ? resolved : fileMap.has(resolved + '.tex') ? resolved + '.tex' : null;
    }

    // Walk the include tree starting from mainFilePath, collect labels in order
    /** @type {Set<string>} */
    const visitedFiles = new Set();
    /** @type {any[]} */
    const orderedFiles = [];

    /**
     * @param {any} filePath
     */
    function walk(filePath) {
      if (visitedFiles.has(filePath)) return;
      visitedFiles.add(filePath);
      const f = fileMap.get(filePath);
      if (!f?.content) return;
      orderedFiles.push(f);
      // Find all \input{} and \include{} commands (skip commented lines)
      const includePattern = /^[^%\n]*\\(?:input|include|subfile|subfileinclude)\{([^}]+)\}/gm;
      let m;
      while ((m = includePattern.exec(f.content)) !== null) {
        const resolved = resolvePath(filePath, m[1].trim());
        if (resolved) walk(resolved);
      }
    }

    walk(mainFilePath);

    // Extract labels from the ordered file set
    /** @type {any[]} */
    const keys = [];
    /** @type {Set<string>} */
    const seenLabels = new Set();
    const labelPattern = /\\label\{([^}]+)\}/g;

    for (const f of orderedFiles) {
      labelPattern.lastIndex = 0;
      let match;
      while ((match = labelPattern.exec(f.content)) !== null) {
        const key = match[1];
        if (seenLabels.has(key)) continue;
        seenLabels.add(key);
        // Extract nearby context: caption or section heading near the label
        const nearby = f.content.slice(Math.max(0, match.index - 300), match.index + match[0].length + 200);
        let detail = '';
        const captionMatch = nearby.match(/\\caption\{([^}]{1,60})/);
        const sectionMatch = nearby.match(/\\(?:section|subsection|subsubsection|chapter|paragraph)\{([^}]{1,60})/);
        if (captionMatch) detail = captionMatch[1].trim();
        else if (sectionMatch) detail = sectionMatch[1].trim();
        // Prefix by type
        if (key.startsWith('fig:')) detail = detail ? 'Fig: ' + detail : 'Figure';
        else if (key.startsWith('tab:')) detail = detail ? 'Table: ' + detail : 'Table';
        else if (key.startsWith('sec:')) detail = detail ? 'Sec: ' + detail : 'Section';
        else if (key.startsWith('eq:')) detail = detail ? 'Eq: ' + detail : 'Equation';
        else if (key.startsWith('lst:')) detail = detail ? 'Listing: ' + detail : 'Listing';
        else if (key.startsWith('alg:')) detail = detail ? 'Alg: ' + detail : 'Algorithm';
        else if (key.startsWith('ch:')) detail = detail ? 'Ch: ' + detail : 'Chapter';
        else if (key.startsWith('thm:')) detail = detail ? 'Thm: ' + detail : 'Theorem';
        else if (key.startsWith('lem:')) detail = detail ? 'Lem: ' + detail : 'Lemma';
        else if (key.startsWith('def:')) detail = detail ? 'Def: ' + detail : 'Definition';
        keys.push({ label: key, type: 'text', detail, boost: 1 });
      }
    }
    return keys;
  }, [files, mainFilePath]);

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
    formatWarning,
    setFormatWarning,
    handleWordCount,
    citeKeys,
    labelKeys,
    mainFilePath,
  };
}
