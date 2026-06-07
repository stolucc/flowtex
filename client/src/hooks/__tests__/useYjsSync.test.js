import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import useYjsSync from '../useYjsSync.js';

// Use the jsdom window for everything (so React Testing Library is
// happy) but spy on addEventListener / removeEventListener and stub
// localStorage so we can control the flag.

let addSpy;
let removeSpy;
const localStorageStub = {
  store: {},
  getItem(k) { return k in this.store ? this.store[k] : null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; },
  clear() { this.store = {}; },
};

beforeEach(() => {
  localStorageStub.clear();
  Object.defineProperty(window, 'localStorage', {
    value: localStorageStub,
    configurable: true,
  });
  addSpy = vi.spyOn(window, 'addEventListener');
  removeSpy = vi.spyOn(window, 'removeEventListener');
});

afterEach(() => {
  addSpy.mockRestore();
  removeSpy.mockRestore();
});

function setFlag(on) {
  // Phase 6 cutover: the flag defaults to ON. "Off" requires an
  // explicit opt-out marker; "on" just clears any opt-out.
  if (on) localStorageStub.removeItem('flowtex-yjs-sync');
  else localStorageStub.setItem('flowtex-yjs-sync', '0');
}

describe('useYjsSync', () => {
  it('is a no-op when the flag is off', () => {
    setFlag(false);
    const { result } = renderHook(() =>
      useYjsSync({ id: 'f1', content: 'hello' }, vi.fn(), 'tab-A'),
    );
    expect(result.current.enabled).toBe(false);
    expect(result.current.extension).toBeNull();
    const yjsSubscribed = addSpy.mock.calls.some((c) => c[0] === 'ws:yjs-update');
    expect(yjsSubscribed).toBe(false);
  });

  it('returns enabled:true and an extension when the flag is on', async () => {
    setFlag(true);
    const sendWs = vi.fn();
    const { result } = renderHook(() =>
      useYjsSync({ id: 'f1', content: 'hello' }, sendWs, 'tab-A'),
    );
    expect(result.current.enabled).toBe(true);
    await waitFor(() => expect(result.current.extension).not.toBeNull());
    const yjsSubscribed = addSpy.mock.calls.some((c) => c[0] === 'ws:yjs-update');
    expect(yjsSubscribed).toBe(true);
  });

  it('returns null extension when no file is provided', () => {
    setFlag(true);
    const { result } = renderHook(() => useYjsSync(null, vi.fn(), 'tab-A'));
    expect(result.current.enabled).toBe(true);
    expect(result.current.extension).toBeNull();
    const yjsSubscribed = addSpy.mock.calls.some((c) => c[0] === 'ws:yjs-update');
    expect(yjsSubscribed).toBe(false);
  });

  it('tears down and re-creates when file.id changes', async () => {
    setFlag(true);
    const sendWs = vi.fn();
    const { result, rerender } = renderHook(
      ({ file }) => useYjsSync(file, sendWs, 'tab-A'),
      { initialProps: { file: { id: 'f1', content: 'one' } } },
    );
    await waitFor(() => expect(result.current.extension).not.toBeNull());
    const first = result.current.extension;

    rerender({ file: { id: 'f2', content: 'two' } });
    await waitFor(() => expect(result.current.extension).not.toBeNull());
    expect(result.current.extension).not.toBe(first);
    const yjsUnsub = removeSpy.mock.calls.some((c) => c[0] === 'ws:yjs-update');
    expect(yjsUnsub).toBe(true);
  });

  it('cleans up the listener on unmount', async () => {
    setFlag(true);
    const sendWs = vi.fn();
    const { unmount, result } = renderHook(() =>
      useYjsSync({ id: 'f1', content: 'one' }, sendWs, 'tab-A'),
    );
    await waitFor(() => expect(result.current.extension).not.toBeNull());
    act(() => { unmount(); });
    const yjsUnsub = removeSpy.mock.calls.some((c) => c[0] === 'ws:yjs-update');
    expect(yjsUnsub).toBe(true);
  });
});
