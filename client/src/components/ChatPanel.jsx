// @ts-check
import React, { useState, useEffect, useRef } from 'react';
import { getColor } from './Avatar.jsx';
import { CloseIcon } from './Icons.jsx';
import { MentionInput, renderMentionText } from './MentionInput.jsx';

// Small fixed palette — keeps the picker tight and avoids a full unicode
// emoji widget. If users want more, swap for a real picker later.
const REACTION_PALETTE = ['👍', '❤️', '😄', '🎉', '🤔', '👀', '✅', '❌'];

/**
 * Real-time project chat panel with typing indicators and date-grouped messages.
 * @param {any} props
 */
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
  const [pickerForId, setPickerForId] = useState(/** @type {any} */ (null));
  const listRef = useRef(/** @type {any} */ (null));
  const inputRef = useRef(/** @type {any} */ (null));
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
  const otherMembers = (members || []).filter((/** @type {any} */ m) => m.id && m.id !== currentUser?.id);

  // For a given message, return the names of OTHER members who've
  // read it (cursor timestamp ≥ message timestamp). Used to build
  // the "Read by Alice, Bob" tooltip — counts alone don't tell the
  // sender which collaborator has actually seen the message.
  const readerNames = (/** @type {any} */ msg) => {
    if (!otherMembers.length || !readCursors) return [];
    const msgTs = new Date(msg.created_at).getTime();
    const names = [];
    for (const m of otherMembers) {
      const lr = readCursors[m.id];
      if (lr && new Date(lr).getTime() >= msgTs) names.push(m.name || 'someone');
    }
    return names;
  };

  const handleSubmit = (/** @type {any} */ e) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
    inputRef.current?.focus();
  };

  const formatTime = (/** @type {any} */ ts) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const handleInput = (/** @type {any} */ e) => {
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
    const close = (/** @type {any} */ e) => {
      if (e.target.closest?.('.chat-react-picker, .chat-react-trigger')) return;
      setPickerForId(null);
    };
    const onKey = (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') setPickerForId(null); };
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
        {messages.map((/** @type {any} */ m, /** @type {any} */ i) => {
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
                  <span className="chat-bubble-text">{renderMentionText(m.text)}</span>
                  <span className="chat-bubble-time">
                    {formatTime(m.created_at)}
                    {isOwn && otherMembers.length > 0 && (() => {
                      const names = readerNames(m);
                      if (names.length === 0) return null;
                      const allSeen = names.length === otherMembers.length;
                      // List the actual names so the sender knows WHO
                      // has read it, not just how many. Two ticks when
                      // everyone has read, one when some have.
                      const label = `Read by ${names.join(', ')}`;
                      return (
                        <span
                          className={`chat-bubble-read${allSeen ? ' all' : ''}`}
                          aria-label={label}
                          title={label}
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
                      {REACTION_PALETTE.map((/** @type {any} */ e) => (
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
                    {m.reactions.map((/** @type {any} */ r) => {
                      const mine = r.users.some((/** @type {any} */ u) => u.id === currentUser?.id);
                      const tip = r.users.map((/** @type {any} */ u) => u.name).join(', ');
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
        <MentionInput
          innerRef={inputRef}
          singleLine
          className="chat-input"
          placeholder="Type a message... (@ to mention)"
          value={text}
          onChange={handleInput}
          onKeyDown={(/** @type {any} */ e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
          members={members}
          currentUserId={currentUser?.id}
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
