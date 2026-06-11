// @ts-check
import { EditorView, Decoration, ViewPlugin, WidgetType, gutter, GutterMarker } from '@codemirror/view';
import { StateEffect, StateField, RangeSet } from '@codemirror/state';
import { foldService } from '@codemirror/language';
import { parse as parseLatex, findTableAtPos, parseTable, findFigureAtPos, parseFigure } from './latexParser.js';

// ─── LaTeX folding ──────────────────────────────────────────────────────────

/** @type {Record<string, number>} */
const SECTION_LEVELS = {
  'part': 0, 'part*': 0,
  'chapter': 1, 'chapter*': 1,
  'section': 2, 'section*': 2,
  'subsection': 3, 'subsection*': 3,
  'subsubsection': 4, 'subsubsection*': 4,
  'paragraph': 5, 'paragraph*': 5,
  'subparagraph': 6, 'subparagraph*': 6,
};

const SECTION_RE = /\\((?:sub){0,3}(?:section|paragraph)\*?|chapter\*?|part\*?)\s*\{/;
const BEGIN_RE = /\\begin\{([^}]+)\}/;
/** @type {Record<string, RegExp>} */
const END_RE_CACHE = {};

/**
 * Get or create a cached regex matching \end{envName}.
 * @param {any} envName
 */
function getEndRe(envName) {
  if (!END_RE_CACHE[envName]) {
    END_RE_CACHE[envName] = new RegExp('\\\\end\\{' + envName.replace(/\*/g, '\\*') + '\\}');
  }
  return END_RE_CACHE[envName];
}

/** CodeMirror fold service for LaTeX environments and sectioning commands. */
export const latexFoldService = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart);
  const text = line.text;

  // Environment folding: \begin{env} ... \end{env}
  const beginMatch = text.match(BEGIN_RE);
  if (beginMatch) {
    const envName = beginMatch[1];
    const endRe = getEndRe(envName);
    // Search forward for matching \end
    let depth = 0;
    const beginInnerRe = new RegExp('\\\\begin\\{' + envName.replace(/\*/g, '\\*') + '\\}', 'g');
    for (let i = line.number + 1; i <= state.doc.lines; i++) {
      const l = state.doc.line(i);
      // Count nested begins on this line
      const begins = l.text.match(beginInnerRe);
      if (begins) depth += begins.length;
      if (endRe.test(l.text)) {
        if (depth === 0) {
          // Fold from end of \begin line to start of \end line
          if (l.from > line.to) {
            return { from: line.to, to: l.from - 1 };
          }
          return null;
        }
        depth--;
      }
    }
  }

  // Section folding: \section{...} folds to next section of same or higher level
  const secMatch = text.match(SECTION_RE);
  if (secMatch) {
    const level = SECTION_LEVELS[secMatch[1]];
    if (level === undefined) return null;
    // Search forward for next section of same or higher level, or \end{document}
    for (let i = line.number + 1; i <= state.doc.lines; i++) {
      const l = state.doc.line(i);
      const nextSec = l.text.match(SECTION_RE);
      if (nextSec) {
        const nextLevel = SECTION_LEVELS[nextSec[1]];
        if (nextLevel !== undefined && nextLevel <= level) {
          // Fold up to the line before this section (skip trailing blank lines)
          let endLine = i - 1;
          while (endLine > line.number && state.doc.line(endLine).text.trim() === '') endLine--;
          const foldEnd = state.doc.line(endLine).to;
          if (foldEnd > line.to) {
            return { from: line.to, to: foldEnd };
          }
          return null;
        }
      }
      // Stop at \end{document}
      if (/\\end\{document\}/.test(l.text)) {
        let endLine = i - 1;
        while (endLine > line.number && state.doc.line(endLine).text.trim() === '') endLine--;
        const foldEnd = state.doc.line(endLine).to;
        if (foldEnd > line.to) {
          return { from: line.to, to: foldEnd };
        }
        return null;
      }
    }
    // No next section found — fold to end of document
    let endLine = state.doc.lines;
    while (endLine > line.number && state.doc.line(endLine).text.trim() === '') endLine--;
    const foldEnd = state.doc.line(endLine).to;
    if (foldEnd > line.to) {
      return { from: line.to, to: foldEnd };
    }
  }

  return null;
});

/**
 * Build CodeMirror decorations for unresolved comments.
 * @param {any[]} comments - Comment objects with from_pos, to_pos, resolved, id
 * @param {number} docLength - Current document length
 * @returns {import('@codemirror/view').DecorationSet}
 */
function buildCommentDecorations(comments, docLength) {
  /** @type {Array<import('@codemirror/state').Range<import('@codemirror/view').Decoration>>} */
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
    } catch (e) {
      console.warn('Comment decoration error:', e);
    }
  }
  widgets.sort((a, b) => a.from - b.from);
  return Decoration.set(widgets);
}

/**
 * Create a ViewPlugin that highlights comment ranges in the editor.
 * @param {any[]} comments - Comment objects
 */
export function commentHighlighter(comments) {
  return ViewPlugin.fromClass(
    class {
      /** @type {import('@codemirror/view').DecorationSet} */
      decorations;
      /** @param {import('@codemirror/view').EditorView} view */
      constructor(view) {
        this.decorations = buildCommentDecorations(comments, view.state.doc.length);
      }
      /** @param {import('@codemirror/view').ViewUpdate} update */
      update(update) {
        if (update.docChanged) {
          this.decorations = this.decorations.map(update.changes);
        }
      }
    },
    { decorations: (/** @type {any} */ v) => v.decorations },
  );
}

/** Widget that renders a remote collaborator's cursor with a name label. */
export class CursorWidget extends WidgetType {
  /**
   * @param {string} userName
   * @param {string} color
   */
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

/** @type {import('@codemirror/state').StateEffectType<import('@codemirror/view').DecorationSet>} */
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
/** @type {import('@codemirror/state').StateEffectType<import('@codemirror/view').DecorationSet>} */
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

const CURSOR_COLORS = ['#e06c75', '#61afef', '#c678dd', '#98c379', '#e5c07b', '#56b6c2', '#be5046'];
/**
 * Deterministically pick a cursor color for a user ID.
 * @param {string} userId
 * @returns {string} CSS color hex string
 */
export function cursorColor(userId) {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0;
  return CURSOR_COLORS[Math.abs(h) % CURSOR_COLORS.length];
}

// (Tracked-changes pipeline removed — to be rebuilt from scratch.)

// Search highlight decoration
/** @type {import('@codemirror/state').StateEffectType<import('@codemirror/view').DecorationSet>} */
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
/** @type {import('@codemirror/state').StateEffectType<import('@codemirror/view').DecorationSet>} */
const setSpellcheckEffect = StateEffect.define();

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
/** @type {import('@codemirror/state').StateEffectType<import('@codemirror/view').DecorationSet>} */
const setLintEffect = StateEffect.define();

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
class LintErrorMarker extends GutterMarker {
  /** @param {string} msg */
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

class LintWarningMarker extends GutterMarker {
  /** @param {string} msg */
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

class SpellGutterMarker extends GutterMarker {
  /** @param {number} count */
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

/** @type {import('@codemirror/state').StateEffectType<import('@codemirror/state').RangeSet<any>>} */
const setLintGutterEffect = StateEffect.define();
/** @type {import('@codemirror/state').StateEffectType<import('@codemirror/state').RangeSet<any>>} */
const setSpellGutterEffect = StateEffect.define();

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

/**
 * Apply lint diagnostics as editor decorations and gutter markers.
 * @param {EditorView} view
 * @param {Array<{line: number, col: number, len?: number, severity: string, message: string}>} diagnostics
 */
export function applyLintDiagnostics(view, diagnostics) {
  /** @type {any[]} */
  const decos = [];
  /** @type {any[]} */
  const gutterMarkers = [];
  const seenLines = new Set();

  for (const d of diagnostics) {
    try {
      const lineInfo = view.state.doc.line(Math.min(d.line, view.state.doc.lines));
      const len = d.len || 0;
      const from = len > 0 ? Math.min(lineInfo.from + Math.max(0, d.col - 1), lineInfo.to) : lineInfo.from;
      const to = len > 0 ? Math.min(from + len, lineInfo.to) : lineInfo.to;
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
    } catch (e) {
      console.warn('Lint decoration error:', e);
    }
  }

  decos.sort((a, b) => a.from - b.from);
  gutterMarkers.sort((a, b) => a.from - b.from);

  view.dispatch({
    effects: [setLintEffect.of(Decoration.set(decos)), setLintGutterEffect.of(RangeSet.of(gutterMarkers))],
  });
}

/**
 * Apply spellcheck underlines and gutter markers, skipping tracked deletions.
 * @param {EditorView} view
 * @param {Array<{from: number, to: number, word: string}>} misspelled
 */
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
const citeKeyMark = Decoration.mark({ class: 'cm-cite-key' });
const citeKeyPattern = /\\cite[tp]?\*?\{([^}]+)\}/g;

/**
 * Build decorations that highlight citation keys inside \\cite{} commands.
 * @param {EditorView} view
 * @returns {import('@codemirror/view').DecorationSet}
 */
function buildCiteDecorations(view) {
  /** @type {Array<import('@codemirror/state').Range<import('@codemirror/view').Decoration>>} */
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
    /** @type {import('@codemirror/view').DecorationSet} */
    decorations;
    /** @param {import('@codemirror/view').EditorView} view */
    constructor(view) {
      this.decorations = buildCiteDecorations(view);
    }
    /** @param {import('@codemirror/view').ViewUpdate} update */
    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildCiteDecorations(update.view);
      }
    }
  },
  { decorations: (/** @type {any} */ v) => v.decorations },
);

// ─── Float gutter icons (tables & figures) ──────────────────────────────────
// Single gutter column showing table/figure icons. Clicking opens the builder.

const TABLE_BEGIN_RE =
  /\\begin\{(tabular\*?|tabularx|tabulary|tabu|longtabu|array|longtable|supertabular\*?|NiceTabular\*?|NiceArray|table\*?)\}/g;
const FIGURE_BEGIN_RE = /\\begin\{(figure\*?)\}/g;

const TABLE_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #4fc3f7)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
  '<line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/>' +
  '<line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>';

const FIGURE_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #4fc3f7)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
  '<circle cx="8.5" cy="8.5" r="1.5"/>' +
  '<polyline points="21 15 16 10 5 21"/></svg>';

class FloatGutterMarker extends GutterMarker {
  /**
   * @param {number} pos
   * @param {string} kind
   */
  constructor(pos, kind) {
    super();
    this.floatPos = pos;
    this.kind = kind; // 'table' | 'figure'
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-float-gutter-marker';
    el.innerHTML = this.kind === 'table' ? TABLE_ICON : FIGURE_ICON;
    el.title = this.kind === 'table' ? 'Edit table' : 'Edit figure';
    return el;
  }
}

/** @type {import('@codemirror/state').StateEffectType<import('@codemirror/state').RangeSet<any>>} */
const setFloatGutterEffect = StateEffect.define();

const floatGutterField = StateField.define({
  create() {
    return RangeSet.empty;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFloatGutterEffect)) return e.value;
    }
    return value.map(tr.changes);
  },
});

const floatGutterExtension = gutter({
  class: 'cm-float-gutter',
  markers: (view) => view.state.field(floatGutterField),
  domEventHandlers: {
    mousedown(view, line) {
      const markers = view.state.field(floatGutterField);
      /** @type {any} */
      let found = null;
      markers.between(line.from, line.from + 1, (/** @type {number} */ from, /** @type {number} */ to, /** @type {any} */ marker) => {
        found = marker;
      });
      if (found) {
        view.dispatch({ selection: { anchor: found.floatPos } });
        const event = found.kind === 'table' ? 'open-table-builder' : 'open-figure-builder';
        view.dom.dispatchEvent(new CustomEvent(event, { bubbles: true }));
      }
      return true;
    },
  },
});

/**
 * Scan the document for table and figure environments and update gutter markers.
 * @param {EditorView} view
 */
function updateFloatGutterMarkers(view) {
  const doc = view.state.doc.toString();
  /** @type {Array<import('@codemirror/state').Range<any>>} */
  const markers = [];
  /** @type {Set<number>} */
  const seenLines = new Set();

  // Tables: find float wrappers first, then standalone tabulars
  const FLOAT_RE = /\\begin\{(table\*?)\}/g;
  /** @type {Array<{ from: number, to: number }>} */
  const floatRanges = [];
  let fm;
  while ((fm = FLOAT_RE.exec(doc)) !== null) {
    const envName = fm[1];
    const endRe = new RegExp('\\\\end\\{' + envName.replace(/\*/g, '\\*') + '\\}', 'g');
    endRe.lastIndex = fm.index + fm[0].length;
    const endMatch = endRe.exec(doc);
    if (endMatch) {
      floatRanges.push({ from: fm.index, to: endMatch.index + endMatch[0].length });
      const lineNum = view.state.doc.lineAt(fm.index).number;
      if (!seenLines.has(lineNum)) {
        seenLines.add(lineNum);
        const lineInfo = view.state.doc.line(lineNum);
        markers.push(new FloatGutterMarker(fm.index, 'table').range(lineInfo.from));
      }
    }
  }
  TABLE_BEGIN_RE.lastIndex = 0;
  /** @type {RegExpExecArray | null} */
  let m;
  while ((m = TABLE_BEGIN_RE.exec(doc)) !== null) {
    const mm = m;
    if (/^table\*?$/.test(mm[1])) continue;
    const inside = floatRanges.some((/** @type {any} */ r) => mm.index >= r.from && mm.index < r.to);
    if (inside) continue;
    const lineNum = view.state.doc.lineAt(mm.index).number;
    if (seenLines.has(lineNum)) continue;
    seenLines.add(lineNum);
    const lineInfo = view.state.doc.line(lineNum);
    markers.push(new FloatGutterMarker(mm.index, 'table').range(lineInfo.from));
  }

  // Figures
  FIGURE_BEGIN_RE.lastIndex = 0;
  while ((m = FIGURE_BEGIN_RE.exec(doc)) !== null) {
    const lineNum = view.state.doc.lineAt(m.index).number;
    if (seenLines.has(lineNum)) continue;
    seenLines.add(lineNum);
    const lineInfo = view.state.doc.line(lineNum);
    markers.push(new FloatGutterMarker(m.index, 'figure').range(lineInfo.from));
  }

  markers.sort((a, b) => a.from - b.from);
  view.dispatch({ effects: setFloatGutterEffect.of(RangeSet.of(markers)) });
}

// Backward-compatible aliases
export const tableGutterField = floatGutterField;
export const tableGutterExtension = floatGutterExtension;
/**
 * @param {any} view
 */
export function updateTableGutterMarkers(view) { updateFloatGutterMarkers(view); }
/** @param {any} [_view] */
export function updateFigureGutterMarkers(_view) { /* no-op, handled by updateFloatGutterMarkers */ }

/**
 * Find and parse the figure environment at the cursor position.
 * @param {EditorView} view
 * @returns {any} Parsed figure data or null
 */
export function findFigureAtCursor(view) {
  const pos = view.state.selection.main.head;
  const source = view.state.doc.toString();
  try {
    const tree = parseLatex(source);
    const figInfo = findFigureAtPos(tree, pos);
    if (figInfo) {
      return parseFigure(figInfo, source);
    }
  } catch (e) {
    console.warn('AST figure detection failed:', e);
  }
  // Regex fallback
  const found = findFigureByRegex(source, pos);
  if (!found) return null;
  return parseFigureFromText(found.text, found.from);
}

/**
 * Regex fallback: find the figure environment containing position `pos`.
 * @param {string} source - Full document text
 * @param {number} pos - Cursor position
 * @returns {{from: number, to: number, text: string}|null}
 */
function findFigureByRegex(source, pos) {
  const re = /\\begin\{(figure\*?)\}/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const envName = match[1];
    let start = match.index;
    const endRe = new RegExp('\\\\end\\{' + envName.replace(/\*/g, '\\*') + '\\}', 'g');
    endRe.lastIndex = start + match[0].length;
    const endMatch = endRe.exec(source);
    if (endMatch) {
      let end = endMatch.index + endMatch[0].length;
      if (pos >= start && pos <= end) {
        // Expand to include \begingroup\floatsetup before
        const lookback = source.slice(Math.max(0, start - 300), start);
        const bgMatch = lookback.match(/\\begingroup\s*\\floatsetup(?:\[figure\])?\{[^}]*\}\s*$/);
        if (bgMatch) {
          start = start - bgMatch[0].length;
        }
        // Expand to include \endgroup after
        const afterText = source.slice(end, end + 50);
        const egMatch = afterText.match(/^\s*\\endgroup/);
        if (egMatch) {
          end = end + egMatch[0].length;
        }
        return { from: start, to: end, text: source.slice(start, end) };
      }
    }
  }
  return null;
}

/**
 * Parse figure properties from raw LaTeX text (regex-based fallback).
 * @param {string} text - The figure environment source
 * @param {number} offset - Document offset where the text starts
 * @returns {Object} Parsed figure data
 */
function parseFigureFromText(text, offset) {
  const result = {
    env: 'figure',
    placement: 'htbp',
    imagePath: '',
    width: '0.8',
    widthUnit: 'textwidth',
    caption: false,
    captionText: '',
    label: '',
    centering: false,
    captionPos: 'bottom',
    captionVAlign: 'center',
    from: offset,
    to: offset + text.length,
  };
  const envMatch = text.match(/\\begin\{(figure\*?)\}/);
  if (envMatch) result.env = envMatch[1];
  const placementMatch = text.match(/\\begin\{figure\*?\}\[([^\]]*)\]/);
  if (placementMatch) result.placement = placementMatch[1];
  if (/\\centering/.test(text)) result.centering = true;
  const imgMatch = text.match(/\\includegraphics(?:\[([^\]]*)\])?\{([^}]*)\}/);
  if (imgMatch) {
    result.imagePath = imgMatch[2];
    if (imgMatch[1]) {
      const wm = imgMatch[1].match(/width\s*=\s*([\d.]+)\s*\\?(textwidth|linewidth|columnwidth)/);
      if (wm) { result.width = wm[1]; result.widthUnit = wm[2]; }
      else {
        const wm2 = imgMatch[1].match(/width\s*=\s*([\d.]+)\s*(cm|mm|in|pt)/);
        if (wm2) { result.width = wm2[1]; result.widthUnit = wm2[2]; }
      }
    }
  }
  const capMatch = text.match(/\\caption\{([^}]*)\}/);
  if (capMatch) { result.caption = true; result.captionText = capMatch[1]; }
  const labelMatch = text.match(/\\label\{([^}]*)\}/);
  if (labelMatch) result.label = labelMatch[1];
  // Caption position: check if \caption appears before \includegraphics
  if (result.caption && imgMatch) {
    const capIdx = text.indexOf('\\caption');
    const imgIdx = text.indexOf('\\includegraphics');
    result.captionPos = capIdx < imgIdx ? 'top' : 'bottom';
  }
  // Check for \thisfloatsetup or \floatsetup side caption pattern
  const besideMatch = text.match(/\\(?:this)?floatsetup(?:\[figure\])?\{[^}]*capbesideposition=\{(\w+),(\w+)\}/);
  if (besideMatch) {
    result.captionPos = besideMatch[1] === 'left' ? 'left' : 'right';
    result.captionVAlign = besideMatch[2] || 'center';
  } else {
    const capOverride = text.match(/\\begingroup\s*\\floatsetup\[figure\]\{capposition=(top|bottom)\}/);
    if (capOverride) result.captionPos = capOverride[1];
  }
  return result;
}

// Table environment names the regex fallback should match
const TABLE_RE_NAMES =
  'tabular\\*?|tabularx|tabulary|tabu|longtabu|array|longtable|supertabular\\*?|NiceTabular\\*?|NiceArray';

/**
 * Regex fallback: find the table environment containing position `pos`.
 * @param {string} source - Full document text
 * @param {number} pos - Cursor position
 * @returns {{from: number, to: number, text: string}|null}
 */
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
    const envNameMatch = match[0].match(/\{(.+)\}/);
    if (!envNameMatch) continue;
    const envName = envNameMatch[1];
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

/**
 * Find and parse the table environment at the cursor position (AST with regex fallback).
 * @param {EditorView} view
 * @param {Array<{path: string, content: string}>} [projectFiles] - Project files for cross-file custom column type lookup
 * @returns {any} Parsed table data or null
 */
export function findTableAtCursor(view, projectFiles) {
  const pos = view.state.selection.main.head;
  const source = view.state.doc.toString();

  // Find the main file preamble for custom column types (the file with \documentclass)
  let preambleSource = null;
  if (projectFiles && !source.includes('\\documentclass')) {
    const mainFile = projectFiles.find((f) => f.content && f.content.includes('\\documentclass'));
    if (mainFile) preambleSource = mainFile.content;
  }

  // Try AST parser first
  try {
    const tree = parseLatex(source);
    const tableInfo = findTableAtPos(tree, pos);
    if (tableInfo) {
      return parseTable(tableInfo, source, preambleSource);
    }
  } catch (e) {
    console.warn('AST table detection failed, using fallback:', e);
  }

  // Regex fallback
  const found = findTableByRegex(source, pos);
  if (!found) return null;
  return parseTableFromText(found.text, found.from);
}

/**
 * Parse table properties from raw LaTeX text (regex-based fallback).
 * @param {string} text - The table environment source
 * @param {number} offset - Document offset where the text starts
 * @returns {Object} Parsed table data
 */
function parseTableFromText(text, offset) {
  /** @type {any} */
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
    const spec = envMatch[2] || '';
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
        return cleaned.split('&').map((/** @type {string} */ c) => c.trim());
      })
      .filter(Boolean);
    /** @type {string[][]} */
    const cells = /** @type {string[][]} */ (cellRows);
    result.cells = cells;
    result.rows = cells.length;
    if (cells.length > 0) result.cols = Math.max(result.cols, ...cells.map((r) => r.length));
    if (cells.length > 0) {
      const first = cells[0];
      if (first.some((c) => c.length > 0)) {
        result.headerRow = true;
        result.boldHeader = first.some((c) => /\\textbf\s*\{/.test(c));
      }
    }
  }

  return result;
}
