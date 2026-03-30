import { useState, useCallback, useEffect, useRef } from 'react';
import { get, post, patch, del } from '../api.js';

export default function useTrackedChanges(activeFile, user, sendWsRef, editorRef) {
  const [trackChangesMode, setTrackChangesMode] = useState(false);
  const [trackedChanges, setTrackedChanges] = useState([]);
  const [tcPopup, setTcPopup] = useState(null);
  const trackedChangesRef = useRef(trackedChanges);
  trackedChangesRef.current = trackedChanges;

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

  const handleTrackChange = useCallback(
    async (change) => {
      if (!activeFile) return;
      try {
        const myPending = trackedChangesRef.current.filter(
          (tc) => tc.status === 'pending' && tc.author_id === user?.id && tc.inserted_text,
        );

        if (change.deleted_text && !change.inserted_text) {
          for (const existing of myPending) {
            if (change.from_pos >= existing.from_pos && change.from_pos <= existing.to_pos) {
              const offset = change.from_pos - existing.from_pos;
              const delLen = change.deleted_text.length;
              const newInserted =
                existing.inserted_text.slice(0, offset) + existing.inserted_text.slice(offset + delLen);
              if (!newInserted && !existing.deleted_text) {
                await del(`/api/tracked-changes/${existing.id}`);
                setTrackedChanges((tc) => tc.filter((c) => c.id !== existing.id));
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

  const handleDeleteInsertionChar = useCallback(async (pos) => {
    const tc = trackedChangesRef.current.find(
      (c) => c.status === 'pending' && c.inserted_text && pos >= c.from_pos && pos < c.to_pos,
    );
    if (!tc) return;
    const offset = pos - tc.from_pos;
    const newInserted = tc.inserted_text.slice(0, offset) + tc.inserted_text.slice(offset + 1);
    if (!newInserted) {
      try {
        await del(`/api/tracked-changes/${tc.id}`);
        setTrackedChanges((tcs) => tcs.filter((c) => c.id !== tc.id));
      } catch (e) {}
      return;
    }
    try {
      const res = await patch(`/api/tracked-changes/${tc.id}`, {
        from_pos: tc.from_pos,
        to_pos: tc.from_pos + newInserted.length,
        inserted_text: newInserted,
      });
      const updated = await res.json();
      setTrackedChanges((tcs) => tcs.map((c) => (c.id === tc.id ? updated : c)));
    } catch (e) {}
  }, []);

  const handleAcceptChange = useCallback(
    async (changeId) => {
      const change = trackedChangesRef.current.find((c) => c.id === changeId);
      if (!change) return;
      await post(`/api/tracked-changes/${changeId}/accept`);
      if (change.deleted_text) {
        editorRef.current?.replaceRange?.(change.from_pos, change.to_pos, '');
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
      await post(`/api/tracked-changes/${changeId}/reject`);
      if (change.inserted_text) {
        editorRef.current?.replaceRange?.(change.from_pos, change.to_pos, '');
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
      editorRef.current?.replaceRange?.(c.from_pos, c.to_pos, '');
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
      editorRef.current?.replaceRange?.(c.from_pos, c.to_pos, '');
    }
    setTrackedChanges((tc) => tc.map((c) => (c.status === 'pending' ? { ...c, status: 'rejected' } : c)));
  }, [activeFile, editorRef]);

  return {
    trackChangesMode,
    setTrackChangesMode,
    trackedChanges,
    setTrackedChanges,
    tcPopup,
    setTcPopup,
    handleTrackChange,
    handleDeleteInsertionChar,
    handleAcceptChange,
    handleRejectChange,
    handleAcceptAllChanges,
    handleRejectAllChanges,
  };
}
