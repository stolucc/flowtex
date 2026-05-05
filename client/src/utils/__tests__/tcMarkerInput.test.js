import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { parseAll } from '@shared/tcMarkers.js';
import { buildTcMarkerInputFilter, tcMarkerSkipAnnotation } from '../tcMarkerInput.js';

let on = false;
const filter = buildTcMarkerInputFilter({
  isOn: () => on,
  getAuthor: () => 'Alice',
});

function makeState(doc) {
  return EditorState.create({ doc, extensions: [filter] });
}

function applyChange(state, spec) {
  return state.update(spec).state;
}

beforeEach(() => {
  on = false;
});

describe('tcMarkerInput filter', () => {
  it('is a no-op when track-changes mode is OFF', () => {
    const s = makeState('hello');
    const next = applyChange(s, { changes: { from: 5, to: 5, insert: ' world' } });
    expect(next.doc.toString()).toBe('hello world');
    expect(parseAll(next.doc.toString())).toEqual([]);
  });

  it('wraps a pure insertion in an ins marker when ON', () => {
    on = true;
    const s = makeState('abc');
    const next = applyChange(s, { changes: { from: 3, to: 3, insert: 'X' } });
    const markers = parseAll(next.doc.toString());
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ type: 'ins', author: 'Alice', text: 'X' });
  });

  it('wraps a pure deletion in a del marker, KEEPING the deleted text inside', () => {
    on = true;
    const s = makeState('abcdef');
    // delete 'cd' at positions [2, 4)
    const next = applyChange(s, { changes: { from: 2, to: 4, insert: '' } });
    const markers = parseAll(next.doc.toString());
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ type: 'del', author: 'Alice', text: 'cd' });
  });

  it('treats a replacement as TWO markers (ins + del at the same point)', () => {
    on = true;
    const s = makeState('Header 2');
    // replace 'Header 2' with 'eee'
    const next = applyChange(s, { changes: { from: 0, to: 8, insert: 'eee' } });
    const markers = parseAll(next.doc.toString());
    expect(markers).toHaveLength(2);
    const insMark = markers.find((m) => m.type === 'ins');
    const delMark = markers.find((m) => m.type === 'del');
    expect(insMark.text).toBe('eee');
    expect(delMark.text).toBe('Header 2');
  });

  it('merges consecutive insertions into one growing ins marker', () => {
    on = true;
    let s = makeState('');
    s = applyChange(s, { changes: { from: 0, to: 0, insert: 'h' } });
    // Cursor lands past the marker; the next "type 'i'" appends.
    const docAfterFirst = s.doc.toString();
    const markersAfterFirst = parseAll(docAfterFirst);
    const insTo = markersAfterFirst[0].to;
    s = applyChange(s, { changes: { from: insTo, to: insTo, insert: 'i' } });
    const markers = parseAll(s.doc.toString());
    expect(markers).toHaveLength(1);
    expect(markers[0].text).toBe('hi');
  });

  it('merges adjacent deletions into one del marker', () => {
    on = true;
    let s = makeState('abcde');
    // delete 'b' at [1, 2)
    s = applyChange(s, { changes: { from: 1, to: 2, insert: '' } });
    // After this, the doc has 'a<delMarker:b>cde'. The 'c' is now at
    // position (1 + delMarkerLength). Delete 'c' next.
    const text = s.doc.toString();
    const markers = parseAll(text);
    const delTo = markers[0].to;
    s = applyChange(s, { changes: { from: delTo, to: delTo + 1, insert: '' } });
    const finalMarkers = parseAll(s.doc.toString());
    expect(finalMarkers).toHaveLength(1);
    expect(finalMarkers[0].text).toBe('bc');
  });

  it('shrinks an existing ins marker when the user backspaces inside their own insertion', () => {
    on = true;
    let s = makeState('');
    s = applyChange(s, { changes: { from: 0, to: 0, insert: 'hello' } });
    // The doc now has one ins marker with text 'hello'. Delete the
    // 'l' at offset 3 inside the marker's text.
    const m = parseAll(s.doc.toString())[0];
    const lPos = m.textFrom + 3;
    s = applyChange(s, { changes: { from: lPos, to: lPos + 1, insert: '' } });
    const markers = parseAll(s.doc.toString());
    expect(markers).toHaveLength(1);
    expect(markers[0].type).toBe('ins');
    expect(markers[0].text).toBe('helo');
  });

  it('removes the marker entirely when the user deletes their whole insertion', () => {
    on = true;
    let s = makeState('');
    s = applyChange(s, { changes: { from: 0, to: 0, insert: 'X' } });
    const m = parseAll(s.doc.toString())[0];
    s = applyChange(s, { changes: { from: m.textFrom, to: m.textTo, insert: '' } });
    expect(parseAll(s.doc.toString())).toEqual([]);
  });

  it('places the caret AFTER a fresh insertion so the next keystroke merges', () => {
    on = true;
    let s = makeState('');
    s = applyChange(s, { changes: { from: 0, to: 0, insert: 's' } });
    // The caret must be at marker.to so simulating a follow-up
    // keystroke at `s.selection.main.head` lands it at the right
    // position to trigger the merge path.
    const m = parseAll(s.doc.toString())[0];
    expect(s.selection.main.head).toBe(m.to);
    // Simulate the next keystroke at the current caret.
    const head = s.selection.main.head;
    s = applyChange(s, { changes: { from: head, to: head, insert: 'd' } });
    const markers = parseAll(s.doc.toString());
    expect(markers).toHaveLength(1);
    expect(markers[0].text).toBe('sd');
  });

  it('places the caret at the START of a fresh deletion (so further backspace extends it)', () => {
    on = true;
    let s = makeState('abcdef');
    s = applyChange(s, { changes: { from: 5, to: 6, insert: '' } }); // backspace 'f'
    const m = parseAll(s.doc.toString())[0];
    expect(m.text).toBe('f');
    expect(s.selection.main.head).toBe(m.from);
    // Backspace again from the current caret. With the caret at m.from,
    // the deletion targets m.from-1..m.from = 'e'. The merge-with-right
    // path picks up the existing 'f' marker and extends it to 'ef'.
    const head = s.selection.main.head;
    s = applyChange(s, { changes: { from: head - 1, to: head, insert: '' } });
    const markers = parseAll(s.doc.toString());
    expect(markers).toHaveLength(1);
    expect(markers[0].text).toBe('ef');
  });

  it('refuses a deletion that partially overlaps a marker (atomic invariant)', () => {
    on = true;
    let s = makeState('');
    s = applyChange(s, { changes: { from: 0, to: 0, insert: 'eee' } });
    // Now the doc holds an ins marker with text 'eee'. The user
    // selects from inside the marker text out to plain content and
    // hits delete. The filter must drop the deletion so we don't
    // synthesise a del marker whose text contains a sentinel.
    const docLen = s.doc.length;
    const m = parseAll(s.doc.toString())[0];
    // Start inside marker text, end past the marker entirely.
    const before = s.doc.toString();
    const next = applyChange(s, { changes: { from: m.textFrom, to: docLen, insert: '' } });
    expect(next.doc.toString()).toBe(before);
  });

  it('refuses a deletion that fully encloses a marker', () => {
    on = true;
    let s = makeState('XYZ');
    s = applyChange(s, { changes: { from: 1, to: 2, insert: 'q' } });
    // Doc: X<ins:q>Z. Now select [0..end] and try to delete.
    const before = s.doc.toString();
    const next = applyChange(s, { changes: { from: 0, to: s.doc.length, insert: '' } });
    expect(next.doc.toString()).toBe(before);
  });

  it('still allows a deletion that touches no markers', () => {
    on = true;
    let s = makeState('hello world');
    // Insert a marker at the end so the doc HAS a marker but the
    // deletion target doesn't touch it.
    s = applyChange(s, { changes: { from: 11, to: 11, insert: '!' } });
    const before = s.doc.toString();
    // Delete 'world' (positions 6..11 in original — still 6..11 in
    // current doc because the marker was added past position 11).
    const next = applyChange(s, { changes: { from: 6, to: 11, insert: '' } });
    expect(next.doc.toString()).not.toBe(before);
    // 'world' was wrapped as a del marker, so the doc grew, not shrunk.
    const markers = parseAll(next.doc.toString());
    expect(markers.find((m) => m.text === 'world')).toBeTruthy();
  });

  it('a backspace whose deletion overlaps a del marker never corrupts the marker', () => {
    on = true;
    let s = makeState('abcdef');
    // Wrap 'cd' as a del marker. Cursor lands at the del marker's
    // m.from after the merge — the position where caretLeftSkipBoundaries
    // would route a follow-up backspace to extend the marker.
    s = applyChange(s, { changes: { from: 2, to: 4, insert: '' } });
    const m = parseAll(s.doc.toString())[0];
    // Apply a deletion fully inside the marker's inner text. The filter
    // must NOT inject a fresh del marker into the middle of m (which
    // would stop the outer header's length field from matching the
    // actual inner-text bytes). Either it rejects, or it extends m
    // — both leave parsing intact.
    const next = applyChange(s, { changes: { from: m.textTo - 1, to: m.textTo, insert: '' } });
    const after = parseAll(next.doc.toString());
    expect(after).toHaveLength(1);
    expect(after[0].type).toBe('del');
    // The marker's text is still well-formed: the parser found exactly
    // one marker spanning the whole syntax block.
  });

  it('typing at the textTo boundary of an own ins marker grows that marker (visually identical to m.to)', () => {
    on = true;
    let s = makeState('abc');
    s = applyChange(s, { changes: { from: 1, to: 2, insert: 'q' } });
    // Doc: a<ins:q>c. textTo and m.to collapse onto the same visible
    // spot since the closing sentinel has zero width — a click that
    // landed at textTo must behave like one at m.to and extend the
    // marker, not get rejected and not corrupt the marker.
    const m = parseAll(s.doc.toString())[0];
    const next = applyChange(s, { changes: { from: m.textTo, to: m.textTo, insert: 'X' } });
    const markers = parseAll(next.doc.toString());
    expect(markers).toHaveLength(2); // grown ins + del('b')
    const ins = markers.find((mm) => mm.type === 'ins');
    expect(ins.text).toBe('qX');
  });

  it('typing in the gap between two adjacent ins markers extends the LEFT one', () => {
    on = true;
    // Build doc with two distinct ins markers back-to-back: type 'a',
    // move past, type 'b' as a separate marker. Easiest: directly seed
    // the doc with two markers via raw applyChange + skip annotation.
    let s = makeState('');
    // Two separate transactions so they DON'T merge into one marker.
    s = applyChange(s, { changes: { from: 0, to: 0, insert: 'a' } });
    // Move caret away then back so the next keystroke isn't at the
    // merge point — we explicitly want two separate markers.
    const m1 = parseAll(s.doc.toString())[0];
    s = applyChange(s, {
      // Insert 'b' at m1.from (before m1) so it's a separate marker.
      changes: { from: m1.from, to: m1.from, insert: 'b' },
    });
    const markers = parseAll(s.doc.toString());
    expect(markers).toHaveLength(2);
    // The second marker now sits before the first. Their boundary is
    // at markers[0].to === markers[1].from. Type 'X' at the interior
    // boundary on the LEFT marker's side (markers[0].textTo): should
    // grow markers[0], not corrupt either.
    const interior = markers[0].textTo;
    const next = applyChange(s, { changes: { from: interior, to: interior, insert: 'X' } });
    const after = parseAll(next.doc.toString());
    expect(after).toHaveLength(2);
    // The marker at the same start as markers[0] grew by one char.
    const grown = after.find((mm) => mm.from === markers[0].from);
    expect(grown.text.length).toBe(markers[0].text.length + 1);
    expect(grown.text.endsWith('X')).toBe(true);
  });

  it('ignores transactions tagged with the skip annotation', () => {
    on = true;
    const s = makeState('abc');
    // A transaction explicitly marked as a skip — used by accept/reject
    // and remote OT applies — should pass through as plain content.
    const next = applyChange(s, {
      changes: { from: 3, to: 3, insert: 'X' },
      annotations: tcMarkerSkipAnnotation.of(true),
    });
    expect(next.doc.toString()).toBe('abcX');
    expect(parseAll(next.doc.toString())).toEqual([]);
  });
});
