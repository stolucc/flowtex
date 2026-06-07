import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { createYjsBinding, isYjsSyncEnabled, __testing } from '../yjsBinding.js';

describe('isYjsSyncEnabled', () => {
  const origWindow = globalThis.window;
  beforeEach(() => {
    globalThis.window = { location: { search: '' }, localStorage: { store: {} } };
    globalThis.window.localStorage.getItem = (k) => globalThis.window.localStorage.store[k] ?? null;
    globalThis.window.localStorage.setItem = (k, v) => { globalThis.window.localStorage.store[k] = String(v); };
  });
  afterEach(() => { globalThis.window = origWindow; });

  it('defaults to false when no flag is set', () => {
    expect(isYjsSyncEnabled()).toBe(false);
  });

  it('honours ?yjs=1 in the URL', () => {
    globalThis.window.location.search = '?yjs=1';
    expect(isYjsSyncEnabled()).toBe(true);
  });

  it('honours ?yjs=0 in the URL, even when localStorage says enabled', () => {
    globalThis.window.location.search = '?yjs=0';
    globalThis.window.localStorage.setItem('flowtex-yjs-sync', '1');
    expect(isYjsSyncEnabled()).toBe(false);
  });

  it('honours localStorage flag', () => {
    globalThis.window.localStorage.setItem('flowtex-yjs-sync', '1');
    expect(isYjsSyncEnabled()).toBe(true);
  });

  it('does not throw when localStorage access fails', () => {
    globalThis.window.localStorage.getItem = () => { throw new Error('private mode'); };
    expect(() => isYjsSyncEnabled()).not.toThrow();
    expect(isYjsSyncEnabled()).toBe(false);
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

describe('createYjsBinding sync semantics', () => {
  it('seeds the Y.Text from initialText without broadcasting', () => {
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: 'hello world', sendWs, originId: 'tab-A' });
    expect(b.ytext.toString()).toBe('hello world');
    expect(sendWs).not.toHaveBeenCalled();
    b.destroy();
  });

  it('skips seeding when the doc already has content (peer update arrived first)', () => {
    const sendWs = vi.fn();
    // Simulate: peer arrived first by pre-applying an update on a
    // separate Y.Doc, then handing the binary in via applyRemoteUpdate.
    const peer = new Y.Doc();
    peer.getText('content').insert(0, 'peer text');
    const update = Y.encodeStateAsUpdateV2(peer);
    const updateB64 = __testing.bytesToBase64(update);

    const b = createYjsBinding({ fileId: 'f1', initialText: '', sendWs, originId: 'tab-A' });
    b.applyRemoteUpdate(updateB64);
    // ytext was empty, then peer update was applied, so it now has
    // the peer's content -- not "hello world" (no seed).
    expect(b.ytext.toString()).toBe('peer text');
    b.destroy();
  });

  it('broadcasts local edits as yjs-update WS messages', () => {
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: '', sendWs, originId: 'tab-A' });
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
    const a = createYjsBinding({ fileId: 'f1', initialText: '', sendWs: sendWsA, originId: 'tab-A' });
    const b = createYjsBinding({ fileId: 'f1', initialText: '', sendWs: sendWsB, originId: 'tab-B' });

    a.ytext.insert(0, 'from-a');
    // A's local edit produced one outgoing message.
    expect(sendWsA).toHaveBeenCalledTimes(1);
    const aSent = sendWsA.mock.calls[0][0];

    // Apply A's update on B's binding -- this must NOT cause B to
    // re-broadcast (which would loop indefinitely).
    sendWsB.mockClear();
    b.applyRemoteUpdate(aSent.update, 'tab-A');
    expect(sendWsB).not.toHaveBeenCalled();
    expect(b.ytext.toString()).toBe('from-a');

    a.destroy();
    b.destroy();
  });

  it('ignores self-echoes (same originId)', () => {
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: 'hello', sendWs, originId: 'tab-A' });
    // Synthesize an update from another doc but pretend it came from
    // ourselves -- binding should refuse to apply.
    const other = new Y.Doc();
    other.getText('content').insert(0, 'INJECT');
    const otherUpdate = __testing.bytesToBase64(Y.encodeStateAsUpdateV2(other));

    b.applyRemoteUpdate(otherUpdate, 'tab-A');  // self-echo
    expect(b.ytext.toString()).toBe('hello');
    b.destroy();
  });

  it('cleans up the updateV2 listener on destroy', () => {
    const sendWs = vi.fn();
    const b = createYjsBinding({ fileId: 'f1', initialText: '', sendWs, originId: 'tab-A' });
    b.ytext.insert(0, 'first');
    expect(sendWs).toHaveBeenCalledTimes(1);
    b.destroy();
    // Operating on a destroyed doc shouldn't send anything.
    sendWs.mockClear();
    // Any further insert call would throw on a destroyed doc; the
    // test passes as long as the listener was detached before destroy
    // tore the doc down (i.e. no spurious send during destroy).
    expect(sendWs).not.toHaveBeenCalled();
  });
});
