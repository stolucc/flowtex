// Track-changes V1 — test suite, growing as each section lands.
//
// Every test corresponds to a row in TRACK-CHANGES-RULES.md §11.
// it.todo placeholders are filled in as each implementation step lands.
//
// ★ items are mandatory before V1 code review (see spec §11).
import { describe, it, expect } from 'vitest';
import { ChangeSet, EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo as cmUndo } from '@codemirror/commands';
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

// ─── Test helpers ───────────────────────────────────────────────────────

const ME = { id: 'u-me', name: 'Alice' };

function makeEntry(over = {}) {
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

function makeStateWithMarks(doc, entries = []) {
  let state = EditorState.create({ doc, extensions: [tcMarksField] });
  if (entries.length > 0) {
    state = state.update({
      effects: setTcMarks.of(entries),
      annotations: tcMarkSkipAnnotation.of(true),
    }).state;
  }
  return state;
}

/**
 * Editor harness with TC ON. Returns { state, setTc, apply } so tests
 * can flip TC on/off mid-sequence (EditorState is immutable, so we
 * close over a mutable `tcOn` ref).
 */
function makeEditorHarness(doc, { tcOn = true, authorId = ME.id, authorName = ME.name, marks = [] } = {}) {
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

describe('TC §1 — Data model + invariants', () => {
  it('§1.3 ★ TcMarkValue side semantics: ins has startSide=1, endSide=-1', () => {
    const v = tcMark({ id: 'x', type: 'ins', authorId: 'a', authorName: 'A', timestamp: 't' });
    expect(v.startSide).toBe(1);
    expect(v.endSide).toBe(-1);
  });

  it('§1.3 ★ TcMarkValue side semantics: del has startSide=1, endSide=-1 (M2 — same as ins)', () => {
    const v = tcMark({ id: 'x', type: 'del', authorId: 'a', authorName: 'A', timestamp: 't' });
    expect(v.startSide).toBe(1);
    expect(v.endSide).toBe(-1);
  });

  it('§1.3 ★ RangeSet.map: insertion at ins START boundary does NOT expand the range', () => {
    // Doc "hello", ins range [1, 4) covering "ell".
    // Insert "X" at position 1 (== from). Expected: range stays [2, 5)
    // (the original chars "ell" are now at 2..4) — new "X" is OUTSIDE.
    const s = makeStateWithMarks('hello', [makeEntry({ id: 'a', from: 1, to: 4 })]);
    const next = s.update({
      changes: { from: 1, to: 1, insert: 'X' },
      annotations: tcMarkSkipAnnotation.of(true),
    }).state;
    expect(next.doc.toString()).toBe('hXello');
    const ms = listMarks(next);
    expect(ms).toHaveLength(1);
    expect(ms[0].from).toBe(2);
    expect(ms[0].to).toBe(5);
  });

  it('§1.3 ★ RangeSet.map: insertion at ins END boundary does NOT expand the range', () => {
    // ins[1, 4) over "ell". Insert "X" at position 4 (== to).
    // Expected: range stays [1, 4); new "X" is OUTSIDE (to the right).
    const s = makeStateWithMarks('hello', [makeEntry({ id: 'a', from: 1, to: 4 })]);
    const next = s.update({
      changes: { from: 4, to: 4, insert: 'X' },
      annotations: tcMarkSkipAnnotation.of(true),
    }).state;
    expect(next.doc.toString()).toBe('hellXo');
    const ms = listMarks(next);
    expect(ms).toHaveLength(1);
    expect(ms[0].from).toBe(1);
    expect(ms[0].to).toBe(4);
  });

  it('§1.3 ★ RangeSet.map: insertion strictly INSIDE ins expands the range', () => {
    // ins[1, 4) over "ell". Insert "X" at position 2 (strictly inside).
    // Expected: range expands to [1, 5) covering "eXll".
    const s = makeStateWithMarks('hello', [makeEntry({ id: 'a', from: 1, to: 4 })]);
    const next = s.update({
      changes: { from: 2, to: 2, insert: 'X' },
      annotations: tcMarkSkipAnnotation.of(true),
    }).state;
    expect(next.doc.toString()).toBe('heXllo');
    const ms = listMarks(next);
    expect(ms).toHaveLength(1);
    expect(ms[0].from).toBe(1);
    expect(ms[0].to).toBe(5);
  });

  it('§1.4 V1 invariant: ins range that maps to zero length is filtered out', () => {
    // ins[2, 4). Delete the entire range. Mapped range becomes [2, 2);
    // §9.2 says it must be filtered out of the sidecar.
    const s = makeStateWithMarks('hello', [makeEntry({ id: 'a', from: 2, to: 4 })]);
    const next = s.update({
      changes: { from: 2, to: 4, insert: '' },
      annotations: tcMarkSkipAnnotation.of(true),
    }).state;
    expect(next.doc.toString()).toBe('heo');
    expect(listMarks(next)).toHaveLength(0);
  });

  // ── isValidEntry / hydration ──────────────────────────────────────

  it('§6.5 isValidEntry: ins must have from < to <= docLen', () => {
    expect(isValidEntry(makeEntry({ from: 0, to: 3 }), 5)).toBe(true);
    expect(isValidEntry(makeEntry({ from: 3, to: 3 }), 5)).toBe(false); // empty
    expect(isValidEntry(makeEntry({ from: 0, to: 6 }), 5)).toBe(false); // OOB
    expect(isValidEntry(makeEntry({ from: -1, to: 2 }), 5)).toBe(false); // negative
  });

  it('§6.5 isValidEntry: del must have from < to <= docLen (M2 — del is a real range)', () => {
    expect(isValidEntry(makeEntry({ type: 'del', from: 2, to: 4 }), 5)).toBe(true);
    expect(isValidEntry(makeEntry({ type: 'del', from: 2, to: 6 }), 5)).toBe(false); // OOB
    expect(isValidEntry(makeEntry({ type: 'del', from: 2, to: 2 }), 5)).toBe(false); // empty
  });

  it('§6.5 isValidEntry: unknown type rejected', () => {
    expect(isValidEntry({ id: 'x', type: 'comment', from: 0, to: 1, authorId: 'a', authorName: 'A', timestamp: 't' }, 5)).toBe(false);
    expect(isValidEntry({ id: 'x', from: 0, to: 1, authorId: 'a', authorName: 'A', timestamp: 't' }, 5)).toBe(false);
  });

  it('§6.5 ★ validateHydration drops invalid + dedupes by id (first wins)', () => {
    const entries = [
      makeEntry({ id: 'a', type: 'ins', from: 0, to: 3 }),
      makeEntry({ id: 'a', type: 'ins', from: 5, to: 8 }), // dup id — dropped
      makeEntry({ id: 'b', type: 'del', from: 100, text: 'x' }), // OOB — dropped
      { id: 'c', type: 'comment', from: 0, to: 1, authorId: 'a', authorName: 'A', timestamp: 't' }, // unknown type
      makeEntry({ id: 'd', type: 'ins', from: 4, to: 6 }), // valid
    ];
    const out = validateHydration(entries, 10);
    expect(out.map((e) => e.id)).toEqual(['a', 'd']);
    expect(out[0].from).toBe(0); // first occurrence won
  });

  it('§6.5 ★ setTcMarks: invalid entries dropped at install time', () => {
    const s = makeStateWithMarks('hello', [
      makeEntry({ id: 'a', type: 'ins', from: 0, to: 3 }),
      makeEntry({ id: 'b', type: 'ins', from: 0, to: 100 }), // OOB
      makeEntry({ id: 'c', type: 'del', from: 2, text: 'x' }),
      makeEntry({ id: 'a', type: 'ins', from: 0, to: 3 }), // dup
    ]);
    const ms = listMarks(s);
    expect(ms.map((m) => m.id).sort()).toEqual(['a', 'c']);
  });

  // ── serialize / deserialize ───────────────────────────────────────

  it('§1.6 serialize / deserialize round-trip preserves entries', () => {
    const original = [
      makeEntry({ id: 'i1', type: 'ins', from: 0, to: 3 }),
      makeEntry({ id: 'd1', type: 'del', from: 5, to: 9 }),
    ];
    const s = makeStateWithMarks('hello world', original);
    const out = serializeMarks(s);
    expect(out).toHaveLength(2);
    // Round-trip back into a fresh state.
    const fresh = makeStateWithMarks('hello world', deserializeMarks(out));
    expect(serializeMarks(fresh)).toEqual(out);
  });
});

describe('TC §2 — TC OFF', () => {
  it('§2.1 Typing TC off creates no entries', () => {
    const h = makeEditorHarness('', { tcOn: false });
    h.apply({ changes: { from: 0, to: 0, insert: 'hello' } });
    expect(h.state.doc.toString()).toBe('hello');
    expect(listMarks(h.state)).toHaveLength(0);
  });

  it('§2.4 Existing own ins survives plain typing before it (positions auto-map)', () => {
    const h = makeEditorHarness('hello', {
      tcOn: false,
      marks: [{ id: 'a', type: 'ins', from: 1, to: 4, authorId: ME.id, authorName: ME.name, timestamp: 't' }],
    });
    h.apply({ changes: { from: 0, to: 0, insert: 'X' } });
    expect(h.state.doc.toString()).toBe('Xhello');
    const ms = listMarks(h.state);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ id: 'a', from: 2, to: 5 });
  });
});

describe('TC §3.2 — TC ON insertions', () => {
  it('§3.2.a Insert strictly inside own ins → range expands, no new entry', () => {
    const h = makeEditorHarness('hello', {
      marks: [{ id: 'a', type: 'ins', from: 1, to: 4, authorId: ME.id, authorName: ME.name, timestamp: 't' }],
    });
    h.apply({ changes: { from: 2, to: 2, insert: 'X' } });
    expect(h.state.doc.toString()).toBe('heXllo');
    const ms = listMarks(h.state);
    // Only ONE entry: the existing ins absorbed the new char (suppressed
    // by §1.4 invariant + StateField map). The original entry id still
    // wins because spec.spread-first preserves spec metadata over the
    // mapped positions in listMarks.
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ id: 'a', from: 1, to: 5 });
  });

  it('§3.2.b ★ Continuous typing produces ONE ins entry (merge across keystrokes)', () => {
    const h = makeEditorHarness('');
    h.apply({ changes: { from: 0, to: 0, insert: 'h' }, selection: { anchor: 1 } });
    h.apply({ changes: { from: 1, to: 1, insert: 'e' }, selection: { anchor: 2 } });
    h.apply({ changes: { from: 2, to: 2, insert: 'l' }, selection: { anchor: 3 } });
    h.apply({ changes: { from: 3, to: 3, insert: 'l' }, selection: { anchor: 4 } });
    h.apply({ changes: { from: 4, to: 4, insert: 'o' }, selection: { anchor: 5 } });
    expect(h.state.doc.toString()).toBe('hello');
    const ms = listMarks(h.state);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ type: 'ins', from: 0, to: 5 });
  });

  it('§3.3 ★ Consecutive backspace produces ONE del entry (merge across keystrokes)', () => {
    const h = makeEditorHarness('hello world');
    // Backspace " world" one char at a time — each keypress deletes the
    // char immediately to the left of the cursor.
    h.apply({ changes: { from: 10, to: 11, insert: '' }, selection: { anchor: 10 } });
    h.apply({ changes: { from: 9, to: 10, insert: '' }, selection: { anchor: 9 } });
    h.apply({ changes: { from: 8, to: 9, insert: '' }, selection: { anchor: 8 } });
    h.apply({ changes: { from: 7, to: 8, insert: '' }, selection: { anchor: 7 } });
    h.apply({ changes: { from: 6, to: 7, insert: '' }, selection: { anchor: 6 } });
    h.apply({ changes: { from: 5, to: 6, insert: '' }, selection: { anchor: 5 } });
    // M2: doc keeps all chars; one merged del covers " world".
    expect(h.state.doc.toString()).toBe('hello world');
    const ms = listMarks(h.state);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ type: 'del', from: 5, to: 11 });
  });

  it('§3.2.b ★ Insert at end boundary of own ins → MERGE (one combined entry)', () => {
    // New rule: continuous typing produces ONE ins entry per run.
    // Inserting at the end of an own ins removes the old and replaces
    // with a combined entry.
    const h = makeEditorHarness('hello', {
      marks: [{ id: 'a', type: 'ins', from: 1, to: 4, authorId: ME.id, authorName: ME.name, timestamp: 't' }],
    });
    h.apply({ changes: { from: 4, to: 4, insert: 'X' } });
    expect(h.state.doc.toString()).toBe('hellXo');
    const ms = listMarks(h.state);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ from: 1, to: 5, type: 'ins' });
    // The merged entry has a NEW id (the old 'a' was removed).
    expect(ms[0].id).not.toBe('a');
  });

  it('§3.2.b ★ Insert at start boundary of own ins → new adjacent entry; old unchanged', () => {
    const h = makeEditorHarness('hello', {
      marks: [{ id: 'a', type: 'ins', from: 1, to: 4, authorId: ME.id, authorName: ME.name, timestamp: 't' }],
    });
    h.apply({ changes: { from: 1, to: 1, insert: 'X' } });
    expect(h.state.doc.toString()).toBe('hXello');
    const ms = listMarks(h.state).sort((a, b) => a.from - b.from);
    expect(ms).toHaveLength(2);
    expect(ms[0]).toMatchObject({ from: 1, to: 2, type: 'ins' });
    expect(ms[1]).toMatchObject({ id: 'a', from: 2, to: 5 });
    expect(ms[0].id).not.toBe('a');
  });

  it('§3.2.d Insert next to a del-marked range → ins added; del range shifts via mapping', () => {
    // M2: doc "hello" with "o" marked-deleted at [4, 5). Insert "X" at
    // position 4 (== del's start). With startSide=1 the new "X" goes
    // OUTSIDE (to the LEFT of) the del range; del shifts right.
    const h = makeEditorHarness('hello', {
      marks: [{ id: 'd', type: 'del', from: 4, to: 5, authorId: ME.id, authorName: ME.name, timestamp: 't' }],
    });
    h.apply({ changes: { from: 4, to: 4, insert: 'X' } });
    expect(h.state.doc.toString()).toBe('hellXo');
    const ms = listMarks(h.state).sort((a, b) => a.from - b.from);
    expect(ms).toHaveLength(2);
    expect(ms[0]).toMatchObject({ type: 'ins', from: 4, to: 5 });
    expect(ms[1]).toMatchObject({ id: 'd', type: 'del', from: 5, to: 6 });
  });

  it('§3.6 Paste TC on → one ins entry covering the pasted region', () => {
    const h = makeEditorHarness('start ');
    h.apply({ changes: { from: 6, to: 6, insert: 'pasted text' } });
    expect(h.state.doc.toString()).toBe('start pasted text');
    const ms = listMarks(h.state);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ type: 'ins', from: 6, to: 17 });
  });

  it('§3.6 Multi-line paste TC on → ins length matches pasted string CM6 length', () => {
    const h = makeEditorHarness('');
    const pasted = 'line1\nline2\nline3';
    h.apply({ changes: { from: 0, to: 0, insert: pasted } });
    const ms = listMarks(h.state);
    expect(ms).toHaveLength(1);
    expect(ms[0].to - ms[0].from).toBe(pasted.length);
  });

  it('§3.6 Multi-cursor insert TC on → one ins entry per cursor', () => {
    // "aaaa" + insert "X" at 1 + insert "Y" at 3 (positions in original
    // doc, applied as one parallel ChangeSet) → "aXaaYa".
    const h = makeEditorHarness('aaaa');
    h.apply({ changes: [{ from: 1, to: 1, insert: 'X' }, { from: 3, to: 3, insert: 'Y' }] });
    expect(h.state.doc.toString()).toBe('aXaaYa');
    const ms = listMarks(h.state).sort((a, b) => a.from - b.from);
    expect(ms).toHaveLength(2);
    expect(ms[0]).toMatchObject({ from: 1, to: 2, type: 'ins' });
    expect(ms[1]).toMatchObject({ from: 4, to: 5, type: 'ins' });
  });

  it('§3.1 Skip annotation bypasses the input filter (used for hydration / OT / accept-reject)', () => {
    const h = makeEditorHarness('');
    h.apply({
      changes: { from: 0, to: 0, insert: 'hello' },
      annotations: tcMarkSkipAnnotation.of(true),
    });
    expect(h.state.doc.toString()).toBe('hello');
    expect(listMarks(h.state)).toHaveLength(0);
  });
});

describe('TC §3.3 — TC ON deletions (M2)', () => {
  it('§3.3.a ★ Backspace into own ins → range shrinks, doc loses chars, no del entry', () => {
    const h = makeEditorHarness('hello', {
      marks: [{ id: 'a', type: 'ins', from: 0, to: 5, authorId: ME.id, authorName: ME.name, timestamp: 't' }],
    });
    h.apply({ changes: { from: 4, to: 5, insert: '' } });
    expect(h.state.doc.toString()).toBe('hell');
    const ms = listMarks(h.state);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ id: 'a', type: 'ins', from: 0, to: 4 });
  });

  it('§3.3.a Backspace entire own ins → ins entry vanishes (zero-length filter)', () => {
    const h = makeEditorHarness('hello', {
      marks: [{ id: 'a', type: 'ins', from: 0, to: 5, authorId: ME.id, authorName: ME.name, timestamp: 't' }],
    });
    h.apply({ changes: { from: 0, to: 5, insert: '' } });
    expect(h.state.doc.toString()).toBe('');
    expect(listMarks(h.state)).toHaveLength(0);
  });

  it('§3.3.b ★ Backspace original text → doc UNCHANGED, del mark added, cursor moves left', () => {
    const h = makeEditorHarness('hello');
    h.apply({
      changes: { from: 4, to: 5, insert: '' },
      selection: { anchor: 4 },
    });
    // M2: doc keeps the "o" — only marked.
    expect(h.state.doc.toString()).toBe('hello');
    // Cursor at 4 (between "l" and the marked-deleted "o").
    expect(h.state.selection.main.head).toBe(4);
    const ms = listMarks(h.state);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ type: 'del', from: 4, to: 5 });
  });

  it('§3.3.c ★ Selection spans own ins + original → own-ins parts deleted, original parts marked', () => {
    // doc: "AB[own-ins:CD]EF" — own ins at [2,4) covering "CD".
    const h = makeEditorHarness('ABCDEF', {
      marks: [{ id: 'a', type: 'ins', from: 2, to: 4, authorId: ME.id, authorName: ME.name, timestamp: 't' }],
    });
    // Delete [1, 5): "B" (orig) + "CD" (own ins) + "E" (orig).
    h.apply({
      changes: { from: 1, to: 5, insert: '' },
      selection: { anchor: 1 },
    });
    // M2: own ins "CD" actually deleted; "B" and "E" stay marked.
    // New doc = "ABEF" (length 4). del marks at [1,2) "B" and [2,3) "E".
    expect(h.state.doc.toString()).toBe('ABEF');
    const ms = listMarks(h.state);
    expect(ms.filter((m) => m.type === 'ins')).toHaveLength(0);
    const dels = ms.filter((m) => m.type === 'del').sort((a, b) => a.from - b.from);
    expect(dels).toHaveLength(2);
    expect(dels[0]).toMatchObject({ from: 1, to: 2 });
    expect(dels[1]).toMatchObject({ from: 2, to: 3 });
  });

  it('§3.6 Cut original text TC on → doc UNCHANGED, del mark created over the cut range', () => {
    const h = makeEditorHarness('hello world');
    h.apply({
      changes: { from: 5, to: 11, insert: '' },
      selection: { anchor: 5 },
    });
    expect(h.state.doc.toString()).toBe('hello world');
    expect(h.state.selection.main.head).toBe(5);
    const ms = listMarks(h.state);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ type: 'del', from: 5, to: 11 });
  });

  it('§3.6 Multi-range delete in one transaction → del mark per affected span; doc unchanged', () => {
    const h = makeEditorHarness('aXbYc');
    h.apply({ changes: [{ from: 1, to: 2, insert: '' }, { from: 3, to: 4, insert: '' }] });
    // M2: doc keeps both "X" and "Y" — marked.
    expect(h.state.doc.toString()).toBe('aXbYc');
    const dels = listMarks(h.state)
      .filter((m) => m.type === 'del')
      .sort((a, b) => a.from - b.from);
    expect(dels).toHaveLength(2);
    expect(dels[0]).toMatchObject({ from: 1, to: 2 });
    expect(dels[1]).toMatchObject({ from: 3, to: 4 });
  });

  it('§3.4.d Right arrow over a del-marked range — chars are real, cursor traverses', () => {
    // doc "hello", del-mark over [4,5) ("o"), cursor at 4.
    // Pressing right arrow should advance cursor to 5 — doc has all
    // 5 chars, the strikethrough doesn't block traversal.
    const h = makeEditorHarness('hello', {
      marks: [{ id: 'd', type: 'del', from: 4, to: 5, authorId: ME.id, authorName: ME.name, timestamp: 't' }],
    });
    expect(h.state.doc.length).toBe(5);
    // Cursor at 4. Selection at 5 is valid (within doc).
    h.apply({ selection: { anchor: 5 } });
    expect(h.state.selection.main.head).toBe(5);
  });
});

describe('TC §3.5 — Replacement (M2)', () => {
  it('§3.5 ★ Replacement of original text → ins inserted at fromA; original kept and marked del', () => {
    const h = makeEditorHarness('abc');
    h.apply({
      changes: { from: 0, to: 3, insert: 'XYZ' },
      selection: { anchor: 3 },
    });
    // M2: "XYZ" inserted at 0; "abc" kept in doc, marked del.
    // New doc: "XYZabc" (6 chars). ins=[0,3), del=[3,6).
    expect(h.state.doc.toString()).toBe('XYZabc');
    const ms = listMarks(h.state).sort((a, b) => a.from - b.from);
    expect(ms).toHaveLength(2);
    expect(ms[0]).toMatchObject({ type: 'ins', from: 0, to: 3 });
    expect(ms[1]).toMatchObject({ type: 'del', from: 3, to: 6 });
  });

  it('§3.5 Replacement of own ins (selection inside) → self-retract + new ins; no del', () => {
    const h = makeEditorHarness('hello', {
      marks: [{ id: 'a', type: 'ins', from: 0, to: 5, authorId: ME.id, authorName: ME.name, timestamp: 't' }],
    });
    h.apply({ changes: { from: 1, to: 4, insert: 'XX' } });
    // Selection inside own ins: "ell" deleted, "XX" inserted.
    // Doc: "hXXo".
    expect(h.state.doc.toString()).toBe('hXXo');
    const ms = listMarks(h.state);
    expect(ms.filter((m) => m.type === 'del')).toHaveLength(0);
    expect(ms.filter((m) => m.type === 'ins').length).toBeGreaterThan(0);
  });
});

describe('TC §3.4 — Cursor (browser/integration)', () => {
  it.todo('§3.4.a After typing N chars, cursor at P + N');
  it.todo('§3.4.c ★ After backspace original, del widget renders LEFT of cursor (side: -1)');
  it.todo('§3.4.d After typing past del widget, cursor past new chars; widget remains left');
  it.todo('§3.4.e Arrow keys traverse one offset at a time across widgets and ranges');
  it.todo('§3.4.f Click on del widget DOM positions cursor at the widget point');
});

describe('TC §3 + §9.12 — Decoration rendering', () => {
  function mountView(state) {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    return new EditorView({ state, parent });
  }

  it('§3 ins range renders with cm-tc-insert class + author dataset', () => {
    const state = makeStateWithMarks('hello world', [
      { id: 'a', type: 'ins', from: 6, to: 11, authorId: ME.id, authorName: ME.name, timestamp: 't' },
    ]);
    const stateWithDeco = EditorState.create({
      doc: state.doc,
      extensions: [...tcMarksExtensions(), tcMarksInlineDecorations],
    });
    const seeded = stateWithDeco.update({
      effects: setTcMarks.of([{ id: 'a', type: 'ins', from: 6, to: 11, authorId: ME.id, authorName: ME.name, timestamp: 't' }]),
      annotations: tcMarkSkipAnnotation.of(true),
    }).state;
    const view = mountView(seeded);
    try {
      const span = view.dom.querySelector('.cm-tc-insert');
      expect(span).toBeTruthy();
      expect(span.dataset.tcId).toBe('a');
      expect(span.dataset.tcType).toBe('ins');
      expect(span.dataset.tcAuthor).toBe(ME.name);
      expect(span.textContent).toBe('world');
    } finally {
      view.destroy();
    }
  });

  it('§3.4.c + §9.12 ★ del mark renders with cm-tc-delete class on the doc chars + aria-label', () => {
    // M2: del is a Mark on real doc chars (strikethrough). Cursor traverses naturally.
    const state = EditorState.create({
      doc: 'hello world',
      extensions: [...tcMarksExtensions(), tcMarksInlineDecorations],
    });
    const seeded = state.update({
      effects: setTcMarks.of([
        { id: 'd', type: 'del', from: 6, to: 11, authorId: ME.id, authorName: ME.name, timestamp: 't' },
      ]),
      annotations: tcMarkSkipAnnotation.of(true),
    }).state;
    const view = mountView(seeded);
    try {
      const span = view.dom.querySelector('.cm-tc-delete');
      expect(span).toBeTruthy();
      expect(span.dataset.tcId).toBe('d');
      expect(span.dataset.tcType).toBe('del');
      expect(span.dataset.tcAuthor).toBe(ME.name);
      expect(span.getAttribute('aria-label')).toBe(`Deleted by ${ME.name}`);
      // Marked text is the doc text in that range.
      expect(span.textContent).toBe('world');
    } finally {
      view.destroy();
    }
  });

  it('§9.13 Copy (M2): pending deletions ARE in the doc text — same as Word', () => {
    // M2: doc contains all pending text. Copying selects from doc text directly.
    // The strikethrough is purely visual — copy gets the underlying chars.
    const state = makeStateWithMarks('hello world', [
      { id: 'a', type: 'ins', from: 6, to: 11, authorId: ME.id, authorName: ME.name, timestamp: 't' },
      { id: 'd', type: 'del', from: 0, to: 5, authorId: ME.id, authorName: ME.name, timestamp: 't' },
    ]);
    expect(state.doc.toString()).toBe('hello world');
  });
});

describe('TC §4 — Accept / reject (M2 semantics)', () => {
  // Helper that simulates the imperative `applyMarkResolution` logic
  // by dispatching the same effects directly onto a state.
  function resolve(state, id, decision) {
    const m = listMarks(state).find((x) => x.id === id);
    if (!m) return state;
    const spec = {
      effects: removeTcMark.of(id),
      annotations: tcMarkSkipAnnotation.of(true),
    };
    const removeRange =
      (m.type === 'ins' && decision === 'reject') ||
      (m.type === 'del' && decision === 'accept');
    if (removeRange) {
      spec.changes = { from: m.from, to: m.to, insert: '' };
    }
    return state.update(spec).state;
  }

  it('§4.1 ★ Accept ins → entry gone, doc unchanged', () => {
    const s0 = makeStateWithMarks('hello', [
      makeEntry({ id: 'a', type: 'ins', from: 0, to: 5 }),
    ]);
    const s1 = resolve(s0, 'a', 'accept');
    expect(s1.doc.toString()).toBe('hello');
    expect(listMarks(s1)).toHaveLength(0);
  });

  it('§4.1 ★ Accept del → doc range REMOVED, entry gone (M2 semantics)', () => {
    const s0 = makeStateWithMarks('hello world', [
      makeEntry({ id: 'd', type: 'del', from: 5, to: 11 }),
    ]);
    const s1 = resolve(s0, 'd', 'accept');
    expect(s1.doc.toString()).toBe('hello');
    expect(listMarks(s1)).toHaveLength(0);
  });

  it('§4.2 Reject ins → doc range removed, entry gone', () => {
    const s0 = makeStateWithMarks('hello world', [
      makeEntry({ id: 'a', type: 'ins', from: 6, to: 11 }),
    ]);
    const s1 = resolve(s0, 'a', 'reject');
    expect(s1.doc.toString()).toBe('hello ');
    expect(listMarks(s1)).toHaveLength(0);
  });

  it('§4.2 Reject del → entry gone, doc UNCHANGED (M2 — text stayed)', () => {
    const s0 = makeStateWithMarks('hello world', [
      makeEntry({ id: 'd', type: 'del', from: 5, to: 11 }),
    ]);
    const s1 = resolve(s0, 'd', 'reject');
    expect(s1.doc.toString()).toBe('hello world');
    expect(listMarks(s1)).toHaveLength(0);
  });
});

describe('TC §5 — Undo / redo (invertedEffects)', () => {
  // Harness with history() so we can drive undo via CM's command.
  function makeUndoHarness(doc, { tcOn = true, marks = [] } = {}) {
    let on = tcOn;
    const filter = buildTcMarksInputFilter({
      isOn: () => on,
      getAuthorId: () => ME.id,
      getAuthorName: () => ME.name,
    });
    let state = EditorState.create({
      doc,
      extensions: [...tcMarksExtensions(), filter, history()],
    });
    if (marks.length > 0) {
      state = state.update({
        effects: setTcMarks.of(marks),
        annotations: tcMarkSkipAnnotation.of(true),
      }).state;
    }
    return {
      get state() { return state; },
      apply(spec) { state = state.update(spec).state; return state; },
      undo() {
        const view = {
          state,
          dispatch(spec) { state = state.update(spec).state; },
        };
        return cmUndo(view);
      },
    };
  }

  it('§5.3.b ★ Undo after backspace TC on → del mark gone', () => {
    const h = makeUndoHarness('hello');
    h.apply({
      changes: { from: 4, to: 5, insert: '' },
      selection: { anchor: 4 },
      annotations: Transaction.userEvent.of('delete.backward'),
    });
    expect(listMarks(h.state).filter((m) => m.type === 'del')).toHaveLength(1);
    h.undo();
    expect(h.state.doc.toString()).toBe('hello');
    expect(listMarks(h.state).filter((m) => m.type === 'del')).toHaveLength(0);
  });

  it('§5.3.a ★ Undo after typing TC on → text removed AND ins mark removed', () => {
    const h = makeUndoHarness('');
    h.apply({
      changes: { from: 0, to: 0, insert: 'X' },
      selection: { anchor: 1 },
      annotations: Transaction.userEvent.of('input.type'),
    });
    expect(h.state.doc.toString()).toBe('X');
    expect(listMarks(h.state).filter((m) => m.type === 'ins')).toHaveLength(1);
    h.undo();
    expect(h.state.doc.toString()).toBe('');
    expect(listMarks(h.state)).toHaveLength(0);
  });

  it('§5.3.c ★ Cmd-Z after self-retraction → text restored AND ins range restored', () => {
    // Pre-existing own ins (not typed in this transaction sequence — so
    // there's no input.type transaction to join with). Backspace → self-
    // retract; Cmd-Z must bring char + ins mark back.
    const h = makeUndoHarness('X', {
      marks: [{ id: 'ins-x', type: 'ins', from: 0, to: 1, authorId: ME.id, authorName: ME.name, timestamp: 't' }],
    });
    expect(h.state.doc.toString()).toBe('X');
    expect(listMarks(h.state).filter((m) => m.type === 'ins')).toHaveLength(1);

    h.apply({
      changes: { from: 0, to: 1, insert: '' },
      selection: { anchor: 0 },
      annotations: Transaction.userEvent.of('delete.backward'),
    });
    expect(h.state.doc.toString()).toBe('');
    expect(listMarks(h.state)).toHaveLength(0);

    h.undo();
    expect(h.state.doc.toString()).toBe('X');
    const ms = listMarks(h.state).filter((m) => m.type === 'ins');
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ from: 0, to: 1 });
  });
  it.todo('§5.3.d Cmd-Z after accept → entry re-created');
  it.todo('§5.3.e Cmd-Z after reject ins → text + entry restored');
  it.todo('§5.3.f Cmd-Z after reject del → text removed again + entry restored');
  it.todo('§5.2 Type "abc" as three transactions → three Cmd-Zs leave doc empty and no entries');
});

describe('TC §6 — Persistence', () => {
  it('§6.3 Round-trip: serialize → deserialize → setTcMarks → serialize gives same shape', () => {
    // Type a few changes through the input filter, serialize, hydrate
    // into a fresh state, serialize again — should be the same.
    const h = makeEditorHarness('hello');
    h.apply({ changes: { from: 5, to: 5, insert: ' world' } });
    h.apply({ changes: { from: 0, to: 5, insert: '' }, selection: { anchor: 0 } });
    const serialized = serializeMarks(h.state);
    expect(serialized.length).toBeGreaterThan(0);

    // Round-trip into a fresh state with the SAME doc.
    const fresh = makeStateWithMarks(h.state.doc.toString(), deserializeMarks(serialized));
    expect(serializeMarks(fresh)).toEqual(serialized);
  });

  it.todo('§6.1 ★ Edit then idle 1s → save fires with current sidecar');
  it.todo('§6.2 ★ Hydration on file load does NOT trigger save');
  it.todo('§6.4 File switch with debounced save pending → save fires with old file id');
});

describe('TC §9 — Edge cases', () => {
  it.todo('§9.1 Empty insert / empty delete → no entries');
  it.todo('§9.2 Ins range mapped to zero length → entry filtered');
  it.todo('§9.4 Multi-step self-retraction → range shrinks then entry vanishes');
  it.todo('§9.8 Emoji A🙂B: ins covering 🙂 round-trips through save/reload');
  it.todo('§9.9 Same-position del + ins → render order del then ins');
  it.todo('§9.12 Accessibility: del widget exposes deleted text to assistive tech');
  it.todo('§9.13 Copy: pending insertions copied; pending deletions not copied');
});

describe('TC V2 (placeholders — do not implement in V1)', () => {
  it.todo('§7.4 Foreign-author ins preserved when current user types adjacent');
  it.todo('§7.4 Foreign-author ins deletion creates own del with displacedMarks for lossless reject');
  it.todo('§6.3 Stale save (baseVersion mismatch) returns 409; client surfaces conflict');
  it.todo('§8 WS broadcast of mark effects');
});
