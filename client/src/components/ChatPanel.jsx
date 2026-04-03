import React, { useState, useEffect, useRef } from 'react';
import Avatar from './Avatar.jsx';
import { getColor } from './Avatar.jsx';
import { CloseIcon } from './Icons.jsx';

export default function ChatPanel({ messages, currentUser, onSend, onClose, onTyping, typingUsers }) {
  const [text, setText] = useState('');
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const lastTypingSentRef = useRef(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

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
  }, [typingUsers]);

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
                  <span className="chat-bubble-time">{formatTime(m.created_at)}</span>
                </div>
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
