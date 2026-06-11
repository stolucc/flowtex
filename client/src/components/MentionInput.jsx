// @ts-check
import React, { useEffect, useMemo, useRef, useState } from 'react';
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
    if (members.some((/** @type {any} */ mb) => mb.name.toLowerCase() === name)) found.push(name);
  }
  return [...new Set(found)];
}

/** Textarea / input wrapper with @mention autocomplete. When `singleLine`
 *  is true, renders an <input> instead of <textarea> — used by chat.
 *
 *  Keyboard inside the picker:
 *    ↓ / ↑           — move selection
 *    Tab / Enter     — accept highlighted candidate
 *  Hitting space (or any char that breaks the @\S* run) hides the
 *  picker naturally. When closed, all keystrokes pass through to the
 *  caller's onKeyDown (so chat's Enter-to-send keeps working).
 * @param {any} props
 */
export function MentionInput({
  value,
  onChange,
  onKeyDown,
  members,
  // Accepted but unused — callers historically supplied it; kept on the
  // surface so a future "filter self out of @-candidates" change has a
  // place to land without touching every caller.
  currentUserId: _currentUserId,
  placeholder,
  rows,
  autoFocus,
  innerRef,
  singleLine = false,
  className,
}) {
  const [cursorPos, setCursorPos] = useState(0);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const localRef = useRef(/** @type {any} */ (null));
  const ref = innerRef || localRef;

  // Candidate list is derived from value + cursor + members. Computed
  // synchronously every render so the picker shows up as soon as the
  // user types '@', without an extra effect tick.
  const candidates = useMemo(() => {
    const before = (value || '').slice(0, cursorPos);
    const match = before.match(/@(\S*)$/);
    if (!match) return [];
    const query = match[1].toLowerCase();
    return (members || [])
      .filter((/** @type {any} */ m) => m.name.toLowerCase().startsWith(query))
      .slice(0, 6);
  }, [value, cursorPos, members]);

  // Clamp selectedIdx whenever the candidate list shrinks so the
  // highlight never points past the end.
  useEffect(() => {
    if (selectedIdx >= candidates.length) setSelectedIdx(0);
  }, [candidates.length, selectedIdx]);

  const handleChange = (/** @type {any} */ e) => {
    onChange(e);
    setCursorPos(e.target.selectionStart ?? 0);
  };

  const handleSelect = (/** @type {any} */ e) => {
    setCursorPos(e.target.selectionStart ?? 0);
  };

  const applyPick = (/** @type {any} */ member) => {
    const before = (value || '').slice(0, cursorPos);
    const match = before.match(/@(\S*)$/);
    if (!match) return;
    const start = cursorPos - match[0].length;
    const nameStr = member.name.includes(' ') ? `@"${member.name}"` : `@${member.name}`;
    const replacement = nameStr + ' ';
    const newText = (value || '').slice(0, start) + replacement + (value || '').slice(cursorPos);
    onChange({ target: { value: newText } });
    const newCursor = start + replacement.length;
    setCursorPos(newCursor);
    setSelectedIdx(0);
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(newCursor, newCursor);
      ref.current?.focus();
    });
  };

  const handleKeyDown = (/** @type {any} */ e) => {
    if (candidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => (i + 1) % candidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        applyPick(candidates[selectedIdx]);
        return;
      }
    }
    onKeyDown?.(e);
  };

  const commonProps = {
    ref,
    autoFocus,
    placeholder,
    value,
    onChange: handleChange,
    onSelect: handleSelect,
    onKeyDown: handleKeyDown,
    className,
  };

  const showPicker = candidates.length > 0;

  return (
    <div className="mention-textarea-wrap">
      {singleLine
        ? <input type="text" {...commonProps} />
        : <textarea {...commonProps} rows={rows} />}
      {showPicker && (
        <div className="mention-autocomplete">
          {candidates.map((/** @type {any} */ m, /** @type {any} */ i) => (
            <button
              key={m.id}
              type="button"
              className={`mention-option${i === selectedIdx ? ' selected' : ''}`}
              onMouseEnter={() => setSelectedIdx(i)}
              onMouseDown={(/** @type {any} */ e) => { e.preventDefault(); applyPick(m); }}
            >
              <span className="mention-option-swatch" style={{ backgroundColor: getColor(m.name) }} />
              {m.name}
              {m.role === 'owner' && <span className="mention-option-role">owner</span>}
            </button>
          ))}
          <div className="mention-autocomplete-hint">↑↓ navigate · Tab/Enter pick · Esc cancel</div>
        </div>
      )}
    </div>
  );
}
