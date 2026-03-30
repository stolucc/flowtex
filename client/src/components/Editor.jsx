import React, { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import useClickOutside from '../hooks/useClickOutside.js';
import { EditorView, keymap, Decoration } from '@codemirror/view';
import { undo as cmUndo, redo as cmRedo } from '@codemirror/commands';
import { EditorState, Compartment, Prec } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import { stex } from '@codemirror/legacy-modes/mode/stex';
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
} from '../utils/editorExtensions.js';

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
    onTrackChange,
    onTrackedChangeClick,
    onDeleteInsertionChar,
    onToggleTrackChanges,
    citeKeys,
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
  const errorHighlightTimer = useRef(null);
  const lintTimeout = useRef(null);
  const spellTimeout = useRef(null);
  const dictRef = useRef(null);
  const currentUserNameRef = useRef(currentUserName);
  currentUserNameRef.current = currentUserName;
  const tcPendingChanges = useRef(null); // composed ChangeSet for debounce
  const tcStartDoc = useRef(null); // doc at start of debounce window
  const tcDebounceTimer = useRef(null);
  const tcDelBuffer = useRef({ from: null, to: null, text: '' });
  const tcDelTimer = useRef(null);
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
  const [showSymbolPicker, setShowSymbolPicker] = useState(false);
  const tableBuilderRef = useRef(null);
  tableBuilderRef.current = tableBuilder;
  const tableBuilderUpdateTimeout = useRef(null);

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
  trackChangesModeRef.current = trackChangesMode;
  trackedChangesRef.current = trackedChanges;
  const citeKeysRef = useRef(citeKeys || []);
  citeKeysRef.current = citeKeys || [];
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
      isRemoteUpdate.current = true; // don't re-track this change
      try {
        view.dispatch({ changes: { from: clampedFrom, to: clampedTo, insert: text } });
      } finally {
        isRemoteUpdate.current = false;
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
      view.dispatch({
        effects: [
          setTrackedChangesEffect.of(buildTcInsertDecorations(changes, docLen, currentUserNameRef.current)),
          setTcDeletesEffect.of(buildTcDeleteDecorations(changes, docLen, currentUserNameRef.current)),
        ],
      });
    },
    applyRemoteChanges(fileId, changes) {
      const view = viewRef.current;
      if (!view || fileId !== file?.id) return;
      isRemoteUpdate.current = true;
      try {
        view.dispatch({ changes });
      } finally {
        isRemoteUpdate.current = false;
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
    getSpellLang() {
      return spellLang;
    },
    setSpellLang(code) {
      setLanguage(code);
      setSpellLang(code);
    },
  }));

  // Mark a range as deleted (for track changes mode)
  const tcMarkAsDeleted = useCallback((view, from, to, cursorPos) => {
    const deletedText = view.state.sliceDoc(from, to);
    if (!deletedText) return;
    // Add deletion decoration immediately
    const currentDecos = view.state.field(tcDeletesField);
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
    // Buffer for debounced API call
    const buf = tcDelBuffer.current;
    if (buf.from !== null && (from === buf.from - 1 || from === buf.from || to === buf.to || to === buf.to + 1)) {
      buf.from = Math.min(buf.from, from);
      buf.to = Math.max(buf.to, to);
      buf.text = view.state.sliceDoc(buf.from, buf.to);
    } else {
      if (buf.from !== null) flushDelBuffer();
      buf.from = from;
      buf.to = to;
      buf.text = deletedText;
    }
    clearTimeout(tcDelTimer.current);
    tcDelTimer.current = setTimeout(flushDelBuffer, 800);
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

  // Create editor when file changes
  useEffect(() => {
    if (!containerRef.current || !file) return;

    if (viewRef.current) {
      viewRef.current.destroy();
    }
    setCommentBtn(null);
    prevTcIdsRef.current = new Set();

    commentCompartment.current = new Compartment();
    wrapCompartment.current = new Compartment();

    const state = EditorState.create({
      doc: file.content || '',
      extensions: [
        basicSetup,
        StreamLanguage.define(stex),
        syntaxHighlighting(classHighlighter, { fallback: true }),
        latexAutocomplete(citeKeysRef),
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
                if (isPosInInsertion(view.state, target)) {
                  isRemoteUpdate.current = true;
                  try {
                    view.dispatch({ changes: { from: target, to: target + 1 }, selection: { anchor: target } });
                  } finally {
                    isRemoteUpdate.current = false;
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
                if (isPosInInsertion(view.state, target)) {
                  isRemoteUpdate.current = true;
                  try {
                    view.dispatch({ changes: { from: target, to: target + 1 } });
                  } finally {
                    isRemoteUpdate.current = false;
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
          if (!trackChangesModeRef.current || !tr.docChanged || isRemoteUpdate.current) return tr;
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
          // Schedule deletion tracking — all deletions become separate tracked changes
          setTimeout(() => {
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
          }, 0);
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
            // Also check decorations (for optimistic deletions not yet in array)
            let found = false;
            view.state.field(tcDeletesField).between(pos, pos + 1, (from, to) => {
              if (pos >= from && pos < to) found = true;
            });
            if (!found) {
              view.state.field(trackedChangesField).between(pos, pos + 1, (from, to) => {
                if (pos >= from && pos < to) found = true;
              });
            }
            if (found) {
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
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            // Map deletion buffer positions through document changes and reset its timer
            const buf = tcDelBuffer.current;
            if (buf.from !== null) {
              buf.from = update.changes.mapPos(buf.from, 1);
              buf.to = update.changes.mapPos(buf.to, -1);
              buf.text = update.state.sliceDoc(buf.from, buf.to);
              // Reset the deletion flush timer — don't flush while positions are still shifting
              clearTimeout(tcDelTimer.current);
              tcDelTimer.current = setTimeout(flushDelBuffer, 800);
            }

            if (!isRemoteUpdate.current) {
              const changes = [];
              update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
                changes.push({ from: fromA, to: toA, insert: inserted.toString() });
              });
              onChangesRef.current?.(changes);

              // Record as tracked change if mode is on (debounced)
              if (trackChangesModeRef.current) {
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

                if (tcPendingChanges.current) {
                  tcPendingChanges.current = tcPendingChanges.current.compose(update.changes);
                } else {
                  tcStartDoc.current = update.startState.doc;
                  tcPendingChanges.current = update.changes;
                }
                clearTimeout(tcDebounceTimer.current);
                tcDebounceTimer.current = setTimeout(() => {
                  const changes = tcPendingChanges.current;
                  const startDoc = tcStartDoc.current;
                  tcPendingChanges.current = null;
                  tcStartDoc.current = null;
                  if (!changes || !startDoc) return;
                  // Only handle insertions here — deletions are handled separately via tcMarkAsDeleted
                  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
                    const insertedText = inserted.toString();
                    if (insertedText) {
                      onTrackChangeRef.current?.({
                        from_pos: fromB,
                        to_pos: fromB + insertedText.length,
                        inserted_text: insertedText,
                        deleted_text: '',
                      });
                    }
                  });
                }, 800);
              }
            }

            const content = update.state.doc.toString();
            clearTimeout(saveTimeout.current);
            saveTimeout.current = setTimeout(() => {
              onSaveRef.current(content);
            }, 1000);

            // Hide comment button if doc changed
            setCommentBtn(null);

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

            // Debounced spellcheck — reuse doc string from lint timeout if both fire
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
          const sel = update.state.selection.main;
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
                const parsed = findTableAtCursor(view);
                if (parsed) {
                  const prev = tableBuilderRef.current;
                  if (prev && (parsed.from !== prev.replaceFrom || parsed.to !== prev.replaceTo)) {
                    setTableBuilder({ initial: parsed, replaceFrom: parsed.from, replaceTo: parsed.to });
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
                onSaveRef.current(view.state.doc.toString());
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
    // Initial spellcheck
    setTimeout(async () => {
      const v = viewRef.current;
      if (!v) return;
      if (!dictRef.current) dictRef.current = await getDictionary();
      if (!dictRef.current) return;
      const misspelled = spellcheckText(v.state.doc.toString(), dictRef.current);
      applySpellcheck(v, misspelled);
    }, 800);

    return () => {
      view.scrollDOM.removeEventListener('scroll', handleScroll);
      clearTimeout(saveTimeout.current);
      clearTimeout(lintTimeout.current);
      clearTimeout(spellTimeout.current);
      clearTimeout(errorHighlightTimer.current);
      clearTimeout(tcDebounceTimer.current);
      clearTimeout(tcDelTimer.current);
      clearTimeout(tableBuilderUpdateTimeout.current);
      view.destroy();
    };
  }, [file?.id]);

  // Re-run spellcheck when language changes
  useEffect(() => {
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

  // Update tracked change decorations
  // Insertion decorations rebuild whenever the set of pending IDs changes (additions or removals).
  // Deletion decorations only rebuild on file load or resolution (IDs removed) — because
  // optimistic deletion decorations in tcDeletesField are already correctly mapped through
  // document changes, and rebuilding from stale server positions would overwrite them.
  const prevTcIdsRef = useRef(new Set());
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentIds = new Set(trackedChanges.filter((c) => c.status === 'pending').map((c) => c.id));
    const prevIds = prevTcIdsRef.current;

    const idsChanged =
      currentIds.size !== prevIds.size ||
      [...currentIds].some((id) => !prevIds.has(id)) ||
      [...prevIds].some((id) => !currentIds.has(id));
    if (!idsChanged) {
      prevTcIdsRef.current = currentIds;
      return;
    }

    const wasRemoved = [...prevIds].some((id) => !currentIds.has(id));
    const isInitialLoad = prevIds.size === 0 && currentIds.size > 0;

    prevTcIdsRef.current = currentIds;

    const docLen = view.state.doc.length;
    const effects = [
      setTrackedChangesEffect.of(buildTcInsertDecorations(trackedChanges, docLen, currentUserNameRef.current)),
    ];

    // Only rebuild deletion decorations on file load or resolution
    if (wasRemoved || isInitialLoad) {
      effects.push(setTcDeletesEffect.of(buildTcDeleteDecorations(trackedChanges, docLen, currentUserNameRef.current)));
    }

    view.dispatch({ effects });
  }, [trackedChanges]);

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
            title={autoSaveOn ? autoSaveLabel || 'Auto-save ON — click to disable' : 'Auto-save OFF — click to enable'}
          >
            <span className={`editor-autosave-dot ${autoSaveOn ? 'on' : 'off'}`} />
            {autoSaveOn ? autoSaveLabel || 'Auto-save ON' : 'Auto-save OFF'}
          </button>
        )}
        <button className="editor-header-btn" onClick={() => cmUndo(viewRef.current)} title="Undo (Cmd+Z)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </button>
        <button className="editor-header-btn" onClick={() => cmRedo(viewRef.current)} title="Redo (Cmd+Shift+Z)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" />
          </svg>
        </button>
        <span className="editor-zoom-controls">
          <button className="editor-header-btn" onClick={() => setFontSize((s) => Math.max(8, s - 1))} title="Zoom out">
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
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
          <span className="editor-zoom-label" title="Font size">
            {fontSize}px
          </span>
          <button className="editor-header-btn" onClick={() => setFontSize((s) => Math.min(32, s + 1))} title="Zoom in">
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
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="11" y1="8" x2="11" y2="14" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
        </span>
        <button className="editor-header-btn" onClick={() => setShowSearch(true)} title="Find & Replace (Cmd+F)">
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
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
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
            const parsed = findTableAtCursor(view);
            if (parsed) {
              setTableBuilder({ initial: parsed, replaceFrom: parsed.from, replaceTo: parsed.to });
            } else {
              setTableBuilder({});
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
        {onToggleTrackChanges && (
          <button
            className={`editor-header-tc-btn ${trackChangesMode ? 'editor-header-tc-active' : ''}`}
            onClick={onToggleTrackChanges}
            title={trackChangesMode ? 'Track changes ON — click to disable' : 'Track changes OFF — click to enable'}
          >
            <span className={`editor-autosave-dot ${trackChangesMode ? 'on' : 'off'}`} />
            Track changes {trackChangesMode ? 'ON' : 'OFF'}
          </button>
        )}
        <button
          className={`editor-header-btn ${inverted ? 'editor-header-btn-active' : ''}`}
          style={{ marginLeft: 'auto' }}
          onClick={() =>
            setInverted((v) => {
              const n = !v;
              localStorage.setItem('flowtex-editor-inverted', String(n));
              return n;
            })
          }
          title="Invert colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 3v18a9 9 0 0 1 0-18z" fill="currentColor" />
          </svg>
        </button>
      </div>
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
