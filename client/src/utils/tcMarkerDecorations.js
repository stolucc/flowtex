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
import { Decoration, EditorView } from '@codemirror/view';
import { StateField, EditorState, RangeSet, RangeSetBuilder } from '@codemirror/state';
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
 * Atomic-range facet so cursor motions (arrow keys, click placement,
 * selection extension) skip over the hidden metadata regions instead
 * of letting the caret land inside a marker's header. Without this the
 * user could land between the leading sentinel and the inner text and
 * then break the marker by typing.
 */
export const tcMarkerAtomicRanges = EditorView.atomicRanges.of((view) => {
  const docText = view.state.doc.toString();
  if (!docText.includes(TC_START)) return RangeSet.empty;
  const markers = parseAll(docText);
  if (markers.length === 0) return RangeSet.empty;
  const builder = new RangeSetBuilder();
  for (const m of markers) {
    // Cover the metadata-header region [from, textFrom) and the closing
    // sentinel [textTo, to). The inner text [textFrom, textTo) stays
    // editable so the user can still select / copy the inserted or
    // deleted text within a marker.
    if (m.textFrom > m.from) builder.add(m.from, m.textFrom, Decoration.mark({}));
    if (m.to > m.textTo) builder.add(m.textTo, m.to, Decoration.mark({}));
  }
  return builder.finish();
});

/** Returns the bundle of extensions consumers should add to the editor. */
export function tcMarkerExtensions() {
  return [tcMarkerDecorationsField, tcMarkerAtomicRanges];
}
