import { useState, useCallback, useEffect, useRef } from 'react';
import { parseAll as parseTcMarkers } from '@shared/tcMarkers.js';
import { getSetting, setSetting } from '../utils/settings.js';

/**
 * Marker-aware tracked-changes hook. The "list of pending tracked
 * changes" is derived directly from the inline tcMarkers in the
 * editor's current document — no DB round-trips, no positions to
 * keep in sync.
 *
 * The hook returns the same shape the rest of the UI components
 * (TrackChangesPopup, TrackChangesReviewBar, App.jsx) consume, so
 * no caller changes were needed when the legacy table-driven path
 * went away.
 *
 * @param {object|null} activeFile - Currently active file.
 * @param {object|null} user        - Authenticated user.
 * @param {React.RefObject} sendWsRef - WebSocket sender ref. Currently
 *                                      unused; kept in the signature so
 *                                      App.jsx wiring stays stable while
 *                                      the rest of the legacy code is
 *                                      ripped out.
 * @param {React.RefObject} editorRef - Editor's imperative-handle ref.
 *                                      Used for applyMarkerResolution
 *                                      and goToPosition.
 */
export default function useTrackedChanges(activeFile, user, sendWsRef, editorRef) {
  void user; void sendWsRef;

  const [trackChangesMode, setTrackChangesMode] = useState(
    () => getSetting('track-changes') === 'true',
  );
  const [trackedChanges, setTrackedChanges] = useState([]);
  const [tcPopup, setTcPopup] = useState(null);

  useEffect(() => {
    setSetting('track-changes', trackChangesMode);
  }, [trackChangesMode]);

  // Stable refs: editorRef is a React ref (intrinsically stable) but
  // the OBJECT identity may change between renders if a parent
  // accidentally creates a new wrapper, which would re-fire deps. Mirror
  // it so callbacks can read it without listing it as a dep. activeFile
  // gets the same treatment for the same reason — its identity changes
  // on every selectFile call.
  const editorRefRef = useRef(editorRef);
  editorRefRef.current = editorRef;
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;

  /**
   * Re-parse markers from the editor's current doc and rebuild the
   * trackedChanges list. App.jsx wires this to the editor's
   * `onDocChange` prop so it fires after every doc-changed transaction.
   */
  const refreshFromDoc = useCallback(() => {
    const view = editorRefRef.current?.current;
    if (!view || typeof view.getContent !== 'function') {
      setTrackedChanges([]);
      return;
    }
    const docText = view.getContent();
    if (typeof docText !== 'string') {
      setTrackedChanges([]);
      return;
    }
    const markers = parseTcMarkers(docText);
    const fileId = activeFileRef.current?.id || null;
    setTrackedChanges(
      markers.map((m) => ({
        id: m.id,
        file_id: fileId,
        status: 'pending',
        author_name: m.author,
        inserted_text: m.type === 'ins' ? m.text : '',
        deleted_text: m.type === 'del' ? m.text : '',
        from_pos: m.from,
        to_pos: m.to,
      })),
    );
  }, []);

  // Re-parse whenever the active file changes — the new file's content
  // has its own markers (or none), and the previous file's list is
  // stale.
  useEffect(() => {
    refreshFromDoc();
  }, [activeFile?.id, refreshFromDoc]);

  // Pending changes (sorted by document position).
  const pendingChanges = trackedChanges
    .filter((c) => c.status === 'pending')
    .sort((a, b) => a.from_pos - b.from_pos);

  // ── Resolve a single marker by id ────────────────────────────────
  const handleAcceptChange = useCallback((changeId) => {
    editorRefRef.current?.current?.applyMarkerResolution?.(changeId, 'accept');
    setTcPopup(null);
    refreshFromDoc();
  }, [refreshFromDoc]);
  const handleRejectChange = useCallback((changeId) => {
    editorRefRef.current?.current?.applyMarkerResolution?.(changeId, 'reject');
    setTcPopup(null);
    refreshFromDoc();
  }, [refreshFromDoc]);

  // ── Bulk resolve ─────────────────────────────────────────────────
  const handleAcceptAllChanges = useCallback(() => {
    editorRefRef.current?.current?.applyMarkerResolutionAll?.('accept');
    refreshFromDoc();
  }, [refreshFromDoc]);
  const handleRejectAllChanges = useCallback(() => {
    editorRefRef.current?.current?.applyMarkerResolutionAll?.('reject');
    refreshFromDoc();
  }, [refreshFromDoc]);

  // ── Review walkthrough ───────────────────────────────────────────
  const [reviewing, setReviewing] = useState(false);
  const [reviewIndex, setReviewIndex] = useState(0);

  // Clamp index when pending list shrinks (e.g. last change just got accepted).
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
    if (pendingChanges.length > 0) {
      editorRefRef.current?.current?.goToPosition?.(pendingChanges[0].from_pos);
    }
  }, [pendingChanges]);

  const stopReview = useCallback(() => {
    setReviewing(false);
    setReviewIndex(0);
  }, []);

  const goToReviewIndex = useCallback((idx) => {
    if (pendingChanges[idx]) {
      setReviewIndex(idx);
      editorRefRef.current?.current?.goToPosition?.(pendingChanges[idx].from_pos);
    }
  }, [pendingChanges]);

  const reviewNext = useCallback(() => {
    goToReviewIndex(Math.min(reviewIndex + 1, pendingChanges.length - 1));
  }, [reviewIndex, pendingChanges.length, goToReviewIndex]);

  const reviewPrev = useCallback(() => {
    goToReviewIndex(Math.max(reviewIndex - 1, 0));
  }, [reviewIndex, goToReviewIndex]);

  const navigateToNextRemaining = useCallback(() => {
    queueMicrotask(() => {
      const view = editorRefRef.current?.current;
      if (!view) return;
      const docText = view.getContent?.() || '';
      const remaining = parseTcMarkers(docText)
        .map((m) => m.from)
        .sort((a, b) => a - b);
      if (remaining.length === 0) {
        setReviewing(false);
        setReviewIndex(0);
        return;
      }
      const nextIdx = Math.min(reviewIndex, remaining.length - 1);
      setReviewIndex(nextIdx);
      view.goToPosition?.(remaining[nextIdx]);
    });
  }, [reviewIndex]);

  const acceptAndNext = useCallback((changeId) => {
    handleAcceptChange(changeId);
    navigateToNextRemaining();
  }, [handleAcceptChange, navigateToNextRemaining]);

  const rejectAndNext = useCallback((changeId) => {
    handleRejectChange(changeId);
    navigateToNextRemaining();
  }, [handleRejectChange, navigateToNextRemaining]);

  const reviewCurrentChange = reviewing ? pendingChanges[reviewIndex] || null : null;

  // ── Legacy no-op handlers ────────────────────────────────────────
  // The new model produces tracked changes via the editor's transaction
  // filter (tcMarkerInput). The hooks below are kept as no-ops so the
  // existing prop wiring in App.jsx and Editor.jsx continues to compile
  // until the next cleanup pass tears them out.
  const handleTrackChange = useCallback(() => {}, []);
  const handleDeleteInsertionChar = useCallback(() => {}, []);
  const handleUndoInsertions = useCallback(() => {}, []);

  return {
    trackChangesMode,
    setTrackChangesMode,
    trackedChanges,
    setTrackedChanges,
    refreshFromDoc,
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
