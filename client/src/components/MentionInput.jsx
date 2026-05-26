import React, { useEffect, useRef, useState } from 'react';
import { getColor } from './Avatar.jsx';

/** Render text with @mentions highlighted. Shared by comments and chat. */
export function renderMentionText(text) {
  if (!text) return text;
  const parts = [];
  const re = /@"([^"]+)"|@(\S+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const name = m[1] || m[2];
    parts.push(<span key={m.index} className="mention-highlight">@{name}</span>);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 1 ? parts : text;
}

/** Extract @mention names that resolve to a known member. Returns lowercase names. */
export function extractMentions(text, members) {
  if (!text || !members?.length) return [];
  const re = /@"([^"]+)"|@(\S+)/g;
  const found = [];
  let m;
  while ((m = re.exec(text))) {
    const name = (m[1] || m[2]).toLowerCase();
    if (members.some((mb) => mb.name.toLowerCase() === name)) found.push(name);
  }
  return [...new Set(found)];
}

/** Autocomplete popup for @mentions in a textarea / input. */
function MentionAutocomplete({ text, cursorPos, members, currentUserId, onSelect }) {
  const [candidates, setCandidates] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const popupRef = useRef(null);

  useEffect(() => {
    const before = text.slice(0, cursorPos);
    const match = before.match(/@(\S*)$/);
    if (!match) {
      setCandidates([]);
      return;
    }
    const query = match[1].toLowerCase();
    const eligible = members.filter((m) => m.name.toLowerCase().startsWith(query));
    setCandidates(eligible.slice(0, 6));
    setSelectedIdx(0);
  }, [text, cursorPos, members, currentUserId]);

  if (candidates.length === 0) return null;

  const handlePick = (member) => {
    const before = text.slice(0, cursorPos);
    const match = before.match(/@(\S*)$/);
    if (!match) return;
    const start = cursorPos - match[0].length;
    const nameStr = member.name.includes(' ') ? `@"${member.name}"` : `@${member.name}`;
    onSelect(start, cursorPos, nameStr + ' ');
  };

  return (
    <div ref={popupRef} className="mention-autocomplete">
      {candidates.map((m, i) => (
        <button
          key={m.id}
          className={`mention-option${i === selectedIdx ? ' selected' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); handlePick(m); }}
        >
          <span className="mention-option-swatch" style={{ backgroundColor: getColor(m.name) }} />
          {m.name}
          {m.role === 'owner' && <span className="mention-option-role">owner</span>}
        </button>
      ))}
    </div>
  );
}

/** Textarea / input wrapper with @mention autocomplete. When `singleLine`
 *  is true, renders an <input> instead of <textarea> — used by chat. */
export function MentionInput({
  value,
  onChange,
  onKeyDown,
  members,
  currentUserId,
  placeholder,
  rows,
  autoFocus,
  innerRef,
  singleLine = false,
  className,
}) {
  const [cursorPos, setCursorPos] = useState(0);
  const localRef = useRef(null);
  const ref = innerRef || localRef;

  const handleChange = (e) => {
    onChange(e);
    setCursorPos(e.target.selectionStart ?? 0);
  };

  const handleSelect = (e) => {
    setCursorPos(e.target.selectionStart ?? 0);
  };

  const handleMentionSelect = (start, end, replacement) => {
    const newText = value.slice(0, start) + replacement + value.slice(end);
    onChange({ target: { value: newText } });
    const newCursor = start + replacement.length;
    setCursorPos(newCursor);
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(newCursor, newCursor);
      ref.current?.focus();
    });
  };

  const commonProps = {
    ref,
    autoFocus,
    placeholder,
    value,
    onChange: handleChange,
    onSelect: handleSelect,
    onKeyDown,
    className,
  };

  return (
    <div className="mention-textarea-wrap">
      {singleLine
        ? <input type="text" {...commonProps} />
        : <textarea {...commonProps} rows={rows} />}
      <MentionAutocomplete
        text={value}
        cursorPos={cursorPos}
        members={members || []}
        currentUserId={currentUserId}
        onSelect={handleMentionSelect}
      />
    </div>
  );
}
