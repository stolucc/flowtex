import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db.js', () => ({
  default: { get: vi.fn(), run: vi.fn(), all: vi.fn() },
}));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import db from '../db.js';
import * as Y from 'yjs';
import {
  acquireRoom,
  applyUpdate,
  encodeStateAsUpdate,
  releaseRoom,
  _peekRoomCount,
  _peekRoom,
  _clearRooms,
} from '../services/yjsRoom.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  _clearRooms();
});
afterEach(() => {
  _clearRooms();
  vi.useRealTimers();
});

const P = 'project-A';
const F = '00000000-0000-4000-8000-000000000001';

describe('acquireRoom', () => {
  it('returns null when the file row is missing', async () => {
    db.get.mockResolvedValueOnce(null);
    const room = await acquireRoom(P, F);
    expect(room).toBeNull();
    expect(_peekRoomCount()).toBe(0);
  });

  it('creates an empty Y.Doc when content_yjs is NULL and content is empty', async () => {
    db.get.mockResolvedValueOnce({ content_yjs: null, content: '' });
    const room = await acquireRoom(P, F);
    expect(room).not.toBeNull();
    expect(room.refCount).toBe(1);
    expect(room.dirty).toBe(false);
    expect(room.ydoc.getText('content').toString()).toBe('');
    expect(_peekRoomCount()).toBe(1);
  });

  it('seeds the Y.Doc from plain `content` when content_yjs is NULL', async () => {
    db.get.mockResolvedValueOnce({ content_yjs: null, content: '\\section{Hi}' });
    const room = await acquireRoom(P, F);
    expect(room.ydoc.getText('content').toString()).toBe('\\section{Hi}');
    // Seeding marks dirty so the next snapshot persists content_yjs.
    expect(room.dirty).toBe(true);
  });

  it('loads existing content_yjs as the canonical state', async () => {
    // Prepare a peer Y.Doc with known content, encode it, and feed it
    // back as the content_yjs row.
    const peer = new Y.Doc();
    peer.getText('content').insert(0, 'persisted');
    const bytes = Y.encodeStateAsUpdateV2(peer);

    db.get.mockResolvedValueOnce({ content_yjs: Buffer.from(bytes), content: 'IGNORED' });
    const room = await acquireRoom(P, F);
    expect(room.ydoc.getText('content').toString()).toBe('persisted');
    // Not dirty -- we just loaded the canonical state.
    expect(room.dirty).toBe(false);
  });

  it('increments refCount on repeated acquire (second acquire skips DB)', async () => {
    db.get.mockResolvedValue({ content_yjs: null, content: '' });
    const r1 = await acquireRoom(P, F);
    const dbGetBefore = db.get.mock.calls.length;
    const r2 = await acquireRoom(P, F);
    expect(r1).toBe(r2);
    expect(r1.refCount).toBe(2);
    // Second acquire hits the cache -- no additional db.get on the
    // hot path. (The first acquire fires backfill helpers that also
    // call db.get; counting the delta isolates the cache-hit
    // assertion from those.)
    expect(db.get.mock.calls.length).toBe(dbGetBefore);
  });
});

describe('applyUpdate + encodeStateAsUpdate', () => {
  it('applies an update to the room and lets encodeStateAsUpdate replay it', async () => {
    db.get.mockResolvedValueOnce({ content_yjs: null, content: '' });
    await acquireRoom(P, F);

    const peer = new Y.Doc();
    peer.getText('content').insert(0, 'inbound');
    const updateBytes = Y.encodeStateAsUpdateV2(peer);

    applyUpdate(P, F, updateBytes);
    expect(_peekRoom(P, F).ydoc.getText('content').toString()).toBe('inbound');
    expect(_peekRoom(P, F).dirty).toBe(true);

    // The encoded state should reconstruct the same content on a fresh Y.Doc.
    const stateBytes = encodeStateAsUpdate(P, F);
    expect(stateBytes).not.toBeNull();
    const fresh = new Y.Doc();
    Y.applyUpdateV2(fresh, stateBytes);
    expect(fresh.getText('content').toString()).toBe('inbound');
  });

  it('is a no-op when the room does not exist', () => {
    applyUpdate(P, F, new Uint8Array([1, 2, 3]));
    expect(_peekRoomCount()).toBe(0);
    expect(encodeStateAsUpdate(P, F)).toBeNull();
  });
});

describe('data-loss guards', () => {
  it('reseeds from content when persisted content_yjs decodes to EMPTY but content has text', async () => {
    // Simulate a file damaged by a pre-guard empty snapshot: content_yjs
    // is a real (non-zero) buffer that encodes an EMPTY Y.Doc, while the
    // content column still holds the original text.
    const emptyDoc = new Y.Doc();
    const emptyBytes = Y.encodeStateAsUpdateV2(emptyDoc); // non-zero buffer, empty text
    db.get.mockResolvedValueOnce({ content_yjs: Buffer.from(emptyBytes), content: '\\section{Recovered}' });

    const room = await acquireRoom(P, F);
    expect(room.ydoc.getText('content').toString()).toBe('\\section{Recovered}');
    // Reseeded → dirty so the recovered text gets persisted back.
    expect(room.dirty).toBe(true);
  });

  it('persistSnapshot REFUSES to overwrite non-empty content with an empty Y.Doc', async () => {
    // Seed a room from content, then empty it (simulating a transient
    // blank editor emitting a delete-all update), then let the snapshot
    // debounce fire. The destructive UPDATE must NOT run.
    db.get.mockResolvedValueOnce({ content_yjs: null, content: 'important text' });
    await acquireRoom(P, F);
    // Empty the room's Y.Doc.
    const room = _peekRoom(P, F);
    room.ydoc.getText('content').delete(0, room.ydoc.getText('content').length);
    room.dirty = true;
    // The guard re-reads current content to decide.
    db.get.mockResolvedValueOnce({ content: 'important text' });

    db.run.mockClear();
    // scheduleSnapshot was armed by the delete? It wasn't (we mutated
    // directly), so arm + fire the debounce manually.
    room.snapshotTimer = null;
    // Re-trigger via applyUpdate path would re-arm; simplest: advance
    // timers after re-scheduling through a no-op update.
    applyUpdate(P, F, Y.encodeStateAsUpdateV2(new Y.Doc())); // keeps it empty, re-arms timer + dirty
    await vi.advanceTimersByTimeAsync(2500);

    // No UPDATE wrote an empty content over the stored text.
    const destructive = db.run.mock.calls.find(
      ([sql, params]) => /UPDATE files SET content_yjs/.test(sql) && params[1] === '',
    );
    expect(destructive).toBeUndefined();
  });
});

describe('releaseRoom snapshot semantics', () => {
  it('decrements refCount and only tears down on the last release', async () => {
    db.get.mockResolvedValueOnce({ content_yjs: null, content: '' });
    await acquireRoom(P, F);
    await acquireRoom(P, F);

    await releaseRoom(P, F);
    expect(_peekRoomCount()).toBe(1);
    expect(_peekRoom(P, F).refCount).toBe(1);

    await releaseRoom(P, F);
    expect(_peekRoomCount()).toBe(0);
  });

  it('flushes a final snapshot to PG when releasing a dirty room', async () => {
    db.get.mockResolvedValueOnce({ content_yjs: null, content: 'seed' });
    await acquireRoom(P, F);
    // The seed itself marks the room dirty.

    db.run.mockResolvedValueOnce(undefined);
    await releaseRoom(P, F);

    expect(db.run).toHaveBeenCalledTimes(1);
    const [sql, params] = db.run.mock.calls[0];
    expect(sql).toMatch(/UPDATE files SET content_yjs/);
    // Phase 3: snapshot also writes the plain `content` column so
    // non-yjs reads stay in sync. params now have 4 entries:
    //   [content_yjs blob, plain text, fileId, projectId]
    expect(sql).toMatch(/content = \$2/);
    expect(params).toHaveLength(4);
    expect(params[1]).toBe('seed');
    expect(params[2]).toBe(F);
    expect(params[3]).toBe(P);
    expect(Buffer.isBuffer(params[0])).toBe(true);
    // The persisted blob should reconstruct the seed when loaded.
    const fresh = new Y.Doc();
    Y.applyUpdateV2(fresh, new Uint8Array(params[0]));
    expect(fresh.getText('content').toString()).toBe('seed');
  });

  it('snapshot also writes the live text after applied updates', async () => {
    db.get.mockResolvedValueOnce({ content_yjs: null, content: 'before' });
    await acquireRoom(P, F);

    // Apply a peer update that REPLACES the content with "after".
    const peer = new Y.Doc();
    Y.applyUpdateV2(peer, Y.encodeStateAsUpdateV2(_peekRoom(P, F).ydoc));
    peer.getText('content').delete(0, peer.getText('content').length);
    peer.getText('content').insert(0, 'after');
    applyUpdate(P, F, Y.encodeStateAsUpdateV2(peer));

    db.run.mockResolvedValue(undefined);
    await releaseRoom(P, F);

    // The single final snapshot should reflect "after", not "before".
    const finalRunCall = db.run.mock.calls.find(([sql]) => /UPDATE files SET content_yjs/.test(sql));
    expect(finalRunCall).toBeDefined();
    expect(finalRunCall[1][1]).toBe('after');
  });

  it('does not flush a final snapshot when the room is clean', async () => {
    // Pre-persisted state -- loading it does NOT mark the room dirty.
    const peer = new Y.Doc();
    peer.getText('content').insert(0, 'already-on-disk');
    db.get.mockResolvedValueOnce({
      content_yjs: Buffer.from(Y.encodeStateAsUpdateV2(peer)),
      content: '',
    });
    await acquireRoom(P, F);

    await releaseRoom(P, F);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('is a no-op when releasing a never-acquired room', async () => {
    await releaseRoom(P, F);
    expect(db.run).not.toHaveBeenCalled();
  });
});

describe('snapshot debounce', () => {
  it('coalesces multiple updates into one PG write after the debounce window', async () => {
    db.get.mockResolvedValueOnce({ content_yjs: null, content: '' });
    await acquireRoom(P, F);

    db.run.mockResolvedValue(undefined);

    // Three updates in quick succession -- only one snapshot expected.
    for (const text of ['a', 'b', 'c']) {
      const peer = new Y.Doc();
      peer.getText('content').insert(0, text);
      applyUpdate(P, F, Y.encodeStateAsUpdateV2(peer));
    }

    await vi.advanceTimersByTimeAsync(2500);
    expect(db.run).toHaveBeenCalledTimes(1);
  });
});
