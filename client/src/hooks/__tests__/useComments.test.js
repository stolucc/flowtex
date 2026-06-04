import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import useComments from '../useComments.js';

vi.mock('../../api.js', () => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

import { get, post, patch, del } from '../../api.js';

describe('useComments', () => {
  let sendWsRef;
  let editorRef;
  const activeFile = { id: 'f1', path: 'main.tex' };

  beforeEach(() => {
    vi.clearAllMocks();
    sendWsRef = { current: vi.fn() };
    editorRef = { current: null };
    get.mockResolvedValue({ json: () => Promise.resolve([]) });
  });

  it('has correct initial state', () => {
    const { result } = renderHook(() => useComments(null, sendWsRef, editorRef));
    expect(result.current.comments).toEqual([]);
    expect(result.current.selection).toBeNull();
  });

  it('loads comments on activeFile change', async () => {
    const comments = [{ id: 'c1', text: 'Fix this', from_pos: 0, to_pos: 5 }];
    get.mockResolvedValue({ json: () => Promise.resolve(comments) });

    const { result } = renderHook(() => useComments(activeFile, sendWsRef, editorRef));

    await waitFor(() => {
      expect(get).toHaveBeenCalledWith('/api/comments/f1');
      expect(result.current.comments).toEqual(comments);
    });
  });

  it('reloads comments when activeFile changes', async () => {
    const comments1 = [{ id: 'c1', text: 'A', from_pos: 0, to_pos: 1 }];
    const comments2 = [{ id: 'c2', text: 'B', from_pos: 0, to_pos: 2 }];

    get
      .mockResolvedValueOnce({ json: () => Promise.resolve(comments1) })
      .mockResolvedValueOnce({ json: () => Promise.resolve(comments2) });

    const { result, rerender } = renderHook(({ file }) => useComments(file, sendWsRef, editorRef), {
      initialProps: { file: { id: 'f1', path: 'a.tex' } },
    });

    await waitFor(() => expect(result.current.comments).toEqual(comments1));

    rerender({ file: { id: 'f2', path: 'b.tex' } });

    await waitFor(() => {
      expect(get).toHaveBeenCalledWith('/api/comments/f2');
      expect(result.current.comments).toEqual(comments2);
    });
  });

  it('handleAddComment posts, appends, clears selection, sends WS', async () => {
    const newComment = { id: 'c1', text: 'Fix this', from_pos: 10, to_pos: 20 };
    post.mockResolvedValue({ json: () => Promise.resolve(newComment) });
    get.mockResolvedValue({ json: () => Promise.resolve([]) });

    const { result } = renderHook(() => useComments(activeFile, sendWsRef, editorRef));
    await waitFor(() => expect(get).toHaveBeenCalled());

    // Set selection first
    act(() => {
      result.current.setSelection({ from: 10, to: 20 });
    });
    expect(result.current.selection).toEqual({ from: 10, to: 20 });

    await act(async () => {
      await result.current.handleAddComment('Fix this');
    });

    expect(post).toHaveBeenCalledWith('/api/comments/f1', {
      from_pos: 10,
      to_pos: 20,
      text: 'Fix this',
    });
    expect(result.current.comments).toEqual([newComment]);
    expect(result.current.selection).toBeNull();
    expect(sendWsRef.current).toHaveBeenCalledWith({
      type: 'comment',
      fileId: 'f1',
      comment: newComment,
    });
  });

  it('handleAddComment does nothing without selection', async () => {
    const { result } = renderHook(() => useComments(activeFile, sendWsRef, editorRef));
    await waitFor(() => expect(get).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleAddComment('text');
    });

    expect(post).not.toHaveBeenCalled();
  });

  it('handleResolveComment patches, updates resolved flag, sends WS', async () => {
    const existing = [{ id: 'c1', text: 'Fix', from_pos: 0, to_pos: 5, resolved: 0 }];
    get.mockResolvedValue({ json: () => Promise.resolve(existing) });
    patch.mockResolvedValue({});

    const { result } = renderHook(() => useComments(activeFile, sendWsRef, editorRef));
    await waitFor(() => expect(result.current.comments).toHaveLength(1));

    await act(async () => {
      await result.current.handleResolveComment('c1', true);
    });

    expect(patch).toHaveBeenCalledWith('/api/comments/c1/resolve', { resolved: true });
    expect(result.current.comments[0].resolved).toBe(1);
    expect(sendWsRef.current).toHaveBeenCalledWith({
      type: 'comment-resolve',
      commentId: 'c1',
      resolved: true,
    });
  });

  it('handleDeleteComment deletes, removes from list, sends WS', async () => {
    const existing = [
      { id: 'c1', text: 'A', from_pos: 0, to_pos: 1 },
      { id: 'c2', text: 'B', from_pos: 2, to_pos: 3 },
    ];
    get.mockResolvedValue({ json: () => Promise.resolve(existing) });
    del.mockResolvedValue({});

    const { result } = renderHook(() => useComments(activeFile, sendWsRef, editorRef));
    await waitFor(() => expect(result.current.comments).toHaveLength(2));

    await act(async () => {
      await result.current.handleDeleteComment('c1');
    });

    expect(del).toHaveBeenCalledWith('/api/comments/c1');
    expect(result.current.comments).toHaveLength(1);
    expect(result.current.comments[0].id).toBe('c2');
    expect(sendWsRef.current).toHaveBeenCalledWith({
      type: 'comment-delete',
      commentId: 'c1',
    });
  });

  it('handleReplyComment posts, appends reply, sends WS', async () => {
    const existing = [{ id: 'c1', text: 'Fix', from_pos: 0, to_pos: 5, replies: [] }];
    get.mockResolvedValue({ json: () => Promise.resolve(existing) });
    const reply = { id: 'r1', text: 'Done', user_id: 'u1' };
    post.mockResolvedValue({ json: () => Promise.resolve(reply) });

    const { result } = renderHook(() => useComments(activeFile, sendWsRef, editorRef));
    await waitFor(() => expect(result.current.comments).toHaveLength(1));

    await act(async () => {
      await result.current.handleReplyComment('c1', 'Done');
    });

    expect(post).toHaveBeenCalledWith('/api/comments/c1/reply', { text: 'Done' });
    expect(result.current.comments[0].replies).toEqual([reply]);
    expect(sendWsRef.current).toHaveBeenCalledWith({
      type: 'comment-reply',
      commentId: 'c1',
      reply,
    });
  });

  it('handleEditComment patches, updates text, sends WS', async () => {
    const existing = [{ id: 'c1', text: 'Old text', from_pos: 0, to_pos: 5 }];
    get.mockResolvedValue({ json: () => Promise.resolve(existing) });
    patch.mockResolvedValue({});

    const { result } = renderHook(() => useComments(activeFile, sendWsRef, editorRef));
    await waitFor(() => expect(result.current.comments).toHaveLength(1));

    await act(async () => {
      await result.current.handleEditComment('c1', 'New text');
    });

    expect(patch).toHaveBeenCalledWith('/api/comments/c1', { text: 'New text' });
    expect(result.current.comments[0].text).toBe('New text');
    expect(sendWsRef.current).toHaveBeenCalledWith({
      type: 'comment-edit',
      commentId: 'c1',
      text: 'New text',
    });
  });

  // The HTTP route now broadcasts the new comment over WS (no sender
  // exclusion). When the WS echo arrives before the HTTP response
  // resolves, useWebSocket already inserted the comment; without
  // dedup the HTTP-response handler would append it again, doubling
  // the local count (and the comments-rail badge). Reproduces the
  // bug the user hit -- "count goes up by 2, hard refresh fixes it".
  it('handleAddComment dedups when the same id is already in state (WS echo arrived first)', async () => {
    const echoed = { id: 'c1', text: 'Fix this', from_pos: 10, to_pos: 20 };
    // Seed initial GET so the WS echo has already inserted c1.
    get.mockResolvedValue({ json: () => Promise.resolve([echoed]) });
    post.mockResolvedValue({ json: () => Promise.resolve(echoed) });

    const { result } = renderHook(() => useComments(activeFile, sendWsRef, editorRef));
    await waitFor(() => expect(result.current.comments).toHaveLength(1));

    act(() => { result.current.setSelection({ from: 10, to: 20 }); });
    await act(async () => { await result.current.handleAddComment('Fix this'); });

    expect(result.current.comments).toHaveLength(1);
  });

  it('handleReplyComment dedups when the same reply id is already present', async () => {
    const reply = { id: 'r1', text: 'Done', user_id: 'u1' };
    const existing = [{ id: 'c1', text: 'Fix', replies: [reply] }];
    get.mockResolvedValue({ json: () => Promise.resolve(existing) });
    post.mockResolvedValue({ json: () => Promise.resolve(reply) });

    const { result } = renderHook(() => useComments(activeFile, sendWsRef, editorRef));
    await waitFor(() => expect(result.current.comments).toHaveLength(1));

    await act(async () => { await result.current.handleReplyComment('c1', 'Done'); });

    expect(result.current.comments[0].replies).toHaveLength(1);
  });
});
