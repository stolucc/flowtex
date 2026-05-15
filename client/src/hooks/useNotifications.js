import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post } from '../api.js';

/** In-app @mention notifications. Fetches the recent set on mount, then
 *  appends real-time mentions delivered via `ws:mention` events. */
export default function useNotifications(user) {
  const [mentions, setMentions] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const mentionsRef = useRef(mentions);
  mentionsRef.current = mentions;

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const r = await get('/api/notifications/mentions');
      if (!r.ok) return;
      const data = await r.json();
      setMentions(Array.isArray(data) ? data : []);
      setLoaded(true);
    } catch (e) {
      console.warn('Failed to load mentions:', e);
    }
  }, [user]);

  useEffect(() => {
    if (!user) {
      setMentions([]);
      setLoaded(false);
      return;
    }
    refresh();
  }, [user, refresh]);

  // Append real-time mentions delivered via WS. Server sends a thin payload;
  // we merge it in optimistically without a refetch, but the next `refresh`
  // will reconcile fields like project_name / file_path that WS doesn't send.
  useEffect(() => {
    if (!user) return;
    const onWs = (e) => {
      const m = e.detail;
      if (!m?.id) return;
      // Dedupe in case server retried — keep the first arrival.
      if (mentionsRef.current.some((x) => x.id === m.id)) return;
      setMentions((prev) => [
        {
          id: m.id,
          comment_id: m.commentId,
          reply_id: m.replyId,
          project_id: m.projectId,
          snippet: m.snippet,
          mentioner_name: m.mentionerName,
          created_at: m.createdAt,
          seen_at: null,
          // project_name / file_path filled in on next refresh
        },
        ...prev,
      ]);
    };
    window.addEventListener('ws:mention', onWs);
    return () => window.removeEventListener('ws:mention', onWs);
  }, [user]);

  const markSeen = useCallback(async (id) => {
    setMentions((prev) => prev.map((m) => (m.id === id ? { ...m, seen_at: new Date().toISOString() } : m)));
    try {
      await post(`/api/notifications/mentions/${id}/seen`, {});
    } catch (e) {
      console.warn('Failed to mark mention seen:', e);
    }
  }, []);

  const markAllSeen = useCallback(async () => {
    const now = new Date().toISOString();
    setMentions((prev) => prev.map((m) => (m.seen_at ? m : { ...m, seen_at: now })));
    try {
      await post('/api/notifications/mentions/seen-all', {});
    } catch (e) {
      console.warn('Failed to mark all mentions seen:', e);
    }
  }, []);

  const unreadCount = mentions.filter((m) => !m.seen_at).length;

  return { mentions, unreadCount, loaded, refresh, markSeen, markAllSeen };
}
