// Transaction filter that converts user keystrokes into inline tcMarkers
// when track-changes mode is on. Pairs with tcMarkerDecorations.js, which
// renders the produced markers visually.
//
// The contract:
//   - When track-changes mode is OFF, this filter is a no-op.
//   - When ON, every user-originated change is rewritten so that:
//       * a pure insertion `from === to, insert: 'x'`
//             → `from === to, insert: <ins-marker:x>`
//       * a pure deletion `from < to, insert: ''`
//             → `from..to replaced with <del-marker:original-text>`
//       * a replacement (from < to, insert: 'y')
//             → `from..to replaced with <ins-marker:y><del-marker:original>`
//   - Transactions tagged as "resolving a TC" (accept/reject) or coming
//     from a remote OT broadcast are NOT rewritten — they're applied
//     verbatim so accept/reject and collaborator edits work normally.
//
// Adjacent same-author same-type markers are merged in the filter so
// rapid typing produces ONE growing marker rather than a string of
// single-char markers. Without merging the doc would balloon and the
// user would see visually-fragmented underlines.
import { EditorState } from '@codemirror/state';
import { parseAll, parseAt, serialize, TC_START, TC_END } from '@shared/tcMarkers.js';

// Annotations callers attach to a transaction so this filter knows to
// leave it alone. Editor.jsx-side flags are passed in via opts.skip.
//
// We export the annotation type so resolveTrackedChangeEdit and the
// websocket OT applier can mark their dispatches with it.
import { Annotation } from '@codemirror/state';
export const tcMarkerSkipAnnotation = Annotation.define();

function shortId() {
  // 8 hex chars; collisions across one project's pending markers are
  // overwhelmingly unlikely and the id only matters for matching the
  // accept/reject button's marker to the document's marker.
  return Math.random().toString(16).slice(2, 10).padStart(8, '0');
}

/**
 * Find the marker (if any) that ends EXACTLY at doc position `pos` and
 * matches type+author. Used for merging a fresh change into the marker
 * that immediately precedes it.
 */
function markerEndingAt(content, pos, type, author) {
  // Cheap reject: pos must be preceded by the closing sentinel char.
  if (pos === 0) return null;
  if (content[pos - 1] !== TC_END) return null;
  // Find the start of the marker by scanning leftward for the leading
  // sentinel. Since markers can't nest, the nearest leading sentinel
  // before pos is ours.
  const start = content.lastIndexOf(TC_START, pos - 1);
  if (start < 0) return null;
  const m = parseAt(content, start);
  if (!m || m.to !== pos) return null;
  if (m.type !== type) return null;
  if (m.author !== author) return null;
  return m;
}

/**
 * Find the marker (if any) that starts EXACTLY at doc position `pos`
 * and matches type+author. Used for merging a deletion that abuts an
 * existing del marker on its right side.
 */
function markerStartingAt(content, pos, type, author) {
  if (content[pos] !== TC_START) return null;
  const m = parseAt(content, pos);
  if (!m || m.from !== pos) return null;
  if (m.type !== type) return null;
  if (m.author !== author) return null;
  return m;
}

/**
 * Build the transaction filter. The filter examines each transaction's
 * changes and, if track-changes mode is on, rewrites them in-place to
 * carry tcMarkers.
 *
 * @param {object} opts
 * @param {() => boolean} opts.isOn - Returns true when track-changes
 *   mode is enabled. Re-evaluated per transaction.
 * @param {() => string} opts.getAuthor - Returns the author string for
 *   newly-created markers. Re-evaluated per transaction so a name
 *   change takes effect immediately.
 * @param {() => boolean} [opts.shouldSkip] - Optional extra predicate.
 *   Defaults to false; useful to plug in legacy isResolvingTc /
 *   isRemoteUpdate refs from Editor.jsx.
 */
export function buildTcMarkerInputFilter({ isOn, getAuthor, shouldSkip }) {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    if (!isOn()) return tr;
    if (shouldSkip && shouldSkip(tr)) return tr;
    if (tr.annotation(tcMarkerSkipAnnotation)) return tr;

    const author = getAuthor() || '';
    const beforeDoc = tr.startState.doc.toString();
    const existingMarkers = parseAll(beforeDoc);

    // Markers are atomic from the user's perspective — they can't be
    // edited by raw typing or backspace, only via the Accept/Reject UI.
    // The one exception is a change fully inside the user's OWN ins
    // marker's inner text: that's the user editing their own pending
    // typing, and the shrink path below handles it. Everything else is
    // rejected outright — pretending to apply such a change would either
    // leave a marker with a sentinel in its text (breaking parsing) or
    // silently lose user content. In particular, backspacing a char
    // inside an existing DEL marker used to wrap that backspace in a
    // fresh del marker INSIDE the existing one, leaving the outer
    // marker's length-prefixed header pointing at corrupted bytes.
    let crossesMarker = false;
    tr.changes.iterChanges((fromA, toA) => {
      for (const m of existingMarkers) {
        if (fromA === toA) {
          // Pure insertion at a point: only the strict interior of the
          // marker corrupts it. m.from and m.to are valid edit points
          // (they sit just outside the marker). m.textFrom and m.textTo
          // are technically interior, but they collapse visually onto
          // m.from and m.to (the metadata and closing sentinel have
          // zero visual width), so a click between two adjacent markers
          // commonly lands at one of these interior boundaries — let
          // them through and the rewrite step below remaps them.
          if (fromA > m.from && fromA < m.to &&
              fromA !== m.textFrom && fromA !== m.textTo) {
            crossesMarker = true;
            break;
          }
          continue;
        }
        const overlap = fromA < m.to && toA > m.from;
        if (!overlap) continue;
        const fullyInsideOwnInsText =
          fromA >= m.textFrom && toA <= m.textTo &&
          m.type === 'ins' && m.author === author;
        if (fullyInsideOwnInsText) continue;
        crossesMarker = true;
        break;
      }
    });
    if (crossesMarker) {
      // Drop the transaction entirely. The user has to position the
      // caret outside the marker, or use Accept/Reject.
      return [];
    }

    // Build a brand-new changes array. We DO NOT use ChangeSet.compose
    // because the rewritten changes overlap the original change's
    // range, and CodeMirror would reject that. We replace each change
    // with a single change in the same range that inserts the wrapped
    // text instead.
    const rewrites = [];
    // Track each rewrite's intended caret destination. After a typing
    // insertion the caret has to land just past the new marker so the
    // NEXT keystroke's transaction has fromA === marker.to and the
    // merge path fires; otherwise the caret would land inside the
    // marker, the merge check would miss, and each new char would
    // produce a fresh nested marker (the bug the user just reported).
    // For deletions the caret stays at the START of the marker so a
    // follow-up backspace continues to extend by deleting the char to
    // the left of the strikethrough.
    let cursorTarget = null;
    let didRewrite = false;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      const insertText = inserted.toString();
      const deletedText = beforeDoc.slice(fromA, toA);
      // If neither side has content, this is a no-op change (shouldn't
      // happen, but be safe).
      if (!insertText && !deletedText) {
        rewrites.push({ from: fromA, to: toA, insert: '' });
        return;
      }

      // Try to merge an INSERTION into an existing same-author 'ins'
      // marker that ends at fromA. The merge replaces the marker with
      // a wider one whose text has the new chars appended.
      //
      // First, remap interior boundary positions: when two markers sit
      // back-to-back (m1.to === m2.from) the visible spot between them
      // collapses onto three doc positions — m1.textTo, m1.to / m2.from,
      // and m2.textFrom — and a click typically lands at one of the
      // interior ones. Without remapping, typing there would either be
      // rejected or wrap a fresh marker INSIDE m1 / m2, corrupting the
      // length-prefixed header. The remap pushes the interior boundary
      // out to the marker's outer boundary so the standard merge path
      // catches it.
      if (insertText && !deletedText) {
        let effectiveFromA = fromA;
        for (const m of existingMarkers) {
          if (fromA === m.textFrom) { effectiveFromA = m.from; break; }
          if (fromA === m.textTo) { effectiveFromA = m.to; break; }
        }
        const prev = markerEndingAt(beforeDoc, effectiveFromA, 'ins', author);
        if (prev) {
          const merged = serialize({
            type: 'ins',
            id: prev.id || shortId(),
            author,
            text: prev.text + insertText,
          });
          rewrites.push({ from: prev.from, to: prev.to, insert: merged });
          cursorTarget = prev.from + merged.length;
          didRewrite = true;
          return;
        }
        // No merge candidate. If the click sat on an interior boundary,
        // emit a fresh ins marker at the OUTER boundary (otherwise the
        // wrap would land in the middle of a marker and break parsing).
        if (effectiveFromA !== fromA) {
          const ins = serialize({ type: 'ins', id: shortId(), author, text: insertText });
          rewrites.push({ from: effectiveFromA, to: effectiveFromA, insert: ins });
          cursorTarget = effectiveFromA + ins.length;
          didRewrite = true;
          return;
        }
      }

      // Try to merge a DELETION into an existing same-author 'del'
      // marker that starts at toA (we're deleting just before it) or
      // ends at fromA (we're deleting just after it).
      if (deletedText && !insertText) {
        const right = markerStartingAt(beforeDoc, toA, 'del', author);
        if (right) {
          const merged = serialize({
            type: 'del',
            id: right.id || shortId(),
            author,
            text: deletedText + right.text,
          });
          rewrites.push({ from: fromA, to: right.to, insert: merged });
          cursorTarget = fromA;
          didRewrite = true;
          return;
        }
        const left = markerEndingAt(beforeDoc, fromA, 'del', author);
        if (left) {
          const merged = serialize({
            type: 'del',
            id: left.id || shortId(),
            author,
            text: left.text + deletedText,
          });
          rewrites.push({ from: left.from, to: toA, insert: merged });
          cursorTarget = left.from;
          didRewrite = true;
          return;
        }
      }

      // No merge — emit fresh marker(s).
      let wrapped = '';
      let insMarkerLen = 0;
      if (insertText) {
        const ins = serialize({ type: 'ins', id: shortId(), author, text: insertText });
        wrapped += ins;
        insMarkerLen = ins.length;
      }
      if (deletedText) {
        wrapped += serialize({ type: 'del', id: shortId(), author, text: deletedText });
      }
      // ALSO: if the deletion range falls inside an existing 'ins'
      // marker by the same author, the user is undoing their own
      // insertion. In that case we should shrink the insertion marker
      // instead of recording a deletion of marker syntax. Detect by
      // checking that the WHOLE deleted span is inside one ins marker.
      if (deletedText && !insertText) {
        const enclosing = enclosingInsMarker(beforeDoc, fromA, toA, author);
        if (enclosing) {
          const offset = fromA - enclosing.textFrom;
          const len = toA - fromA;
          const newText = enclosing.text.slice(0, offset) + enclosing.text.slice(offset + len);
          if (newText) {
            const replacement = serialize({
              type: 'ins',
              id: enclosing.id || shortId(),
              author,
              text: newText,
            });
            rewrites.push({ from: enclosing.from, to: enclosing.to, insert: replacement });
            // Caret stays where the user just deleted, mapped through
            // the rewrite — that's the position right after the
            // shrunk text.
            cursorTarget = enclosing.from + (replacement.length - 1);
          } else {
            // Drop the marker entirely.
            rewrites.push({ from: enclosing.from, to: enclosing.to, insert: '' });
            cursorTarget = enclosing.from;
          }
          didRewrite = true;
          return;
        }
      }

      rewrites.push({ from: fromA, to: toA, insert: wrapped });
      // For a pure insertion, the caret has to land just past the new
      // ins marker so the next keystroke triggers the merge path. For a
      // pure deletion or a replacement, the caret lands at the start of
      // the new wrap — visually before the strikethrough.
      if (insertText && !deletedText) {
        cursorTarget = fromA + insMarkerLen;
      } else {
        cursorTarget = fromA;
      }
      didRewrite = true;
    });

    if (!didRewrite) return tr;
    const spec = { changes: rewrites, sequential: false };
    if (cursorTarget !== null) {
      spec.selection = { anchor: cursorTarget };
    }
    return [spec];
  });
}

/**
 * Returns the 'ins' marker that wholly contains the deletion range
 * [fromA, toA), or null. Used by the "delete inside my own insertion"
 * shrink path so the user can backspace through their just-inserted
 * text without spawning a separate del marker that contains marker
 * syntax (which would be a parse-defying mess).
 */
function enclosingInsMarker(beforeDoc, fromA, toA, author) {
  const markers = parseAll(beforeDoc);
  for (const m of markers) {
    if (m.type !== 'ins') continue;
    if (m.author !== author) continue;
    if (fromA >= m.textFrom && toA <= m.textTo) return m;
  }
  return null;
}
