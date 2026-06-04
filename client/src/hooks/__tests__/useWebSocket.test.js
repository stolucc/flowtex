import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useWebSocket from '../useWebSocket.js';

let mockWsInstances = [];

class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    mockWsInstances.push(this);
    // Simulate async open
    setTimeout(() => {
      if (this.readyState === 0) {
        this.readyState = 1; // OPEN
        this.onopen?.();
      }
    }, 0);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3; // CLOSED
    this.onclose?.({ code: 1000 });
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);

describe('useWebSocket', () => {
  const user = { id: 'u1', name: 'Alice' };
  const project = { id: 'p1' };
  let activeFileRef;
  let callbacks;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockWsInstances = [];
    activeFileRef = { current: { id: 'f1' } };
    callbacks = {
      setComments: vi.fn(),
      setTrackedChanges: vi.fn(),
      setHistoryVersion: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderWsHook(userArg = user) {
    return renderHook(({ u }) => useWebSocket(u, project, activeFileRef, callbacks), { initialProps: { u: userArg } });
  }

  it('has correct initial state', () => {
    const { result } = renderHook(() => useWebSocket(null, null, activeFileRef, callbacks));
    expect(result.current.activeUsers).toEqual([]);
    expect(result.current.wsConnected).toBe(false);
    expect(result.current.chatMessages).toEqual([]);
  });

  it('connects when user provided', () => {
    const { result } = renderWsHook();
    expect(mockWsInstances).toHaveLength(1);
    expect(mockWsInstances[0].url).toContain('/ws');

    // Trigger onopen
    act(() => {
      vi.runAllTimers();
    });
    expect(result.current.wsConnected).toBe(true);
  });

  it('disconnects when user becomes null', () => {
    const { result, rerender } = renderWsHook();
    act(() => {
      vi.runAllTimers();
    });
    expect(result.current.wsConnected).toBe(true);

    // Prevent onclose from trying reconnect by simulating intentional close
    rerender({ u: null });

    expect(result.current.wsConnected).toBe(false);
  });

  it('handles presence message', () => {
    const { result } = renderWsHook();
    act(() => {
      vi.runAllTimers();
    });

    const ws = mockWsInstances[0];
    const users = [
      { id: 'u1', name: 'Alice' },
      { id: 'u2', name: 'Bob' },
    ];
    act(() => {
      ws.onmessage({ data: JSON.stringify({ type: 'presence', users }) });
    });

    expect(result.current.activeUsers).toEqual(users);
  });

  it('handles cursor message', () => {
    const { result } = renderWsHook();
    act(() => {
      vi.runAllTimers();
    });

    const ws = mockWsInstances[0];
    act(() => {
      ws.onmessage({
        data: JSON.stringify({
          type: 'cursor',
          userId: 'u2',
          fileId: 'f1',
          head: 10,
          anchor: 5,
          userName: 'Bob',
        }),
      });
    });

    expect(result.current.remoteCursors).toEqual({
      u2: { fileId: 'f1', head: 10, anchor: 5, userName: 'Bob' },
    });
  });

  it('handles chat message and increments unreadChat when chat hidden', () => {
    const { result } = renderWsHook();
    act(() => {
      vi.runAllTimers();
    });

    // Chat is hidden by default (showChat = false)
    const ws = mockWsInstances[0];
    const chatMsg = { type: 'chat', userId: 'u2', text: 'Hello' };
    act(() => {
      ws.onmessage({ data: JSON.stringify(chatMsg) });
    });

    expect(result.current.chatMessages).toEqual([chatMsg]);
    expect(result.current.unreadChat).toBe(1);
  });

  it('handles comment message for matching fileId', () => {
    renderWsHook();
    act(() => {
      vi.runAllTimers();
    });

    const ws = mockWsInstances[0];
    const comment = { id: 'c1', text: 'Fix this' };
    act(() => {
      ws.onmessage({ data: JSON.stringify({ type: 'comment', fileId: 'f1', comment }) });
    });

    expect(callbacks.setComments).toHaveBeenCalled();
  });

  it('does not call setComments for non-matching fileId', () => {
    renderWsHook();
    act(() => {
      vi.runAllTimers();
    });

    const ws = mockWsInstances[0];
    act(() => {
      ws.onmessage({ data: JSON.stringify({ type: 'comment', fileId: 'other-file', comment: { id: 'c1' } }) });
    });

    expect(callbacks.setComments).not.toHaveBeenCalled();
  });

  // Regression cover: HTTP-driven comment broadcasts send to the whole
  // room (no sender exclusion), so the author's own tab gets the WS
  // echo right after its HTTP add. Without dedup the count jumped by 2
  // until a hard refresh. The updater should be a no-op when the
  // comment id is already in state.
  it('dedups duplicate comment broadcast (self-echo from HTTP)', () => {
    renderWsHook();
    act(() => { vi.runAllTimers(); });

    const ws = mockWsInstances[0];
    const comment = { id: 'c1', text: 'Fix this' };
    act(() => {
      ws.onmessage({ data: JSON.stringify({ type: 'comment', fileId: 'f1', comment }) });
    });

    // Extract the updater that setComments was called with.
    const updater = callbacks.setComments.mock.calls[0][0];
    // If c1 is already in state, the updater returns the same array
    // (or one with no new entries).
    const prevWithC1 = [{ id: 'c1', text: 'Fix this' }];
    expect(updater(prevWithC1)).toHaveLength(1);
    // If c1 is NOT in state (other-tab case), the updater appends.
    expect(updater([])).toHaveLength(1);
    expect(updater([])[0].id).toBe('c1');
  });

  it('dedups duplicate comment-reply broadcast', () => {
    renderWsHook();
    act(() => { vi.runAllTimers(); });

    const ws = mockWsInstances[0];
    const reply = { id: 'r1', text: 'Done' };
    act(() => {
      ws.onmessage({ data: JSON.stringify({ type: 'comment-reply', commentId: 'c1', reply }) });
    });

    const updater = callbacks.setComments.mock.calls[0][0];
    // Reply already present -> no duplicate append.
    const withReply = [{ id: 'c1', replies: [{ id: 'r1', text: 'Done' }] }];
    expect(updater(withReply)[0].replies).toHaveLength(1);
    // Reply not present -> appended.
    const withoutReply = [{ id: 'c1', replies: [] }];
    expect(updater(withoutReply)[0].replies).toHaveLength(1);
    expect(updater(withoutReply)[0].replies[0].id).toBe('r1');
  });

  it('sendWsMessage sends JSON through WebSocket', () => {
    const { result } = renderWsHook();
    act(() => {
      vi.runAllTimers();
    });

    const ws = mockWsInstances[0];
    act(() => {
      result.current.sendWsMessage({ type: 'cursor', head: 42 });
    });

    // The join message is sent first, then our message. cursor frames get
    // an originId stamped automatically (see echo-filter tests below) — so
    // assert the user-supplied fields are present rather than strict-equal.
    const lastSent = ws.sent[ws.sent.length - 1];
    expect(JSON.parse(lastSent)).toEqual(expect.objectContaining({ type: 'cursor', head: 42 }));
  });

  it('reconnects on non-4003 close with exponential backoff', () => {
    const { result } = renderWsHook();
    act(() => {
      vi.runAllTimers();
    });

    expect(mockWsInstances).toHaveLength(1);
    const ws = mockWsInstances[0];

    // Simulate unexpected close (not intentional, not 4003)
    act(() => {
      ws.readyState = 3;
      ws.onclose({ code: 1006 });
    });

    expect(result.current.wsConnected).toBe(false);

    // After 1 second (initial delay), should reconnect
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(mockWsInstances).toHaveLength(2);

    // Close again - delay should double
    const ws2 = mockWsInstances[1];
    act(() => {
      ws2.readyState = 3;
      ws2.onclose({ code: 1006 });
    });

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // Should NOT have reconnected yet (delay is now 2000)
    expect(mockWsInstances).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(mockWsInstances).toHaveLength(3);
  });

  it('stamps outgoing changes frames with a stable per-tab originId, and filters echoes that bring it back', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const { result } = renderWsHook();
    act(() => { vi.runAllTimers(); }); // let the mock ws open
    const ws = mockWsInstances[0];

    // Send a `changes` frame — should be stamped with originId. (The hook
    // also sends a `join` on connect; pick the changes frame specifically.)
    act(() => {
      result.current.sendWsMessage({ type: 'changes', fileId: 'f1', changes: [{ from: 0, to: 0, insert: 'h' }] });
    });
    const sent = JSON.parse(ws.sent.find((s) => JSON.parse(s).type === 'changes'));
    expect(sent.originId).toMatch(/.+/);

    // Server echoes back the same change with our own originId — must be dropped.
    dispatchSpy.mockClear();
    act(() => {
      ws.onmessage({
        data: JSON.stringify({
          type: 'changes',
          fileId: 'f1',
          changes: [{ from: 0, to: 0, insert: 'h' }],
          userId: 'u1',
          originId: sent.originId,
        }),
      });
    });
    const echoEvent = dispatchSpy.mock.calls.find((c) => c[0]?.type === 'ws:changes');
    expect(echoEvent).toBeFalsy(); // filtered — no ws:changes event

    // Same shape with a *different* originId (another client / tab) must pass through.
    dispatchSpy.mockClear();
    act(() => {
      ws.onmessage({
        data: JSON.stringify({
          type: 'changes',
          fileId: 'f1',
          changes: [{ from: 0, to: 0, insert: 'x' }],
          userId: 'u2',
          originId: 'some-other-tab-id',
        }),
      });
    });
    const passEvent = dispatchSpy.mock.calls.find((c) => c[0]?.type === 'ws:changes');
    expect(passEvent).toBeTruthy();

    dispatchSpy.mockRestore();
  });

  it('also stamps + filters cursor frames so own-cursor echoes do not render as ghost cursors', () => {
    const { result } = renderWsHook();
    act(() => { vi.runAllTimers(); });
    const ws = mockWsInstances[0];

    // Outgoing cursor frame gets stamped.
    act(() => {
      result.current.sendWsMessage({ type: 'cursor', fileId: 'f1', head: 5, anchor: 5 });
    });
    const sent = JSON.parse(ws.sent.find((s) => JSON.parse(s).type === 'cursor'));
    expect(sent.originId).toMatch(/.+/);

    // Echo back with our own originId — must not update remoteCursors.
    act(() => {
      ws.onmessage({
        data: JSON.stringify({
          type: 'cursor',
          fileId: 'f1',
          userId: 'u1',
          userName: 'Alice',
          head: 5,
          anchor: 5,
          originId: sent.originId,
        }),
      });
    });
    expect(result.current.remoteCursors).toEqual({});

    // Different originId (another tab/client) — must update.
    act(() => {
      ws.onmessage({
        data: JSON.stringify({
          type: 'cursor',
          fileId: 'f1',
          userId: 'u2',
          userName: 'Bob',
          head: 12,
          anchor: 12,
          originId: 'someone-else',
        }),
      });
    });
    expect(result.current.remoteCursors.u2).toBeTruthy();
  });

  it('uses a different originId per hook mount (one id per browser tab)', () => {
    const findChanges = (ws) => JSON.parse(ws.sent.find((s) => JSON.parse(s).type === 'changes'));

    const a = renderWsHook();
    act(() => { vi.runAllTimers(); });
    const wsA = mockWsInstances[0];
    act(() => { a.result.current.sendWsMessage({ type: 'changes', fileId: 'f1', changes: [{ from: 0, to: 0, insert: 'a' }] }); });

    // Second mount = second "tab" — fresh originId.
    const b = renderWsHook();
    act(() => { vi.runAllTimers(); });
    const wsB = mockWsInstances[mockWsInstances.length - 1];
    act(() => { b.result.current.sendWsMessage({ type: 'changes', fileId: 'f1', changes: [{ from: 0, to: 0, insert: 'b' }] }); });

    expect(findChanges(wsA).originId).not.toBe(findChanges(wsB).originId);
  });

  it('does not reconnect on 4003 close (removed from project)', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const { result } = renderWsHook();
    act(() => {
      vi.runAllTimers();
    });

    const ws = mockWsInstances[0];
    act(() => {
      ws.readyState = 3;
      ws.onclose({ code: 4003 });
    });

    expect(result.current.wsConnected).toBe(false);

    // Verify ws:removed-from-project event dispatched
    const removedEvent = dispatchSpy.mock.calls.find((call) => call[0]?.type === 'ws:removed-from-project');
    expect(removedEvent).toBeTruthy();

    // No reconnect after any time
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(mockWsInstances).toHaveLength(1);

    dispatchSpy.mockRestore();
  });
});
