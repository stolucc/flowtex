import { EditorView, Decoration, ViewPlugin, WidgetType, gutter, GutterMarker } from '@codemirror/view';
import { StateEffect, StateField, RangeSet } from '@codemirror/state';
import { parse as parseLatex, findTableAtPos, parseTable } from './latexParser.js';

export function buildCommentDecorations(comments, docLength) {
  const widgets = [];
  for (const c of comments || []) {
    if (c.resolved) continue;
    try {
      const from = Math.min(c.from_pos, c.to_pos);
      const to = Math.max(c.from_pos, c.to_pos);
      if (from >= 0 && to <= docLength) {
        widgets.push(
          Decoration.mark({ class: 'cm-comment-highlight', attributes: { 'data-comment-id': c.id } }).range(from, to),
        );
      }
    } catch (e) {}
  }
  widgets.sort((a, b) => a.from - b.from);
  return Decoration.set(widgets);
}

export function commentHighlighter(comments) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = buildCommentDecorations(comments, view.state.doc.length);
      }
      update() {}
    },
    { decorations: (v) => v.decorations },
  );
}

// Remote cursor decoration
export class CursorWidget extends WidgetType {
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

export const setCursorsEffect = StateEffect.define();

export const remoteCursorsField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setCursorsEffect)) return e.value;
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Error highlight decoration
export const setErrorHighlightEffect = StateEffect.define();

export const errorHighlightField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setErrorHighlightEffect)) return e.value;
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const CURSOR_COLORS = ['#e06c75', '#61afef', '#c678dd', '#98c379', '#e5c07b', '#56b6c2', '#be5046'];
export function cursorColor(userId) {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0;
  return CURSOR_COLORS[Math.abs(h) % CURSOR_COLORS.length];
}

// Tracked changes — insertion highlights
export const setTrackedChangesEffect = StateEffect.define();

export const trackedChangesField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setTrackedChangesEffect)) return e.value;
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Tracked changes — deletion strikethroughs (separate field so we can query it)
export const setTcDeletesEffect = StateEffect.define();

export const tcDeletesField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setTcDeletesEffect)) return e.value;
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function isPosInDeletion(state, pos) {
  const decos = state.field(tcDeletesField);
  let found = false;
  decos.between(pos, pos + 1, (from, to) => {
    if (pos >= from && pos < to) found = true;
  });
  return found;
}

export function isPosInInsertion(state, pos) {
  const decos = state.field(trackedChangesField);
  let found = false;
  decos.between(pos, pos + 1, (from, to) => {
    if (pos >= from && pos < to) found = true;
  });
  return found;
}

// Track changes gutter markers
export class TcInsertGutterMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-tc-gutter-insert';
    return el;
  }
}
export class TcDeleteGutterMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-tc-gutter-delete';
    return el;
  }
}
export const tcInsertMarkerInstance = new TcInsertGutterMarker();
export const tcDeleteMarkerInstance = new TcDeleteGutterMarker();

export const tcInsertGutterField = StateField.define({
  create() {
    return RangeSet.empty;
  },
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

export const tcDeleteGutterField = StateField.define({
  create() {
    return RangeSet.empty;
  },
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

export const tcInsertGutterExtension = gutter({
  class: 'cm-tc-insert-gutter',
  markers: (view) => view.state.field(tcInsertGutterField),
});

export const tcDeleteGutterExtension = gutter({
  class: 'cm-tc-delete-gutter',
  markers: (view) => view.state.field(tcDeleteGutterField),
});

export function buildTcInsertDecorations(trackedChanges, docLength, currentUserName) {
  const decos = [];
  for (const tc of trackedChanges || []) {
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
              title: `Inserted by ${tc.author_name === currentUserName ? 'You' : tc.author_name}`,
            },
          }).range(from, to),
        );
      }
    } catch (e) {}
  }
  decos.sort((a, b) => a.from - b.from);
  return Decoration.set(decos, true);
}

export function buildTcDeleteDecorations(trackedChanges, docLength, currentUserName) {
  const decos = [];
  for (const tc of trackedChanges || []) {
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
              title: `Deleted by ${tc.author_name === currentUserName ? 'You' : tc.author_name}`,
            },
          }).range(from, to),
        );
      }
    } catch (e) {}
  }
  decos.sort((a, b) => a.from - b.from);
  return Decoration.set(decos, true);
}

// Search highlight decoration
export const setSearchHighlightEffect = StateEffect.define();

export const searchHighlightField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSearchHighlightEffect)) return e.value;
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Spellcheck decoration
export const setSpellcheckEffect = StateEffect.define();

export const spellcheckField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSpellcheckEffect)) return e.value;
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Lint decoration
export const setLintEffect = StateEffect.define();

export const lintField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setLintEffect)) return e.value;
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Lint gutter markers — shown in a narrow gutter next to line numbers
export class LintErrorMarker extends GutterMarker {
  constructor(msg) {
    super();
    this.msg = msg;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-lint-gutter-error';
    el.title = this.msg;
    return el;
  }
}

export class LintWarningMarker extends GutterMarker {
  constructor(msg) {
    super();
    this.msg = msg;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-lint-gutter-warning';
    el.title = this.msg;
    return el;
  }
}

export class SpellGutterMarker extends GutterMarker {
  constructor(count) {
    super();
    this.count = count;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-spell-gutter-marker';
    el.title = `${this.count} misspelled word${this.count !== 1 ? 's' : ''} on this line`;
    return el;
  }
}

export const setLintGutterEffect = StateEffect.define();
export const setSpellGutterEffect = StateEffect.define();

export const lintGutterField = StateField.define({
  create() {
    return RangeSet.empty;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setLintGutterEffect)) return e.value;
    }
    return value;
  },
});

export const spellGutterField = StateField.define({
  create() {
    return RangeSet.empty;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSpellGutterEffect)) return e.value;
    }
    return value;
  },
});

export const lintGutterExtension = gutter({
  class: 'cm-lint-gutter',
  markers: (view) => view.state.field(lintGutterField),
});

export const spellGutterExtension = gutter({
  class: 'cm-spell-gutter',
  markers: (view) => view.state.field(spellGutterField),
});

export function applyLintDiagnostics(view, diagnostics) {
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
          }).range(from, to),
        );
      }
      // One gutter marker per line (first diagnostic wins)
      if (!seenLines.has(d.line)) {
        seenLines.add(d.line);
        const marker = d.severity === 'error' ? new LintErrorMarker(d.message) : new LintWarningMarker(d.message);
        gutterMarkers.push(marker.range(lineInfo.from));
      }
    } catch (e) {}
  }

  decos.sort((a, b) => a.from - b.from);
  gutterMarkers.sort((a, b) => a.from - b.from);

  view.dispatch({
    effects: [setLintEffect.of(Decoration.set(decos)), setLintGutterEffect.of(RangeSet.of(gutterMarkers))],
  });
}

export function applySpellcheck(view, misspelled) {
  const decos = misspelled.map((m) =>
    Decoration.mark({ class: 'cm-spell-error', attributes: { title: `Misspelled: ${m.word}` } }).range(m.from, m.to),
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
    effects: [setSpellcheckEffect.of(Decoration.set(decos)), setSpellGutterEffect.of(RangeSet.of(gutterMarkers))],
  });
}

// Citation key highlighter — decorates keys inside \cite{}, \citep{}, \citet{}, etc.
export const citeKeyMark = Decoration.mark({ class: 'cm-cite-key' });
export const citeKeyPattern = /\\cite[tp]?\*?\{([^}]+)\}/g;

export function buildCiteDecorations(view) {
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

export const citeKeyHighlighter = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildCiteDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildCiteDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// Table environment names the regex fallback should match
const TABLE_RE_NAMES =
  'tabular\\*?|tabularx|tabulary|tabu|longtabu|array|longtable|supertabular\\*?|NiceTabular\\*?|NiceArray';

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
  candidates.sort((a, b) => b.end - b.start - (a.end - a.start));
  const outer = candidates[0];
  return { from: outer.start, to: outer.end, text: source.slice(outer.start, outer.end) };
}

// Find and parse a table at the cursor using the AST parser, with regex fallback
export function findTableAtCursor(view) {
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
    env: 'tabular',
    alignment: 'c',
    borders: 'none',
    headerRow: false,
    boldHeader: false,
    caption: false,
    captionText: '',
    label: '',
    centering: false,
    zebra: false,
    booktabs: false,
    rows: 0,
    cols: 0,
    cells: [],
    from: offset,
    to: offset + text.length,
  };

  // Detect float wrapper
  result.centering = /\\centering/.test(text);
  result.zebra = /\\rowcolors/.test(text);
  if (/\\toprule|\\midrule|\\bottomrule/.test(text)) {
    result.borders = 'booktabs';
  }

  const captionMatch = text.match(/\\caption\{(.+?)\}/);
  if (captionMatch) {
    result.caption = true;
    result.captionText = captionMatch[1];
  }

  const labelMatch = text.match(/\\label\{(.+?)\}/);
  if (labelMatch) result.label = labelMatch[1];

  // Find inner env and colspec
  const envMatch =
    text.match(
      /\\begin\{(tabular\*?|tabularx|tabulary|tabu|longtabu?|array|longtable|supertabular\*?|NiceTabular\*?|NiceArray)\}(?:\{[^}]*\})?\{([^}]*)\}/,
    ) ||
    text.match(
      /\\begin\{(tabular\*?|tabularx|tabulary|tabu|longtabu?|array|longtable|supertabular\*?|NiceTabular\*?|NiceArray)\}\{([^}]*)\}/,
    );
  if (envMatch) {
    result.env = envMatch[1];
    const spec = envMatch[2] || envMatch[3] || '';
    const stripped = spec
      .replace(/\|/g, '')
      .replace(/[><!@]\{[^}]*\}/g, '')
      .replace(/[pmb]\{[^}]*\}/g, 'l')
      .replace(/\s/g, '');
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
  const innerMatch = text.match(
    /\\begin\{(?:tabular\*?|tabularx|tabulary|tabu|longtabu?|array|longtable|supertabular\*?|NiceTabular\*?|NiceArray)\}(?:\{[^}]*\})*\s*([\s\S]*?)\\end\{/,
  );
  if (innerMatch) {
    const body = innerMatch[1];
    const rawRows = body
      .split(/\\\\/)
      .map((r) => r.trim())
      .filter(
        (r) =>
          r &&
          !/^\\(?:hline|toprule|midrule|bottomrule|cline\{[^}]*\}|endfirsthead|endhead|endfoot|endlastfoot|caption\{[^}]*\}|label\{[^}]*\})$/.test(
            r,
          ),
      );
    const cellRows = rawRows
      .map((row) => {
        const cleaned = row
          .replace(
            /\\(?:hline|toprule|midrule|bottomrule|cline\{[^}]*\}|endfirsthead|endhead|endfoot|endlastfoot)\s*/g,
            '',
          )
          .trim();
        if (!cleaned || /^\\caption/.test(cleaned) || /^\\label/.test(cleaned)) return null;
        return cleaned.split('&').map((c) => c.trim());
      })
      .filter(Boolean);
    result.cells = cellRows;
    result.rows = cellRows.length;
    if (cellRows.length > 0) result.cols = Math.max(result.cols, ...cellRows.map((r) => r.length));
    if (cellRows.length > 0) {
      const first = cellRows[0];
      if (first.some((c) => c.length > 0)) {
        result.headerRow = true;
        result.boldHeader = first.some((c) => /\\textbf\s*\{/.test(c));
      }
    }
  }

  return result;
}
