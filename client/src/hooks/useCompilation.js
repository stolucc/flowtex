import { useState, useCallback, useRef, useEffect } from 'react';
import { get, post } from '../api.js';
import { getSetting } from '../utils/settings.js';

/**
 * Handles LaTeX compilation lifecycle: streaming compile output, PDF URL management, linting, and diff compilation.
 * @param {object|null} project - The current project.
 * @param {object|null} activeFile - The currently active file.
 * @param {Function} handleSave - Saves the current editor content before compiling.
 * @param {import('react').RefObject} editorRef - Ref to the editor instance.
 */
export default function useCompilation(project, activeFile, handleSave, editorRef, { showTrackedChanges } = {}) {
  const [compiling, setCompiling] = useState(false);
  const [pdfUrl, setPdfUrl] = useState(null);
  const [compileLog, setCompileLog] = useState('');
  const [consoleOutput, setConsoleOutput] = useState('');
  const [lintDiagnostics, setLintDiagnostics] = useState([]);
  const [generatedFiles, setGeneratedFiles] = useState([]);
  const [activeGenFile, setActiveGenFile] = useState(null);
  const compileSourceRef = useRef(null);
  const compilingRef = useRef(false);

  // Keep ref in sync with state so callbacks can read current value
  useEffect(() => {
    compilingRef.current = compiling;
  }, [compiling]);

  // Invalidate cached PDF when tracked-changes toggle changes so user must recompile
  const tcRef = useRef(showTrackedChanges);
  useEffect(() => {
    if (tcRef.current !== showTrackedChanges) {
      tcRef.current = showTrackedChanges;
      setPdfUrl(null);
    }
  }, [showTrackedChanges]);

  // Wipe all compile-derived state when the project changes. This hook
  // is mounted once at App level and persists across project switches —
  // without this reset, switching from project A to B would keep showing
  // As last-compiled PDF (and its lint diagnostics, console output, and
  // generated-files list) in Bs editor view until the user re-compiled.
  // That was the source of the "PDF shows text from a different project,
  // hard refresh fixes it" bug.
  const projectIdRef = useRef(project?.id ?? null);
  useEffect(() => {
    const newId = project?.id ?? null;
    if (projectIdRef.current !== newId) {
      projectIdRef.current = newId;
      setPdfUrl(null);
      setCompileLog('');
      setConsoleOutput('');
      setLintDiagnostics([]);
      setGeneratedFiles([]);
      setActiveGenFile(null);
      // Cancel any in-flight compile stream from the previous project so
      // its `done` event cant land here and resurrect the stale PDF.
      if (compileSourceRef.current) {
        compileSourceRef.current.close();
        compileSourceRef.current = null;
      }
      setCompiling(false);
    }
  }, [project?.id]);

  // Clean up EventSource on unmount
  useEffect(() => {
    return () => {
      if (compileSourceRef.current) {
        compileSourceRef.current.close();
        compileSourceRef.current = null;
      }
    };
  }, []);

  const handleCompile = useCallback(async () => {
    if (!project) return;
    // Prevent double-compile
    if (compilingRef.current) return;

    // Snapshot the file we're saving for so the post-compile lint targets the same file,
    // even if the user switches files during the compile stream.
    const fileAtStart = activeFile;
    if (fileAtStart) {
      const currentContent = editorRef.current?.getContent();
      if (currentContent != null) {
        // Marks must ride along with content. Without them the server
        // compiles fresh content against stale tc_marks from the DB —
        // stripPendingDeletions then cuts ranges based on stale positions
        // and can lop the closing `}` off a just-typed `\section{...}`,
        // surfacing as "File ended while scanning use of \@xdblarg".
        const currentMarks = editorRef.current?.getTcMarks?.() ?? [];
        await handleSave(currentContent, fileAtStart.id, currentMarks);
      }
    }
    setCompiling(true);
    setConsoleOutput('');

    if (compileSourceRef.current) {
      compileSourceRef.current.close();
      compileSourceRef.current = null;
    }

    try {
      const tcParam = showTrackedChanges ? '?showTrackedChanges=1' : '';
      const evtSource = new EventSource(`/api/compile/${project.id}/compile-stream${tcParam}`);
      compileSourceRef.current = evtSource;

      // Each handler below guards `compileSourceRef.current !== evtSource`: if
      // the user (re)triggered another compile mid-stream, this EventSource is
      // superseded and any late events from it must NOT update UI state, or we'd
      // overwrite the new compile's output/PDF with stale data.
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
    }
    setCompiling(false);
    if (project) {
      get(`/api/compile/${project.id}/generated-files`)
        .then((r) => r.json())
        .then((d) => setGeneratedFiles(d.files || []))
        .catch((e) => console.warn('Failed to load generated files:', e));

      // Run server-side linter (ChkTeX/lacheck) after compile.
      // Use fileAtStart (the file we compiled for) instead of activeFile, which may have
      // moved on if the user switched files mid-compile.
      const serverLinter = getSetting(`server-linter-${project.id}`) || '';
      if (serverLinter && fileAtStart?.path?.endsWith('.tex')) {
        // Read content from the editor only if it's still showing the same file; otherwise
        // fall back to the file's last-known content from the props snapshot.
        const editorContent =
          activeFile?.id === fileAtStart.id ? editorRef.current?.getContent() : null;
        const content = editorContent ?? fileAtStart.content;
        if (content) {
          post(`/api/compile/${project.id}/lint`, { content, filename: fileAtStart.path, linter: serverLinter })
            .then((r) => r.json())
            .then((data) => {
              setLintDiagnostics((data.diagnostics || []).map((d) => ({ ...d, source: serverLinter })));
            })
            .catch((e) => console.warn('Server lint error:', e));
        }
      } else {
        setLintDiagnostics([]);
      }
    }
  }, [project, activeFile, handleSave, editorRef, showTrackedChanges]);

  const handleDiff = useCallback(
    (oldFileId, newFileId) => {
      if (!project) return;
      if (compilingRef.current) return;
      setCompiling(true);
      setConsoleOutput('');

      if (compileSourceRef.current) {
        compileSourceRef.current.close();
        compileSourceRef.current = null;
      }

      const evtSource = new EventSource(
        `/api/compile/${project.id}/diff-stream?oldFileId=${encodeURIComponent(oldFileId)}&newFileId=${encodeURIComponent(newFileId)}`,
      );
      compileSourceRef.current = evtSource;

      // Same staleness guard pattern as handleCompile: if a newer compile/diff
      // replaced this EventSource, ignore its late events so we don't apply
      // them to the newer compile's state.
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
        }
        evtSource.close();
        compileSourceRef.current = null;
        setCompiling(false);
      });

      evtSource.onerror = () => {
        if (compileSourceRef.current !== evtSource) return;
        evtSource.close();
        compileSourceRef.current = null;
        setCompiling(false);
      };
    },
    [project],
  );

  const handleStopCompile = useCallback(async () => {
    if (!project) return;
    // Close the EventSource first to prevent auto-reconnect
    if (compileSourceRef.current) {
      compileSourceRef.current.close();
      compileSourceRef.current = null;
    }
    setCompiling(false);
    setConsoleOutput((prev) => prev + '\n--- Compilation stopped ---\n');
    try {
      await post(`/api/compile/${project.id}/stop`);
    } catch {}
  }, [project]);

  return {
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
  };
}
