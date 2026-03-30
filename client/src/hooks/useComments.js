import { useState, useCallback, useEffect, useRef } from 'react';
import { get, post, patch, del } from '../api.js';

export default function useComments(activeFile, sendWsRef, editorRef) {
  const [comments, setComments] = useState([]);
  const [selection, setSelection] = useState(null);
  const [selectionFormTop, setSelectionFormTop] = useState(null);
  const [commentPositions, setCommentPositions] = useState([]);
  const selectionRef = useRef(null);
  selectionRef.current = selection;

  // Load comments for active file
  useEffect(() => {
    if (!activeFile) return;
    get(`/api/comments/${activeFile.id}`)
      .then((r) => r.json())
      .then(setComments);
  }, [activeFile]);

  const handleAddComment = useCallback(
    async (text) => {
      if (!activeFile || !selection) return;
      const res = await post(`/api/comments/${activeFile.id}`, {
        from_pos: selection.from,
        to_pos: selection.to,
        text,
      });
      const comment = await res.json();
      setComments((c) => [...c, comment]);
      setSelection(null);
      sendWsRef.current?.({ type: 'comment', fileId: activeFile.id, comment });
    },
    [activeFile, selection, sendWsRef],
  );

  const handleResolveComment = useCallback(
    async (commentId, resolved) => {
      await patch(`/api/comments/${commentId}/resolve`, { resolved });
      setComments((cs) => cs.map((c) => (c.id === commentId ? { ...c, resolved: resolved ? 1 : 0 } : c)));
      sendWsRef.current?.({ type: 'comment-resolve', commentId, resolved });
    },
    [sendWsRef],
  );

  const handleDeleteComment = useCallback(
    async (commentId) => {
      await del(`/api/comments/${commentId}`);
      setComments((cs) => cs.filter((c) => c.id !== commentId));
      sendWsRef.current?.({ type: 'comment-delete', commentId });
    },
    [sendWsRef],
  );

  const handleReplyComment = useCallback(
    async (commentId, text) => {
      const res = await post(`/api/comments/${commentId}/reply`, { text });
      const reply = await res.json();
      setComments((cs) => cs.map((c) => (c.id === commentId ? { ...c, replies: [...(c.replies || []), reply] } : c)));
      sendWsRef.current?.({ type: 'comment-reply', commentId, reply });
    },
    [sendWsRef],
  );

  const handleEditComment = useCallback(
    async (commentId, text) => {
      await patch(`/api/comments/${commentId}`, { text });
      setComments((cs) => cs.map((c) => (c.id === commentId ? { ...c, text } : c)));
      sendWsRef.current?.({ type: 'comment-edit', commentId, text });
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
    updateCommentPositions,
  };
}
