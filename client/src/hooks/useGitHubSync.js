import { useState, useEffect, useRef } from 'react';
import { get, post, patch } from '../api.js';

export default function useGitHubSync(project) {
  const [githubLink, setGithubLink] = useState(null);
  const [autoSyncStatus, setAutoSyncStatus] = useState('');
  const autoSyncTimer = useRef(null);

  // Fetch GitHub link status
  useEffect(() => {
    if (!project) {
      setGithubLink(null);
      return;
    }
    get(`/api/github/link/${project.id}`)
      .then((r) => r.json())
      .then(setGithubLink)
      .catch(() => {});
  }, [project]);

  // Auto-push to GitHub on interval
  useEffect(() => {
    if (autoSyncTimer.current) {
      clearInterval(autoSyncTimer.current);
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
          setGithubLink((prev) =>
            prev ? { ...prev, lastSyncAt: new Date().toISOString(), lastSyncCommit: d.commit } : prev,
          );
        } else {
          setAutoSyncStatus('error');
        }
      } catch {
        setAutoSyncStatus('error');
      }
      setTimeout(() => setAutoSyncStatus(''), 5000);
    }, intervalMs);

    return () => {
      clearInterval(autoSyncTimer.current);
      autoSyncTimer.current = null;
    };
  }, [project, githubLink?.linked, githubLink?.autoPush, githubLink?.autoPushInterval]);

  const handleToggleAutoSync = async () => {
    if (!project || !githubLink?.linked) return;
    const newVal = !githubLink.autoPush;
    await patch(`/api/github/link/${project.id}/auto-push`, { enabled: newVal });
    setGithubLink((prev) => (prev ? { ...prev, autoPush: newVal } : prev));
  };

  return {
    githubLink,
    setGithubLink,
    autoSyncStatus,
    handleToggleAutoSync,
  };
}
