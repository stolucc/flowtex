import { useState, useCallback, useEffect, useRef } from 'react';

// Server-side WS maxPayload is 4 MiB; cap below that to leave headroom and
// guarantee we never send a frame the receiver can't decode.
const WS_MAX_FRAME = 3 * 1024 * 1024;

/**
 * Manages WebSocket connection lifecycle, reconnection, and real-time message handling for collaboration.
 * @param {object|null} user - The authenticated user.
 * @param {object|null} project - The current project.
 * @param {import('react').RefObject} activeFileRef - Ref to the currently active file.
 * @param {object} callbacks - State setters for comments, tracked changes, and history version.
 */
export default function useWebSocket(
  user,
  project,
  activeFileRef,
  { setComments, setHistoryVersion },
) {
  const [activeUsers, setActiveUsers] = useState([]);
  const [remoteCursors, setRemoteCursors] = useState({});
  const [chatMessages, setChatMessages] = useState([]);
  // Per-member "last read at" timestamp for the active project's chat.
  // Map of userId -> ISO timestamp (or null if they've never opened it).
  // Hydrated from the GET /api/chat/:projectId response in App.jsx, then
  // patched live via 'chat-read' WS messages from the server.
  const [chatReadCursors, setChatReadCursors] = useState({});
  const [unreadChat, setUnreadChat] = useState(0);
  const [showChat, setShowChat] = useState(false);
  const [typingUsers, setTypingUsers] = useState({});
  const [wsConnected, setWsConnected] = useState(false);
  const showChatRef = useRef(false);
  showChatRef.current = showChat;
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectDelay = useRef(1000);
  const intentionalClose = useRef(false);
  // Per-tab origin id — stamps every outgoing `changes` frame so we can drop
  // echoes of our own edits if they ever loop back (e.g. on reconnect, a
  // zombie ws on the server can briefly co-exist with the new one and the
  // server's broadcast then reaches the same browser tab). Different tabs of
  // the same user get different ids, so legit multi-tab still works — only
  // self-echoes within one tab are filtered.
  const originIdRef = useRef(
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'origin-' + Math.random().toString(36).slice(2) + Date.now(),
  );

  const connect = useCallback(() => {
    if (!user) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectDelay.current = 1000;
      setWsConnected(true);
      window.dispatchEvent(new Event('ws:connected'));
    };

    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'presence') {
        // Defensive — a malformed presence frame from a future server
        // version (or a manual ws.send injection) shouldnt nuke the
        // active-users list into something non-array that downstream
        // map() / filter() callers would throw on.
        setActiveUsers(Array.isArray(msg.users) ? msg.users : []);
      } else if (msg.type === 'changes') {
        // Drop echoes of our own edits — see originIdRef comment above. The
        // server preserves the originId in its broadcast; if it matches ours,
        // this is a zombie/reconnect echo of a change we already applied
        // locally, and re-applying it would duplicate the text.
        if (msg.originId && msg.originId === originIdRef.current) return;
        window.dispatchEvent(new CustomEvent('ws:changes', { detail: msg }));
      } else if (msg.type === 'cursor') {
        // Same self-echo guard as `changes` — own cursor echoes on reconnect
        // would render as a ghost cursor next to the real one.
        if (msg.originId && msg.originId === originIdRef.current) return;
        setRemoteCursors((prev) => ({
          ...prev,
          [msg.userId]: { fileId: msg.fileId, head: msg.head, anchor: msg.anchor, userName: msg.userName },
        }));
      } else if (msg.type === 'comment') {
        if (activeFileRef.current?.id === msg.fileId) {
          // Dedup by id: comment broadcasts now originate from the HTTP
          // routes (see routes/comments.js) which send to the whole
          // room with no sender exclusion. The author's tab already
          // added the comment from its own HTTP response, so without
          // this guard a self-echo would double-count. Other tabs in
          // the same browser legitimately need the broadcast to pick
          // up tab-A's comment, which this still allows (their state
          // doesn't have msg.comment.id yet).
          setComments((cs) => (cs.some((c) => c.id === msg.comment.id) ? cs : [...cs, msg.comment]));
        }
      } else if (msg.type === 'comment-reply') {
        // Same dedup story for replies (HTTP-originated broadcast).
        setComments((cs) =>
          cs.map((c) =>
            c.id === msg.commentId
              ? {
                  ...c,
                  replies: (c.replies || []).some((r) => r.id === msg.reply.id)
                    ? c.replies
                    : [...(c.replies || []), msg.reply],
                }
              : c,
          ),
        );
      } else if (msg.type === 'comment-resolve') {
        setComments((cs) => cs.map((c) => (c.id === msg.commentId ? { ...c, resolved: msg.resolved ? 1 : 0 } : c)));
      } else if (msg.type === 'comment-delete') {
        setComments((cs) => cs.filter((c) => c.id !== msg.commentId));
      } else if (msg.type === 'comment-edit') {
        setComments((cs) => cs.map((c) => (c.id === msg.commentId ? { ...c, text: msg.text } : c)));
      } else if (msg.type === 'comment-reaction-update') {
        setComments((cs) =>
          cs.map((c) => (c.id === msg.commentId ? { ...c, reactions: msg.reactions } : c)),
        );
      } else if (msg.type === 'reply-reaction-update') {
        setComments((cs) =>
          cs.map((c) =>
            c.id === msg.commentId
              ? {
                  ...c,
                  replies: (c.replies || []).map((r) =>
                    r.id === msg.replyId ? { ...r, reactions: msg.reactions } : r,
                  ),
                }
              : c,
          ),
        );
      } else if (msg.type === 'history_update') {
        setHistoryVersion((v) => (v || 0) + 1);
      } else if (msg.type === 'chat') {
        setChatMessages((prev) => [...prev, msg]);
        if (!showChatRef.current) {
          setUnreadChat((n) => n + 1);
        }
      } else if (msg.type === 'chat-reaction-update') {
        setChatMessages((prev) =>
          prev.map((m) => (m.id === msg.messageId ? { ...m, reactions: msg.reactions } : m)),
        );
      } else if (msg.type === 'chat-read') {
        // Another member just marked the chat as read up to lastReadAt;
        // update their cursor so own-message "seen by" indicators update
        // in real time.
        setChatReadCursors((prev) => ({ ...prev, [msg.userId]: msg.lastReadAt }));
      } else if (msg.type === 'typing') {
        setTypingUsers((prev) => ({ ...prev, [msg.userId]: { userName: msg.userName, ts: Date.now() } }));
      } else if (msg.type === 'invitation') {
        window.dispatchEvent(new CustomEvent('ws:invitation', { detail: msg.invitation }));
      } else if (msg.type === 'mention') {
        // In-app @mention notification — forwarded to useNotifications hook.
        window.dispatchEvent(new CustomEvent('ws:mention', { detail: msg.mention }));
      } else if (msg.type === 'members-update') {
        // Membership changed (invite accepted, member removed, etc.) —
        // useProject refetches the member list in response.
        window.dispatchEvent(new Event('ws:members-update'));
      } else if (msg.type === 'folder-create' || msg.type === 'folder-delete' || msg.type === 'folder-rename') {
        // Folder ops are HTTP, broadcast via WS. Forward to useProject as a
        // single 'ws:folder' event so it can patch local state without a refetch.
        window.dispatchEvent(new CustomEvent('ws:folder', { detail: msg }));
      }
    };

    ws.onclose = (e) => {
      wsRef.current = null;
      setWsConnected(false);
      setActiveUsers([]);
      if (e.code === 4003) {
        // Removed from project by owner
        window.dispatchEvent(new CustomEvent('ws:removed-from-project'));
        return;
      }
      if (!intentionalClose.current) {
        const delay = reconnectDelay.current;
        reconnectDelay.current = Math.min(delay * 2, 30000);
        reconnectTimer.current = setTimeout(connect, delay);
      }
    };
  }, [user, activeFileRef, setComments, setHistoryVersion]);

  // Connect WS when user is logged in (even without a project, for invitations etc.)
  useEffect(() => {
    intentionalClose.current = false;
    if (!user) {
      if (wsRef.current) {
        intentionalClose.current = true;
        wsRef.current.close();
        wsRef.current = null;
      }
      setWsConnected(false);
      setActiveUsers([]);
      return;
    }

    connect();

    return () => {
      intentionalClose.current = true;
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [user, connect]);

  // Wipe collaboration state that's scoped to the previous project when
  // the user switches. Without this, cursors from project A's collaborators
  // would "teleport" into B's editor until B's own WS broadcasts overwrote
  // them, the typing indicator could show "<A user> is typing" inside B,
  // and unreadChat would accumulate across projects forever. Same bug
  // class as the useCompilation leak (commit b023333).
  const lastProjectIdRef = useRef(project?.id ?? null);
  useEffect(() => {
    const newId = project?.id ?? null;
    if (lastProjectIdRef.current !== newId) {
      lastProjectIdRef.current = newId;
      setRemoteCursors({});
      setTypingUsers({});
      setUnreadChat(0);
      setChatMessages([]);
      setChatReadCursors({});
    }
  }, [project?.id]);

  // Join project room when project changes or WS connects
  useEffect(() => {
    if (!project || !user) return;
    const joinMsg = JSON.stringify({ type: 'join', projectId: project.id, userId: user.id, userName: user.name });
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      ws.send(joinMsg);
    }
    // Also join when WS (re)connects after project is already set
    const onConnected = () => {
      const w = wsRef.current;
      if (w && w.readyState === 1) w.send(joinMsg);
    };
    window.addEventListener('ws:connected', onConnected);
    return () => window.removeEventListener('ws:connected', onConnected);
  }, [project, user]);

  // Drop oversized frames client-side (see WS_MAX_FRAME above): if a single
  // edit serializes too large, the local doc still updates and the next HTTP
  // save will bring collaborators back in sync.
  const sendWsMessage = useCallback((msg) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return;
    // Stamp our origin on outgoing edit/cursor frames so the server's
    // broadcast can echo it back unchanged and we can filter our own echoes
    // on receive (defends against the zombie-ws scenario on reconnect).
    const stamped = msg.type === 'changes' || msg.type === 'cursor'
      ? { ...msg, originId: originIdRef.current }
      : msg;
    const payload = JSON.stringify(stamped);
    if (payload.length > WS_MAX_FRAME) {
      console.warn(
        `[ws] dropping ${msg.type} frame (${(payload.length / 1024 / 1024).toFixed(2)} MiB) — exceeds ${WS_MAX_FRAME / 1024 / 1024} MiB cap`,
      );
      return;
    }
    ws.send(payload);
  }, []);

  return {
    activeUsers,
    remoteCursors,
    setRemoteCursors,
    chatMessages,
    setChatMessages,
    chatReadCursors,
    setChatReadCursors,
    unreadChat,
    setUnreadChat,
    showChat,
    setShowChat,
    typingUsers,
    setTypingUsers,
    sendWsMessage,
    wsConnected,
  };
}
