// @ts-check
import { useState, useCallback, useRef, useEffect } from 'react';
import { get, post } from '../api.js';
import { getSetting } from '../utils/settings.js';
import { resolveCompileLocation } from '../utils/compileLocation.js';
import { compileLocal } from '../utils/helperBridge.js';
import {
  wrapPendingChangesAsMacros,
  injectTcMacros,
  stripPendingDeletions,
} from '@shared/trackedChanges.js';

/**
 * Handles LaTeX compilation lifecycle: streaming compile output, PDF URL management, linting, and diff compilation.
 * @param {any} project - The current project.
 * @param {any} activeFile - The currently active file.
 * @param {Function} handleSave - Saves the current editor content before compiling.
 * @param {import('react').RefObject<any>} editorRef - Ref to the editor instance.
 * @param {object} [opts]
 * @param {boolean} [opts.showTrackedChanges]
 * @param {any} [opts.user] - Current user, for compileLocation resolution.
 * @param {any} [opts.helperStatus] - Local helper status, for compileLocation resolution.
 * @param {any[]} [opts.files] - The full project files array. Required for the local-compile
 *                                path so the helper can write source to disk; ignored on the
 *                                server path (server pulls fresh from PostgreSQL).
 */
export default function useCompilation(project, activeFile, handleSave, editorRef, { showTrackedChanges, user, helperStatus, files } = {}) {
  // Resolved compile choice for this render. Used by the compile button
  // label and by handleCompile to pick a code path. Re-resolved every
  // render so settings changes or a freshly-available helper take effect
  // on the next compile without a manual refresh.
  const compileChoice = resolveCompileLocation(project, user, helperStatus || { available: false });
  const [compiling, setCompiling] = useState(false);
  const [pdfUrl, setPdfUrl] = useState(/** @type {any} */ (null));
  const [compileLog, setCompileLog] = useState('');
  const [compileProfile, setCompileProfile] = useState(/** @type {any} */ (null));
  const [rebuildReason, setRebuildReason] = useState(/** @type {any} */ (null));
  const [consoleOutput, setConsoleOutput] = useState('');
  const [lintDiagnostics, setLintDiagnostics] = useState(/** @type {any[]} */ ([]));
  const [generatedFiles, setGeneratedFiles] = useState(/** @type {any[]} */ ([]));
  const [activeGenFile, setActiveGenFile] = useState(/** @type {any} */ (null));
  /** @type {React.MutableRefObject<EventSource | null>} */
  const compileSourceRef = useRef(null);
  const compilingRef = useRef(false);

  // Keep ref in sync with state so callbacks can read current value
  useEffect(() => {
    compilingRef.current = compiling;
  }, [compiling]);

  // Tracked-changes view is compiled to a sibling jobname server-side
  // (jobname_tc.pdf), so each mode has its own PDF + skip-rebuild cache
  // on disk. Toggling between modes only needs to swap the URL — if a
  // previous compile in the target mode exists, the browser fetches its
  // PDF immediately; if not, the PdfViewer surfaces "PDF not found —
  // compile first" and the user can hit the Compile button. Previously
  // we wiped pdfUrl on every toggle, which forced a recompile even when
  // toggling OFF back to a known-good plain PDF.
  const tcRef = useRef(showTrackedChanges);
  useEffect(() => {
    if (tcRef.current !== showTrackedChanges) {
      tcRef.current = showTrackedChanges;
      if (!project) {
        setPdfUrl(null);
        return;
      }
      // Switch to the new mode's PDF URL. The ?tc=1/0 selects which
      // sibling file the /pdf endpoint serves; ?t= busts the browser
      // cache so we re-fetch from disk.
      const tcParam = showTrackedChanges ? '1' : '0';
      setPdfUrl(`/api/compile/${project.id}/pdf?tc=${tcParam}&t=${Date.now()}`);
    }
  }, [showTrackedChanges, project]);

  // Wipe all compile-derived state when the project changes. This hook
  // is mounted once at App level and persists across project switches —
  // without this reset, switching from project A to B would keep showing
  // As last-compiled PDF (and its lint diagnostics, console output, and
  // generated-files list) in Bs editor view until the user re-compiled.
  // That was the source of the "PDF shows text from a different project,
  // hard refresh fixes it" bug.
  // Also wipe on main_file change: the cached PDF was compiled from
  // the previous main file, so leaving it around when the user switches
  // root document would show the wrong document next to the new editor.
  const compileScopeRef = useRef({ id: project?.id ?? null, mainFile: project?.main_file ?? null });
  useEffect(() => {
    const newId = project?.id ?? null;
    const newMain = project?.main_file ?? null;
    const last = compileScopeRef.current;
    if (last.id !== newId || last.mainFile !== newMain) {
      compileScopeRef.current = { id: newId, mainFile: newMain };
      setPdfUrl(null);
      setCompileLog('');
      setCompileProfile(null);
      setRebuildReason(null);
      setConsoleOutput('');
      setLintDiagnostics([]);
      setGeneratedFiles([]);
      setActiveGenFile(null);
      // Cancel any in-flight compile stream from the previous scope so
      // its `done` event cant land here and resurrect the stale PDF.
      if (compileSourceRef.current) {
        compileSourceRef.current.close();
        compileSourceRef.current = null;
      }
      setCompiling(false);
    }
  }, [project?.id, project?.main_file]);

  // Clean up EventSource on unmount
  useEffect(() => {
    return () => {
      if (compileSourceRef.current) {
        compileSourceRef.current.close();
        compileSourceRef.current = null;
      }
    };
  }, []);

  // Track blob URLs created from local-helper PDF responses so they can
  // be revoked on the next compile / on project switch — otherwise they
  // sit in the browser until reload (real memory cost: ~5-20 MB per
  // typical PDF).
  /** @type {React.MutableRefObject<string | null>} */
  const lastBlobUrlRef = useRef(null);
  const setPdfUrlSmart = useCallback((/** @type {any} */ next) => {
    setPdfUrl((/** @type {any} */ _prev) => {
      if (lastBlobUrlRef.current && lastBlobUrlRef.current !== next) {
        URL.revokeObjectURL(lastBlobUrlRef.current);
        lastBlobUrlRef.current = null;
      }
      if (typeof next === 'string' && next.startsWith('blob:')) {
        lastBlobUrlRef.current = next;
      }
      return next;
    });
  }, []);
  useEffect(() => {
    return () => {
      if (lastBlobUrlRef.current) {
        URL.revokeObjectURL(lastBlobUrlRef.current);
        lastBlobUrlRef.current = null;
      }
    };
  }, []);

  // Apply the same tracked-changes transform the server applies before
  // shipping source to the helper. Stays in sync with the server
  // because both call the same `shared/trackedChanges.js` module.
  const buildLocalPayloadFiles = useCallback((/** @type {any} */ proj, /** @type {any[]} */ allFiles) => {
    if (!Array.isArray(allFiles)) return [];
    const mainFile = proj?.main_file || 'main.tex';
    return allFiles.map((/** @type {any} */ f) => {
      if (f.is_binary) {
        return { path: f.path, content: f.content || '', isBinary: true };
      }
      let content = f.content || '';
      const marks = Array.isArray(f.tc_marks) ? f.tc_marks : [];
      if (showTrackedChanges) {
        content = wrapPendingChangesAsMacros(content, marks);
        if (f.path === mainFile) content = injectTcMacros(content);
      } else {
        content = stripPendingDeletions(content, marks);
      }
      return { path: f.path, content, isBinary: false };
    });
  }, [showTrackedChanges]);

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

    // ── Local-compile path ─────────────────────────────────────────
    // When the resolved choice is `local`, ship the source to the helper
    // and put the resulting PDF blob straight into the viewer. On any
    // transport/auth error we silently fall through to the server path
    // so the user still gets a PDF; on a compile-level failure (helper
    // ran latexmk and got no PDF) we surface it as-is, since the server
    // would fail the same way against the same source.
    if (compileChoice.source === 'local') {
      setConsoleOutput('Compiling locally on your machine…\n');
      const jobId =
        (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
          ? crypto.randomUUID()
          : `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const result = await compileLocal({
        jobId,
        mainFile: project.main_file || 'main.tex',
        compiler: project.compiler || 'pdflatex',
        showTrackedChanges: !!showTrackedChanges,
        // Pin local compile to the project's chosen TeX Live year (if
        // any). Empty string = use whatever the helper has as default
        // — matches the server-side fallback behaviour.
        texDistribution: project.tex_distribution || '',
        files: buildLocalPayloadFiles(project, files || []),
      });
      if (result.ok) {
        const blobUrl = URL.createObjectURL(/** @type {Blob} */ (result.pdfBlob));
        setPdfUrlSmart(blobUrl);
        setCompileLog(result.log || '');
        setConsoleOutput((/** @type {string} */ prev) => prev + (result.log || ''));
        setCompiling(false);
        return; // skip server path, skip server-side lint (helper doesn't lint)
      }
      if (!result.fatal) {
        // The helper ran but the compile itself failed; identical
        // outcome to a server compile, so don't bounce — just surface.
        setCompileLog(result.error || 'Local compile failed');
        setConsoleOutput((prev) => prev + (result.log || '') + '\n' + (result.error || ''));
        // Drop any stale PDF from a prior good build (same reasoning
        // as the server done-handler failure branch).
        setPdfUrl(null);
        setCompiling(false);
        return;
      }
      // fatal: transport/auth — fall through to the server stream below.
      setConsoleOutput((prev) => prev + `Local compile unavailable (${result.error}). Falling back to server.\n`);
    }

    // ── Server-compile path (existing behaviour, unchanged) ────────
    try {
      const tcParam = showTrackedChanges ? '?showTrackedChanges=1' : '';
      const evtSource = new EventSource(`/api/compile/${project.id}/compile-stream${tcParam}`);
      compileSourceRef.current = evtSource;

      // Each handler below guards `compileSourceRef.current !== evtSource`: if
      // the user (re)triggered another compile mid-stream, this EventSource is
      // superseded and any late events from it must NOT update UI state, or we'd
      // overwrite the new compile's output/PDF with stale data.
      await new Promise(/** @type {(resolve: (v?: any) => void, reject: (err: any) => void) => void} */ ((resolve, reject) => {
        evtSource.addEventListener('output', (e) => {
          if (compileSourceRef.current !== evtSource) return;
          const { text } = JSON.parse(e.data);
          setConsoleOutput((prev) => prev + text);
        });

        evtSource.addEventListener('done', (e) => {
          if (compileSourceRef.current !== evtSource) return;
          const data = JSON.parse(e.data);
          setCompileLog(data.log || '');
          setCompileProfile(data.profile || null);
          setRebuildReason(data.rebuildReason || null);
          if (data.success) {
            // tc query selects the matching sibling PDF on disk
            // (jobname.pdf vs jobname_tc.pdf); without it a TC-mode
            // compile would write to the _tc path but the viewer would
            // fetch the plain one and 404.
            const tcParam = showTrackedChanges ? '1' : '0';
            const pdfUrlForMode = `/api/compile/${project.id}/pdf?tc=${tcParam}&t=${Date.now()}`;
            if (data.cached) {
              // Skip-rebuild cache hit: the PDF on disk is bit-identical
              // to what the viewer already shows. Bumping the ?t= cache-
              // buster forces PdfViewer's [url] effect to wipe + reload
              // for nothing — a visible flicker on every save-and-compile
              // that didn't change anything build-tracked. Set the URL
              // only if it wasn't set yet (first compile of the session).
              setPdfUrl((/** @type {any} */ prev) => prev || pdfUrlForMode);
            } else {
              setPdfUrlSmart(pdfUrlForMode);
            }
          } else {
            // Compile failed (e.g. "No output PDF file produced!"). Any
            // PDF still showing is from a PRIOR good build and is now
            // stale — drop it so the viewer shows the error state, not
            // a document that no longer matches the source.
            setPdfUrl(null);
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
      }));
    } catch (err) {
      setCompileLog(err instanceof Error ? err.message : String(err));
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
              setLintDiagnostics((data.diagnostics || []).map((/** @type {any} */ d) => ({ ...d, source: serverLinter })));
            })
            .catch((e) => console.warn('Server lint error:', e));
        }
      } else {
        setLintDiagnostics([]);
      }
    }
  }, [project, activeFile, handleSave, editorRef, showTrackedChanges, compileChoice, buildLocalPayloadFiles, files, setPdfUrlSmart]);

  const handleDiff = useCallback(
    (/** @type {string} */ oldFileId, /** @type {string} */ newFileId) => {
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
        setCompileProfile(data.profile || null);
        setRebuildReason(data.rebuildReason || null);
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
    compileProfile,
    setCompileProfile,
    rebuildReason,
    setRebuildReason,
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
    // Resolved compile-source decision for the next compile. Surface so
    // the compile button / tooltip can show "(local)" when the helper is
    // present and the user has opted in. Note: as of Phase 3b1 the
    // handleCompile path is still always server (the local branch lands
    // when the flowtex-helper binary ships in Phase 1). The choice is
    // exposed now so the UI plumbing is already correct.
    compileChoice,
  };
}
