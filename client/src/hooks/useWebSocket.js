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
  { setComments, setTrackedChanges, setHistoryVersion },
) {
  const [activeUsers, setActiveUsers] = useState([]);
  const [remoteCursors, setRemoteCursors] = useState({});
  const [chatMessages, setChatMessages] = useState([]);
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
        setActiveUsers(msg.users);
      } else if (msg.type === 'changes') {
        window.dispatchEvent(new CustomEvent('ws:changes', { detail: msg }));
      } else if (msg.type === 'cursor') {
        setRemoteCursors((prev) => ({
          ...prev,
          [msg.userId]: { fileId: msg.fileId, head: msg.head, anchor: msg.anchor, userName: msg.userName },
        }));
      } else if (msg.type === 'comment') {
        if (activeFileRef.current?.id === msg.fileId) {
          setComments((cs) => [...cs, msg.comment]);
        }
      } else if (msg.type === 'comment-reply') {
        setComments((cs) =>
          cs.map((c) => (c.id === msg.commentId ? { ...c, replies: [...(c.replies || []), msg.reply] } : c)),
        );
      } else if (msg.type === 'comment-resolve') {
        setComments((cs) => cs.map((c) => (c.id === msg.commentId ? { ...c, resolved: msg.resolved ? 1 : 0 } : c)));
      } else if (msg.type === 'comment-delete') {
        setComments((cs) => cs.filter((c) => c.id !== msg.commentId));
      } else if (msg.type === 'comment-edit') {
        setComments((cs) => cs.map((c) => (c.id === msg.commentId ? { ...c, text: msg.text } : c)));
      } else if (msg.type === 'history_update') {
        setHistoryVersion((v) => (v || 0) + 1);
      } else if (msg.type === 'chat') {
        setChatMessages((prev) => [...prev, msg]);
        if (!showChatRef.current) {
          setUnreadChat((n) => n + 1);
        }
      } else if (msg.type === 'typing') {
        setTypingUsers((prev) => ({ ...prev, [msg.userId]: { userName: msg.userName, ts: Date.now() } }));
      } else if (msg.type === 'invitation') {
        window.dispatchEvent(new CustomEvent('ws:invitation', { detail: msg.invitation }));
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
  }, [user, activeFileRef, setComments, setHistoryVersion, setTrackedChanges]);

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
    const payload = JSON.stringify(msg);
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
