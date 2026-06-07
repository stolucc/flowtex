import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db.js', () => ({
  default: { get: vi.fn(), run: vi.fn(), all: vi.fn() },
}));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import db from '../db.js';
import * as Y from 'yjs';
import { makeAnchorBytes, resolveAnchor, backfillCommentAnchors } from '../services/yjsAnchors.js';

beforeEach(() => { vi.clearAllMocks(); });

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

describe('backfillCommentAnchors (phase 4.5)', () => {
  const P = 'project-A';
  const F = 'file-A';

  it('captures anchors for rows missing them and round-trips through resolveAnchor', async () => {
    const ydoc = freshDocWith('the quick brown fox jumped');
    db.all.mockResolvedValueOnce([
      { id: 'c1', from_pos: 4, to_pos: 9 },   // "quick"
      { id: 'c2', from_pos: 16, to_pos: 19 }, // "fox"
    ]);
    db.run.mockResolvedValue(undefined);

    const migrated = await backfillCommentAnchors(P, F, ydoc);
    expect(migrated).toBe(2);
    expect(db.run).toHaveBeenCalledTimes(2);

    // Each UPDATE supplies (startBytes, endBytes, id) -- decode the
    // first row's anchors and verify they resolve back to the same
    // indices.
    const [, params1] = db.run.mock.calls[0];
    const startIdx = resolveAnchor(ydoc, params1[0]);
    const endIdx = resolveAnchor(ydoc, params1[1]);
    expect(startIdx).toBe(4);
    expect(endIdx).toBe(9);
  });

  it('writes idempotent UPDATE that refuses to overwrite existing anchors', async () => {
    const ydoc = freshDocWith('abc');
    db.all.mockResolvedValueOnce([{ id: 'c1', from_pos: 0, to_pos: 3 }]);
    db.run.mockResolvedValue(undefined);

    await backfillCommentAnchors(P, F, ydoc);
    const [sql] = db.run.mock.calls[0];
    // Race-safety: even after our SELECT identified a NULL-anchor row,
    // a concurrent comment-create could fill it. The UPDATE filter
    // makes that case a no-op rather than a clobber.
    expect(sql).toMatch(/anchor_start_yjs IS NULL OR anchor_end_yjs IS NULL/);
  });

  it('returns 0 and does no UPDATE when nothing needs back-filling', async () => {
    const ydoc = freshDocWith('abc');
    db.all.mockResolvedValueOnce([]);
    const migrated = await backfillCommentAnchors(P, F, ydoc);
    expect(migrated).toBe(0);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('logs and returns 0 when the SELECT throws -- never propagates', async () => {
    const ydoc = freshDocWith('abc');
    db.all.mockRejectedValueOnce(new Error('boom'));
    const migrated = await backfillCommentAnchors(P, F, ydoc);
    expect(migrated).toBe(0);
  });

  it('returns 0 immediately when ydoc / projectId / fileId is falsy', async () => {
    expect(await backfillCommentAnchors(null, F, freshDocWith('abc'))).toBe(0);
    expect(await backfillCommentAnchors(P, null, freshDocWith('abc'))).toBe(0);
    expect(await backfillCommentAnchors(P, F, null)).toBe(0);
    expect(db.all).not.toHaveBeenCalled();
  });

  it('survives concurrent edits -- anchored row resolves to the right character after a merge', async () => {
    const a = freshDocWith('the quick fox');
    db.all.mockResolvedValueOnce([{ id: 'c1', from_pos: 10, to_pos: 13 }]);
    db.run.mockResolvedValue(undefined);

    await backfillCommentAnchors(P, F, a);
    const [, params] = db.run.mock.calls[0];
    const startBytes = params[0];
    const endBytes = params[1];

    // Peer inserts "brown " before "fox".
    a.getText('content').insert(10, 'brown ');
    expect(a.getText('content').toString()).toBe('the quick brown fox');

    // Anchors should follow the original "fox" characters (now at 16..19).
    expect(resolveAnchor(a, startBytes)).toBe(16);
    expect(resolveAnchor(a, endBytes)).toBe(19);
  });
});
