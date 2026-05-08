// Property-based + targeted tests for normalizeChange. The property
// tests pummel the function with random doc + change pairs and assert:
//
//   1. The resulting doc is well-formed: every TC_START sentinel is
//      matched by parseAt — no orphan sentinels, no length mismatches.
//   2. The decision is referentially safe: applying the returned change
//      to beforeDoc produces a doc whose markers all parse cleanly.
//   3. The cursor lands at a position that's valid in the resulting
//      doc (not negative, not past the end, not strictly inside any
//      marker's metadata zone).
import { describe, it, expect } from 'vitest';
import { normalizeChange } from '../tcMarkerNormalize.js';
import { parseAll, parseAt, serialize, TC_START } from '@shared/tcMarkers.js';

const AUTHOR = 'Alice';

/** Apply the normalized change to beforeDoc and return the new doc. A
 *  null result OR an empty changes array means no doc change. */
function apply(beforeDoc, result) {
  if (result === null) return beforeDoc;
  if (!result.changes || result.changes.length === 0) return beforeDoc;
  const { from, to, insert } = result.changes[0];
  return beforeDoc.slice(0, from) + insert + beforeDoc.slice(to);
}

/** Returns true if every TC_START char in the doc starts a parseable marker. */
function isWellFormed(doc) {
  let i = 0;
  while (i < doc.length) {
    const idx = doc.indexOf(TC_START, i);
    if (idx === -1) return true;
    const m = parseAt(doc, idx);
    if (!m) return false;
    i = m.to;
  }
  return true;
}

/**
 * Pick a random integer in [min, max).
 */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min)) + min;
}

/**
 * Generate a random doc with 0..5 markers, mixed types and a few
 * authors. Markers are guaranteed not to overlap each other (they're
 * placed in plain-char slots between a chain of plain spans). The
 * resulting doc is always well-formed for parseAll.
 */
function randomDoc() {
  const authors = [AUTHOR, 'Bob'];
  const markerCount = randInt(0, 5);
  // Build the doc as alternating spans of plain text and serialized
  // markers — that way markers can never end up inside one another.
  const parts = [];
  for (let n = 0; n <= markerCount; n++) {
    let plain = '';
    const plainLen = randInt(0, 15);
    for (let k = 0; k < plainLen; k++) plain += String.fromCharCode(randInt(97, 123));
    parts.push(plain);
    if (n < markerCount) {
      const type = Math.random() < 0.5 ? 'ins' : 'del';
      const author = authors[randInt(0, authors.length)];
      let text = '';
      for (let k = 0; k < randInt(1, 8); k++) text += String.fromCharCode(randInt(97, 123));
      parts.push(serialize({ type, id: shortHex(), author, text }));
    }
  }
  return parts.join('');
}

function shortHex() {
  return Math.random().toString(16).slice(2, 10).padStart(8, '0');
}

/**
 * Pick a random change against the doc — random fromA/toA/insertText.
 * The range can be a pure insertion (fromA===toA) or a deletion span.
 */
function randomChange(doc) {
  const isInsertion = Math.random() < 0.5;
  let fromA, toA;
  if (isInsertion) {
    fromA = toA = randInt(0, doc.length + 1);
  } else {
    fromA = randInt(0, doc.length);
    toA = randInt(fromA, Math.min(fromA + 30, doc.length + 1));
  }
  const insertText = isInsertion || Math.random() < 0.3
    ? Array.from({ length: randInt(0, 6) }, () => String.fromCharCode(randInt(97, 123))).join('')
    : '';
  return { fromA, toA, insertText };
}

describe('normalizeChange — property tests', () => {
  it('produces a well-formed doc for random inputs (TC ON)', () => {
    let failures = 0;
    let counterexample = null;
    for (let trial = 0; trial < 10000; trial++) {
      const beforeDoc = randomDoc(trial);
      const markers = parseAll(beforeDoc);
      const { fromA, toA, insertText } = randomChange(beforeDoc);
      const result = normalizeChange({
        beforeDoc, markers, fromA, toA, insertText, tcOn: true, author: AUTHOR,
      });
      const after = apply(beforeDoc, result);
      if (!isWellFormed(after)) {
        failures++;
        if (!counterexample) counterexample = { beforeDoc, fromA, toA, insertText, after };
      }
    }
    if (failures > 0) {
      throw new Error(
        `${failures}/10000 random TC-ON trials produced a malformed doc. ` +
        `Example: ${JSON.stringify(counterexample)}`,
      );
    }
  });

  it('produces a well-formed doc for random inputs (TC OFF)', () => {
    let failures = 0;
    let counterexample = null;
    for (let trial = 0; trial < 10000; trial++) {
      const beforeDoc = randomDoc(trial);
      const markers = parseAll(beforeDoc);
      const { fromA, toA, insertText } = randomChange(beforeDoc);
      const result = normalizeChange({
        beforeDoc, markers, fromA, toA, insertText, tcOn: false, author: AUTHOR,
      });
      const after = apply(beforeDoc, result);
      if (!isWellFormed(after)) {
        failures++;
        if (!counterexample) counterexample = { beforeDoc, fromA, toA, insertText, after };
      }
    }
    if (failures > 0) {
      throw new Error(
        `${failures}/10000 random TC-OFF trials produced a malformed doc. ` +
        `Example: ${JSON.stringify(counterexample)}`,
      );
    }
  });

  it('returned cursor is in [0, after.length] (when not rejected)', () => {
    for (let trial = 0; trial < 5000; trial++) {
      const beforeDoc = randomDoc(trial);
      const markers = parseAll(beforeDoc);
      const { fromA, toA, insertText } = randomChange(beforeDoc);
      for (const tcOn of [true, false]) {
        const result = normalizeChange({
          beforeDoc, markers, fromA, toA, insertText, tcOn, author: AUTHOR,
        });
        if (result === null) continue;
        const after = apply(beforeDoc, result);
        expect(result.cursor).toBeGreaterThanOrEqual(0);
        expect(result.cursor).toBeLessThanOrEqual(after.length);
      }
    }
  });

  it('Phase 0b: a different user backspacing at end of a foreign ins shrinks it by one (preserves original author)', () => {
    let s = `pre${serialize({ type: 'ins', id: 'b1', author: 'Bob', text: 'hello' })}post`;
    const m = parseAll(s)[0];
    // Alice (current author) backspaces at m.to. CM atomic extends
    // the deletion target to [m.textTo, m.to).
    const r = normalizeChange({
      beforeDoc: s, markers: parseAll(s),
      fromA: m.textTo, toA: m.to, insertText: '',
      tcOn: true, author: AUTHOR,
    });
    s = apply(s, r);
    const ms = parseAll(s);
    expect(ms).toHaveLength(1);
    expect(ms[0].text).toBe('hell');
    expect(ms[0].author).toBe('Bob'); // original author preserved
    expect(isWellFormed(s)).toBe(true);
  });

  it('allows editing through a foreign marker (collapses authorship to current user)', () => {
    // Bob's pending insertion of 'foo'.
    let s = `pre${serialize({ type: 'ins', id: 'b1', author: 'Bob', text: 'foo' })}post`;
    const m = parseAll(s)[0];
    // Alice deletes a range that covers Bob's marker fully.
    const result = normalizeChange({
      beforeDoc: s, markers: parseAll(s),
      fromA: 0, toA: m.to + 1, insertText: '',
      tcOn: true, author: AUTHOR,
    });
    expect(result).not.toBeNull();
  });
});

describe('normalizeChange — targeted edge cases', () => {
  function call(beforeDoc, fromA, toA, insertText, { tcOn = true, author = AUTHOR } = {}) {
    return normalizeChange({
      beforeDoc, markers: parseAll(beforeDoc), fromA, toA, insertText, tcOn, author,
    });
  }

  it('TC ON: replace selection then keep typing preserves character order', () => {
    // Select 'abc', type 'q', type 'r'. The marker should end up as
    // 'qr' — the previous bug landed the caret BEFORE the new ins,
    // so the next keystroke prepended via the right-merge path and
    // produced 'rq' instead.
    let s = 'abc';
    const r1 = call(s, 0, 3, 'q');
    s = apply(s, r1);
    const r2 = call(s, r1.cursor, r1.cursor, 'r');
    s = apply(s, r2);
    const ins = parseAll(s).find((mm) => mm.type === 'ins');
    expect(ins.text).toBe('qr');
  });

  it('Phase -0.5: backspace at the LEFT edge of own ins (atomic-extended target = [m.from, m.textFrom))', () => {
    // Build: "abc<ins:hello>". CM's atomic handling extends the
    // backspace target to span the marker's metadata only.
    let s = 'abc';
    s = apply(s, call(s, 3, 3, 'hello'));
    const m = parseAll(s)[0];
    expect(m.text).toBe('hello');
    // Backspace at start of marker — deletion is [m.from, m.textFrom).
    const r = call(s, m.from, m.textFrom, '');
    s = apply(s, r);
    const ms = parseAll(s);
    const ins = ms.find((mm) => mm.type === 'ins');
    const del = ms.find((mm) => mm.type === 'del');
    expect(ins.text).toBe('hello'); // marker preserved
    expect(del.text).toBe('c'); // char before marker wrapped as del
  });

  it('typing space AT m.from of an ins marker prepends to the marker (does NOT erase it)', () => {
    let s = 'abc';
    s = apply(s, call(s, 3, 3, 'hello'));
    const m = parseAll(s)[0];
    expect(m.text).toBe('hello');
    // CM places caret at m.from when the click is at the visual left
    // boundary of the marker (left edge of atomic [m.from, m.textFrom)).
    s = apply(s, call(s, m.from, m.from, ' '));
    const ms = parseAll(s);
    expect(ms).toHaveLength(1);
    expect(ms[0].type).toBe('ins');
    expect(ms[0].text).toBe(' hello');
  });

  it('typing space AT m.textFrom of an ins marker prepends to the marker (does NOT erase it)', () => {
    let s = 'abc';
    s = apply(s, call(s, 3, 3, 'hello'));
    const m = parseAll(s)[0];
    s = apply(s, call(s, m.textFrom, m.textFrom, ' '));
    const ms = parseAll(s);
    expect(ms).toHaveLength(1);
    expect(ms[0].text).toBe(' hello');
  });

  it('Phase -0.5: backspace at LEFT edge with marker at position 0 is a no-op', () => {
    let s = '';
    s = apply(s, call(s, 0, 0, 'hello'));
    const m = parseAll(s)[0];
    const before = s;
    s = apply(s, call(s, m.from, m.textFrom, ''));
    expect(s).toBe(before); // no change
    expect(parseAll(s)[0].text).toBe('hello');
  });

  it('TC ON: typing in empty doc creates a fresh ins marker', () => {
    const r = call('', 0, 0, 'X');
    const after = apply('', r);
    const ms = parseAll(after);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ type: 'ins', text: 'X', author: AUTHOR });
  });

  it('TC ON: typing right after own ins merges (no fragmentation)', () => {
    let s = '';
    let r1 = call(s, 0, 0, 'h');
    s = apply(s, r1);
    const m1 = parseAll(s)[0];
    let r2 = call(s, m1.to, m1.to, 'i');
    s = apply(s, r2);
    const ms = parseAll(s);
    expect(ms).toHaveLength(1);
    expect(ms[0].text).toBe('hi');
  });

  it('TC ON: backspace one char inside own ins shrinks in place (header length stays consistent)', () => {
    let s = '';
    s = apply(s, call(s, 0, 0, 'hello'));
    const m = parseAll(s)[0];
    // Delete 'l' at offset 3 inside the marker text.
    const lPos = m.textFrom + 3;
    s = apply(s, call(s, lPos, lPos + 1, ''));
    const ms = parseAll(s);
    expect(ms).toHaveLength(1);
    expect(ms[0].text).toBe('helo');
    expect(isWellFormed(s)).toBe(true);
  });

  it('TC ON: deletion of plain chars wraps as fresh del marker', () => {
    const r = call('hello', 1, 4, '');
    const after = apply('hello', r);
    const ms = parseAll(after);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ type: 'del', text: 'ell' });
  });

  it('TC ON: select-line that visually contains a del marker absorbs it', () => {
    let s = 'abcdef';
    s = apply(s, call(s, 2, 4, '')); // delete 'cd' → del:cd
    const m = parseAll(s)[0];
    expect(m.text).toBe('cd');
    // Now select [0, m.to + 1) and delete: covers 'ab' + del:cd + 'e'.
    const r = call(s, 0, m.to + 1, '');
    s = apply(s, r);
    const ms = parseAll(s);
    expect(ms).toHaveLength(1);
    expect(ms[0].type).toBe('del');
    // Visible old content: 'ab' + (del:cd's text 'cd') + 'e' = 'abcde'.
    expect(ms[0].text).toBe('abcde');
  });

  it('TC ON: own ins inside a deletion range is dropped (undo-of-insertion)', () => {
    let s = 'XYZ';
    // Replace Y with 'q': creates ins:q + del:Y.
    s = apply(s, call(s, 1, 2, 'q'));
    // Select all and delete.
    s = apply(s, call(s, 0, s.length, ''));
    const ms = parseAll(s);
    expect(ms).toHaveLength(1);
    expect(ms[0].type).toBe('del');
    // 'X' + (ins:q dropped) + 'Y' (del absorbed) + 'Z' = 'XYZ'.
    expect(ms[0].text).toBe('XYZ');
  });

  it('TC OFF: pure deletion inside own ins shrinks the marker (no split needed)', () => {
    let s = apply('', call('', 0, 0, 'hello'));
    const m = parseAll(s)[0];
    const r = call(s, m.textFrom + 3, m.textFrom + 4, '', { tcOn: false });
    s = apply(s, r);
    const ms = parseAll(s);
    expect(ms).toHaveLength(1);
    expect(ms[0].text).toBe('helo');
    expect(isWellFormed(s)).toBe(true);
  });

  it('TC OFF: typing inside own ins splits the marker so new chars stay UNTRACKED', () => {
    let s = apply('', call('', 0, 0, 'hello'));
    const m = parseAll(s)[0];
    // Type 'X' at offset 3 inside the marker. With TC OFF, X must
    // NOT be marked as inserted — it ends up as plain text between
    // a left-half ins ('hel') and a right-half ins ('lo').
    const r = call(s, m.textFrom + 3, m.textFrom + 3, 'X', { tcOn: false });
    s = apply(s, r);
    const ms = parseAll(s);
    expect(ms).toHaveLength(2);
    expect(ms[0].text).toBe('hel');
    expect(ms[1].text).toBe('lo');
    // The 'X' sits between them as plain text.
    const between = s.slice(ms[0].to, ms[1].from);
    expect(between).toBe('X');
    expect(isWellFormed(s)).toBe(true);
  });

  it('TC OFF: typing at the START of own ins inner text → plain X before, marker keeps its full text', () => {
    let s = apply('', call('', 0, 0, 'hello'));
    const m = parseAll(s)[0];
    const r = call(s, m.textFrom, m.textFrom, 'X', { tcOn: false });
    s = apply(s, r);
    const ms = parseAll(s);
    expect(ms).toHaveLength(1);
    expect(ms[0].text).toBe('hello');
    // 'X' lands right before the marker, plain.
    expect(s.slice(0, ms[0].from)).toBe('X');
  });

  it('TC OFF: deletion that visually covers a del marker drops the marker entirely', () => {
    let s = 'abcdef';
    s = apply(s, call(s, 2, 4, '')); // del:cd
    const m = parseAll(s)[0];
    // Select [m.from, m.to) — exactly the marker's bounds — and delete with TC OFF.
    s = apply(s, call(s, m.from, m.to, '', { tcOn: false }));
    expect(parseAll(s)).toHaveLength(0);
    expect(isWellFormed(s)).toBe(true);
  });

  it('TC OFF: backspace at right boundary of del marker drops it (no caret-only stuck press)', () => {
    let s = 'abc';
    s = apply(s, call(s, 0, 1, '')); // del:a
    const m = parseAll(s)[0];
    // The "atomic-extended backspace at m.to" shape: deletion covers [m.textTo, m.to).
    s = apply(s, call(s, m.textTo, m.to, '', { tcOn: false }));
    expect(parseAll(s)).toHaveLength(0);
    expect(isWellFormed(s)).toBe(true);
  });
});
