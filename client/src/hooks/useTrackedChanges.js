import { useState, useCallback, useEffect, useRef } from 'react';
import { get, post, patch, del } from '../api.js';

/**
 * Manages tracked changes: creating, merging, accepting/rejecting changes, undo cleanup, and review walkthrough.
 * @param {object|null} activeFile - The currently active file.
 * @param {object|null} user - The authenticated user.
 * @param {import('react').RefObject} sendWsRef - Ref to the WebSocket send function.
 * @param {import('react').RefObject} editorRef - Ref to the editor instance.
 */
export default function useTrackedChanges(activeFile, user, sendWsRef, editorRef) {
  const [trackChangesMode, setTrackChangesMode] = useState(
    () => localStorage.getItem('flowtex-track-changes') === 'true',
  );
  const [trackedChanges, setTrackedChanges] = useState([]);
  const [tcPopup, setTcPopup] = useState(null);
  const trackedChangesRef = useRef(trackedChanges);
  trackedChangesRef.current = trackedChanges;
  const trackChangeLock = useRef(Promise.resolve());

  useEffect(() => {
    localStorage.setItem('flowtex-track-changes', trackChangesMode);
  }, [trackChangesMode]);

  // Load tracked changes for active file
  useEffect(() => {
    if (!activeFile) {
      setTrackedChanges([]);
      return;
    }
    get(`/api/tracked-changes/${activeFile.id}`)
      .then((r) => r.json())
      .then(setTrackedChanges)
      .catch(() => setTrackedChanges([]));
  }, [activeFile]);

  const adjustOtherChanges = useCallback((fileId, changeId, removeFrom, removeTo) => {
    const delta = removeFrom - removeTo;
    if (delta === 0) return;
    setTrackedChanges((tc) =>
      tc.map((c) => {
        if (c.id === changeId || c.status !== 'pending') return c;
        if (c.from_pos >= removeTo) {
          return { ...c, from_pos: c.from_pos + delta, to_pos: c.to_pos + delta };
        }
        return c;
      }),
    );
    post(`/api/tracked-changes/file/${fileId}/adjust-positions`, { afterPos: removeTo, delta });
  }, []);

  const doHandleTrackChange = useCallback(
    async (change) => {
      if (!activeFile) return;
      try {
        const myPending = trackedChangesRef.current.filter(
          (tc) => tc.status === 'pending' && tc.author_id === user?.id && tc.inserted_text,
        );

        if (change.deleted_text && !change.inserted_text) {
          for (const existing of myPending) {
            if (change.from_pos >= existing.from_pos && change.from_pos < existing.to_pos) {
              const offset = change.from_pos - existing.from_pos;
              const delLen = change.deleted_text.length;
              const newInserted =
                existing.inserted_text.slice(0, offset) + existing.inserted_text.slice(offset + delLen);
              if (!newInserted && !existing.deleted_text) {
                await del(`/api/tracked-changes/${existing.id}`);
                setTrackedChanges((tc) => tc.filter((c) => c.id !== existing.id));
                sendWsRef.current?.({ type: 'tracked-change-delete', fileId: activeFile.id, changeId: existing.id });
                return;
              }
              const res = await patch(`/api/tracked-changes/${existing.id}`, {
                from_pos: existing.from_pos,
                to_pos: existing.from_pos + newInserted.length,
                inserted_text: newInserted,
              });
              const updated = await res.json();
              setTrackedChanges((tc) => tc.map((c) => (c.id === existing.id ? updated : c)));
              sendWsRef.current?.({ type: 'tracked-change', fileId: activeFile.id, change: updated });
              return;
            }
          }
        }

        if (change.inserted_text && !change.deleted_text) {
          for (const existing of myPending) {
            if (change.from_pos >= existing.from_pos && change.from_pos <= existing.to_pos) {
              const offset = change.from_pos - existing.from_pos;
              const newInserted =
                existing.inserted_text.slice(0, offset) + change.inserted_text + existing.inserted_text.slice(offset);
              const res = await patch(`/api/tracked-changes/${existing.id}`, {
                from_pos: existing.from_pos,
                to_pos: existing.from_pos + newInserted.length,
                inserted_text: newInserted,
              });
              const updated = await res.json();
              setTrackedChanges((tc) => tc.map((c) => (c.id === existing.id ? updated : c)));
              sendWsRef.current?.({ type: 'tracked-change', fileId: activeFile.id, change: updated });
              return;
            }
          }
        }

        const res = await post(`/api/tracked-changes/${activeFile.id}`, change);
        const saved = await res.json();
        setTrackedChanges((tc) => [...tc, saved]);
        sendWsRef.current?.({ type: 'tracked-change', fileId: activeFile.id, change: saved });
      } catch (err) {
        // ignore
      }
    },
    [activeFile, user, sendWsRef],
  );

  const handleTrackChange = useCallback(
    (change) => {
      // Serialize async calls to prevent overlapping merge logic reading stale state
      trackChangeLock.current = trackChangeLock.current.then(() => doHandleTrackChange(change)).catch((e) => console.warn('Track change error:', e));
    },
    [doHandleTrackChange],
  );

  const handleDeleteInsertionChar = useCallback(
    (pos) => {
      const tc = trackedChangesRef.current.find(
        (c) => c.status === 'pending' && c.inserted_text && pos >= c.from_pos && pos < c.to_pos,
      );
      if (!tc) return;
      const fileId = activeFile?.id;
      const offset = pos - tc.from_pos;
      const newInserted = tc.inserted_text.slice(0, offset) + tc.inserted_text.slice(offset + 1);

      // Update local state AND ref immediately so rapid backspaces see current state
      if (!newInserted && !tc.deleted_text) {
        trackedChangesRef.current = trackedChangesRef.current.filter((c) => c.id !== tc.id);
        setTrackedChanges(trackedChangesRef.current);
      } else {
        trackedChangesRef.current = trackedChangesRef.current.map((c) =>
          c.id === tc.id ? { ...c, inserted_text: newInserted, to_pos: tc.from_pos + newInserted.length } : c,
        );
        setTrackedChanges(trackedChangesRef.current);
      }

      // Adjust positions of other TCs: removing the insertion char shifted the document left by 1
      adjustOtherChanges(fileId, tc.id, pos, pos + 1);

      // Persist to server in background
      (async () => {
        if (!newInserted && !tc.deleted_text) {
          try {
            await del(`/api/tracked-changes/${tc.id}`);
            sendWsRef.current?.({ type: 'tracked-change-delete', fileId, changeId: tc.id });
          } catch {}
        } else {
          try {
            const res = await patch(`/api/tracked-changes/${tc.id}`, {
              from_pos: tc.from_pos,
              to_pos: tc.from_pos + newInserted.length,
              inserted_text: newInserted,
            });
            const updated = await res.json();
            sendWsRef.current?.({ type: 'tracked-change', fileId, change: updated });
          } catch {}
        }
      })();
    },
    [activeFile, sendWsRef, adjustOtherChanges],
  );

  // Clean up tracked insertions that no longer match the document after undo.
  // `docText` is the full document text after the undo.
  const handleUndoInsertions = useCallback(
    (docText) => {
      if (!activeFile) return;
      const fileId = activeFile.id;
      const myPending = trackedChangesRef.current.filter(
        (tc) => tc.status === 'pending' && tc.author_id === user?.id && tc.inserted_text,
      );
      const toDelete = [];
      const toShrink = [];
      for (const tc of myPending) {
        // Check if the inserted text still exists at the expected position
        const docSlice = docText.slice(tc.from_pos, tc.to_pos);
        if (docSlice === tc.inserted_text) continue; // still matches, nothing to do

        // Find how much of the inserted text is still present (search near the position)
        // Simple approach: check if a prefix of the inserted text is still at from_pos
        let matchLen = 0;
        for (let i = 0; i < tc.inserted_text.length; i++) {
          if (tc.from_pos + i < docText.length && docText[tc.from_pos + i] === tc.inserted_text[i]) {
            matchLen = i + 1;
          } else {
            break;
          }
        }

        if (matchLen === 0 && !tc.deleted_text) {
          toDelete.push(tc.id);
        } else if (matchLen < tc.inserted_text.length) {
          const newInserted = tc.inserted_text.slice(0, matchLen);
          if (!newInserted && !tc.deleted_text) {
            toDelete.push(tc.id);
          } else {
            toShrink.push({ tc, newInserted });
          }
        }
      }

      // Update local state immediately so UI reflects the change
      if (toDelete.length > 0) {
        const deleteSet = new Set(toDelete);
        setTrackedChanges((tcs) => tcs.filter((c) => !deleteSet.has(c.id)));
      }
      if (toShrink.length > 0) {
        setTrackedChanges((tcs) =>
          tcs.map((c) => {
            const s = toShrink.find((x) => x.tc.id === c.id);
            return s ? { ...c, inserted_text: s.newInserted, to_pos: c.from_pos + s.newInserted.length } : c;
          }),
        );
      }

      // Persist to server and notify collaborators in background
      (async () => {
        for (const id of toDelete) {
          try {
            await del(`/api/tracked-changes/${id}`);
            sendWsRef.current?.({ type: 'tracked-change-delete', fileId, changeId: id });
          } catch {}
        }
        for (const { tc, newInserted } of toShrink) {
          try {
            const res = await patch(`/api/tracked-changes/${tc.id}`, {
              from_pos: tc.from_pos,
              to_pos: tc.from_pos + newInserted.length,
              inserted_text: newInserted,
            });
            const updated = await res.json();
            sendWsRef.current?.({ type: 'tracked-change', fileId, change: updated });
          } catch {}
        }
      })();
    },
    [activeFile, user, sendWsRef],
  );

  const handleAcceptChange = useCallback(
    async (changeId) => {
      const change = trackedChangesRef.current.find((c) => c.id === changeId);
      if (!change) return;
      const resp = await post(`/api/tracked-changes/${changeId}/accept`);
      if (resp.status === 409) return; // already resolved by another user
      if (change.deleted_text) {
        editorRef.current?.resolveTrackedChangeEdit?.(change.from_pos, change.to_pos, '');
        adjustOtherChanges(change.file_id, changeId, change.from_pos, change.to_pos);
      }
      setTrackedChanges((tc) => tc.map((c) => (c.id === changeId ? { ...c, status: 'accepted' } : c)));
      setTcPopup(null);
      sendWsRef.current?.({ type: 'tracked-change-resolve', changeId, status: 'accepted' });
    },
    [sendWsRef, adjustOtherChanges, editorRef],
  );

  const handleRejectChange = useCallback(
    async (changeId) => {
      const change = trackedChangesRef.current.find((c) => c.id === changeId);
      if (!change) return;
      const resp = await post(`/api/tracked-changes/${changeId}/reject`);
      if (resp.status === 409) return; // already resolved by another user
      if (change.inserted_text) {
        editorRef.current?.resolveTrackedChangeEdit?.(change.from_pos, change.to_pos, '');
        adjustOtherChanges(change.file_id, changeId, change.from_pos, change.to_pos);
      }
      setTrackedChanges((tc) => tc.map((c) => (c.id === changeId ? { ...c, status: 'rejected' } : c)));
      setTcPopup(null);
      sendWsRef.current?.({ type: 'tracked-change-resolve', changeId, status: 'rejected' });
    },
    [sendWsRef, adjustOtherChanges, editorRef],
  );

  const handleAcceptAllChanges = useCallback(async () => {
    if (!activeFile) return;
    await post(`/api/tracked-changes/file/${activeFile.id}/accept-all`);
    const pending = trackedChangesRef.current
      .filter((c) => c.status === 'pending' && c.deleted_text)
      .sort((a, b) => b.from_pos - a.from_pos);
    for (const c of pending) {
      editorRef.current?.resolveTrackedChangeEdit?.(c.from_pos, c.to_pos, '');
    }
    setTrackedChanges((tc) => tc.map((c) => (c.status === 'pending' ? { ...c, status: 'accepted' } : c)));
  }, [activeFile, editorRef]);

  const handleRejectAllChanges = useCallback(async () => {
    if (!activeFile) return;
    await post(`/api/tracked-changes/file/${activeFile.id}/reject-all`);
    const pending = trackedChangesRef.current
      .filter((c) => c.status === 'pending' && c.inserted_text)
      .sort((a, b) => b.from_pos - a.from_pos);
    for (const c of pending) {
      editorRef.current?.resolveTrackedChangeEdit?.(c.from_pos, c.to_pos, '');
    }
    setTrackedChanges((tc) => tc.map((c) => (c.status === 'pending' ? { ...c, status: 'rejected' } : c)));
  }, [activeFile, editorRef]);

  // --- Review walkthrough ---
  const [reviewing, setReviewing] = useState(false);
  const [reviewIndex, setReviewIndex] = useState(0);

  const pendingChanges = trackedChanges.filter((c) => c.status === 'pending').sort((a, b) => a.from_pos - b.from_pos);

  // Clamp index when pending list shrinks
  useEffect(() => {
    if (reviewing && reviewIndex >= pendingChanges.length) {
      if (pendingChanges.length === 0) {
        setReviewing(false);
        setReviewIndex(0);
      } else {
        setReviewIndex(pendingChanges.length - 1);
      }
    }
  }, [reviewing, reviewIndex, pendingChanges.length]);

  const startReview = useCallback(() => {
    setReviewing(true);
    setReviewIndex(0);
    const first = trackedChanges.filter((c) => c.status === 'pending').sort((a, b) => a.from_pos - b.from_pos)[0];
    if (first) editorRef.current?.goToPosition(first.from_pos);
  }, [trackedChanges, editorRef]);

  const stopReview = useCallback(() => {
    setReviewing(false);
    setReviewIndex(0);
  }, []);

  const goToReviewIndex = useCallback(
    (idx) => {
      const sorted = trackedChanges.filter((c) => c.status === 'pending').sort((a, b) => a.from_pos - b.from_pos);
      if (sorted[idx]) {
        setReviewIndex(idx);
        editorRef.current?.goToPosition(sorted[idx].from_pos);
      }
    },
    [trackedChanges, editorRef],
  );

  const reviewNext = useCallback(() => {
    goToReviewIndex(Math.min(reviewIndex + 1, pendingChanges.length - 1));
  }, [reviewIndex, pendingChanges.length, goToReviewIndex]);

  const reviewPrev = useCallback(() => {
    goToReviewIndex(Math.max(reviewIndex - 1, 0));
  }, [reviewIndex, goToReviewIndex]);

  const acceptAndNext = useCallback(
    async (changeId) => {
      await handleAcceptChange(changeId);
      // After accepting, the pending list shrinks; effect will clamp index.
      // Navigate to the same index (which is now the next change).
      setTimeout(() => {
        const sorted = trackedChangesRef.current
          .filter((c) => c.status === 'pending' && c.id !== changeId)
          .sort((a, b) => a.from_pos - b.from_pos);
        if (sorted.length === 0) {
          setReviewing(false);
          setReviewIndex(0);
          return;
        }
        const nextIdx = Math.min(reviewIndex, sorted.length - 1);
        setReviewIndex(nextIdx);
        editorRef.current?.goToPosition(sorted[nextIdx].from_pos);
      }, 50);
    },
    [handleAcceptChange, reviewIndex, editorRef],
  );

  const rejectAndNext = useCallback(
    async (changeId) => {
      await handleRejectChange(changeId);
      setTimeout(() => {
        const sorted = trackedChangesRef.current
          .filter((c) => c.status === 'pending' && c.id !== changeId)
          .sort((a, b) => a.from_pos - b.from_pos);
        if (sorted.length === 0) {
          setReviewing(false);
          setReviewIndex(0);
          return;
        }
        const nextIdx = Math.min(reviewIndex, sorted.length - 1);
        setReviewIndex(nextIdx);
        editorRef.current?.goToPosition(sorted[nextIdx].from_pos);
      }, 50);
    },
    [handleRejectChange, reviewIndex, editorRef],
  );

  const reviewCurrentChange = reviewing ? pendingChanges[reviewIndex] || null : null;

  return {
    trackChangesMode,
    setTrackChangesMode,
    trackedChanges,
    setTrackedChanges,
    tcPopup,
    setTcPopup,
    handleTrackChange,
    handleDeleteInsertionChar,
    handleUndoInsertions,
    handleAcceptChange,
    handleRejectChange,
    handleAcceptAllChanges,
    handleRejectAllChanges,
    // Review walkthrough
    reviewing,
    reviewIndex,
    reviewCurrentChange,
    pendingChanges,
    startReview,
    stopReview,
    reviewNext,
    reviewPrev,
    acceptAndNext,
    rejectAndNext,
  };
}
