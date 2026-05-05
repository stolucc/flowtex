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
