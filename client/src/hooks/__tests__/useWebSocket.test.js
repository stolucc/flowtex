import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
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

    const ws = mockWsInstances[0];
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
    const { result } = renderWsHook();
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
    const { result } = renderWsHook();
    act(() => {
      vi.runAllTimers();
    });

    const ws = mockWsInstances[0];
    act(() => {
      ws.onmessage({ data: JSON.stringify({ type: 'comment', fileId: 'other-file', comment: { id: 'c1' } }) });
    });

    expect(callbacks.setComments).not.toHaveBeenCalled();
  });

  it('handles tracked-change message for matching fileId', () => {
    const { result } = renderWsHook();
    act(() => {
      vi.runAllTimers();
    });

    const ws = mockWsInstances[0];
    act(() => {
      ws.onmessage({
        data: JSON.stringify({ type: 'tracked-change', fileId: 'f1', change: { id: 'tc1', text: 'added' } }),
      });
    });

    expect(callbacks.setTrackedChanges).toHaveBeenCalled();
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

    // The join message is sent first, then our message
    const lastSent = ws.sent[ws.sent.length - 1];
    expect(JSON.parse(lastSent)).toEqual({ type: 'cursor', head: 42 });
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
