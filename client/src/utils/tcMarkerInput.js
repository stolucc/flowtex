// Transaction filter that converts user keystrokes into inline tcMarkers
// when track-changes mode is on. Thin shell around normalizeChange in
// tcMarkerNormalize.js — see that file for the algorithm. The filter's
// only job here is to:
//
//   1. Bail out for transactions tagged as "tc-skip" (accept/reject doc
//      edits, OT applies, legacy isResolvingTc / isRemoteUpdate refs).
//   2. Iterate the transaction's changes, hand each to normalizeChange,
//      and accumulate a single rewritten transaction spec.
//   3. Forward a rejection (`null` from normalizeChange — happens when
//      the change would absorb a foreign-author marker) as `[]`.
//
// All the previous TC ON/OFF, ins/del, partial/full overlap, boundary
// cases live inside normalizeChange now — adding a new edge case there
// only changes one algorithm rather than five layered exception checks.
import { Annotation, EditorState } from '@codemirror/state';
import { parseAll } from '@shared/tcMarkers.js';
import { normalizeChange } from './tcMarkerNormalize.js';

export const tcMarkerSkipAnnotation = Annotation.define();

/**
 * Build the transaction filter.
 *
 * @param {object} opts
 * @param {() => boolean} opts.isOn - Returns true when TC mode is on.
 * @param {() => string} opts.getAuthor - Returns the author string for
 *   newly-created markers.
 * @param {(tr: any) => boolean} [opts.shouldSkip] - Predicate called
 *   per transaction; if true, the filter passes the transaction
 *   through unchanged.
 */
export function buildTcMarkerInputFilter({ isOn, getAuthor, shouldSkip }) {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    if (shouldSkip && shouldSkip(tr)) return tr;
    if (tr.annotation(tcMarkerSkipAnnotation)) return tr;

    const tcOn = isOn();
    const author = getAuthor() || '';
    const beforeDoc = tr.startState.doc.toString();
    // Fast path: no markers anywhere AND TC is off → nothing to do.
    if (!tcOn && !beforeDoc.includes('\u{e000}')) return tr;
    const markers = parseAll(beforeDoc);

    const rewrites = [];
    let cursorTarget = null;
    let didRewrite = false;
    let rejected = false;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (rejected) return;
      const insertText = inserted.toString();
      const result = normalizeChange({
        beforeDoc, markers, fromA, toA, insertText, tcOn, author,
      });
      if (result === null) {
        rejected = true;
        return;
      }
      // Detect "the rewrite is identical to the original change" —
      // skip in that case so we don't churn the doc with a no-op.
      const onlyChange = result.changes.length === 1 ? result.changes[0] : null;
      const isOriginal =
        onlyChange &&
        onlyChange.from === fromA &&
        onlyChange.to === toA &&
        onlyChange.insert === insertText;
      if (!isOriginal) didRewrite = true;
      for (const c of result.changes) rewrites.push(c);
      cursorTarget = result.cursor;
    });

    if (rejected) return [];
    if (!didRewrite) return tr;
    const spec = { changes: rewrites, sequential: false };
    if (cursorTarget !== null) {
      spec.selection = { anchor: cursorTarget };
    }
    return [spec];
  });
}
