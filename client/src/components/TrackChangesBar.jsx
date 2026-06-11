// @ts-check
// V1 review bar for tracked changes (M2 model).
//
// Shows when there are pending TC entries on the active file. Lets the
// user step through entries one at a time (with prev/next + accept/reject)
// or bulk-resolve via Accept All / Reject All. Designed to be slim and
// stay out of the way.
//
// Mounted once in App.jsx alongside the editor; receives the live
// pending list and the resolution handlers from useTrackedChanges.
import React from 'react';

/** @param {any} props */
export default function TrackChangesBar({
  pendingChanges,
  reviewing,
  reviewIndex,
  reviewCurrentChange,
  currentUserId,
  currentUserName,
  onStartReview,
  onStopReview,
  onReviewNext,
  onReviewPrev,
  onAcceptAndNext,
  onRejectAndNext,
  onAcceptAll,
  onRejectAll,
}) {
  // Display "You" when the change is authored by the current user
  // (matches the TrackChangesPanel + CommentsSidebar conventions).
  const isOwn = (/** @type {any} */ c) =>
    (currentUserId && c?.authorId && c.authorId === currentUserId) ||
    (currentUserName && c?.author && c.author === currentUserName);
  const count = pendingChanges?.length || 0;
  if (count === 0) return null;

  if (!reviewing) {
    return (
      <div className="tc-bar tc-bar-collapsed" role="region" aria-label="Tracked changes">
        <span className="tc-bar-count">
          {count} pending change{count === 1 ? '' : 's'}
        </span>
        <button className="tc-bar-btn" onClick={onStartReview}>
          Review
        </button>
        <button className="tc-bar-btn tc-bar-btn-accept" onClick={onAcceptAll}>
          Accept all
        </button>
        <button className="tc-bar-btn tc-bar-btn-reject" onClick={onRejectAll}>
          Reject all
        </button>
      </div>
    );
  }

  const cur = reviewCurrentChange;
  return (
    <div className="tc-bar tc-bar-reviewing" role="region" aria-label="Reviewing tracked changes">
      <button
        className="tc-bar-btn tc-bar-arrow"
        onClick={onReviewPrev}
        disabled={reviewIndex <= 0}
        aria-label="Previous change"
        title="Previous change"
      >
        ‹
      </button>
      <span className="tc-bar-counter">
        {reviewIndex + 1} / {count}
      </span>
      <button
        className="tc-bar-btn tc-bar-arrow"
        onClick={onReviewNext}
        disabled={reviewIndex >= count - 1}
        aria-label="Next change"
        title="Next change"
      >
        ›
      </button>
      {cur && (
        <span className={`tc-bar-info tc-bar-info-${cur.type}`}>
          <span className="tc-bar-type">{cur.type === 'ins' ? '+' : '−'}</span>
          {(cur.author || isOwn(cur)) && (
            <span className="tc-bar-author">{isOwn(cur) ? 'You' : cur.author}</span>
          )}
        </span>
      )}
      <button
        className="tc-bar-icon-btn tc-bar-icon-accept"
        onClick={() => cur && onAcceptAndNext(cur.id)}
        disabled={!cur}
        title="Accept"
        aria-label="Accept change"
      >
        ✓
      </button>
      <button
        className="tc-bar-icon-btn tc-bar-icon-reject"
        onClick={() => cur && onRejectAndNext(cur.id)}
        disabled={!cur}
        title="Reject"
        aria-label="Reject change"
      >
        ✕
      </button>
      <span className="tc-bar-sep" />
      <button className="tc-bar-btn" onClick={onAcceptAll}>
        Accept all
      </button>
      <button className="tc-bar-btn" onClick={onRejectAll}>
        Reject all
      </button>
      <button className="tc-bar-btn tc-bar-close" onClick={onStopReview} aria-label="Close review">
        ×
      </button>
    </div>
  );
}
