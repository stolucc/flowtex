import { useState, useCallback, useRef } from 'react';
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

  const handleCompile = useCallback(async () => {
    if (!project) return;
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
      get(`/api/compile/${project.id}/generated-files`).then((r) => r.json()).then((d) => setGeneratedFiles(d.files || [])).catch(() => {});
    }
  }, [project, activeFile, handleSave, editorRef]);

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

  return {
    compiling, pdfUrl, setPdfUrl,
    compileLog, setCompileLog,
    consoleOutput, setConsoleOutput,
    lintDiagnostics, setLintDiagnostics,
    generatedFiles, setGeneratedFiles,
    activeGenFile, setActiveGenFile,
    handleCompile, handleDiff,
  };
}
