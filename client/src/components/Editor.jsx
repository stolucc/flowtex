import React, { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
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
import {
  getDictionary,
  spellcheckText,
  addToCustomDictionary,
  ignoreWord,
  LANGUAGES,
  getLanguage,
  setLanguage,
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
import {
  UndoIcon,
  ZoomOutIcon,
  ZoomInIcon,
  SearchIcon,
  ContrastIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from './Icons.jsx';

const Editor = forwardRef(function Editor(
  {
    file,
    comments,
    currentUserName,
    onSave,
    onSelectionChange,
    onLineChange,
    onChanges,
    onCursorChange,
    onCompile,
    onRequestComment,
    onScroll,
    onLintDiagnostics,
    projectId,
    showLineNumbers = true,
    wordWrap = true,
    trackChangesMode = false,
    trackedChanges = [],
    reviewingChangeId = null,
    onTrackChange,
    onTrackedChangeClick,
    onDeleteInsertionChar,
    onUndoInsertions,
    onTrackDeletion,
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
  },
  ref,
) {
  const containerRef = useRef(null);
  const viewRef = useRef(null);
  const saveTimeout = useRef(null);
  const commentCompartment = useRef(new Compartment());
  const wrapCompartment = useRef(new Compartment());
  const fontSizeCompartment = useRef(new Compartment());
  const [fontSize, setFontSize] = useState(() => parseInt(localStorage.getItem('flowtex-font-size') || '14', 10));
  const isRemoteUpdate = useRef(false);
  const isResolvingTc = useRef(false);
  const errorHighlightTimer = useRef(null);
  const lintTimeout = useRef(null);
  const spellTimeout = useRef(null);
  const dictRef = useRef(null);
  const currentUserNameRef = useRef(currentUserName);
  currentUserNameRef.current = currentUserName;
  const tcInsertBuffer = useRef({ from: null, to: null, text: '' }); // buffered insertion for debounce
  const tcInsertTimer = useRef(null);
  const tcDelBuffer = useRef({ from: null, to: null, text: '' });
  const tcDelTimer = useRef(null);
  // Pending deletion ranges from the transaction filter, piggybacked on the next 'changes' WS message.
  // Stored as old-doc positions so the collaborator can map them through the ChangeSet locally.
  const pendingTcDeletions = useRef(null);
  // When true, tcMarkAsDeleted skips the onTrackDeletion WS broadcast (info is piggybacked instead).
  const skipTcDeleteBroadcast = useRef(false);
  const [commentBtn, setCommentBtn] = useState(null); // { x, y, from, to }
  const [showSearch, setShowSearch] = useState(false);
  const [lintDiags, setLintDiags] = useState([]);
  const [spellMenu, setSpellMenu] = useState(null); // { x, y, word, from, to }
  const spellMenuRef = useRef(null);
  const [spellLang, setSpellLang] = useState(() => getLanguage());
  const [inverted, setInverted] = useState(() => localStorage.getItem('flowtex-editor-inverted') === 'true');
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
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onLineChangeRef = useRef(onLineChange);
  const onChangesRef = useRef(onChanges);
  const onCursorChangeRef = useRef(onCursorChange);
  const onCompileRef = useRef(onCompile);
  const onRequestCommentRef = useRef(onRequestComment);
  const onScrollRef = useRef(onScroll);
  const onLintDiagnosticsRef = useRef(onLintDiagnostics);
  const onTrackChangeRef = useRef(onTrackChange);
  const onTrackedChangeClickRef = useRef(onTrackedChangeClick);
  const onDeleteInsertionCharRef = useRef(onDeleteInsertionChar);
  const onUndoInsertionsRef = useRef(onUndoInsertions);
  const onTrackDeletionRef = useRef(onTrackDeletion);
  const trackChangesModeRef = useRef(trackChangesMode);
  const trackedChangesRef = useRef(trackedChanges);
  const setSpellMenuRef = useRef(setSpellMenu);
  onGoToFileRef.current = onGoToFile;
  projectFilesRef.current = projectFiles;
  onSaveRef.current = onSave;
  onSelectionChangeRef.current = onSelectionChange;
  onLineChangeRef.current = onLineChange;
  onChangesRef.current = onChanges;
  onCursorChangeRef.current = onCursorChange;
  onCompileRef.current = onCompile;
  onRequestCommentRef.current = onRequestComment;
  onScrollRef.current = onScroll;
  onLintDiagnosticsRef.current = onLintDiagnostics;
  onTrackChangeRef.current = onTrackChange;
  onTrackedChangeClickRef.current = onTrackedChangeClick;
  onDeleteInsertionCharRef.current = onDeleteInsertionChar;
  onUndoInsertionsRef.current = onUndoInsertions;
  onTrackDeletionRef.current = onTrackDeletion;
  trackChangesModeRef.current = trackChangesMode;
  trackedChangesRef.current = trackedChanges;
  const citeKeysRef = useRef(citeKeys || []);
  citeKeysRef.current = citeKeys || [];
  const labelKeysRef = useRef(labelKeys || []);
  labelKeysRef.current = labelKeys || [];
  setSpellMenuRef.current = setSpellMenu;

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
    // Edit that broadcasts via OT but doesn't create a new tracked change
    resolveTrackedChangeEdit(from, to, text) {
      const view = viewRef.current;
      if (!view) return;
      const docLen = view.state.doc.length;
      const clampedFrom = Math.min(Math.max(0, from), docLen);
      const clampedTo = Math.min(Math.max(clampedFrom, to), docLen);
      isResolvingTc.current = true;
      try {
        view.dispatch({ changes: { from: clampedFrom, to: clampedTo, insert: text } });
      } finally {
        isResolvingTc.current = false;
      }
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
    updateTrackedChanges(changes) {
      const view = viewRef.current;
      if (!view) return;
      const docLen = view.state.doc.length;
      const docText = view.state.doc.toString();
      view.dispatch({
        effects: [
          setTrackedChangesEffect.of(buildTcInsertDecorations(changes, docLen, currentUserNameRef.current, docText)),
          setTcDeletesEffect.of(buildTcDeleteDecorations(changes, docLen, currentUserNameRef.current, docText)),
        ],
      });
    },
    applyRemoteChanges(fileId, changes, tracked, deletions) {
      const view = viewRef.current;
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
        } catch (e) {
          // Ignore — decoration is non-critical; DB reconciliation will fix it
        }
      }
    },
    applyRemoteTcDelete(fileId, from, to) {
      const view = viewRef.current;
      if (!view || fileId !== file?.id) return;
      const docLen = view.state.doc.length;
      const clampedFrom = Math.max(0, Math.min(from, docLen));
      const clampedTo = Math.max(clampedFrom, Math.min(to, docLen));
      if (clampedFrom >= clampedTo) return;
      const newMark = Decoration.mark({
        class: 'cm-tc-delete',
        attributes: { 'data-tc-type': 'delete' },
      }).range(clampedFrom, clampedTo);
      const current = view.state.field(tcDeletesField);
      view.dispatch({ effects: setTcDeletesEffect.of(current.update({ add: [newMark], sort: true })) });
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
    getSpellLang() {
      return spellLang;
    },
    setSpellLang(code) {
      setLanguage(code);
      setSpellLang(code);
    },
    zoomIn() {
      setFontSize((s) => Math.min(32, s + 1));
    },
    zoomOut() {
      setFontSize((s) => Math.max(8, s - 1));
    },
  }));

  // Compute corrected TC positions by finding each TC's text in the current document.
  // Returns an array of { id, from_pos, to_pos } for all pending TCs whose text can be located.
  const computeTcPositions = useCallback((docText) => {
    const tcs = trackedChangesRef.current;
    if (!tcs || tcs.length === 0) return null;
    const pending = tcs.filter((tc) => tc.status === 'pending');
    if (pending.length === 0) return null;

    const positions = [];
    for (const tc of pending) {
      const text = tc.inserted_text || tc.deleted_text;
      if (!text) continue;
      // Check if the stored position still matches
      const from = Math.max(0, Math.min(tc.from_pos, docText.length));
      const to = Math.max(from, Math.min(tc.to_pos, docText.length));
      if (docText.slice(from, to) === text) {
        positions.push({ id: tc.id, from_pos: from, to_pos: to });
        continue;
      }
      // Search nearby for the text
      const searchFrom = Math.max(0, tc.from_pos - 80);
      const searchTo = Math.min(docText.length, tc.from_pos + 80 + text.length);
      const region = docText.slice(searchFrom, searchTo);
      const idx = region.indexOf(text);
      if (idx !== -1) {
        const correctedFrom = searchFrom + idx;
        positions.push({ id: tc.id, from_pos: correctedFrom, to_pos: correctedFrom + text.length });
      }
      // If not found, skip — don't send stale position
    }
    return positions.length > 0 ? positions : null;
  }, []);

  // Debounce delay (ms) for flushing TC buffers to the API.
  // Set to 0 for immediate flush; increase to batch adjacent keystrokes.
  const tcFlushDelay = 0;

  // Mark a range as deleted (for track changes mode).
  // If the range contains tracked insertions, those are actually removed from the document
  // (they were never part of the original text). Only non-insertion text gets a deletion mark.
  const tcMarkAsDeleted = useCallback((view, from, to, cursorPos) => {
    const state = view.state;
    const text = state.sliceDoc(from, to);
    if (!text) return;

    // Split [from, to) into insertion vs non-insertion sub-ranges
    const insertionRanges = [];
    const deletionRanges = [];
    let i = from;
    while (i < to) {
      const inIns = isPosInInsertion(state, i);
      let end = i + 1;
      while (end < to && isPosInInsertion(state, end) === inIns) end++;
      if (inIns) insertionRanges.push({ from: i, to: end });
      else deletionRanges.push({ from: i, to: end });
      i = end;
    }

    // --- Case 1: No insertions in range — original simple path ---
    if (insertionRanges.length === 0) {
      const currentDecos = state.field(tcDeletesField);
      const newMark = Decoration.mark({
        class: 'cm-tc-delete',
        attributes: { 'data-tc-type': 'delete' },
      }).range(from, to);
      const updated = currentDecos.update({ add: [newMark], sort: true });
      const dispatchSpec = { effects: setTcDeletesEffect.of(updated) };
      if (cursorPos !== null && cursorPos !== undefined) {
        dispatchSpec.selection = { anchor: cursorPos };
      }
      view.dispatch(dispatchSpec);
      if (!skipTcDeleteBroadcast.current) onTrackDeletionRef.current?.(from, to);
      // Buffer for API
      const buf = tcDelBuffer.current;
      if (buf.from !== null && (from === buf.from - 1 || from === buf.from || to === buf.to || to === buf.to + 1)) {
        buf.from = Math.min(buf.from, from);
        buf.to = Math.max(buf.to, to);
        buf.text = state.sliceDoc(buf.from, buf.to);
      } else {
        if (buf.from !== null) flushDelBuffer();
        buf.from = from;
        buf.to = to;
        buf.text = text;
      }
      clearTimeout(tcDelTimer.current);
      tcDelTimer.current = setTimeout(flushDelBuffer, tcFlushDelay);
      return;
    }

    // --- Case 2: Only insertions, no original text — just remove them ---
    if (deletionRanges.length === 0) {
      const changes = insertionRanges.map((r) => ({ from: r.from, to: r.to }));
      const dispatchSpec = { changes };
      if (cursorPos !== null && cursorPos !== undefined) {
        dispatchSpec.selection = { anchor: cursorPos };
      }
      isResolvingTc.current = true;
      try {
        view.dispatch(dispatchSpec);
      } finally {
        isResolvingTc.current = false;
      }
      for (const r of insertionRanges) {
        for (let p = r.to - 1; p >= r.from; p--) {
          onDeleteInsertionCharRef.current?.(p);
        }
      }
      return;
    }

    // --- Case 3: Mixed — remove insertions from doc, mark original text as deleted ---
    // Build document changes (remove insertion text)
    const changes = insertionRanges.map((r) => ({ from: r.from, to: r.to }));
    const cs = ChangeSet.of(
      changes.map((c) => ({ from: c.from, to: c.to, insert: '' })),
      state.doc.length,
    );

    // Map deletion ranges into post-change coordinate space
    const mappedDeletionRanges = deletionRanges
      .map((r) => ({
        from: cs.mapPos(r.from, 1),
        to: cs.mapPos(r.to, -1),
      }))
      .filter((r) => r.from < r.to);

    // Build decorations in post-change space
    const currentDecos = state.field(tcDeletesField).map(cs);
    const newMarks = mappedDeletionRanges.map((r) =>
      Decoration.mark({
        class: 'cm-tc-delete',
        attributes: { 'data-tc-type': 'delete' },
      }).range(r.from, r.to),
    );
    const updatedDecos = currentDecos.update({ add: newMarks, sort: true });

    const newCursor = cursorPos !== null && cursorPos !== undefined ? cs.mapPos(cursorPos, 1) : cs.mapPos(from, 1);

    isResolvingTc.current = true;
    try {
      view.dispatch({
        changes,
        effects: setTcDeletesEffect.of(updatedDecos),
        selection: { anchor: newCursor },
      });
    } finally {
      isResolvingTc.current = false;
    }

    // Notify collaborators about deletion marks (skip if piggybacked on changes message)
    if (!skipTcDeleteBroadcast.current) {
      for (const r of mappedDeletionRanges) {
        onTrackDeletionRef.current?.(r.from, r.to);
      }
    }
    // Notify about removed insertion chars (original pre-change positions)
    for (const r of insertionRanges) {
      for (let p = r.to - 1; p >= r.from; p--) {
        onDeleteInsertionCharRef.current?.(p);
      }
    }
    // Buffer the deletion parts for API
    for (const r of mappedDeletionRanges) {
      const buf = tcDelBuffer.current;
      const rText = view.state.sliceDoc(r.from, r.to);
      if (
        buf.from !== null &&
        (r.from === buf.from - 1 || r.from === buf.from || r.to === buf.to || r.to === buf.to + 1)
      ) {
        buf.from = Math.min(buf.from, r.from);
        buf.to = Math.max(buf.to, r.to);
        buf.text = view.state.sliceDoc(buf.from, buf.to);
      } else {
        if (buf.from !== null) flushDelBuffer();
        buf.from = r.from;
        buf.to = r.to;
        buf.text = rText;
      }
    }
    clearTimeout(tcDelTimer.current);
    tcDelTimer.current = setTimeout(flushDelBuffer, tcFlushDelay);
  }, []);

  const flushDelBuffer = useCallback(() => {
    const buf = tcDelBuffer.current;
    if (buf.from === null) return;
    onTrackChangeRef.current?.({
      from_pos: buf.from,
      to_pos: buf.to,
      inserted_text: '',
      deleted_text: buf.text,
    });
    buf.from = null;
    buf.to = null;
    buf.text = '';
  }, []);

  const flushInsBuffer = useCallback(() => {
    const buf = tcInsertBuffer.current;
    if (buf.from === null) return;
    onTrackChangeRef.current?.({
      from_pos: buf.from,
      to_pos: buf.to,
      inserted_text: buf.text,
      deleted_text: '',
    });
    buf.from = null;
    buf.to = null;
    buf.text = '';
  }, []);

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

    const state = EditorState.create({
      doc: file.content || '',
      extensions: [
        basicSetup,
        StreamLanguage.define(file?.path?.endsWith('.bib') ? bibtex : stex),
        syntaxHighlighting(classHighlighter, { fallback: true }),
        latexFoldService,
        latexAutocomplete(citeKeysRef, labelKeysRef),
        wrapCompartment.current.of(wordWrap ? EditorView.lineWrapping : []),
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
        tcReviewHighlightField,
        tableGutterField,
        tableGutterExtension,
        // Track changes: intercept Backspace/Delete to mark text as deleted instead of removing it
        Prec.high(
          keymap.of([
            {
              key: 'Backspace',
              run(view) {
                if (!trackChangesModeRef.current) return false;
                const sel = view.state.selection.main;
                if (!sel.empty) {
                  tcMarkAsDeleted(view, sel.from, sel.to, sel.from);
                  return true;
                }
                if (sel.from === 0) return true;
                let target = sel.from - 1;
                // Skip backward over already-deleted char (one at a time)
                if (isPosInDeletion(view.state, target)) {
                  view.dispatch({ selection: { anchor: target } });
                  return true;
                }
                // If char is a tracked insertion, just delete it normally (undo the insertion)
                // Use isResolvingTc (not isRemoteUpdate) so the deletion is still broadcast via OT
                // but doesn't get re-tracked as a new tracked change.
                if (isPosInInsertion(view.state, target)) {
                  isResolvingTc.current = true;
                  try {
                    view.dispatch({ changes: { from: target, to: target + 1 }, selection: { anchor: target } });
                  } finally {
                    isResolvingTc.current = false;
                  }
                  onDeleteInsertionCharRef.current?.(target);
                  return true;
                }
                tcMarkAsDeleted(view, target, target + 1, target);
                return true;
              },
            },
            {
              key: 'Delete',
              run(view) {
                if (!trackChangesModeRef.current) return false;
                const sel = view.state.selection.main;
                if (!sel.empty) {
                  tcMarkAsDeleted(view, sel.from, sel.to, sel.from);
                  return true;
                }
                if (sel.from >= view.state.doc.length) return true;
                // Skip forward over already-deleted chars
                let target = sel.from;
                while (target < view.state.doc.length && isPosInDeletion(view.state, target)) target++;
                if (target >= view.state.doc.length) return true;
                // If char is a tracked insertion, just delete it normally
                // Use isResolvingTc so the deletion is broadcast but not re-tracked
                if (isPosInInsertion(view.state, target)) {
                  isResolvingTc.current = true;
                  try {
                    view.dispatch({ changes: { from: target, to: target + 1 } });
                  } finally {
                    isResolvingTc.current = false;
                  }
                  onDeleteInsertionCharRef.current?.(target);
                  return true;
                }
                tcMarkAsDeleted(view, target, target + 1, sel.from);
                return true;
              },
            },
          ]),
        ),
        // Transaction filter: prevent deletions in track changes mode for select+type, cut, etc.
        EditorState.transactionFilter.of((tr) => {
          if (!trackChangesModeRef.current || !tr.docChanged || isRemoteUpdate.current || isResolvingTc.current)
            return tr;
          let hasDeletion = false;
          tr.changes.iterChanges((fromA, toA) => {
            if (fromA < toA) hasDeletion = true;
          });
          if (!hasDeletion) return tr; // pure insertion, let through
          // Build insert-only changes and record deletions
          const insertParts = [];
          const deletionParts = [];
          tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
            if (inserted.length > 0) {
              insertParts.push({ from: fromA, to: fromA, insert: inserted.toString() });
            }
            if (fromA < toA) {
              deletionParts.push({ from: fromA, to: toA, text: tr.startState.sliceDoc(fromA, toA) });
            }
          });
          // Store raw deletion ranges (old-doc positions) so the update listener can
          // piggyback them on the OT 'changes' message.  The collaborator will map
          // these through the ChangeSet locally — no separate tc-delete-mark needed.
          {
            const filteredDels = deletionParts.filter((d) => {
              for (let p = d.from; p < d.to; p++) {
                if (!isPosInDeletion(tr.startState, p)) return true;
              }
              return false;
            });
            pendingTcDeletions.current = filteredDels.length > 0 ? filteredDels : null;
          }
          // Schedule local deletion decorations + API buffer (runs after dispatch).
          // skipTcDeleteBroadcast prevents the duplicate WS send — info is already
          // piggybacked on the changes message via pendingTcDeletions.
          queueMicrotask(() => {
            skipTcDeleteBroadcast.current = true;
            try {
              let offset = 0;
              for (const ins of insertParts) offset += ins.insert.length;
              for (const d of deletionParts) {
                let skip = true;
                for (let p = d.from; p < d.to; p++) {
                  if (!isPosInDeletion(tr.startState, p)) {
                    skip = false;
                    break;
                  }
                }
                if (!skip && viewRef.current) {
                  const adjFrom = d.from + offset;
                  const adjTo = d.to + offset;
                  tcMarkAsDeleted(viewRef.current, adjFrom, adjTo, null);
                }
              }
            } finally {
              skipTcDeleteBroadcast.current = false;
            }
          });
          if (insertParts.length === 0) {
            return { selection: tr.selection };
          }
          const lastIns = insertParts[insertParts.length - 1];
          return {
            changes: insertParts,
            selection: { anchor: lastIns.from + lastIns.insert.length },
          };
        }),
        EditorView.domEventHandlers({
          contextmenu(event, view) {
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos == null) return false;
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
          // Clear TC buffers on undo/redo — the history restores decorations directly,
          // so any pending buffer would create a stale/duplicate tracked change.
          // Also clean up tracked insertions that were removed by undo.
          for (const tr of update.transactions) {
            if (tr.isUserEvent('undo') || tr.isUserEvent('redo')) {
              tcDelBuffer.current = { from: null, to: null, text: '' };
              clearTimeout(tcDelTimer.current);
              tcInsertBuffer.current = { from: null, to: null, text: '' };
              clearTimeout(tcInsertTimer.current);

              // Check which pending tracked insertions no longer match the document after undo
              if (trackChangesModeRef.current && tr.docChanged) {
                const doc = update.state.doc.toString();
                onUndoInsertionsRef.current?.(doc);
              }
              break;
            }
          }

          if (update.docChanged) {
            // Map tracked-change buffers through ALL document changes (local + remote)
            // so positions stay correct regardless of interleaved OT updates.
            const delBuf = tcDelBuffer.current;
            if (delBuf.from !== null) {
              delBuf.from = update.changes.mapPos(delBuf.from, 1);
              delBuf.to = update.changes.mapPos(delBuf.to, -1);
              delBuf.text = update.state.sliceDoc(delBuf.from, delBuf.to);
              clearTimeout(tcDelTimer.current);
              tcDelTimer.current = setTimeout(flushDelBuffer, tcFlushDelay);
            }
            const insBuf = tcInsertBuffer.current;
            if (insBuf.from !== null) {
              insBuf.from = update.changes.mapPos(insBuf.from, 1);
              insBuf.to = update.changes.mapPos(insBuf.to, -1);
              insBuf.text = update.state.sliceDoc(insBuf.from, insBuf.to);
              clearTimeout(tcInsertTimer.current);
              tcInsertTimer.current = setTimeout(flushInsBuffer, tcFlushDelay);
            }

            if (!isRemoteUpdate.current) {
              const changes = [];
              update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
                changes.push({ from: fromA, to: toA, insert: inserted.toString() });
              });
              const isTracked = trackChangesModeRef.current && !isResolvingTc.current;
              // Attach pending deletion ranges (old-doc positions) so collaborator can
              // compute deletion marks locally after applying the OT change.
              const dels = pendingTcDeletions.current;
              pendingTcDeletions.current = null;
              onChangesRef.current?.(changes, isTracked, dels);

              // Record as tracked change if mode is on (debounced), but not when resolving a TC
              if (isTracked) {
                // Add immediate insertion decoration so blue underline appears instantly
                const insertDecos = [];
                update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
                  if (inserted.length > 0 && fromB < toB) {
                    insertDecos.push(
                      Decoration.mark({
                        class: 'cm-tc-insert',
                        attributes: { 'data-tc-type': 'insert' },
                      }).range(fromB, toB),
                    );
                  }
                });
                if (insertDecos.length > 0) {
                  const currentDecos = update.state.field(trackedChangesField);
                  const updated = currentDecos.update({ add: insertDecos, sort: true });
                  // Use queueMicrotask to avoid dispatching during an update listener
                  queueMicrotask(() => {
                    viewRef.current?.dispatch({ effects: setTrackedChangesEffect.of(updated) });
                  });
                }

                // Buffer insertion positions — extend existing buffer if adjacent/overlapping
                update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
                  if (inserted.length > 0 && fromB < toB) {
                    const buf = tcInsertBuffer.current;
                    if (buf.from !== null && fromB <= buf.to && toB >= buf.from) {
                      // Overlapping or adjacent — extend
                      buf.from = Math.min(buf.from, fromB);
                      buf.to = Math.max(buf.to, toB);
                    } else {
                      // Disjoint — flush old buffer, start new one
                      if (buf.from !== null) flushInsBuffer();
                      buf.from = fromB;
                      buf.to = toB;
                    }
                    buf.text = update.state.sliceDoc(buf.from, buf.to);
                  }
                });
                clearTimeout(tcInsertTimer.current);
                tcInsertTimer.current = setTimeout(flushInsBuffer, tcFlushDelay);
              }
            }

            const content = update.state.doc.toString();
            clearTimeout(saveTimeout.current);
            saveTimeout.current = setTimeout(() => {
              onSaveRef.current(content, computeTcPositions(content));
            }, 1000);

            // Hide comment button if doc changed
            setCommentBtn(null);

            // Update table and figure gutter markers
            updateTableGutterMarkers(update.view);
            updateFigureGutterMarkers(update.view);

            // Debounced lint (client-side only; server-side runs on compile)
            if (file?.path?.endsWith('.tex')) {
              clearTimeout(lintTimeout.current);
              lintTimeout.current = setTimeout(() => {
                const v = viewRef.current;
                if (!v) return;
                const diagnostics = latexLint(v.state.doc.toString());
                applyLintDiagnostics(v, diagnostics);
                setLintDiags(diagnostics);
                onLintDiagnosticsRef.current?.(diagnostics);
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
            onSelectionChangeRef.current?.({ from: sel.from, to: sel.to });
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
          const line = update.state.doc.lineAt(sel.head).number;
          onLineChangeRef.current?.(line);

          if (update.selectionSet && !isRemoteUpdate.current) {
            onCursorChangeRef.current?.(sel.head, sel.anchor);
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
                onSaveRef.current(content, computeTcPositions(content));
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
    if (file?.path?.endsWith('.tex')) {
      setTimeout(() => {
        const v = viewRef.current;
        if (!v) return;
        const diagnostics = latexLint(v.state.doc.toString());
        applyLintDiagnostics(v, diagnostics);
        setLintDiags(diagnostics);
        onLintDiagnosticsRef.current?.(diagnostics);
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

    // Flush pending save immediately (e.g. on file switch or unmount)
    const flushPendingSave = () => {
      if (saveTimeout.current) {
        clearTimeout(saveTimeout.current);
        saveTimeout.current = null;
        const v = viewRef.current;
        if (v) {
          const content = v.state.doc.toString();
          onSaveRef.current?.(content, computeTcPositions(content));
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
      clearTimeout(figureBuilderUpdateTimeout.current);
      view.destroy();
    };
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
  }, [spellLang]);

  useClickOutside(
    spellMenuRef,
    useCallback(() => setSpellMenu(null), []),
    !!spellMenu,
  );

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
    // Instead of rebuilding all decorations (which would use stale DB positions for remaining
    // TCs), we filter the existing correctly-mapped decorations to remove only the resolved ones.
    // We identify them by checking which decorations overlap with the resolved TC's position range.
    const resolvedTcs = trackedChanges.filter((c) => removedIds.has(c.id));

    // Remove resolved insertion decorations
    const currentInsertDecos = view.state.field(trackedChangesField);
    let filteredInserts = currentInsertDecos;
    for (const tc of resolvedTcs) {
      if (!tc.inserted_text) continue;
      // Filter out any insertion decoration that falls within this TC's approximate range
      const ranges = [];
      filteredInserts.between(0, view.state.doc.length, (from, to, deco) => {
        // Keep decorations that don't overlap with any resolved TC
        let dominated = false;
        if (from >= tc.from_pos - 2 && to <= tc.to_pos + 2) dominated = true;
        if (!dominated) ranges.push(deco.range(from, to));
      });
      filteredInserts = Decoration.set(ranges, true);
    }

    // Remove resolved deletion decorations
    const currentDeleteDecos = view.state.field(tcDeletesField);
    let filteredDeletes = currentDeleteDecos;
    for (const tc of resolvedTcs) {
      if (!tc.deleted_text) continue;
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
    localStorage.setItem('flowtex-font-size', String(fontSize));
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
            <span className={`editor-autosave-dot ${autoSaveOn ? 'on' : 'off'}`} />
            {autoSaveOn ? autoSaveLabel || 'Sync ON' : 'Sync'}
          </button>
        )}
        <button className="editor-header-btn" onClick={() => cmUndo(viewRef.current)} title="Undo (Cmd+Z)">
          <UndoIcon />
        </button>
        <button className="editor-header-btn" onClick={() => cmRedo(viewRef.current)} title="Redo (Cmd+Shift+Z)">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" />
          </svg>
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
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="3" y1="15" x2="21" y2="15" />
            <line x1="9" y1="3" x2="9" y2="21" />
            <line x1="15" y1="3" x2="15" y2="21" />
          </svg>
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
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </button>
        <button
          className="editor-header-btn"
          onClick={() => setShowSymbolPicker(true)}
          title="Insert symbol"
        >
          <span style={{ fontSize: 14, fontWeight: 600, lineHeight: 1 }}>Ω</span>
        </button>
        {onToggleTrackChanges && (
          <button
            className={`editor-header-tc-btn ${trackChangesMode ? 'editor-header-tc-active' : ''}`}
            onClick={onToggleTrackChanges}
            title={trackChangesMode ? 'Track changes ON — click to disable' : 'Track changes OFF — click to enable'}
          >
            <span className={`editor-autosave-dot ${trackChangesMode ? 'on' : 'off'}`} />
            Track changes{trackChangesMode ? ' ON' : ''}
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
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        )}
        <button
          className={`editor-header-btn ${inverted ? 'editor-header-btn-active' : ''}`}
          onClick={() =>
            setInverted((v) => {
              const n = !v;
              localStorage.setItem('flowtex-editor-inverted', String(n));
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
          onInsert={(table) => {
            const view = viewRef.current;
            if (view) {
              const from = tableBuilder.replaceFrom != null ? tableBuilder.replaceFrom : view.state.selection.main.from;
              const to = tableBuilder.replaceTo != null ? tableBuilder.replaceTo : view.state.selection.main.to;
              view.dispatch({ changes: { from, to, insert: table } });
              view.focus();
            }
          }}
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
