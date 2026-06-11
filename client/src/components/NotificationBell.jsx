// @ts-check
import React, { useRef, useState } from 'react';
import useClickOutside from '../hooks/useClickOutside.js';

/** Friendly relative time for the notification dropdown ("3m ago", "2h ago"). */
/** @param {any} iso */
/** @param {any} iso */
function relativeTime(iso) {
  if (!iso) return '';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '';
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Bell icon in the toolbar with an unread badge and a dropdown listing
 * @param {any} props
 *  recent @mentions. Clicking a mention navigates to the project. */
export default function NotificationBell({ mentions, unreadCount, currentProjectId, onOpen, onMarkSeen, onMarkAllSeen, onNavigate }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(/** @type {any} */ (null));
  useClickOutside(ref, () => setOpen(false), open);

  const toggle = () => {
    if (!open) onOpen?.();
    setOpen((/** @type {any} */ v) => !v);
  };

  const handleClickMention = (/** @type {any} */ m) => {
    setOpen(false);
    if (!m.seen_at) onMarkSeen?.(m.id);
    onNavigate?.(m);
  };

  return (
    <div className="notif-wrapper" ref={ref}>
      <button
        className="toolbar-btn notif-bell"
        onClick={toggle}
        title={unreadCount > 0 ? `${unreadCount} unread mention${unreadCount === 1 ? '' : 's'}` : 'Notifications'}
        aria-label="Notifications"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && <span className="notif-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>
      {open && (
        <div className="notif-dropdown">
          <div className="notif-header">
            <span>Mentions</span>
            {unreadCount > 0 && (
              <button className="notif-mark-all" onClick={onMarkAllSeen}>
                Mark all read
              </button>
            )}
          </div>
          {mentions.length === 0 ? (
            <div className="notif-empty">No mentions yet.</div>
          ) : (
            <ul className="notif-list">
              {mentions.map((/** @type {any} */ m) => (
                <li
                  key={m.id}
                  className={`notif-item ${!m.seen_at ? 'unread' : ''}`}
                  onClick={() => handleClickMention(m)}
                >
                  <div className="notif-line1">
                    <strong>{m.mentioner_name || '(deleted user)'}</strong>
                    <span className="notif-time">{relativeTime(m.created_at)}</span>
                  </div>
                  <div className="notif-line2">
                    {m.project_name && (
                      <span className="notif-project">
                        {m.project_name}
                        {m.project_id === currentProjectId ? ' (this project)' : ''}
                      </span>
                    )}
                  </div>
                  {m.snippet && <div className="notif-snippet">{m.snippet}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
