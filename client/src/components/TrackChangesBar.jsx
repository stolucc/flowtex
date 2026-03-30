import React from 'react';

export function TrackChangesPopup({ tcPopup, trackedChanges, onAccept, onReject, onClose }) {
  if (!tcPopup) return null;
  const change = trackedChanges.find((c) => c.id === tcPopup.changeId && c.status === 'pending');
  if (!change) return null;
  return (
    <div className="tc-popup" style={{ position: 'fixed', left: tcPopup.x, top: tcPopup.y + 4, zIndex: 1000 }}>
      <div className="tc-popup-header">
        <span className="tc-popup-author">{change.author_name}</span>
        <button className="tc-popup-close" onClick={onClose}>
          &times;
        </button>
      </div>
      {change.inserted_text && (
        <div className="tc-popup-detail tc-popup-insert">
          + {change.inserted_text.length > 60 ? change.inserted_text.slice(0, 60) + '...' : change.inserted_text}
        </div>
      )}
      {change.deleted_text && (
        <div className="tc-popup-detail tc-popup-delete">
          - {change.deleted_text.length > 60 ? change.deleted_text.slice(0, 60) + '...' : change.deleted_text}
        </div>
      )}
      <div className="tc-popup-buttons">
        <button className="tc-btn tc-btn-accept" onClick={() => onAccept(change.id)}>
          Accept
        </button>
        <button className="tc-btn tc-btn-reject" onClick={() => onReject(change.id)}>
          Reject
        </button>
      </div>
    </div>
  );
}

export function TrackChangesReviewBar({
  trackedChanges,
  onAcceptAll,
  onRejectAll,
  onAccept,
  onReject,
  onGoToPosition,
}) {
  const pending = trackedChanges.filter((c) => c.status === 'pending');
  if (pending.length === 0) return null;
  return (
    <div className="tc-review-bar">
      <span className="tc-review-count">
        {pending.length} pending change{pending.length !== 1 ? 's' : ''}
      </span>
      <div className="tc-review-actions">
        <button className="tc-btn tc-btn-accept-all" onClick={onAcceptAll}>
          Accept All
        </button>
        <button className="tc-btn tc-btn-reject-all" onClick={onRejectAll}>
          Reject All
        </button>
      </div>
      <div className="tc-review-list">
        {pending.map((c) => (
          <div key={c.id} className="tc-review-item" onClick={() => onGoToPosition(c.from_pos)}>
            <span className="tc-review-author">{c.author_name}</span>
            {c.inserted_text && (
              <span className="tc-review-insert">
                +{c.inserted_text.length > 30 ? c.inserted_text.slice(0, 30) + '...' : c.inserted_text}
              </span>
            )}
            {c.deleted_text && (
              <span className="tc-review-delete">
                -{c.deleted_text.length > 30 ? c.deleted_text.slice(0, 30) + '...' : c.deleted_text}
              </span>
            )}
            <button
              className="tc-btn tc-btn-accept"
              onClick={(e) => {
                e.stopPropagation();
                onAccept(c.id);
              }}
              title="Accept"
            >
              ✓
            </button>
            <button
              className="tc-btn tc-btn-reject"
              onClick={(e) => {
                e.stopPropagation();
                onReject(c.id);
              }}
              title="Reject"
            >
              ✗
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
