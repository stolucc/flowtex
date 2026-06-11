// @ts-check
// V1 tracked-changes hook (M2 model — see TRACK-CHANGES-RULES.md).
//
// Reads the live list of pending TC entries from the editor's imperative
// API (`editor.listTcMarks()`), drives accept/reject (§4), and exposes a
// simple review walkthrough so App.jsx can render a bar that lets the
// user step through and resolve pending entries.
//
// V1 is single-author so we don't distinguish foreign vs. own here.
//
// The hook also persists the on/off toggle in localStorage via
// settings.js so it survives reloads.

import { useState, useEffect, useCallback, useRef } from 'react';
import { getSetting, setSetting } from '../utils/settings.js';

/** @type {any[]} */
const EMPTY = [];

/**
 * @param {any} activeFile
 * @param {any} _user
 * @param {any} _sendWsRef
 * @param {any} editorRef
 */
export default function useTrackedChanges(activeFile, _user, _sendWsRef, editorRef) {
  const [trackChangesMode, setTrackChangesMode] = useState(
    () => getSetting('track-changes') === 'true',
  );
  const [trackedChanges, setTrackedChanges] = useState(EMPTY);
  const [reviewing, setReviewing] = useState(false);
  const [reviewIndex, setReviewIndex] = useState(0);

  useEffect(() => {
    setSetting('track-changes', trackChangesMode);
  }, [trackChangesMode]);

  // Refs so callbacks aren't churned by every state change.
  const editorRefRef = useRef(editorRef);
  editorRefRef.current = editorRef;
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;

  /**
   * Re-read pending entries from the editor's marks field. App.jsx wires
   * this to the editor's `onDocChange` prop so the review list stays in
   * sync after every transaction (typing, accept/reject, hydration).
   */
  const refreshFromDoc = useCallback(() => {
    const handle = editorRefRef.current?.current;
    if (!handle || typeof handle.listTcMarks !== 'function') {
      setTrackedChanges(EMPTY);
      return;
    }
    const marks = handle.listTcMarks();
    setTrackedChanges(
      marks.map((/** @type {any} */ m) => ({
        id: m.id,
        type: m.type,
        from: m.from,
        to: m.to,
        author: m.authorName || '',
        authorId: m.authorId || '',
        timestamp: m.timestamp || '',
      })),
    );
  }, []);

  // Re-read on file change.
  useEffect(() => {
    refreshFromDoc();
  }, [activeFile?.id, refreshFromDoc]);

  // Sorted by document position — the natural reading order for review.
  const pendingChanges = trackedChanges.slice().sort((a, b) => a.from - b.from);

  // Viewport-relative top for each pending mark, so the review panel can
  // place its cards alongside the marked text and slide them in lockstep
  // with editor scroll (mirrors commentPositions in useComments).
  const [tcPositions, setTcPositions] = useState(/** @type {any[]} */ ([]));
  const updateTcPositions = useCallback(() => {
    const handle = editorRefRef.current?.current;
    if (!handle || typeof handle.getTopForPos !== 'function') {
      setTcPositions([]);
      return;
    }
    const { scrollTop } = handle.getScrollInfo();
    const marks = typeof handle.listTcMarks === 'function' ? handle.listTcMarks() : [];
    setTcPositions(
      marks.map((/** @type {any} */ m) => ({ id: m.id, top: handle.getTopForPos(m.from) - scrollTop })),
    );
  }, []);
  useEffect(() => {
    updateTcPositions();
  }, [trackedChanges, updateTcPositions]);

  // ── Single-mark resolve ────────────────────────────────────────────
  const handleAcceptChange = useCallback((/** @type {string} */ id) => {
    editorRefRef.current?.current?.applyMarkResolution?.(id, 'accept');
    refreshFromDoc();
  }, [refreshFromDoc]);

  const handleRejectChange = useCallback((/** @type {string} */ id) => {
    editorRefRef.current?.current?.applyMarkResolution?.(id, 'reject');
    refreshFromDoc();
  }, [refreshFromDoc]);

  // ── Bulk resolve ───────────────────────────────────────────────────
  const handleAcceptAllChanges = useCallback(() => {
    editorRefRef.current?.current?.applyMarkResolutionAll?.('accept');
    refreshFromDoc();
  }, [refreshFromDoc]);

  const handleRejectAllChanges = useCallback(() => {
    editorRefRef.current?.current?.applyMarkResolutionAll?.('reject');
    refreshFromDoc();
  }, [refreshFromDoc]);

  // ── Review walkthrough ─────────────────────────────────────────────
  // Clamp index when the pending list shrinks (e.g. after an accept).
  useEffect(() => {
    if (reviewing && pendingChanges.length === 0) {
      setReviewing(false);
      setReviewIndex(0);
    } else if (reviewing && reviewIndex >= pendingChanges.length) {
      setReviewIndex(Math.max(0, pendingChanges.length - 1));
    }
  }, [reviewing, reviewIndex, pendingChanges.length]);

  const startReview = useCallback(() => {
    setReviewing(true);
    setReviewIndex(0);
    if (pendingChanges.length > 0) {
      editorRefRef.current?.current?.goToPosition?.(pendingChanges[0].from);
    }
  }, [pendingChanges]);

  const stopReview = useCallback(() => {
    setReviewing(false);
    setReviewIndex(0);
  }, []);

  const goToReviewIndex = useCallback((/** @type {number} */ idx) => {
    if (pendingChanges[idx]) {
      setReviewIndex(idx);
      editorRefRef.current?.current?.goToPosition?.(pendingChanges[idx].from);
    }
  }, [pendingChanges]);

  const reviewNext = useCallback(() => {
    goToReviewIndex(Math.min(reviewIndex + 1, pendingChanges.length - 1));
  }, [reviewIndex, pendingChanges.length, goToReviewIndex]);

  const reviewPrev = useCallback(() => {
    goToReviewIndex(Math.max(reviewIndex - 1, 0));
  }, [reviewIndex, goToReviewIndex]);

  // After accept/reject during review, advance to next remaining mark.
  const advanceAfterResolution = useCallback(() => {
    queueMicrotask(() => {
      const handle = editorRefRef.current?.current;
      if (!handle?.listTcMarks) return;
      const remaining = handle.listTcMarks().sort((/** @type {any} */ a, /** @type {any} */ b) => a.from - b.from);
      if (remaining.length === 0) {
        setReviewing(false);
        setReviewIndex(0);
        return;
      }
      const nextIdx = Math.min(reviewIndex, remaining.length - 1);
      setReviewIndex(nextIdx);
      handle.goToPosition?.(remaining[nextIdx].from);
    });
  }, [reviewIndex]);

  const acceptAndNext = useCallback((/** @type {string} */ id) => {
    handleAcceptChange(id);
    advanceAfterResolution();
  }, [handleAcceptChange, advanceAfterResolution]);

  const rejectAndNext = useCallback((/** @type {string} */ id) => {
    handleRejectChange(id);
    advanceAfterResolution();
  }, [handleRejectChange, advanceAfterResolution]);

  const reviewCurrentChange = reviewing ? pendingChanges[reviewIndex] || null : null;

  return {
    trackChangesMode,
    setTrackChangesMode,
    trackedChanges,
    pendingChanges,
    refreshFromDoc,
    handleAcceptChange,
    handleRejectChange,
    handleAcceptAllChanges,
    handleRejectAllChanges,
    tcPositions,
    updateTcPositions,
    reviewing,
    reviewIndex,
    reviewCurrentChange,
    startReview,
    stopReview,
    reviewNext,
    reviewPrev,
    acceptAndNext,
    rejectAndNext,
  };
}
