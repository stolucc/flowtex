// @ts-check
import { useState, useEffect, useRef } from 'react';
import { get, post, patch } from '../api.js';

/**
 * Manages GitHub repository linking, auto-push sync, and sync status for a project.
 * @param {any} project - The current project.
 */
export default function useGitHubSync(project) {
  const [githubLink, setGithubLink] = useState(/** @type {any} */ (null));
  const [hasGithubToken, setHasGithubToken] = useState(false);
  const [autoSyncStatus, setAutoSyncStatus] = useState('');
  /** @type {React.MutableRefObject<ReturnType<typeof setInterval> | null>} */
  const autoSyncTimer = useRef(null);
  // Inner timeout that resets the status pill to '' a few seconds after
  // each auto-push attempt. We track it in a ref so the effect cleanup
  // (and the next tick's setStatus) can clear it — without this the
  // setTimeout outlived the hook and would write to an unmounted
  // component's setter after a project switch.
  /** @type {React.MutableRefObject<ReturnType<typeof setTimeout> | null>} */
  const autoSyncStatusClearTimer = useRef(null);

  // Check if the user has a GitHub token
  useEffect(() => {
    get('/api/github/token')
      .then((r) => r.json())
      .then((d) => setHasGithubToken(!!d.hasToken))
      .catch(() => setHasGithubToken(false));
  }, []);

  // Fetch GitHub link status
  useEffect(() => {
    if (!project) {
      setGithubLink(null);
      return;
    }
    get(`/api/github/link/${project.id}`)
      .then((r) => r.json())
      .then(setGithubLink)
      .catch((e) => console.warn('Failed to load GitHub link:', e));
  }, [project]);

  // Auto-push to GitHub on interval
  useEffect(() => {
    const t = autoSyncTimer.current;
    if (t) {
      clearInterval(t);
      autoSyncTimer.current = null;
    }
    if (!project || !githubLink?.linked || !githubLink?.autoPush) return;

    const intervalMs = (githubLink.autoPushInterval || 300) * 1000;
    autoSyncTimer.current = setInterval(async () => {
      setAutoSyncStatus('saving');
      try {
        const res = await post(`/api/github/push/${project.id}`, { message: 'Auto-save from FlowTex' });
        const d = await res.json();
        if (res.ok) {
          setAutoSyncStatus('saved');
          setGithubLink((/** @type {any} */ prev) =>
            prev ? { ...prev, lastSyncAt: new Date().toISOString(), lastSyncCommit: d.commit } : prev,
          );
        } else {
          setAutoSyncStatus('error');
          // Stop retrying on auth/permission errors — session expired or access revoked
          if (res.status === 401 || res.status === 403) {
            const t2 = autoSyncTimer.current;
            if (t2) clearInterval(t2);
            autoSyncTimer.current = null;
          }
        }
      } catch {
        setAutoSyncStatus('error');
      }
      if (autoSyncStatusClearTimer.current) clearTimeout(autoSyncStatusClearTimer.current);
      autoSyncStatusClearTimer.current = setTimeout(() => {
        setAutoSyncStatus('');
        autoSyncStatusClearTimer.current = null;
      }, 5000);
    }, intervalMs);

    return () => {
      const ti = autoSyncTimer.current;
      if (ti) clearInterval(ti);
      autoSyncTimer.current = null;
      const tc = autoSyncStatusClearTimer.current;
      if (tc) {
        clearTimeout(tc);
        autoSyncStatusClearTimer.current = null;
      }
    };
  }, [project, githubLink?.linked, githubLink?.autoPush, githubLink?.autoPushInterval]);

  const handleToggleAutoSync = async () => {
    if (!project || !githubLink?.linked) return;
    const newVal = !githubLink.autoPush;
    await patch(`/api/github/link/${project.id}/auto-push`, { enabled: newVal });
    setGithubLink((/** @type {any} */ prev) => (prev ? { ...prev, autoPush: newVal } : prev));
  };

  return {
    githubLink,
    setGithubLink,
    hasGithubToken,
    setHasGithubToken,
    autoSyncStatus,
    handleToggleAutoSync,
  };
}
