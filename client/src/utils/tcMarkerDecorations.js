// CodeMirror extension that turns inline tracked-change markers in the
// document into editor decorations. The markers themselves (sentinels +
// metadata header + closing sentinel) are hidden via Decoration.replace;
// the inner text portion is marked with the TC-insert / TC-delete CSS
// classes that the rest of the app already styles. The result: the
// editor shows a clean view of the user's prose plus blue underlines
// for insertions and red strikethroughs for deletions, while the
// underlying document carries everything the server needs to compile
// the PDF, persist via the websocket, and replay history.
//
// The extension is purely presentational. Recording new tracked changes
// (i.e. converting keystrokes into markers) is the input layer's job —
// see useTrackedChanges + Editor input handling.
import { Decoration, EditorView, keymap, gutter, GutterMarker } from '@codemirror/view';
import { StateField, RangeSet, RangeSetBuilder, Prec } from '@codemirror/state';
import { parseAll, TC_START } from '@shared/tcMarkers.js';

// Hide a span entirely. `inclusive: true` so cursor motions skip past
// it; combined with the atomic-ranges facet below, the user can't put
// the caret inside a marker's metadata.
function hiddenReplace() {
  return Decoration.replace({ inclusive: true });
}

function classMark(cls, attrs) {
  return Decoration.mark({ class: cls, attributes: attrs });
}

/**
 * Build the decoration set for `state`. Exported for direct use in the
 * StateField initializer and for testing.
 */
export function buildMarkerDecorations(state) {
  const docText = state.doc.toString();
  if (!docText.includes(TC_START)) return Decoration.none;
  const markers = parseAll(docText);
  if (markers.length === 0) return Decoration.none;

  const builder = new RangeSetBuilder();
  for (const m of markers) {
    const cls = m.type === 'ins' ? 'cm-tc-insert' : 'cm-tc-delete';
    const attrs = {
      'data-tc-id': m.id,
      'data-tc-type': m.type,
      'data-tc-author': m.author,
      title:
        m.type === 'ins'
          ? `Inserted${m.author ? ` by ${m.author}` : ''}`
          : `Deleted${m.author ? ` by ${m.author}` : ''}`,
    };
    // 1) hide the leading sentinel + metadata header
    if (m.textFrom > m.from) builder.add(m.from, m.textFrom, hiddenReplace());
    // 2) style the inner text (skipped if the text is empty — empty
    //    insertions/deletions shouldn't render visually but we still
    //    want them removed from view, so the surrounding hides take care
    //    of the entire marker)
    if (m.textTo > m.textFrom) builder.add(m.textFrom, m.textTo, classMark(cls, attrs));
    // 3) hide the trailing sentinel
    if (m.to > m.textTo) builder.add(m.textTo, m.to, hiddenReplace());
  }
  return builder.finish();
}

/**
 * StateField driving the decorations. It rebuilds on every transaction
 * that mutates the doc — cheap, since parseAll is O(content) and only
 * runs when there's at least one TC_START sentinel.
 */
export const tcMarkerDecorationsField = StateField.define({
  create(state) {
    return buildMarkerDecorations(state);
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    return buildMarkerDecorations(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Atomic-range facet so cursor motions skip over the hidden metadata
 * regions instead of letting the caret land between the leading
 * sentinel and the inner text. Only the hidden zones are atomic; the
 * inner text stays normally navigable so backspace can shrink the
 * user's own ins markers one char at a time.
 *
 * Note: m.textFrom and m.textTo remain valid cursor positions because
 * they're the LEFT/RIGHT boundary of an atomic range. They visually
 * collapse onto the marker's outer boundaries (m.from / m.to) since
 * the metadata and closing sentinel have zero width — so a click that
 * lands at one of those interior positions has to be remapped at the
 * input-filter level, otherwise the resulting edit either gets
 * rejected or corrupts the marker.
 */
export const tcMarkerAtomicRanges = EditorView.atomicRanges.of((view) => {
  const docText = view.state.doc.toString();
  if (!docText.includes(TC_START)) return RangeSet.empty;
  const markers = parseAll(docText);
  if (markers.length === 0) return RangeSet.empty;
  const builder = new RangeSetBuilder();
  for (const m of markers) {
    if (m.textFrom > m.from) builder.add(m.from, m.textFrom, Decoration.mark({}));
    if (m.to > m.textTo) builder.add(m.textTo, m.to, Decoration.mark({}));
  }
  return builder.finish();
});

/**
 * Keymap that makes ArrowLeft/ArrowRight feel natural at marker
 * boundaries. The hidden metadata + closing sentinel each occupy one
 * doc position with zero visual width — so a single default arrow
 * press at the edge of a marker traverses a hidden position and looks
 * like a no-op. We intercept those edge positions and dispatch a
 * 2-position jump in one keypress.
 *
 * Boundary positions and what each press should do (non-empty marker):
 *   ArrowLeft  at `to`        → cursor lands at textTo - 1
 *   ArrowLeft  at textFrom    → cursor lands at from - 1
 *   ArrowRight at `from`      → cursor lands at textFrom + 1
 *   ArrowRight at textTo      → cursor lands at `to` + 1
 *
 * For empty-text markers the whole marker has zero visual width, so
 * any press from any of its boundary positions jumps clear past the
 * marker.
 */
function jumpAtBoundary(view, isLeft) {
  const { state } = view;
  if (!state.selection.main.empty) return false;
  const head = state.selection.main.head;
  const docText = state.doc.toString();
  if (!docText.includes(TC_START)) return false;
  const markers = parseAll(docText);
  for (const m of markers) {
    if (m.text.length === 0) {
      if (isLeft && (head === m.to || head === m.textTo || head === m.textFrom)) {
        view.dispatch({ selection: { anchor: Math.max(0, m.from - 1) }, scrollIntoView: true });
        return true;
      }
      if (!isLeft && (head === m.from || head === m.textFrom || head === m.textTo)) {
        view.dispatch({
          selection: { anchor: Math.min(state.doc.length, m.to + 1) },
          scrollIntoView: true,
        });
        return true;
      }
      continue;
    }
    if (isLeft) {
      if (head === m.to) {
        view.dispatch({ selection: { anchor: m.textTo - 1 }, scrollIntoView: true });
        return true;
      }
      if (head === m.textFrom) {
        view.dispatch({ selection: { anchor: Math.max(0, m.from - 1) }, scrollIntoView: true });
        return true;
      }
    } else {
      if (head === m.from) {
        view.dispatch({ selection: { anchor: m.textFrom + 1 }, scrollIntoView: true });
        return true;
      }
      if (head === m.textTo) {
        view.dispatch({
          selection: { anchor: Math.min(state.doc.length, m.to + 1) },
          scrollIntoView: true,
        });
        return true;
      }
    }
  }
  return false;
}

const tcMarkerArrowKeymap = Prec.high(
  keymap.of([
    { key: 'ArrowLeft', run: (view) => jumpAtBoundary(view, true) },
    { key: 'ArrowRight', run: (view) => jumpAtBoundary(view, false) },
  ]),
);

// Gutter markers — one dot per line that contains a tracked-change
// marker. Built directly from parseAll so the dots can never drift.

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

function buildGutterMarkers(state, type) {
  const docText = state.doc.toString();
  if (!docText.includes(TC_START)) return RangeSet.empty;
  const markers = parseAll(docText);
  if (markers.length === 0) return RangeSet.empty;
  // One dot per line; collect distinct line starts so two markers on
  // the same line don't render two dots stacked.
  const lines = new Set();
  for (const m of markers) {
    if (m.type !== type) continue;
    if (m.from < 0 || m.from > state.doc.length) continue;
    lines.add(state.doc.lineAt(m.from).from);
  }
  const sorted = [...lines].sort((a, b) => a - b);
  const inst = type === 'ins' ? tcInsertMarkerInstance : tcDeleteMarkerInstance;
  return RangeSet.of(sorted.map((p) => inst.range(p)));
}

const tcInsertGutterField = StateField.define({
  create(state) {
    return buildGutterMarkers(state, 'ins');
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    return buildGutterMarkers(tr.state, 'ins');
  },
});

const tcDeleteGutterField = StateField.define({
  create(state) {
    return buildGutterMarkers(state, 'del');
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    return buildGutterMarkers(tr.state, 'del');
  },
});

const tcInsertGutter = gutter({
  class: 'cm-tc-insert-gutter',
  markers: (view) => view.state.field(tcInsertGutterField),
});

const tcDeleteGutter = gutter({
  class: 'cm-tc-delete-gutter',
  markers: (view) => view.state.field(tcDeleteGutterField),
});

/** Returns the bundle of extensions consumers should add to the editor. */
export function tcMarkerExtensions() {
  return [
    tcMarkerDecorationsField,
    tcMarkerAtomicRanges,
    tcMarkerArrowKeymap,
    tcInsertGutterField,
    tcDeleteGutterField,
    tcInsertGutter,
    tcDeleteGutter,
  ];
}
