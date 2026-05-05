import React, { useEffect, useRef, useState, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import useClickOutside from '../hooks/useClickOutside.js';
import { EditorView, keymap, Decoration } from '@codemirror/view';
import { undo as cmUndo, redo as cmRedo, invertedEffects } from '@codemirror/commands';
import { EditorState, ChangeSet, Compartment, Prec } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { StreamLanguage, syntaxHighlighting } from '@codemirror/language';
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
  setTrackedChangesEffect,
  trackedChangesField,
  setTcDeletesEffect,
  tcDeletesField,
  isPosInDeletion,
  isPosInInsertion,
  tcInsertGutterField,
  tcDeleteGutterField,
  tcInsertGutterExtension,
  tcDeleteGutterExtension,
  buildTcInsertDecorations,
  buildTcDeleteDecorations,
  setTcReviewHighlightEffect,
  tcReviewHighlightField,
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
import { tcMarkerExtensions } from '../utils/tcMarkerDecorations.js';
import { buildTcMarkerInputFilter, tcMarkerSkipAnnotation } from '../utils/tcMarkerInput.js';
import { parseAll as parseTcMarkers } from '@shared/tcMarkers.js';
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
  ReviewEyeIcon,
  ContrastIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SyncIcon,
  HighlightIcon,
} from './Icons.jsx';

/** CodeMirror-based LaTeX/BibTeX editor with spellcheck, linting, track changes, and collaborative cursors. */
const Editor = forwardRef(function Editor(
  {
    file,
    comments,
    currentUserName,
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
    trackedChanges = [],
    reviewingChangeId = null,
    onTrackedChangeClick,
    onToggleTrackChanges,
    pendingChangesCount = 0,
    reviewing = false,
    reviewIndex = 0,
    reviewCurrentChange = null,
    onStartReview,
    onStopReview,
    onAcceptAndNext,
    onRejectAndNext,
    onAcceptAll,
    onRejectAll,
    onReviewNext,
    onReviewPrev,
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
  },
  ref,
) {
  const containerRef = useRef(null);
  const viewRef = useRef(null);
  const saveTimeout = useRef(null);
  const commentCompartment = useRef(new Compartment());
  const wrapCompartment = useRef(new Compartment());
  const fontSizeCompartment = useRef(new Compartment());
  const visualModeCompartment = useRef(new Compartment());
  const [fontSize, setFontSize] = useState(() => parseInt(getSetting('font-size') || '14', 10));
  const isRemoteUpdate = useRef(false);
  const isResolvingTc = useRef(false);
  const errorHighlightTimer = useRef(null);
  const lintTimeout = useRef(null);
  const spellTimeout = useRef(null);
  const dictRef = useRef(null);
  const currentUserNameRef = useRef(currentUserName);
  currentUserNameRef.current = currentUserName;
  // Track current file id so any deferred operations pin to the file the user is
  // actually editing — saves and other operations must not leak edits across files.
  const fileIdRef = useRef(file?.id ?? null);
  fileIdRef.current = file?.id ?? null;
  const [commentBtn, setCommentBtn] = useState(null); // { x, y, from, to }
  const [cursorInHl, setCursorInHl] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [lintDiags, setLintDiags] = useState([]);
  const [spellMenu, setSpellMenu] = useState(null); // { x, y, word, from, to }
  const spellMenuRef = useRef(null);
  const [citeMenu, setCiteMenu] = useState(null); // { x, y, from, to, name, opt, key }
  const citeMenuRef = useRef(null);
  const [inverted, setInverted] = useState(() => getSetting('editor-inverted') === 'true');

  // VisualModeToolbar owns its own state; we hold a ref to refresh it on cursor move.
  const vmToolbarRef = useRef(null);

  /**
   * Per-doc cache for list-env tag positions. Recomputed only when the CodeMirror
   * Text reference changes. This matters because findInnermostListEnv runs on
   * every Enter / Tab / Shift-Tab keystroke under autorepeat.
   *   { doc, tags: [{ pos, env, type, len }, ...] sorted by pos }
   */
  const listEnvTagsCacheRef = useRef(null);

  const getListEnvTags = useCallback((doc) => {
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
  const findInnermostListEnv = useCallback((doc, pos) => {
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
  const vmInsertList = useCallback((envName) => {
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
    const lines = blockText.split('\n').filter(l => l.trim());
    const items = lines.map(l => {
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

    const indented = blockText.split('\n').map((l) => (l.trim() ? '  ' + l.trim() : '')).join('\n');
    const newText = `\\begin{quote}\n${indented}\n\\end{quote}`;
    view.dispatch({ changes: { from: blockFrom, to: blockTo, insert: newText } });
    view.focus();
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if (e.detail.editorInverted !== undefined) setInverted(e.detail.editorInverted);
    };
    window.addEventListener('flowtex:settings-changed', handler);
    return () => window.removeEventListener('flowtex:settings-changed', handler);
  }, []);
  const [tableBuilder, setTableBuilder] = useState(null); // null | { initial?, replaceFrom?, replaceTo? }
  const [figureBuilder, setFigureBuilder] = useState(null);
  const [showSymbolPicker, setShowSymbolPicker] = useState(false);
  const tableBuilderRef = useRef(null);
  const figureBuilderRef = useRef(null);
  tableBuilderRef.current = tableBuilder;
  figureBuilderRef.current = figureBuilder;
  const tableBuilderUpdateTimeout = useRef(null);
  const figureBuilderUpdateTimeout = useRef(null);

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
  const onTrackedChangeClickRef = useRef(onTrackedChangeClick);
  const trackChangesModeRef = useRef(trackChangesMode);
  const trackedChangesRef = useRef(trackedChanges);
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
  onTrackedChangeClickRef.current = onTrackedChangeClick;
  trackChangesModeRef.current = trackChangesMode;
  trackedChangesRef.current = trackedChanges;
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
    const mainFile = projectFiles.find((f) => f.content && f.content.includes('\\documentclass'));
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
    goToPosition(pos) {
      const view = viewRef.current;
      if (!view) return;
      const clamped = Math.min(pos, view.state.doc.length);
      // Snapshot scrollTop of all ancestors before focus
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
    scrollBy(deltaX, deltaY) {
      const view = viewRef.current;
      if (!view) return;
      view.scrollDOM.scrollBy(deltaX, deltaY);
    },
    replaceContent(newContent) {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: newContent },
      });
    },
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
     * Resolve a single inline-marker tracked change by id. Replaces the
     * marker's range in the doc with either its inner text (kept) or
     * empty (dropped), depending on the marker type and decision:
     *   accept(ins) | reject(del)  →  keep inner text
     *   accept(del) | reject(ins)  →  drop the whole marker
     * Tagged with tcMarkerSkipAnnotation so the input filter doesn't
     * re-wrap the dispatched change as a new tracked change.
     */
    applyMarkerResolution(markerId, decision) {
      const view = viewRef.current;
      if (!view) return false;
      const docText = view.state.doc.toString();
      const markers = parseTcMarkers(docText);
      const m = markers.find((mk) => mk.id === markerId);
      if (!m) return false;
      const keep =
        (m.type === 'ins' && decision === 'accept') ||
        (m.type === 'del' && decision === 'reject');
      const replacement = keep ? m.text : '';
      view.dispatch({
        changes: { from: m.from, to: m.to, insert: replacement },
        annotations: tcMarkerSkipAnnotation.of(true),
      });
      return true;
    },
    /** Apply the same decision to every pending marker in the doc. */
    applyMarkerResolutionAll(decision) {
      const view = viewRef.current;
      if (!view) return 0;
      const docText = view.state.doc.toString();
      const markers = parseTcMarkers(docText);
      if (markers.length === 0) return 0;
      // Walk in REVERSE document order so each replacement doesn't shift
      // the positions of yet-to-process markers.
      const sorted = [...markers].sort((a, b) => b.from - a.from);
      const changes = sorted.map((m) => {
        const keep =
          (m.type === 'ins' && decision === 'accept') ||
          (m.type === 'del' && decision === 'reject');
        return { from: m.from, to: m.to, insert: keep ? m.text : '' };
      });
      view.dispatch({
        changes,
        annotations: tcMarkerSkipAnnotation.of(true),
        sequential: false,
      });
      return markers.length;
    },
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
    applyRemoteChanges(fileId, changes, tracked, deletions) {
      const view = viewRef.current;
      // Drop OT changes that target a file the user has since switched away
      // from — applying them to the wrong file's CodeMirror state would
      // corrupt the visible document and produce out-of-band positions.
      if (!view || fileId !== file?.id) return;
      const prevDocLen = view.state.doc.length;
      isRemoteUpdate.current = true;
      try {
        view.dispatch({ changes });
      } finally {
        isRemoteUpdate.current = false;
      }
      // If the remote user had track-changes on, mark the inserted ranges immediately
      if (tracked) {
        try {
          const cs = ChangeSet.of(changes, prevDocLen);
          const insertDecos = [];
          cs.iterChanges((fromA, toA, fromB, toB, inserted) => {
            if (inserted.length > 0 && fromB < toB) {
              insertDecos.push(
                Decoration.mark({
                  class: 'cm-tc-insert',
                  attributes: { 'data-tc-type': 'insert' },
                }).range(fromB, toB),
              );
            }
          });

          // Compute deletion marks from piggybacked old-doc deletion ranges.
          // The collaborator maps these through the same ChangeSet that was just applied,
          // so both users compute identical positions — no separate message needed.
          const deleteDecos = [];
          if (Array.isArray(deletions)) {
            const docLen = view.state.doc.length;
            for (const d of deletions) {
              const mappedFrom = Math.max(0, Math.min(cs.mapPos(d.from, 1), docLen));
              const mappedTo = Math.max(mappedFrom, Math.min(cs.mapPos(d.to, 1), docLen));
              if (mappedFrom < mappedTo) {
                deleteDecos.push(
                  Decoration.mark({
                    class: 'cm-tc-delete',
                    attributes: { 'data-tc-type': 'delete' },
                  }).range(mappedFrom, mappedTo),
                );
              }
            }
          }

          const effects = [];
          if (insertDecos.length > 0) {
            const currentInsert = view.state.field(trackedChangesField);
            effects.push(setTrackedChangesEffect.of(currentInsert.update({ add: insertDecos, sort: true })));
          }
          if (deleteDecos.length > 0) {
            const currentDelete = view.state.field(tcDeletesField);
            effects.push(setTcDeletesEffect.of(currentDelete.update({ add: deleteDecos, sort: true })));
          }
          if (effects.length > 0) {
            view.dispatch({ effects });
          }
        } catch {
          // Ignore — decoration is non-critical; DB reconciliation will fix it
        }
      }
    },
    setRemoteCursors(cursors) {
      const view = viewRef.current;
      if (!view) return;
      const docLen = view.state.doc.length;
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
      setFontSize((s) => Math.min(32, s + 1));
    },
    zoomOut() {
      setFontSize((s) => Math.max(8, s - 1));
    },
  }));


  // (Legacy tcMarkAsDeleted / tcInterceptDeletion / flushDelBuffer /
  //  flushInsBuffer / their buffer refs deleted in phase 5c.1.
  //  All input now flows through tcMarkerInput.js.)


  // Create editor when file changes
  useEffect(() => {
    if (!containerRef.current || !file) return;

    if (viewRef.current) {
      viewRef.current.destroy();
    }
    setCommentBtn(null);
    prevPendingIdsRef.current = new Set();
    tcDecorationsBuiltForFileRef.current = null;

    commentCompartment.current = new Compartment();
    wrapCompartment.current = new Compartment();
    visualModeCompartment.current = new Compartment();

    const state = EditorState.create({
      doc: file.content || '',
      extensions: [
        basicSetup,
        StreamLanguage.define(file?.path?.endsWith('.bib') ? bibtex : stex),
        syntaxHighlighting(classHighlighter, { fallback: true }),
        latexFoldService,
        latexAutocomplete(citeKeysRef, labelKeysRef),
        refHoverTooltip,
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
        trackedChangesField,
        tcDeletesField,
        // New marker-based TC extension: scans the doc for inline tcMarkers
        // and renders insertion / deletion decorations driven by the doc
        // text itself. Position drift is impossible because the markers
        // ARE the position. Coexists with the legacy
        // trackedChangesField / tcDeletesField until the migration drops
        // the table-driven path.
        ...tcMarkerExtensions(),
        // Input filter that wraps user keystrokes in inline markers when
        // track-changes mode is on. Bypassed for transactions tagged with
        // the skip annotation (accept/reject doc edits, OT applies).
        buildTcMarkerInputFilter({
          isOn: () => trackChangesModeRef.current,
          getAuthor: () => currentUserNameRef.current || '',
          shouldSkip: () => isResolvingTc.current || isRemoteUpdate.current,
        }),
        tcReviewHighlightField,
        tableGutterField,
        tableGutterExtension,
        // Track changes: Backspace/Delete fall through to default keybindings.
        // The buildTcMarkerInputFilter transaction filter wraps the resulting
        // delete change in an inline tcMarker so the chars are visually
        // marked deleted rather than removed. Previous code intercepted
        // these keys to call tcMarkAsDeleted; that path is bypassed now.
        // (Removed: legacy transaction filter that converted deletions in
        // track-changes mode into insertions + scheduled tcMarkAsDeleted.
        // The new buildTcMarkerInputFilter further down replaces every
        // user change with an inline tcMarker and is the sole path for
        // recording tracked changes.)
        EditorView.domEventHandlers({
          contextmenu(event, view) {
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos == null) return false;
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
            // Find tracked change at this position from the trackedChanges array
            const tcs = trackedChangesRef.current || [];
            const tc = tcs.find((c) => {
              if (c.status !== 'pending') return false;
              // Check if position is within this change's range
              if (pos >= c.from_pos && pos < c.to_pos) return true;
              return false;
            });
            if (tc) {
              event.preventDefault();
              onTrackedChangeClickRef.current?.(tc.id, { x: event.clientX, y: event.clientY });
              return true;
            }
            // Also check decorations — DB positions may be stale, but decorations
            // are mapped through edits and always reflect the current document.
            let decoRange = null;
            view.state.field(tcDeletesField).between(pos, pos + 1, (from, to) => {
              if (pos >= from && pos < to) decoRange = { from, to, type: 'delete' };
            });
            if (!decoRange) {
              view.state.field(trackedChangesField).between(pos, pos + 1, (from, to) => {
                if (pos >= from && pos < to) decoRange = { from, to, type: 'insert' };
              });
            }
            if (decoRange) {
              // Find the best matching pending TC — DB positions may have drifted,
              // so pick the closest TC of the right type by distance to click position.
              let bestTc = null;
              let bestDist = Infinity;
              for (const c of tcs) {
                if (c.status !== 'pending') continue;
                if (decoRange.type === 'delete' && !c.deleted_text) continue;
                if (decoRange.type === 'insert' && !c.inserted_text) continue;
                // Distance: 0 if pos is inside the TC's DB range, otherwise gap to nearest edge
                const dist =
                  pos >= c.from_pos && pos < c.to_pos
                    ? 0
                    : Math.min(Math.abs(pos - c.from_pos), Math.abs(pos - c.to_pos));
                if (dist < bestDist) {
                  bestDist = dist;
                  bestTc = c;
                }
              }
              if (bestTc) {
                event.preventDefault();
                onTrackedChangeClickRef.current?.(bestTc.id, { x: event.clientX, y: event.clientY });
                return true;
              }
              // Decoration exists but no matching TC yet — just block default menu
              event.preventDefault();
              return true;
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
        tcInsertGutterField,
        tcInsertGutterExtension,
        tcDeleteGutterField,
        tcDeleteGutterExtension,
        citeKeyHighlighter,
        // Make tracked-deletion decorations undoable via CM6's history.
        // When a setTcDeletesEffect is dispatched (e.g. from tcMarkAsDeleted),
        // the history records the inverse (previous decoration set) so Cmd+Z restores it.
        invertedEffects.of((tr) => {
          const effects = [];
          for (const e of tr.effects) {
            if (e.is(setTcDeletesEffect)) {
              effects.push(setTcDeletesEffect.of(tr.startState.field(tcDeletesField)));
            }
          }
          return effects;
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            // Notify the marker-aware tracked-changes hook that the doc
            // moved. Fires for ALL doc-changed transactions (local typing,
            // remote OT, accept/reject) so the review-panel marker list
            // stays in sync. Cheap — the receiver re-parses markers in O(n).
            onDocChangeRef.current?.();

            if (!isRemoteUpdate.current) {
              const changes = [];
              update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
                changes.push({ from: fromA, to: toA, insert: inserted.toString() });
              });
              // Track changes are now produced inline as content markers by
              // the buildTcMarkerInputFilter transaction filter. The doc
              // changes that reach this listener already CONTAIN the
              // marker syntax, so we skip the legacy "buffer for POST +
              // add immediate decoration" pass — it would double-decorate
              // the marker metadata and create a phantom DB row.
              // OT broadcast still fires unconditionally; collaborators
              // receive the doc text including the marker and apply it
              // verbatim.
              const dels = pendingTcDeletions.current;
              pendingTcDeletions.current = null;
              onChangesRef.current?.(changes, /* isTracked= */ false, dels);
            }

            const content = update.state.doc.toString();
            clearTimeout(saveTimeout.current);
            // Capture the file id this content belongs to. The save MUST be
            // pinned to this id — even if the user has since switched files,
            // the debounced save will still target the original file.
            const fileIdAtEdit = file?.id;
            saveTimeout.current = setTimeout(() => {
              onSaveRef.current(content, computeTcPositions(content), fileIdAtEdit);
            }, 1000);

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

            // Debounced spellcheck (skip .bib files)
            if (!file?.path?.endsWith('.bib')) {
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
                onSaveRef.current(content, computeTcPositions(content), file?.id);
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

    // Build TC decorations immediately if data is already available (eliminates race condition
    // where the separate TC useEffect fires before the view is ready or after refs are reset)
    const tcs = trackedChangesRef.current || [];
    const pendingTcs = tcs.filter((c) => c.status === 'pending');
    if (pendingTcs.length > 0) {
      const docLen = view.state.doc.length;
      const docText = view.state.doc.toString();
      view.dispatch({
        effects: [
          setTrackedChangesEffect.of(buildTcInsertDecorations(tcs, docLen, currentUserNameRef.current, docText)),
          setTcDeletesEffect.of(buildTcDeleteDecorations(tcs, docLen, currentUserNameRef.current, docText)),
        ],
      });
      tcDecorationsBuiltForFileRef.current = file?.id;
      prevPendingIdsRef.current = new Set(pendingTcs.map((c) => c.id));
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
    // Initial spellcheck (skip .bib files)
    if (!file?.path?.endsWith('.bib')) {
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
          onSaveRef.current?.(content, computeTcPositions(content), file?.id);
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
      clearTimeout(tcInsertTimer.current);
      clearTimeout(tcDelTimer.current);
      clearTimeout(tableBuilderUpdateTimeout.current);
      // eslint-disable-next-line react-hooks/exhaustive-deps
      clearTimeout(figureBuilderUpdateTimeout.current);
      view.destroy();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  // Re-run spellcheck when language changes (skip .bib files)
  useEffect(() => {
    if (file?.path?.endsWith('.bib')) return;
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
  }, [spellLang]);

  useClickOutside(
    spellMenuRef,
    useCallback(() => setSpellMenu(null), []),
    !!spellMenu,
  );

  useClickOutside(
    citeMenuRef,
    useCallback(() => setCiteMenu(null), []),
    !!citeMenu,
  );

  const swapCiteVariant = useCallback((newName) => {
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

  // Tracked change decoration management.
  //
  // Real-time decorations are added by:
  //   - Local edits: update listener (insertions) + tcMarkAsDeleted (deletions)
  //   - Remote edits: applyRemoteChanges (tracked insertions) + applyRemoteTcDelete (deletions)
  // These auto-map through OT changes via value.map(tr.changes), staying correctly positioned.
  //
  // This useEffect handles two cases:
  //   1. File load — full rebuild from DB positions (correct because doc just loaded too)
  //   2. TC resolved — selectively remove decorations for no-longer-pending TCs
  //
  // It must NOT rebuild on new TC IDs from WS, because those DB positions are relative to
  // the author's document at save time and may be stale on the collaborator's view.
  const prevPendingIdsRef = useRef(new Set());
  const tcDecorationsBuiltForFileRef = useRef(null);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentFileId = file?.id;
    const currentPendingIds = new Set(trackedChanges.filter((c) => c.status === 'pending').map((c) => c.id));
    const prevIds = prevPendingIdsRef.current;

    // Case 1: Full rebuild from DB data.
    // Triggers: file changed, OR new TC IDs appeared when we had none previously
    // (i.e. TC API data arrived after the editor was created with empty TCs).
    const isNewFile = tcDecorationsBuiltForFileRef.current !== currentFileId;
    const addedIds = new Set();
    for (const id of currentPendingIds) {
      if (!prevIds.has(id)) addedIds.add(id);
    }

    const needsRebuild = currentPendingIds.size > 0 && (isNewFile || (addedIds.size > 0 && prevIds.size === 0));

    if (needsRebuild) {
      tcDecorationsBuiltForFileRef.current = currentFileId;
      prevPendingIdsRef.current = currentPendingIds;
      const docLen = view.state.doc.length;
      const docText = view.state.doc.toString();
      view.dispatch({
        effects: [
          setTrackedChangesEffect.of(
            buildTcInsertDecorations(trackedChanges, docLen, currentUserNameRef.current, docText),
          ),
          setTcDeletesEffect.of(buildTcDeleteDecorations(trackedChanges, docLen, currentUserNameRef.current, docText)),
        ],
      });
      return;
    }
    // If file is new but no pending TCs, just update tracking refs (don't mark as "built"
    // so that when TCs arrive later, we'll know we still need to build them)
    if (isNewFile && currentPendingIds.size === 0) {
      prevPendingIdsRef.current = currentPendingIds;
      return;
    }

    // Detect IDs that were removed (TC resolved via accept/reject)
    const removedIds = new Set();
    for (const id of prevIds) {
      if (!currentPendingIds.has(id)) removedIds.add(id);
    }
    prevPendingIdsRef.current = currentPendingIds;

    if (removedIds.size === 0) return;

    // Case 2: TC resolved — remove decorations for resolved TCs.
    // We only need to manually filter when the resolution did NOT physically
    // edit the doc. The decoration field's `value.map(tr.changes)` already
    // drops any decoration whose underlying chars were removed:
    //   - accept(insertion): chars stay  → filter out the insert decoration.
    //   - accept(deletion):  chars removed → mapping handled it.
    //   - reject(insertion): chars removed → mapping handled it.
    //   - reject(deletion):  chars stay  → filter out the delete decoration.
    // The previous code filtered unconditionally with a `tc.from_pos ± 2`
    // dominance check, which incorrectly removed a *neighbour* decoration
    // whose POST-mapping position landed inside the resolved TC's PRE-
    // mapping range. That's how accepting `Header` (stored at 241-247)
    // also nuked the strikethrough on `3` (now at 242-243 after mapping).
    const resolvedTcs = trackedChanges.filter((c) => removedIds.has(c.id));

    // Remove decorations for accepted insertions only.
    const currentInsertDecos = view.state.field(trackedChangesField);
    let filteredInserts = currentInsertDecos;
    for (const tc of resolvedTcs) {
      if (!tc.inserted_text) continue;
      if (tc.status !== 'accepted') continue; // rejected: doc edited, mapping handled it
      const ranges = [];
      filteredInserts.between(0, view.state.doc.length, (from, to, deco) => {
        let dominated = false;
        if (from >= tc.from_pos - 2 && to <= tc.to_pos + 2) dominated = true;
        if (!dominated) ranges.push(deco.range(from, to));
      });
      filteredInserts = Decoration.set(ranges, true);
    }

    // Remove decorations for rejected deletions only.
    const currentDeleteDecos = view.state.field(tcDeletesField);
    let filteredDeletes = currentDeleteDecos;
    for (const tc of resolvedTcs) {
      if (!tc.deleted_text) continue;
      if (tc.status !== 'rejected') continue; // accepted: doc edited, mapping handled it
      const ranges = [];
      filteredDeletes.between(0, view.state.doc.length, (from, to, deco) => {
        let dominated = false;
        if (from >= tc.from_pos - 2 && to <= tc.to_pos + 2) dominated = true;
        if (!dominated) ranges.push(deco.range(from, to));
      });
      filteredDeletes = Decoration.set(ranges, true);
    }

    const effects = [];
    if (filteredInserts !== currentInsertDecos) {
      effects.push(setTrackedChangesEffect.of(filteredInserts));
    }
    if (filteredDeletes !== currentDeleteDecos) {
      effects.push(setTcDeletesEffect.of(filteredDeletes));
    }
    if (effects.length > 0) {
      view.dispatch({ effects });
    }
  }, [trackedChanges, file]);

  // Review walkthrough highlight
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const docLen = view.state.doc.length;
    let decos = Decoration.none;
    if (reviewingChangeId) {
      const change = trackedChanges.find((c) => c.id === reviewingChangeId);
      if (change && change.from_pos >= 0 && change.to_pos <= docLen) {
        decos = Decoration.set([
          Decoration.mark({ class: 'cm-tc-review-active' }).range(change.from_pos, change.to_pos),
        ]);
      }
    }
    view.dispatch({ effects: setTcReviewHighlightEffect.of(decos) });
  }, [reviewingChangeId, trackedChanges]);

  // Toggle word wrap
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wrapCompartment.current.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    });
  }, [wordWrap]);

  // Toggle visual mode
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: visualModeCompartment.current.reconfigure(visualMode ? visualModeExtension(projectFiles, citeKeys) : []),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visualMode]);

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
  const handleTableBuilderInsert = useCallback((table) => {
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
          <button className="editor-header-btn" onClick={() => setFontSize((s) => Math.max(8, s - 1))} title="Zoom out">
            <ZoomOutIcon />
          </button>
          <span className="editor-zoom-label" title="Font size">
            {fontSize}px
          </span>
          <button className="editor-header-btn" onClick={() => setFontSize((s) => Math.min(32, s + 1))} title="Zoom in">
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
        {pendingChangesCount > 0 && onStartReview && (
          <button
            className={`editor-header-btn ${reviewing ? 'editor-header-btn-active' : ''}`}
            onClick={reviewing ? onStopReview : onStartReview}
            title={
              reviewing
                ? 'Close review'
                : `Review ${pendingChangesCount} pending change${pendingChangesCount !== 1 ? 's' : ''}`
            }
          >
            <ReviewEyeIcon />
          </button>
        )}
        <button
          className={`editor-header-btn ${inverted ? 'editor-header-btn-active' : ''}`}
          onClick={() =>
            setInverted((v) => {
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
      {reviewing && pendingChangesCount > 0 && (
        <div className="tc-review-toolbar">
          <div className="tc-review-toolbar-nav">
            <button
              className="tc-review-toolbar-arrow"
              onClick={onReviewPrev}
              disabled={reviewIndex <= 0}
              title="Previous change"
            >
              <ChevronLeftIcon />
            </button>
            <span className="tc-review-toolbar-counter">
              {reviewIndex + 1} / {pendingChangesCount}
            </span>
            <button
              className="tc-review-toolbar-arrow"
              onClick={onReviewNext}
              disabled={reviewIndex >= pendingChangesCount - 1}
              title="Next change"
            >
              <ChevronRightIcon />
            </button>
          </div>
          {reviewCurrentChange && (
            <span className="tc-review-toolbar-info">
              <span className="tc-review-toolbar-author">{reviewCurrentChange.author_name}</span>
              {reviewCurrentChange.inserted_text && (
                <span className="tc-review-insert">
                  +
                  {reviewCurrentChange.inserted_text.length > 30
                    ? reviewCurrentChange.inserted_text.slice(0, 30) + '…'
                    : reviewCurrentChange.inserted_text}
                </span>
              )}
              {reviewCurrentChange.deleted_text && (
                <span className="tc-review-delete">
                  −
                  {reviewCurrentChange.deleted_text.length > 30
                    ? reviewCurrentChange.deleted_text.slice(0, 30) + '…'
                    : reviewCurrentChange.deleted_text}
                </span>
              )}
            </span>
          )}
          <div className="tc-review-toolbar-actions">
            <button
              className="tc-review-toolbar-btn tc-review-toolbar-accept"
              onClick={() => onAcceptAndNext(reviewCurrentChange?.id)}
              disabled={!reviewCurrentChange}
              title="Accept and move to next"
            >
              Accept
            </button>
            <button
              className="tc-review-toolbar-btn tc-review-toolbar-reject"
              onClick={() => onRejectAndNext(reviewCurrentChange?.id)}
              disabled={!reviewCurrentChange}
              title="Reject and move to next"
            >
              Reject
            </button>
            <span className="tc-review-toolbar-sep" />
            <button
              className="tc-review-toolbar-btn tc-review-toolbar-accept-all"
              onClick={onAcceptAll}
              title="Accept all changes"
            >
              Accept All
            </button>
            <button
              className="tc-review-toolbar-btn tc-review-toolbar-reject-all"
              onClick={onRejectAll}
              title="Reject all changes"
            >
              Reject All
            </button>
          </div>
        </div>
      )}
      {showSymbolPicker && (
        <SymbolPicker
          declaredPackages={declaredPackages}
          onInsert={(cmd) => {
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
          onInsert={(latex) => {
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
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleCommentBtnClick}
        >
          + Comment
        </button>
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
          ].map((variant) => (
            <button
              key={variant.name}
              className={`cite-context-item ${variant.name === citeMenu.name ? 'cite-context-item-current' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
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
    </div>
  );
});

export default Editor;
