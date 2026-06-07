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

  it('increments refCount on repeated acquire', async () => {
    db.get.mockResolvedValueOnce({ content_yjs: null, content: '' });
    const r1 = await acquireRoom(P, F);
    const r2 = await acquireRoom(P, F);
    expect(r1).toBe(r2);
    expect(r1.refCount).toBe(2);
    // Only one DB lookup -- second acquire hit the cache.
    expect(db.get).toHaveBeenCalledTimes(1);
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
    expect(params[1]).toBe(F);
    expect(params[2]).toBe(P);
    expect(Buffer.isBuffer(params[0])).toBe(true);
    // The persisted blob should reconstruct the seed when loaded.
    const fresh = new Y.Doc();
    Y.applyUpdateV2(fresh, new Uint8Array(params[0]));
    expect(fresh.getText('content').toString()).toBe('seed');
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
