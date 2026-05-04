import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import useTrackedChanges from '../useTrackedChanges.js';

vi.mock('../../api.js', () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

vi.mock('../../utils/settings.js', () => ({
  getSetting: vi.fn(() => 'false'),
  setSetting: vi.fn(),
}));

import { get, post, patch } from '../../api.js';

const FILE = { id: 'f1' };
const USER = { id: 'u1' };

let idCounter;
function jsonRes(body) {
  return Promise.resolve({ json: () => Promise.resolve(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  idCounter = 0;
  // Default: no pending TCs already on this file
  get.mockResolvedValue({ json: () => Promise.resolve([]) });
  post.mockImplementation((_url, body) => {
    idCounter += 1;
    return jsonRes({
      id: `tc-${idCounter}`,
      status: 'pending',
      author_id: USER.id,
      author_name: 'Test',
      ...body,
    });
  });
  patch.mockImplementation((_url, body) => jsonRes({ status: 'pending', ...body }));
});

describe('useTrackedChanges race + dedup', () => {
  it('synchronously updates trackedChangesRef so a backspace right after a keystroke merges into the just-saved insertion', async () => {
    const sendWsRef = { current: vi.fn() };
    const editorRef = { current: null };
    const { result } = renderHook(() => useTrackedChanges(FILE, USER, sendWsRef, editorRef));

    // Wait for the file-load effect to settle (empty TC list).
    await waitFor(() => expect(get).toHaveBeenCalled());

    // Fire two changes back-to-back without awaiting between them: an
    // insertion of 'e' at pos 100, then a backspace deleting that 'e'.
    // Without the ref-sync fix, the second handler reads a stale
    // trackedChangesRef and POSTs a separate deletion. With the fix, it
    // sees the just-POSTed insertion and merges (deleting the insertion).
    act(() => {
      result.current.handleTrackChange({
        fileId: FILE.id,
        from_pos: 100,
        to_pos: 101,
        inserted_text: 'e',
        deleted_text: '',
      });
      result.current.handleTrackChange({
        fileId: FILE.id,
        from_pos: 100,
        to_pos: 101,
        inserted_text: '',
        deleted_text: 'e',
      });
    });

    // Let the lock chain drain.
    await waitFor(() => {
      expect(post).toHaveBeenCalledTimes(1); // only the insertion was POSTed
    });
    // The merge collapsed it back to nothing — the insertion was deleted.
    await waitFor(() => {
      expect(result.current.trackedChanges).toHaveLength(0);
    });
    // No phantom deletion record.
    expect(post.mock.calls.find((c) => c[1]?.deleted_text === 'e' && !c[1]?.inserted_text)).toBeUndefined();
  });

  it('drops an exact-duplicate pending change (same pos, same text)', async () => {
    const sendWsRef = { current: vi.fn() };
    const { result } = renderHook(() => useTrackedChanges(FILE, USER, sendWsRef, { current: null }));
    await waitFor(() => expect(get).toHaveBeenCalled());

    // Two identical deletion events arrive (e.g., a debounce racing with
    // a WebSocket echo). Only the first should hit the server.
    act(() => {
      result.current.handleTrackChange({
        fileId: FILE.id,
        from_pos: 50,
        to_pos: 51,
        inserted_text: '',
        deleted_text: 'x',
      });
      result.current.handleTrackChange({
        fileId: FILE.id,
        from_pos: 50,
        to_pos: 51,
        inserted_text: '',
        deleted_text: 'x',
      });
    });

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.trackedChanges).toHaveLength(1));
  });

  it('does not dedup distinct deletions at different positions', async () => {
    const sendWsRef = { current: vi.fn() };
    const { result } = renderHook(() => useTrackedChanges(FILE, USER, sendWsRef, { current: null }));
    await waitFor(() => expect(get).toHaveBeenCalled());

    act(() => {
      result.current.handleTrackChange({
        fileId: FILE.id,
        from_pos: 50,
        to_pos: 51,
        inserted_text: '',
        deleted_text: 'x',
      });
      result.current.handleTrackChange({
        fileId: FILE.id,
        from_pos: 60,
        to_pos: 61,
        inserted_text: '',
        deleted_text: 'y',
      });
    });

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.trackedChanges).toHaveLength(2));
  });
});
