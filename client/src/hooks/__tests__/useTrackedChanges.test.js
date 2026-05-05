import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { serialize } from '@shared/tcMarkers.js';
import useTrackedChanges from '../useTrackedChanges.js';

vi.mock('../../utils/settings.js', () => ({
  getSetting: vi.fn(() => 'false'),
  setSetting: vi.fn(),
}));

const FILE = { id: 'file-1', content: '' };
const USER = { id: 'u1', name: 'Alice' };

/**
 * Build a fake editorRef whose `getContent()` returns whatever `docTextRef`
 * currently points to. Tests mutate docTextRef and call refreshFromDoc to
 * have the hook re-parse the new content.
 */
function makeEditorMocks(initialDoc) {
  const docTextRef = { current: initialDoc };
  const calls = { applyMarkerResolution: [], applyMarkerResolutionAll: [], goToPosition: [] };
  const editor = {
    getContent: () => docTextRef.current,
    applyMarkerResolution: vi.fn((id, decision) => {
      calls.applyMarkerResolution.push({ id, decision });
      return true;
    }),
    applyMarkerResolutionAll: vi.fn((decision) => {
      calls.applyMarkerResolutionAll.push({ decision });
      return 0;
    }),
    goToPosition: vi.fn((pos) => calls.goToPosition.push(pos)),
  };
  return { docTextRef, editor, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useTrackedChanges (marker-aware)', () => {
  it('parses no markers when the doc is plain text', () => {
    const { editor } = makeEditorMocks('hello world');
    const { result } = renderHook(() =>
      useTrackedChanges(FILE, USER, { current: vi.fn() }, { current: editor }),
    );
    expect(result.current.trackedChanges).toEqual([]);
    expect(result.current.pendingChanges).toEqual([]);
  });

  it('parses an ins marker into a tracked change with type-equivalent fields', () => {
    const m = serialize({ type: 'ins', id: 'a1', author: 'Alice', text: 'hello' });
    const { editor } = makeEditorMocks(`pre ${m} post`);
    const { result } = renderHook(() =>
      useTrackedChanges(FILE, USER, { current: vi.fn() }, { current: editor }),
    );
    expect(result.current.trackedChanges).toHaveLength(1);
    const tc = result.current.trackedChanges[0];
    expect(tc).toMatchObject({
      id: 'a1',
      file_id: 'file-1',
      status: 'pending',
      author_name: 'Alice',
      inserted_text: 'hello',
      deleted_text: '',
    });
  });

  it('parses a del marker into a tracked change with deleted_text set', () => {
    const m = serialize({ type: 'del', id: 'd1', author: 'Alice', text: 'gone' });
    const { editor } = makeEditorMocks(`pre ${m} post`);
    const { result } = renderHook(() =>
      useTrackedChanges(FILE, USER, { current: vi.fn() }, { current: editor }),
    );
    expect(result.current.trackedChanges[0]).toMatchObject({
      deleted_text: 'gone',
      inserted_text: '',
      author_name: 'Alice',
    });
  });

  it('handleAcceptChange forwards to the editor with decision="accept"', () => {
    const m = serialize({ type: 'ins', id: 'a1', author: 'Alice', text: 'hello' });
    const { editor, calls } = makeEditorMocks(m);
    const { result } = renderHook(() =>
      useTrackedChanges(FILE, USER, { current: vi.fn() }, { current: editor }),
    );
    act(() => {
      result.current.handleAcceptChange('a1');
    });
    expect(calls.applyMarkerResolution).toEqual([{ id: 'a1', decision: 'accept' }]);
  });

  it('handleRejectChange forwards to the editor with decision="reject"', () => {
    const m = serialize({ type: 'del', id: 'd1', author: 'Alice', text: 'gone' });
    const { editor, calls } = makeEditorMocks(m);
    const { result } = renderHook(() =>
      useTrackedChanges(FILE, USER, { current: vi.fn() }, { current: editor }),
    );
    act(() => {
      result.current.handleRejectChange('d1');
    });
    expect(calls.applyMarkerResolution).toEqual([{ id: 'd1', decision: 'reject' }]);
  });

  it('handleAcceptAllChanges and handleRejectAllChanges forward to applyMarkerResolutionAll', () => {
    const { editor, calls } = makeEditorMocks('');
    const { result } = renderHook(() =>
      useTrackedChanges(FILE, USER, { current: vi.fn() }, { current: editor }),
    );
    act(() => result.current.handleAcceptAllChanges());
    act(() => result.current.handleRejectAllChanges());
    expect(calls.applyMarkerResolutionAll).toEqual([{ decision: 'accept' }, { decision: 'reject' }]);
  });

  it('refreshFromDoc rebuilds the trackedChanges list from the editor doc', () => {
    const { docTextRef, editor } = makeEditorMocks('');
    const { result } = renderHook(() =>
      useTrackedChanges(FILE, USER, { current: vi.fn() }, { current: editor }),
    );
    expect(result.current.trackedChanges).toEqual([]);
    // Doc text changes (in real life: a transaction the editor applied
    // and which now needs to be reflected in the review-panel list).
    docTextRef.current = serialize({ type: 'ins', id: 'a1', author: 'Alice', text: 'new' });
    act(() => result.current.refreshFromDoc());
    expect(result.current.trackedChanges).toHaveLength(1);
    expect(result.current.trackedChanges[0].inserted_text).toBe('new');
  });
});
