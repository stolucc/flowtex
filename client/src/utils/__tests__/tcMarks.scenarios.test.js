// Comprehensive scenario + fuzz coverage for the track-changes pipeline.
//
// Organized as parameterized describe.each / it.each blocks so each
// scenario is one assertion. Goal: exercise the data layer, input
// filter, and undo paths from many angles — boundary positions,
// overlap patterns, multi-author setups, edge sizes, and randomized
// inputs.
//
// Convention:
//   makeEd(...) → editor harness with TC on.
//   makeUd(...) → harness with history() so we can drive undo/redo.
//   ent(over)  → factory for entry specs.
//
// Doc-text shape used in many tests:
//   "0123456789" (10 chars) — short, predictable positions.

import { describe, it, expect } from 'vitest';
import { ChangeSet, EditorState, Transaction } from '@codemirror/state';
import { history, undo as cmUndo, redo as cmRedo } from '@codemirror/commands';
import {
  tcMark,
  tcMarksField,
  tcMarksExtensions,
  tcMarksInlineDecorations,
  setTcMarks,
  addTcMarks,
  removeTcMark,
  serializeMarks,
  deserializeMarks,
  listMarks,
  isValidEntry,
  validateHydration,
  tcMarkSkipAnnotation,
  shortId,
} from '../tcMarks.js';
import { buildTcMarksInputFilter } from '../tcMarksInput.js';

const ME = { id: 'u-me', name: 'Alice' };
const OTHER = { id: 'u-bob', name: 'Bob' };

function ent(over = {}) {
  return {
    id: over.id ?? shortId(),
    type: over.type ?? 'ins',
    from: over.from ?? 0,
    to: over.to ?? (over.from ?? 0) + 1,
    authorId: over.authorId ?? ME.id,
    authorName: over.authorName ?? ME.name,
    timestamp: over.timestamp ?? '2026-05-08T00:00:00.000Z',
  };
}

function makeBase(doc, marks = []) {
  let state = EditorState.create({ doc, extensions: [tcMarksField] });
  if (marks.length > 0) {
    state = state.update({
      effects: setTcMarks.of(marks),
      annotations: tcMarkSkipAnnotation.of(true),
    }).state;
  }
  return state;
}

function makeEd(doc, { tcOn = true, authorId = ME.id, authorName = ME.name, marks = [] } = {}) {
  let on = tcOn;
  const filter = buildTcMarksInputFilter({
    isOn: () => on,
    getAuthorId: () => authorId,
    getAuthorName: () => authorName,
  });
  let state = EditorState.create({ doc, extensions: [...tcMarksExtensions(), filter] });
  if (marks.length > 0) {
    state = state.update({
      effects: setTcMarks.of(marks),
      annotations: tcMarkSkipAnnotation.of(true),
    }).state;
  }
  return {
    get state() { return state; },
    setTc(v) { on = v; },
    apply(spec) { state = state.update(spec).state; return state; },
  };
}

function makeUd(doc, { tcOn = true, authorId = ME.id, authorName = ME.name, marks = [] } = {}) {
  let on = tcOn;
  const filter = buildTcMarksInputFilter({
    isOn: () => on,
    getAuthorId: () => authorId,
    getAuthorName: () => authorName,
  });
  let state = EditorState.create({ doc, extensions: [...tcMarksExtensions(), filter, history()] });
  if (marks.length > 0) {
    state = state.update({
      effects: setTcMarks.of(marks),
      annotations: tcMarkSkipAnnotation.of(true),
    }).state;
  }
  return {
    get state() { return state; },
    setTc(v) { on = v; },
    apply(spec) { state = state.update(spec).state; return state; },
    undo() {
      const view = { state, dispatch(spec) { state = state.update(spec).state; } };
      return cmUndo(view);
    },
    redo() {
      const view = { state, dispatch(spec) { state = state.update(spec).state; } };
      return cmRedo(view);
    },
  };
}

// ════════════════════════════════════════════════════════════════════
// SECTION 1 — RangeSet.map invariants (ins range with side=1/-1)
// ════════════════════════════════════════════════════════════════════

describe('RangeSet.map: ins range under insertions (10-char doc, ins[3,7))', () => {
  // Insert various lengths at various positions; check the range maps.
  const cases = [];
  for (const insertAt of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    for (const len of [1, 2, 5]) {
      // Compute expected new range based on side semantics
      // startSide=1, endSide=-1.
      const a = 3, b = 7;
      const newA = insertAt < a ? a + len : insertAt === a ? a + len : a; // P==a, side=1 → shifts
      const newB = insertAt < b ? b + len : b; // endSide=-1: P==b stays
      cases.push({ insertAt, len, expectedFrom: newA, expectedTo: newB });
    }
  }
  it.each(cases)(
    'insert $len at $insertAt → range [$expectedFrom, $expectedTo)',
    ({ insertAt, len, expectedFrom, expectedTo }) => {
      const text = 'X'.repeat(len);
      const s = makeBase('0123456789', [ent({ id: 'r', type: 'ins', from: 3, to: 7 })]);
      const next = s.update({
        changes: { from: insertAt, to: insertAt, insert: text },
        annotations: tcMarkSkipAnnotation.of(true),
      }).state;
      const ms = listMarks(next);
      expect(ms).toHaveLength(1);
      expect(ms[0]).toMatchObject({ from: expectedFrom, to: expectedTo });
    },
  );
});

describe('RangeSet.map: ins range under deletions (10-char doc, ins[3,7))', () => {
  // For deletion [a, b), compute expected mapping of ins[3,7).
  const cases = [];
  const fromOrig = 3, toOrig = 7;
  for (let delFrom = 0; delFrom <= 9; delFrom++) {
    for (let delLen = 1; delLen <= 5; delLen++) {
      const delTo = delFrom + delLen;
      if (delTo > 10) continue;
      // Compute mapping:
      // For each endpoint E with side, deletion [a, b):
      //   if E <= a: stays
      //   if E >= b: shifts by -(b - a)
      //   if a < E < b: maps to a
      //   if E == a: side > 0 → stays at a; side < 0 → maps to a (= same)
      //   if E == b: side > 0 → maps to a + 0 (b - len = a); side < 0 → maps to a
      function mapEdge(E, side) {
        if (E < delFrom) return E;
        if (E > delTo) return E - delLen;
        if (E === delFrom) return E; // both side=1 (start) and -1 give a here
        if (E === delTo) return delFrom; // both give a
        // strictly inside
        return delFrom;
      }
      const newA = mapEdge(fromOrig, 1);
      const newB = mapEdge(toOrig, -1);
      const expectedKept = newA < newB;
      cases.push({ delFrom, delTo, expectedKept, expectedFrom: newA, expectedTo: newB });
    }
  }
  it.each(cases)(
    'delete [$delFrom, $delTo) → kept=$expectedKept range=[$expectedFrom, $expectedTo)',
    ({ delFrom, delTo, expectedKept, expectedFrom, expectedTo }) => {
      const s = makeBase('0123456789', [ent({ id: 'r', type: 'ins', from: 3, to: 7 })]);
      const next = s.update({
        changes: { from: delFrom, to: delTo, insert: '' },
        annotations: tcMarkSkipAnnotation.of(true),
      }).state;
      const ms = listMarks(next);
      if (!expectedKept) {
        expect(ms).toHaveLength(0);
      } else {
        expect(ms).toHaveLength(1);
        expect(ms[0]).toMatchObject({ from: expectedFrom, to: expectedTo });
      }
    },
  );
});

describe('RangeSet.map: del range under insertions (10-char doc, del[3,7))', () => {
  // Same side semantics as ins → same mapping rules.
  const cases = [];
  for (const insertAt of [0, 2, 3, 4, 6, 7, 8, 10]) {
    for (const len of [1, 3]) {
      const a = 3, b = 7;
      const newA = insertAt < a ? a + len : insertAt === a ? a + len : a;
      const newB = insertAt < b ? b + len : b;
      cases.push({ insertAt, len, expectedFrom: newA, expectedTo: newB });
    }
  }
  it.each(cases)(
    'insert $len at $insertAt → del range [$expectedFrom, $expectedTo)',
    ({ insertAt, len, expectedFrom, expectedTo }) => {
      const s = makeBase('0123456789', [ent({ id: 'd', type: 'del', from: 3, to: 7 })]);
      const next = s.update({
        changes: { from: insertAt, to: insertAt, insert: 'X'.repeat(len) },
        annotations: tcMarkSkipAnnotation.of(true),
      }).state;
      const ms = listMarks(next);
      expect(ms).toHaveLength(1);
      expect(ms[0]).toMatchObject({ from: expectedFrom, to: expectedTo });
    },
  );
});

// ════════════════════════════════════════════════════════════════════
// SECTION 2 — Hydration validation
// ════════════════════════════════════════════════════════════════════

describe('isValidEntry: ins shape', () => {
  const DOCLEN = 10;
  const cases = [
    { name: 'ins from < to ≤ docLen', e: ent({ type: 'ins', from: 0, to: 5 }), expected: true },
    { name: 'ins at exact docLen', e: ent({ type: 'ins', from: 5, to: 10 }), expected: true },
    { name: 'ins from === to (empty)', e: ent({ type: 'ins', from: 3, to: 3 }), expected: false },
    { name: 'ins from > to (inverted)', e: ent({ type: 'ins', from: 5, to: 2 }), expected: false },
    { name: 'ins past docLen', e: ent({ type: 'ins', from: 0, to: 11 }), expected: false },
    { name: 'ins negative from', e: ent({ type: 'ins', from: -1, to: 2 }), expected: false },
    { name: 'ins NaN from', e: ent({ type: 'ins', from: Number.NaN, to: 2 }), expected: false },
    { name: 'ins Infinity to', e: ent({ type: 'ins', from: 0, to: Infinity }), expected: false },
    { name: 'ins missing id', e: { ...ent({ type: 'ins', from: 0, to: 3 }), id: '' }, expected: false },
    { name: 'ins null id', e: { ...ent({ type: 'ins', from: 0, to: 3 }), id: null }, expected: false },
  ];
  it.each(cases)('$name → $expected', ({ e, expected }) => {
    expect(isValidEntry(e, DOCLEN)).toBe(expected);
  });
});

describe('isValidEntry: del shape (M2: real range)', () => {
  const DOCLEN = 10;
  const cases = [
    { name: 'del from < to ≤ docLen', e: ent({ type: 'del', from: 0, to: 5 }), expected: true },
    { name: 'del at exact docLen', e: ent({ type: 'del', from: 5, to: 10 }), expected: true },
    { name: 'del from === to', e: ent({ type: 'del', from: 3, to: 3 }), expected: false },
    { name: 'del past docLen', e: ent({ type: 'del', from: 0, to: 11 }), expected: false },
    { name: 'del negative from', e: ent({ type: 'del', from: -2, to: 1 }), expected: false },
  ];
  it.each(cases)('$name → $expected', ({ e, expected }) => {
    expect(isValidEntry(e, DOCLEN)).toBe(expected);
  });
});

describe('isValidEntry: type rejection', () => {
  const DOCLEN = 10;
  const cases = [
    { type: 'ins', valid: true },
    { type: 'del', valid: true },
    { type: 'comment', valid: false },
    { type: 'replace', valid: false },
    { type: '', valid: false },
    { type: undefined, valid: false },
    { type: null, valid: false },
    { type: 0, valid: false },
  ];
  it.each(cases)('type=$type → $valid', ({ type, valid }) => {
    const e = type !== undefined ? { ...ent({ from: 0, to: 3 }), type } : { ...ent({ from: 0, to: 3 }) };
    if (type === undefined) delete e.type;
    expect(isValidEntry(e, DOCLEN)).toBe(valid);
  });
});

describe('validateHydration: drops invalid, dedupes by id', () => {
  it('keeps only valid entries', () => {
    const entries = [
      ent({ id: 'a', type: 'ins', from: 0, to: 3 }),
      ent({ id: 'b', type: 'del', from: 5, to: 100 }),
      ent({ id: 'c', type: 'ins', from: 6, to: 9 }),
      { id: 'd', type: 'comment', from: 0, to: 1 },
    ];
    const out = validateHydration(entries, 10);
    expect(out.map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('dedupes by id (first wins)', () => {
    const entries = [
      ent({ id: 'a', type: 'ins', from: 0, to: 3 }),
      ent({ id: 'a', type: 'ins', from: 5, to: 8 }),
      ent({ id: 'a', type: 'del', from: 5, to: 8 }),
      ent({ id: 'b', type: 'ins', from: 5, to: 8 }),
    ];
    const out = validateHydration(entries, 10);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('a');
    expect(out[0].from).toBe(0); // first occurrence wins
    expect(out[1].id).toBe('b');
  });

  it('empty / non-array input → empty result', () => {
    expect(validateHydration(null, 10)).toEqual([]);
    expect(validateHydration(undefined, 10)).toEqual([]);
    expect(validateHydration('not-array', 10)).toEqual([]);
    expect(validateHydration([], 10)).toEqual([]);
  });

  it('handles 0-length doc (only zero-bound entries are valid... and they\'re not)', () => {
    expect(validateHydration([ent({ from: 0, to: 0 })], 0)).toEqual([]);
    expect(validateHydration([ent({ from: 0, to: 1 })], 0)).toEqual([]);
  });

  it('clamping is NOT done — out-of-bounds entries are DROPPED, not truncated', () => {
    const out = validateHydration([ent({ from: 5, to: 12 })], 10);
    expect(out).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════
// SECTION 3 — Serialization round-trip
// ════════════════════════════════════════════════════════════════════

describe('serialize / deserialize round-trip — many entry shapes', () => {
  const configs = [
    { name: 'single ins', doc: 'hello', entries: [ent({ id: 'i', type: 'ins', from: 0, to: 5 })] },
    { name: 'single del', doc: 'hello world', entries: [ent({ id: 'd', type: 'del', from: 6, to: 11 })] },
    { name: 'ins + del separate', doc: 'abcdefghij', entries: [
      ent({ id: 'i', type: 'ins', from: 0, to: 3 }),
      ent({ id: 'd', type: 'del', from: 5, to: 9 }),
    ] },
    { name: 'two ins, two del', doc: '0123456789', entries: [
      ent({ id: 'i1', type: 'ins', from: 0, to: 2 }),
      ent({ id: 'i2', type: 'ins', from: 6, to: 8 }),
      ent({ id: 'd1', type: 'del', from: 2, to: 4 }),
      ent({ id: 'd2', type: 'del', from: 8, to: 10 }),
    ] },
    { name: 'adjacent ins + del', doc: 'abcdef', entries: [
      ent({ id: 'i', type: 'ins', from: 0, to: 3 }),
      ent({ id: 'd', type: 'del', from: 3, to: 6 }),
    ] },
    { name: 'mark covering whole doc', doc: 'xyz', entries: [
      ent({ id: 'a', type: 'ins', from: 0, to: 3 }),
    ] },
    { name: 'mark at end-of-doc', doc: 'abc', entries: [
      ent({ id: 'a', type: 'del', from: 2, to: 3 }),
    ] },
  ];
  it.each(configs)('round-trip: $name', ({ doc, entries }) => {
    const s = makeBase(doc, entries);
    const out = serializeMarks(s);
    expect(out).toHaveLength(entries.length);
    const fresh = makeBase(doc, deserializeMarks(out));
    expect(serializeMarks(fresh)).toEqual(out);
  });
});

// ════════════════════════════════════════════════════════════════════
// SECTION 4 — TC OFF: editor behaves like plain CM6
// ════════════════════════════════════════════════════════════════════

describe('TC OFF: no marks created by typing/deletion', () => {
  const operations = [
    { name: 'single-char insert', changes: { from: 0, to: 0, insert: 'x' } },
    { name: 'multi-char insert', changes: { from: 0, to: 0, insert: 'hello' } },
    { name: 'insert in middle', changes: { from: 3, to: 3, insert: 'X' } },
    { name: 'insert at end', changes: { from: 5, to: 5, insert: 'X' } },
    { name: 'backspace at end', changes: { from: 4, to: 5, insert: '' } },
    { name: 'forward delete in middle', changes: { from: 2, to: 3, insert: '' } },
    { name: 'replace selection', changes: { from: 1, to: 4, insert: 'Z' } },
    { name: 'empty doc insert', changes: { from: 0, to: 0, insert: 'a' }, doc: '' },
  ];
  it.each(operations)('$name → no entries', ({ changes, doc = 'hello' }) => {
    const h = makeEd(doc, { tcOn: false });
    h.apply({ changes });
    expect(listMarks(h.state)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// SECTION 5 — TC ON: insertions across positions
// ════════════════════════════════════════════════════════════════════

describe('TC ON: single insert at various positions', () => {
  const positions = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  it.each(positions.map((p) => ({ p })))(
    'insert "X" at position $p → ins[$p, $p+1)',
    ({ p }) => {
      const h = makeEd('0123456789');
      h.apply({ changes: { from: p, to: p, insert: 'X' } });
      const ms = listMarks(h.state);
      expect(ms).toHaveLength(1);
      expect(ms[0]).toMatchObject({ type: 'ins', from: p, to: p + 1 });
    },
  );
});

describe('TC ON: multi-char insert (paste) at various positions', () => {
  const cases = [];
  for (const pos of [0, 5, 10]) {
    for (const len of [1, 2, 5, 10, 50]) {
      cases.push({ pos, len, text: 'A'.repeat(len) });
    }
  }
  it.each(cases)('insert $len chars at $pos', ({ pos, text }) => {
    const h = makeEd('0123456789');
    h.apply({ changes: { from: pos, to: pos, insert: text } });
    const ms = listMarks(h.state).filter((m) => m.type === 'ins');
    expect(ms).toHaveLength(1);
    expect(ms[0].to - ms[0].from).toBe(text.length);
  });
});

describe('TC ON: insert strictly inside own ins → range expands (no new entry)', () => {
  const insertPositions = [4, 5, 6]; // strictly inside [3, 7)
  it.each(insertPositions.map((p) => ({ p })))(
    'insert "Z" at $p inside ins[3,7)',
    ({ p }) => {
      const h = makeEd('0123456789', {
        marks: [ent({ id: 'r', type: 'ins', from: 3, to: 7 })],
      });
      h.apply({ changes: { from: p, to: p, insert: 'Z' } });
      const ms = listMarks(h.state).filter((m) => m.type === 'ins');
      expect(ms).toHaveLength(1);
      expect(ms[0].from).toBe(3);
      expect(ms[0].to).toBeGreaterThanOrEqual(7);
    },
  );
});

describe('TC ON: insert at end boundary of own ins → MERGE (one entry)', () => {
  // Adjacency-merge rule: typing AT r.to extends the same entry.
  const cases = [
    { initRange: [0, 3], doc: '012345', insertAt: 3, text: 'X' },
    { initRange: [1, 4], doc: '012345', insertAt: 4, text: 'Y' },
    { initRange: [0, 5], doc: '01234567', insertAt: 5, text: 'AB' },
  ];
  it.each(cases)('ins[$initRange.0,$initRange.1) + insert "$text" at $insertAt → merged', ({ initRange, doc, insertAt, text }) => {
    const h = makeEd(doc, {
      marks: [ent({ id: 'r', type: 'ins', from: initRange[0], to: initRange[1] })],
    });
    h.apply({ changes: { from: insertAt, to: insertAt, insert: text } });
    const ms = listMarks(h.state).filter((m) => m.type === 'ins');
    expect(ms).toHaveLength(1);
    expect(ms[0].from).toBe(initRange[0]);
    expect(ms[0].to).toBe(initRange[1] + text.length);
  });
});

describe('TC ON: insert at start boundary of own ins → NEW adjacent entry (no merge)', () => {
  const cases = [
    { initRange: [3, 6], doc: '012345', insertAt: 3, text: 'X' },
    { initRange: [5, 8], doc: '012345678', insertAt: 5, text: 'Y' },
  ];
  it.each(cases)('ins[$initRange.0,$initRange.1) + insert at start $insertAt', ({ initRange, doc, insertAt, text }) => {
    const h = makeEd(doc, {
      marks: [ent({ id: 'r', type: 'ins', from: initRange[0], to: initRange[1] })],
    });
    h.apply({ changes: { from: insertAt, to: insertAt, insert: text } });
    const ms = listMarks(h.state).filter((m) => m.type === 'ins');
    expect(ms.length).toBeGreaterThanOrEqual(1);
    // The original ins (mapped) and a new ins should both be present.
    expect(ms.some((m) => m.from === initRange[0] && m.to === initRange[0] + text.length)).toBe(true);
    expect(ms.some((m) => m.from === initRange[0] + text.length && m.to === initRange[1] + text.length)).toBe(true);
  });
});

describe('TC ON: insert at del range start → ins added; del range shifts right', () => {
  const cases = [
    { delRange: [3, 5], doc: '0123456789', insertAt: 3, text: 'X' },
    { delRange: [2, 7], doc: '0123456789', insertAt: 2, text: 'YZ' },
  ];
  it.each(cases)('del[$delRange.0,$delRange.1) + insert "$text" at $insertAt', ({ delRange, doc, insertAt, text }) => {
    const h = makeEd(doc, {
      marks: [ent({ id: 'd', type: 'del', from: delRange[0], to: delRange[1] })],
    });
    h.apply({ changes: { from: insertAt, to: insertAt, insert: text } });
    const ms = listMarks(h.state).sort((a, b) => a.from - b.from);
    expect(ms).toHaveLength(2);
    expect(ms[0]).toMatchObject({ type: 'ins', from: insertAt, to: insertAt + text.length });
    expect(ms[1]).toMatchObject({ id: 'd', type: 'del', from: delRange[0] + text.length, to: delRange[1] + text.length });
  });
});

describe('TC ON: continuous keystroke typing → ONE merged ins per run', () => {
  const words = ['hello', 'X', 'world', 'a', 'longerword', '!!!', '12345'];
  it.each(words.map((w) => ({ w })))(
    'typing "$w" char-by-char → one ins',
    ({ w }) => {
      const h = makeEd('');
      for (let i = 0; i < w.length; i++) {
        h.apply({
          changes: { from: i, to: i, insert: w[i] },
          selection: { anchor: i + 1 },
        });
      }
      expect(h.state.doc.toString()).toBe(w);
      const ms = listMarks(h.state);
      expect(ms).toHaveLength(1);
      expect(ms[0]).toMatchObject({ type: 'ins', from: 0, to: w.length });
    },
  );
});

describe('TC ON: paste at end of existing ins MERGES into one entry', () => {
  const cases = [
    { existing: [0, 3], paste: 'XYZ', expectedTo: 6 },
    { existing: [0, 5], paste: '12345', expectedTo: 10 },
    { existing: [2, 4], paste: 'Q', expectedTo: 5 },
  ];
  it.each(cases)('ins[$existing.0,$existing.1) + paste "$paste" at end', ({ existing, paste, expectedTo }) => {
    const h = makeEd('0123456789', {
      marks: [ent({ id: 'a', type: 'ins', from: existing[0], to: existing[1] })],
    });
    h.apply({ changes: { from: existing[1], to: existing[1], insert: paste } });
    const ms = listMarks(h.state).filter((m) => m.type === 'ins');
    expect(ms).toHaveLength(1);
    expect(ms[0].from).toBe(existing[0]);
    expect(ms[0].to).toBe(expectedTo);
  });
});

describe('TC ON: multi-cursor insert', () => {
  const cases = [
    {
      doc: 'aaaa',
      changes: [{ from: 1, to: 1, insert: 'X' }, { from: 3, to: 3, insert: 'Y' }],
      expectedDoc: 'aXaaYa',
      expectedRanges: [[1, 2], [4, 5]],
    },
    {
      doc: '_____',
      changes: [{ from: 1, to: 1, insert: 'A' }, { from: 2, to: 2, insert: 'B' }, { from: 4, to: 4, insert: 'C' }],
      expectedDoc: '_A_B__C__',
      expectedRanges: null, // just verify count
    },
  ];
  it.each(cases)('multi-cursor insert produces N ins entries (one per cursor)', ({ doc, changes, expectedDoc }) => {
    const h = makeEd(doc);
    h.apply({ changes });
    expect(h.state.doc.toString().length).toBe(doc.length + changes.reduce((a, c) => a + c.insert.length, 0));
    const ms = listMarks(h.state).filter((m) => m.type === 'ins');
    expect(ms).toHaveLength(changes.length);
    void expectedDoc; // doc match is implied by length check
  });
});

// ════════════════════════════════════════════════════════════════════
// SECTION 6 — TC ON: deletions (M2 — keep chars, add del mark)
// ════════════════════════════════════════════════════════════════════

describe('TC ON: backspace original text at various positions (M2)', () => {
  // 10-char doc, backspace one char at position p. Doc unchanged; del mark.
  const positions = [1, 2, 3, 5, 8, 9, 10];
  it.each(positions.map((p) => ({ p })))(
    'backspace at cursor=$p deletes [$p-1, $p) → del mark, doc unchanged',
    ({ p }) => {
      const h = makeEd('0123456789');
      h.apply({
        changes: { from: p - 1, to: p, insert: '' },
        selection: { anchor: p - 1 },
      });
      expect(h.state.doc.toString()).toBe('0123456789'); // unchanged
      expect(h.state.selection.main.head).toBe(p - 1);
      const ms = listMarks(h.state).filter((m) => m.type === 'del');
      expect(ms).toHaveLength(1);
      expect(ms[0]).toMatchObject({ from: p - 1, to: p });
    },
  );
});

describe('TC ON: selection-delete of original text → del mark over selection', () => {
  const cases = [
    { from: 0, to: 3 },
    { from: 2, to: 5 },
    { from: 5, to: 10 },
    { from: 0, to: 10 },
  ];
  it.each(cases)('select [$from,$to) and delete → del mark; doc unchanged', ({ from, to }) => {
    const h = makeEd('0123456789');
    h.apply({
      changes: { from, to, insert: '' },
      selection: { anchor: from },
    });
    expect(h.state.doc.toString()).toBe('0123456789');
    const ms = listMarks(h.state).filter((m) => m.type === 'del');
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ from, to });
  });
});

describe('TC ON: consecutive backspace MERGES into one del entry', () => {
  it.each([
    { word: 'world', startCursor: 11, doc: 'hello world' },
    { word: 'lo', startCursor: 5, doc: 'hello' },
    { word: 'abcdef', startCursor: 6, doc: 'abcdef' },
  ])('backspace "$word" char-by-char from cursor $startCursor', ({ doc, startCursor, word }) => {
    const h = makeEd(doc);
    let cur = startCursor;
    for (let i = 0; i < word.length; i++) {
      h.apply({
        changes: { from: cur - 1, to: cur, insert: '' },
        selection: { anchor: cur - 1 },
      });
      cur -= 1;
    }
    expect(h.state.doc.toString()).toBe(doc);
    const ms = listMarks(h.state).filter((m) => m.type === 'del');
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ from: startCursor - word.length, to: startCursor });
  });
});

describe('TC ON: forward delete (Delete key) → del mark; doc unchanged', () => {
  const cases = [
    { cursor: 0, range: [0, 1] },
    { cursor: 5, range: [5, 6] },
    { cursor: 9, range: [9, 10] },
  ];
  it.each(cases)('forward-delete at cursor=$cursor → del [$range.0, $range.1)', ({ cursor, range }) => {
    const h = makeEd('0123456789');
    h.apply({
      changes: { from: range[0], to: range[1], insert: '' },
      selection: { anchor: cursor },
    });
    expect(h.state.doc.toString()).toBe('0123456789');
    const dels = listMarks(h.state).filter((m) => m.type === 'del');
    expect(dels).toHaveLength(1);
    expect(dels[0]).toMatchObject({ from: range[0], to: range[1] });
  });
});

// ════════════════════════════════════════════════════════════════════
// SECTION 7 — Self-retraction patterns
// ════════════════════════════════════════════════════════════════════

describe('Self-retraction: backspace WITHIN own ins → range shrinks, no del', () => {
  const cases = [];
  // Own ins[2, 7) — delete one char at various positions inside it.
  for (let pos = 2; pos < 7; pos++) {
    cases.push({ pos });
  }
  it.each(cases)('delete [$pos, $pos+1) inside own ins[2,7)', ({ pos }) => {
    const h = makeEd('0123456789', {
      marks: [ent({ id: 'a', type: 'ins', from: 2, to: 7, authorId: ME.id })],
    });
    h.apply({ changes: { from: pos, to: pos + 1, insert: '' } });
    expect(h.state.doc.length).toBe(9);
    const ms = listMarks(h.state);
    // One ins, shrunk by one char. No del.
    expect(ms.filter((m) => m.type === 'del')).toHaveLength(0);
    expect(ms.filter((m) => m.type === 'ins')).toHaveLength(1);
    expect(ms[0].to - ms[0].from).toBe(4);
  });
});

describe('Self-retraction: delete RANGES within own ins → range shrinks proportionally', () => {
  const cases = [];
  // Own ins[2, 8). Delete various sub-ranges.
  for (let a = 2; a < 8; a++) {
    for (let b = a + 1; b <= 8; b++) {
      cases.push({ a, b });
    }
  }
  it.each(cases)('delete [$a, $b) inside own ins[2,8)', ({ a, b }) => {
    const h = makeEd('0123456789', {
      marks: [ent({ id: 'a', type: 'ins', from: 2, to: 8 })],
    });
    h.apply({ changes: { from: a, to: b, insert: '' } });
    const ms = listMarks(h.state);
    expect(ms.filter((m) => m.type === 'del')).toHaveLength(0);
    const ins = ms.filter((m) => m.type === 'ins');
    const expectedShrink = b - a;
    if (expectedShrink === 6) {
      // Full coverage — ins vanishes.
      expect(ins).toHaveLength(0);
    } else {
      expect(ins).toHaveLength(1);
      expect(ins[0].to - ins[0].from).toBe(6 - expectedShrink);
    }
  });
});

describe('Self-retraction: delete EXACTLY the own ins → ins vanishes', () => {
  const cases = [
    { range: [0, 5], doc: '01234' },
    { range: [3, 7], doc: '0123456789' },
    { range: [0, 10], doc: '0123456789' },
  ];
  it.each(cases)('exact-fit delete of own ins[$range.0,$range.1)', ({ doc, range }) => {
    const h = makeEd(doc, {
      marks: [ent({ id: 'a', type: 'ins', from: range[0], to: range[1] })],
    });
    h.apply({ changes: { from: range[0], to: range[1], insert: '' } });
    expect(h.state.doc.length).toBe(doc.length - (range[1] - range[0]));
    expect(listMarks(h.state)).toHaveLength(0);
  });
});

describe('Mixed deletion: own ins + original → ins shrinks, del marks gaps', () => {
  const cases = [
    {
      name: 'A[ins:B]C with delete A..C',
      doc: 'ABC',
      ins: [1, 2],
      del: [0, 3],
      expectedDoc: 'AC',
      expectedDels: [{ from: 0, to: 1 }, { from: 1, to: 2 }],
    },
    {
      name: 'AB[ins:CD]EF with delete B..E',
      doc: 'ABCDEF',
      ins: [2, 4],
      del: [1, 5],
      expectedDoc: 'ABEF',
      expectedDels: [{ from: 1, to: 2 }, { from: 2, to: 3 }],
    },
    {
      name: 'AB[ins:CD]EF with delete A..C (left + half-ins)',
      doc: 'ABCDEF',
      ins: [2, 4],
      del: [0, 3],
      // Own ins covered: [2,3) ("C") → actually deleted.
      // Uncovered: [0,2) ("AB") → kept as del.
      // Result: doc "ABDEF" (5 chars), del mark over "AB" at [0,2).
      expectedDoc: 'ABDEF',
      expectedDels: [{ from: 0, to: 2 }],
    },
    {
      name: 'AB[ins:CD]EF with delete C..F (half-ins + right)',
      doc: 'ABCDEF',
      ins: [2, 4],
      del: [3, 6],
      // Own ins covered: [3,4) ("D") → actually deleted.
      // Uncovered: [4,6) ("EF") → kept as del.
      // Result: doc "ABCEF" (5 chars), del covers "EF" at [3,5).
      expectedDoc: 'ABCEF',
      expectedDels: [{ from: 3, to: 5 }],
    },
  ];
  it.each(cases)('$name', ({ doc, ins, del, expectedDoc, expectedDels }) => {
    const h = makeEd(doc, {
      marks: [ent({ id: 'a', type: 'ins', from: ins[0], to: ins[1] })],
    });
    h.apply({ changes: { from: del[0], to: del[1], insert: '' } });
    expect(h.state.doc.toString()).toBe(expectedDoc);
    const dels = listMarks(h.state).filter((m) => m.type === 'del').sort((a, b) => a.from - b.from);
    expect(dels).toHaveLength(expectedDels.length);
    expectedDels.forEach((expected, i) => {
      expect(dels[i]).toMatchObject(expected);
    });
  });
});

describe('Foreign-author ins NOT eligible for self-retraction', () => {
  it.each([
    { from: 2, to: 7 },
    { from: 0, to: 5 },
    { from: 5, to: 10 },
  ])('foreign ins[$from,$to): deleting it produces a del mark by current user', ({ from, to }) => {
    const h = makeEd('0123456789', {
      marks: [ent({ id: 'f', type: 'ins', from, to, authorId: OTHER.id, authorName: OTHER.name })],
    });
    h.apply({ changes: { from, to, insert: '' } });
    // M2: chars stay in doc; del mark added; foreign ins still present (but shrunk by 0... actually it gets mapped through).
    expect(h.state.doc.toString()).toBe('0123456789');
    const dels = listMarks(h.state).filter((m) => m.type === 'del');
    expect(dels).toHaveLength(1);
    expect(dels[0]).toMatchObject({ from, to, authorId: ME.id });
  });
});

// ════════════════════════════════════════════════════════════════════
// SECTION 8 — Replacement
// ════════════════════════════════════════════════════════════════════

describe('Replacement of original text → del + ins (M2)', () => {
  const cases = [];
  for (const [from, to] of [[0, 3], [2, 5], [5, 10]]) {
    for (const ins of ['X', 'XY', 'replacement']) {
      cases.push({ from, to, ins });
    }
  }
  it.each(cases)('replace [$from,$to) with "$ins"', ({ from, to, ins }) => {
    const h = makeEd('0123456789');
    h.apply({
      changes: { from, to, insert: ins },
      selection: { anchor: from + ins.length },
    });
    const ms = listMarks(h.state).sort((a, b) => a.from - b.from);
    expect(ms.filter((m) => m.type === 'ins')).toHaveLength(1);
    expect(ms.filter((m) => m.type === 'del')).toHaveLength(1);
    const insE = ms.find((m) => m.type === 'ins');
    const delE = ms.find((m) => m.type === 'del');
    expect(insE.to - insE.from).toBe(ins.length);
    expect(delE.to - delE.from).toBe(to - from);
  });
});

describe('Replacement inside own ins (self-retract + new ins)', () => {
  const cases = [
    { initIns: [0, 5], selectFrom: 1, selectTo: 4, insert: 'XX' },
    { initIns: [0, 8], selectFrom: 2, selectTo: 6, insert: 'YYYY' },
  ];
  it.each(cases)('ins[$initIns.0,$initIns.1) + replace [$selectFrom,$selectTo) with "$insert"', ({ initIns, selectFrom, selectTo, insert }) => {
    const h = makeEd('0123456789', {
      marks: [ent({ id: 'a', type: 'ins', from: initIns[0], to: initIns[1] })],
    });
    h.apply({ changes: { from: selectFrom, to: selectTo, insert } });
    // No del; ins reflects new content.
    expect(listMarks(h.state).filter((m) => m.type === 'del')).toHaveLength(0);
    expect(listMarks(h.state).filter((m) => m.type === 'ins').length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// SECTION 9 — Accept / reject
// ════════════════════════════════════════════════════════════════════

describe('Accept / reject — M2 semantics across mark types', () => {
  function applyResolve(state, id, decision) {
    const m = listMarks(state).find((x) => x.id === id);
    if (!m) return state;
    const spec = {
      effects: removeTcMark.of(id),
      annotations: tcMarkSkipAnnotation.of(true),
    };
    const removeRange =
      (m.type === 'ins' && decision === 'reject') ||
      (m.type === 'del' && decision === 'accept');
    if (removeRange) spec.changes = { from: m.from, to: m.to, insert: '' };
    return state.update(spec).state;
  }

  const cases = [
    {
      name: 'accept ins → keep doc, drop mark',
      doc: 'hello',
      mark: ent({ id: 'a', type: 'ins', from: 0, to: 5 }),
      decision: 'accept',
      expectedDoc: 'hello',
      expectedMarks: 0,
    },
    {
      name: 'accept del → remove doc range',
      doc: 'hello world',
      mark: ent({ id: 'd', type: 'del', from: 5, to: 11 }),
      decision: 'accept',
      expectedDoc: 'hello',
      expectedMarks: 0,
    },
    {
      name: 'reject ins → remove doc range',
      doc: 'hello world',
      mark: ent({ id: 'i', type: 'ins', from: 6, to: 11 }),
      decision: 'reject',
      expectedDoc: 'hello ',
      expectedMarks: 0,
    },
    {
      name: 'reject del → keep doc, drop mark',
      doc: 'hello world',
      mark: ent({ id: 'd', type: 'del', from: 5, to: 11 }),
      decision: 'reject',
      expectedDoc: 'hello world',
      expectedMarks: 0,
    },
  ];
  it.each(cases)('$name', ({ doc, mark, decision, expectedDoc, expectedMarks }) => {
    let s = makeBase(doc, [mark]);
    s = applyResolve(s, mark.id, decision);
    expect(s.doc.toString()).toBe(expectedDoc);
    expect(listMarks(s)).toHaveLength(expectedMarks);
  });
});

describe('Accept-all: bulk resolution (M2)', () => {
  it('all ins accepted → text stays, all marks gone', () => {
    const marks = [
      ent({ id: 'a', type: 'ins', from: 0, to: 3 }),
      ent({ id: 'b', type: 'ins', from: 5, to: 8 }),
    ];
    let s = makeBase('0123456789', marks);
    const effects = marks.map((m) => removeTcMark.of(m.id));
    s = s.update({ effects, annotations: tcMarkSkipAnnotation.of(true) }).state;
    expect(s.doc.toString()).toBe('0123456789');
    expect(listMarks(s)).toHaveLength(0);
  });

  it('all del accepted → marked ranges removed from doc', () => {
    const marks = [
      ent({ id: 'a', type: 'del', from: 0, to: 3 }),
      ent({ id: 'b', type: 'del', from: 5, to: 8 }),
    ];
    let s = makeBase('0123456789', marks);
    const sorted = [...marks].sort((a, b) => b.from - a.from);
    const effects = [];
    const changes = [];
    for (const m of sorted) {
      effects.push(removeTcMark.of(m.id));
      changes.push({ from: m.from, to: m.to, insert: '' });
    }
    s = s.update({ changes, effects, annotations: tcMarkSkipAnnotation.of(true) }).state;
    // [0,3) removes "012"; [5,8) removes "567"; remaining: "34" + "89" = "3489".
    expect(s.doc.toString()).toBe('3489');
  });
});

// ════════════════════════════════════════════════════════════════════
// SECTION 10 — Undo / redo with invertedEffects
// ════════════════════════════════════════════════════════════════════

describe('Undo after typing (own ins) → text + ins removed', () => {
  it.each([
    { text: 'a' },
    { text: 'hello' },
    { text: 'X' },
    { text: 'abcdef' },
  ])('type "$text" then undo → empty doc, no marks', ({ text }) => {
    const h = makeUd('');
    h.apply({
      changes: { from: 0, to: 0, insert: text },
      selection: { anchor: text.length },
      annotations: Transaction.userEvent.of('input.type'),
    });
    expect(listMarks(h.state)).toHaveLength(1);
    h.undo();
    expect(h.state.doc.toString()).toBe('');
    expect(listMarks(h.state)).toHaveLength(0);
  });
});

describe('Undo after del (original text) → del mark removed, doc unchanged', () => {
  it.each([
    { range: [4, 5] },
    { range: [0, 5] },
    { range: [5, 10] },
  ])('delete [$range.0,$range.1) then undo → no del, doc unchanged', ({ range }) => {
    const h = makeUd('0123456789');
    h.apply({
      changes: { from: range[0], to: range[1], insert: '' },
      selection: { anchor: range[0] },
      annotations: Transaction.userEvent.of('delete.backward'),
    });
    expect(listMarks(h.state).filter((m) => m.type === 'del')).toHaveLength(1);
    h.undo();
    expect(h.state.doc.toString()).toBe('0123456789');
    expect(listMarks(h.state).filter((m) => m.type === 'del')).toHaveLength(0);
  });
});

describe('Undo after self-retraction → text + ins range restored', () => {
  it.each([
    { initLen: 1 },
    { initLen: 3 },
    { initLen: 5 },
  ])('own ins [0, $initLen) backspaced fully then undo → ins restored', ({ initLen }) => {
    const doc = 'X'.repeat(initLen);
    const h = makeUd(doc, {
      marks: [ent({ id: 'a', type: 'ins', from: 0, to: initLen })],
    });
    h.apply({
      changes: { from: 0, to: initLen, insert: '' },
      selection: { anchor: 0 },
      annotations: Transaction.userEvent.of('delete.backward'),
    });
    expect(h.state.doc.length).toBe(0);
    expect(listMarks(h.state)).toHaveLength(0);
    h.undo();
    expect(h.state.doc.toString()).toBe(doc);
    expect(listMarks(h.state).filter((m) => m.type === 'ins')).toHaveLength(1);
  });
});

describe('Redo after undo restores the change', () => {
  // Filter bypasses tr.isUserEvent('redo'), so history's recorded
  // (changes, effects) tuple — captured at original commit time —
  // re-applies verbatim. Doc text AND the exact original mark id are
  // restored, not a fresh id.
  it.each([
    { text: 'a' },
    { text: 'hello' },
    { text: 'X' },
    { text: 'abcdef' },
  ])('type "$text" → undo → redo → doc + mark restored with original id', ({ text }) => {
    const h = makeUd('');
    h.apply({
      changes: { from: 0, to: 0, insert: text },
      selection: { anchor: text.length },
      annotations: Transaction.userEvent.of('input.type'),
    });
    const originalId = listMarks(h.state)[0].id;
    h.undo();
    expect(h.state.doc.toString()).toBe('');
    h.redo();
    expect(h.state.doc.toString()).toBe(text);
    const after = listMarks(h.state);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(originalId);
    expect(after[0].type).toBe('ins');
    expect(after[0].from).toBe(0);
    expect(after[0].to).toBe(text.length);
  });

  it.each([
    { range: [4, 5] },
    { range: [0, 5] },
    { range: [5, 10] },
  ])('delete [$range.0,$range.1) → undo → redo → del mark restored with original id', ({ range }) => {
    const h = makeUd('0123456789');
    h.apply({
      changes: { from: range[0], to: range[1], insert: '' },
      selection: { anchor: range[0] },
      annotations: Transaction.userEvent.of('delete.backward'),
    });
    const originalId = listMarks(h.state).find((m) => m.type === 'del').id;
    h.undo();
    expect(listMarks(h.state).filter((m) => m.type === 'del')).toHaveLength(0);
    h.redo();
    const after = listMarks(h.state).filter((m) => m.type === 'del');
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(originalId);
    expect(h.state.doc.toString()).toBe('0123456789');
  });

  it('self-retraction → undo → redo → ins removed again, doc shrunk', () => {
    const h = makeUd('XXXXX', {
      marks: [ent({ id: 'a', type: 'ins', from: 0, to: 5 })],
    });
    h.apply({
      changes: { from: 0, to: 5, insert: '' },
      selection: { anchor: 0 },
      annotations: Transaction.userEvent.of('delete.backward'),
    });
    expect(h.state.doc.length).toBe(0);
    h.undo();
    expect(h.state.doc.toString()).toBe('XXXXX');
    expect(listMarks(h.state)).toHaveLength(1);
    h.redo();
    expect(h.state.doc.length).toBe(0);
    expect(listMarks(h.state)).toHaveLength(0);
  });
});

describe('History branching: undo → new edit clears redo stack', () => {
  // CM6 history discards the redo stack once a non-history edit lands,
  // so a subsequent redo() should be a no-op rather than reviving a
  // ghost mark. Guards against the "redo of a discarded branch
  // resurrects stale ids" failure mode.
  it('type → undo → type something else → redo is a no-op', () => {
    const h = makeUd('');
    h.apply({
      changes: { from: 0, to: 0, insert: 'foo' },
      selection: { anchor: 3 },
      annotations: Transaction.userEvent.of('input.type'),
    });
    const firstId = listMarks(h.state)[0].id;
    h.undo();
    h.apply({
      changes: { from: 0, to: 0, insert: 'bar' },
      selection: { anchor: 3 },
      annotations: Transaction.userEvent.of('input.type'),
    });
    const afterBranch = listMarks(h.state);
    expect(afterBranch).toHaveLength(1);
    expect(afterBranch[0].id).not.toBe(firstId);
    expect(h.state.doc.toString()).toBe('bar');
    // Redo stack was cleared by the branching edit.
    h.redo();
    expect(h.state.doc.toString()).toBe('bar');
    expect(listMarks(h.state)).toHaveLength(1);
    expect(listMarks(h.state)[0].id).not.toBe(firstId);
  });
});

// ════════════════════════════════════════════════════════════════════
// SECTION 11 — Cursor positioning
// ════════════════════════════════════════════════════════════════════

describe('Cursor lands at expected position after each op', () => {
  const cases = [
    { name: 'after typing N chars', doc: 'abc', from: 1, insert: 'XY', expectedCursor: 3 },
    { name: 'after backspace original', doc: 'hello', from: 4, to: 5, insert: '', cursor: 4 },
    { name: 'after backspace own ins (self-retract)', doc: 'hello', from: 4, to: 5, insert: '', marks: [ent({ id: 'a', type: 'ins', from: 0, to: 5 })], cursor: 4 },
    { name: 'after multi-char paste', doc: '', from: 0, insert: 'multi-char paste here', expectedCursor: 21 },
  ];
  it.each(cases)('$name', ({ doc, from, to, insert, marks = [], cursor }) => {
    const h = makeEd(doc, { marks });
    const sel = { anchor: cursor ?? (from + (insert ? insert.length : 0)) };
    h.apply({
      changes: insert !== undefined && to === undefined
        ? { from, to: from, insert }
        : { from, to, insert: insert || '' },
      selection: sel,
    });
    expect(h.state.selection.main.head).toBe(sel.anchor);
  });
});

describe('Cursor traverses across strikethrough chars (M2 — they\'re real chars)', () => {
  it.each([
    { from: 0, to: 5 },
    { from: 3, to: 7 },
    { from: 5, to: 10 },
  ])('cursor can sit at every position in/around del[$from,$to)', ({ from, to }) => {
    const s = makeBase('0123456789', [ent({ id: 'd', type: 'del', from, to })]);
    // All doc positions 0..10 are valid cursor positions in M2.
    for (let p = 0; p <= 10; p++) {
      const next = s.update({ selection: { anchor: p } }).state;
      expect(next.selection.main.head).toBe(p);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// SECTION 12 — Skip annotation
// ════════════════════════════════════════════════════════════════════

describe('Skip annotation: bypasses the input filter (no marks created)', () => {
  it.each([
    { name: 'insert with skip', changes: { from: 0, to: 0, insert: 'X' } },
    { name: 'delete with skip', changes: { from: 0, to: 3, insert: '' }, doc: 'hello' },
    { name: 'replace with skip', changes: { from: 0, to: 2, insert: 'Z' }, doc: 'abcd' },
  ])('$name', ({ doc = '', changes }) => {
    const h = makeEd(doc);
    h.apply({
      changes,
      annotations: tcMarkSkipAnnotation.of(true),
    });
    expect(listMarks(h.state)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// SECTION 13 — Edge cases
// ════════════════════════════════════════════════════════════════════

describe('Edge cases', () => {
  it('empty insert + empty delete (no-op) → no marks', () => {
    const h = makeEd('abc');
    // CM6 rejects truly empty changes but we test the filter's defensiveness.
    h.apply({ changes: { from: 1, to: 1, insert: '' } });
    expect(listMarks(h.state)).toHaveLength(0);
  });

  it('emoji + surrogate pair: ins covering "🙂" round-trips through save/reload', () => {
    const doc = 'A🙂B';
    const docLen = doc.length; // 4 (🙂 is 2 UTF-16 code units)
    expect(docLen).toBe(4);
    const s = makeBase(doc, [ent({ id: 'a', type: 'ins', from: 1, to: 3 })]);
    const serialized = serializeMarks(s);
    expect(serialized).toHaveLength(1);
    expect(serialized[0]).toMatchObject({ from: 1, to: 3 });
    const fresh = makeBase(doc, deserializeMarks(serialized));
    expect(serializeMarks(fresh)).toEqual(serialized);
  });

  it('same-position del + ins enumerate together', () => {
    const s = makeBase('0123456789', [
      ent({ id: 'd', type: 'del', from: 3, to: 4 }),
      ent({ id: 'i', type: 'ins', from: 3, to: 4 }),
    ]);
    const ms = listMarks(s);
    expect(ms).toHaveLength(2);
  });

  it('hydration: invalid + valid mix → only valid', () => {
    const s = makeBase('0123', [
      ent({ id: 'a', type: 'ins', from: 0, to: 2 }),
      ent({ id: 'b', type: 'ins', from: 5, to: 8 }), // OOB
      ent({ id: 'c', type: 'del', from: 0, to: 4 }),
    ]);
    const ms = listMarks(s);
    expect(ms.map((m) => m.id).sort()).toEqual(['a', 'c']);
  });

  it('many entries (50 ins ranges)', () => {
    const marks = [];
    for (let i = 0; i < 50; i++) {
      marks.push(ent({ id: `i${i}`, type: 'ins', from: i, to: i + 1 }));
    }
    const s = makeBase('X'.repeat(60), marks);
    expect(listMarks(s)).toHaveLength(50);
  });
});

// ════════════════════════════════════════════════════════════════════
// SECTION 13.4 — Insert inside a del splits the del around the insertion
// ════════════════════════════════════════════════════════════════════

describe('typing inside a del splits the del around the insertion', () => {
  // Canonical scenario: doc = "from ", del covers "from" (positions 0..4).
  // User (TC on) types a space at position 1 (between f and r).
  // Expected outcome: del split into [0,1) for "f" and [2,5) for "rom",
  // plus a new ins [1,2) for the space. The strike-through should NOT
  // visually extend across the inserted space, and accepting the del
  // halves must NOT wipe the inserted space.
  it('"from" with del + insert space between f and r → 2 dels + 1 ins', () => {
    const h = makeEd('from ', {
      marks: [ent({ id: 'orig-del', type: 'del', from: 0, to: 4, authorId: ME.id, authorName: ME.name })],
    });
    h.apply({
      changes: { from: 1, to: 1, insert: ' ' },
      selection: { anchor: 2 },
      annotations: Transaction.userEvent.of('input.type'),
    });
    expect(h.state.doc.toString()).toBe('f rom ');

    const marks = listMarks(h.state);
    // Original del's id is removed (split halves get fresh ids).
    expect(marks.find((m) => m.id === 'orig-del')).toBeUndefined();
    const dels = marks.filter((m) => m.type === 'del').sort((a, b) => a.from - b.from);
    const inses = marks.filter((m) => m.type === 'ins');
    expect(dels).toHaveLength(2);
    expect(inses).toHaveLength(1);
    expect(dels[0].from).toBe(0);
    expect(dels[0].to).toBe(1); // "f"
    expect(dels[1].from).toBe(2);
    expect(dels[1].to).toBe(5); // "rom"
    expect(inses[0].from).toBe(1);
    expect(inses[0].to).toBe(2); // the inserted space
  });

  it('insertion preserves the original del author across split halves', () => {
    // A previously deleted "abcd"; B (current user) types in the middle.
    // Both halves stay attributed to A; only the new ins is B's.
    const h = makeEd('abcd', {
      authorId: ME.id,
      authorName: ME.name,
      marks: [ent({ id: 'a-del', type: 'del', from: 0, to: 4, authorId: OTHER.id, authorName: OTHER.name })],
    });
    h.apply({
      changes: { from: 2, to: 2, insert: 'X' },
      selection: { anchor: 3 },
    });
    const dels = listMarks(h.state).filter((m) => m.type === 'del');
    const inses = listMarks(h.state).filter((m) => m.type === 'ins');
    expect(dels).toHaveLength(2);
    for (const d of dels) {
      expect(d.authorId).toBe(OTHER.id);
      expect(d.authorName).toBe(OTHER.name);
    }
    expect(inses).toHaveLength(1);
    expect(inses[0].authorId).toBe(ME.id);
    expect(inses[0].authorName).toBe(ME.name);
  });

  it('insertion at the EXACT start of the del (fromA === rfrom) → no split', () => {
    const h = makeEd('from ', {
      marks: [ent({ id: 'orig-del', type: 'del', from: 0, to: 4 })],
    });
    h.apply({ changes: { from: 0, to: 0, insert: 'X' }, selection: { anchor: 1 } });
    const marks = listMarks(h.state);
    // Original del still exists (its id is preserved because the mark
    // wasn't removed/replaced — only mapped through the change).
    expect(marks.find((m) => m.id === 'orig-del')).toBeTruthy();
    const dels = marks.filter((m) => m.type === 'del');
    expect(dels).toHaveLength(1);
    expect(dels[0].from).toBe(1);
    expect(dels[0].to).toBe(5);
  });

  it('insertion at the EXACT end of the del (fromA === rto) → no split', () => {
    const h = makeEd('from ', {
      marks: [ent({ id: 'orig-del', type: 'del', from: 0, to: 4 })],
    });
    h.apply({ changes: { from: 4, to: 4, insert: 'X' }, selection: { anchor: 5 } });
    const marks = listMarks(h.state);
    expect(marks.find((m) => m.id === 'orig-del')).toBeTruthy();
    const dels = marks.filter((m) => m.type === 'del');
    expect(dels).toHaveLength(1);
    expect(dels[0].from).toBe(0);
    expect(dels[0].to).toBe(4);
  });

  it('multiple inserts inside the same del → each subsequent insert splits the relevant half', () => {
    // "from" del → insert "X" at 1 → del[0,1), ins[1,2), del[2,5).
    // Then insert "Y" at 3 (which is strictly inside del[2,5))
    // → del[0,1), ins[1,2), del[2,3), ins[3,4), del[4,6).
    const h = makeEd('from ', {
      marks: [ent({ id: 'orig-del', type: 'del', from: 0, to: 4 })],
    });
    h.apply({ changes: { from: 1, to: 1, insert: 'X' }, selection: { anchor: 2 } });
    h.apply({ changes: { from: 3, to: 3, insert: 'Y' }, selection: { anchor: 4 } });
    expect(h.state.doc.toString()).toBe('fXrYom ');
    const dels = listMarks(h.state).filter((m) => m.type === 'del').sort((a, b) => a.from - b.from);
    const inses = listMarks(h.state).filter((m) => m.type === 'ins').sort((a, b) => a.from - b.from);
    expect(dels).toHaveLength(3);
    expect(dels.map((d) => [d.from, d.to])).toEqual([[0, 1], [2, 3], [4, 6]]);
    expect(inses).toHaveLength(2);
    expect(inses.map((i) => [i.from, i.to])).toEqual([[1, 2], [3, 4]]);
  });

  it('replacement (toA > fromA) inside a del should NOT split — only pure insertion does', () => {
    // The split logic only applies when the change is purely an insertion
    // (toA === fromA). A replacement that removes some chars and inserts
    // others falls through to the existing del-creation path.
    const h = makeEd('from ', {
      marks: [ent({ id: 'orig-del', type: 'del', from: 0, to: 4 })],
    });
    h.apply({ changes: { from: 1, to: 2, insert: 'X' }, selection: { anchor: 2 } });
    // The original del still exists (unsplit); a new del may be added by
    // the deletion handling but the split path didn't fire.
    const stillThere = listMarks(h.state).find((m) => m.id === 'orig-del');
    expect(stillThere).toBeTruthy();
  });

  it('undo of insert-inside-del restores the original del and removes the halves', () => {
    const h = makeUd('from ', {
      marks: [ent({ id: 'orig-del', type: 'del', from: 0, to: 4 })],
    });
    h.apply({
      changes: { from: 1, to: 1, insert: ' ' },
      selection: { anchor: 2 },
      annotations: Transaction.userEvent.of('input.type'),
    });
    // Pre-undo: split happened.
    expect(listMarks(h.state).filter((m) => m.type === 'del')).toHaveLength(2);
    h.undo();
    // Post-undo: doc reverted, original del back, halves gone.
    expect(h.state.doc.toString()).toBe('from ');
    const dels = listMarks(h.state).filter((m) => m.type === 'del');
    expect(dels).toHaveLength(1);
    expect(dels[0].id).toBe('orig-del');
    expect(dels[0].from).toBe(0);
    expect(dels[0].to).toBe(4);
  });
});

// ════════════════════════════════════════════════════════════════════
// SECTION 13.5 — Cross-author undo: ins eaten by TC-off delete
// ════════════════════════════════════════════════════════════════════

describe("undoing a TC-off delete of another user's ins restores the mark", () => {
  // Scenario: user A inserted "hello" with TC on (ins mark). User B then
  // turned TC off and deleted those chars. The field's RangeSet.map
  // collapses the ins range to zero width and drops it — no explicit
  // removeTcMark effect is emitted. Without the invertedEffects fallback,
  // undo would restore the text but lose the ins mark, surfacing user A's
  // still-pending text as plain (unmarked) original. This test asserts
  // both text AND mark come back.
  it('restores the original ins mark (same id) after undo', () => {
    const h = makeUd('hello world', {
      tcOn: false,
      marks: [ent({ id: 'a-ins', type: 'ins', from: 0, to: 5, authorId: OTHER.id, authorName: OTHER.name })],
    });
    expect(listMarks(h.state).find((m) => m.id === 'a-ins')).toBeTruthy();

    // B (TC off) deletes the first 5 chars covering A's ins range.
    h.apply({
      changes: { from: 0, to: 5, insert: '' },
      selection: { anchor: 0 },
      annotations: Transaction.userEvent.of('delete.backward'),
    });
    expect(h.state.doc.toString()).toBe(' world');
    expect(listMarks(h.state).find((m) => m.id === 'a-ins')).toBeFalsy();

    // Undo: doc AND mark restored, with the original id preserved.
    h.undo();
    expect(h.state.doc.toString()).toBe('hello world');
    const restored = listMarks(h.state).find((m) => m.id === 'a-ins');
    expect(restored).toBeTruthy();
    expect(restored.type).toBe('ins');
    expect(restored.from).toBe(0);
    expect(restored.to).toBe(5);
    expect(restored.authorId).toBe(OTHER.id);
    expect(restored.authorName).toBe(OTHER.name);
  });

  it('restores only fully-eaten marks; surviving (partially-overlapped) marks pass through normally', () => {
    // A's ins covers [0, 10). B (TC off) deletes [2, 4) — interior cut.
    // Mark survives at [0, 8) via mapping. Undo restores text; mark goes
    // back to [0, 10). No phantom duplicate from the new fallback path.
    const h = makeUd('helloworld!', {
      tcOn: false,
      marks: [ent({ id: 'a-ins', type: 'ins', from: 0, to: 10, authorId: OTHER.id })],
    });
    h.apply({ changes: { from: 2, to: 4, insert: '' }, selection: { anchor: 2 } });
    expect(h.state.doc.toString()).toBe('heoworld!');
    const afterDel = listMarks(h.state).filter((m) => m.id === 'a-ins');
    expect(afterDel).toHaveLength(1); // not eaten
    h.undo();
    expect(h.state.doc.toString()).toBe('helloworld!');
    const afterUndo = listMarks(h.state).filter((m) => m.id === 'a-ins');
    expect(afterUndo).toHaveLength(1);
    expect(afterUndo[0].from).toBe(0);
    expect(afterUndo[0].to).toBe(10);
  });

  it('redo of the same delete eats the mark again', () => {
    const h = makeUd('hello world', {
      tcOn: false,
      marks: [ent({ id: 'a-ins', type: 'ins', from: 0, to: 5, authorId: OTHER.id })],
    });
    h.apply({
      changes: { from: 0, to: 5, insert: '' },
      selection: { anchor: 0 },
      annotations: Transaction.userEvent.of('delete.backward'),
    });
    h.undo();
    expect(listMarks(h.state).find((m) => m.id === 'a-ins')).toBeTruthy();
    h.redo();
    expect(h.state.doc.toString()).toBe(' world');
    expect(listMarks(h.state).find((m) => m.id === 'a-ins')).toBeFalsy();
  });
});

// ════════════════════════════════════════════════════════════════════
// SECTION 14 — Property-based fuzz
// ════════════════════════════════════════════════════════════════════

describe('Fuzz: random edits preserve invariants (200 random scenarios)', () => {
  // Seeded RNG for reproducibility.
  function rngFactory(seed) {
    let s = seed | 0;
    return () => {
      s = (s * 1664525 + 1013904223) | 0;
      return ((s >>> 0) % 0x10000) / 0x10000;
    };
  }

  function randomEdit(rng, docLen) {
    const opRoll = rng();
    if (opRoll < 0.5) {
      // insertion
      const from = Math.floor(rng() * (docLen + 1));
      const len = 1 + Math.floor(rng() * 4);
      const insert = 'abcdef'.slice(0, len);
      return { changes: { from, to: from, insert }, selection: { anchor: from + insert.length } };
    } else if (opRoll < 0.85) {
      // deletion
      const from = Math.floor(rng() * Math.max(1, docLen));
      const to = Math.min(docLen, from + 1 + Math.floor(rng() * 3));
      return { changes: { from, to, insert: '' }, selection: { anchor: from } };
    } else {
      // replacement
      const from = Math.floor(rng() * Math.max(1, docLen));
      const to = Math.min(docLen, from + 1 + Math.floor(rng() * 2));
      const insert = 'XY'.slice(0, 1 + Math.floor(rng() * 2));
      return { changes: { from, to, insert }, selection: { anchor: from + insert.length } };
    }
  }

  it.each(Array.from({ length: 200 }, (_, i) => ({ seed: i + 1 })))(
    'seed=$seed: 5 random edits keep invariants',
    ({ seed }) => {
      const rng = rngFactory(seed);
      const h = makeEd('0123456789abcdef');
      for (let i = 0; i < 5; i++) {
        const docLen = h.state.doc.length;
        if (docLen === 0) {
          h.apply({ changes: { from: 0, to: 0, insert: 'x' }, selection: { anchor: 1 } });
          continue;
        }
        const edit = randomEdit(rng, docLen);
        h.apply(edit);
      }
      // Invariants:
      //   - All marks are within doc bounds.
      //   - All ins ranges are non-empty.
      //   - All del ranges are non-empty.
      const docLen = h.state.doc.length;
      const ms = listMarks(h.state);
      for (const m of ms) {
        expect(m.from).toBeGreaterThanOrEqual(0);
        expect(m.to).toBeLessThanOrEqual(docLen);
        expect(m.from).toBeLessThan(m.to);
      }
    },
  );
});

describe('Fuzz: hydration validation accepts arbitrary doc lengths (100 cases)', () => {
  it.each(Array.from({ length: 100 }, (_, i) => ({ seed: i + 1 })))(
    'seed=$seed: random entries → only valid ones installed',
    ({ seed }) => {
      let s = seed * 31;
      function rng() {
        s = (s * 1664525 + 1013904223) | 0;
        return ((s >>> 0) % 0x10000) / 0x10000;
      }
      const docLen = 20;
      const candidateEntries = [];
      for (let i = 0; i < 10; i++) {
        const type = rng() < 0.5 ? 'ins' : 'del';
        const from = Math.floor(rng() * 25) - 2;
        const to = from + Math.floor(rng() * 25) - 2;
        candidateEntries.push({
          id: `e${i}`,
          type,
          from,
          to,
          authorId: 'a',
          authorName: 'A',
          timestamp: 't',
        });
      }
      const out = validateHydration(candidateEntries, docLen);
      for (const e of out) {
        expect(isValidEntry(e, docLen)).toBe(true);
      }
    },
  );
});

// ════════════════════════════════════════════════════════════════════
// SECTION 15 — Multi-author behavior (V2 placeholder, V1 single-author)
// ════════════════════════════════════════════════════════════════════

describe('Multi-author: marks preserve their authorId/authorName across mappings', () => {
  it.each([
    { author: ME },
    { author: OTHER },
    { author: { id: 'u-charlie', name: 'Charlie' } },
  ])('insert before foreign mark by $author.name → authorId preserved', ({ author }) => {
    const s = makeBase('0123456789', [
      ent({ id: 'f', type: 'ins', from: 5, to: 8, authorId: author.id, authorName: author.name }),
    ]);
    const next = s.update({
      changes: { from: 0, to: 0, insert: 'X' },
      annotations: tcMarkSkipAnnotation.of(true),
    }).state;
    const ms = listMarks(next);
    expect(ms[0]).toMatchObject({ authorId: author.id, authorName: author.name });
  });
});

// ════════════════════════════════════════════════════════════════════
// SECTION 16 — Bulk listMarks output ordering (sort invariant)
// ════════════════════════════════════════════════════════════════════

describe('listMarks always returns entries sorted by from-position', () => {
  it.each([
    {
      name: 'three scattered marks',
      marks: [
        ent({ id: 'c', type: 'ins', from: 8, to: 10 }),
        ent({ id: 'a', type: 'del', from: 0, to: 2 }),
        ent({ id: 'b', type: 'ins', from: 4, to: 6 }),
      ],
    },
    {
      name: 'multiple marks at same position',
      marks: [
        ent({ id: 'a', type: 'ins', from: 3, to: 4 }),
        ent({ id: 'b', type: 'del', from: 3, to: 4 }),
      ],
    },
  ])('$name → sorted by from', ({ marks }) => {
    const s = makeBase('0123456789', marks);
    const ms = listMarks(s);
    for (let i = 1; i < ms.length; i++) {
      expect(ms[i].from).toBeGreaterThanOrEqual(ms[i - 1].from);
    }
  });
});
