import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Correct collaborative editing across MULTIPLE web instances on one file.
//
// Faithful hermetic model of the cluster data flow (no Redis needed):
//   - the canonical Y.Doc room (services/yjsRoom.js) is what the worker
//     tier owns — the single source of truth every instance routes to;
//   - each "client" is a Y.Doc (as the browser binding holds), attached
//     to a web instance;
//   - an edit is delivered two ways, exactly as the real system does:
//       1. applyUpdate(P,F,delta)  → the worker room  (the XADD path)
//       2. Y.applyUpdateV2(peer,delta) for every other client (the Redis
//          pub/sub fan-out that re-broadcasts to peer instances' clients)
//
// The guarantees these tests pin: edits from clients on DIFFERENT
// instances converge, convergence is independent of delivery order
// (Redis fan-out gives no cross-instance ordering), a late joiner on any
// instance catches up from the canonical state, and a client that had to
// seed locally (offline / an instance that couldn't reach the worker)
// still converges thanks to the deterministic seed.

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
  _clearRooms,
  _testing,
} from '../services/yjsRoom.js';

const P = 'project-A';
const F = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers(); // swallow the room's snapshot debounce timers
  _clearRooms();
});
afterEach(() => {
  _clearRooms();
  vi.useRealTimers();
});

/** Stand up the canonical room seeded from `content` (what acquireRoom
 *  does on first open — server-side, once, for the whole cluster). */
async function openRoomWith(content) {
  db.get.mockResolvedValueOnce({ content_yjs: null, content });
  await acquireRoom(P, F);
}

/** A client "joins" (on whatever instance) by applying the canonical
 *  state the server replies with — the yjs-request-state round trip. */
function joinClient() {
  const doc = new Y.Doc();
  const state = encodeStateAsUpdate(P, F);
  if (state) Y.applyUpdateV2(doc, new Uint8Array(state));
  return doc;
}

const text = (doc) => doc.getText('content').toString();

/** Read the canonical room's text back through a fresh decode. */
function workerText() {
  const d = new Y.Doc();
  Y.applyUpdateV2(d, new Uint8Array(encodeStateAsUpdate(P, F)));
  return d.getText('content').toString();
}

/** Make an edit on `doc` and return the update it produced (one per tx). */
function edit(doc, mutate) {
  let delta = null;
  const h = (u) => { delta = u; };
  doc.on('updateV2', h);
  doc.transact(() => mutate(doc.getText('content')));
  doc.off('updateV2', h);
  return delta;
}

/** Deliver an edit as the cluster does: to the worker room AND to every
 *  other client (peer instances' fan-out). */
function deliver(delta, from, clients) {
  applyUpdate(P, F, delta);
  for (const c of clients) if (c !== from) Y.applyUpdateV2(c, new Uint8Array(delta));
}

describe('multi-instance editing — convergence', () => {
  it('concurrent edits from clients on two instances converge and match the worker', async () => {
    await openRoomWith('shared');
    const a = joinClient(); // instance-1 client
    const b = joinClient(); // instance-2 client
    expect(text(a)).toBe('shared');
    expect(text(b)).toBe('shared');

    // Concurrent: both edit against the same base before either arrives.
    const da = edit(a, (t) => t.insert(0, 'A:'));
    const db2 = edit(b, (t) => t.insert(t.length, ':B'));

    deliver(da, a, [a, b]);
    deliver(db2, b, [a, b]);

    expect(text(a)).toBe(text(b));        // the two instances agree
    expect(text(a)).toBe(workerText());   // and agree with the canonical room
    expect(text(a)).toContain('A:');
    expect(text(a)).toContain(':B');
  });

  it('conflicting insert+delete on the same region still converges', async () => {
    await openRoomWith('hello world');
    const a = joinClient();
    const b = joinClient();

    const da = edit(a, (t) => t.insert(5, ' brave'));  // "hello brave world"
    const db2 = edit(b, (t) => t.delete(0, 5));         // "... world" (drop "hello")

    deliver(da, a, [a, b]);
    deliver(db2, b, [a, b]);

    expect(text(a)).toBe(text(b));
    expect(text(a)).toBe(workerText());
  });

  it('convergence is independent of cross-instance delivery ORDER', async () => {
    await openRoomWith('base');
    const src = [joinClient(), joinClient(), joinClient()];
    // Three concurrent edits, captured against the same base.
    const deltas = [
      edit(src[0], (t) => t.insert(0, '1')),
      edit(src[1], (t) => t.insert(t.length, '2')),
      edit(src[2], (t) => t.insert(2, '3')),
    ];

    // Two fresh receivers get the SAME set of updates in DIFFERENT orders
    // (Redis pub/sub gives no ordering guarantee across instances).
    const r1 = joinClient();
    const r2 = joinClient();
    for (const d of deltas) Y.applyUpdateV2(r1, new Uint8Array(d));
    for (const d of [deltas[2], deltas[0], deltas[1]]) Y.applyUpdateV2(r2, new Uint8Array(d));

    expect(text(r1)).toBe(text(r2)); // order didn't matter → identical
  });

  it('a late joiner on any instance catches up from the canonical state', async () => {
    await openRoomWith('doc');
    const a = joinClient();
    deliver(edit(a, (t) => t.insert(t.length, '-edited')), a, [a]);

    // New client connects (to any instance) after the edit — joins from
    // the worker's current state.
    const late = joinClient();
    expect(text(late)).toBe('doc-edited');
    expect(text(late)).toBe(workerText());

    // …and can then edit and stay converged.
    deliver(edit(late, (t) => t.insert(0, 'NEW ')), late, [a, late]);
    expect(text(a)).toBe(text(late));
    expect(text(a)).toBe('NEW doc-edited');
  });

  it('a locally-seeded client (offline / worker-unreachable instance) still converges', async () => {
    await openRoomWith('shared text');
    const served = joinClient(); // got canonical state from the worker

    // This client couldn't reach the worker (dropped yjs-state), so its
    // instance fell back to seeding the Y.Doc locally from the same file
    // content. The deterministic SEED_CLIENT_ID makes that base identical
    // to the worker's, so their edits interoperate (the split-brain fix).
    const local = new Y.Doc();
    _testing.applyDeterministicSeed(local, 'shared text');
    expect(text(local)).toBe('shared text');

    const dLocal = edit(local, (t) => t.insert(0, 'X '));
    const dServed = edit(served, (t) => t.insert(t.length, ' Y'));

    // Exchange (both directions) — as fan-out would.
    Y.applyUpdateV2(served, new Uint8Array(dLocal));
    Y.applyUpdateV2(local, new Uint8Array(dServed));
    applyUpdate(P, F, dLocal);
    applyUpdate(P, F, dServed);

    expect(text(local)).toBe(text(served)); // converged, not split-brained
    expect(text(local)).toBe(workerText());
    expect(text(local)).toContain('X ');
    expect(text(local)).toContain(' Y');
  });

  it('the worker room persists the converged text (files.content stays in sync)', async () => {
    await openRoomWith('start');
    const a = joinClient();
    const b = joinClient();
    deliver(edit(a, (t) => t.insert(t.length, '-a')), a, [a, b]);
    deliver(edit(b, (t) => t.insert(t.length, '-b')), b, [a, b]);

    db.run.mockResolvedValue(undefined);
    // Fire the debounced snapshot; the persisted plain-text column must
    // reflect the merged document, not one instance's partial view.
    await vi.advanceTimersByTimeAsync(2500);

    const snap = db.run.mock.calls.find(([sql]) => /UPDATE files SET content_yjs/.test(sql));
    expect(snap).toBeDefined();
    const persistedText = snap[1][1]; // params: [blob, text, fileId, projectId]
    expect(persistedText).toBe(workerText());
    expect(persistedText).toContain('-a');
    expect(persistedText).toContain('-b');
  });
});
