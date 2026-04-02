import { useState, useCallback, useEffect, useRef } from 'react';

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
  const showChatRef = useRef(false);
  showChatRef.current = showChat;
  const wsRef = useRef(null);

  useEffect(() => {
    if (!user || !project) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setActiveUsers([]);
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', projectId: project.id, userId: user.id, userName: user.name }));
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
        // handled via editorRef in App
        window.dispatchEvent(new CustomEvent('ws:changes', { detail: msg }));
      } else if (msg.type === 'tc-delete-mark') {
        // real-time tracked deletion mark — handled via editorRef in App
        window.dispatchEvent(new CustomEvent('ws:tc-delete-mark', { detail: msg }));
      } else if (msg.type === 'cursor') {
        setRemoteCursors((prev) => ({
          ...prev,
          [msg.userId]: { fileId: msg.fileId, head: msg.head, anchor: msg.anchor, userName: msg.userName },
        }));
      } else if (msg.type === 'comment') {
        if (msg.fileId === activeFileRef.current?.id) {
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
      } else if (msg.type === 'tracked-change') {
        if (msg.fileId === activeFileRef.current?.id) {
          setTrackedChanges((tc) => {
            const idx = tc.findIndex((c) => c.id === msg.change.id);
            if (idx >= 0) {
              const updated = [...tc];
              updated[idx] = msg.change;
              return updated;
            }
            return [...tc, msg.change];
          });
        }
      } else if (msg.type === 'tracked-change-resolve') {
        setTrackedChanges((tc) => tc.map((c) => (c.id === msg.changeId ? { ...c, status: msg.status } : c)));
      } else if (msg.type === 'tracked-change-delete') {
        setTrackedChanges((tc) => tc.filter((c) => c.id !== msg.changeId));
      } else if (msg.type === 'history_update') {
        setHistoryVersion((v) => (v || 0) + 1);
      } else if (msg.type === 'chat') {
        setChatMessages((prev) => [...prev, msg]);
        if (!showChatRef.current) {
          setUnreadChat((n) => n + 1);
        }
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      setActiveUsers([]);
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [user, project]);

  const sendWsMessage = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
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
    sendWsMessage,
  };
}
