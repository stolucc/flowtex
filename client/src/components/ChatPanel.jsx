import React, { useState, useEffect, useRef } from 'react';
import { getColor } from './Avatar.jsx';
import { CloseIcon } from './Icons.jsx';

// Small fixed palette — keeps the picker tight and avoids a full unicode
// emoji widget. If users want more, swap for a real picker later.
const REACTION_PALETTE = ['👍', '❤️', '😄', '🎉', '🤔', '👀', '✅', '❌'];

/** Real-time project chat panel with typing indicators and date-grouped messages. */
export default function ChatPanel({
  messages,
  currentUser,
  members,
  readCursors,
  onSend,
  onReact,
  onRead,
  onClose,
  onTyping,
  typingUsers,
}) {
  const [text, setText] = useState('');
  const [pickerForId, setPickerForId] = useState(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const lastTypingSentRef = useRef(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  // Mark the chat as read whenever the panel is mounted and whenever
  // a new message arrives while it's visible. The server upserts the
  // cursor and broadcasts to the room, which updates everyone's
  // own-message indicators.
  //
  // ⚠ onRead is intentionally NOT in the dep array: the parent passes
  // it as an inline arrow, so its identity changes every render. Every
  // chat-read message broadcasts and triggers another render, which
  // would change the callback identity, which would re-fire the effect
  // — an infinite loop that floods WS rate-limit and starves real
  // chat messages. The ref captures the latest callback without
  // making the effect depend on it.
  const onReadRef = useRef(onRead);
  useEffect(() => { onReadRef.current = onRead; }, [onRead]);
  useEffect(() => {
    onReadRef.current?.();
  }, [messages]);

  // Pre-compute "other members" — recipients whose read cursors we
  // need to consult for the seen-by indicator on own messages. Members
  // arrive via the parent's WS-driven hook and may be empty for a
  // brief moment after project switch; default to [] silently.
  const otherMemberIds = (members || [])
    .map((m) => m.id)
    .filter((id) => id && id !== currentUser?.id);

  const otherReaders = (msg) => {
    if (!otherMemberIds.length || !readCursors) return 0;
    const msgTs = new Date(msg.created_at).getTime();
    let n = 0;
    for (const uid of otherMemberIds) {
      const lr = readCursors[uid];
      if (lr && new Date(lr).getTime() >= msgTs) n++;
    }
    return n;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
    inputRef.current?.focus();
  };

  const formatTime = (ts) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const handleInput = (e) => {
    setText(e.target.value);
    if (onTyping && Date.now() - lastTypingSentRef.current > 2000) {
      lastTypingSentRef.current = Date.now();
      onTyping();
    }
  };

  // Filter out self and stale typing indicators (>3s old)
  const now = Date.now();
  const typers = Object.entries(typingUsers || {})
    .filter(([uid, info]) => uid !== currentUser?.id && now - info.ts < 3000)
    .map(([, info]) => info.userName);

  // Auto-expire typing indicators
  useEffect(() => {
    if (typers.length === 0) return;
    const timer = setTimeout(() => setTick((t) => t + 1), 3100);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typingUsers]);

  // Close the reaction picker on outside click / Escape.
  useEffect(() => {
    if (!pickerForId) return;
    const close = (e) => {
      if (e.target.closest?.('.chat-react-picker, .chat-react-trigger')) return;
      setPickerForId(null);
    };
    const onKey = (e) => { if (e.key === 'Escape') setPickerForId(null); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [pickerForId]);

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span>Chat</span>
        <button className="chat-close-btn" onClick={onClose} title="Close chat">
          <CloseIcon />
        </button>
      </div>
      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && <div className="chat-empty">No messages yet. Say hello!</div>}
        {messages.map((m, i) => {
          const isOwn = m.userId === currentUser?.id;
          const showAuthor = i === 0 || messages[i - 1].userId !== m.userId;
          const dateStr = new Date(m.created_at).toLocaleDateString([], {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          });
          const prevDateStr =
            i > 0
              ? new Date(messages[i - 1].created_at).toLocaleDateString([], {
                  weekday: 'long',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })
              : null;
          const showDate = i === 0 || dateStr !== prevDateStr;
          return (
            <React.Fragment key={m.id || i}>
              {showDate && (
                <div className="chat-date-separator">
                  <span>{dateStr}</span>
                </div>
              )}
              <div className={`chat-message ${isOwn ? 'own' : ''}`}>
                <div className="chat-bubble">
                  {showAuthor && (
                    <div className="chat-bubble-author" style={isOwn ? undefined : { color: getColor(m.userName) }}>
                      {isOwn ? 'You' : m.userName}
                    </div>
                  )}
                  <span className="chat-bubble-text">{m.text}</span>
                  <span className="chat-bubble-time">
                    {formatTime(m.created_at)}
                    {isOwn && otherMemberIds.length > 0 && (() => {
                      const seen = otherReaders(m);
                      const allSeen = seen === otherMemberIds.length;
                      // Two ticks when everyone has read, one tick when
                      // some but not all, nothing when zero. The aria
                      // label spells it out for screen readers.
                      if (seen === 0) return null;
                      return (
                        <span
                          className={`chat-bubble-read${allSeen ? ' all' : ''}`}
                          aria-label={allSeen ? 'Read by everyone' : `Read by ${seen} of ${otherMemberIds.length}`}
                          title={allSeen ? 'Read by everyone' : `Read by ${seen} of ${otherMemberIds.length}`}
                        >
                          {allSeen ? '✓✓' : '✓'}
                        </span>
                      );
                    })()}
                  </span>
                  {onReact && (
                    <button
                      type="button"
                      className="chat-react-trigger"
                      aria-label="Add reaction"
                      title="Add reaction"
                      onClick={() => setPickerForId(pickerForId === m.id ? null : m.id)}
                    >
                      ☺
                    </button>
                  )}
                  {pickerForId === m.id && (
                    <div className="chat-react-picker" role="menu">
                      {REACTION_PALETTE.map((e) => (
                        <button
                          key={e}
                          type="button"
                          className="chat-react-picker-btn"
                          onClick={() => {
                            onReact(m.id, e);
                            setPickerForId(null);
                          }}
                        >
                          {e}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {Array.isArray(m.reactions) && m.reactions.length > 0 && (
                  <div className="chat-reactions">
                    {m.reactions.map((r) => {
                      const mine = r.users.some((u) => u.id === currentUser?.id);
                      const tip = r.users.map((u) => u.name).join(', ');
                      return (
                        <button
                          key={r.emoji}
                          type="button"
                          className={`chat-reaction-pill${mine ? ' mine' : ''}`}
                          title={tip}
                          onClick={() => onReact?.(m.id, r.emoji)}
                        >
                          <span className="chat-reaction-emoji">{r.emoji}</span>
                          <span className="chat-reaction-count">{r.count}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </React.Fragment>
          );
        })}
      </div>
      {typers.length > 0 && (
        <div className="chat-typing-indicator">
          <span className="chat-typing-dots">
            <span />
            <span />
            <span />
          </span>
          <span className="chat-typing-text">
            {typers.length === 1
              ? `${typers[0]} is typing`
              : `${typers.slice(0, 2).join(' and ')}${typers.length > 2 ? ` and ${typers.length - 2} more` : ''} are typing`}
          </span>
        </div>
      )}
      <form className="chat-input-bar" onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          type="text"
          className="chat-input"
          placeholder="Type a message..."
          value={text}
          onChange={handleInput}
          autoFocus
        />
        <button type="submit" className="chat-send-btn">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </form>
    </div>
  );
}
