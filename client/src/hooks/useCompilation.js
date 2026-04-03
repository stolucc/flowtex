import { useState, useCallback, useRef, useEffect } from 'react';
import { get, post } from '../api.js';

export default function useCompilation(project, activeFile, handleSave, editorRef) {
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

    if (activeFile) {
      const currentContent = editorRef.current?.getContent();
      if (currentContent != null) {
        await handleSave(currentContent);
      }
    }
    setCompiling(true);
    setConsoleOutput('');

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
        .catch(() => {});

      // Run server-side linter (ChkTeX/lacheck) after compile
      const serverLinter = localStorage.getItem(`flowtex-server-linter-${project.id}`) || '';
      if (serverLinter && activeFile?.path?.endsWith('.tex')) {
        const content = editorRef.current?.getContent();
        if (content) {
          post(`/api/compile/${project.id}/lint`, { content, filename: activeFile.path, linter: serverLinter })
            .then((r) => r.json())
            .then((data) => {
              setLintDiagnostics((data.diagnostics || []).map((d) => ({ ...d, source: serverLinter })));
            })
            .catch(() => {});
        }
      } else {
        setLintDiagnostics([]);
      }
    }
  }, [project, activeFile, handleSave, editorRef]);

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
