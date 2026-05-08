// Pure function that turns a user's intended change into a tc-marker-safe
// change spec. The transactionFilter in tcMarkerInput.js is a thin shell
// around this — see normalizeChange's contract and invariants below.
//
// Behavior contract — the rules this algorithm implements are pinned as
// tests in __tests__/tcMarkerRules.test.js. Each test there names a
// specific user-visible rule (A1, A2, …, F1) so any "but X behaves
// wrong" report can be traced to (or added as) a single rule. The
// categories are:
//
//   A. Typing (TC ON) creates and grows pending insertions.
//   B. Backspace (TC ON) shrinks pending insertions.
//   C. Pending deletions: del markers absorb adjacent ones, selection
//      that visually covers a marker folds its content into a bigger del.
//   D. TC OFF preserves markers without re-tracking the user's edit.
//   E. Caret placement after edits (typing → end of new ins so the
//      next keystroke merges; deletion → start of the new del).
//   F. Invariants: every rewrite leaves the doc with parseable markers.
//
// When you need to change behaviour, add or update the rule test FIRST,
// then adjust the phases below until it passes. The property tests
// (tcMarkerNormalize.test.js) catch corruption at scale; the rules
// table catches behaviour drift.
//
// Why this lives in its own file: the prior version inside the filter
// had ~5 named cross-marker exceptions and ~6 separate rewrite branches
// that interacted in subtle ways. Each new edge-case bug surfaced a
// missing combination. This module replaces all of that with a single
// algorithm with explicitly-named phases.
//
// Algorithm:
//   0. If the user's change is fully inside their OWN ins marker's
//      inner text, reserialize the marker in place (preserves the
//      "I just typed this and want to keep editing" UX).
//   1. Expand the change range to fully cover any marker it overlaps,
//      iterated to a fixed point.
//   2. Reconstruct the VISIBLE old content in the expanded range:
//      plain chars stay; DEL markers' text is appended (those chars
//      were "deleted" semantically — still part of the visible doc);
//      INS markers are dropped (the user's previous insertion is
//      undone as part of the bigger edit).
//   3. Merge with adjacent same-author markers on either side (so
//      typing at the right edge of an ins extends it, and chained
//      backspaces extend a single del).
//   4. Emit the replacement: ins/del markers if TC is ON, plain text
//      if it's OFF.
//   5. Compute the caret target.
import { TC_END, TC_START, parseAt, serialize } from '@shared/tcMarkers.js';

function shortId() {
  return Math.random().toString(16).slice(2, 10).padStart(8, '0');
}

/** Visible content of a range — plain chars + del markers' inner text. */
function reconstructVisible(beforeDoc, efA, eTA, markers) {
  const inRange = markers
    .filter((m) => m.from >= efA && m.to <= eTA)
    .sort((a, b) => a.from - b.from);
  let buf = '';
  let i = efA;
  for (const m of inRange) {
    if (i < m.from) buf += beforeDoc.slice(i, m.from);
    if (m.type === 'del') buf += m.text;
    // ins markers in range are dropped — chars were inserted pending,
    // and being part of a deletion undoes that insertion.
    i = m.to;
  }
  if (i < eTA) buf += beforeDoc.slice(i, eTA);
  return buf;
}

/** Marker whose `to` is exactly `pos`, of the given type and author. */
function markerEndingAt(beforeDoc, pos, type, author) {
  if (pos === 0) return null;
  if (beforeDoc[pos - 1] !== TC_END) return null;
  const start = beforeDoc.lastIndexOf(TC_START, pos - 1);
  if (start < 0) return null;
  const m = parseAt(beforeDoc, start);
  if (!m || m.to !== pos) return null;
  if (m.type !== type) return null;
  if (m.author !== author) return null;
  return m;
}

/** Marker whose `from` is exactly `pos`, of the given type and author. */
function markerStartingAt(beforeDoc, pos, type, author) {
  if (beforeDoc[pos] !== TC_START) return null;
  const m = parseAt(beforeDoc, pos);
  if (!m || m.from !== pos) return null;
  if (m.type !== type) return null;
  if (m.author !== author) return null;
  return m;
}

/**
 * Normalize a user change against the current marker set.
 *
 * @param {object} args
 * @param {string} args.beforeDoc - Document text before the change.
 * @param {Array} args.markers - parseAll(beforeDoc) result.
 * @param {number} args.fromA - Change range start.
 * @param {number} args.toA - Change range end.
 * @param {string} args.insertText - Text being inserted.
 * @param {boolean} args.tcOn - Whether track-changes mode is ON.
 * @param {string} args.author - Current user's author string.
 * @returns {{changes: Array<{from:number, to:number, insert:string}>, cursor: number}}
 */
export function normalizeChange({ beforeDoc, markers, fromA, toA, insertText, tcOn, author }) {
  // (No foreign-marker reject. Collaborative TC needs the editing user
  // to be able to delete or modify text that a colleague inserted; the
  // authorship of resulting markers collapses to the current user but
  // at least the edit isn't blocked outright. Any time `author` shifts
  // — name change, switch between users — past markers also count as
  // "foreign," so a hard reject would freeze the user out of their own
  // history.)

  // ── Phase -0.5: clamp ranges that land on a marker boundary. ──────
  // CM atomic ranges produce specific shapes that look like they
  // overlap the marker but really shouldn't:
  //   - Backspace at cursor=m.textFrom yields [m.from, m.textFrom)
  //     (atomic-extends the deletion into the metadata only).
  //   - A selection ending at the marker's left boundary lands toA
  //     at m.textFrom or m.from.
  //   - Symmetric on the right boundary (toA = m.to or m.textTo).
  //   - A space typed before/after a marker can come in with the
  //     selection's toA/fromA on the marker's boundary.
  // Without clamping, Phase 1 would expand the range to fully cover
  // the marker and Phase 2's oldVisible would drop its content —
  // collapsing the marker into the user's edit. We clamp so the
  // range stays OUTSIDE the marker; Phase 3's merge step will then
  // absorb the marker as an adjacent same-author candidate when
  // appropriate (typing) or leave it alone (deleting plain chars
  // before/after).
  //
  // Special case: pure backspace at m.from (atomic-extended target
  // [m.from, m.textFrom)). After clamping toA to m.from the range
  // becomes empty; rewrite as "delete the char BEFORE the marker"
  // or no-op if the marker is at position 0.
  for (const m of markers) {
    // INS markers only — the user's intent at an ins boundary is to
    // edit AROUND the inserted run, leaving it intact. For del
    // markers the opposite semantic applies: absorbing the marker
    // (and dropping it on TC-off, or wrapping its text in a new del
    // on TC-on) is correct, so we leave Phase 1 expansion to handle
    // them.
    if (m.type !== 'ins') continue;
    if ((toA === m.from || toA === m.textFrom) && fromA <= m.from) {
      if (fromA === m.from && insertText.length === 0) {
        if (m.from === 0) return { changes: [], cursor: m.from };
        fromA = m.from - 1;
        toA = m.from;
      } else {
        toA = m.from;
      }
      break;
    }
    if ((fromA === m.to || fromA === m.textTo) && toA >= m.to) {
      fromA = m.to;
      break;
    }
  }

  // ── Phase 0: edit fully inside user's own ins marker. ──────────────
  // With TC ON: reserialize the marker in place — the new chars are
  // part of the same tracked insertion (extends the marker's text).
  // With TC OFF: SPLIT the marker around the edit so the new chars
  // (insertText) end up as PLAIN, untracked text. The user explicitly
  // turned tracking off; their new typing shouldn't be marked as
  // inserted just because the caret happens to sit inside a previous
  // pending insertion. Either branch keeps the length-prefixed header
  // consistent — the marker(s) emitted always have valid headers.
  for (const m of markers) {
    if (m.type !== 'ins' || m.author !== author) continue;
    if (fromA < m.textFrom || toA > m.textTo) continue;
    const offset = fromA - m.textFrom;
    const len = toA - fromA;
    const beforeText = m.text.slice(0, offset);
    const afterText = m.text.slice(offset + len);
    if (tcOn || insertText.length === 0) {
      // Reserialize in place. TC ON: grows / shrinks the marker as
      // part of the tracked edit. TC OFF + pure deletion: shrinks
      // (no new content to keep untracked, so no need to split).
      const newText = beforeText + insertText + afterText;
      if (!newText) {
        return { changes: [{ from: m.from, to: m.to, insert: '' }], cursor: m.from };
      }
      const replacement = serialize({
        type: 'ins',
        id: m.id || shortId(),
        author: m.author,
        text: newText,
      });
      const newHeaderLen = replacement.length - newText.length - 1;
      return {
        changes: [{ from: m.from, to: m.to, insert: replacement }],
        cursor: m.from + newHeaderLen + offset + insertText.length,
      };
    }
    // TC OFF + insertion/replacement — split.
    let replacement = '';
    let beforeMarkerLen = 0;
    if (beforeText) {
      const before = serialize({
        type: 'ins',
        id: m.id || shortId(),
        author: m.author,
        text: beforeText,
      });
      replacement += before;
      beforeMarkerLen = before.length;
    }
    replacement += insertText;
    if (afterText) {
      replacement += serialize({
        type: 'ins',
        id: shortId(),
        author: m.author,
        text: afterText,
      });
    }
    return {
      changes: [{ from: m.from, to: m.to, insert: replacement }],
      cursor: m.from + beforeMarkerLen + insertText.length,
    };
  }

  // ── Phase 0b: pure deletion at the right edge of an ins marker. ──
  // CM's atomic-range handling extends a backspace-at-m.to to span
  // [m.textTo, m.to) — just the closing sentinel. The user's intent
  // is to remove ONE visible char from the end of the pending
  // insertion, not to absorb the whole marker. Without this branch
  // Phase 1 would expand the range to fully cover m and Phase 2's
  // oldVisible would drop its text entirely (any ins → undone in
  // visible content), so a single backspace at the right edge would
  // erase the entire word in one press. Applies to ANY author's
  // ins so a collaborator can also shrink an inserted run one char
  // at a time. The marker's original id + author are preserved.
  if (insertText.length === 0) {
    for (const m of markers) {
      if (m.type !== 'ins') continue;
      if (toA !== m.to) continue;
      if (fromA < m.from) continue;
      let dropCount;
      if (fromA >= m.textTo) {
        dropCount = 1;
      } else {
        dropCount = m.textTo - Math.max(fromA, m.textFrom);
      }
      const newText = m.text.slice(0, m.text.length - dropCount);
      if (!newText) {
        return { changes: [{ from: m.from, to: m.to, insert: '' }], cursor: m.from };
      }
      const replacement = serialize({
        type: 'ins',
        id: m.id || shortId(),
        author: m.author,
        text: newText,
      });
      return {
        changes: [{ from: m.from, to: m.to, insert: replacement }],
        cursor: m.from + replacement.length,
      };
    }
  }

  // ── Phase 1: expand range to cover any overlapping markers. ────────
  let efA = fromA;
  let eTA = toA;
  let stable = false;
  while (!stable) {
    stable = true;
    for (const m of markers) {
      if (m.from < eTA && m.to > efA) {
        if (m.from < efA) { efA = m.from; stable = false; }
        if (m.to > eTA) { eTA = m.to; stable = false; }
      }
    }
  }

  // ── Phase 2: reconstruct visible old content in the expanded range.
  const oldVisible = reconstructVisible(beforeDoc, efA, eTA, markers);

  // ── Phase 3: merge with adjacent same-author markers. ──────────────
  // For each side, if we're emitting a marker of a given type and
  // there's an adjacent same-author marker of that type, absorb it
  // (extend the range AND prepend/append its text to the new marker).
  let prevInsText = '';
  let nextInsText = '';
  let prevDelText = '';
  let nextDelText = '';
  if (tcOn) {
    if (insertText.length > 0) {
      const prev = markerEndingAt(beforeDoc, efA, 'ins', author);
      if (prev) { prevInsText = prev.text; efA = prev.from; }
      const next = markerStartingAt(beforeDoc, eTA, 'ins', author);
      if (next) { nextInsText = next.text; eTA = next.to; }
    }
    if (oldVisible.length > 0) {
      const prev = markerEndingAt(beforeDoc, efA, 'del', author);
      if (prev) { prevDelText = prev.text; efA = prev.from; }
      const next = markerStartingAt(beforeDoc, eTA, 'del', author);
      if (next) { nextDelText = next.text; eTA = next.to; }
    }
  }

  // ── Phase 4: build the replacement string. ─────────────────────────
  let replacement;
  let insLen = 0;
  if (tcOn) {
    let buf = '';
    if (insertText.length > 0 || prevInsText || nextInsText) {
      const ins = serialize({
        type: 'ins',
        id: shortId(),
        author,
        text: prevInsText + insertText + nextInsText,
      });
      buf += ins;
      insLen = ins.length;
    }
    if (oldVisible.length > 0 || prevDelText || nextDelText) {
      buf += serialize({
        type: 'del',
        id: shortId(),
        author,
        text: prevDelText + oldVisible + nextDelText,
      });
    }
    replacement = buf;
  } else {
    replacement = insertText;
  }

  // ── Phase 5: caret target. ─────────────────────────────────────────
  // Whenever we emit an ins marker the caret has to land just past it
  // — that's the merge point for subsequent typing (prev-marker merge
  // on the LEFT). If we land before or inside the marker, follow-up
  // chars merge via the right-side path and reverse the order. For
  // pure deletions or TC-off plain edits, the caret lands past the
  // inserted plain text (which is `insertText.length` for TC-off, 0
  // for TC-on pure deletion since insertText is empty).
  let cursor;
  if (insLen > 0) {
    cursor = efA + insLen;
  } else {
    cursor = efA + insertText.length;
  }

  return { changes: [{ from: efA, to: eTA, insert: replacement }], cursor };
}
