// @ts-check
import { useState, useCallback, useEffect, useRef } from 'react';
import { get, post, patch, del } from '../api.js';

/**
 * Manages inline comments: CRUD operations, position tracking, and WebSocket broadcast.
 * @param {any} activeFile - The currently active file.
 * @param {import('react').RefObject<any>} sendWsRef - Ref to the WebSocket send function.
 * @param {import('react').RefObject<any>} editorRef - Ref to the editor instance.
 */
export default function useComments(activeFile, sendWsRef, editorRef) {
  /** @type {[any[], React.Dispatch<React.SetStateAction<any[]>>]} */
  const [comments, setComments] = useState(/** @type {any[]} */ ([]));
  /** @type {[any, React.Dispatch<any>]} */
  const [selection, setSelection] = useState(/** @type {any} */ (null));
  const [selectionFormTop, setSelectionFormTop] = useState(/** @type {number | null} */ (null));
  /** @type {[any[], React.Dispatch<React.SetStateAction<any[]>>]} */
  const [commentPositions, setCommentPositions] = useState(/** @type {any[]} */ ([]));
  /** @type {React.MutableRefObject<any>} */
  const selectionRef = useRef(null);
  selectionRef.current = selection;

  // Load comments for active file. Also reset the pending-comment selection
  // — `selection` is the range that the in-progress comment form is
  // anchored to, captured against the previous file's content. If we kept
  // it across a file switch, submitting the form would write a comment to
  // the new file at positions captured from the old one (which could be
  // past EOF), producing an orphaned bubble at an unreachable line.
  useEffect(() => {
    if (!activeFile) return;
    setSelection(null);
    setSelectionFormTop(null);
    let cancelled = false;
    get(`/api/comments/${activeFile.id}`)
      .then((r) => r.json())
      .then((rows) => {
        // Drop the payload if the user switched files mid-fetch — the
        // cleanup below flips `cancelled` when a new file is loaded.
        if (cancelled) return;
        setComments(rows);
      });
    return () => { cancelled = true; };
  }, [activeFile]);

  const handleAddComment = useCallback(
    async (/** @type {string} */ text, /** @type {{ assignedTo?: string }} */ { assignedTo } = {}) => {
      if (!activeFile || !selection) return;
      const res = await post(`/api/comments/${activeFile.id}`, {
        from_pos: selection.from,
        to_pos: selection.to,
        text,
        assigned_to: assignedTo || undefined,
      });
      const comment = await res.json();
      // Dedup on id: the server now broadcasts the comment over WS to
      // the whole room (no sender exclusion). If the WS echo arrives
      // BEFORE the HTTP response resolves, useWebSocket will have
      // already added it; this guard stops the HTTP path from doubling
      // it. The reverse race (HTTP first, then WS echo) is handled by
      // the matching dedup in useWebSocket.js.
      setComments((c) => (c.some((existing) => existing.id === comment.id) ? c : [...c, comment]));
      setSelection(null);
      sendWsRef.current?.({ type: 'comment', fileId: activeFile.id, comment });
    },
    [activeFile, selection, sendWsRef],
  );

  const handleResolveComment = useCallback(
    async (/** @type {string} */ commentId, /** @type {boolean} */ resolved) => {
      await patch(`/api/comments/${commentId}/resolve`, { resolved });
      setComments((cs) => cs.map((c) => (c.id === commentId ? { ...c, resolved: resolved ? 1 : 0 } : c)));
      sendWsRef.current?.({ type: 'comment-resolve', commentId, resolved });
    },
    [sendWsRef],
  );

  const handleDeleteComment = useCallback(
    async (/** @type {string} */ commentId) => {
      await del(`/api/comments/${commentId}`);
      setComments((cs) => cs.filter((c) => c.id !== commentId));
      sendWsRef.current?.({ type: 'comment-delete', commentId });
    },
    [sendWsRef],
  );

  const handleReplyComment = useCallback(
    async (/** @type {string} */ commentId, /** @type {string} */ text) => {
      const res = await post(`/api/comments/${commentId}/reply`, { text });
      const reply = await res.json();
      // Same dedup story as handleAddComment: server-originated WS
      // broadcast can race the HTTP response in either direction.
      setComments((cs) =>
        cs.map((c) =>
          c.id === commentId
            ? {
                ...c,
                replies: (c.replies || []).some((/** @type {any} */ r) => r.id === reply.id)
                  ? c.replies
                  : [...(c.replies || []), reply],
              }
            : c,
        ),
      );
      sendWsRef.current?.({ type: 'comment-reply', commentId, reply });
    },
    [sendWsRef],
  );

  const handleEditComment = useCallback(
    async (/** @type {string} */ commentId, /** @type {string} */ text) => {
      await patch(`/api/comments/${commentId}`, { text });
      setComments((cs) => cs.map((c) => (c.id === commentId ? { ...c, text } : c)));
      sendWsRef.current?.({ type: 'comment-edit', commentId, text });
    },
    [sendWsRef],
  );

  // Reactions are server-authoritative: send the toggle over WS, the server
  // broadcasts the new reaction set back to every client (including us) via
  // 'comment-reaction-update' / 'reply-reaction-update', so no optimistic
  // local mutation here.
  const handleReactComment = useCallback(
    (/** @type {string} */ commentId, /** @type {string} */ emoji) => {
      sendWsRef.current?.({ type: 'comment-react', commentId, emoji });
    },
    [sendWsRef],
  );

  const handleReactReply = useCallback(
    (/** @type {string} */ replyId, /** @type {string} */ emoji) => {
      sendWsRef.current?.({ type: 'reply-react', replyId, emoji });
    },
    [sendWsRef],
  );

  const updateCommentPositions = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      setCommentPositions([]);
      setSelectionFormTop(null);
      return;
    }
    const scrollInfo = editor.getScrollInfo();

    const sel = selectionRef.current;
    if (sel) {
      const selPos = Math.min(sel.from, sel.to);
      const selTop = editor.getTopForPos(selPos) - scrollInfo.scrollTop;
      setSelectionFormTop(selTop);
    } else {
      setSelectionFormTop(null);
    }

    if (!comments.length) {
      setCommentPositions([]);
      return;
    }
    const positions = comments
      .filter((c) => !c.resolved)
      .map((c) => {
        const pos = Math.min(c.from_pos, c.to_pos);
        const top = editor.getTopForPos(pos) - scrollInfo.scrollTop;
        return { id: c.id, top };
      });
    setCommentPositions(positions);
  }, [comments, editorRef]);

  // Recompute when comments or selection change
  useEffect(() => {
    updateCommentPositions();
  }, [comments, selection, updateCommentPositions]);

  return {
    comments,
    setComments,
    selection,
    setSelection,
    selectionFormTop,
    commentPositions,
    handleAddComment,
    handleResolveComment,
    handleDeleteComment,
    handleReplyComment,
    handleEditComment,
    handleReactComment,
    handleReactReply,
    updateCommentPositions,
  };
}
