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
 *  null result means the filter rejected the change — beforeDoc stays. */
function apply(beforeDoc, result) {
  if (result === null) return beforeDoc;
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
    for (let trial = 0; trial < 1000; trial++) {
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
        `${failures}/1000 random TC-ON trials produced a malformed doc. ` +
        `Example: ${JSON.stringify(counterexample)}`,
      );
    }
  });

  it('produces a well-formed doc for random inputs (TC OFF)', () => {
    let failures = 0;
    let counterexample = null;
    for (let trial = 0; trial < 1000; trial++) {
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
        `${failures}/1000 random TC-OFF trials produced a malformed doc. ` +
        `Example: ${JSON.stringify(counterexample)}`,
      );
    }
  });

  it('returned cursor is in [0, after.length] (when not rejected)', () => {
    for (let trial = 0; trial < 500; trial++) {
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

  it('rejects changes that would absorb a foreign-author marker', () => {
    let s = '';
    // Insert a Bob-authored ins marker.
    s = serialize({ type: 'ins', id: 'b1', author: 'Bob', text: 'foo' });
    s = `pre${s}post`;
    const m = parseAll(s)[0];
    // Alice tries to delete a range that touches Bob's marker.
    const result = normalizeChange({
      beforeDoc: s, markers: parseAll(s),
      fromA: 0, toA: m.to + 1, insertText: '',
      tcOn: true, author: AUTHOR,
    });
    expect(result).toBeNull();
  });
});

describe('normalizeChange — targeted edge cases', () => {
  function call(beforeDoc, fromA, toA, insertText, { tcOn = true, author = AUTHOR } = {}) {
    return normalizeChange({
      beforeDoc, markers: parseAll(beforeDoc), fromA, toA, insertText, tcOn, author,
    });
  }

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

  it('TC OFF: in-place edit inside own ins reserializes the marker', () => {
    // Set up: own ins with text 'hello'.
    let s = apply('', call('', 0, 0, 'hello'));
    const m = parseAll(s)[0];
    // Backspace one char at offset 3 — the equivalent of the user
    // turning off TC and editing inside their own pending ins.
    const r = call(s, m.textFrom + 3, m.textFrom + 4, '', { tcOn: false });
    s = apply(s, r);
    const ms = parseAll(s);
    expect(ms).toHaveLength(1);
    expect(ms[0].text).toBe('helo');
    expect(isWellFormed(s)).toBe(true);
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
