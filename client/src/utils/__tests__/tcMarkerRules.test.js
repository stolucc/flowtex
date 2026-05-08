// Rules-as-tests for the tracked-change editor.
//
// Each test below pins ONE rule of the behavior contract — the rules
// match the conventions Google Docs / MS Word / Overleaf converge on
// for collaborative tracked-change editing. The rule names read like
// short user stories so a reviewer can scan them without reading code.
//
// When someone reports "but X behaves wrong," the right response is:
//   1. Find the rule it violates here. If absent, add it (under the
//      right category).
//   2. Add a test that pins the desired behavior.
//   3. Adjust normalizeChange until the test passes.
//
// The tests use the helper `apply()` to play out a sequence of
// CM-shaped edits. Cursor positions match what CM's atomic-aware
// commands produce — see the H1/H2 traces in earlier sessions for
// why backspace at an ins marker boundary lands [m.from, m.textFrom)
// rather than [m.from - 1, m.textFrom).
import { describe, it, expect } from 'vitest';
import { normalizeChange } from '../tcMarkerNormalize.js';
import { parseAll, serialize } from '@shared/tcMarkers.js';

const ME = 'Alice';
const OTHER = 'Bob';

function call(beforeDoc, fromA, toA, insertText, { tcOn = true, author = ME } = {}) {
  return normalizeChange({
    beforeDoc, markers: parseAll(beforeDoc), fromA, toA, insertText, tcOn, author,
  });
}
function apply(beforeDoc, result) {
  if (!result || !result.changes || result.changes.length === 0) return beforeDoc;
  const { from, to, insert } = result.changes[0];
  return beforeDoc.slice(0, from) + insert + beforeDoc.slice(to);
}
function only(s) { return parseAll(s)[0]; }

// ─────────────────────────────────────────────────────────────────
// CATEGORY A — typing creates and grows pending insertions (TC ON)
// ─────────────────────────────────────────────────────────────────
describe('A. Typing (TC ON) creates and grows pending insertions', () => {
  it('A1: typing in an empty doc creates a fresh ins marker', () => {
    const s = apply('', call('', 0, 0, 'X'));
    expect(only(s)).toMatchObject({ type: 'ins', text: 'X', author: ME });
  });

  it('A2: consecutive keystrokes after typing merge into one growing ins', () => {
    let s = apply('', call('', 0, 0, 'h'));
    const r = call(s, only(s).to, only(s).to, 'i');
    s = apply(s, r);
    expect(parseAll(s)).toHaveLength(1);
    expect(only(s).text).toBe('hi');
  });

  it('A3: typing at the END of own ins (m.to) extends the marker', () => {
    let s = apply('', call('', 0, 0, 'hello'));
    const m = only(s);
    s = apply(s, call(s, m.to, m.to, '!'));
    expect(only(s).text).toBe('hello!');
  });

  it('A4: typing at the START of own ins (m.from) prepends to the marker', () => {
    let s = apply('abc', call('abc', 3, 3, 'hello'));
    const m = only(s);
    s = apply(s, call(s, m.from, m.from, ' '));
    expect(only(s).text).toBe(' hello');
  });

  it('A5: typing at m.textFrom of own ins also prepends (visual same spot as m.from)', () => {
    let s = apply('abc', call('abc', 3, 3, 'hello'));
    const m = only(s);
    s = apply(s, call(s, m.textFrom, m.textFrom, ' '));
    expect(only(s).text).toBe(' hello');
  });

  it('A6: typing strictly inside own ins inner text grows the marker in place', () => {
    let s = apply('', call('', 0, 0, 'hello'));
    const m = only(s);
    s = apply(s, call(s, m.textFrom + 2, m.textFrom + 2, 'X'));
    expect(only(s).text).toBe('heXllo');
  });

  it('A7: typing OUTSIDE any marker creates a fresh ins (no destructive merge)', () => {
    const s = apply('hello world', call('hello world', 6, 6, 'X'));
    const ms = parseAll(s);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ type: 'ins', text: 'X' });
  });

  it('A8: replacement (select + type) emits ins followed by del', () => {
    const s = apply('abc', call('abc', 0, 3, 'q'));
    const ms = parseAll(s);
    expect(ms).toHaveLength(2);
    expect(ms.find((m) => m.type === 'ins').text).toBe('q');
    expect(ms.find((m) => m.type === 'del').text).toBe('abc');
  });

  it('A9: replacement followed by more typing preserves character ORDER (qr, not rq)', () => {
    let s = 'abc';
    const r1 = call(s, 0, 3, 'q');
    s = apply(s, r1);
    const r2 = call(s, r1.cursor, r1.cursor, 'r');
    s = apply(s, r2);
    const ins = parseAll(s).find((m) => m.type === 'ins');
    expect(ins.text).toBe('qr');
  });
});

// ─────────────────────────────────────────────────────────────────
// CATEGORY B — backspace shrinks pending insertions (TC ON)
// ─────────────────────────────────────────────────────────────────
describe('B. Backspace (TC ON) shrinks pending insertions', () => {
  it('B1: backspace at END of own ins shrinks by one inner char (atomic-extends to closing sentinel)', () => {
    let s = apply('', call('', 0, 0, 'hi'));
    const m = only(s);
    s = apply(s, call(s, m.textTo, m.to, ''));
    expect(only(s).text).toBe('h');
  });

  it('B2: repeated backspace at the end of an own ins eventually empties it', () => {
    let s = apply('', call('', 0, 0, 'hi'));
    let m = only(s);
    s = apply(s, call(s, m.textTo, m.to, ''));
    m = only(s);
    s = apply(s, call(s, m.textTo, m.to, ''));
    expect(parseAll(s)).toHaveLength(0);
  });

  it('B3: backspace one char strictly inside own ins (Phase 0)', () => {
    let s = apply('', call('', 0, 0, 'hello'));
    const m = only(s);
    s = apply(s, call(s, m.textFrom + 3, m.textFrom + 4, ''));
    expect(only(s).text).toBe('helo');
  });

  it('B4: backspace at START of own ins deletes char BEFORE the marker (marker preserved)', () => {
    let s = apply('abc', call('abc', 3, 3, 'hello'));
    const m = only(s);
    s = apply(s, call(s, m.from, m.textFrom, ''));
    const ms = parseAll(s);
    expect(ms.find((mm) => mm.type === 'ins').text).toBe('hello');
    expect(ms.find((mm) => mm.type === 'del').text).toBe('c');
  });

  it('B5: backspace when an ins is the very first content of the doc is a no-op', () => {
    let s = apply('', call('', 0, 0, 'hi'));
    const m = only(s);
    const before = s;
    s = apply(s, call(s, m.from, m.textFrom, ''));
    expect(s).toBe(before);
  });

  it('B6: backspace at end of FOREIGN ins shrinks by one and preserves the original author', () => {
    const seed = `pre${serialize({ type: 'ins', id: 'b1', author: OTHER, text: 'hello' })}post`;
    const m = only(seed);
    const s = apply(seed, call(seed, m.textTo, m.to, ''));
    const ms = parseAll(s);
    expect(ms).toHaveLength(1);
    expect(ms[0].text).toBe('hell');
    expect(ms[0].author).toBe(OTHER);
  });
});

// ─────────────────────────────────────────────────────────────────
// CATEGORY C — pending deletions (del markers, TC ON)
// ─────────────────────────────────────────────────────────────────
describe('C. Pending deletions (del markers, TC ON)', () => {
  it('C1: deleting plain text wraps it as a fresh del marker', () => {
    const s = apply('hello', call('hello', 1, 4, ''));
    expect(only(s)).toMatchObject({ type: 'del', text: 'ell' });
  });

  it('C2: extending a deletion adjacent to an existing del merges into one del', () => {
    let s = 'abcde';
    s = apply(s, call(s, 1, 2, '')); // del 'b'
    const m = only(s);
    // Now delete 'c' — fromA = m.to (after del marker), toA = m.to + 1.
    s = apply(s, call(s, m.to, m.to + 1, ''));
    const ms = parseAll(s);
    expect(ms).toHaveLength(1);
    expect(ms[0].text).toBe('bc');
  });

  it('C3: a selection that visually contains a del marker absorbs the marker (text is folded into the bigger del)', () => {
    let s = 'abcdef';
    s = apply(s, call(s, 2, 4, '')); // del 'cd'
    const m = only(s);
    s = apply(s, call(s, 0, m.to + 1, ''));
    expect(parseAll(s)).toHaveLength(1);
    expect(only(s).text).toBe('abcde');
  });

  it('C4: a selection that contains an own ins marker drops it (undoes the insertion)', () => {
    let s = 'XYZ';
    s = apply(s, call(s, 1, 2, 'q')); // X<ins:q><del:Y>Z
    s = apply(s, call(s, 0, s.length, ''));
    const ms = parseAll(s);
    expect(ms).toHaveLength(1);
    expect(ms[0].type).toBe('del');
    // Visible old content: X + (q dropped) + Y (absorbed) + Z = 'XYZ'.
    expect(ms[0].text).toBe('XYZ');
  });
});

// ─────────────────────────────────────────────────────────────────
// CATEGORY D — TC OFF preserves markers without re-tracking
// ─────────────────────────────────────────────────────────────────
describe('D. TC OFF preserves markers without re-tracking', () => {
  it('D1: typing strictly inside own ins (TC off) splits the marker so new chars stay UNTRACKED', () => {
    let s = apply('', call('', 0, 0, 'hello'));
    const m = only(s);
    s = apply(s, call(s, m.textFrom + 3, m.textFrom + 3, 'X', { tcOn: false }));
    const ms = parseAll(s);
    expect(ms).toHaveLength(2);
    expect(ms[0].text).toBe('hel');
    expect(ms[1].text).toBe('lo');
    expect(s.slice(ms[0].to, ms[1].from)).toBe('X');
  });

  it('D2: typing at the START of own ins (TC off) places plain text BEFORE the marker', () => {
    let s = apply('', call('', 0, 0, 'hello'));
    const m = only(s);
    s = apply(s, call(s, m.textFrom, m.textFrom, 'X', { tcOn: false }));
    const after = parseAll(s);
    expect(after).toHaveLength(1);
    expect(after[0].text).toBe('hello');
    expect(s.slice(0, after[0].from)).toBe('X');
  });

  it('D3: pure deletion strictly inside own ins (TC off) shrinks it (no split)', () => {
    let s = apply('', call('', 0, 0, 'hello'));
    const m = only(s);
    s = apply(s, call(s, m.textFrom + 3, m.textFrom + 4, '', { tcOn: false }));
    expect(only(s).text).toBe('helo');
  });

  it('D4: backspace at the right boundary of a del marker (TC off) drops the marker', () => {
    let s = 'abc';
    s = apply(s, call(s, 0, 1, '')); // del 'a'
    const m = only(s);
    s = apply(s, call(s, m.textTo, m.to, '', { tcOn: false }));
    expect(parseAll(s)).toHaveLength(0);
  });

  it('D5: a selection that visually covers a del marker (TC off) drops the marker entirely', () => {
    let s = 'abcdef';
    s = apply(s, call(s, 2, 4, '')); // del 'cd'
    const m = only(s);
    s = apply(s, call(s, m.from, m.to, '', { tcOn: false }));
    expect(parseAll(s)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// CATEGORY E — caret placement after edits
// ─────────────────────────────────────────────────────────────────
describe('E. Caret placement', () => {
  it('E1: after typing a fresh char, caret lands at the end of the new ins (merge point)', () => {
    const r = call('', 0, 0, 'X');
    expect(r.cursor).toBe(r.changes[0].insert.length);
  });

  it('E2: after a replacement, caret lands at the end of the new ins so further typing extends it', () => {
    const r = call('abc', 0, 3, 'q');
    // The replacement emits ins:q + del:abc. Caret = end of ins:q.
    expect(r.cursor).toBeGreaterThan(0);
    // Further typing at r.cursor should merge with ins:q.
    const s1 = apply('abc', r);
    const r2 = call(s1, r.cursor, r.cursor, 'r');
    const s2 = apply(s1, r2);
    expect(parseAll(s2).find((m) => m.type === 'ins').text).toBe('qr');
  });

  it('E3: after a pure deletion, caret lands at the START of the new del', () => {
    const r = call('hello', 1, 4, '');
    expect(r.cursor).toBe(r.changes[0].from);
  });
});

// ─────────────────────────────────────────────────────────────────
// CATEGORY F — invariants (corruption never reaches the doc)
// ─────────────────────────────────────────────────────────────────
describe('F. Invariants', () => {
  it('F1: any rewrite produces a doc whose markers all parse cleanly', () => {
    // Sample a variety of scenarios; the property tests in
    // tcMarkerNormalize.test.js cover the random cases at scale.
    const scenarios = [
      ['', 0, 0, 'hello', true],
      ['hello', 1, 4, 'X', true],
      ['hello', 0, 5, '', true],
      ['', 0, 0, '\n', true],
      ['ab', 1, 1, ' ', true],
    ];
    for (const [doc, fromA, toA, insertText, tcOn] of scenarios) {
      const r = call(doc, fromA, toA, insertText, { tcOn });
      const after = apply(doc, r);
      const ms = parseAll(after);
      // parseAll silently skips corrupted markers, so check there are
      // no orphan TC_START sentinels in the final doc.
      let last = 0;
      for (const m of ms) {
        expect(m.from).toBeGreaterThanOrEqual(last);
        last = m.to;
      }
      expect(after.indexOf('\u{e000}', last)).toBe(-1);
    }
  });
});
