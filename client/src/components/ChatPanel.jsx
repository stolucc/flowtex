import React, { useState, useEffect, useRef } from 'react';
import Avatar from './Avatar.jsx';
import { getColor } from './Avatar.jsx';

export default function ChatPanel({ messages, currentUser, onSend, onClose }) {
  const [text, setText] = useState('');
  const listRef = useRef(null);
  const inputRef = useRef(null);

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

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span>Chat</span>
        <button className="chat-close-btn" onClick={onClose} title="Close chat">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
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
      <form className="chat-input-bar" onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          type="text"
          className="chat-input"
          placeholder="Type a message..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
        <button type="submit" className="chat-send-btn" disabled={!text.trim()}>
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
