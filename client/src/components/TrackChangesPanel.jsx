// V2 side panel — Word-style review cards for pending tracked changes.
//
// Toggled on/off via View → "Show changes panel". When on, renders a
// vertical list of cards (one per pending TC entry) with:
//   - The author + relative timestamp
//   - The inserted or deleted text snippet
//   - Accept / Reject buttons
//
// Clicking a card jumps the editor cursor to that change. Cards are
// independent of the inline decorations — the user can hide inline
// markup ("Show changes inline" off) and still review via this panel.

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { formatFullDate as formatDate } from '../utils/dateFormat.js';

const SNIPPET_MAX = 120;

function snippet(text) {
  if (!text) return '';
  return text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX) + '…' : text;
}

export default function TrackChangesPanel({
  docText,
  pendingChanges,
  tcPositions,
  currentUserId,
  currentUserName,
  onAccept,
  onReject,
  onAcceptAll,
  onRejectAll,
  onGoToPosition,
  onClose,
}) {
  const listRef = useRef(null);
  const cardRefs = useRef({});

  // Map id → viewport-relative top, identical pattern to commentPositions.
  const posMap = useMemo(() => {
    const m = {};
    for (const p of tcPositions || []) m[p.id] = p.top;
    return m;
  }, [tcPositions]);
  const isPositioned = (tcPositions?.length || 0) > 0;
  // Display "You" for entries authored by the current user — matches the
  // comments panel UX. Compare authorId first (stable across name changes),
  // fall back to authorName.
  const isOwn = (c) =>
    (currentUserId && c.authorId && c.authorId === currentUserId) ||
    (currentUserName && c.author && c.author === currentUserName);
  // For each pending change, slice the relevant text out of the doc.
  // M2 model: both ins and del cover real chars; the slice IS the change.
  const cards = useMemo(() => {
    if (!Array.isArray(pendingChanges) || !docText) return [];
    return pendingChanges.map((c) => ({
      ...c,
      text: docText.slice(c.from, c.to),
    }));
  }, [pendingChanges, docText]);

  // Elastic packing — same algorithm as CommentsSidebar. Each card sits
  // at its target top (the editor's y for the marked range), but gets
  // pushed down to avoid overlapping the previous card.
  const computeElasticPositions = useCallback(() => {
    if (!isPositioned) return;
    const items = [];
    for (const c of cards) {
      const el = cardRefs.current[c.id];
      if (posMap[c.id] != null && el) {
        items.push({ id: c.id, targetTop: posMap[c.id], el });
      }
    }
    items.sort((a, b) => a.targetTop - b.targetTop);
    const GAP = 8;
    let nextAvailable = 0;
    for (const item of items) {
      const top = Math.max(item.targetTop, nextAvailable);
      item.el.style.position = 'absolute';
      item.el.style.top = top + 'px';
      item.el.style.left = '0';
      item.el.style.right = '0';
      nextAvailable = top + item.el.offsetHeight + GAP;
    }
    if (listRef.current && items.length > 0) {
      const last = items[items.length - 1];
      const lastBottom = parseFloat(last.el.style.top) + last.el.offsetHeight + GAP;
      listRef.current.style.minHeight = Math.max(lastBottom, listRef.current.parentElement?.clientHeight || 0) + 'px';
    }
  }, [isPositioned, cards, posMap]);

  useEffect(() => {
    computeElasticPositions();
  });

  return (
    <div className="tc-panel" role="region" aria-label="Tracked changes">
      <div className="tc-panel-header">
        <span className="tc-panel-title">Review changes</span>
        <span className="tc-panel-count">{cards.length}</span>
        {onClose && (
          <button className="tc-panel-close" onClick={onClose} aria-label="Close panel" title="Close">
            ×
          </button>
        )}
      </div>
      {cards.length === 0 ? (
        <div className="tc-panel-empty">No pending changes.</div>
      ) : (
        <>
          <div className="tc-panel-bulk">
            <button onClick={onAcceptAll}>Accept all</button>
            <button onClick={onRejectAll}>Reject all</button>
          </div>
          <div className="tc-panel-list-scroll">
          <ul ref={listRef} className={`tc-panel-list ${isPositioned ? 'positioned' : ''}`}>
            {cards.map((c) => (
              <li
                key={c.id}
                ref={(el) => {
                  if (el) cardRefs.current[c.id] = el;
                  else delete cardRefs.current[c.id];
                }}
                className={`tc-panel-card tc-panel-card-${c.type}`}
                onClick={() => onGoToPosition?.(c.from)}
                tabIndex={0}
                role="button"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onGoToPosition?.(c.from);
                  }
                }}
              >
                <div className="tc-panel-card-meta">
                  <span className="tc-panel-card-type">
                    {c.type === 'ins' ? 'Inserted' : 'Deleted'}
                  </span>
                  {(c.author || isOwn(c)) && (
                    <>
                      <span className="tc-panel-card-by">by</span>
                      <span className="tc-panel-card-author">
                        {isOwn(c) ? 'You' : c.author}
                      </span>
                    </>
                  )}
                  <span className="tc-panel-card-time">{formatDate(c.timestamp)}</span>
                </div>
                <div className="tc-panel-card-text">
                  {c.text ? `"${snippet(c.text)}"` : <em>(empty)</em>}
                </div>
                <div className="tc-panel-card-actions">
                  <button
                    className="tc-panel-icon-btn tc-panel-icon-accept"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAccept?.(c.id);
                    }}
                    title="Accept"
                    aria-label="Accept change"
                  >
                    ✓
                  </button>
                  <button
                    className="tc-panel-icon-btn tc-panel-icon-reject"
                    onClick={(e) => {
                      e.stopPropagation();
                      onReject?.(c.id);
                    }}
                    title="Reject"
                    aria-label="Reject change"
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
          </div>
        </>
      )}
    </div>
  );
}
