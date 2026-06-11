// @ts-check
import React, { useEffect, useRef, useState, useCallback, useMemo, forwardRef, useImperativeHandle, lazy, Suspense } from 'react';

// Lazy — the dialog pulls in helperBridge + SSE wiring and isn't
// needed until the user actually picks a menu item. The catalog of
// available tasks lives in its own tiny module so the right-click
// menu can enumerate items without dragging the dialog chunk in.
const LlmActionDialog = lazy(() => import('./LlmActionDialog.jsx'));
import { LLM_TASKS } from '../utils/llmTasks.js';
import { fetchLlmStatus } from '../utils/helperBridge.js';
import useClickOutside from '../hooks/useClickOutside.js';
import {
  EditorView,
  keymap,
  Decoration,
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
} from '@codemirror/view';
import {
  history,
  defaultKeymap,
  historyKeymap,
  insertNewline,
  undo as cmUndo,
  redo as cmRedo,
} from '@codemirror/commands';
import { EditorState, Compartment, Prec } from '@codemirror/state';
import {
  StreamLanguage,
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
} from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { completionKeymap } from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';
import { classHighlighter } from '@lezer/highlight';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { bibtex } from '../utils/bibtexMode.js';
import latexLint from '../utils/latexLint.js';
import bibtexLint from '../utils/bibtexLint.js';
import {
  getDictionary,
  spellcheckText,
  addToCustomDictionary,
  ignoreWord,
} from '../utils/spellcheck.js';
import latexAutocomplete from '../utils/latexCompletions.js';
import SymbolPicker from './SymbolPicker.jsx';
import SearchPanel from './SearchPanel.jsx';
import TableGridPicker from './TableGridPicker.jsx';
import FigureBuilder from './FigureBuilder.jsx';
import {
  commentHighlighter,
  CursorWidget,
  setCursorsEffect,
  remoteCursorsField,
  setErrorHighlightEffect,
  errorHighlightField,
  cursorColor,
  setSearchHighlightEffect,
  searchHighlightField,
  spellcheckField,
  lintField,
  lintGutterField,
  lintGutterExtension,
  spellGutterField,
  spellGutterExtension,
  applyLintDiagnostics,
  applySpellcheck,
  citeKeyHighlighter,
  findTableAtCursor,
  tableGutterField,
  tableGutterExtension,
  updateTableGutterMarkers,
  findFigureAtCursor,
  updateFigureGutterMarkers,
  latexFoldService,
} from '../utils/editorExtensions.js';
import { visualModeExtension, refHoverTooltip, updateBibContext } from '../utils/visualMode.js';
import {
  tcMarksExtensions,
  tcMarksInlineDecorations,
  setTcMarks,
  addTcMarks,
  removeTcMark,
  deserializeMarks,
  serializeMarks,
  listMarks,
  tcMarkSkipAnnotation,
} from '../utils/tcMarks.js';
import { buildTcMarksInputFilter } from '../utils/tcMarksInput.js';
import { findMatchingBrace } from '../utils/latexParser.js';
import VisualModeToolbar from './VisualModeToolbar.jsx';
import { getSetting, setSetting } from '../utils/settings.js';
import {
  UndoIcon,
  RedoIcon,
  ZoomOutIcon,
  ZoomInIcon,
  SearchIcon,
  TableIcon,
  FigureIcon,
  ContrastIcon,
  SyncIcon,
  HighlightIcon,
} from './Icons.jsx';

/** CodeMirror-based LaTeX/BibTeX editor with spellcheck, linting, track changes, and collaborative cursors.
 *  @type {React.ForwardRefExoticComponent<any>}
 */
// @ts-ignore -- props are too dynamic to enumerate
const Editor = forwardRef(function Editor(
  {
    file,
    comments,
    currentUserName,
    currentUserId,
    onSave,
    onLineChange,
    onChanges,
    onDocChange,
    onCursorChange,
    onCompile,
    onRequestComment,
    onScroll,
    onLintDiagnostics,
    showLineNumbers = true,
    wordWrap = true,
    trackChangesMode = false,
    onToggleTrackChanges,
    showTrackedChangesInline = true,
    citeKeys,
    labelKeys,
    autoSaveOn,
    autoSaveLabel,
    onToggleAutoSave,
    onGoToFile,
    projectFiles,
    visualMode = false,
    onToggleVisualMode,
    spellLang = 'en_US',
    // readOnly drives both EditorState.readOnly.of and
    // EditorView.editable.of so neither keystrokes nor paste/drop
    // mutate the doc. App.jsx computes this from the current user's
    // project role -- viewers and commenters can read + select +
    // comment but cannot type. The server already rejects their
    // `changes` WS messages and file PUTs; this stops the editor
    // from accepting input that would silently fail.
    readOnly = false,
    // YJS-MIGRATION phase 1.5: opaque CodeMirror extensions appended
    // to the editor's initial config. Used to splice in the yCollab
    // binding from useYjsSync when the feature flag is on. Default is
    // an empty array so behaviour is unchanged on default builds.
    extraExtensions = [],
    // YJS-MIGRATION phase 2 boilerplate-doubling fix: when the Y.Doc
    // sync is going to take over, CodeMirror must start with an EMPTY
    // doc -- otherwise the file.content rendered at mount stays in the
    // editor and the y-codemirror binding INSERTS the Y.Doc state on
    // top once yjs-state arrives, producing doubled boilerplate. With
    // yjsEnabled=true we render empty briefly; Y.Doc is the source of
    // truth and populates the editor within a request-state round trip.
    yjsEnabled = false,
    // Companion to yjsEnabled: a `() => boolean` from the binding that
    // returns true while Y.applyUpdateV2 of a remote update is being
    // processed. y-codemirror's syncPlugin observes the Y.Doc change
    // synchronously and dispatches a CodeMirror transaction to insert
    // the delta into the editor. Without this flag, the TC marks
    // input filter would treat those inserts as user typing -- so
    // every project opens with the WHOLE file flagged as tracked-
    // change inserts. Wired into the TC filter's shouldSkip below.
    yjsIsApplyingRemote = null,
  },
  ref,
) {
  const containerRef = useRef(/** @type {any} */ (null));
  const viewRef = useRef(/** @type {any} */ (null));
  const saveTimeout = useRef(/** @type {any} */ (null));
  const commentCompartment = useRef(new Compartment());
  const wrapCompartment = useRef(new Compartment());
  const fontSizeCompartment = useRef(new Compartment());
  const visualModeCompartment = useRef(new Compartment());
  const tcInlineCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  // YJS-MIGRATION phase 1.5: extraExtensions arrives one render AFTER
  // a file becomes active (useYjsSync's useEffect runs post-render and
  // setState triggers a re-render with the extension). A Compartment
  // lets us reconfigure the editor in-place when that happens, instead
  // of rebuilding the EditorState and losing cursor/scroll/history.
  const extraExtCompartment = useRef(new Compartment());
  const [fontSize, setFontSize] = useState(() => parseInt(getSetting('font-size') || '14', 10));
  const isRemoteUpdate = useRef(false);
  const errorHighlightTimer = useRef(/** @type {any} */ (null));
  const lintTimeout = useRef(/** @type {any} */ (null));
  const spellTimeout = useRef(/** @type {any} */ (null));
  const dictRef = useRef(/** @type {any} */ (null));
  const currentUserNameRef = useRef(currentUserName);
  currentUserNameRef.current = currentUserName;
  const currentUserIdRef = useRef(currentUserId);
  currentUserIdRef.current = currentUserId;
  // Stable ref to the yjsIsApplyingRemote prop. Without this, the
  // TC marks filter's shouldSkip closure (built at mount time inside
  // EditorState.create) bakes in whatever value the prop had THEN.
  // useYjsSync's binding is async: the prop is `null` on first
  // render and becomes the real function on the next render. The
  // mount effect's dep list is [file?.id] only -- it never re-runs
  // -- so the editor permanently has shouldSkip wired to null,
  // meaning every char that yjs-state applies on project open gets
  // marked as a user insert. The ref pattern lets shouldSkip read
  // the LATEST function reference at call time.
  const yjsIsApplyingRemoteRef = useRef(yjsIsApplyingRemote);
  yjsIsApplyingRemoteRef.current = yjsIsApplyingRemote;
  // Track current file id so any deferred operations pin to the file the user is
  // actually editing — saves and other operations must not leak edits across files.
  const fileIdRef = useRef(file?.id ?? null);
  fileIdRef.current = file?.id ?? null;
  const [commentBtn, setCommentBtn] = useState(/** @type {any} */ (null)); // { x, y, from, to }
  const [cursorInHl, setCursorInHl] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [lintDiags, setLintDiags] = useState(/** @type {any[]} */ ([]));
  const [spellMenu, setSpellMenu] = useState(/** @type {any} */ (null)); // { x, y, word, from, to }
  const [tcMenu, setTcMenu] = useState(/** @type {any} */ (null)); // { x, y, id, type, author }
  const tcMenuRef = useRef(/** @type {any} */ (null));
  const spellMenuRef = useRef(/** @type {any} */ (null));
  const [citeMenu, setCiteMenu] = useState(/** @type {any} */ (null)); // { x, y, from, to, name, opt, key }
  const citeMenuRef = useRef(/** @type {any} */ (null));
  // LLM context menu shown when the user right-clicks INSIDE a non-empty
  // selection. Each menu item dispatches one of the LLM_TASKS — Accept
  // in the resulting dialog replaces the selection in place.
  const [llmMenu, setLlmMenu] = useState(/** @type {any} */ (null)); // { x, y, from, to, text }
  const llmMenuRef = useRef(/** @type {any} */ (null));
  const [llmDialog, setLlmDialog] = useState(/** @type {any} */ (null)); // { from, to, text, task }
  // Tasks the running helper actually supports. Probed once via
  // /llm/status. null = not probed yet (show everything — old client
  // contract); array = filter the menu. Older helpers without the
  // supportedTasks field also leave this null so they keep showing
  // all menu items as before.
  const [llmSupportedTasks, setLlmSupportedTasks] = useState(/** @type {any} */ (null));
  useEffect(() => {
    let cancelled = false;
    fetchLlmStatus().then((/** @type {any} */ r) => {
      if (cancelled) return;
      const arr = r?.status?.supportedTasks;
      if (Array.isArray(arr)) setLlmSupportedTasks(arr);
    });
    return () => { cancelled = true; };
  }, []);
  const [inverted, setInverted] = useState(() => getSetting('editor-inverted') === 'true');
  const [spellcheckEnabled, setSpellcheckEnabled] = useState(
    () => getSetting('spellcheck-enabled') !== 'false', // default ON
  );

  // VisualModeToolbar owns its own state; we hold a ref to refresh it on cursor move.
  const vmToolbarRef = useRef(/** @type {any} */ (null));

  /**
   * Per-doc cache for list-env tag positions. Recomputed only when the CodeMirror
   * Text reference changes. This matters because findInnermostListEnv runs on
   * every Enter / Tab / Shift-Tab keystroke under autorepeat.
   *   { doc, tags: [{ pos, env, type, len }, ...] sorted by pos }
   */
  const listEnvTagsCacheRef = useRef(/** @type {any} */ (null));

  const getListEnvTags = useCallback((/** @type {any} */ doc) => {
    const cached = listEnvTagsCacheRef.current;
    if (cached && cached.doc === doc) return cached.tags;
    const text = doc.toString();
    const envNames = ['itemize', 'enumerate', 'description'];
    const tags = [];
    for (const env of envNames) {
      const bt = `\\begin{${env}}`;
      const et = `\\end{${env}}`;
      let i = 0;
      while ((i = text.indexOf(bt, i)) !== -1) { tags.push({ pos: i, env, type: 'begin', len: bt.length }); i += bt.length; }
      i = 0;
      while ((i = text.indexOf(et, i)) !== -1) { tags.push({ pos: i, env, type: 'end', len: et.length }); i += et.length; }
    }
    tags.sort((a, b) => a.pos - b.pos);
    listEnvTagsCacheRef.current = { doc, tags };
    return tags;
  }, []);

  /**
   * Find the innermost itemize/enumerate/description env surrounding `pos`.
   * Returns { env, beginPos, endPos, depth } or null.
   * beginPos = start of \begin{env}, endPos = start of \end{env}.
   *
   * Tag positions are memoized per document version (see listEnvTagsCacheRef);
   * only the per-position stack walk runs on each call.
   */
  const findInnermostListEnv = useCallback((/** @type {any} */ doc, /** @type {any} */ pos) => {
    const tags = getListEnvTags(doc);

    // Walk through tags, tracking a stack of open envs
    const stack = []; // { env, beginPos }
    let result = null;
    for (const tag of tags) {
      if (tag.type === 'begin') {
        stack.push({ env: tag.env, beginPos: tag.pos });
      } else {
        // Close the most recent matching begin
        for (let j = stack.length - 1; j >= 0; j--) {
          if (stack[j].env === tag.env) {
            const opened = stack[j];
            // Does this env surround pos?
            if (opened.beginPos < pos && tag.pos + tag.len >= pos) {
              // This env contains pos — is it innermost so far?
              if (!result || opened.beginPos > result.beginPos) {
                result = { env: tag.env, beginPos: opened.beginPos, endPos: tag.pos, depth: 0 };
              }
            }
            stack.splice(j, 1);
            break;
          }
        }
      }
    }

    if (!result) return null;

    // Compute depth: count how many list envs contain this one
    let depth = 0;
    // Re-scan: count how many begin tags before result.beginPos are still open at that point
    const stack2 = [];
    for (const tag of tags) {
      if (tag.pos >= result.beginPos) break;
      if (tag.type === 'begin') {
        stack2.push(tag);
      } else {
        for (let j = stack2.length - 1; j >= 0; j--) {
          if (stack2[j].env === tag.env) { stack2.splice(j, 1); break; }
        }
      }
    }
    depth = stack2.length;
    result.depth = depth;
    return result;
  }, [getListEnvTags]);

  // Insert a list environment around the current selection/lines
  const vmInsertList = useCallback((/** @type {string} */ envName) => {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const fromLine = view.state.doc.lineAt(from);
    const toLine = view.state.doc.lineAt(to);
    const blockFrom = fromLine.from;
    const blockTo = toLine.to;
    const blockText = view.state.doc.sliceString(blockFrom, blockTo);

    // Check if cursor is already inside this list env — if so, unwrap
    // Scan backwards for \begin{envName} and forwards for \end{envName}
    const docText = view.state.doc.toString();
    const beforeCursor = docText.slice(0, blockFrom);
    const afterCursor = docText.slice(blockTo);
    const beginIdx = beforeCursor.lastIndexOf(`\\begin{${envName}}`);
    const endIdx = afterCursor.indexOf(`\\end{${envName}}`);

    if (beginIdx >= 0 && endIdx >= 0) {
      // Check there's no \end{envName} between beginIdx and cursor (i.e. we're truly inside)
      const between = docText.slice(beginIdx, blockFrom);
      if (!between.includes(`\\end{${envName}}`)) {
        // Unwrap the entire environment
        const envFrom = beginIdx;
        const envTo = blockTo + endIdx + `\\end{${envName}}`.length;
        let envContent = docText.slice(envFrom, envTo);
        // Strip \begin{env} and \end{env}
        envContent = envContent
          .replace(new RegExp('^\\\\begin\\{' + envName + '\\}\\s*\\n?'), '')
          .replace(new RegExp('\\n?\\s*\\\\end\\{' + envName + '\\}$'), '');
        // Strip \item from each line
        const stripped = envContent.replace(/^\s*\\item\s*/gm, '');
        view.dispatch({ changes: { from: envFrom, to: envTo, insert: stripped } });
        view.focus();
        return;
      }
    }

    // No selection or empty line — insert a fresh list with one item, cursor after \item
    if (from === to || !blockText.trim()) {
      const snippet = `\\begin{${envName}}\n  \\item \n\\end{${envName}}`;
      const cursorPos = blockFrom + `\\begin{${envName}}\n  \\item `.length;
      view.dispatch({
        changes: { from: blockFrom, to: blockTo, insert: snippet },
        selection: { anchor: cursorPos },
      });
      view.focus();
      return;
    }

    // Selection exists — wrap each selected line as \item
    const lines = blockText.split('\n').filter((/** @type {string} */ l) => l.trim());
    const items = lines.map((/** @type {string} */ l) => {
      const trimmed = l.trim();
      return trimmed.startsWith('\\item') ? '  ' + trimmed : '  \\item ' + trimmed;
    }).join('\n');
    const newText = `\\begin{${envName}}\n${items}\n\\end{${envName}}`;

    view.dispatch({
      changes: { from: blockFrom, to: blockTo, insert: newText },
    });
    view.focus();
  }, []);

  // Wrap or unwrap a `\begin{quote} ... \end{quote}` block. Mirrors the toggle
  // semantics of vmInsertList: cursor already inside a quote → unwrap;
  // empty selection → insert an empty quote and place the cursor inside;
  // non-empty selection → wrap the selected block.
  const vmInsertQuote = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const fromLine = view.state.doc.lineAt(from);
    const toLine = view.state.doc.lineAt(to);
    const blockFrom = fromLine.from;
    const blockTo = toLine.to;
    const blockText = view.state.doc.sliceString(blockFrom, blockTo);

    const docText = view.state.doc.toString();
    const beforeCursor = docText.slice(0, blockFrom);
    const afterCursor = docText.slice(blockTo);
    const beginIdx = beforeCursor.lastIndexOf('\\begin{quote}');
    const endIdx = afterCursor.indexOf('\\end{quote}');

    if (beginIdx >= 0 && endIdx >= 0) {
      const between = docText.slice(beginIdx, blockFrom);
      if (!between.includes('\\end{quote}')) {
        // Unwrap the surrounding quote environment.
        const envFrom = beginIdx;
        const envTo = blockTo + endIdx + '\\end{quote}'.length;
        let envContent = docText.slice(envFrom, envTo);
        envContent = envContent
          .replace(/^\\begin\{quote\}\s*\n?/, '')
          .replace(/\n?\s*\\end\{quote\}$/, '');
        view.dispatch({ changes: { from: envFrom, to: envTo, insert: envContent } });
        view.focus();
        return;
      }
    }

    if (from === to || !blockText.trim()) {
      const snippet = '\\begin{quote}\n  \n\\end{quote}';
      const cursorPos = blockFrom + '\\begin{quote}\n  '.length;
      view.dispatch({
        changes: { from: blockFrom, to: blockTo, insert: snippet },
        selection: { anchor: cursorPos },
      });
      view.focus();
      return;
    }

    const indented = blockText.split('\n').map((/** @type {any} */ l) => (l.trim() ? '  ' + l.trim() : '')).join('\n');
    const newText = `\\begin{quote}\n${indented}\n\\end{quote}`;
    view.dispatch({ changes: { from: blockFrom, to: blockTo, insert: newText } });
    view.focus();
  }, []);

  useEffect(() => {
    const handler = (/** @type {any} */ e) => {
      if (e.detail.editorInverted !== undefined) setInverted(e.detail.editorInverted);
    };
    window.addEventListener('flowtex:settings-changed', handler);
    return () => window.removeEventListener('flowtex:settings-changed', handler);
  }, []);
  const [tableBuilder, setTableBuilder] = useState(/** @type {any} */ (null)); // null | { initial?, replaceFrom?, replaceTo? }
  const [figureBuilder, setFigureBuilder] = useState(/** @type {any} */ (null));
  const [showSymbolPicker, setShowSymbolPicker] = useState(false);
  const tableBuilderRef = useRef(/** @type {any} */ (null));
  const figureBuilderRef = useRef(/** @type {any} */ (null));
  tableBuilderRef.current = tableBuilder;
  figureBuilderRef.current = figureBuilder;
  const tableBuilderUpdateTimeout = useRef(/** @type {any} */ (null));
  const figureBuilderUpdateTimeout = useRef(/** @type {any} */ (null));

  const onGoToFileRef = useRef(onGoToFile);
  const projectFilesRef = useRef(projectFiles);
  const onSaveRef = useRef(onSave);
  const onLineChangeRef = useRef(onLineChange);
  const onChangesRef = useRef(onChanges);
  const onDocChangeRef = useRef(onDocChange);
  const onCursorChangeRef = useRef(onCursorChange);
  const onCompileRef = useRef(onCompile);
  const onRequestCommentRef = useRef(onRequestComment);
  const onScrollRef = useRef(onScroll);
  const onLintDiagnosticsRef = useRef(onLintDiagnostics);
  const trackChangesModeRef = useRef(trackChangesMode);
  const setSpellMenuRef = useRef(setSpellMenu);
  const setCiteMenuRef = useRef(setCiteMenu);
  const onToggleVisualModeRef = useRef(onToggleVisualMode);
  const visualModeRef = useRef(visualMode);
  onGoToFileRef.current = onGoToFile;
  projectFilesRef.current = projectFiles;
  onSaveRef.current = onSave;
  onLineChangeRef.current = onLineChange;
  onChangesRef.current = onChanges;
  onDocChangeRef.current = onDocChange;
  onCursorChangeRef.current = onCursorChange;
  onCompileRef.current = onCompile;
  onRequestCommentRef.current = onRequestComment;
  onScrollRef.current = onScroll;
  onLintDiagnosticsRef.current = onLintDiagnostics;
  trackChangesModeRef.current = trackChangesMode;
  onToggleVisualModeRef.current = onToggleVisualMode;
  visualModeRef.current = visualMode;
  const citeKeysRef = useRef(citeKeys || []);
  citeKeysRef.current = citeKeys || [];
  const labelKeysRef = useRef(labelKeys || []);
  labelKeysRef.current = labelKeys || [];
  // Keep the bib lookup populated regardless of mode so the cite-hover
  // tooltip works in source mode too (visual mode also refreshes it via
  // visualModeExtension, but we run it eagerly here so the data is ready
  // before the user even toggles into visual mode).
  updateBibContext(projectFiles, citeKeys);
  setSpellMenuRef.current = setSpellMenu;
  setCiteMenuRef.current = setCiteMenu;

  /** Set of package names declared via \usepackage in the project preamble. */
  const declaredPackages = useMemo(() => {
    const pkgs = new Set();
    if (!projectFiles) return pkgs;
    const mainFile = projectFiles.find((/** @type {any} */ f) => f.content && f.content.includes('\\documentclass'));
    if (!mainFile) return pkgs;
    // Extract preamble (before \begin{document})
    const preamble = mainFile.content.split('\\begin{document}')[0] || '';
    // Match \usepackage[opts]{pkg1,pkg2,...} and \usepackage{pkg}
    const re = /\\(?:usepackage|RequirePackage)(?:\[.*?\])?\{([^}]+)\}/g;
    let m;
    while ((m = re.exec(preamble))) {
      for (const p of m[1].split(',')) {
        const trimmed = p.trim();
        if (trimmed) pkgs.add(trimmed);
      }
    }
    return pkgs;
  }, [projectFiles]);

  useImperativeHandle(ref, () => ({
    undo() {
      const view = viewRef.current;
      if (view) cmUndo(view);
    },
    redo() {
      const view = viewRef.current;
      if (view) cmRedo(view);
    },
    /** @param {number} line @param {number} [col] */
    goToLine(line, col) {
      const view = viewRef.current;
      if (!view) return;
      const lineInfo = view.state.doc.line(Math.min(line, view.state.doc.lines));

      // Determine highlight range: if col is provided, highlight around that position; otherwise the whole line
      let from, to;
      if (col != null && col > 0) {
        // col is the offset within the line where the error is (at or just before this position)
        const errPos = Math.min(lineInfo.from + col - 1, lineInfo.to);
        from = Math.max(errPos, lineInfo.from);
        to = Math.min(errPos + 1, lineInfo.to);
        // If from == to (end of line), widen to at least 1 char before
        if (from >= to && from > lineInfo.from) from = from - 1;
      } else {
        from = lineInfo.from;
        to = lineInfo.to;
      }

      // Snapshot scrollTop of all ancestors before focus
      /** @type {Array<{ el: HTMLElement, top: number, left: number }>} */
      const ancestors = [];
      let el = view.dom.parentElement;
      while (el) {
        ancestors.push({ el, top: el.scrollTop, left: el.scrollLeft });
        el = el.parentElement;
      }
      view.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: 'center' }),
      });
      view.focus({ preventScroll: true });
      // Restore all ancestor scroll positions
      for (const a of ancestors) {
        a.el.scrollTop = a.top;
        a.el.scrollLeft = a.left;
      }
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      requestAnimationFrame(() => {
        for (const a of ancestors) {
          a.el.scrollTop = a.top;
          a.el.scrollLeft = a.left;
        }
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      });
      // Add error highlight decoration
      if (from < to) {
        const deco = Decoration.set([Decoration.mark({ class: 'cm-error-highlight' }).range(from, to)]);
        view.dispatch({ effects: setErrorHighlightEffect.of(deco) });
        clearTimeout(errorHighlightTimer.current);
        errorHighlightTimer.current = setTimeout(() => {
          if (viewRef.current) {
            viewRef.current.dispatch({ effects: setErrorHighlightEffect.of(Decoration.none) });
          }
        }, 3000);
      }
    },
    /** @param {number} pos */
    goToPosition(pos) {
      const view = viewRef.current;
      if (!view) return;
      const clamped = Math.min(pos, view.state.doc.length);
      // Snapshot scrollTop of all ancestors before focus
      /** @type {Array<{ el: HTMLElement, top: number, left: number }>} */
      const ancestors = [];
      let el = view.dom.parentElement;
      while (el) {
        ancestors.push({ el, top: el.scrollTop, left: el.scrollLeft });
        el = el.parentElement;
      }
      view.dispatch({
        selection: { anchor: clamped },
        effects: EditorView.scrollIntoView(clamped, { y: 'center' }),
      });
      view.focus({ preventScroll: true });
      // Restore all ancestor scroll positions to prevent header shift
      for (const a of ancestors) {
        a.el.scrollTop = a.top;
        a.el.scrollLeft = a.left;
      }
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      // Also do it on next frame in case browser defers the scroll
      requestAnimationFrame(() => {
        for (const a of ancestors) {
          a.el.scrollTop = a.top;
          a.el.scrollLeft = a.left;
        }
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      });
    },
    getContent() {
      const view = viewRef.current;
      return view ? view.state.doc.toString() : null;
    },
    openSearch() {
      setShowSearch(true);
    },
    /** @param {number} deltaX @param {number} deltaY */
    scrollBy(deltaX, deltaY) {
      const view = viewRef.current;
      if (!view) return;
      view.scrollDOM.scrollBy(deltaX, deltaY);
    },
    /** @param {string} newContent */
    replaceContent(newContent) {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: newContent },
      });
    },
    /** @param {string} before @param {string} after */
    insertSnippet(before, after) {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);
      const insert = before + selected + after;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + before.length, head: from + before.length + selected.length },
      });
      view.focus();
    },
    /** @param {number} from @param {number} to @param {string} text */
    replaceRange(from, to, text) {
      const view = viewRef.current;
      if (!view) return;
      const docLen = view.state.doc.length;
      const clampedFrom = Math.min(Math.max(0, from), docLen);
      const clampedTo = Math.min(Math.max(clampedFrom, to), docLen);
      isRemoteUpdate.current = true; // don't re-track AND don't broadcast (used for remote edits)
      try {
        view.dispatch({ changes: { from: clampedFrom, to: clampedTo, insert: text } });
      } finally {
        isRemoteUpdate.current = false;
      }
    },

    /**
     * Snapshot of all current TC entries (M2 — both ins and del are
     * real ranges over chars in the doc). Sorted by `from`.
     */
    listTcMarks() {
      const view = viewRef.current;
      if (!view) return [];
      return listMarks(view.state);
    },

    /**
     * Persistence-shape snapshot of TC entries — matches what the
     * debounced autosave sends. Compile callers use this so the
     * pre-compile flush includes marks alongside content; without it
     * the server compiles fresh content against stale `tc_marks` from
     * the DB, which can chop closing braces out of newly-typed
     * sectioning commands (see §6 of TRACK-CHANGES-RULES.md).
     */
    getTcMarks() {
      const view = viewRef.current;
      return view ? serializeMarks(view.state) : [];
    },

    /**
     * Resolve a single TC entry by id. M2 semantics (§4):
     *   accept(ins): drop the mark; doc unchanged.
     *   reject(ins): delete [from, to) AND drop the mark.
     *   accept(del): delete [from, to) AND drop the mark.
     *   reject(del): drop the mark; doc unchanged.
     * Skip annotation prevents the input filter from re-tracking the
     * accept/reject doc surgery as a new edit.
     */
    /** @param {string} markerId @param {string} decision */
    applyMarkResolution(markerId, decision) {
      const view = viewRef.current;
      if (!view) return false;
      const m = listMarks(view.state).find((/** @type {any} */ x) => x.id === markerId);
      if (!m) return false;
      /** @type {any} */
      const spec = {
        effects: removeTcMark.of(markerId),
        annotations: tcMarkSkipAnnotation.of(true),
      };
      const removeRange =
        (m.type === 'ins' && decision === 'reject') ||
        (m.type === 'del' && decision === 'accept');
      if (removeRange) {
        spec.changes = { from: m.from, to: m.to, insert: '' };
      }
      view.dispatch(spec);
      return true;
    },

    /** Resolve every pending TC entry with the same decision. */
    /** @param {string} decision */
    applyMarkResolutionAll(decision) {
      const view = viewRef.current;
      if (!view) return 0;
      const marks = listMarks(view.state);
      if (marks.length === 0) return 0;
      // Sort by `from` descending so deletions don't invalidate later
      // positions when CM applies them in sequence.
      const sorted = [...marks].sort((a, b) => b.from - a.from);
      const changes = [];
      const effects = [];
      for (const m of sorted) {
        effects.push(removeTcMark.of(m.id));
        const removeRange =
          (m.type === 'ins' && decision === 'reject') ||
          (m.type === 'del' && decision === 'accept');
        if (removeRange) {
          changes.push({ from: m.from, to: m.to, insert: '' });
        }
      }
      view.dispatch({
        changes,
        effects,
        annotations: tcMarkSkipAnnotation.of(true),
      });
      return marks.length;
    },

    /** @param {number} pos */
    getTopForPos(pos) {
      const view = viewRef.current;
      if (!view) return 0;
      const clamped = Math.min(Math.max(0, pos), view.state.doc.length);
      return view.lineBlockAt(clamped).top;
    },
    getScrollInfo() {
      const view = viewRef.current;
      if (!view) return { scrollTop: 0, clientHeight: 0 };
      return { scrollTop: view.scrollDOM.scrollTop, clientHeight: view.scrollDOM.clientHeight };
    },
    /**
     * @param {string} fileId
     * @param {any} changes
     * @param {boolean} [_tracked]
     * @param {any} [_deletions]
     * @param {any} [tcMarks]
     */
    applyRemoteChanges(fileId, changes, _tracked, _deletions, tcMarks) {
      const view = viewRef.current;
      // Drop OT changes that target a file the user has since switched away
      // from — applying them to the wrong file's CodeMirror state would
      // corrupt the visible document and produce out-of-band positions.
      if (!view || fileId !== file?.id) return;
      isRemoteUpdate.current = true;
      try {
        // Build effects for any TC mark mutations the sender broadcast.
        // These get applied with the skip annotation so the input filter
        // doesn't re-track them.
        /** @type {any[]} */
        const effects = [];
        if (tcMarks && Array.isArray(tcMarks.added) && tcMarks.added.length > 0) {
          effects.push(addTcMarks.of(tcMarks.added));
        }
        if (tcMarks && Array.isArray(tcMarks.removed)) {
          for (const id of tcMarks.removed) effects.push(removeTcMark.of(id));
        }
        /** @type {any} */
        const spec = {
          annotations: tcMarkSkipAnnotation.of(true),
        };
        if (changes && (Array.isArray(changes) ? changes.length > 0 : true)) {
          spec.changes = changes;
        }
        if (effects.length > 0) spec.effects = effects;
        if (spec.changes || spec.effects) view.dispatch(spec);
      } finally {
        isRemoteUpdate.current = false;
      }
    },
    /** @param {any[]} cursors */
    setRemoteCursors(cursors) {
      const view = viewRef.current;
      if (!view) return;
      const docLen = view.state.doc.length;
      /** @type {any[]} */
      const decos = [];
      for (const c of cursors) {
        const head = Math.min(Math.max(c.head, 0), docLen);
        const anchor = Math.min(Math.max(c.anchor ?? c.head, 0), docLen);
        const color = cursorColor(c.userId);

        // Cursor widget at head position
        decos.push(
          Decoration.widget({
            widget: new CursorWidget(c.userName, color),
            side: 1,
          }).range(head),
        );

        // Selection highlight if anchor != head
        if (anchor !== head) {
          const from = Math.min(anchor, head);
          const to = Math.max(anchor, head);
          decos.push(
            Decoration.mark({
              class: 'cm-remote-selection',
              attributes: { style: `background-color: ${color}33` },
            }).range(from, to),
          );
        }
      }
      decos.sort((a, b) => a.from - b.from || a.startSide - b.startSide);
      view.dispatch({ effects: setCursorsEffect.of(Decoration.set(decos, true)) });
    },
    openSymbolPicker() {
      setShowSymbolPicker(true);
    },
    zoomIn() {
      setFontSize((/** @type {any} */ s) => Math.min(32, s + 1));
    },
    zoomOut() {
      setFontSize((/** @type {any} */ s) => Math.max(8, s - 1));
    },
  }));


  // Create editor when file changes
  useEffect(() => {
    if (!containerRef.current || !file) return;

    if (viewRef.current) {
      viewRef.current.destroy();
    }
    setCommentBtn(null);

    commentCompartment.current = new Compartment();
    wrapCompartment.current = new Compartment();
    visualModeCompartment.current = new Compartment();
    tcInlineCompartment.current = new Compartment();
    extraExtCompartment.current = new Compartment();

    const state = EditorState.create({
      // Empty when Y.Doc sync is on so the y-codemirror binding's
      // insert-from-yjs-state doesn't duplicate file.content. The
      // Y.Doc populates the editor once yjs-state arrives over the WS.
      doc: yjsEnabled ? '' : (file.content || ''),
      extensions: [
        // Equivalent of `basicSetup` without `closeBrackets()` and its
        // keymap — auto-pairing { → {} or ' → '' interferes with LaTeX
        // typing and was filed as a bug. Everything else from basicSetup
        // is preserved (line numbers, history, fold gutter, etc.).
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        // (indentOnInput() removed — LaTeX users manage their own
        // indentation, and with TC on its auto-inserted whitespace was
        // showing up as tracked-inserted text.)
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        // Override Enter to insert a plain newline (the default
        // `insertNewlineAndIndent` adds language-aware indentation
        // which, with TC on, gets tracked as inserted whitespace).
        keymap.of([{ key: 'Enter', run: insertNewline }]),
        keymap.of([
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          ...lintKeymap,
        ]),
        StreamLanguage.define(file?.path?.endsWith('.bib') ? bibtex : stex),
        syntaxHighlighting(classHighlighter, { fallback: true }),
        latexFoldService,
        latexAutocomplete(citeKeysRef, labelKeysRef),
        refHoverTooltip,
        // EditorState.readOnly alone (NOT EditorView.editable.of(false))
        // blocks every doc-mutating transaction at the state level while
        // keeping the caret live: the user can still click to position
        // their cursor, drag-select text, and run the floating Comment
        // button on a selection. EditorView.editable=false would also
        // hide the caret entirely, which removes the "I'm reading at
        // line 47" affordance that's the whole point of a comment-
        // capable read-only role. Paste/drop still produce transactions
        // here; readOnly filters them so they're no-ops.
        readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
        wrapCompartment.current.of(wordWrap ? EditorView.lineWrapping : []),
        visualModeCompartment.current.of(visualMode ? visualModeExtension(projectFiles, citeKeys) : []),
        fontSizeCompartment.current.of(
          EditorView.theme({
            '.cm-content': { fontSize: fontSize + 'px' },
            '.cm-gutters': { fontSize: fontSize + 'px' },
          }),
        ),
        EditorView.contentAttributes.of({ spellcheck: 'false' }),
        remoteCursorsField,
        // Track-changes V1 (insertion-only as of Step 4). Doc text is
        // plain; sidecar marks live in tcMarksField. Input filter emits
        // ins entries on user typing when TC is on. Deletions land in
        // Step 5; accept/reject + undo in Steps 6/7.
        ...tcMarksExtensions(),
        // Inline ins/del decorations are wrapped in a Compartment so the
        // user can toggle "Show tracked changes inline" without remounting.
        // (Marks are still tracked / saved / undoable when off.)
        tcInlineCompartment.current.of(showTrackedChangesInline ? tcMarksInlineDecorations : []),
        buildTcMarksInputFilter({
          isOn: () => trackChangesModeRef.current,
          getAuthorId: () => currentUserIdRef.current || '',
          getAuthorName: () => currentUserNameRef.current || '',
          // Skip TC marking while y-codemirror's syncPlugin is
          // applying a remote Y.Doc update -- these are the inserts
          // that bring the empty editor up to canonical state on
          // open. Without this, every project opens with the whole
          // boilerplate (or full restored content) flagged as a
          // pending tracked change.
          // Read through the ref so the closure sees the LATEST function
          // reference (the binding might not exist when the editor first
          // mounts; once it does, the ref updates and shouldSkip starts
          // returning true during remote applies). Returns false when the
          // prop is still null -- safe default, just means no skipping.
          shouldSkip: () => {
            const f = yjsIsApplyingRemoteRef.current;
            return f ? f() : false;
          },
        }),
        tableGutterField,
        tableGutterExtension,
        EditorView.domEventHandlers({
          contextmenu(event, view) {
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos == null) return false;
            // LLM menu wins precedence when the right-click is INSIDE a
            // non-empty selection. Reasoning: if the user has selected
            // text and right-clicks on it, they almost certainly mean
            // "do something to this selection" — not the in-place
            // tracked-change / spell / cite-variant menus that target
            // the click point alone. Other menus still fire when the
            // click is outside the selection (or there is no selection).
            const sel = view.state.selection.main;
            if (!sel.empty && pos >= sel.from && pos <= sel.to) {
              const text = view.state.sliceDoc(sel.from, sel.to);
              if (text.trim().length > 0) {
                event.preventDefault();
                setLlmMenu({
                  x: event.clientX,
                  y: event.clientY,
                  from: sel.from,
                  to: sel.to,
                  text,
                });
                return true;
              }
            }
            // Cite-family command at this position → offer a variant-swap menu.
            // Scan a 200-char window around `pos` for `\name[opt]{key}` where
            // `name` is one of the cite-family commands. Includes optional [arg]
            // so we can preserve page references like \citep[p.~5]{key}.
            {
              const text = view.state.doc.toString();
              const winStart = Math.max(0, pos - 200);
              const winEnd = Math.min(text.length, pos + 200);
              const window = text.slice(winStart, winEnd);
              const re = /\\(cite|citep|citet|citeauthor|citeyear|parencite|textcite|autocite|citealt|citealp|nocite)\*?(\[[^\]]*\](?:\[[^\]]*\])?)?\{([^}]*)\}/g;
              let m;
              while ((m = re.exec(window)) !== null) {
                const cmdFrom = winStart + m.index;
                const cmdTo = cmdFrom + m[0].length;
                if (pos >= cmdFrom && pos < cmdTo) {
                  event.preventDefault();
                  setCiteMenuRef.current?.({
                    x: event.clientX,
                    y: event.clientY,
                    from: cmdFrom,
                    to: cmdTo,
                    name: m[1],
                    opt: m[2] || '',
                    key: m[3],
                  });
                  return true;
                }
              }
            }
            // Tracked-change mark at this position? If so, show an
            // Accept/Reject menu instead of the spellcheck menu.
            {
              const marks = listMarks(view.state);
              const hit = marks.find((/** @type {any} */ m) => pos >= m.from && pos < m.to);
              if (hit) {
                event.preventDefault();
                setTcMenu({
                  x: event.clientX,
                  y: event.clientY,
                  id: hit.id,
                  type: hit.type,
                  author: hit.authorName || '',
                });
                return true;
              }
            }
            // Check for misspelled word at this position
            let spellHit = null;
            view.state.field(spellcheckField).between(pos, pos + 1, (from, to) => {
              if (pos >= from && pos <= to) {
                spellHit = { from, to, word: view.state.sliceDoc(from, to), misspelled: true };
              }
            });
            // If no misspelled decoration, find the word under cursor anyway
            if (!spellHit) {
              const doc = view.state.doc;
              const line = doc.lineAt(pos);
              const lineText = line.text;
              const offset = pos - line.from;
              // Find word boundaries
              let start = offset,
                end = offset;
              while (start > 0 && /[a-zA-Z']/.test(lineText[start - 1])) start--;
              while (end < lineText.length && /[a-zA-Z']/.test(lineText[end])) end++;
              // Strip leading/trailing apostrophes
              while (start < end && lineText[start] === "'") start++;
              while (end > start && lineText[end - 1] === "'") end--;
              if (end > start) {
                const word = lineText.slice(start, end);
                if (word.length >= 2) {
                  spellHit = { from: line.from + start, to: line.from + end, word, misspelled: false };
                }
              }
            }
            if (spellHit) {
              event.preventDefault();
              setSpellMenuRef.current?.({ x: event.clientX, y: event.clientY, ...spellHit });
              return true;
            }
            return false;
          },
        }),
        errorHighlightField,
        searchHighlightField,
        spellcheckField,
        lintField,
        lintGutterField,
        lintGutterExtension,
        spellGutterField,
        spellGutterExtension,
        citeKeyHighlighter,
        // YJS-MIGRATION phase 1.5: caller-supplied extensions
        // (yCollab when useYjsSync is enabled), held in a Compartment
        // so the binding can be spliced in on a later render without
        // tearing down the EditorState.
        extraExtCompartment.current.of(extraExtensions || []),
        EditorView.updateListener.of((update) => {
          // Detect mark-only mutations from accept/reject so the save
          // scheduler runs even when the doc didn't change (§6.1/§6.2).
          // Hydration is intentionally excluded: setTcMarks is hydration
          // only and must NOT trigger a re-save of what we just loaded.
          let userMarkChange = false;
          for (const tr of update.transactions) {
            for (const e of tr.effects) {
              if (e.is(addTcMarks) || e.is(removeTcMark)) {
                userMarkChange = true;
                break;
              }
            }
            if (userMarkChange) break;
          }

          // Fire onDocChange on either a doc change OR a mark mutation
          // (M2 deletions of original text are mark-only — `docChanged`
          // stays false but the review panel still needs to re-read the
          // pending list). Hydration is excluded by `userMarkChange`'s
          // definition (setTcMarks isn't counted).
          if (update.docChanged || userMarkChange) {
            onDocChangeRef.current?.();
          }

          // Broadcast doc changes + TC mark mutations together so other
          // clients in the project apply them as one atomic remote-OT
          // step. Skip if this update was itself a remote OT (echo
          // suppression).
          if (!isRemoteUpdate.current && (update.docChanged || userMarkChange)) {
            /** @type {any[]} */
            const changes = [];
            if (update.docChanged) {
              update.changes.iterChanges((/** @type {any} */ fromA, /** @type {any} */ toA, /** @type {any} */ fromB, /** @type {any} */ toB, /** @type {any} */ inserted) => {
                changes.push({ from: fromA, to: toA, insert: inserted.toString() });
              });
            }
            // Collect TC mark effects (excluding setTcMarks — that's
            // hydration-only and shouldn't broadcast).
            /** @type {any[]} */
            const added = [];
            /** @type {any[]} */
            const removed = [];
            for (const tr of update.transactions) {
              for (const e of tr.effects) {
                if (e.is(addTcMarks)) {
                  for (const spec of e.value) added.push(spec);
                } else if (e.is(removeTcMark)) {
                  removed.push(e.value);
                }
              }
            }
            const tcMarks = added.length > 0 || removed.length > 0
              ? { added, removed }
              : undefined;
            if (changes.length > 0 || tcMarks) {
              onChangesRef.current?.(changes, /* isTracked= */ false, /* deletions= */ undefined, tcMarks);
            }
          }

          if (update.docChanged || userMarkChange) {
            const content = update.state.doc.toString();
            clearTimeout(saveTimeout.current);
            const fileIdAtEdit = file?.id;
            saveTimeout.current = setTimeout(() => {
              const v = viewRef.current;
              const marks = v ? serializeMarks(v.state) : [];
              onSaveRef.current(content, fileIdAtEdit, marks);
            }, 1000);
          }

          if (update.docChanged) {

            // Hide comment button if doc changed
            setCommentBtn(null);

            // Update table and figure gutter markers
            updateTableGutterMarkers(update.view);
            updateFigureGutterMarkers(update.view);

            // Debounced lint (client-side only; server-side runs on compile)
            if (file?.path?.endsWith('.tex') || file?.path?.endsWith('.bib')) {
              clearTimeout(lintTimeout.current);
              lintTimeout.current = setTimeout(() => {
                const v = viewRef.current;
                if (!v) return;
                const docStr = v.state.doc.toString();
                const isBib = file.path.endsWith('.bib');
                const diagnostics = isBib ? bibtexLint(docStr) : latexLint(docStr);
                applyLintDiagnostics(v, diagnostics);
                setLintDiags(diagnostics);
                if (!isBib) onLintDiagnosticsRef.current?.(diagnostics);
              }, 1000);
            }

            // Debounced spellcheck (skip .bib files; skip when disabled).
            if (!file?.path?.endsWith('.bib') && spellcheckEnabledRef.current) {
              clearTimeout(spellTimeout.current);
              spellTimeout.current = setTimeout(async () => {
                const v = viewRef.current;
                if (!v) return;
                if (!dictRef.current) dictRef.current = await getDictionary();
                if (!dictRef.current) return;
                const docStr = v.state.doc.toString();
                const misspelled = spellcheckText(docStr, dictRef.current);
                applySpellcheck(v, misspelled);
              }, 1500);
            }
          }
          const sel = update.state.selection.main;
          // Persist cursor position for restore on reload
          const fid = file?.id;
          if (fid) sessionStorage.setItem(`flowtex-cursor-${fid}`, String(sel.head));
          if (sel.from !== sel.to) {
            // Show comment button near selection end
            const coords = update.view.coordsAtPos(sel.to);
            const containerRect = update.view.dom.closest('.editor-container')?.getBoundingClientRect();
            if (coords && containerRect) {
              setCommentBtn({
                x: coords.right - containerRect.left,
                y: coords.bottom - containerRect.top + 4,
                from: sel.from,
                to: sel.to,
              });
            }
          } else {
            // Collapsed selection — hide button
            setCommentBtn(null);
          }
          // Detect if cursor is inside \hl{...}
          const doc = update.state.doc.toString();
          const pos = sel.head;
          let inHl = false;
          const hlSearch = doc.lastIndexOf('\\hl{', pos);
          if (hlSearch !== -1) {
            const closeIdx = findMatchingBrace(doc, hlSearch + 3);
            if (closeIdx !== -1 && pos >= hlSearch + 4 && pos <= closeIdx) inHl = true;
          }
          setCursorInHl(inHl);

          const line = update.state.doc.lineAt(sel.head).number;
          onLineChangeRef.current?.(line);

          if (update.selectionSet && !isRemoteUpdate.current) {
            onCursorChangeRef.current?.(sel.head, sel.anchor);
            vmToolbarRef.current?.refresh();
            // Update table builder if open and cursor moved to a different table
            if (tableBuilderRef.current) {
              clearTimeout(tableBuilderUpdateTimeout.current);
              const view = update.view;
              tableBuilderUpdateTimeout.current = setTimeout(() => {
                const parsed = findTableAtCursor(view, projectFilesRef.current);
                if (parsed) {
                  const prev = tableBuilderRef.current;
                  if (prev && (parsed.from !== prev.replaceFrom || parsed.to !== prev.replaceTo)) {
                    const doc = view.state.doc.toString();
                    const multiColumn = /\\documentclass\[[^\]]*twocolumn/.test(doc) || /\\begin\{multicols\}/.test(doc);
                    setTableBuilder({ initial: parsed, replaceFrom: parsed.from, replaceTo: parsed.to, multiColumn });
                  }
                }
              }, 200);
            }
          }
        }),
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-s',
              run: (view) => {
                clearTimeout(saveTimeout.current);
                const content = view.state.doc.toString();
                onSaveRef.current(content, file?.id, serializeMarks(view.state));
                onCompileRef.current?.();
                return true;
              },
            },
            {
              key: 'Mod-f',
              run: () => {
                setShowSearch(true);
                return true;
              },
            },
            {
              key: 'Mod-Shift-v',
              run: () => {
                onToggleVisualModeRef.current?.();
                return true;
              },
            },
            {
              key: 'Enter',
              run: (view) => {
                if (!visualModeRef.current) return false;
                const { from, to } = view.state.selection.main;
                const doc = view.state.doc;

                // Headings and single-line metadata commands cannot contain newlines.
                // If the cursor is collapsed inside one's braces, close it off and drop
                // to a new paragraph. Cursor outside the braces falls through to default.
                if (from === to) {
                  const text = doc.toString();
                  const HEADING_RE = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph|title|subtitle|author|date|email|institution|department|city|country|state|streetaddress|postcode)\*?\s*(?:\[[^\]]*\]\s*)?\{/g;
                  const winStart = Math.max(0, from - 2000);
                  const winEnd = Math.min(text.length, from + 2000);
                  const window = text.slice(winStart, winEnd);
                  let m;
                  while ((m = HEADING_RE.exec(window)) !== null) {
                    const cmdStart = winStart + m.index;
                    if (cmdStart > from) break;
                    const contentFrom = cmdStart + m[0].length;
                    const j = findMatchingBrace(text, contentFrom - 1);
                    if (j === -1) continue;
                    // Trigger only when the cursor is strictly inside the {…}.
                    if (from >= contentFrom && from <= j) {
                      // Always insert a newline after the closing `}` so the
                      // user gets the same visible feedback as pressing Enter
                      // anywhere else. If a newline already follows, this
                      // becomes a blank-line paragraph break — desired.
                      const afterBrace = j + 1;
                      view.dispatch({
                        changes: { from: afterBrace, to: afterBrace, insert: '\n' },
                        selection: { anchor: afterBrace + 1 },
                        scrollIntoView: true,
                      });
                      return true;
                    }
                  }
                }

                const line = doc.lineAt(from);

                // Find the innermost list env the cursor is inside
                const innerEnv = findInnermostListEnv(doc, from);
                if (!innerEnv) return false;

                // Current line has \item?
                if (!/\\item\b/.test(line.text)) return false;

                // Empty item → pop out one level (or exit list at outermost)
                if (/^\s*\\item\s*$/.test(line.text)) {
                  const envEndTag = `\\end{${innerEnv.env}}`;
                  const envContent = doc.sliceString(innerEnv.beginPos, innerEnv.endPos + envEndTag.length);
                  const itemCount = (envContent.match(/\\item\b/g) || []).length;

                  if (innerEnv.depth === 0) {
                    // ── Outermost list: exit the environment ──
                    if (itemCount <= 1) {
                      // Only item — remove entire environment, cursor after it
                      const fullFrom = innerEnv.beginPos;
                      const fullTo = innerEnv.endPos + envEndTag.length;
                      const adjFrom = fullFrom > 0 && doc.sliceString(fullFrom - 1, fullFrom) === '\n' ? fullFrom - 1 : fullFrom;
                      const adjTo = fullTo < doc.length && doc.sliceString(fullTo, fullTo + 1) === '\n' ? fullTo + 1 : fullTo;
                      view.dispatch({
                        changes: { from: adjFrom, to: adjTo, insert: '' },
                        selection: { anchor: Math.min(adjFrom, doc.length - (adjTo - adjFrom)) },
                      });
                    } else {
                      // Multiple items — remove the empty item, cursor after \end{env}
                      const removeFrom = line.from > 0 ? line.from - 1 : line.from;
                      const removedLen = line.to - removeFrom;
                      const afterEnd = innerEnv.endPos + envEndTag.length - removedLen;
                      view.dispatch({
                        changes: { from: removeFrom, to: line.to, insert: '' },
                      });
                      // Place cursor after \end{env} (on the next line or at end)
                      const newDoc = view.state.doc;
                      const cursorPos = Math.min(afterEnd, newDoc.length);
                      view.dispatch({ selection: { anchor: cursorPos } });
                    }
                  } else {
                    // ── Nested list: pop back to parent level ──
                    if (itemCount <= 1) {
                      // Only item in nested env — remove entire nested env,
                      // insert a new \item at the parent level
                      const fullFrom = innerEnv.beginPos;
                      const fullTo = innerEnv.endPos + envEndTag.length;
                      const adjFrom = fullFrom > 0 && doc.sliceString(fullFrom - 1, fullFrom) === '\n' ? fullFrom - 1 : fullFrom;
                      const adjTo = fullTo < doc.length && doc.sliceString(fullTo, fullTo + 1) === '\n' ? fullTo + 1 : fullTo;
                      const parentIndent = '  '.repeat(innerEnv.depth);
                      const newItem = `\n${parentIndent}\\item `;
                      view.dispatch({
                        changes: { from: adjFrom, to: adjTo, insert: newItem },
                        selection: { anchor: adjFrom + newItem.length },
                      });
                    } else {
                      // Multiple items in nested env — remove empty item,
                      // insert a new \item after the \end{env} at parent level
                      const removeFrom = line.from > 0 ? line.from - 1 : line.from;
                      const removedLen = line.to - removeFrom;
                      const afterEnd = innerEnv.endPos + envEndTag.length;
                      const parentIndent = '  '.repeat(innerEnv.depth);
                      const newItem = `\n${parentIndent}\\item `;
                      // afterEnd is in original doc; shifts back by removedLen
                      const adjEnd = afterEnd - removedLen;
                      view.dispatch({ changes: { from: removeFrom, to: line.to } });
                      view.dispatch({
                        changes: { from: adjEnd, to: adjEnd, insert: newItem },
                        selection: { anchor: adjEnd + newItem.length },
                      });
                    }
                  }
                  return true;
                }

                // Non-empty item → insert new \item
                const indent = '  '.repeat(innerEnv.depth + 1);
                const insert = `\n${indent}\\item `;
                view.dispatch({
                  changes: { from, insert },
                  selection: { anchor: from + insert.length },
                });
                return true;
              },
            },
            {
              key: 'Tab',
              run: (view) => {
                if (!visualModeRef.current) return false;
                const { from } = view.state.selection.main;
                const doc = view.state.doc;
                const line = doc.lineAt(from);

                // Must be on a \item line
                if (!/\\item\b/.test(line.text)) return false;

                const innerEnv = findInnermostListEnv(doc, from);
                if (!innerEnv) return false;

                // Must NOT be the first \item in this env
                const contentBeforeItem = doc.sliceString(innerEnv.beginPos, line.from);
                if (!/\\item\b/.test(contentBeforeItem)) return false; // first item

                // Extract the current \item line content (text after \item)
                const itemMatch = line.text.match(/^(\s*)\\item\s*(.*)/);
                if (!itemMatch) return false;
                const itemContent = itemMatch[2];

                // Wrap this line in a nested sub-environment of the same type
                const subEnv = innerEnv.env;
                const indent = '  '.repeat(innerEnv.depth + 1);
                const subIndent = '  '.repeat(innerEnv.depth + 2);
                const replacement = `${indent}\\begin{${subEnv}}\n${subIndent}\\item ${itemContent}\n${indent}\\end{${subEnv}}`;

                const cursorPos = line.from + indent.length + `\\begin{${subEnv}}\n`.length + subIndent.length + '\\item '.length + itemContent.length;

                view.dispatch({
                  changes: { from: line.from, to: line.to, insert: replacement },
                  selection: { anchor: cursorPos },
                });
                return true;
              },
            },
            {
              key: 'Shift-Tab',
              run: (view) => {
                if (!visualModeRef.current) return false;
                const { from } = view.state.selection.main;
                const doc = view.state.doc;
                const line = doc.lineAt(from);

                if (!/\\item\b/.test(line.text)) return false;

                const innerEnv = findInnermostListEnv(doc, from);
                if (!innerEnv || innerEnv.depth < 1) return false; // not nested

                // Extract item content
                const itemMatch = line.text.match(/^(\s*)\\item\s*(.*)/);
                if (!itemMatch) return false;
                const itemContent = itemMatch[2];

                // Check if this is the only \item in the inner env
                const envEndTag = `\\end{${innerEnv.env}}`;
                const envContent = doc.sliceString(innerEnv.beginPos, innerEnv.endPos + envEndTag.length);
                const items = envContent.match(/\\item\b/g) || [];
                const parentIndent = '  '.repeat(innerEnv.depth);

                if (items.length <= 1) {
                  // Only item — remove the entire nested env, replace with \item at parent level
                  const fullFrom = innerEnv.beginPos;
                  const fullTo = innerEnv.endPos + envEndTag.length;
                  const adjFrom = fullFrom > 0 && doc.sliceString(fullFrom - 1, fullFrom) === '\n' ? fullFrom - 1 : fullFrom;
                  const adjTo = fullTo < doc.length && doc.sliceString(fullTo, fullTo + 1) === '\n' ? fullTo + 1 : fullTo;
                  const replacement = `\n${parentIndent}\\item ${itemContent}`;
                  view.dispatch({
                    changes: { from: adjFrom, to: adjTo, insert: replacement },
                    selection: { anchor: adjFrom + replacement.length },
                  });
                } else {
                  // Multiple items — remove this line and insert after \end{env}
                  const removeFrom = line.from > 0 ? line.from - 1 : line.from;
                  const removedLen = line.to - removeFrom;
                  const afterEnvEnd = innerEnv.endPos + envEndTag.length;
                  const insertText = `\n${parentIndent}\\item ${itemContent}`;
                  // afterEnvEnd is in original doc; after removing earlier text it shifts back
                  const adjEnd = afterEnvEnd - removedLen;
                  // Apply as two sequential dispatches to keep it simple
                  view.dispatch({ changes: { from: removeFrom, to: line.to } });
                  view.dispatch({
                    changes: { from: adjEnd, to: adjEnd, insert: insertText },
                    selection: { anchor: adjEnd + insertText.length },
                  });
                }
                return true;
              },
            },
          ]),
        ),
        commentCompartment.current.of(commentHighlighter(comments || [])),
        EditorView.theme({
          '&': { height: '100%', fontSize: '14px', backgroundColor: '#ffffff' },
          '.cm-scroller': { overflow: 'auto' },
          '.cm-content': { color: '#1e1e1e' },
          '.tok-comment': { color: '#4078c0 !important', fontStyle: 'italic' },
          '.cm-gutters': { backgroundColor: '#f0f0f0', color: '#888', borderRight: '1px solid #ddd' },
          '.cm-lint-gutter': {
            width: '14px',
            borderRight: 'none',
          },
          '.cm-lint-gutter .cm-gutterElement': {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0',
          },
          '.cm-lint-gutter-error': {
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: '#e03131',
            display: 'inline-block',
            cursor: 'pointer',
          },
          '.cm-lint-gutter-warning': {
            display: 'inline-block',
            width: '0',
            height: '0',
            borderLeft: '4px solid transparent',
            borderRight: '4px solid transparent',
            borderBottom: '7px solid #e8a300',
            cursor: 'pointer',
          },
          '.cm-spell-gutter': {
            width: '10px',
            borderRight: 'none',
          },
          '.cm-spell-gutter .cm-gutterElement': {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0',
          },
          '.cm-spell-gutter-marker': {
            display: 'inline-block',
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            backgroundColor: '#5c7cfa',
            cursor: 'pointer',
          },
          '.cm-table-gutter': {
            width: '16px',
            borderRight: 'none',
          },
          '.cm-table-gutter .cm-gutterElement': {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0',
          },
          '.cm-table-gutter-marker': {
            display: 'inline-flex',
            cursor: 'pointer',
            opacity: '0.4',
            transition: 'opacity 0.15s',
          },
          '.cm-table-gutter-marker:hover': {
            opacity: '1',
          },
          '.cm-activeLineGutter': { backgroundColor: '#f0f0f0' },
          '.cm-activeLine': { backgroundColor: 'transparent' },
          '.cm-cursor': { borderLeftColor: '#1e1e1e' },
          '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: '#b3d7ff' },
          '&.cm-focused': { outline: 'none' },
          '.cm-comment-highlight': {
            backgroundColor: 'rgba(255, 213, 79, 0.3)',
            borderBottom: '2px solid #ffd54f',
          },
          '.cm-error-highlight': {
            backgroundColor: 'rgba(255, 213, 79, 0.3)',
            borderBottom: '2px solid #ffd54f',
          },
          '.cm-search-match': {
            backgroundColor: 'rgba(255, 213, 79, 0.35)',
            borderRadius: '2px',
          },
          '.cm-search-match-current': {
            backgroundColor: 'rgba(255, 152, 0, 0.5)',
            borderRadius: '2px',
          },
          '.cm-lint-warning': {
            backgroundColor: 'rgba(249, 226, 175, 0.15)',
            borderBottom: '1px wavy #f9e2af',
          },
          '.cm-lint-error': {
            backgroundColor: 'rgba(243, 139, 168, 0.15)',
            borderBottom: '1px wavy #f38ba8',
          },
          '.cm-spell-error': {
            borderBottom: '2px dotted #e03131',
          },
          '.cm-remote-cursor': {
            position: 'relative',
            borderLeft: '2px solid',
            marginLeft: '-1px',
            marginRight: '-1px',
          },
          '.cm-remote-cursor-label': {
            position: 'absolute',
            top: '-1.4em',
            left: '-1px',
            fontSize: '10px',
            padding: '0 4px',
            borderRadius: '3px 3px 3px 0',
            color: '#fff',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            lineHeight: '1.4',
          },
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    // Hydrate the TC sidecar from the file row, if present. The
    // StateField validates entries against the loaded doc length and
    // drops invalid ones (§6.5). The skip annotation prevents the
    // input filter from re-tracking the seeding (§6.2).
    const initialMarks = Array.isArray(file?.tc_marks) ? file.tc_marks : [];
    if (initialMarks.length > 0) {
      view.dispatch({
        effects: setTcMarks.of(deserializeMarks(initialMarks)),
        annotations: tcMarkSkipAnnotation.of(true),
      });
    }

    // Initial table and figure gutter markers
    updateTableGutterMarkers(view);
    updateFigureGutterMarkers(view);

    // Restore saved cursor position for this file
    const cursorKey = `flowtex-cursor-${file.id}`;
    const savedCursor = sessionStorage.getItem(cursorKey);
    if (savedCursor) {
      const pos = Math.min(parseInt(savedCursor, 10), view.state.doc.length);
      if (pos > 0) {
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: 'center' }),
        });
      }
    }

    // Broadcast initial cursor position so other users can jump to us
    const initialSel = view.state.selection.main;
    onCursorChangeRef.current?.(initialSel.head, initialSel.anchor);

    const handleScroll = () => onScrollRef.current?.();
    view.scrollDOM.addEventListener('scroll', handleScroll);

    // Fire initial scroll to position comments
    setTimeout(handleScroll, 50);

    // Run initial lint + spellcheck
    if (file?.path?.endsWith('.tex') || file?.path?.endsWith('.bib')) {
      setTimeout(() => {
        const v = viewRef.current;
        if (!v) return;
        const docStr = v.state.doc.toString();
        const isBib = file.path.endsWith('.bib');
        const diagnostics = isBib ? bibtexLint(docStr) : latexLint(docStr);
        applyLintDiagnostics(v, diagnostics);
        setLintDiags(diagnostics);
        if (!isBib) onLintDiagnosticsRef.current?.(diagnostics);
      }, 300);
    }
    // Initial spellcheck (skip .bib files; skip when disabled).
    if (!file?.path?.endsWith('.bib') && spellcheckEnabledRef.current) {
      setTimeout(async () => {
        const v = viewRef.current;
        if (!v) return;
        if (!dictRef.current) dictRef.current = await getDictionary();
        if (!dictRef.current) return;
        const misspelled = spellcheckText(v.state.doc.toString(), dictRef.current);
        applySpellcheck(v, misspelled);
      }, 800);
    }

    // Flush pending save immediately (e.g. on file switch or unmount).
    // Pin the save to *this* file's id — by the time this cleanup runs on a
    // file switch, React may have already updated `activeFile` to the new
    // file. Without pinning, the old file's content gets written to the new
    // file's row.
    const flushPendingSave = () => {
      if (saveTimeout.current) {
        clearTimeout(saveTimeout.current);
        saveTimeout.current = null;
        const v = viewRef.current;
        if (v) {
          const content = v.state.doc.toString();
          onSaveRef.current?.(content, file?.id, serializeMarks(v.state));
        }
      }
    };

    // Table gutter click: open table builder
    const handleOpenTableBuilder = () => {
      const v = viewRef.current;
      if (!v) return;
      const doc = v.state.doc.toString();
      const multiColumn = /\\documentclass\[[^\]]*twocolumn/.test(doc) || /\\begin\{multicols\}/.test(doc);
      const parsed = findTableAtCursor(v, projectFilesRef.current);
      if (parsed) {
        setTableBuilder({ initial: parsed, replaceFrom: parsed.from, replaceTo: parsed.to, multiColumn });
      } else {
        setTableBuilder({ multiColumn });
      }
    };
    view.dom.addEventListener('open-table-builder', handleOpenTableBuilder);

    // Figure gutter click: open figure builder
    const handleOpenFigureBuilder = () => {
      const v = viewRef.current;
      if (!v) return;
      const parsed = findFigureAtCursor(v);
      if (parsed) {
        setFigureBuilder({ initial: parsed, replaceFrom: parsed.from, replaceTo: parsed.to });
      } else {
        setFigureBuilder({});
      }
    };
    view.dom.addEventListener('open-figure-builder', handleOpenFigureBuilder);

    // Save on page reload/close so DB content stays in sync with TC positions
    const handleBeforeUnload = () => flushPendingSave();
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      view.dom.removeEventListener('open-table-builder', handleOpenTableBuilder);
      view.dom.removeEventListener('open-figure-builder', handleOpenFigureBuilder);
      flushPendingSave();
      view.scrollDOM.removeEventListener('scroll', handleScroll);
      clearTimeout(lintTimeout.current);
      clearTimeout(spellTimeout.current);
      clearTimeout(errorHighlightTimer.current);
      clearTimeout(tableBuilderUpdateTimeout.current);
      // eslint-disable-next-line react-hooks/exhaustive-deps
      clearTimeout(figureBuilderUpdateTimeout.current);
      view.destroy();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  // Re-run spellcheck when language changes (skip .bib files; skip if disabled).
  useEffect(() => {
    if (file?.path?.endsWith('.bib')) return;
    if (!spellcheckEnabled) return;
    const run = async () => {
      const v = viewRef.current;
      if (!v) return;
      dictRef.current = await getDictionary();
      if (!dictRef.current) return;
      const misspelled = spellcheckText(v.state.doc.toString(), dictRef.current);
      applySpellcheck(v, misspelled);
    };
    run();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spellLang, spellcheckEnabled]);

  // Toggle effect: when the user flips spellcheck on/off, persist + apply.
  // Disabled → clear all spellcheck decorations immediately. Enabled → run
  // a fresh pass.
  const spellcheckEnabledRef = useRef(spellcheckEnabled);
  spellcheckEnabledRef.current = spellcheckEnabled;
  useEffect(() => {
    setSetting('spellcheck-enabled', spellcheckEnabled);
    const v = viewRef.current;
    if (!v) return;
    if (!spellcheckEnabled) {
      applySpellcheck(v, []); // clear underlines + gutter dots
      return;
    }
    if (file?.path?.endsWith('.bib')) return;
    (async () => {
      if (!dictRef.current) dictRef.current = await getDictionary();
      if (!dictRef.current) return;
      const misspelled = spellcheckText(v.state.doc.toString(), dictRef.current);
      applySpellcheck(v, misspelled);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spellcheckEnabled]);

  useClickOutside(
    spellMenuRef,
    useCallback(() => setSpellMenu(null), []),
    !!spellMenu,
  );

  useClickOutside(
    tcMenuRef,
    useCallback(() => setTcMenu(null), []),
    !!tcMenu,
  );

  useClickOutside(
    citeMenuRef,
    useCallback(() => setCiteMenu(null), []),
    !!citeMenu,
  );

  useClickOutside(
    llmMenuRef,
    useCallback(() => setLlmMenu(null), []),
    !!llmMenu,
  );

  const swapCiteVariant = useCallback((/** @type {any} */ newName) => {
    const v = viewRef.current;
    if (!v || !citeMenu) return;
    const replacement = `\\${newName}${citeMenu.opt}{${citeMenu.key}}`;
    v.dispatch({
      changes: { from: citeMenu.from, to: citeMenu.to, insert: replacement },
      selection: { anchor: citeMenu.from + replacement.length },
    });
    setCiteMenu(null);
    v.focus();
  }, [citeMenu]);

  // Update comment decorations without recreating editor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: commentCompartment.current.reconfigure(commentHighlighter(comments || [])),
    });
  }, [comments]);

  // Toggle word wrap
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wrapCompartment.current.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    });
  }, [wordWrap]);

  // Reconfigure read-only when the user's role changes mid-session
  // (e.g. owner downgrades them mid-edit, they're removed and added
  // back as a commenter). State-level readOnly blocks every mutating
  // transaction but keeps the caret live so the user can still see
  // and move their cursor; see the initial-state comment for why we
  // don't combine this with EditorView.editable.of(false).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  // Toggle visual mode
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: visualModeCompartment.current.reconfigure(visualMode ? visualModeExtension(projectFiles, citeKeys) : []),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visualMode]);

  // Toggle inline TC decorations (Word-style "Display for Review").
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: tcInlineCompartment.current.reconfigure(showTrackedChangesInline ? tcMarksInlineDecorations : []),
    });
  }, [showTrackedChangesInline]);

  // YJS-MIGRATION phase 1.5: when extraExtensions changes (typically
  // when useYjsSync's binding finishes constructing), splice the new
  // extension array into the Compartment without rebuilding the
  // EditorState.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: extraExtCompartment.current.reconfigure(extraExtensions || []),
    });
  }, [extraExtensions]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: fontSizeCompartment.current.reconfigure(
        EditorView.theme({
          '.cm-content': { fontSize: fontSize + 'px' },
          '.cm-gutters': { fontSize: fontSize + 'px' },
        }),
      ),
    });
    setSetting('font-size', fontSize);
  }, [fontSize]);

  // Toggle line numbers via CSS class
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.classList.toggle('hide-line-numbers', !showLineNumbers);
  }, [showLineNumbers]);

  const handleCommentBtnClick = () => {
    if (commentBtn) {
      onRequestCommentRef.current?.({ from: commentBtn.from, to: commentBtn.to });
      setCommentBtn(null);
    }
  };

  // Toggle \hl{…} highlight on the current selection (or cursor inside an existing \hl{…}).
  // Cases handled: outer \hl{…} immediately wrapping selection, selection that *is* an \hl{…},
  // bare cursor inside an enclosing \hl{…}, otherwise wrap the selection.
  const handleHighlightToggle = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    const before = view.state.sliceDoc(Math.max(0, from - 4), from);
    const after = view.state.sliceDoc(to, to + 1);
    if (before === '\\hl{' && after === '}') {
      view.dispatch({
        changes: [
          { from: from - 4, to: from, insert: '' },
          { from: to, to: to + 1, insert: '' },
        ],
        selection: { anchor: from - 4, head: from - 4 + selected.length },
      });
    } else if (selected.startsWith('\\hl{') && selected.endsWith('}')) {
      const inner = selected.slice(4, -1);
      view.dispatch({
        changes: { from, to, insert: inner },
        selection: { anchor: from + inner.length },
      });
    } else if (cursorInHl && from === to) {
      const doc = view.state.doc.toString();
      const hlStart = doc.lastIndexOf('\\hl{', from);
      if (hlStart !== -1) {
        const i = findMatchingBrace(doc, hlStart + 3);
        if (i !== -1) {
          const inner = doc.slice(hlStart + 4, i);
          view.dispatch({
            changes: { from: hlStart, to: i + 1, insert: inner },
            selection: { anchor: hlStart + inner.length },
          });
        }
      }
    } else {
      const insert = '\\hl{' + selected + '}';
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
      });
    }
    view.focus();
  }, [cursorInHl]);

  // Insert a generated table from the table builder (replaces existing range if editing).
  const handleTableBuilderInsert = useCallback((/** @type {any} */ table) => {
    const view = viewRef.current;
    if (!view || !tableBuilder) return;
    const from = tableBuilder.replaceFrom != null ? tableBuilder.replaceFrom : view.state.selection.main.from;
    const to = tableBuilder.replaceTo != null ? tableBuilder.replaceTo : view.state.selection.main.to;
    view.dispatch({ changes: { from, to, insert: table } });
    view.focus();
  }, [tableBuilder]);

  if (!file) {
    return <div className="editor-placeholder">Select a file to edit</div>;
  }

  return (
    <div className="editor-wrapper">
      <div className="editor-header">
        <span className="editor-header-filename">{file.path}</span>
        {onToggleAutoSave && (
          <button
            className={`editor-header-tc-btn ${autoSaveOn ? 'editor-header-autosave-active' : ''}`}
            onClick={onToggleAutoSave}
            title={
              autoSaveOn ? autoSaveLabel || 'GitHub Sync ON — click to disable' : 'Click to set up GitHub Sync'
            }
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 4, verticalAlign: -2 }}>
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
            </svg>
            <SyncIcon size={14} style={{ marginLeft: 2 }} />
          </button>
        )}
        <button className="editor-header-btn" onClick={() => cmUndo(viewRef.current)} title="Undo (Cmd+Z)">
          <UndoIcon />
        </button>
        <button className="editor-header-btn" onClick={() => cmRedo(viewRef.current)} title="Redo (Cmd+Shift+Z)">
          <RedoIcon />
        </button>
        <span className="editor-zoom-controls">
          <button className="editor-header-btn" onClick={() => setFontSize((/** @type {any} */ s) => Math.max(8, s - 1))} title="Zoom out">
            <ZoomOutIcon />
          </button>
          <span className="editor-zoom-label" title="Font size">
            {fontSize}px
          </span>
          <button className="editor-header-btn" onClick={() => setFontSize((/** @type {any} */ s) => Math.min(32, s + 1))} title="Zoom in">
            <ZoomInIcon />
          </button>
        </span>
        <button className="editor-header-btn" onClick={() => setShowSearch(true)} title="Find & Replace (Cmd+F)">
          <SearchIcon />
        </button>
        <button
          className={`editor-header-btn ${tableBuilder ? 'editor-header-btn-active' : ''}`}
          onClick={() => {
            if (tableBuilder) {
              setTableBuilder(null);
              return;
            }
            const view = viewRef.current;
            if (!view) {
              setTableBuilder({});
              return;
            }
            const doc = view.state.doc.toString();
            const multiColumn = /\\documentclass\[[^\]]*twocolumn/.test(doc) || /\\begin\{multicols\}/.test(doc);
            const parsed = findTableAtCursor(view, projectFilesRef.current);
            if (parsed) {
              setTableBuilder({ initial: parsed, replaceFrom: parsed.from, replaceTo: parsed.to, multiColumn });
            } else {
              setTableBuilder({ multiColumn });
            }
          }}
          title="Insert table"
        >
          <TableIcon />
        </button>
        <button
          className={`editor-header-btn ${figureBuilder ? 'editor-header-btn-active' : ''}`}
          onClick={() => {
            if (figureBuilder) {
              setFigureBuilder(null);
              return;
            }
            const view = viewRef.current;
            if (!view) {
              setFigureBuilder({});
              return;
            }
            const parsed = findFigureAtCursor(view);
            if (parsed) {
              setFigureBuilder({ initial: parsed, replaceFrom: parsed.from, replaceTo: parsed.to });
            } else {
              setFigureBuilder({});
            }
          }}
          title="Insert figure"
        >
          <FigureIcon />
        </button>
        <button
          className="editor-header-btn"
          onClick={() => setShowSymbolPicker(true)}
          title="Insert symbol"
        >
          <span style={{ fontSize: 14, fontWeight: 600, lineHeight: 1 }}>Ω</span>
        </button>
        <button
          className={`editor-header-btn ${cursorInHl ? 'editor-header-btn-active' : ''}`}
          onClick={handleHighlightToggle}
          title="Highlight text (\hl{…} — requires xcolor, soul packages)"
        >
          <HighlightIcon />
        </button>
        {onToggleTrackChanges && (
          <button
            className={`editor-header-tc-btn ${trackChangesMode ? 'editor-header-tc-active' : ''}`}
            onClick={onToggleTrackChanges}
            title={trackChangesMode ? 'Track changes ON — click to disable' : 'Track changes OFF — click to enable'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="8" y1="13" x2="16" y2="13" stroke="#e06c75" strokeWidth="2" />
              <line x1="8" y1="17" x2="13" y2="17" stroke="#61afef" strokeWidth="2" />
            </svg>
          </button>
        )}
        <button
          className={`editor-header-btn ${spellcheckEnabled ? 'editor-header-btn-active' : ''}`}
          onClick={() => setSpellcheckEnabled((/** @type {any} */ v) => !v)}
          title={spellcheckEnabled ? 'Spellcheck ON — click to disable' : 'Spellcheck OFF — click to enable'}
          aria-pressed={spellcheckEnabled}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {/* Page with check mark — universal "spellcheck" icon */}
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <polyline points="9 14 11 16 15 12" stroke={spellcheckEnabled ? '#2ea043' : 'currentColor'} strokeWidth="2.5" />
          </svg>
        </button>
        <button
          className={`editor-header-btn ${inverted ? 'editor-header-btn-active' : ''}`}
          onClick={() =>
            setInverted((/** @type {any} */ v) => {
              const n = !v;
              setSetting('editor-inverted', n);
              return n;
            })
          }
          title="Invert colors"
        >
          <ContrastIcon />
        </button>
      </div>
      {showSymbolPicker && (
        <SymbolPicker
          declaredPackages={declaredPackages}
          onInsert={(/** @type {any} */ cmd) => {
            const view = viewRef.current;
            if (!view) return;
            const { from, to } = view.state.selection.main;
            view.dispatch({ changes: { from, to, insert: cmd } });
            view.focus();
          }}
          onClose={() => setShowSymbolPicker(false)}
        />
      )}
      {tableBuilder && (
        <TableGridPicker
          key={`${tableBuilder.replaceFrom ?? 'new'}-${tableBuilder.replaceTo ?? 'new'}`}
          initial={tableBuilder.initial}
          multiColumn={tableBuilder.multiColumn}
          declaredPackages={declaredPackages}
          onInsert={handleTableBuilderInsert}
          onClose={() => setTableBuilder(null)}
          onDelete={tableBuilder.replaceFrom != null ? () => {
            const view = viewRef.current;
            if (view) {
              view.dispatch({ changes: { from: tableBuilder.replaceFrom, to: tableBuilder.replaceTo, insert: '' } });
              view.focus();
            }
            setTableBuilder(null);
          } : null}
        />
      )}
      {figureBuilder && (
        <FigureBuilder
          key={`fig-${figureBuilder.replaceFrom ?? 'new'}-${figureBuilder.replaceTo ?? 'new'}`}
          initial={figureBuilder.initial}
          projectFiles={projectFilesRef.current}
          declaredPackages={declaredPackages}
          onInsert={(/** @type {any} */ latex) => {
            const view = viewRef.current;
            if (view) {
              const from = figureBuilder.replaceFrom != null ? figureBuilder.replaceFrom : view.state.selection.main.from;
              const to = figureBuilder.replaceTo != null ? figureBuilder.replaceTo : view.state.selection.main.to;
              view.dispatch({ changes: { from, to, insert: latex } });
              view.focus();
            }
          }}
          onClose={() => setFigureBuilder(null)}
          onDelete={figureBuilder.replaceFrom != null ? () => {
            const view = viewRef.current;
            if (view) {
              view.dispatch({ changes: { from: figureBuilder.replaceFrom, to: figureBuilder.replaceTo, insert: '' } });
              view.focus();
            }
            setFigureBuilder(null);
          } : null}
        />
      )}
      {file?.path?.endsWith('.bib') && lintDiags.length > 0 && (
        <div className="bib-lint-banner">
          {lintDiags.length} field {lintDiags.length !== 1 ? 'issues' : 'issue'} — check orange gutter markers
        </div>
      )}
      <VisualModeToolbar
        ref={vmToolbarRef}
        viewRef={viewRef}
        visualMode={visualMode}
        onInsertList={vmInsertList}
        onInsertQuote={vmInsertQuote}
        citeKeys={citeKeys}
      />
      <div className={`editor-container ${inverted ? 'editor-inverted' : ''}`} ref={containerRef} />
      {showSearch && viewRef.current && (
        <SearchPanel
          view={viewRef.current}
          onClose={() => setShowSearch(false)}
          projectFiles={projectFilesRef.current}
          onGoToFile={onGoToFileRef.current}
          setSearchHighlightEffect={setSearchHighlightEffect}
        />
      )}
      {commentBtn && (
        <button
          className="editor-comment-btn"
          style={{ left: commentBtn.x, top: commentBtn.y }}
          onMouseDown={(/** @type {any} */ e) => e.preventDefault()}
          onClick={handleCommentBtnClick}
        >
          + Comment
        </button>
      )}
      {llmMenu && (
        <div
          ref={llmMenuRef}
          className="cite-context-menu"
          style={{ position: 'fixed', left: llmMenu.x, top: llmMenu.y, zIndex: 1000 }}
        >
          <div className="cite-context-header">
            <span className="cite-context-cmd">Local LLM</span>
          </div>
          {Object.entries(LLM_TASKS)
            .filter(([taskKey]) => !llmSupportedTasks || llmSupportedTasks.includes(taskKey))
            .map(([taskKey, spec]) => (
              <button
                key={taskKey}
                className="cite-context-item"
                onMouseDown={(/** @type {any} */ e) => e.preventDefault()}
                onClick={() => {
                  setLlmDialog({ from: llmMenu.from, to: llmMenu.to, text: llmMenu.text, task: taskKey });
                  setLlmMenu(null);
                }}
              >
                <span className="cite-context-item-label">{spec.label}</span>
                <span className="cite-context-item-hint">{spec.hint}</span>
              </button>
            ))}
        </div>
      )}
      {llmDialog && (
        <Suspense fallback={null}>
          <LlmActionDialog
            task={llmDialog.task}
            initialText={llmDialog.text}
            onClose={() => setLlmDialog(null)}
            onAccept={(/** @type {any} */ replacement) => {
              const v = viewRef.current;
              if (v) {
                v.dispatch({
                  changes: { from: llmDialog.from, to: llmDialog.to, insert: replacement },
                  selection: { anchor: llmDialog.from + replacement.length },
                });
                v.focus();
              }
            }}
          />
        </Suspense>
      )}
      {citeMenu && (
        <div
          ref={citeMenuRef}
          className="cite-context-menu"
          style={{ position: 'fixed', left: citeMenu.x, top: citeMenu.y, zIndex: 1000 }}
        >
          <div className="cite-context-header">
            <span className="cite-context-cmd">\{citeMenu.name}</span>
            <span className="cite-context-key">{citeMenu.key}</span>
          </div>
          {[
            { name: 'cite', label: 'Cite', hint: 'default' },
            { name: 'citep', label: '(Author, Year)', hint: 'natbib parenthetical' },
            { name: 'citet', label: 'Author (Year)', hint: 'natbib textual' },
            { name: 'parencite', label: '(Author, Year)', hint: 'biblatex parenthetical' },
            { name: 'textcite', label: 'Author (Year)', hint: 'biblatex textual' },
            { name: 'citeauthor', label: 'Author', hint: 'name only' },
            { name: 'citeyear', label: 'Year', hint: 'year only' },
          ].map((/** @type {any} */ variant) => (
            <button
              key={variant.name}
              className={`cite-context-item ${variant.name === citeMenu.name ? 'cite-context-item-current' : ''}`}
              onMouseDown={(/** @type {any} */ e) => e.preventDefault()}
              onClick={() => swapCiteVariant(variant.name)}
            >
              <span className="cite-context-item-label">{variant.label}</span>
              <span className="cite-context-item-hint">\{variant.name}{citeMenu.opt} · {variant.hint}</span>
            </button>
          ))}
        </div>
      )}
      {spellMenu && (
        <div
          ref={spellMenuRef}
          className="spell-context-menu"
          style={{ position: 'fixed', left: spellMenu.x, top: spellMenu.y, zIndex: 1000 }}
        >
          <div className="spell-context-word">
            {spellMenu.misspelled && <span className="spell-context-badge">Misspelled</span>}
            {spellMenu.word}
          </div>
          <button
            onClick={async () => {
              addToCustomDictionary(spellMenu.word);
              setSpellMenu(null);
              const v = viewRef.current;
              if (v && dictRef.current) {
                const misspelled = spellcheckText(v.state.doc.toString(), dictRef.current);
                applySpellcheck(v, misspelled);
              }
            }}
          >
            Add to dictionary
          </button>
          <button
            onClick={async () => {
              ignoreWord(spellMenu.word);
              setSpellMenu(null);
              const v = viewRef.current;
              if (v && dictRef.current) {
                const misspelled = spellcheckText(v.state.doc.toString(), dictRef.current);
                applySpellcheck(v, misspelled);
              }
            }}
          >
            Ignore
          </button>
        </div>
      )}
      {tcMenu && (
        <div
          ref={tcMenuRef}
          className="tc-context-menu"
          style={{ position: 'fixed', left: tcMenu.x, top: tcMenu.y, zIndex: 1000 }}
        >
          <div className={`tc-context-header tc-context-header-${tcMenu.type}`}>
            <span className="tc-context-type">
              {tcMenu.type === 'ins' ? 'Inserted' : 'Deleted'}
            </span>
            {tcMenu.author && <span className="tc-context-author">by {tcMenu.author}</span>}
          </div>
          <button
            onClick={() => {
              const view = viewRef.current;
              if (!view) return;
              const m = listMarks(view.state).find((/** @type {any} */ x) => x.id === tcMenu.id);
              if (!m) {
                setTcMenu(null);
                return;
              }
              // Accept-ins: keep the text, drop the mark (no doc change).
              // Accept-del: remove the marked range AND drop the mark.
              const removeRange = m.type === 'del';
              /** @type {any} */
              const spec = {
                effects: removeTcMark.of(tcMenu.id),
                annotations: tcMarkSkipAnnotation.of(true),
              };
              if (removeRange) spec.changes = { from: m.from, to: m.to, insert: '' };
              view.dispatch(spec);
              setTcMenu(null);
            }}
          >
            Accept
          </button>
          <button
            onClick={() => {
              const view = viewRef.current;
              if (!view) return;
              const m = listMarks(view.state).find((/** @type {any} */ x) => x.id === tcMenu.id);
              if (!m) {
                setTcMenu(null);
                return;
              }
              const removeRange =
                (m.type === 'ins' && true) || (m.type === 'del' && false);
              /** @type {any} */
              const spec = {
                effects: removeTcMark.of(tcMenu.id),
                annotations: tcMarkSkipAnnotation.of(true),
              };
              if (removeRange) spec.changes = { from: m.from, to: m.to, insert: '' };
              view.dispatch(spec);
              setTcMenu(null);
            }}
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
});

export default Editor;
