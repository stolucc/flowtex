// @ts-check
// Track-changes V1 — input filter (M2 model: §3 editing rules).
//
// In M2, deleted text STAYS IN THE DOC and is marked with a strikethrough
// `del` mark. The cursor traverses these chars naturally (right arrow
// steps through the strikethrough). The input filter rewrites the
// transaction's changes so original-text deletions become no-ops on the
// doc but produce a del mark instead. Self-retraction (deleting your
// own pending ins) is the only case that actually shrinks the doc.
//
// Bypassed for transactions tagged with tcMarkSkipAnnotation:
//   - Hydration (setTcMarks at file load)
//   - Accept/reject doc surgery
//   - Remote OT applies
//
// Decision invariant (§3.1): all boundary checks compare against entries
// in `tr.startState` (the pre-transaction sidecar) and old-doc positions.

import { ChangeSet, EditorState, Transaction } from '@codemirror/state';
import { addTcMarks, removeTcMark, shortId, tcMarkSkipAnnotation, tcMarksField } from './tcMarks.js';

/**
 * Given a deletion [fromA, toA) in the OLD doc and the OLD sidecar,
 * return the sub-ranges covered by the current author's own pending
 * ins. Each covered sub-range will actually be deleted from the doc
 * (self-retraction §3.3.a).
 * @param {any} fromA
 * @param {any} toA
 * @param {any} authorId
 * @param {any} oldMarks
 */
function ownInsSegments(fromA, toA, authorId, oldMarks) {
  if (!oldMarks) return [];
  /** @type {Array<{ from: number, to: number }>} */
  const out = [];
  oldMarks.between(fromA, toA, (/** @type {number} */ rfrom, /** @type {number} */ rto, /** @type {any} */ val) => {
    if (
      val.spec.type === 'ins' &&
      val.spec.authorId === authorId &&
      rto > rfrom
    ) {
      out.push({ from: Math.max(rfrom, fromA), to: Math.min(rto, toA) });
    }
  });
  out.sort((/** @type {any} */ a, /** @type {any} */ b) => a.from - b.from);
  return out;
}

/**
 * Subtract `covered` (sorted, disjoint) from [fromA, toA). Return the
 * uncovered sub-ranges in left-to-right order. These are the ranges
 * that should be marked as del (kept in the doc, struck through).
 * @param {any} fromA
 * @param {any} toA
 * @param {any} covered
 */
function subtractCovered(fromA, toA, covered) {
  if (covered.length === 0) return [{ from: fromA, to: toA }];
  /** @type {Array<{ from: number, to: number }>} */
  const out = [];
  let cur = fromA;
  for (const s of covered) {
    if (s.from > cur) out.push({ from: cur, to: s.from });
    cur = Math.max(cur, s.to);
  }
  if (cur < toA) out.push({ from: cur, to: toA });
  return out;
}

/**
 * Build the transaction filter for TC ON.
 *
 * @param {object} opts
 * @param {() => boolean} opts.isOn      - Returns true when TC mode is on.
 * @param {() => string}  opts.getAuthorId   - Stable user id.
 * @param {() => string}  opts.getAuthorName - Display-name snapshot.
 * @param {(tr: any) => boolean} [opts.shouldSkip] - Optional bypass predicate.
 */
export function buildTcMarksInputFilter({ isOn, getAuthorId, getAuthorName, shouldSkip }) {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    if (shouldSkip && shouldSkip(tr)) return tr;
    if (tr.annotation(tcMarkSkipAnnotation)) return tr;
    // History (undo/redo) dispatches already carry the correct
    // (changes, effects) tuple captured at original commit time — let
    // them through unfiltered. Otherwise the filter would rewrite the
    // redo's changes and synthesize fresh mark ids instead of restoring
    // the original ones. See §5.
    if (tr.isUserEvent('undo') || tr.isUserEvent('redo')) return tr;
    if (!isOn()) return tr;

    const authorId = getAuthorId() || '';
    const authorName = getAuthorName() || '';
    const timestamp = new Date().toISOString();
    const oldMarks = tr.startState.field(tcMarksField, /* require */ false);
    const oldDocLen = tr.startState.doc.length;

    // Build new changes (positions in old doc) and pending mark targets.
    /** @type {any[]} */
    const customChanges = [];
    /** @type {any[]} */
    const pendingDel = []; // { fromOld, toOld }
    /** @type {any[]} */
    const pendingIns = []; // { atOld, length }

    // IDs of marks that should be removed in this transaction. Two
    // sources:
    //  (a) ins entries fully consumed by deletions (self-retraction) —
    //      we emit removeTcMark so invertedEffects can restore them on
    //      undo (otherwise the StateField's zero-length filter silently
    //      drops them and undo brings text back as plain).
    //  (b) marks being merged with newly-created adjacent ones — we
    //      remove the old, add a combined new one. Keeps continuous
    //      typing as ONE ins entry (rather than one per keystroke) and
    //      consecutive backspaces as ONE del entry.
    /** @type {string[]} */
    const removedIds = [];

    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      const insertText = inserted.toString();

      // ── Deletion handling (M2) ─────────────────────────────────────
      // Split [fromA, toA) into:
      //   - own-ins-covered → actually delete (self-retraction §3.3.a)
      //   - everything else → keep in doc, mark as del (§3.3.b)
      if (toA > fromA) {
        const covered = ownInsSegments(fromA, toA, authorId, oldMarks);
        const uncovered = subtractCovered(fromA, toA, covered);
        for (const seg of covered) {
          customChanges.push({ from: seg.from, to: seg.to, insert: '' });
        }
        // Each uncovered sub-range becomes a del mark. If there's an
        // own-author del immediately AFTER the sub-range (`rfrom ===
        // seg.to`), merge: remove the old del and emit a combined one
        // covering [seg.from, oldDel.to). Keeps consecutive backspace
        // a single del entry.
        for (const seg of uncovered) {
          let mergeRightId = null;
          let mergeRightTo = null;
          if (oldMarks) {
            oldMarks.between(seg.to, seg.to, (rfrom, rto, val) => {
              if (
                val.spec.type === 'del' &&
                val.spec.authorId === authorId &&
                rto > rfrom &&
                rfrom === seg.to
              ) {
                mergeRightId = val.spec.id;
                mergeRightTo = rto;
              }
            });
          }
          if (mergeRightId !== null) {
            removedIds.push(mergeRightId);
            pendingDel.push({ fromOld: seg.from, toOld: mergeRightTo });
          } else {
            pendingDel.push({ fromOld: seg.from, toOld: seg.to });
          }
        }
        // Track fully-consumed own ins entries for explicit removal.
        if (oldMarks) {
          oldMarks.between(fromA, toA, (rfrom, rto, val) => {
            if (
              val.spec.type === 'ins' &&
              val.spec.authorId === authorId &&
              rto > rfrom &&
              rfrom >= fromA &&
              rto <= toA
            ) {
              removedIds.push(val.spec.id);
            }
          });
        }
      }

      // ── Insertion handling ─────────────────────────────────────────
      // Insert at fromA in old doc. For replacement (toA > fromA), this
      // puts the new text at the START of the kept-or-marked region.
      // The kept original chars (now strikethrough) follow; from the
      // user's perspective the new text appears at the cursor location.
      if (insertText.length > 0) {
        let absorbedByOwnIns = false;
        // Continuous-typing merge: if there's an own ins ending exactly
        // at fromA, remove it and emit a single combined ins covering
        // the old chars plus the new ones. Result: one ins entry per
        // editing run instead of one per keystroke.
        let mergeLeftId = null;
        /** @type {number | null} */
        let mergeLeftFrom = null;
        // Pure insertion (toA === fromA) strictly inside a del → split
        // the del into a left half [rfrom, fromA) and a right half
        // [fromA, rto). The two halves keep the ORIGINAL del's author
        // and timestamp; the new ins (the user's typed text) gets the
        // current author. Without this the del's `to` would map past
        // the insertion and visually strike through the new chars, and
        // accepting the del would wipe them away with the original
        // deleted text.
        /** @type {Array<{ rfrom: number, rto: number, spec: any }>} */
        const delsToSplit = [];
        if (oldMarks) {
          oldMarks.between(fromA, fromA, (/** @type {number} */ rfrom, /** @type {number} */ rto, /** @type {any} */ val) => {
            if (
              val.spec.type === 'ins' &&
              val.spec.authorId === authorId &&
              rfrom < fromA &&
              fromA < rto
            ) {
              absorbedByOwnIns = true;
            } else if (
              val.spec.type === 'ins' &&
              val.spec.authorId === authorId &&
              rto === fromA &&
              rfrom < rto
            ) {
              mergeLeftId = val.spec.id;
              mergeLeftFrom = rfrom;
            } else if (
              val.spec.type === 'del' &&
              toA === fromA &&
              rfrom < fromA &&
              fromA < rto
            ) {
              delsToSplit.push({ rfrom, rto, spec: val.spec });
            }
          });
        }
        for (const d of delsToSplit) {
          removedIds.push(d.spec.id);
          pendingDel.push({ fromOld: d.rfrom, toOld: fromA, originSpec: d.spec });
          pendingDel.push({ fromOld: fromA, toOld: d.rto, originSpec: d.spec });
        }
        customChanges.push({ from: fromA, to: fromA, insert: insertText });
        if (absorbedByOwnIns) {
          // No new entry — the existing range expands via RangeSet.map.
        } else if (mergeLeftId !== null && mergeLeftFrom !== null) {
          removedIds.push(mergeLeftId);
          pendingIns.push({
            atOld: mergeLeftFrom,
            length: (fromA - mergeLeftFrom) + insertText.length,
          });
        } else {
          pendingIns.push({ atOld: fromA, length: insertText.length });
        }
      }
    });

    // Build the actual ChangeSet (positions in old doc → applied as one).
    const newChanges = ChangeSet.of(customChanges, oldDocLen);

    // Compute NEW doc positions for the mark targets.
    const newEntries = [];
    for (const d of pendingDel) {
      // For the del range [fromOld, toOld) we want to track the SAME
      // original chars after our customChanges land. Insertions at the
      // boundary should land OUTSIDE the del range:
      //   - from with assoc=1: insertion at fromOld pushes the original
      //     chars right; new range starts where those chars now live.
      //   - to with assoc=-1: insertion at toOld stays outside the del
      //     range (new chars come AFTER the marked region).
      const newFrom = newChanges.mapPos(d.fromOld, 1);
      const newTo = newChanges.mapPos(d.toOld, -1);
      if (newFrom < newTo) {
        newEntries.push({
          id: shortId(),
          type: 'del',
          from: newFrom,
          to: newTo,
          // When d.originSpec is set, this del entry is one half of a
          // split that happened because the user inserted INSIDE someone
          // else's del. Preserve the original author/timestamp so the
          // split doesn't silently re-attribute their deletion to us.
          authorId: d.originSpec?.authorId ?? authorId,
          authorName: d.originSpec?.authorName ?? authorName,
          timestamp: d.originSpec?.timestamp ?? timestamp,
        });
      }
    }
    for (const i of pendingIns) {
      const newFrom = newChanges.mapPos(i.atOld, -1);
      const newTo = newFrom + i.length;
      newEntries.push({
        id: shortId(),
        type: 'ins',
        from: newFrom,
        to: newTo,
        authorId,
        authorName,
        timestamp,
      });
    }

    // Selection: tr.selection is ALREADY in post-tr-change coordinates
    // (CM computed it for the user's intended action). Our rewritten
    // changes produce a doc whose length differs from tr's intended doc,
    // but the cursor's INTENDED position (e.g., fromA after backspace)
    // is the same number in both — for backspace at end-of-doc, cursor
    // at P-1 is valid whether we deleted the char or kept it as a del
    // mark. Pass tr.selection through directly; do NOT remap.
    const newSelection = tr.selection;

    const effects = [];
    if (newEntries.length > 0) effects.push(addTcMarks.of(newEntries));
    for (const id of removedIds) effects.push(removeTcMark.of(id));

    // Preserve the userEvent annotation so CM history groups correctly
    // (keymap dispatches "delete.backward" / "input.type" etc).
    const userEvent = tr.annotation(Transaction.userEvent);
    const annotations = userEvent ? Transaction.userEvent.of(userEvent) : undefined;

    return {
      changes: newChanges,
      selection: newSelection,
      effects,
      annotations,
      scrollIntoView: tr.scrollIntoView,
    };
  });
}
