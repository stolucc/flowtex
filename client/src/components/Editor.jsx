import React, { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { EditorView, keymap, Decoration, ViewPlugin, WidgetType, gutter, GutterMarker } from '@codemirror/view';
import { EditorState, ChangeSet, Compartment, StateEffect, StateField, Prec, RangeSet } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import latexLint from '../utils/latexLint.js';
import { parse as parseLatex, findTableAtPos, parseTable } from '../utils/latexParser.js';
import { getDictionary, spellcheckText, addToCustomDictionary, ignoreWord, LANGUAGES, getLanguage, setLanguage } from '../utils/spellcheck.js';
import latexAutocomplete from '../utils/latexCompletions.js';

function buildCommentDecorations(comments, docLength) {
  const widgets = [];
  for (const c of (comments || [])) {
    if (c.resolved) continue;
    try {
      const from = Math.min(c.from_pos, c.to_pos);
      const to = Math.max(c.from_pos, c.to_pos);
      if (from >= 0 && to <= docLength) {
        widgets.push(
          Decoration.mark({ class: 'cm-comment-highlight', attributes: { 'data-comment-id': c.id } }).range(from, to)
        );
      }
    } catch (e) {}
  }
  widgets.sort((a, b) => a.from - b.from);
  return Decoration.set(widgets);
}

function commentHighlighter(comments) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = buildCommentDecorations(comments, view.state.doc.length);
      }
      update() {}
    },
    { decorations: (v) => v.decorations }
  );
}

// Remote cursor decoration
class CursorWidget extends WidgetType {
  constructor(userName, color) {
    super();
    this.userName = userName;
    this.color = color;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-remote-cursor';
    el.style.borderLeftColor = this.color;
    const label = document.createElement('span');
    label.className = 'cm-remote-cursor-label';
    label.style.backgroundColor = this.color;
    label.textContent = this.userName;
    el.appendChild(label);
    return el;
  }
}

const setCursorsEffect = StateEffect.define();

const remoteCursorsField = StateField.define({
  create() { return Decoration.none; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setCursorsEffect)) return e.value;
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Error highlight decoration
const setErrorHighlightEffect = StateEffect.define();

const errorHighlightField = StateField.define({
  create() { return Decoration.none; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setErrorHighlightEffect)) return e.value;
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const CURSOR_COLORS = ['#e06c75', '#61afef', '#c678dd', '#98c379', '#e5c07b', '#56b6c2', '#be5046'];
function cursorColor(userId) {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0;
  return CURSOR_COLORS[Math.abs(h) % CURSOR_COLORS.length];
}

// Tracked changes — insertion highlights
const setTrackedChangesEffect = StateEffect.define();

const trackedChangesField = StateField.define({
  create() { return Decoration.none; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setTrackedChangesEffect)) return e.value;
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Tracked changes — deletion strikethroughs (separate field so we can query it)
const setTcDeletesEffect = StateEffect.define();

const tcDeletesField = StateField.define({
  create() { return Decoration.none; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setTcDeletesEffect)) return e.value;
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

function isPosInDeletion(state, pos) {
  const decos = state.field(tcDeletesField);
  let found = false;
  decos.between(pos, pos + 1, (from, to) => {
    if (pos >= from && pos < to) found = true;
  });
  return found;
}

function isPosInInsertion(state, pos) {
  const decos = state.field(trackedChangesField);
  let found = false;
  decos.between(pos, pos + 1, (from, to) => {
    if (pos >= from && pos < to) found = true;
  });
  return found;
}

// Track changes gutter markers
class TcInsertGutterMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-tc-gutter-insert';
    return el;
  }
}
class TcDeleteGutterMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-tc-gutter-delete';
    return el;
  }
}
const tcInsertMarkerInstance = new TcInsertGutterMarker();
const tcDeleteMarkerInstance = new TcDeleteGutterMarker();

const tcInsertGutterField = StateField.define({
  create() { return RangeSet.empty; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setTrackedChangesEffect)) {
        // Rebuild gutter markers from insertion decorations
        const lines = new Set();
        const doc = tr.state.doc;
        e.value.between(0, doc.length, (from) => {
          lines.add(doc.lineAt(from).from);
        });
        const markers = [];
        for (const lineStart of [...lines].sort((a, b) => a - b)) {
          markers.push(tcInsertMarkerInstance.range(lineStart));
        }
        return RangeSet.of(markers);
      }
    }
    return value.map(tr.changes);
  },
});

const tcDeleteGutterField = StateField.define({
  create() { return RangeSet.empty; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setTcDeletesEffect)) {
        const lines = new Set();
        const doc = tr.state.doc;
        e.value.between(0, doc.length, (from) => {
          lines.add(doc.lineAt(from).from);
        });
        const markers = [];
        for (const lineStart of [...lines].sort((a, b) => a - b)) {
          markers.push(tcDeleteMarkerInstance.range(lineStart));
        }
        return RangeSet.of(markers);
      }
    }
    return value.map(tr.changes);
  },
});

const tcInsertGutterExtension = gutter({
  class: 'cm-tc-insert-gutter',
  markers: (view) => view.state.field(tcInsertGutterField),
});

const tcDeleteGutterExtension = gutter({
  class: 'cm-tc-delete-gutter',
  markers: (view) => view.state.field(tcDeleteGutterField),
});

function buildTcInsertDecorations(trackedChanges, docLength) {
  const decos = [];
  for (const tc of (trackedChanges || [])) {
    if (tc.status !== 'pending') continue;
    if (!tc.inserted_text) continue;
    try {
      const from = Math.max(0, Math.min(tc.from_pos, docLength));
      const to = Math.max(from, Math.min(tc.to_pos, docLength));
      if (from < to) {
        decos.push(
          Decoration.mark({
            class: 'cm-tc-insert',
            attributes: {
              'data-tc-id': tc.id,
              'data-tc-author': tc.author_name,
              title: `Inserted by ${tc.author_name === currentUserNameRef.current ? 'You' : tc.author_name}`,
            },
          }).range(from, to)
        );
      }
    } catch (e) {}
  }
  decos.sort((a, b) => a.from - b.from);
  return Decoration.set(decos, true);
}

function buildTcDeleteDecorations(trackedChanges, docLength) {
  const decos = [];
  for (const tc of (trackedChanges || [])) {
    if (tc.status !== 'pending') continue;
    if (!tc.deleted_text) continue;
    try {
      // Deletions always use from_pos..to_pos
      const from = Math.max(0, Math.min(tc.from_pos, docLength));
      const to = Math.max(from, Math.min(tc.to_pos, docLength));
      if (from < to) {
        decos.push(
          Decoration.mark({
            class: 'cm-tc-delete',
            attributes: {
              'data-tc-id': tc.id,
              'data-tc-author': tc.author_name,
              title: `Deleted by ${tc.author_name === currentUserNameRef.current ? 'You' : tc.author_name}`,
            },
          }).range(from, to)
        );
      }
    } catch (e) {}
  }
  decos.sort((a, b) => a.from - b.from);
  return Decoration.set(decos, true);
}

// Search highlight decoration
const setSearchHighlightEffect = StateEffect.define();

const searchHighlightField = StateField.define({
  create() { return Decoration.none; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSearchHighlightEffect)) return e.value;
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});


const TABLE_ENV_OPTIONS = [
  { value: 'tabular', label: 'tabular' },
  { value: 'tabularx', label: 'tabularx (full width)' },
  { value: 'longtable', label: 'longtable (multi-page)' },
  { value: 'array', label: 'array (math mode)' },
];

// Table environment names the regex fallback should match
const TABLE_RE_NAMES = 'tabular\\*?|tabularx|tabulary|tabu|longtabu|array|longtable|supertabular\\*?|NiceTabular\\*?|NiceArray';

// Regex fallback: find the table environment containing position `pos`
function findTableByRegex(source, pos) {
  const beginRe = new RegExp('\\\\begin\\{(' + TABLE_RE_NAMES + ')\\}', 'g');
  let match;
  const candidates = [];
  while ((match = beginRe.exec(source)) !== null) {
    const envName = match[1];
    const start = match.index;
    const endRe = new RegExp('\\\\end\\{' + envName.replace(/\*/g, '\\*') + '\\}', 'g');
    endRe.lastIndex = start + match[0].length;
    const endMatch = endRe.exec(source);
    if (endMatch) {
      const end = endMatch.index + endMatch[0].length;
      if (pos >= start && pos <= end) {
        candidates.push({ start, end, envName });
      }
    }
  }
  // Also check for \begin{table} wrapper
  const tableRe = /\\begin\{table\*?\}/g;
  while ((match = tableRe.exec(source)) !== null) {
    const start = match.index;
    const envName = match[0].match(/\{(.+)\}/)[1];
    const endRe = new RegExp('\\\\end\\{' + envName.replace(/\*/g, '\\*') + '\\}', 'g');
    endRe.lastIndex = start + match[0].length;
    const endMatch = endRe.exec(source);
    if (endMatch) {
      const end = endMatch.index + endMatch[0].length;
      if (pos >= start && pos <= end) {
        candidates.push({ start, end, envName });
      }
    }
  }
  if (candidates.length === 0) return null;
  // Outermost
  candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const outer = candidates[0];
  return { from: outer.start, to: outer.end, text: source.slice(outer.start, outer.end) };
}

// Find and parse a table at the cursor using the AST parser, with regex fallback
function findTableAtCursor(view) {
  const pos = view.state.selection.main.head;
  const source = view.state.doc.toString();

  // Try AST parser first
  try {
    const tree = parseLatex(source);
    const tableInfo = findTableAtPos(tree, pos);
    if (tableInfo) {
      return parseTable(tableInfo, source);
    }
  } catch (e) {
    console.warn('AST table detection failed, using fallback:', e);
  }

  // Regex fallback
  const found = findTableByRegex(source, pos);
  if (!found) return null;
  return parseTableFromText(found.text, found.from);
}

// Simple regex-based table parser (fallback)
function parseTableFromText(text, offset) {
  const result = {
    env: 'tabular', alignment: 'c', borders: 'none',
    headerRow: false, boldHeader: false, caption: false,
    captionText: '', label: '', centering: false,
    zebra: false, booktabs: false, rows: 0, cols: 0, cells: [],
    from: offset, to: offset + text.length,
  };

  // Detect float wrapper
  result.centering = /\\centering/.test(text);
  result.zebra = /\\rowcolors/.test(text);
  if (/\\toprule|\\midrule|\\bottomrule/.test(text)) {
    result.borders = 'booktabs';
  }

  const captionMatch = text.match(/\\caption\{(.+?)\}/);
  if (captionMatch) { result.caption = true; result.captionText = captionMatch[1]; }

  const labelMatch = text.match(/\\label\{(.+?)\}/);
  if (labelMatch) result.label = labelMatch[1];

  // Find inner env and colspec
  const envMatch = text.match(/\\begin\{(tabular\*?|tabularx|tabulary|tabu|longtabu?|array|longtable|supertabular\*?|NiceTabular\*?|NiceArray)\}(?:\{[^}]*\})?\{([^}]*)\}/)
    || text.match(/\\begin\{(tabular\*?|tabularx|tabulary|tabu|longtabu?|array|longtable|supertabular\*?|NiceTabular\*?|NiceArray)\}\{([^}]*)\}/);
  if (envMatch) {
    result.env = envMatch[1];
    const spec = envMatch[2] || envMatch[3] || '';
    const stripped = spec.replace(/\|/g, '').replace(/[><!@]\{[^}]*\}/g, '').replace(/[pmb]\{[^}]*\}/g, 'l').replace(/\s/g, '');
    if (/^l+$/.test(stripped)) result.alignment = 'l';
    else if (/^r+$/.test(stripped)) result.alignment = 'r';
    else if (/^c+$/.test(stripped)) result.alignment = 'c';
    else if (/^X+$/.test(stripped)) result.alignment = 'c';
    else if (stripped.length > 0) result.alignment = stripped[0];
    result.cols = stripped.length || 0;
    if (/\|/.test(spec)) result.borders = 'all';
  }

  if (result.borders !== 'booktabs' && /\\hline/.test(text)) {
    // Count hlines to distinguish modes
    const hlineCount = (text.match(/\\hline/g) || []).length;
    if (hlineCount <= 2) result.borders = 'outside';
    else if (hlineCount <= 3) result.borders = 'header';
    else result.borders = 'all';
  }

  // Parse rows
  const innerMatch = text.match(/\\begin\{(?:tabular\*?|tabularx|tabulary|tabu|longtabu?|array|longtable|supertabular\*?|NiceTabular\*?|NiceArray)\}(?:\{[^}]*\})*\s*([\s\S]*?)\\end\{/);
  if (innerMatch) {
    const body = innerMatch[1];
    const rawRows = body.split(/\\\\/).map(r => r.trim()).filter(r => r && !/^\\(?:hline|toprule|midrule|bottomrule|cline\{[^}]*\}|endfirsthead|endhead|endfoot|endlastfoot|caption\{[^}]*\}|label\{[^}]*\})$/.test(r));
    const cellRows = rawRows.map(row => {
      const cleaned = row.replace(/\\(?:hline|toprule|midrule|bottomrule|cline\{[^}]*\}|endfirsthead|endhead|endfoot|endlastfoot)\s*/g, '').trim();
      if (!cleaned || /^\\caption/.test(cleaned) || /^\\label/.test(cleaned)) return null;
      return cleaned.split('&').map(c => c.trim());
    }).filter(Boolean);
    result.cells = cellRows;
    result.rows = cellRows.length;
    if (cellRows.length > 0) result.cols = Math.max(result.cols, ...cellRows.map(r => r.length));
    if (cellRows.length > 0) {
      const first = cellRows[0];
      if (first.some(c => c.length > 0)) {
        result.headerRow = true;
        result.boldHeader = first.some(c => /\\textbf\s*\{/.test(c));
      }
    }
  }

  return result;
}

function TableGridPicker({ onInsert, onClose, initial }) {
  const MAX_ROWS = 12;
  const MAX_COLS = 12;
  const [hover, setHover] = useState({ r: 0, c: 0 });
  const [rows, setRows] = useState(initial?.rows || 0);
  const [cols, setCols] = useState(initial?.cols || 0);
  const [sizeConfirmed, setSizeConfirmed] = useState(!!initial?.cells);
  const [alignment, setAlignment] = useState(initial?.alignment || 'c');
  const [borders, setBorders] = useState(initial?.borders || 'none');
  const [headerRow, setHeaderRow] = useState(initial?.headerRow ?? true);
  const [caption, setCaption] = useState(initial?.caption || false);
  const [captionText, setCaptionText] = useState(initial?.captionText || '');
  const [label, setLabel] = useState(initial?.label || '');
  const [env, setEnv] = useState(initial?.env || 'tabular');
  const [centering, setCentering] = useState(initial?.centering ?? true);
  const [boldHeader, setBoldHeader] = useState(initial?.boldHeader || false);
  const [zebra, setZebra] = useState(initial?.zebra || false);
  const [merges, setMerges] = useState(initial?.merges || []);
  // Vertical lines: array of cols+1 booleans (left edge, between each col, right edge)
  const [vlines, setVlines] = useState(() => {
    if (initial?.vlines) return initial.vlines;
    if (initial?.borders === 'all') return Array(initial.cols + 1).fill(true);
    return Array((initial?.cols || 0) + 1).fill(false);
  });
  const [selection, setSelection] = useState(null); // { startRow, startCol, endRow, endCol }
  const [selecting, setSelecting] = useState(false);

  const isEditing = !!initial?.cells;
  const hasSize = rows > 0 && cols > 0;

  // Compute minimum rows/cols based on last row/col with actual content
  let minRows = 0, minCols = 0;
  if (isEditing && initial.cells) {
    for (let r = initial.cells.length - 1; r >= 0; r--) {
      if (initial.cells[r]?.some(c => c != null && c.trim().length > 0)) { minRows = r + 1; break; }
    }
    for (const row of initial.cells) {
      if (!row) continue;
      for (let c = row.length - 1; c >= 0; c--) {
        if (row[c] != null && row[c].trim().length > 0 && c + 1 > minCols) { minCols = c + 1; break; }
      }
    }
  }

  const handleGridClick = (r, c) => {
    const newCols = Math.max(c, minCols);
    setRows(Math.max(r, minRows));
    setCols(newCols);
    setSizeConfirmed(true);
    // Resize vlines array to match new column count
    setVlines(prev => {
      const needed = newCols + 1;
      if (prev.length === needed) return prev;
      if (prev.length < needed) return [...prev, ...Array(needed - prev.length).fill(false)];
      return prev.slice(0, needed);
    });
  };

  function normalizeSelection(sel) {
    return {
      r1: Math.min(sel.startRow, sel.endRow), c1: Math.min(sel.startCol, sel.endCol),
      r2: Math.max(sel.startRow, sel.endRow), c2: Math.max(sel.startCol, sel.endCol),
    };
  }
  function isInSelection(sel, r, c) {
    const { r1, c1, r2, c2 } = normalizeSelection(sel);
    return r >= r1 && r <= r2 && c >= c1 && c <= c2;
  }
  function selectionSpan(sel) {
    const { r1, c1, r2, c2 } = normalizeSelection(sel);
    return { rows: r2 - r1 + 1, cols: c2 - c1 + 1, cells: (r2 - r1 + 1) * (c2 - c1 + 1) };
  }
  function selectionOverlapsMerge(merges, sel) {
    if (!sel || !merges.length) return false;
    const { r1, c1, r2, c2 } = normalizeSelection(sel);
    return merges.some(m => {
      const mr2 = m.row + m.rowSpan - 1, mc2 = m.col + m.colSpan - 1;
      const overlaps = m.row <= r2 && mr2 >= r1 && m.col <= c2 && mc2 >= c1;
      // Fully contained is OK (we'd unmerge first), partial is not
      const fullyContained = m.row >= r1 && mr2 <= r2 && m.col >= c1 && mc2 <= c2;
      return overlaps && !fullyContained;
    });
  }

  const handleInsert = () => {
    if (!hasSize) return;
    // When editing, preserve existing cell content where possible
    const cells = initial?.cells || [];
    const table = generateLatexTable({ rows, cols, alignment, borders, headerRow, caption, captionText, label, env, centering, boldHeader, zebra, cells, rawColSpec: initial?.rawColSpec, longtablePreamble: initial?.longtablePreamble, alignments: initial?.alignments, merges, vlines });
    onInsert(table);
    onClose();
  };

  return (
    <div className="table-builder">
      <div className="table-builder-left">
        <div className="table-grid-label">{hover.r > 0 ? `${hover.r} \u00d7 ${hover.c}` : hasSize ? `${rows} \u00d7 ${cols}` : 'Select size'}</div>
        <div className="table-grid" onMouseEnter={() => setSizeConfirmed(false)} onMouseLeave={() => { setHover({ r: 0, c: 0 }); setSizeConfirmed(hasSize); }}>
          {Array.from({ length: MAX_ROWS }, (_, r) => (
            <div key={r} className="table-grid-row">
              {Array.from({ length: MAX_COLS }, (_, c) => (
                <div
                  key={c}
                  className={`table-grid-cell ${r < (hover.r || rows) && c < (hover.c || cols) ? 'active' : ''}${isEditing && (r < minRows && c < minCols) ? ' locked' : ''}`}
                  onMouseEnter={() => setHover({ r: Math.max(r + 1, minRows), c: Math.max(c + 1, minCols) })}
                  onClick={() => handleGridClick(r + 1, c + 1)}
                />
              ))}
            </div>
          ))}
        </div>
        {isEditing && <div className="table-builder-editing">Editing table</div>}
      </div>
      <div className="table-builder-opts">
        <div className="table-opt-row">
          <label className="table-opt-label">Environment</label>
          <select className="table-opt-select" value={env} onChange={e => setEnv(e.target.value)}>
            {TABLE_ENV_OPTIONS.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}
          </select>
        </div>
        <div className="table-opt-row">
          <label className="table-opt-label">Alignment</label>
          <div className="table-opt-btns">
            {[['l', 'Left'], ['c', 'Center'], ['r', 'Right']].map(([v, l]) => (
              <button key={v} className={`table-opt-btn ${alignment === v ? 'active' : ''}`} onClick={() => setAlignment(v)} title={l}>{l[0]}</button>
            ))}
          </div>
        </div>
        <div className="table-opt-row">
          <label className="table-opt-label">Booktabs</label>
          <div className="table-vlines-icons">
            <button className={`table-vline-icon${borders === 'booktabs' ? ' active' : ''}`}
              title="Booktabs (toprule/midrule/bottomrule)" onClick={() => {
                setBorders('booktabs');
                setVlines(Array(cols + 1).fill(false));
              }}>
              <svg width="20" height="16" viewBox="0 0 20 16">
                <rect x="2" y="1" width="16" height="14" fill="none" stroke="#888" strokeWidth="1" />
                <line x1="2" y1="1" x2="18" y2="1" stroke="var(--accent, #4fc3f7)" strokeWidth="2.5" />
                <line x1="2" y1="5.5" x2="18" y2="5.5" stroke="var(--accent, #4fc3f7)" strokeWidth="1" />
                <line x1="2" y1="15" x2="18" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="2.5" />
              </svg>
            </button>
            <span className="table-vlines-sep" />
          </div>
        </div>
        <div className="table-opt-row">
          <label className="table-opt-label">Horizontal lines</label>
          <div className={`table-vlines-icons${borders === 'booktabs' ? ' disabled' : ''}`}>
            {[
              { mode: 'none', title: 'None', lines: [] },
              { mode: 'outside', title: 'Top & Bottom', lines: [[1, 15]] },
              { mode: 'header', title: 'Top, Header & Bottom', lines: [[1, 15], [5.5, null]] },
              { mode: 'all', title: 'All', lines: [[1, 15], [5.5, null], [10, null]] },
            ].map(({ mode, title, lines: hlines }) => (
              <button key={mode} className={`table-vline-icon${borders === mode ? ' active' : ''}`}
                title={title} disabled={borders === 'booktabs'} onClick={() => setBorders(mode)}>
                <svg width="20" height="16" viewBox="0 0 20 16">
                  <rect x="2" y="1" width="16" height="14" fill="none" stroke="#888" strokeWidth="1" />
                  {hlines.map((hl, i) => {
                    if (hl[1] !== null) {
                      return <React.Fragment key={i}>
                        <line x1="2" y1={hl[0]} x2="18" y2={hl[0]} stroke="var(--accent, #4fc3f7)" strokeWidth="2" />
                        <line x1="2" y1={hl[1]} x2="18" y2={hl[1]} stroke="var(--accent, #4fc3f7)" strokeWidth="2" />
                      </React.Fragment>;
                    }
                    return <line key={i} x1="2" y1={hl[0]} x2="18" y2={hl[0]} stroke="var(--accent, #4fc3f7)" strokeWidth="1.5" />;
                  })}
                </svg>
              </button>
            ))}
          </div>
        </div>
        {hasSize && (
          <div className="table-opt-row">
            <label className="table-opt-label">Vertical lines</label>
            <div className={`table-vlines-icons${borders === 'booktabs' ? ' disabled' : ''}`}>
              {['none', 'outside', 'all'].map(mode => {
                const current = vlines.every(v => v) ? 'all' :
                  vlines[0] && vlines[cols] && vlines.slice(1, cols).every(v => !v) ? 'outside' : 'none';
                return (
                  <button key={mode} className={`table-vline-icon${current === mode ? ' active' : ''}`}
                    title={mode.charAt(0).toUpperCase() + mode.slice(1)}
                    disabled={borders === 'booktabs'}
                    onClick={() => {
                      if (mode === 'all') setVlines(Array(cols + 1).fill(true));
                      else if (mode === 'outside') setVlines([true, ...Array(Math.max(0, cols - 1)).fill(false), true]);
                      else setVlines(Array(cols + 1).fill(false));
                    }}>
                    <svg width="20" height="16" viewBox="0 0 20 16">
                      <rect x="2" y="1" width="16" height="14" fill="none" stroke="#888" strokeWidth="1" />
                      {mode === 'outside' && (<>
                        <line x1="2" y1="1" x2="2" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="2" />
                        <line x1="18" y1="1" x2="18" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="2" />
                      </>)}
                      {mode === 'all' && (<>
                        <line x1="2" y1="1" x2="2" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="2" />
                        <line x1="7.5" y1="1" x2="7.5" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="1.5" />
                        <line x1="12.5" y1="1" x2="12.5" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="1.5" />
                        <line x1="18" y1="1" x2="18" y2="15" stroke="var(--accent, #4fc3f7)" strokeWidth="2" />
                      </>)}
                    </svg>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="table-opt-row table-opt-checks">
          <label className="table-opt-check"><input type="checkbox" checked={headerRow} onChange={() => setHeaderRow(v => !v)} /> Header row</label>
          <label className="table-opt-check"><input type="checkbox" checked={boldHeader} onChange={() => setBoldHeader(v => !v)} /> Bold header</label>
          <label className="table-opt-check"><input type="checkbox" checked={caption} onChange={() => setCaption(v => !v)} /> Caption</label>
          <label className="table-opt-check"><input type="checkbox" checked={centering} onChange={() => setCentering(v => !v)} /> Centered</label>
          <label className="table-opt-check"><input type="checkbox" checked={zebra} onChange={() => setZebra(v => !v)} /> Zebra stripes</label>
        </div>
        {caption && (
          <>
            <div className="table-opt-row">
              <label className="table-opt-label">Caption</label>
              <input className="table-opt-input" type="text" placeholder="Caption here" value={captionText} onChange={e => setCaptionText(e.target.value)} />
            </div>
            <div className="table-opt-row">
              <label className="table-opt-label">Label</label>
              <input className="table-opt-input" type="text" placeholder="tab:mytable" value={label} onChange={e => setLabel(e.target.value)} />
            </div>
          </>
        )}
      </div>
      <div className="table-builder-actions">
        <button className="table-builder-insert" onClick={handleInsert} disabled={!hasSize}>{isEditing ? 'Update' : 'Insert'}</button>
        <button className="table-builder-cancel" onClick={onClose}>Cancel</button>
      </div>
      {hasSize && (
        <div className="table-cell-layout">
          <div className="table-cell-layout-header">
            <span className="table-cell-layout-title">Cell layout</span>
            {selection && selectionSpan(selection).cells > 1 && !selectionOverlapsMerge(merges, selection) && (
              <button className="table-merge-btn" onClick={() => {
                const { r1, c1, r2, c2 } = normalizeSelection(selection);
                setMerges(prev => [...prev, { row: r1, col: c1, rowSpan: r2 - r1 + 1, colSpan: c2 - c1 + 1, align: alignment }]);
                setSelection(null);
              }}>Merge</button>
            )}
          </div>
          <div className="table-cell-preview" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
            onMouseUp={() => setSelecting(false)}
            onMouseLeave={() => setSelecting(false)}
          >
            {Array.from({ length: rows }, (_, r) =>
              Array.from({ length: cols }, (_, c) => {
                const merge = getMergeAt(merges, r, c);
                const covered = isCoveredByMerge(merges, r, c);
                if (covered) return null;
                const cellContent = initial?.cells?.[r]?.[c];
                const display = cellContent != null ? cellContent.slice(0, 30) : '';
                const isSel = selection && isInSelection(selection, r, c);
                const style = {};
                if (merge) {
                  if (merge.colSpan > 1) style.gridColumn = `span ${merge.colSpan}`;
                  if (merge.rowSpan > 1) style.gridRow = `span ${merge.rowSpan}`;
                }
                return (
                  <div key={`${r}-${c}`}
                    className={`table-cell-preview-cell${isSel ? ' selected' : ''}${merge ? ' merged' : ''}${headerRow && r === 0 ? ' header' : ''}`}
                    style={style}
                    title={cellContent || `(${r+1}, ${c+1})`}
                    onMouseDown={(e) => { e.preventDefault(); setSelection({ startRow: r, startCol: c, endRow: r, endCol: c }); setSelecting(true); }}
                    onMouseEnter={() => { if (selecting) setSelection(prev => prev ? { ...prev, endRow: r, endCol: c } : prev); }}
                    onClick={() => {
                      // Click on merged cell: offer unmerge
                      if (merge) {
                        setMerges(prev => prev.filter(m => m !== merge));
                        setSelection(null);
                      }
                    }}
                  >
                    {merge && <span className="table-cell-merge-badge">{merge.colSpan > 1 || merge.rowSpan > 1 ? `${merge.rowSpan}×${merge.colSpan}` : ''}</span>}
                    {display}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function getMergeAt(merges, r, c) {
  return merges?.find(m => m.row === r && m.col === c) || null;
}

function isCoveredByMerge(merges, r, c) {
  if (!merges) return false;
  return merges.some(m => {
    if (m.row === r && m.col === c) return false; // origin, not covered
    return r >= m.row && r < m.row + m.rowSpan && c >= m.col && c < m.col + m.colSpan;
  });
}

// Returns the merge that covers cell (r,c) — but NOT the origin cell itself
function getCoveringMerge(merges, r, c) {
  if (!merges) return null;
  return merges.find(m => {
    if (m.row === r && m.col === c) return false; // origin, not covered
    return r >= m.row && r < m.row + m.rowSpan && c >= m.col && c < m.col + m.colSpan;
  }) || null;
}

function extractColParts(spec, maxCols) {
  const parts = [];
  let i = 0, current = '';
  function skipBraces() {
    if (i < spec.length && spec[i] === '{') {
      let d = 1; current += '{'; i++;
      while (i < spec.length && d > 0) {
        if (spec[i] === '{') d++;
        if (spec[i] === '}') d--;
        current += spec[i]; i++;
      }
    }
  }
  while (i < spec.length && parts.length < maxCols) {
    const ch = spec[i];
    if (/\s/.test(ch)) { i++; continue; }
    if ('><!@'.includes(ch)) { current += ch; i++; skipBraces(); continue; }
    if ('lcrX'.includes(ch)) { current += ch; i++; parts.push(current); current = ''; continue; }
    if ('pmbPMBLRCSW'.includes(ch) && i + 1 < spec.length && spec[i + 1] === '{') {
      current += ch; i++; skipBraces(); parts.push(current); current = ''; continue;
    }
    // '*' repeat — just treat as raw
    current += ch; i++;
  }
  if (current) { if (parts.length > 0) parts[parts.length - 1] += current; }
  return parts;
}

function generateLatexTable({ rows, cols, alignment, borders, headerRow, caption, captionText, label, env, centering, boldHeader, zebra, cells, rawColSpec, longtablePreamble, alignments, merges, vlines }) {
  // Build column spec: preserve original if column count unchanged, otherwise generate new
  let colSpec;
  if (rawColSpec && alignments && alignments.length === cols) {
    // Rebuild from original spec: strip all | then re-add based on current vlines
    const stripped = rawColSpec.replace(/\|/g, '');
    const vl = vlines || Array(cols + 1).fill(false);
    // Parse individual column specs from stripped string
    const colParts = extractColParts(stripped, cols);
    let spec = '';
    for (let c = 0; c < colParts.length; c++) {
      if (vl[c]) spec += '|';
      spec += colParts[c];
    }
    if (vl[colParts.length]) spec += '|';
    colSpec = spec;
  } else {
    // Build per-column spec
    let colSpecs;
    if (env === 'tabularx') {
      colSpecs = Array(cols).fill('X');
    } else {
      // Account for \tabcolsep padding (~6pt per side per column)
      const totalWidth = Math.max(0.5, 0.97 - cols * 0.035);
      const colWidth = (totalWidth / cols).toFixed(2);
      const w = `${colWidth}\\textwidth`;
      if (alignment === 'c') {
        colSpecs = Array(cols).fill(`>{\\centering\\arraybackslash}p{${w}}`);
      } else if (alignment === 'r') {
        colSpecs = Array(cols).fill(`>{\\raggedleft\\arraybackslash}p{${w}}`);
      } else {
        colSpecs = Array(cols).fill(`p{${w}}`);
      }
    }
    // Interleave with vertical lines
    const vl = vlines || Array(cols + 1).fill(false);
    let spec = '';
    for (let c = 0; c < cols; c++) {
      if (vl[c]) spec += '|';
      spec += colSpecs[c];
    }
    if (vl[cols]) spec += '|';
    colSpec = spec;
  }
  const isBooktabs = borders === 'booktabs';
  const hlineTop = !isBooktabs && (borders === 'outside' || borders === 'header' || borders === 'all');
  const hlineBottom = hlineTop;
  const hlineHeader = !isBooktabs && (borders === 'header' || borders === 'all');
  const hlineAll = !isBooktabs && borders === 'all';
  const capText = captionText || 'Caption here';

  const lines = [];

  // Preamble — float wrapper
  const needsFloat = caption || label;
  if (needsFloat && env !== 'longtable') {
    lines.push('\\begin{table}[htbp]');
    if (centering) lines.push('\\centering');
    if (zebra) lines.push('\\rowcolors{2}{gray!10}{}');
    if (caption) lines.push(`\\caption{${capText}}`);
    if (label) lines.push(`\\label{${label || 'tab:mytable'}}`);
  } else {
    if (centering) lines.push('\\begin{center}');
    if (zebra) lines.push('\\rowcolors{2}{gray!10}{}');
  }

  // Add row spacing when using rules (hlines or vlines make tables look cramped)
  const hasAnyRules = hlineTop || hlineAll || hlineHeader || isBooktabs || (vlines && vlines.some(v => v));
  if (hasAnyRules) {
    lines.push('\\renewcommand{\\arraystretch}{1.3}');
  }

  // Begin environment
  if (env === 'tabularx') {
    lines.push(`\\begin{tabularx}{\\textwidth}{${colSpec}}`);
  } else if (env === 'longtable') {
    lines.push(`\\begin{longtable}{${colSpec}}`);
    if (longtablePreamble) {
      // Preserve existing longtable preamble (caption, firsthead, endhead, endfoot, endlastfoot)
      lines.push(longtablePreamble.trim());
    } else {
      if (caption) lines.push(`\\caption{${capText}}`);
      if (label) lines.push(`\\label{${label || 'tab:mytable'}}`);
      if (isBooktabs) lines.push('\\toprule');
      else if (hlineTop) lines.push('\\hline');
    }
  } else {
    lines.push(`\\begin{${env}}{${colSpec}}`);
  }

  if (isBooktabs && env !== 'longtable') lines.push('\\toprule');
  else if (hlineTop && env !== 'longtable') lines.push('\\hline');

  // Rows — preserve existing cell content where available
  // For longtable with preamble, skip the header row (it's already in the preamble)
  const startRow = (longtablePreamble && headerRow) ? 1 : 0;
  const activeMerges = merges || [];
  for (let r = startRow; r < rows; r++) {
    const isHeader = headerRow && r === 0;
    const existingRow = cells && cells[r];
    const rowParts = [];
    for (let c = 0; c < cols; c++) {
      // Check if this cell is covered by a merge (not the origin)
      const coveringMerge = getCoveringMerge(activeMerges, r, c);
      if (coveringMerge) {
        // For multi-row merges that also span columns, subsequent rows need
        // an empty \multicolumn placeholder to keep column alignment correct.
        // Only emit the placeholder at the first covered column of the merge in this row.
        if (coveringMerge.colSpan > 1 && c === coveringMerge.col) {
          const vl = vlines || [];
          const leftBar = (c === 0 && vl[0]) ? '|' : '';
          const rightBar = vl[c + coveringMerge.colSpan] ? '|' : '';
          const baseAlign = (coveringMerge.align || alignment).replace(/\|/g, '');
          const mcolAlign = `${leftBar}${baseAlign}${rightBar}`;
          rowParts.push(`\\multicolumn{${coveringMerge.colSpan}}{${mcolAlign}}{}`);
        }
        // For single-column multirow, just push an empty cell
        else if (coveringMerge.colSpan === 1 && c === coveringMerge.col) {
          rowParts.push('');
        }
        // Otherwise skip (additional columns consumed by the multicolumn)
        continue;
      }

      const merge = getMergeAt(activeMerges, r, c);
      let content = (existingRow && c < existingRow.length && existingRow[c] != null) ? existingRow[c] : '';

      // Handle bold header toggle
      if (isHeader && content) {
        if (boldHeader && !/\\textbf\{/.test(content)) {
          content = `\\textbf{${content}}`;
        } else if (!boldHeader && /\\textbf\{/.test(content)) {
          content = content.replace(/\\textbf\{(.*?)\}/, '$1');
        }
      } else if (isHeader && !content) {
        const text = `Header ${c + 1}`;
        content = boldHeader ? `\\textbf{${text}}` : text;
      }

      if (merge) {
        // Wrap content in \multicolumn / \multirow as needed
        const baseAlign = (merge.align || alignment).replace(/\|/g, '');
        if (merge.colSpan > 1) {
          // Build multicolumn alignment spec with vlines
          const vl = vlines || [];
          const leftBar = (c === 0 && vl[0]) ? '|' : '';
          const rightBar = vl[c + merge.colSpan] ? '|' : '';
          const mcolAlign = `${leftBar}${baseAlign}${rightBar}`;
          if (merge.rowSpan > 1) {
            // Use * width (natural) when inside multicolumn; = is unreliable across multiple columns
            content = `\\multicolumn{${merge.colSpan}}{${mcolAlign}}{\\multirow{${merge.rowSpan}}{*}{${content}}}`;
          } else {
            content = `\\multicolumn{${merge.colSpan}}{${mcolAlign}}{${content}}`;
          }
        } else if (merge.rowSpan > 1) {
          content = `\\multirow{${merge.rowSpan}}{=}{${content}}`;
        }
      }

      rowParts.push(content);
    }
    const rowStr = rowParts.join(' & ') + ' \\\\';
    // Determine if any multirow spans cross from this row to the next
    const needsCline = activeMerges.some(m => r >= m.row && r < m.row + m.rowSpan - 1);
    const wantRule = (isHeader && (isBooktabs || hlineHeader)) || (!isHeader && hlineAll && r < rows - 1);
    const isLastRow = r === rows - 1;
    // Bottom rule: always full-width since no multirow can span past the last row
    const wantBottom = isLastRow && !longtablePreamble && (isBooktabs || hlineBottom);

    lines.push(rowStr);

    if (wantRule && needsCline) {
      // Use \cline for columns not covered by an active multirow span
      let c = 0;
      while (c < cols) {
        const spanning = activeMerges.find(m => r >= m.row && r < m.row + m.rowSpan - 1 && c >= m.col && c < m.col + m.colSpan);
        if (spanning) {
          c = spanning.col + spanning.colSpan;
        } else {
          const start = c + 1; // \cline is 1-based
          while (c < cols && !activeMerges.find(m => r >= m.row && r < m.row + m.rowSpan - 1 && c >= m.col && c < m.col + m.colSpan)) c++;
          lines.push(`\\cline{${start}-${c}}`);
        }
      }
    } else if (wantRule) {
      if (isHeader && isBooktabs) lines.push('\\midrule');
      else if (isHeader && hlineHeader) lines.push('\\hline');
      else if (!isHeader && hlineAll && r < rows - 1) lines.push('\\hline');
    }
  }

  if (isBooktabs && !longtablePreamble) lines.push('\\bottomrule');
  else if (hlineBottom && !longtablePreamble) lines.push('\\hline');

  // End environment
  lines.push(`\\end{${env === 'tabularx' ? 'tabularx' : env}}`);

  if (needsFloat && env !== 'longtable') {
    lines.push('\\end{table}');
  } else if (centering && env !== 'longtable') {
    lines.push('\\end{center}');
  }

  // Reset arraystretch if we changed it (float/center groups handle scoping, but be safe for longtable)
  if (hasAnyRules && env === 'longtable') {
    lines.push('\\renewcommand{\\arraystretch}{1.0}');
  }

  return lines.join('\n');
}

// [command, displayGlyph, requiredPackage or null]
const SYMBOL_CATEGORIES = [
  { name: 'Accented Letters', symbols: [
    // Acute
    ['\\\'{a}', '\u00E1'], ['\\\'{e}', '\u00E9'], ['\\\'{i}', '\u00ED'], ['\\\'{o}', '\u00F3'], ['\\\'{u}', '\u00FA'], ['\\\'{y}', '\u00FD'],
    ['\\\'{A}', '\u00C1'], ['\\\'{E}', '\u00C9'], ['\\\'{I}', '\u00CD'], ['\\\'{O}', '\u00D3'], ['\\\'{U}', '\u00DA'],
    ['\\\'{c}', '\u0107'], ['\\\'{n}', '\u0144'], ['\\\'{s}', '\u015B'], ['\\\'{z}', '\u017A'],
    // Grave
    ['\\`{a}', '\u00E0'], ['\\`{e}', '\u00E8'], ['\\`{i}', '\u00EC'], ['\\`{o}', '\u00F2'], ['\\`{u}', '\u00F9'],
    ['\\`{A}', '\u00C0'], ['\\`{E}', '\u00C8'], ['\\`{I}', '\u00CC'], ['\\`{O}', '\u00D2'], ['\\`{U}', '\u00D9'],
    // Circumflex
    ['\\^{a}', '\u00E2'], ['\\^{e}', '\u00EA'], ['\\^{i}', '\u00EE'], ['\\^{o}', '\u00F4'], ['\\^{u}', '\u00FB'],
    ['\\^{A}', '\u00C2'], ['\\^{E}', '\u00CA'], ['\\^{I}', '\u00CE'], ['\\^{O}', '\u00D4'], ['\\^{U}', '\u00DB'],
    // Umlaut / Diaeresis
    ['\\"{a}', '\u00E4'], ['\\"{e}', '\u00EB'], ['\\"{i}', '\u00EF'], ['\\"{o}', '\u00F6'], ['\\"{u}', '\u00FC'], ['\\"{y}', '\u00FF'],
    ['\\"{A}', '\u00C4'], ['\\"{E}', '\u00CB'], ['\\"{I}', '\u00CF'], ['\\"{O}', '\u00D6'], ['\\"{U}', '\u00DC'],
    // Tilde
    ['\\~{a}', '\u00E3'], ['\\~{n}', '\u00F1'], ['\\~{o}', '\u00F5'],
    ['\\~{A}', '\u00C3'], ['\\~{N}', '\u00D1'], ['\\~{O}', '\u00D5'],
    // Cedilla
    ['\\c{c}', '\u00E7'], ['\\c{C}', '\u00C7'], ['\\c{s}', '\u015F'], ['\\c{S}', '\u015E'], ['\\c{t}', '\u0163'], ['\\c{T}', '\u0162'],
    // Caron / Háček
    ['\\v{c}', '\u010D'], ['\\v{C}', '\u010C'], ['\\v{s}', '\u0161'], ['\\v{S}', '\u0160'], ['\\v{z}', '\u017E'], ['\\v{Z}', '\u017D'],
    ['\\v{r}', '\u0159'], ['\\v{R}', '\u0158'], ['\\v{e}', '\u011B'], ['\\v{n}', '\u0148'], ['\\v{d}', '\u010F'], ['\\v{t}', '\u0165'],
    // Breve
    ['\\u{a}', '\u0103'], ['\\u{A}', '\u0102'], ['\\u{g}', '\u011F'], ['\\u{G}', '\u011E'], ['\\u{i}', '\u012D'],
    // Macron
    ['\\={a}', '\u0101'], ['\\={e}', '\u0113'], ['\\={i}', '\u012B'], ['\\={o}', '\u014D'], ['\\={u}', '\u016B'],
    ['\\={A}', '\u0100'], ['\\={E}', '\u0112'], ['\\={I}', '\u012A'], ['\\={O}', '\u014C'], ['\\={U}', '\u016A'],
    // Dot above
    ['\\.{a}', '\u0227'], ['\\.{e}', '\u0117'], ['\\.{z}', '\u017C'], ['\\.{Z}', '\u017B'], ['\\.{I}', '\u0130'], ['\\.{G}', '\u0120'],
    // Ring
    ['\\r{a}', '\u00E5'], ['\\r{A}', '\u00C5'], ['\\r{u}', '\u016F'],
    // Double acute
    ['\\H{o}', '\u0151'], ['\\H{O}', '\u0150'], ['\\H{u}', '\u0171'], ['\\H{U}', '\u0170'],
    // Ogonek
    ['\\k{a}', '\u0105'], ['\\k{A}', '\u0104'], ['\\k{e}', '\u0119'], ['\\k{E}', '\u0118'],
    // Dot below
    ['\\d{a}', 'a\u0323'], ['\\d{s}', '\u1E63'], ['\\d{t}', '\u1E6D'], ['\\d{h}', '\u1E25'],
    // Bar below
    ['\\b{a}', 'a\u0332'],
    // Tie
    ['\\t{oo}', 'o\u0361o'],
  ]},
  { name: 'Special Characters', symbols: [
    ['\\aa', '\u00E5'], ['\\AA', '\u00C5'], ['\\ae', '\u00E6'], ['\\AE', '\u00C6'],
    ['\\oe', '\u0153'], ['\\OE', '\u0152'], ['\\o', '\u00F8'], ['\\O', '\u00D8'],
    ['\\ss', '\u00DF'], ['\\SS', 'SS'], ['\\i', '\u0131'], ['\\j', '\u0237'],
    ['\\l', '\u0142'], ['\\L', '\u0141'],
    ['\\dh', '\u00F0', 'fontenc'], ['\\DH', '\u00D0', 'fontenc'], ['\\th', '\u00FE', 'fontenc'], ['\\TH', '\u00DE', 'fontenc'],
    ['\\ng', '\u014B', 'fontenc'], ['\\NG', '\u014A', 'fontenc'],
    ['\\dj', '\u0111', 'fontenc'],
    ['?`', '\u00BF'], ['!`', '\u00A1'],
    ['{\\copyright}', '\u00A9'], ['{\\pounds}', '\u00A3'],
    ['\\texteuro', '\u20AC', 'textcomp'],
    ['\\textyen', '\u00A5', 'textcomp'],
    ['\\textcent', '\u00A2', 'textcomp'],
    ['\\textsterling', '\u00A3'],
    ['\\dag', '\u2020'], ['\\ddag', '\u2021'], ['\\textsection', '\u00A7'], ['\\textparagraph', '\u00B6'],
    ['\\textsuperscript{1}', '\u00B9'], ['\\textsuperscript{2}', '\u00B2'], ['\\textsuperscript{3}', '\u00B3'],
    ['\\textonehalf', '\u00BD', 'textcomp'], ['\\textonequarter', '\u00BC', 'textcomp'], ['\\textthreequarters', '\u00BE', 'textcomp'],
    ['\\textordfeminine', '\u00AA'], ['\\textordmasculine', '\u00BA'],
    ['\\textdegree', '\u00B0', 'textcomp'], ['\\texttrademark', '\u2122', 'textcomp'],
    ['\\textregistered', '\u00AE', 'textcomp'], ['\\textcopyright', '\u00A9'],
    ['\\guillemotleft', '\u00AB'], ['\\guillemotright', '\u00BB'],
    ['\\guilsinglleft', '\u2039'], ['\\guilsinglright', '\u203A'],
    ['\\textquoteleft', '\u2018'], ['\\textquoteright', '\u2019'],
    ['\\textquotedblleft', '\u201C'], ['\\textquotedblright', '\u201D'],
    ['\\quotedblbase', '\u201E'], ['\\quotesinglbase', '\u201A'],
    ['\\textendash', '\u2013'], ['\\textemdash', '\u2014'],
    ['\\textbullet', '\u2022'], ['\\textellipsis', '\u2026'],
    ['\\textbackslash', '\\'], ['\\textbar', '|'], ['\\textbraceleft', '{'], ['\\textbraceright', '}'],
    ['\\textasciitilde', '~'], ['\\textasciicircum', '^'],
    ['\\textmu', '\u00B5', 'textcomp'], ['\\textohm', '\u2126', 'textcomp'],
    ['\\texttimes', '\u00D7', 'textcomp'], ['\\textdiv', '\u00F7', 'textcomp'],
    ['\\textpm', '\u00B1', 'textcomp'],
    ['\\textlangle', '\u27E8', 'textcomp'], ['\\textrangle', '\u27E9', 'textcomp'],
  ]},
  { name: 'Greek Letters (lowercase)', symbols: [
    ['\\alpha', '\u03B1'], ['\\beta', '\u03B2'], ['\\gamma', '\u03B3'], ['\\delta', '\u03B4'], ['\\epsilon', '\u03B5'], ['\\varepsilon', '\u03B5'],
    ['\\zeta', '\u03B6'], ['\\eta', '\u03B7'], ['\\theta', '\u03B8'], ['\\vartheta', '\u03D1'], ['\\iota', '\u03B9'], ['\\kappa', '\u03BA'],
    ['\\varkappa', '\u03F0', 'amssymb'], ['\\lambda', '\u03BB'], ['\\mu', '\u03BC'], ['\\nu', '\u03BD'], ['\\xi', '\u03BE'],
    ['\\pi', '\u03C0'], ['\\varpi', '\u03D6'], ['\\rho', '\u03C1'], ['\\varrho', '\u03F1'], ['\\sigma', '\u03C3'], ['\\varsigma', '\u03C2'],
    ['\\tau', '\u03C4'], ['\\upsilon', '\u03C5'], ['\\phi', '\u03D5'], ['\\varphi', '\u03C6'], ['\\chi', '\u03C7'], ['\\psi', '\u03C8'], ['\\omega', '\u03C9'],
  ]},
  { name: 'Greek Letters (uppercase)', symbols: [
    ['\\Gamma', '\u0393'], ['\\Delta', '\u0394'], ['\\Theta', '\u0398'], ['\\Lambda', '\u039B'], ['\\Xi', '\u039E'], ['\\Pi', '\u03A0'],
    ['\\Sigma', '\u03A3'], ['\\Upsilon', '\u03A5'], ['\\Phi', '\u03A6'], ['\\Psi', '\u03A8'], ['\\Omega', '\u03A9'],
    ['\\varGamma', '\uD835\uDEE4', 'amsmath'], ['\\varDelta', '\uD835\uDEE5', 'amsmath'], ['\\varTheta', '\uD835\uDEE9', 'amsmath'],
    ['\\varLambda', '\uD835\uDEEC', 'amsmath'], ['\\varXi', '\uD835\uDEEF', 'amsmath'], ['\\varPi', '\uD835\uDEF1', 'amsmath'],
    ['\\varSigma', '\uD835\uDEF4', 'amsmath'], ['\\varUpsilon', '\uD835\uDEF6', 'amsmath'], ['\\varPhi', '\uD835\uDEF7', 'amsmath'],
    ['\\varPsi', '\uD835\uDEF9', 'amsmath'], ['\\varOmega', '\uD835\uDEFA', 'amsmath'],
  ]},
  { name: 'Hebrew', symbols: [
    ['\\aleph', '\u2135'], ['\\beth', '\u2136', 'amssymb'], ['\\gimel', '\u2137', 'amssymb'], ['\\daleth', '\u2138', 'amssymb'],
  ]},
  { name: 'Binary Operators', symbols: [
    ['\\pm', '\u00B1'], ['\\mp', '\u2213'], ['\\times', '\u00D7'], ['\\div', '\u00F7'], ['\\cdot', '\u22C5'], ['\\ast', '\u2217'],
    ['\\star', '\u22C6'], ['\\circ', '\u2218'], ['\\bullet', '\u2022'],
    ['\\oplus', '\u2295'], ['\\ominus', '\u2296'], ['\\otimes', '\u2297'], ['\\oslash', '\u2298'], ['\\odot', '\u2299'],
    ['\\boxplus', '\u229E', 'amssymb'], ['\\boxminus', '\u229F', 'amssymb'], ['\\boxtimes', '\u22A0', 'amssymb'], ['\\boxdot', '\u22A1', 'amssymb'],
    ['\\dagger', '\u2020'], ['\\ddagger', '\u2021'], ['\\amalg', '\u2A3F'],
    ['\\cap', '\u2229'], ['\\cup', '\u222A'], ['\\uplus', '\u228E'], ['\\sqcap', '\u2293'], ['\\sqcup', '\u2294'],
    ['\\vee', '\u2228'], ['\\wedge', '\u2227'], ['\\setminus', '\u2216'], ['\\wr', '\u2240'],
    ['\\diamond', '\u22C4'], ['\\bigtriangleup', '\u25B3'], ['\\bigtriangledown', '\u25BD'],
    ['\\triangleleft', '\u25C1'], ['\\triangleright', '\u25B7'],
    ['\\lhd', '\u25C1', 'amssymb'], ['\\rhd', '\u25B7', 'amssymb'], ['\\unlhd', '\u22B4', 'amssymb'], ['\\unrhd', '\u22B5', 'amssymb'],
    ['\\barwedge', '\u22BC', 'amssymb'], ['\\veebar', '\u22BB', 'amssymb'], ['\\doublebarwedge', '\u2A5E', 'amssymb'],
    ['\\curlywedge', '\u22CF', 'amssymb'], ['\\curlyvee', '\u22CE', 'amssymb'],
    ['\\Cap', '\u22D2', 'amssymb'], ['\\Cup', '\u22D3', 'amssymb'],
    ['\\ltimes', '\u22C9', 'amssymb'], ['\\rtimes', '\u22CA', 'amssymb'],
    ['\\leftthreetimes', '\u22CB', 'amssymb'], ['\\rightthreetimes', '\u22CC', 'amssymb'],
    ['\\circledast', '\u229B', 'amssymb'], ['\\circledcirc', '\u229A', 'amssymb'], ['\\circleddash', '\u229D', 'amssymb'],
    ['\\dotplus', '\u2214', 'amssymb'], ['\\intercal', '\u22BA', 'amssymb'],
    ['\\divideontimes', '\u22C7', 'amssymb'], ['\\smallsetminus', '\u2216', 'amssymb'],
  ]},
  { name: 'Relations', symbols: [
    ['\\leq', '\u2264'], ['\\geq', '\u2265'], ['\\neq', '\u2260'], ['\\sim', '\u223C'], ['\\simeq', '\u2243'], ['\\approx', '\u2248'],
    ['\\cong', '\u2245'], ['\\equiv', '\u2261'], ['\\doteq', '\u2250'], ['\\propto', '\u221D'],
    ['\\prec', '\u227A'], ['\\succ', '\u227B'], ['\\preceq', '\u2AAF', 'amssymb'], ['\\succeq', '\u2AB0', 'amssymb'],
    ['\\ll', '\u226A'], ['\\gg', '\u226B'], ['\\lll', '\u22D8', 'amssymb'], ['\\ggg', '\u22D9', 'amssymb'],
    ['\\subset', '\u2282'], ['\\supset', '\u2283'], ['\\subseteq', '\u2286'], ['\\supseteq', '\u2287'],
    ['\\Subset', '\u22D0', 'amssymb'], ['\\Supset', '\u22D1', 'amssymb'],
    ['\\sqsubset', '\u228F', 'amssymb'], ['\\sqsupset', '\u2290', 'amssymb'],
    ['\\sqsubseteq', '\u2291'], ['\\sqsupseteq', '\u2292'],
    ['\\in', '\u2208'], ['\\ni', '\u220B'], ['\\notin', '\u2209'],
    ['\\vdash', '\u22A2'], ['\\dashv', '\u22A3'], ['\\models', '\u22A8'],
    ['\\Vdash', '\u22A9', 'amssymb'], ['\\Vvdash', '\u22AA', 'amssymb'],
    ['\\parallel', '\u2225'], ['\\perp', '\u22A5'], ['\\mid', '\u2223'], ['\\nmid', '\u2224', 'amssymb'],
    ['\\bowtie', '\u22C8'], ['\\Join', '\u2A1D', 'amssymb'], ['\\smile', '\u2323'], ['\\frown', '\u2322'],
    ['\\asymp', '\u224D'], ['\\bumpeq', '\u224F', 'amssymb'], ['\\Bumpeq', '\u224E', 'amssymb'],
    ['\\circeq', '\u2257', 'amssymb'], ['\\eqcirc', '\u2256', 'amssymb'],
    ['\\doteqdot', '\u2251', 'amssymb'], ['\\fallingdotseq', '\u2252', 'amssymb'], ['\\risingdotseq', '\u2253', 'amssymb'],
    ['\\triangleq', '\u225C', 'amssymb'],
    ['\\lesssim', '\u2272', 'amssymb'], ['\\gtrsim', '\u2273', 'amssymb'],
    ['\\lessapprox', '\u2A85', 'amssymb'], ['\\gtrapprox', '\u2A86', 'amssymb'],
    ['\\lessgtr', '\u2276', 'amssymb'], ['\\gtrless', '\u2277', 'amssymb'],
    ['\\lesseqgtr', '\u22DA', 'amssymb'], ['\\gtreqless', '\u22DB', 'amssymb'],
    ['\\curlyeqprec', '\u22DE', 'amssymb'], ['\\curlyeqsucc', '\u22DF', 'amssymb'],
    ['\\preccurlyeq', '\u227C', 'amssymb'], ['\\succcurlyeq', '\u227D', 'amssymb'],
    ['\\precsim', '\u227E', 'amssymb'], ['\\succsim', '\u227F', 'amssymb'],
    ['\\trianglelefteq', '\u22B4', 'amssymb'], ['\\trianglerighteq', '\u22B5', 'amssymb'],
    ['\\vartriangleleft', '\u22B2', 'amssymb'], ['\\vartriangleright', '\u22B3', 'amssymb'],
    ['\\between', '\u226C', 'amssymb'], ['\\pitchfork', '\u22D4', 'amssymb'],
    ['\\backepsilon', '\u220D', 'amssymb'], ['\\therefore', '\u2234', 'amssymb'], ['\\because', '\u2235', 'amssymb'],
  ]},
  { name: 'Negated Relations', symbols: [
    ['\\nless', '\u226E', 'amssymb'], ['\\ngtr', '\u226F', 'amssymb'],
    ['\\nleq', '\u2270', 'amssymb'], ['\\ngeq', '\u2271', 'amssymb'],
    ['\\nleqslant', '\u2270', 'amssymb'], ['\\ngeqslant', '\u2271', 'amssymb'],
    ['\\nprec', '\u2280', 'amssymb'], ['\\nsucc', '\u2281', 'amssymb'],
    ['\\npreceq', '\u22E0', 'amssymb'], ['\\nsucceq', '\u22E1', 'amssymb'],
    ['\\nsim', '\u2241', 'amssymb'], ['\\ncong', '\u2247', 'amssymb'],
    ['\\nsubseteq', '\u2288', 'amssymb'], ['\\nsupseteq', '\u2289', 'amssymb'],
    ['\\subsetneq', '\u228A', 'amssymb'], ['\\supsetneq', '\u228B', 'amssymb'],
    ['\\nparallel', '\u2226', 'amssymb'], ['\\nvdash', '\u22AC', 'amssymb'], ['\\nVdash', '\u22AE', 'amssymb'],
    ['\\nvDash', '\u22AD', 'amssymb'], ['\\nVDash', '\u22AF', 'amssymb'],
    ['\\ntriangleleft', '\u22EA', 'amssymb'], ['\\ntriangleright', '\u22EB', 'amssymb'],
    ['\\ntrianglelefteq', '\u22EC', 'amssymb'], ['\\ntrianglerighteq', '\u22ED', 'amssymb'],
    ['\\lneqq', '\u2268', 'amssymb'], ['\\gneqq', '\u2269', 'amssymb'],
    ['\\lnsim', '\u22E6', 'amssymb'], ['\\gnsim', '\u22E7', 'amssymb'],
    ['\\precnsim', '\u22E8', 'amssymb'], ['\\succnsim', '\u22E9', 'amssymb'],
  ]},
  { name: 'Arrows', symbols: [
    ['\\leftarrow', '\u2190'], ['\\rightarrow', '\u2192'], ['\\uparrow', '\u2191'], ['\\downarrow', '\u2193'],
    ['\\leftrightarrow', '\u2194'], ['\\updownarrow', '\u2195'],
    ['\\Leftarrow', '\u21D0'], ['\\Rightarrow', '\u21D2'], ['\\Uparrow', '\u21D1'], ['\\Downarrow', '\u21D3'],
    ['\\Leftrightarrow', '\u21D4'], ['\\Updownarrow', '\u21D5'],
    ['\\longleftarrow', '\u27F5'], ['\\longrightarrow', '\u27F6'], ['\\longleftrightarrow', '\u27F7'],
    ['\\Longleftarrow', '\u27F8'], ['\\Longrightarrow', '\u27F9'], ['\\Longleftrightarrow', '\u27FA'],
    ['\\mapsto', '\u21A6'], ['\\longmapsto', '\u27FC'],
    ['\\hookleftarrow', '\u21A9'], ['\\hookrightarrow', '\u21AA'],
    ['\\nearrow', '\u2197'], ['\\searrow', '\u2198'], ['\\swarrow', '\u2199'], ['\\nwarrow', '\u2196'],
    ['\\rightharpoonup', '\u21C0'], ['\\rightharpoondown', '\u21C1'], ['\\leftharpoonup', '\u21BC'], ['\\leftharpoondown', '\u21BD'],
    ['\\upharpoonleft', '\u21BF'], ['\\upharpoonright', '\u21BE'], ['\\downharpoonleft', '\u21C3'], ['\\downharpoonright', '\u21C2'],
    ['\\rightleftharpoons', '\u21CC'], ['\\leftrightharpoons', '\u21CB'],
    ['\\dashrightarrow', '\u21E2', 'amssymb'], ['\\dashleftarrow', '\u21E0', 'amssymb'],
    ['\\twoheadrightarrow', '\u21A0', 'amssymb'], ['\\twoheadleftarrow', '\u219E', 'amssymb'],
    ['\\leftleftarrows', '\u21C7', 'amssymb'], ['\\rightrightarrows', '\u21C9', 'amssymb'],
    ['\\upuparrows', '\u21C8', 'amssymb'], ['\\downdownarrows', '\u21CA', 'amssymb'],
    ['\\leftrightarrows', '\u21C6', 'amssymb'], ['\\rightleftarrows', '\u21C4', 'amssymb'],
    ['\\Lsh', '\u21B0', 'amssymb'], ['\\Rsh', '\u21B1', 'amssymb'],
    ['\\looparrowleft', '\u21AB', 'amssymb'], ['\\looparrowright', '\u21AC', 'amssymb'],
    ['\\curvearrowleft', '\u21B6', 'amssymb'], ['\\curvearrowright', '\u21B7', 'amssymb'],
    ['\\circlearrowleft', '\u21BA', 'amssymb'], ['\\circlearrowright', '\u21BB', 'amssymb'],
    ['\\multimap', '\u22B8', 'amssymb'], ['\\leftrightsquigarrow', '\u21AD', 'amssymb'],
    ['\\rightsquigarrow', '\u21DD', 'amssymb'], ['\\leadsto', '\u21DD', 'amssymb'],
    ['\\Lleftarrow', '\u21DA', 'amssymb'], ['\\Rrightarrow', '\u21DB', 'amssymb'],
  ]},
  { name: 'Miscellaneous Math', symbols: [
    ['\\infty', '\u221E'], ['\\partial', '\u2202'], ['\\nabla', '\u2207'], ['\\forall', '\u2200'], ['\\exists', '\u2203'],
    ['\\nexists', '\u2204', 'amssymb'], ['\\neg', '\u00AC'], ['\\surd', '\u221A'], ['\\top', '\u22A4'], ['\\bot', '\u22A5'],
    ['\\angle', '\u2220'], ['\\measuredangle', '\u2221', 'amssymb'], ['\\sphericalangle', '\u2222', 'amssymb'],
    ['\\triangle', '\u25B3'], ['\\vartriangle', '\u25B3', 'amssymb'],
    ['\\blacktriangle', '\u25B2', 'amssymb'], ['\\blacktriangledown', '\u25BE', 'amssymb'],
    ['\\triangledown', '\u25BD', 'amssymb'],
    ['\\square', '\u25A1', 'amssymb'], ['\\blacksquare', '\u25A0', 'amssymb'],
    ['\\lozenge', '\u25CA', 'amssymb'], ['\\blacklozenge', '\u29EB', 'amssymb'],
    ['\\bigstar', '\u2605', 'amssymb'],
    ['\\clubsuit', '\u2663'], ['\\diamondsuit', '\u2662'], ['\\heartsuit', '\u2661'], ['\\spadesuit', '\u2660'],
    ['\\flat', '\u266D'], ['\\natural', '\u266E'], ['\\sharp', '\u266F'],
    ['\\hbar', '\u210F'], ['\\hslash', '\u210F', 'amssymb'], ['\\ell', '\u2113'], ['\\wp', '\u2118'],
    ['\\Re', '\u211C'], ['\\Im', '\u2111'], ['\\Finv', '\u2132', 'amssymb'], ['\\Game', '\u2141', 'amssymb'],
    ['\\complement', '\u2201', 'amssymb'], ['\\eth', '\u00F0', 'amssymb'], ['\\mho', '\u2127', 'amssymb'],
    ['\\prime', '\u2032'], ['\\backprime', '\u2035', 'amssymb'],
    ['\\emptyset', '\u2205'], ['\\varnothing', '\u2205', 'amssymb'],
    ['\\dag', '\u2020'], ['\\ddag', '\u2021'],
    ['\\checkmark', '\u2713', 'amssymb'], ['\\maltese', '\u2720', 'amssymb'],
    ['\\circledR', '\u00AE', 'amssymb'], ['\\circledS', '\u24C8', 'amssymb'],
    ['\\Bbbk', '\uD835\uDD5C', 'amssymb'],
  ]},
  { name: 'Big Operators & Integrals', symbols: [
    ['\\sum', '\u2211'], ['\\prod', '\u220F'], ['\\coprod', '\u2210'],
    ['\\int', '\u222B'], ['\\oint', '\u222E'],
    ['\\iint', '\u222C', 'amsmath'], ['\\iiint', '\u222D', 'amsmath'], ['\\iiiint', '\u2A0C', 'amsmath'],
    ['\\idotsint', '\u222B\u22EF\u222B', 'amsmath'],
    ['\\bigcap', '\u22C2'], ['\\bigcup', '\u22C3'], ['\\bigsqcup', '\u2A06'], ['\\bigvee', '\u22C1'], ['\\bigwedge', '\u22C0'],
    ['\\bigoplus', '\u2A01'], ['\\bigotimes', '\u2A02'], ['\\bigodot', '\u2A00'], ['\\biguplus', '\u2A04'],
  ]},
  { name: 'Delimiters', symbols: [
    ['\\langle', '\u27E8'], ['\\rangle', '\u27E9'], ['\\lceil', '\u2308'], ['\\rceil', '\u2309'],
    ['\\lfloor', '\u230A'], ['\\rfloor', '\u230B'], ['\\lbrace', '{'], ['\\rbrace', '}'],
    ['\\lvert', '|'], ['\\rvert', '|'], ['\\lVert', '\u2016'], ['\\rVert', '\u2016'],
    ['\\ulcorner', '\u231C', 'amssymb'], ['\\urcorner', '\u231D', 'amssymb'],
    ['\\llcorner', '\u231E', 'amssymb'], ['\\lrcorner', '\u231F', 'amssymb'],
    ['/', '/'], ['\\backslash', '\\'],
  ]},
  { name: 'Accents', symbols: [
    ['\\hat{a}', '\u00E2'], ['\\check{a}', '\u01CE'], ['\\tilde{a}', '\u00E3'], ['\\bar{a}', '\u0101'],
    ['\\vec{a}', 'a\u20D7'], ['\\dot{a}', '\u0227'], ['\\ddot{a}', '\u00E4'], ['\\dddot{a}', 'a\u20DB', 'amsmath'],
    ['\\breve{a}', '\u0103'], ['\\acute{a}', '\u00E1'], ['\\grave{a}', '\u00E0'],
    ['\\mathring{a}', '\u00E5'],
    ['\\widehat{abc}', 'a\u0302bc'], ['\\widetilde{abc}', '\u00E3bc'],
    ['\\overline{abc}', 'a\u0304bc'], ['\\underline{abc}', 'a\u0332bc'],
    ['\\overbrace{abc}', 'a\u23DE'], ['\\underbrace{abc}', 'a\u23DF'],
    ['\\overleftarrow{abc}', '\u2190abc'], ['\\overrightarrow{abc}', 'abc\u2192'],
    ['\\overleftrightarrow{abc}', '\u2194abc', 'amsmath'],
    ['\\underleftarrow{abc}', '\u2190abc', 'amsmath'], ['\\underrightarrow{abc}', 'abc\u2192', 'amsmath'],
  ]},
  { name: 'Dots', symbols: [
    ['\\cdots', '\u22EF'], ['\\ldots', '\u2026'], ['\\vdots', '\u22EE'], ['\\ddots', '\u22F1'],
    ['\\iddots', '\u22F0', 'mathdots'],
    ['\\dotsc', '\u2026', 'amsmath'], ['\\dotsb', '\u22EF', 'amsmath'], ['\\dotsm', '\u22EF', 'amsmath'], ['\\dotsi', '\u22EF', 'amsmath'],
  ]},
  { name: 'Math Fonts & Alphabets', symbols: [
    ['\\mathbb{R}', '\u211D', 'amssymb'], ['\\mathbb{Z}', '\u2124', 'amssymb'], ['\\mathbb{Q}', '\u211A', 'amssymb'],
    ['\\mathbb{N}', '\u2115', 'amssymb'], ['\\mathbb{C}', '\u2102', 'amssymb'],
    ['\\mathbb{1}', '\uD835\uDFD9', 'amssymb'],
    ['\\mathcal{A}', '\uD835\uDC9C'], ['\\mathcal{B}', '\u212C'], ['\\mathcal{C}', '\uD835\uDC9E'],
    ['\\mathcal{F}', '\u2131'], ['\\mathcal{L}', '\u2112'], ['\\mathcal{O}', '\uD835\uDCAA'],
    ['\\mathfrak{A}', '\uD835\uDD04', 'amssymb'], ['\\mathfrak{B}', '\uD835\uDD05', 'amssymb'],
    ['\\mathfrak{g}', '\uD835\uDD24', 'amssymb'], ['\\mathfrak{p}', '\uD835\uDD2D', 'amssymb'],
  ]},
  { name: 'Spacing', symbols: [
    ['\\,', '\u2009'], ['\\:', '\u2005'], ['\\;', '\u2004'], ['\\!', ''], ['\\quad', '\u2003'], ['\\qquad', '\u2003\u2003'],
    ['\\phantom{x}', '\u2B1C'], ['\\hspace{1cm}', '\u2B62'],
  ]},
  { name: 'Text Symbols', symbols: [
    ['\\textdegree', '\u00B0', 'textcomp'], ['\\texttrademark', '\u2122', 'textcomp'],
    ['\\textregistered', '\u00AE', 'textcomp'], ['\\textcopyright', '\u00A9'],
    ['\\pounds', '\u00A3'], ['\\euro', '\u20AC', 'eurosym'], ['\\yen', '\u00A5'],
    ['\\textsection', '\u00A7'], ['\\textparagraph', '\u00B6'],
    ['\\textendash', '\u2013'], ['\\textemdash', '\u2014'],
    ['\\textbullet', '\u2022'], ['\\textellipsis', '\u2026'],
    ['\\texttimes', '\u00D7', 'textcomp'], ['\\textdiv', '\u00F7', 'textcomp'],
    ['\\textlangle', '\u27E8', 'textcomp'], ['\\textrangle', '\u27E9', 'textcomp'],
    ['\\textmu', '\u00B5', 'textcomp'], ['\\textohm', '\u2126', 'textcomp'],
    ['\\textordfeminine', '\u00AA'], ['\\textordmasculine', '\u00BA'],
    ['\\textquoteleft', '\u2018'], ['\\textquoteright', '\u2019'],
    ['\\textquotedblleft', '\u201C'], ['\\textquotedblright', '\u201D'],
    ['\\guillemotleft', '\u00AB'], ['\\guillemotright', '\u00BB'],
    ['\\guilsinglleft', '\u2039'], ['\\guilsinglright', '\u203A'],
  ]},
  { name: 'Stacked Symbols', symbols: [
    ['\\overset{!}{=}', '\u225D', 'amsmath'], ['\\underset{x}{\\min}', 'min\u2093', 'amsmath'],
    ['\\stackrel{\\text{def}}{=}', '\u225D'],
    ['\\xrightarrow{n}', '\u2192\u207F', 'amsmath'], ['\\xleftarrow{n}', '\u207F\u2190', 'amsmath'],
    ['\\frac{a}{b}', 'a/b'], ['\\tfrac{a}{b}', 'a/b', 'amsmath'], ['\\dfrac{a}{b}', 'a/b', 'amsmath'],
    ['\\binom{n}{k}', '(n k)', 'amsmath'], ['\\tbinom{n}{k}', '(n k)', 'amsmath'], ['\\dbinom{n}{k}', '(n k)', 'amsmath'],
    ['\\sqrt{x}', '\u221Ax'], ['\\sqrt[n]{x}', '\u207F\u221Ax'],
  ]},
];

function SymbolPicker({ onInsert, onClose }) {
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('');
  const filterRef = useRef(null);

  useEffect(() => { filterRef.current?.focus(); }, []);

  const filtered = filter.trim()
    ? SYMBOL_CATEGORIES.map(cat => ({
        ...cat,
        symbols: cat.symbols.filter(([cmd]) => cmd.toLowerCase().includes(filter.toLowerCase())),
      })).filter(cat => cat.symbols.length > 0)
    : SYMBOL_CATEGORIES;

  // Find package for selected symbol
  const selectedPkg = selected
    ? SYMBOL_CATEGORIES.flatMap(c => c.symbols).find(s => s[0] === selected)?.[2] || null
    : null;

  const handleInsert = (cmd) => {
    onInsert(cmd);
    onClose();
  };

  return (
    <div className="symbol-picker-overlay" onClick={onClose}>
      <div className="symbol-picker" onClick={e => e.stopPropagation()}>
        <div className="symbol-picker-header">
          <span className="symbol-picker-title">Insert Special Symbol</span>
          <button className="symbol-picker-close" onClick={onClose}>&times;</button>
        </div>
        <input
          ref={filterRef}
          className="symbol-picker-filter"
          placeholder="Search symbols..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <div className="symbol-picker-body">
          {filtered.map(cat => (
            <div key={cat.name} className="symbol-picker-category">
              <div className="symbol-picker-cat-name">{cat.name}</div>
              <div className="symbol-picker-grid">
                {cat.symbols.map(([cmd, glyph, pkg]) => (
                  <button
                    key={cmd}
                    className={`symbol-picker-cell${selected === cmd ? ' selected' : ''}${pkg ? ' has-pkg' : ''}`}
                    title={pkg ? `${cmd} (${pkg})` : cmd}
                    onClick={() => setSelected(cmd)}
                    onDoubleClick={() => handleInsert(cmd)}
                  >
                    {glyph}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {filtered.length === 0 && <div className="symbol-picker-empty">No symbols match "{filter}"</div>}
        </div>
        <div className="symbol-picker-footer">
          <div>
            <span className="symbol-picker-selected-cmd">{selected || ''}</span>
            {selectedPkg && <span className="symbol-picker-pkg">Requires: \usepackage{'{' + selectedPkg + '}'}</span>}
          </div>
          <button className="symbol-picker-insert-btn" disabled={!selected} onClick={() => selected && handleInsert(selected)}>Insert</button>
        </div>
      </div>
    </div>
  );
}

function SearchPanel({ view, onClose, projectFiles, onGoToFile }) {
  const [query, setQuery] = useState('');
  const [replace, setReplace] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [matchIndex, setMatchIndex] = useState(-1);
  const [matchCount, setMatchCount] = useState(0);
  const [scope, setScope] = useState('file'); // 'file' | 'tex' | 'all'
  const [globalResults, setGlobalResults] = useState([]);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Local file search
  const findMatches = useCallback((q, cs) => {
    if (!view || !q) return [];
    const doc = view.state.doc.toString();
    const matches = [];
    const searchStr = cs ? q : q.toLowerCase();
    const haystack = cs ? doc : doc.toLowerCase();
    let pos = 0;
    while (pos < haystack.length) {
      const idx = haystack.indexOf(searchStr, pos);
      if (idx === -1) break;
      matches.push({ from: idx, to: idx + q.length });
      pos = idx + 1;
    }
    return matches;
  }, [view]);

  const updateHighlights = useCallback((q, cs, currentIdx) => {
    if (!view) return;
    if (scope !== 'file') {
      view.dispatch({ effects: setSearchHighlightEffect.of(Decoration.none) });
      return;
    }
    const matches = findMatches(q, cs);
    setMatchCount(matches.length);
    if (matches.length === 0) {
      view.dispatch({ effects: setSearchHighlightEffect.of(Decoration.none) });
      setMatchIndex(-1);
      return;
    }
    const decos = matches.map((m, i) =>
      Decoration.mark({
        class: i === currentIdx ? 'cm-search-match-current' : 'cm-search-match',
      }).range(m.from, m.to)
    );
    view.dispatch({ effects: setSearchHighlightEffect.of(Decoration.set(decos)) });
  }, [view, findMatches, scope]);

  // Global search — runs client-side against in-memory file contents
  useEffect(() => {
    if (scope === 'file') { setGlobalResults([]); return; }
    const q = query.trim();
    if (!q || !projectFiles?.length) { setGlobalResults([]); return; }
    const searchStr = caseSensitive ? q : q.toLowerCase();
    const results = [];
    for (const file of projectFiles) {
      if (scope === 'tex' && !file.path.endsWith('.tex')) continue;
      if (!file.content) continue;
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const haystack = caseSensitive ? line : line.toLowerCase();
        let pos = 0;
        while (pos < haystack.length) {
          const idx = haystack.indexOf(searchStr, pos);
          if (idx === -1) break;
          results.push({ fileId: file.id, filePath: file.path, line: i + 1, col: idx, text: line.trim() });
          pos = idx + 1;
          if (results.length >= 500) break;
        }
        if (results.length >= 500) break;
      }
      if (results.length >= 500) break;
    }
    setGlobalResults(results);
  }, [query, scope, caseSensitive, projectFiles]);

  // Local highlights
  useEffect(() => {
    if (scope === 'file') {
      updateHighlights(query, caseSensitive, -1);
      setMatchIndex(-1);
    }
    return () => {
      if (view) view.dispatch({ effects: setSearchHighlightEffect.of(Decoration.none) });
    };
  }, [query, caseSensitive, scope]);

  const goToMatch = useCallback((dir) => {
    const matches = findMatches(query, caseSensitive);
    if (matches.length === 0) return;
    let idx;
    if (dir === 'next') {
      const cursor = view.state.selection.main.from;
      idx = matches.findIndex((m) => m.from > cursor);
      if (idx === -1) idx = 0;
    } else {
      const cursor = view.state.selection.main.from;
      for (idx = matches.length - 1; idx >= 0; idx--) {
        if (matches[idx].from < cursor) break;
      }
      if (idx < 0) idx = matches.length - 1;
    }
    setMatchIndex(idx);
    updateHighlights(query, caseSensitive, idx);
    const m = matches[idx];
    view.dispatch({
      selection: { anchor: m.from, head: m.to },
      scrollIntoView: true,
    });
    view.focus();
  }, [view, query, caseSensitive, findMatches, updateHighlights]);

  const handleReplace = useCallback(() => {
    const matches = findMatches(query, caseSensitive);
    if (matchIndex < 0 || matchIndex >= matches.length) return;
    const m = matches[matchIndex];
    view.dispatch({ changes: { from: m.from, to: m.to, insert: replace } });
    setTimeout(() => goToMatch('next'), 0);
  }, [view, query, replace, caseSensitive, matchIndex, findMatches, goToMatch]);

  const handleReplaceAll = useCallback(() => {
    const matches = findMatches(query, caseSensitive);
    if (matches.length === 0) return;
    const changes = [...matches].reverse().map((m) => ({
      from: m.from, to: m.to, insert: replace,
    }));
    view.dispatch({ changes });
    setMatchIndex(-1);
    setMatchCount(0);
    view.dispatch({ effects: setSearchHighlightEffect.of(Decoration.none) });
  }, [view, query, replace, caseSensitive, findMatches]);

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (scope === 'file') {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); goToMatch('next'); }
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); goToMatch('prev'); }
    }
  };

  const highlightMatch = (text, q, cs) => {
    if (!q) return text;
    const searchStr = cs ? q : q.toLowerCase();
    const haystack = cs ? text : text.toLowerCase();
    const idx = haystack.indexOf(searchStr);
    if (idx === -1) return text;
    return (
      <>{text.slice(0, idx)}<mark className="search-result-highlight">{text.slice(idx, idx + q.length)}</mark>{text.slice(idx + q.length)}</>
    );
  };

  const isGlobal = scope !== 'file';

  return (
    <div className="editor-search-panel">
      <div className="editor-search-toolbar">
        <div className="editor-search-scope">
          <button className={`editor-search-scope-btn ${scope === 'file' ? 'active' : ''}`} onClick={() => setScope('file')}>Current File</button>
          <button className={`editor-search-scope-btn ${scope === 'tex' ? 'active' : ''}`} onClick={() => setScope('tex')}>.tex Files</button>
          <button className={`editor-search-scope-btn ${scope === 'all' ? 'active' : ''}`} onClick={() => setScope('all')}>All Files</button>
        </div>
        <button className="editor-search-close" onClick={onClose} title="Close (Esc)">&times;</button>
      </div>
      <div className="editor-search-row">
        <input
          ref={inputRef}
          className="editor-search-input"
          placeholder={isGlobal ? 'Search in project...' : 'Find...'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        {!isGlobal && (
          <span className="editor-search-count">
            {query ? (matchCount > 0 ? `${matchIndex >= 0 ? matchIndex + 1 : '–'}/${matchCount}` : 'No results') : ''}
          </span>
        )}
        {isGlobal && (
          <span className="editor-search-count">
            {query ? `${globalResults.length}${globalResults.length >= 500 ? '+' : ''} results` : ''}
          </span>
        )}
        {!isGlobal && (
          <>
            <button className="editor-search-btn" onClick={() => goToMatch('prev')} title="Previous (Shift+Enter)">&#x25B2;</button>
            <button className="editor-search-btn" onClick={() => goToMatch('next')} title="Next (Enter)">&#x25BC;</button>
          </>
        )}
        <button
          className={`editor-search-btn ${caseSensitive ? 'active' : ''}`}
          onClick={() => setCaseSensitive(!caseSensitive)}
          title="Case sensitive"
        >Aa</button>
        {!isGlobal && (
          <button
            className={`editor-search-btn ${showReplace ? 'active' : ''}`}
            onClick={() => setShowReplace(!showReplace)}
            title="Replace"
          >⇄</button>
        )}
      </div>
      {!isGlobal && showReplace && (
        <div className="editor-search-row">
          <input
            className="editor-search-input"
            placeholder="Replace..."
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
          />
          <button className="editor-search-btn" onClick={handleReplace} disabled={matchIndex < 0} title="Replace">Replace</button>
          <button className="editor-search-btn" onClick={handleReplaceAll} disabled={matchCount === 0} title="Replace all">All</button>
        </div>
      )}
      {isGlobal && globalResults.length > 0 && (
        <div className="editor-search-results">
          {globalResults.map((r, i) => (
            <div
              key={`${r.fileId}-${r.line}-${r.col}-${i}`}
              className="editor-search-result"
              onClick={() => onGoToFile?.(r.fileId, r.line, r.col)}
            >
              <span className="search-result-file">{r.filePath}</span>
              <span className="search-result-line">:{r.line}</span>
              <span className="search-result-text">{highlightMatch(r.text, query, caseSensitive)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Spellcheck decoration
const setSpellcheckEffect = StateEffect.define();

const spellcheckField = StateField.define({
  create() { return Decoration.none; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSpellcheckEffect)) return e.value;
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Lint decoration
const setLintEffect = StateEffect.define();

const lintField = StateField.define({
  create() { return Decoration.none; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setLintEffect)) return e.value;
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Lint gutter markers — shown in a narrow gutter next to line numbers
class LintErrorMarker extends GutterMarker {
  constructor(msg) { super(); this.msg = msg; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-lint-gutter-error';
    el.title = this.msg;
    return el;
  }
}

class LintWarningMarker extends GutterMarker {
  constructor(msg) { super(); this.msg = msg; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-lint-gutter-warning';
    el.title = this.msg;
    return el;
  }
}

class SpellGutterMarker extends GutterMarker {
  constructor(count) { super(); this.count = count; }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-spell-gutter-marker';
    el.title = `${this.count} misspelled word${this.count !== 1 ? 's' : ''} on this line`;
    return el;
  }
}

const setLintGutterEffect = StateEffect.define();
const setSpellGutterEffect = StateEffect.define();

const lintGutterField = StateField.define({
  create() { return RangeSet.empty; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setLintGutterEffect)) return e.value;
    }
    return value;
  },
});

const spellGutterField = StateField.define({
  create() { return RangeSet.empty; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSpellGutterEffect)) return e.value;
    }
    return value;
  },
});

const lintGutterExtension = gutter({
  class: 'cm-lint-gutter',
  markers: (view) => view.state.field(lintGutterField),
});

const spellGutterExtension = gutter({
  class: 'cm-spell-gutter',
  markers: (view) => view.state.field(spellGutterField),
});

function applyLintDiagnostics(view, diagnostics) {
  const decos = [];
  const gutterMarkers = [];
  const seenLines = new Set();

  for (const d of diagnostics) {
    try {
      const lineInfo = view.state.doc.line(Math.min(d.line, view.state.doc.lines));
      const from = d.len > 0 ? Math.min(lineInfo.from + Math.max(0, d.col - 1), lineInfo.to) : lineInfo.from;
      const to = d.len > 0 ? Math.min(from + d.len, lineInfo.to) : lineInfo.to;
      if (from < to) {
        decos.push(
          Decoration.mark({
            class: d.severity === 'error' ? 'cm-lint-error' : 'cm-lint-warning',
            attributes: { title: d.message },
          }).range(from, to)
        );
      }
      // One gutter marker per line (first diagnostic wins)
      if (!seenLines.has(d.line)) {
        seenLines.add(d.line);
        const marker = d.severity === 'error'
          ? new LintErrorMarker(d.message)
          : new LintWarningMarker(d.message);
        gutterMarkers.push(marker.range(lineInfo.from));
      }
    } catch (e) {}
  }

  decos.sort((a, b) => a.from - b.from);
  gutterMarkers.sort((a, b) => a.from - b.from);

  view.dispatch({
    effects: [
      setLintEffect.of(Decoration.set(decos)),
      setLintGutterEffect.of(RangeSet.of(gutterMarkers)),
    ],
  });
}

function applySpellcheck(view, misspelled) {
  const decos = misspelled.map(m =>
    Decoration.mark({ class: 'cm-spell-error', attributes: { title: `Misspelled: ${m.word}` } })
      .range(m.from, m.to)
  );

  // Build gutter markers — one per line with misspellings
  const lineCounts = new Map();
  for (const m of misspelled) {
    const lineNum = view.state.doc.lineAt(m.from).number;
    lineCounts.set(lineNum, (lineCounts.get(lineNum) || 0) + 1);
  }
  const gutterMarkers = [];
  for (const [lineNum, count] of lineCounts) {
    const lineInfo = view.state.doc.line(lineNum);
    gutterMarkers.push(new SpellGutterMarker(count).range(lineInfo.from));
  }
  gutterMarkers.sort((a, b) => a.from - b.from);

  view.dispatch({
    effects: [
      setSpellcheckEffect.of(Decoration.set(decos)),
      setSpellGutterEffect.of(RangeSet.of(gutterMarkers)),
    ],
  });
}

// Citation key highlighter — decorates keys inside \cite{}, \citep{}, \citet{}, etc.
const citeKeyMark = Decoration.mark({ class: 'cm-cite-key' });
const citeKeyPattern = /\\cite[tp]?\*?\{([^}]+)\}/g;

function buildCiteDecorations(view) {
  const decos = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    let match;
    citeKeyPattern.lastIndex = 0;
    while ((match = citeKeyPattern.exec(text)) !== null) {
      const keyStart = from + match.index + match[0].indexOf('{') + 1;
      const keyEnd = keyStart + match[1].length;
      decos.push(citeKeyMark.range(keyStart, keyEnd));
    }
  }
  return Decoration.set(decos, true);
}

const citeKeyHighlighter = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildCiteDecorations(view); }
  update(update) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildCiteDecorations(update.view);
    }
  }
}, { decorations: (v) => v.decorations });

const Editor = forwardRef(function Editor({ file, comments, currentUserName, onSave, onSelectionChange, onLineChange, onChanges, onCursorChange, onCompile, onRequestComment, onScroll, onLintDiagnostics, projectId, showLineNumbers = true, wordWrap = true, trackChangesMode = false, trackedChanges = [], onTrackChange, onTrackedChangeClick, onDeleteInsertionChar, onToggleTrackChanges, citeKeys, autoSaveOn, autoSaveLabel, onToggleAutoSave, onGoToFile, projectFiles }, ref) {
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
  const tcPendingChanges = useRef(null);  // composed ChangeSet for debounce
  const tcStartDoc = useRef(null);        // doc at start of debounce window
  const tcDebounceTimer = useRef(null);
  const tcDelBuffer = useRef({ from: null, to: null, text: '' });
  const tcDelTimer = useRef(null);
  const [commentBtn, setCommentBtn] = useState(null); // { x, y, from, to }
  const [showSearch, setShowSearch] = useState(false);
  const [lintDiags, setLintDiags] = useState([]);
  const [spellMenu, setSpellMenu] = useState(null); // { x, y, word, from, to }
  const [spellLang, setSpellLang] = useState(() => getLanguage());
  const [inverted, setInverted] = useState(() => localStorage.getItem('flowtex-editor-inverted') === 'true');
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
      for (const a of ancestors) { a.el.scrollTop = a.top; a.el.scrollLeft = a.left; }
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      requestAnimationFrame(() => {
        for (const a of ancestors) { a.el.scrollTop = a.top; a.el.scrollLeft = a.left; }
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      });
      // Add error highlight decoration
      if (from < to) {
        const deco = Decoration.set([
          Decoration.mark({ class: 'cm-error-highlight' }).range(from, to),
        ]);
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
          setTrackedChangesEffect.of(buildTcInsertDecorations(changes, docLen)),
          setTcDeletesEffect.of(buildTcDeleteDecorations(changes, docLen)),
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
          }).range(head)
        );

        // Selection highlight if anchor != head
        if (anchor !== head) {
          const from = Math.min(anchor, head);
          const to = Math.max(anchor, head);
          decos.push(
            Decoration.mark({
              class: 'cm-remote-selection',
              attributes: { style: `background-color: ${color}33` },
            }).range(from, to)
          );
        }
      }
      decos.sort((a, b) => a.from - b.from || a.startSide - b.startSide);
      view.dispatch({ effects: setCursorsEffect.of(Decoration.set(decos, true)) });
    },
    openSymbolPicker() {
      setShowSymbolPicker(true);
    },
    getSpellLang() { return spellLang; },
    setSpellLang(code) { setLanguage(code); setSpellLang(code); },
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
        fontSizeCompartment.current.of(EditorView.theme({ '.cm-content': { fontSize: fontSize + 'px' }, '.cm-gutters': { fontSize: fontSize + 'px' } })),
        EditorView.contentAttributes.of({ spellcheck: 'false' }),
        remoteCursorsField,
        trackedChangesField,
        tcDeletesField,
        // Track changes: intercept Backspace/Delete to mark text as deleted instead of removing it
        Prec.high(keymap.of([
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
        ])),
        // Transaction filter: prevent deletions in track changes mode for select+type, cut, etc.
        EditorState.transactionFilter.of((tr) => {
          if (!trackChangesModeRef.current || !tr.docChanged || isRemoteUpdate.current) return tr;
          let hasDeletion = false;
          tr.changes.iterChanges((fromA, toA) => { if (fromA < toA) hasDeletion = true; });
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
                if (!isPosInDeletion(tr.startState, p)) { skip = false; break; }
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
              let start = offset, end = offset;
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
                      }).range(fromB, toB)
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

            // Debounced lint (client-side)
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

            // Debounced spellcheck
            clearTimeout(spellTimeout.current);
            spellTimeout.current = setTimeout(async () => {
              const v = viewRef.current;
              if (!v) return;
              if (!dictRef.current) dictRef.current = await getDictionary();
              if (!dictRef.current) return;
              const misspelled = spellcheckText(v.state.doc.toString(), dictRef.current);
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
        Prec.highest(keymap.of([
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
        ])),
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

  // Close spell menu on click outside
  useEffect(() => {
    if (!spellMenu) return;
    const handler = (e) => {
      if (!e.target.closest('.spell-context-menu')) setSpellMenu(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [spellMenu]);

  // Update comment decorations without recreating editor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: commentCompartment.current.reconfigure(
        commentHighlighter(comments || [])
      ),
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
    const currentIds = new Set(
      trackedChanges.filter((c) => c.status === 'pending').map((c) => c.id)
    );
    const prevIds = prevTcIdsRef.current;

    const idsChanged = currentIds.size !== prevIds.size || [...currentIds].some((id) => !prevIds.has(id)) || [...prevIds].some((id) => !currentIds.has(id));
    if (!idsChanged) { prevTcIdsRef.current = currentIds; return; }

    const wasRemoved = [...prevIds].some((id) => !currentIds.has(id));
    const isInitialLoad = prevIds.size === 0 && currentIds.size > 0;

    prevTcIdsRef.current = currentIds;

    const docLen = view.state.doc.length;
    const effects = [setTrackedChangesEffect.of(buildTcInsertDecorations(trackedChanges, docLen))];

    // Only rebuild deletion decorations on file load or resolution
    if (wasRemoved || isInitialLoad) {
      effects.push(setTcDeletesEffect.of(buildTcDeleteDecorations(trackedChanges, docLen)));
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
        EditorView.theme({ '.cm-content': { fontSize: fontSize + 'px' }, '.cm-gutters': { fontSize: fontSize + 'px' } })
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
            title={autoSaveOn ? (autoSaveLabel || 'Auto-save ON — click to disable') : 'Auto-save OFF — click to enable'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4, verticalAlign: -2 }}>
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            {autoSaveOn ? (autoSaveLabel || 'Auto-save ON') : 'Auto-save OFF'}
          </button>
        )}
        <span className="editor-zoom-controls">
          <button className="editor-header-btn" onClick={() => setFontSize((s) => Math.max(8, s - 1))} title="Zoom out">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
          <span className="editor-zoom-label" title="Font size">{fontSize}px</span>
          <button className="editor-header-btn" onClick={() => setFontSize((s) => Math.min(32, s + 1))} title="Zoom in">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line x1="11" y1="8" x2="11" y2="14" />
              <line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </button>
        </span>
        <button className="editor-header-btn" onClick={() => setShowSearch(true)} title="Find & Replace (Cmd+F)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </button>
        <button className={`editor-header-btn ${tableBuilder ? 'editor-header-btn-active' : ''}`} onClick={() => {
          if (tableBuilder) { setTableBuilder(null); return; }
          const view = viewRef.current;
          if (!view) { setTableBuilder({}); return; }
          const parsed = findTableAtCursor(view);
          if (parsed) {
            setTableBuilder({ initial: parsed, replaceFrom: parsed.from, replaceTo: parsed.to });
          } else {
            setTableBuilder({});
          }
        }} title="Insert table">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4, verticalAlign: -2 }}>
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Track changes {trackChangesMode ? 'ON' : 'OFF'}
          </button>
        )}
        <button className={`editor-header-btn ${inverted ? 'editor-header-btn-active' : ''}`} style={{ marginLeft: 'auto' }} onClick={() => setInverted((v) => { const n = !v; localStorage.setItem('flowtex-editor-inverted', String(n)); return n; })} title="Invert colors">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 3v18a9 9 0 0 1 0-18z" fill="currentColor" /></svg>
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
        <SearchPanel view={viewRef.current} onClose={() => setShowSearch(false)} projectFiles={projectFilesRef.current} onGoToFile={onGoToFileRef.current} />
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
        <div className="spell-context-menu" style={{ position: 'fixed', left: spellMenu.x, top: spellMenu.y, zIndex: 1000 }}>
          <div className="spell-context-word">
            {spellMenu.misspelled && <span className="spell-context-badge">Misspelled</span>}
            {spellMenu.word}
          </div>
          <button onClick={async () => {
            addToCustomDictionary(spellMenu.word);
            setSpellMenu(null);
            const v = viewRef.current;
            if (v && dictRef.current) {
              const misspelled = spellcheckText(v.state.doc.toString(), dictRef.current);
              applySpellcheck(v, misspelled);
            }
          }}>Add to dictionary</button>
          <button onClick={async () => {
            ignoreWord(spellMenu.word);
            setSpellMenu(null);
            const v = viewRef.current;
            if (v && dictRef.current) {
              const misspelled = spellcheckText(v.state.doc.toString(), dictRef.current);
              applySpellcheck(v, misspelled);
            }
          }}>Ignore</button>
        </div>
      )}
    </div>
  );
});

export default Editor;
