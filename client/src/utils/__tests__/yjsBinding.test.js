import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { createYjsBinding, isYjsSyncEnabled, __testing } from '../yjsBinding.js';

describe('isYjsSyncEnabled (post-phase-6 default = ON)', () => {
  const origWindow = globalThis.window;
  beforeEach(() => {
    globalThis.window = { location: { search: '' }, localStorage: { store: {} } };
    globalThis.window.localStorage.getItem = (k) => globalThis.window.localStorage.store[k] ?? null;
    globalThis.window.localStorage.setItem = (k, v) => { globalThis.window.localStorage.store[k] = String(v); };
  });
  afterEach(() => { globalThis.window = origWindow; });

  it('defaults to TRUE when no flag is set (phase 6 cutover)', () => {
    expect(isYjsSyncEnabled()).toBe(true);
  });

  it('honours ?yjs=0 as an explicit per-tab opt-out', () => {
    globalThis.window.location.search = '?yjs=0';
    expect(isYjsSyncEnabled()).toBe(false);
  });

  it('?yjs=1 keeps it enabled (the new default, so this is just an explicit yes)', () => {
    globalThis.window.location.search = '?yjs=1';
    expect(isYjsSyncEnabled()).toBe(true);
  });

  it('URL ?yjs=0 wins over a localStorage opt-in', () => {
    globalThis.window.location.search = '?yjs=0';
    globalThis.window.localStorage.setItem('flowtex-yjs-sync', '1');
    expect(isYjsSyncEnabled()).toBe(false);
  });

  it('localStorage flowtex-yjs-sync=0 is the persistent opt-out', () => {
    globalThis.window.localStorage.setItem('flowtex-yjs-sync', '0');
    expect(isYjsSyncEnabled()).toBe(false);
  });

  it('does not throw when localStorage access fails and stays ON', () => {
    globalThis.window.localStorage.getItem = () => { throw new Error('private mode'); };
    expect(() => isYjsSyncEnabled()).not.toThrow();
    expect(isYjsSyncEnabled()).toBe(true);
  });

  it('is FORCED OFF for encrypted projects (content_yjs would be plaintext)', () => {
    // Even with everything else pointing to ON, an encrypted project
    // must not use Y.js — the CRDT column is plaintext and seeding from
    // ciphertext content would corrupt the editor.
    expect(isYjsSyncEnabled({ encrypted: true })).toBe(false);
  });

  it('encrypted=false leaves the normal ON default intact', () => {
    expect(isYjsSyncEnabled({ encrypted: false })).toBe(true);
  });

  it('encrypted flag overrides even an explicit ?yjs=1 enable', () => {
    globalThis.window.location = /** @type {any} */ ({ search: '?yjs=1' });
    expect(isYjsSyncEnabled({ encrypted: true })).toBe(false);
  });
});

describe('createYjsBinding base64 round-trip', () => {
  it('encodes and decodes arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 200, 255]);
    const b64 = __testing.bytesToBase64(bytes);
    const decoded = __testing.base64ToBytes(b64);
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });
});

describe('deterministic seed — independent seeds converge (split-brain fix)', () => {
  it('two docs seeded from the same text encode to byte-identical state', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    // Different live clientIDs (as real tabs have)...
    a.clientID = 111;
    b.clientID = 222;
    __testing.applyDeterministicSeed(a, '\\section{Hi}', 'seed');
    __testing.applyDeterministicSeed(b, '\\section{Hi}', 'seed');
    const sa = Y.encodeStateAsUpdateV2(a);
    const sb = Y.encodeStateAsUpdateV2(b);
    expect(Array.from(sa)).toEqual(Array.from(sb));
  });

  it('a delta from one independently-seeded binding integrates on the other (no split-brain)', () => {
    // Simulates the deployed bug: server state never arrived, so BOTH
    // tabs fell back to a local seed. With the old random-clientID seed
    // the bases differed and deltas could not integrate. With the
    // deterministic seed they converge.
    const a = createYjsBinding({ fileId: 'f1', initialText: 'hello', sendWs: vi.fn(), originId: 'tab-A', sync: 'phase1' });
    const b = createYjsBinding({ fileId: 'f1', initialText: 'hello', sendWs: vi.fn(), originId: 'tab-B', sync: 'phase1' });

    // Tab A types ' world' at the end; capture the broadcast delta.
    let sent = null;
    a.ydoc.on('updateV2', (u) => { sent = __testing.bytesToBase64(u); });
    a.ytext.insert(5, ' world');
    expect(sent).not.toBeNull();

    // Tab B applies A's delta — it must integrate, not get dropped as pending.
    b.applyRemoteUpdate(sent, 'tab-A');
    expect(b.ytext.toString()).toBe('hello world');

    a.destroy();
    b.destroy();
  });
});

describe('createYjsBinding sync semantics (phase 1 fallback)', () => {
  it('seeds the Y.Text from initialText without broadcasting', () => {
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: 'hello world', sendWs, originId: 'tab-A', sync: 'phase1' });
    expect(b.ytext.toString()).toBe('hello world');
    expect(sendWs).not.toHaveBeenCalled();
    b.destroy();
  });

  it('skips seeding when the doc already has content (peer update arrived first)', () => {
    const sendWs = vi.fn();
    const peer = new Y.Doc();
    peer.getText('content').insert(0, 'peer text');
    const update = Y.encodeStateAsUpdateV2(peer);
    const updateB64 = __testing.bytesToBase64(update);

    const b = createYjsBinding({ fileId: 'f1', initialText: '', sendWs, originId: 'tab-A', sync: 'phase1' });
    b.applyRemoteUpdate(updateB64);
    expect(b.ytext.toString()).toBe('peer text');
    b.destroy();
  });

  it('broadcasts local edits as yjs-update WS messages', () => {
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: '', sendWs, originId: 'tab-A', sync: 'phase1' });
    b.ytext.insert(0, 'abc');
    expect(sendWs).toHaveBeenCalledTimes(1);
    const sent = sendWs.mock.calls[0][0];
    expect(sent.type).toBe('yjs-update');
    expect(sent.fileId).toBe('f1');
    expect(sent.originId).toBe('tab-A');
    expect(typeof sent.update).toBe('string');
    b.destroy();
  });

  it('does NOT re-broadcast updates that came in from the wire', () => {
    const sendWsA = vi.fn();
    const sendWsB = vi.fn();
    const a = createYjsBinding({ fileId: 'f1', initialText: '', sendWs: sendWsA, originId: 'tab-A', sync: 'phase1' });
    const b = createYjsBinding({ fileId: 'f1', initialText: '', sendWs: sendWsB, originId: 'tab-B', sync: 'phase1' });

    a.ytext.insert(0, 'from-a');
    expect(sendWsA).toHaveBeenCalledTimes(1);
    const aSent = sendWsA.mock.calls[0][0];

    sendWsB.mockClear();
    b.applyRemoteUpdate(aSent.update, 'tab-A');
    expect(sendWsB).not.toHaveBeenCalled();
    expect(b.ytext.toString()).toBe('from-a');

    a.destroy();
    b.destroy();
  });

  it('ignores self-echoes (same originId)', () => {
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: 'hello', sendWs, originId: 'tab-A', sync: 'phase1' });
    const other = new Y.Doc();
    other.getText('content').insert(0, 'INJECT');
    const otherUpdate = __testing.bytesToBase64(Y.encodeStateAsUpdateV2(other));

    b.applyRemoteUpdate(otherUpdate, 'tab-A');  // self-echo
    expect(b.ytext.toString()).toBe('hello');
    b.destroy();
  });

  it('cleans up the updateV2 listener on destroy', () => {
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: '', sendWs, originId: 'tab-A', sync: 'phase1' });
    b.ytext.insert(0, 'first');
    expect(sendWs).toHaveBeenCalledTimes(1);
    b.destroy();
    sendWs.mockClear();
    expect(sendWs).not.toHaveBeenCalled();
  });
});

describe('createYjsBinding sync semantics (phase 2 — server-canonical)', () => {
  it('does NOT seed from initialText (server is canonical)', () => {
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: 'hello', sendWs, originId: 'tab-A' });
    expect(b.ytext.toString()).toBe(''); // empty until applyRemoteState
    b.destroy();
  });

  it('immediately requests state on creation', () => {
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: '', sendWs, originId: 'tab-A' });
    const calls = sendWs.mock.calls.map((c) => c[0]);
    const req = calls.find((m) => m.type === 'yjs-request-state');
    expect(req).toBeDefined();
    expect(req.fileId).toBe('f1');
    b.destroy();
  });

  it('applyRemoteState fills the doc from the server payload', () => {
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: '', sendWs, originId: 'tab-A' });
    const server = new Y.Doc();
    server.getText('content').insert(0, 'server canonical');
    const stateB64 = __testing.bytesToBase64(Y.encodeStateAsUpdateV2(server));

    b.applyRemoteState(stateB64);
    expect(b.ytext.toString()).toBe('server canonical');
    b.destroy();
  });
});

describe('createYjsBinding phase 2 — fallback seed (editor never stuck blank)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('seeds from initialText if no yjs-state arrives within the grace window', () => {
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: 'fallback content', sendWs, originId: 'tab-A' });
    // Still blank right after creation (waiting on the server).
    expect(b.ytext.toString()).toBe('');
    vi.advanceTimersByTime(1500);
    // Grace window elapsed with no state → local seed shows content.
    expect(b.ytext.toString()).toBe('fallback content');
    b.destroy();
  });

  it('does NOT broadcast the fallback seed (server already has the same text)', () => {
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: 'fallback content', sendWs, originId: 'tab-A' });
    sendWs.mockClear(); // drop the initial yjs-request-state
    vi.advanceTimersByTime(1500);
    const broadcasts = sendWs.mock.calls.map((c) => c[0]).filter((m) => m.type === 'yjs-update');
    expect(broadcasts).toHaveLength(0);
    b.destroy();
  });

  it('a server state that arrives in time wins and cancels the fallback', () => {
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: 'fallback content', sendWs, originId: 'tab-A' });
    const server = new Y.Doc();
    server.getText('content').insert(0, 'server canonical');
    b.applyRemoteState(__testing.bytesToBase64(Y.encodeStateAsUpdateV2(server)));
    expect(b.ytext.toString()).toBe('server canonical');
    // Fallback must NOT append on top after the window passes (no doubling).
    vi.advanceTimersByTime(1500);
    expect(b.ytext.toString()).toBe('server canonical');
    b.destroy();
  });

  it('a server state that arrives LATE is ignored once the fallback seeded (no doubling)', () => {
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: 'fallback content', sendWs, originId: 'tab-A' });
    vi.advanceTimersByTime(1500); // fallback seeds first
    expect(b.ytext.toString()).toBe('fallback content');
    // Same-content server state shows up late — must not duplicate text.
    const server = new Y.Doc();
    server.getText('content').insert(0, 'fallback content');
    b.applyRemoteState(__testing.bytesToBase64(Y.encodeStateAsUpdateV2(server)));
    expect(b.ytext.toString()).toBe('fallback content');
    b.destroy();
  });

  it('destroy clears the pending fallback timer (no seed after teardown)', () => {
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: 'fallback content', sendWs, originId: 'tab-A' });
    b.destroy();
    vi.advanceTimersByTime(1500);
    expect(b.ytext.toString()).toBe('');
  });

  it('an EMPTY server state does NOT mark hydrated — a later real state still applies', () => {
    // Guards the `if (ytext.length > 0) hydrated = true` line: an empty
    // reply must not latch hydrated, or the real state would be ignored.
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: 'x', sendWs, originId: 'tab-A' });
    b.applyRemoteState(__testing.bytesToBase64(Y.encodeStateAsUpdateV2(new Y.Doc()))); // empty
    expect(b.ytext.toString()).toBe('');
    const server = new Y.Doc();
    server.getText('content').insert(0, 'real state');
    b.applyRemoteState(__testing.bytesToBase64(Y.encodeStateAsUpdateV2(server)));
    expect(b.ytext.toString()).toBe('real state');
    b.destroy();
  });

  it('arms NO fallback when initialText is empty (nothing to seed)', () => {
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: '', sendWs, originId: 'tab-A' });
    vi.advanceTimersByTime(1500);
    expect(b.ytext.toString()).toBe('');
    b.destroy();
  });

  it('a delta that fills the doc before the timer cancels the fallback seed (no doubling)', () => {
    // Guards the `ytext.length > 0` arm of the fallback no-op check.
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: 'seed text', sendWs, originId: 'tab-A' });
    const peer = new Y.Doc();
    peer.getText('content').insert(0, 'live delta');
    b.applyRemoteUpdate(__testing.bytesToBase64(Y.encodeStateAsUpdateV2(peer)), 'tab-B');
    expect(b.ytext.toString()).toBe('live delta');
    vi.advanceTimersByTime(1500); // fallback must NOT append 'seed text'
    expect(b.ytext.toString()).toBe('live delta');
    b.destroy();
  });
});
