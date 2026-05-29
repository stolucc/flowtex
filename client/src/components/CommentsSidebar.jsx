import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import useClickOutside from '../hooks/useClickOutside.js';
import { formatFullDate as formatDate } from '../utils/dateFormat.js';
import { MentionInput, renderMentionText, extractMentions } from './MentionInput.jsx';

// Same fixed palette as chat reactions — keeps the picker tight.
const REACTION_PALETTE = ['👍', '❤️', '😄', '🎉', '🤔', '👀', '✅', '❌'];

/** Reaction pill row + ☺ trigger + popover picker. Used on both top-level
 *  comments and on replies — `targetId` is whichever entity the parent wants
 *  to react on, passed straight through to `onReact`. */
function ReactionRow({ reactions, currentUserId, targetId, onReact, onChange }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setPickerOpen(false), pickerOpen);

  useEffect(() => {
    onChange?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reactions?.length, pickerOpen]);

  return (
    <div className="comment-reactions-row" ref={ref}>
      {Array.isArray(reactions) && reactions.length > 0 && (
        <div className="comment-reactions">
          {reactions.map((r) => {
            const mine = r.users.some((u) => u.id === currentUserId);
            const tip = r.users.map((u) => u.name).join(', ');
            return (
              <button
                key={r.emoji}
                type="button"
                className={`comment-reaction-pill${mine ? ' mine' : ''}`}
                title={tip}
                onClick={() => onReact(targetId, r.emoji)}
              >
                <span className="comment-reaction-emoji">{r.emoji}</span>
                <span className="comment-reaction-count">{r.count}</span>
              </button>
            );
          })}
        </div>
      )}
      <button
        type="button"
        className="comment-react-trigger"
        aria-label="Add reaction"
        title="Add reaction"
        onClick={() => setPickerOpen((v) => !v)}
      >
        ☺
      </button>
      {pickerOpen && (
        <div className="comment-react-picker" role="menu">
          {REACTION_PALETTE.map((e) => (
            <button
              key={e}
              type="button"
              className="comment-react-picker-btn"
              onClick={() => {
                onReact(targetId, e);
                setPickerOpen(false);
              }}
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Single comment thread with inline replies, edit/delete actions, and resolve toggle. */
function CommentBubble({ comment, currentUserName, members, currentUserId, onResolve, onDelete, onEdit, onReply, onReact, onReactReply, innerRef, onLayoutChange }) {
  const [replyText, setReplyText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(comment.text);
  const menuRef = useRef(null);

  const hadText = useRef(false);

  const handleReply = () => {
    if (replyText.trim()) {
      onReply(comment.id, replyText.trim());
      setReplyText('');
    }
  };

  const handleEdit = () => {
    if (editText.trim() && editText.trim() !== comment.text) {
      onEdit(comment.id, editText.trim());
    }
    setEditing(false);
  };

  useEffect(() => {
    const hasText = !!replyText.trim();
    if (hasText !== hadText.current) {
      hadText.current = hasText;
      onLayoutChange?.();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyText]);

  useEffect(() => {
    onLayoutChange?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  useClickOutside(menuRef, () => setMenuOpen(false), menuOpen);

  return (
    <div
      ref={innerRef}
      className={`comment-item ${comment.resolved ? 'resolved' : ''}`}
    >
      {comment.assigned_to && (
        <div className="comment-assignment">
          Assigned to {comment.assigned_to === currentUserId ? 'you' : (members?.find((m) => m.id === comment.assigned_to)?.name || 'someone')}
        </div>
      )}
      <div className="comment-top-actions">
        <button
          className="comment-resolve-btn"
          onClick={() => onResolve(comment.id, !comment.resolved)}
          title={comment.resolved ? 'Reopen' : 'Resolve'}
        >
          {comment.resolved ? '↩' : '✓'}
        </button>
        <div className="comment-menu-wrapper" ref={menuRef}>
          <button className="comment-menu-btn" onClick={() => setMenuOpen(!menuOpen)} title="More options">
            ⋯
          </button>
          {menuOpen && (
            <div className="comment-menu-dropdown">
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setEditText(comment.text);
                  setEditing(true);
                }}
              >
                Edit
              </button>
              <button
                className="comment-menu-delete"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete(comment.id);
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="comment-author">
        {comment.author === currentUserName ? 'You' : comment.author}
      </div>
      <div className="comment-date">{formatDate(comment.created_at)}</div>
      {editing ? (
        <div className="comment-edit-form">
          <textarea
            autoFocus
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleEdit();
              }
              if (e.key === 'Escape') setEditing(false);
            }}
            rows={2}
          />
          <div className="comment-edit-actions">
            <button onClick={() => setEditing(false)}>Cancel</button>
            <button onClick={handleEdit} disabled={!editText.trim()} className="comment-edit-save">
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="comment-text">{renderMentionText(comment.text)}</div>
      )}
      {onReact && (
        <ReactionRow
          reactions={comment.reactions}
          currentUserId={currentUserId}
          targetId={comment.id}
          onReact={onReact}
          onChange={onLayoutChange}
        />
      )}
      {(comment.replies || []).length > 0 && (
        <div className="comment-replies">
          {comment.replies.map((r) => (
            <div key={r.id} className="comment-reply">
              <div className="comment-reply-author">
                {r.author === currentUserName ? 'You' : r.author}
              </div>
              <div className="comment-reply-date">{formatDate(r.created_at)}</div>
              <div className="comment-reply-text">{renderMentionText(r.text)}</div>
              {onReactReply && (
                <ReactionRow
                  reactions={r.reactions}
                  currentUserId={currentUserId}
                  targetId={r.id}
                  onReact={onReactReply}
                  onChange={onLayoutChange}
                />
              )}
            </div>
          ))}
        </div>
      )}
      {!comment.resolved && (
        <div className="comment-reply-area">
          <MentionInput
            placeholder="Reply..."
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleReply();
              }
            }}
            rows={1}
            members={members}
            currentUserId={currentUserId}
          />
          {replyText.trim() && (
            <div className="comment-reply-actions">
              <button onClick={() => setReplyText('')}>Cancel</button>
              <button onClick={handleReply} className="comment-reply-submit">
                Reply
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Sidebar displaying editor comments with elastic positioning aligned to source lines. */
export default function CommentsSidebar({
  currentUserName,
  currentUserId,
  members,
  comments,
  selection,
  selectionFormTop,
  commentPositions,
  onAdd,
  onResolve,
  onDelete,
  onEdit,
  onReact,
  onReactReply,
  onCancelComment,
  onReply,
  onWheel,
  onClose,
  style,
}) {
  const [text, setText] = useState('');
  const [assignTo, setAssignTo] = useState(null);
  const [resolvedCollapsed, setResolvedCollapsed] = useState(true);
  const textareaRef = useRef(null);
  const prevSelectionRef = useRef(null);
  const formRef = useRef(null);
  const commentRefs = useRef({});
  const listRef = useRef(null);

  // Detect @mentions in the new comment text
  const mentionedMembers = useMemo(() => {
    if (!text || !members?.length) return [];
    const names = extractMentions(text, members);
    return members.filter((m) => names.includes(m.name.toLowerCase()));
  }, [text, members]);

  useEffect(() => {
    if (selection && selection !== prevSelectionRef.current) {
      prevSelectionRef.current = selection;
      setText('');
      setAssignTo(null);
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
    if (!selection) {
      prevSelectionRef.current = null;
    }
  }, [selection]);

  // Clear assignTo if the mentioned member is removed from text
  useEffect(() => {
    if (assignTo && !mentionedMembers.some((m) => m.id === assignTo)) {
      setAssignTo(null);
    }
  }, [mentionedMembers, assignTo]);

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    if (!text.trim() || !selection) return;
    await onAdd(text.trim(), { assignedTo: assignTo });
    setText('');
    setAssignTo(null);
  };

  const handleCancel = () => {
    setText('');
    setAssignTo(null);
    onCancelComment?.();
  };

  const unresolvedComments = comments.filter((c) => !c.resolved);
  const resolvedComments = comments.filter((c) => c.resolved);

  // Build target position map from commentPositions
  const posMap = useMemo(() => {
    const map = {};
    for (const p of commentPositions || []) {
      map[p.id] = p.top;
    }
    return map;
  }, [commentPositions]);

  const hasPositions = commentPositions && commentPositions.length > 0;
  const isPositioned = hasPositions || selectionFormTop != null;

  // Compute elastic positions: use target positions but push down if overlapping
  const computeElasticPositions = useCallback(() => {
    if (!isPositioned) return;

    // Collect all items with their target top and DOM element
    const items = [];

    // Add the comment form if active
    if (selection && selectionFormTop != null && formRef.current) {
      items.push({ id: '__form__', targetTop: selectionFormTop, el: formRef.current });
    }

    // Add unresolved comments
    for (const c of unresolvedComments) {
      if (posMap[c.id] != null && commentRefs.current[c.id]) {
        items.push({ id: c.id, targetTop: posMap[c.id], el: commentRefs.current[c.id] });
      }
    }

    // Sort by target position
    items.sort((a, b) => a.targetTop - b.targetTop);

    // Place items, pushing down if they'd overlap
    let nextAvailable = 0;
    const GAP = 8;
    for (const item of items) {
      const top = Math.max(item.targetTop, nextAvailable);
      item.el.style.position = 'absolute';
      item.el.style.top = top + 'px';
      item.el.style.left = '0';
      item.el.style.right = '0';
      nextAvailable = top + item.el.offsetHeight + GAP;
    }

    // Set container min-height to contain all items
    if (listRef.current && items.length > 0) {
      const last = items[items.length - 1];
      const lastBottom = parseFloat(last.el.style.top) + last.el.offsetHeight + GAP;
      listRef.current.style.minHeight = Math.max(lastBottom, listRef.current.parentElement?.clientHeight || 0) + 'px';
    }
  }, [isPositioned, selection, selectionFormTop, unresolvedComments, posMap]);

  // Run elastic positioning after render
  useEffect(() => {
    computeElasticPositions();
  });

  // Also reposition on next frame when called imperatively (e.g. reply toggle)
  const handleLayoutChange = useCallback(() => {
    requestAnimationFrame(() => computeElasticPositions());
  }, [computeElasticPositions]);

  return (
    <div className="comments-sidebar" style={style} onWheel={onWheel}>
      <div className="comments-header">
        <span className="comments-title">Comments</span>
        <span className="comments-count">{unresolvedComments.length}</span>
        {onClose && (
          <button className="comments-close-btn" onClick={onClose} title="Close comments">
            &times;
          </button>
        )}
      </div>

      <div className="comments-body">
        {!selection && unresolvedComments.length === 0 && (
          <div className="comments-empty">Double-click text in the editor to add a comment</div>
        )}

        <div ref={listRef} className={`comments-list ${isPositioned ? 'positioned' : ''}`}>
          {selection && (
            <div ref={formRef} className="comment-form">
              <MentionInput
                innerRef={textareaRef}
                autoFocus
                placeholder="Write a comment..."
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
                rows={3}
                members={members}
                currentUserId={currentUserId}
              />
              {mentionedMembers.length > 0 && (
                <div className="comment-assign-section">
                  {mentionedMembers.map((m) => (
                    <label key={m.id} className="comment-assign-option">
                      <input
                        type="checkbox"
                        checked={assignTo === m.id}
                        onChange={() => setAssignTo(assignTo === m.id ? null : m.id)}
                      />
                      Assign to {m.id === currentUserId ? 'you' : m.name}
                    </label>
                  ))}
                </div>
              )}
              <div className="comment-form-actions">
                <button type="button" className="comment-cancel-btn" onClick={handleCancel}>
                  Cancel
                </button>
                <button type="button" onClick={handleSubmit} disabled={!text.trim()}>
                  Comment
                </button>
              </div>
            </div>
          )}
          {unresolvedComments.map((c) => (
            <CommentBubble
              key={c.id}
              comment={c}
              currentUserName={currentUserName}
              members={members}
              currentUserId={currentUserId}
              onResolve={onResolve}
              onDelete={onDelete}
              onEdit={onEdit}
              onReply={onReply}
              onReact={onReact}
              onReactReply={onReactReply}
              innerRef={(el) => {
                if (el) commentRefs.current[c.id] = el;
              }}
              onLayoutChange={handleLayoutChange}
            />
          ))}
        </div>

        {resolvedComments.length > 0 && (
          <>
            <div
              className="comments-resolved-header"
              onClick={() => setResolvedCollapsed((v) => !v)}
              style={{ cursor: 'pointer', userSelect: 'none' }}
            >
              <span className="comments-resolved-arrow">{resolvedCollapsed ? '▸' : '▾'}</span>
              Resolved ({resolvedComments.length})
            </div>
            {!resolvedCollapsed && (
              <div className="comments-list">
                {resolvedComments.map((c) => (
                  <CommentBubble
                    key={c.id}
                    comment={c}
                    currentUserName={currentUserName}
                    members={members}
                    currentUserId={currentUserId}
                    onResolve={onResolve}
                    onDelete={onDelete}
                    onEdit={onEdit}
                    onReply={onReply}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
