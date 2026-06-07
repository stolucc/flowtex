import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { makeAnchorBytes, resolveAnchor } from '../services/yjsAnchors.js';

function freshDocWith(text) {
  const ydoc = new Y.Doc();
  ydoc.getText('content').insert(0, text);
  return ydoc;
}

describe('makeAnchorBytes', () => {
  it('returns a Buffer for a valid index', () => {
    const ydoc = freshDocWith('hello world');
    const bytes = makeAnchorBytes(ydoc.getText('content'), 6);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('clamps index past the end of the text', () => {
    const ydoc = freshDocWith('abc');
    const bytes = makeAnchorBytes(ydoc.getText('content'), 999);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(resolveAnchor(ydoc, bytes)).toBe(3);
  });

  it('returns null for non-integer / negative / NaN index', () => {
    const ydoc = freshDocWith('abc');
    const t = ydoc.getText('content');
    expect(makeAnchorBytes(t, -1)).toBeNull();
    expect(makeAnchorBytes(t, 1.5)).toBeNull();
    expect(makeAnchorBytes(t, NaN)).toBeNull();
    expect(makeAnchorBytes(t, undefined)).toBeNull();
  });

  it('returns null when ytext is falsy', () => {
    expect(makeAnchorBytes(null, 0)).toBeNull();
    expect(makeAnchorBytes(undefined, 0)).toBeNull();
  });
});

describe('resolveAnchor', () => {
  it('round-trips the original index when the doc is unchanged', () => {
    const ydoc = freshDocWith('hello world');
    const bytes = makeAnchorBytes(ydoc.getText('content'), 6);
    expect(resolveAnchor(ydoc, bytes)).toBe(6);
  });

  it('handles Uint8Array input as well as Buffer', () => {
    const ydoc = freshDocWith('hello world');
    const bytes = makeAnchorBytes(ydoc.getText('content'), 6);
    const u8 = new Uint8Array(bytes);
    expect(resolveAnchor(ydoc, u8)).toBe(6);
  });

  it('returns null on falsy input but never throws on random bytes', () => {
    const ydoc = freshDocWith('abc');
    expect(resolveAnchor(ydoc, null)).toBeNull();
    expect(resolveAnchor(null, Buffer.from([1, 2, 3]))).toBeNull();
    // Random bytes may resolve to a meaningless-but-numeric index;
    // the important guarantee is that the helper doesn't throw and
    // returns either a number or null -- never a thrown exception
    // that would crash the comment-load path.
    const garbage = resolveAnchor(ydoc, Buffer.from([1, 2, 3]));
    expect(garbage === null || typeof garbage === 'number').toBe(true);
  });
});

describe('anchor survival under concurrent edits', () => {
  it('shifts forward when text is inserted BEFORE the anchor', () => {
    const ydoc = freshDocWith('the quick fox');
    // anchor at the start of "fox" (index 10)
    const startBytes = makeAnchorBytes(ydoc.getText('content'), 10);
    const endBytes = makeAnchorBytes(ydoc.getText('content'), 13);

    // Insert "brown " (6 chars) BEFORE "fox" -> shifts fox to 16..19
    ydoc.getText('content').insert(10, 'brown ');
    expect(ydoc.getText('content').toString()).toBe('the quick brown fox');

    expect(resolveAnchor(ydoc, startBytes)).toBe(16);
    expect(resolveAnchor(ydoc, endBytes)).toBe(19);
  });

  it('END anchor with side=left does NOT grow when text is inserted at the boundary', () => {
    // Comment span is [start, end). For the END anchor we want
    // side='left' so typing immediately after the comment doesn't
    // extend the highlighted range.
    const ydoc = freshDocWith('the fox jumped');
    const startBytes = makeAnchorBytes(ydoc.getText('content'), 4);
    const endBytes = makeAnchorBytes(ydoc.getText('content'), 7, { side: 'left' });

    ydoc.getText('content').insert(7, ' and');
    expect(ydoc.getText('content').toString()).toBe('the fox and jumped');

    expect(resolveAnchor(ydoc, startBytes)).toBe(4);
    // With side='left', the end anchor sticks to the original char
    // at index 6 and stays at index 7 in the new doc.
    expect(resolveAnchor(ydoc, endBytes)).toBe(7);
  });

  it('END anchor with default (side=right) DOES grow when text is inserted at the boundary', () => {
    // Documents the contrasting case for completeness.
    const ydoc = freshDocWith('the fox jumped');
    const endBytes = makeAnchorBytes(ydoc.getText('content'), 7); // default side='right'

    ydoc.getText('content').insert(7, ' and');
    // Anchor moves forward by the length of the insertion -- the
    // character it tracks (' ' originally at index 7) is now at 11.
    expect(resolveAnchor(ydoc, endBytes)).toBe(11);
  });

  it('comment span [start, end) grows when text is inserted INSIDE it', () => {
    // Realistic comment use: with start=right and end=left, a typed
    // character INSIDE the span extends the end anchor and leaves
    // the start anchor pinned.
    const ydoc = freshDocWith('abc DEF ghi');
    // Highlight "DEF" -> [4, 7)
    const start = makeAnchorBytes(ydoc.getText('content'), 4);
    const end = makeAnchorBytes(ydoc.getText('content'), 7, { side: 'left' });

    // Insert "X" in the middle of "DEF" -> "abc DXEF ghi"
    ydoc.getText('content').insert(5, 'X');

    expect(resolveAnchor(ydoc, start)).toBe(4);
    expect(resolveAnchor(ydoc, end)).toBe(8);
  });

  it('survives deletion of text before the anchor', () => {
    const ydoc = freshDocWith('the brown fox');
    // anchor at "fox" (index 10..13)
    const startBytes = makeAnchorBytes(ydoc.getText('content'), 10);
    const endBytes = makeAnchorBytes(ydoc.getText('content'), 13);

    // Delete "brown " (6 chars) -> "the fox"
    ydoc.getText('content').delete(4, 6);
    expect(ydoc.getText('content').toString()).toBe('the fox');

    expect(resolveAnchor(ydoc, startBytes)).toBe(4);
    expect(resolveAnchor(ydoc, endBytes)).toBe(7);
  });

  it('survives a CRDT-style merge from another client', () => {
    // Simulate two concurrent users: peer A places a comment anchor,
    // peer B inserts text BEFORE the anchored span, then A merges B's
    // updates -- the anchor's index moves to reflect B's insertion.
    const a = freshDocWith('hello world');
    const b = new Y.Doc();
    Y.applyUpdateV2(b, Y.encodeStateAsUpdateV2(a));

    // A captures an anchor at index 6 (the 'w' of 'world').
    const aAnchor = makeAnchorBytes(a.getText('content'), 6);

    // B inserts ", dear " before 'world' (without seeing A yet).
    b.getText('content').insert(5, ', dear');
    expect(b.getText('content').toString()).toBe('hello, dear world');

    // A merges B's changes.
    Y.applyUpdateV2(a, Y.encodeStateAsUpdateV2(b));

    // Anchor should resolve to the same 'w' in A's view (now index 12).
    expect(resolveAnchor(a, aAnchor)).toBe(12);
  });

  it('two anchors flanking a span both move together when text is inserted before', () => {
    const ydoc = freshDocWith('abcdef');
    const start = makeAnchorBytes(ydoc.getText('content'), 2); // 'c'
    const end = makeAnchorBytes(ydoc.getText('content'), 4);   // 'e'
    ydoc.getText('content').insert(0, 'XX');
    // 'c' is now at index 4, 'e' at index 6.
    expect(resolveAnchor(ydoc, start)).toBe(4);
    expect(resolveAnchor(ydoc, end)).toBe(6);
  });
});
