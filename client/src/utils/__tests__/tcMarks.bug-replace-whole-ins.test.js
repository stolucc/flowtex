import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  tcMarksExtensions,
  tcMarksInlineDecorations,
  setTcMarks,
  listMarks,
  tcMarkSkipAnnotation,
} from '../tcMarks.js';
import { buildTcMarksInputFilter } from '../tcMarksInput.js';

const ME = { id: 'u-me', name: 'Alice' };

function ent(over) {
  return {
    id: over.id,
    type: over.type,
    from: over.from,
    to: over.to,
    authorId: over.authorId ?? ME.id,
    authorName: over.authorName ?? ME.name,
    timestamp: over.timestamp ?? '2026-05-17T00:00:00.000Z',
  };
}

function makeEd(doc, { marks = [] } = {}) {
  const filter = buildTcMarksInputFilter({
    isOn: () => true,
    getAuthorId: () => ME.id,
    getAuthorName: () => ME.name,
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
    apply(spec) { state = state.update(spec).state; return state; },
  };
}

describe('bug: select the whole own-ins and replace with one char', () => {
  it('single-transaction replace [0,5)="klaas" with "k"', () => {
    const h = makeEd('klaas', {
      marks: [ent({ id: 'klaas-mark', type: 'ins', from: 0, to: 5 })],
    });
    h.apply({ changes: { from: 0, to: 5, insert: 'k' } });
    expect(h.state.doc.toString()).toBe('k');
    const ins = listMarks(h.state).filter((m) => m.type === 'ins');
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ from: 0, to: 1, type: 'ins' });
  });

  it('with userEvent input.type annotation (real-typing path)', () => {
    const h = makeEd('klaas', {
      marks: [ent({ id: 'klaas-mark', type: 'ins', from: 0, to: 5 })],
    });
    h.apply({
      changes: { from: 0, to: 5, insert: 'k' },
      selection: { anchor: 1 },
      userEvent: 'input.type',
    });
    expect(h.state.doc.toString()).toBe('k');
    const ins = listMarks(h.state).filter((m) => m.type === 'ins');
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ from: 0, to: 1, type: 'ins' });
  });

  it('via replaceSelection (what CM dispatches for typing over selection)', () => {
    const h = makeEd('klaas', {
      marks: [ent({ id: 'klaas-mark', type: 'ins', from: 0, to: 5 })],
    });
    // Select the whole klaas first (non-doc-changing tr → not filtered).
    h.apply({ selection: { anchor: 0, head: 5 } });
    expect(h.state.selection.main.from).toBe(0);
    expect(h.state.selection.main.to).toBe(5);
    // Now produce the change that CM produces internally for "type k over selection".
    const tr = h.state.replaceSelection('k');
    // replaceSelection returns a TransactionSpec; verify what CM crafts.
    expect(tr.changes).toBeDefined();
    h.apply(tr);
    expect(h.state.doc.toString()).toBe('k');
    const ins = listMarks(h.state).filter((m) => m.type === 'ins');
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ from: 0, to: 1, type: 'ins' });
  });

  it('typed letter-by-letter then replace whole — mirrors merge-left + self-retract', () => {
    const h = makeEd('', {});
    // Type k-l-a-a-s one char at a time (5 transactions, each at end-of-doc)
    for (const ch of 'klaas') {
      const pos = h.state.doc.length;
      h.apply({ changes: { from: pos, to: pos, insert: ch }, userEvent: 'input.type' });
    }
    expect(h.state.doc.toString()).toBe('klaas');
    const insBefore = listMarks(h.state).filter((m) => m.type === 'ins');
    // merge-left should have collapsed these into a single ins[0,5)
    expect(insBefore).toHaveLength(1);
    expect(insBefore[0]).toMatchObject({ from: 0, to: 5 });

    // Now select all and type k
    h.apply({ selection: { anchor: 0, head: 5 } });
    h.apply({ changes: { from: 0, to: 5, insert: 'k' }, userEvent: 'input.type' });
    expect(h.state.doc.toString()).toBe('k');
    const insAfter = listMarks(h.state).filter((m) => m.type === 'ins');
    expect(insAfter).toHaveLength(1);
    expect(insAfter[0]).toMatchObject({ from: 0, to: 1, type: 'ins' });
  });

  it('two-transaction sequence: delete then insert (defensive)', () => {
    const h = makeEd('klaas', {
      marks: [ent({ id: 'klaas-mark', type: 'ins', from: 0, to: 5 })],
    });
    h.apply({ changes: { from: 0, to: 5, insert: '' }, userEvent: 'delete.selection' });
    expect(h.state.doc.toString()).toBe('');
    expect(listMarks(h.state)).toHaveLength(0);
    h.apply({ changes: { from: 0, to: 0, insert: 'k' }, userEvent: 'input.type' });
    expect(h.state.doc.toString()).toBe('k');
    const ins = listMarks(h.state).filter((m) => m.type === 'ins');
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ from: 0, to: 1, type: 'ins' });
  });

  it('larger doc: "hello klaas world" with ins[6,11) → replace with k', () => {
    const h = makeEd('hello klaas world', {
      marks: [ent({ id: 'klaas-mark', type: 'ins', from: 6, to: 11 })],
    });
    h.apply({ changes: { from: 6, to: 11, insert: 'k' }, userEvent: 'input.type' });
    expect(h.state.doc.toString()).toBe('hello k world');
    const ins = listMarks(h.state).filter((m) => m.type === 'ins');
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ from: 6, to: 7, type: 'ins' });
  });

  it('two adjacent own-ins entries — select across both and replace', () => {
    // What if "klaas" came from two separate typing bursts that didnt merge,
    // e.g. ins[0,2) and ins[2,5)? The replacement spans BOTH entries.
    const h = makeEd('klaas', {
      marks: [
        ent({ id: 'a', type: 'ins', from: 0, to: 2 }),
        ent({ id: 'b', type: 'ins', from: 2, to: 5 }),
      ],
    });
    h.apply({ changes: { from: 0, to: 5, insert: 'k' }, userEvent: 'input.type' });
    expect(h.state.doc.toString()).toBe('k');
    const ins = listMarks(h.state).filter((m) => m.type === 'ins');
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ from: 0, to: 1, type: 'ins' });
  });

  it('cross-author replacement: original klaas by other, replace by me', () => {
    const h = makeEd('klaas', {
      marks: [
        ent({ id: 'b-ins', type: 'ins', from: 0, to: 5, authorId: 'u-bob', authorName: 'Bob' }),
      ],
    });
    h.apply({ changes: { from: 0, to: 5, insert: 'k' }, userEvent: 'input.type' });
    // Bobs ins is preserved at the shifted location; my own ins+del overlay
    // the same chars (he inserted it, Im deleting it — both stay pending
    // until someone resolves either way).
    expect(h.state.doc.toString()).toBe('kklaas');
    const marks = listMarks(h.state);
    const myIns = marks.find((m) => m.type === 'ins' && m.authorId === 'u-me');
    const myDel = marks.find((m) => m.type === 'del' && m.authorId === 'u-me');
    const bobIns = marks.find((m) => m.type === 'ins' && m.authorId === 'u-bob');
    expect(myIns).toMatchObject({ from: 0, to: 1 });
    expect(myDel).toMatchObject({ from: 1, to: 6 });
    expect(bobIns).toMatchObject({ from: 1, to: 6 });
  });

  it('via real EditorView dispatch (decoration end-to-end)', () => {
    const filter = buildTcMarksInputFilter({
      isOn: () => true,
      getAuthorId: () => ME.id,
      getAuthorName: () => ME.name,
    });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: 'klaas',
        extensions: [...tcMarksExtensions(), tcMarksInlineDecorations, filter],
      }),
      parent,
    });
    // Hydrate the ins mark for klaas
    view.dispatch({
      effects: setTcMarks.of([ent({ id: 'klaas-mark', type: 'ins', from: 0, to: 5 })]),
      annotations: tcMarkSkipAnnotation.of(true),
    });
    // Sanity: klaas is marked
    let insMarks = listMarks(view.state).filter((m) => m.type === 'ins');
    expect(insMarks).toHaveLength(1);
    expect(insMarks[0]).toMatchObject({ from: 0, to: 5 });

    // Now select all and "type" k — what CM does internally for typing over selection
    view.dispatch(view.state.replaceSelection('k'));
    // Wait actually replaceSelection uses CURRENT selection — set it first
    // (above didnt change selection). Reset and try the canonical flow:
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: 'klaas' },
      selection: { anchor: 0 },
      annotations: tcMarkSkipAnnotation.of(true),
    });
    view.dispatch({
      effects: setTcMarks.of([ent({ id: 'klaas-2', type: 'ins', from: 0, to: 5 })]),
      annotations: tcMarkSkipAnnotation.of(true),
    });
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    view.dispatch(view.state.replaceSelection('k'));

    expect(view.state.doc.toString()).toBe('k');
    insMarks = listMarks(view.state).filter((m) => m.type === 'ins');
    expect(insMarks).toHaveLength(1);
    expect(insMarks[0]).toMatchObject({ from: 0, to: 1, type: 'ins' });

    // And the DOM decoration is applied?
    const insSpans = parent.querySelectorAll('.cm-tc-insert');
    expect(insSpans.length).toBeGreaterThan(0);
    const text = Array.from(insSpans).map((s) => s.textContent).join('');
    expect(text).toContain('k');

    view.destroy();
    parent.remove();
  });
});
