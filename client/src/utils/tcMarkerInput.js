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
    if (shouldSkip && shouldSkip(tr)) return tr;
    if (tr.annotation(tcMarkerSkipAnnotation)) return tr;

    const tcOn = isOn();
    const author = getAuthor() || '';
    const beforeDoc = tr.startState.doc.toString();
    // Fast path: no markers in the doc, no protection or wrapping
    // needed when TC is off either. (Wrapping path below still handles
    // TC-on edits in a doc that hasn't acquired a marker yet.)
    if (!tcOn && !beforeDoc.includes(TC_START)) return tr;
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
    let delOverlap = false;
    // Track markers whose ENTIRE visible content sits inside a deletion
    // range — those get absorbed: del markers contribute their inner
    // text to the new del's text; ins markers are dropped (the user is
    // undoing their insertion as part of the bigger deletion). Marker
    // syntax in either case is stripped from the new del's text.
    const absorbedDels = new Set();
    const absorbedIns = new Set();
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      for (const m of existingMarkers) {
        if (fromA === toA) {
          // Pure insertion at a point: only the strict interior of a
          // FOREIGN marker corrupts it. Insertions strictly inside the
          // user's own ins marker are valid (the rewrite step grows
          // the marker). m.textFrom and m.textTo collapse visually
          // onto m.from and m.to (zero-width metadata + closing
          // sentinel) so they are also let through and remapped.
          if (fromA > m.from && fromA < m.to &&
              fromA !== m.textFrom && fromA !== m.textTo) {
            const insideOwnIns =
              m.type === 'ins' && m.author === author &&
              fromA >= m.textFrom && fromA <= m.textTo;
            if (!insideOwnIns) {
              crossesMarker = true;
              break;
            }
          }
          continue;
        }
        const overlap = fromA < m.to && toA > m.from;
        if (!overlap) continue;
        const fullyInsideOwnInsText =
          fromA >= m.textFrom && toA <= m.textTo &&
          m.type === 'ins' && m.author === author;
        // Backspace at the right edge of the user's own ins marker —
        // CM's atomic-range handling expanded the original [to-1, to)
        // deletion to span the (invisible) closing sentinel. Treat it
        // as "shrink the marker by one inner char."
        const rightEdgeOwnIns =
          fromA >= m.textTo && toA === m.to &&
          m.type === 'ins' && m.author === author;
        // Deletion fully contains a marker (visually). Use textFrom/
        // textTo as the visual edges since the metadata + closing
        // sentinel collapse onto m.from / m.to — when CM places the
        // selection end at the visual end of the marker, that doc
        // position is m.textTo, not m.to.
        const containsMarker =
          inserted.length === 0 &&
          fromA <= m.textFrom && toA >= m.textTo;
        // Selection partially overlaps a DEL marker's visible inner
        // text (selection enters or exits the strikethrough). Absorb
        // the whole del marker into the deletion — the chars are
        // already pending deletion, so extending the deletion bounds
        // to cover the rest of the marker is harmless and matches
        // user intent of "delete everything I selected (and adjacent
        // markers)."
        const partialOverlapsDelInner =
          inserted.length === 0 &&
          m.type === 'del' &&
          fromA < m.textTo && toA > m.textFrom;
        if (fullyInsideOwnInsText || rightEdgeOwnIns || containsMarker || partialOverlapsDelInner) {
          if (containsMarker || partialOverlapsDelInner) {
            if (m.type === 'del') absorbedDels.add(m);
            else absorbedIns.add(m);
          }
          continue;
        }
        // Backspace that overlaps a DEL marker on the metadata/sentinel
        // boundaries only (not the visible inner text). With TC ON
        // that's a "navigate through the strikethrough" press — move
        // the caret and let further backspaces extend the marker on
        // its left edge. With TC OFF the user is past TC, so just
        // absorb the marker and remove it on this press.
        if (m.type === 'del' && inserted.length === 0) {
          if (!tcOn) {
            absorbedDels.add(m);
            continue;
          }
          delOverlap = true;
        }
        crossesMarker = true;
        break;
      }
    });
    if (crossesMarker) {
      if (delOverlap) {
        const head = tr.startState.selection.main.head;
        // Special case: backspace at the left edge of a del marker
        // (caret on m.textFrom or m.from after walking through the
        // strikethrough). The user wants this press to extend the
        // deletion to include the char immediately before the marker
        // — otherwise the caret jumps two visible positions in one
        // step and the next backspace deletes the wrong char.
        for (const m of existingMarkers) {
          if (m.type !== 'del' || m.author !== author) continue;
          if (head !== m.textFrom && head !== m.from) continue;
          if (m.from === 0) continue;
          const beforeIdx = m.from - 1;
          // Bail if the preceding char is itself inside another marker
          // (would corrupt that marker's length-prefixed header).
          const inOther = existingMarkers.some(
            (om) => om !== m && beforeIdx >= om.from && beforeIdx < om.to,
          );
          if (inOther) break;
          const charBefore = beforeDoc[beforeIdx];
          const merged = serialize({
            type: 'del',
            id: m.id || shortId(),
            author,
            text: charBefore + m.text,
          });
          return [{
            changes: [{ from: beforeIdx, to: m.to, insert: merged }],
            selection: { anchor: beforeIdx },
            annotations: tcMarkerSkipAnnotation.of(true),
          }];
        }
        // Default delOverlap behaviour: move the caret one visible
        // position to the left in lieu of deleting (chars already
        // pending deletion).
        return [{ selection: { anchor: caretLeftSkipBoundaries(head, existingMarkers) } }];
      }
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

      // TC OFF: don't wrap; just remap interior-boundary positions so
      // that typing at m.textTo (cursor visually at end of marker's
      // visible text but doc-wise just before the hidden closing
      // sentinel) appends AFTER the marker instead of corrupting its
      // length header. The cross-marker check above already rejected
      // changes that would corrupt a marker some other way.
      if (!tcOn) {
        // Edits fully inside the user's own ins marker's inner text
        // need to be reserialized through the marker's header so the
        // length-prefixed text stays consistent. Without this, an
        // in-place edit (typing or deleting one char inside the
        // marker) would chop the inner text but leave the header's
        // length field pointing at the old byte count — the marker
        // becomes unparseable and its `ins:id:author:N:` prefix leaks
        // into the visible document.
        const enclosing = (() => {
          for (const m of existingMarkers) {
            if (m.type !== 'ins' || m.author !== author) continue;
            if (fromA >= m.textFrom && toA <= m.textTo) return m;
          }
          return null;
        })();
        if (enclosing) {
          const offset = fromA - enclosing.textFrom;
          const len = toA - fromA;
          const newText =
            enclosing.text.slice(0, offset) + insertText + enclosing.text.slice(offset + len);
          if (newText) {
            const replacement = serialize({
              type: 'ins',
              id: enclosing.id || shortId(),
              author: enclosing.author,
              text: newText,
            });
            rewrites.push({ from: enclosing.from, to: enclosing.to, insert: replacement });
            const newHeaderLen = replacement.length - newText.length - 1;
            cursorTarget = enclosing.from + newHeaderLen + offset + insertText.length;
          } else {
            rewrites.push({ from: enclosing.from, to: enclosing.to, insert: '' });
            cursorTarget = enclosing.from;
          }
          didRewrite = true;
          return;
        }
        let effectiveFromA = fromA;
        let effectiveToA = toA;
        for (const m of existingMarkers) {
          if (fromA === m.textFrom) effectiveFromA = m.from;
          else if (fromA === m.textTo) effectiveFromA = m.to;
          if (toA === m.textFrom) effectiveToA = m.from;
          else if (toA === m.textTo) effectiveToA = m.to;
        }
        // Extend the range to cover any markers absorbed by the
        // cross-marker check (partial or full overlap). Without this,
        // a TC-off deletion that nicks a marker on either side would
        // leave the marker's length-prefixed header pointing at
        // truncated bytes, exposing the raw `del:...` / `ins:...`
        // syntax in the visible document.
        for (const m of absorbedDels) {
          if (m.from < effectiveFromA) effectiveFromA = m.from;
          if (m.to > effectiveToA) effectiveToA = m.to;
        }
        for (const m of absorbedIns) {
          if (m.from < effectiveFromA) effectiveFromA = m.from;
          if (m.to > effectiveToA) effectiveToA = m.to;
        }
        if (effectiveFromA !== fromA || effectiveToA !== toA) {
          rewrites.push({ from: effectiveFromA, to: effectiveToA, insert: insertText });
          cursorTarget = effectiveFromA + insertText.length;
          didRewrite = true;
        }
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
        // Insertion strictly inside the user's own ins marker — grow
        // the marker's text in place. (Without this branch, typing in
        // the middle of an ins block — including a multi-line one
        // where line breaks are inside the marker's inner text —
        // would be rejected.)
        for (const m of existingMarkers) {
          if (m.type !== 'ins' || m.author !== author) continue;
          if (!(fromA > m.textFrom && fromA < m.textTo)) continue;
          const offset = fromA - m.textFrom;
          const newText = m.text.slice(0, offset) + insertText + m.text.slice(offset);
          const replacement = serialize({
            type: 'ins',
            id: m.id || shortId(),
            author,
            text: newText,
          });
          rewrites.push({ from: m.from, to: m.to, insert: replacement });
          // Caret lands right after the inserted chars in the new doc.
          // headerLen is constant so the caret is at:
          //   m.from + (m.textFrom - m.from) + offset + insertText.length
          cursorTarget = m.textFrom + offset + insertText.length;
          didRewrite = true;
          return;
        }
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

      // Backspace at the right edge of the user's own ins marker.
      // After CM's atomic-range adjustment the deletion spans
      // [m.textTo, m.to) (just the closing sentinel) and possibly
      // some trailing inner text. The user's intent is "delete the
      // last char of my just-typed text," so shrink the marker.
      if (deletedText && !insertText) {
        for (const m of existingMarkers) {
          if (m.type !== 'ins' || m.author !== author) continue;
          if (toA !== m.to) continue;
          if (fromA < m.textTo) continue;
          // Deletion covered only the closing sentinel + (possibly
          // none of) the inner text. Shrink m.text by one char from
          // the right; if that empties the marker, drop it entirely.
          const newText = m.text.slice(0, -1);
          if (newText) {
            const replacement = serialize({
              type: 'ins',
              id: m.id || shortId(),
              author,
              text: newText,
            });
            rewrites.push({ from: m.from, to: m.to, insert: replacement });
            cursorTarget = m.from + replacement.length;
          } else {
            rewrites.push({ from: m.from, to: m.to, insert: '' });
            cursorTarget = m.from;
          }
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

      // No merge — emit fresh marker(s). When the deletion absorbed
      // any markers, the actual rewrite range may need to extend
      // beyond [fromA, toA) to fully cover them (the user's selection
      // may have ended at the marker's visual edge — m.textTo — but
      // the marker's bytes extend to m.to). The new del's text is the
      // VISIBLE content in the extended range: plain chars + del
      // markers' inner text; ins markers are dropped (the user's own
      // insertion is undone by the deletion).
      let effectiveFromA = fromA;
      let effectiveToA = toA;
      const absorbedAll = [...absorbedDels, ...absorbedIns];
      for (const m of absorbedAll) {
        if (m.from < effectiveFromA) effectiveFromA = m.from;
        if (m.to > effectiveToA) effectiveToA = m.to;
      }
      let wrapped = '';
      let insMarkerLen = 0;
      if (insertText) {
        const ins = serialize({ type: 'ins', id: shortId(), author, text: insertText });
        wrapped += ins;
        insMarkerLen = ins.length;
      }
      if (deletedText) {
        let visibleText;
        if (absorbedAll.length > 0) {
          const inRange = absorbedAll
            .slice()
            .sort((a, b) => a.from - b.from);
          let buf = '';
          let i = effectiveFromA;
          for (const m of inRange) {
            if (i < m.from) buf += beforeDoc.slice(i, m.from);
            // Del's text becomes part of the new del; ins's text is
            // dropped (insertion undone).
            if (m.type === 'del') buf += m.text;
            i = m.to;
          }
          if (i < effectiveToA) buf += beforeDoc.slice(i, effectiveToA);
          visibleText = buf;
        } else {
          visibleText = deletedText;
        }
        if (visibleText) {
          wrapped += serialize({ type: 'del', id: shortId(), author, text: visibleText });
        }
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
            // Caret stays at the left edge of the deletion, in the
            // NEW doc's coordinate space. headerLen = replacement
            // length minus the inner text minus the closing sentinel.
            const newHeaderLen = replacement.length - newText.length - 1;
            cursorTarget = enclosing.from + newHeaderLen + offset;
          } else {
            // Drop the marker entirely.
            rewrites.push({ from: enclosing.from, to: enclosing.to, insert: '' });
            cursorTarget = enclosing.from;
          }
          didRewrite = true;
          return;
        }
      }

      rewrites.push({ from: effectiveFromA, to: effectiveToA, insert: wrapped });
      // For a pure insertion, the caret has to land just past the new
      // ins marker so the next keystroke triggers the merge path. For a
      // pure deletion or a replacement, the caret lands at the start of
      // the new wrap — visually before the strikethrough.
      if (insertText && !deletedText) {
        cursorTarget = effectiveFromA + insMarkerLen;
      } else {
        cursorTarget = effectiveFromA;
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
 * Compute the position one VISIBLE char to the left of `head`, jumping
 * over marker hidden zones in a single step (mirrors what the arrow
 * keymap does at boundary positions). Used when backspace overlaps a
 * del marker — the caret moves backward instead of deleting since the
 * chars are already pending deletion.
 */
function caretLeftSkipBoundaries(head, markers) {
  for (const m of markers) {
    if (head === m.to) {
      return m.text.length > 0 ? m.textTo - 1 : Math.max(0, m.from - 1);
    }
    if (head === m.textFrom) {
      return Math.max(0, m.from - 1);
    }
  }
  return Math.max(0, head - 1);
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
