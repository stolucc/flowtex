// Pure function that turns a user's intended change into a tc-marker-safe
// change spec. The transactionFilter in tcMarkerInput.js is a thin shell
// around this — see normalizeChange's contract and invariants below.
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
  // ── Phase -1: refuse changes that would absorb a foreign marker. ────
  // Crossing into another user's tracked change should be a deliberate
  // accept/reject decision, not a side-effect of an unrelated edit.
  // (`null` is the filter's signal to drop the transaction.)
  for (const m of markers) {
    if (m.author === author) continue;
    if (m.from < toA && m.to > fromA) return null;
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
  // Typing → caret lands just past the new ins so the next keystroke
  // merges. Otherwise → caret lands at the start of the replacement.
  // TC-OFF plain-text → caret lands past the inserted text.
  let cursor;
  if (tcOn && insertText.length > 0 && oldVisible.length === 0) {
    cursor = efA + insLen;
  } else {
    cursor = efA + insertText.length;
  }

  return { changes: [{ from: efA, to: eTA, insert: replacement }], cursor };
}
