import React, { useState, useEffect, useRef } from 'react';
import { get, post, put, patch, del } from '../api.js';

export default function GitHubSyncModal({ projectId, projectName, onClose, onFilesUpdated, onLinkChanged }) {
  const [hasToken, setHasToken] = useState(false);
  const [link, setLink] = useState(null);
  const [repoMode, setRepoMode] = useState('create'); // 'create' | 'existing'
  const [newRepoName, setNewRepoName] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [repos, setRepos] = useState(null);
  const [repoSearch, setRepoSearch] = useState('');
  const [commitMsg, setCommitMsg] = useState('');
  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const overlayRef = useRef(null);

  useEffect(() => {
    if (projectName) {
      setNewRepoName(
        projectName
          .toLowerCase()
          .replace(/[^a-z0-9-_]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, ''),
      );
    }
  }, [projectName]);

  useEffect(() => {
    get('/api/github/token')
      .then((r) => r.json())
      .then((d) => {
        setHasToken(d.hasToken);
      })
      .catch(() => {});
    get(`/api/github/link/${projectId}`)
      .then((r) => r.json())
      .then(setLink)
      .catch(() => {});
  }, [projectId]);

  const fetchRepos = (force) => {
    if (repos !== null && !force) return;
    setRepos([]);
    get('/api/github/repos')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setRepos(data);
      })
      .catch(() => {});
  };

  const handleOverlayClick = (e) => {
    if (e.target === overlayRef.current) onClose();
  };

  const createAndLink = async () => {
    if (!newRepoName.trim()) return;
    setError('');
    setLoading('create');
    try {
      const createRes = await post('/api/github/repos', { name: newRepoName.trim(), isPrivate });
      const repoData = await createRes.json();

      if (!createRes.ok) {
        const errMsg = repoData.error || 'Failed to create repository';
        if (errMsg.toLowerCase().includes('already exists') || errMsg.toLowerCase().includes('name already exists')) {
          throw new Error(
            `A repository named "${newRepoName}" already exists on your GitHub account. Use "Link existing repo" to connect to it.`,
          );
        }
        throw new Error(errMsg);
      }

      const linkRes = await put(`/api/github/link/${projectId}`, {
        repo: repoData.fullName,
        branch: repoData.defaultBranch || 'main',
      });
      if (!linkRes.ok) {
        const d = await linkRes.json();
        throw new Error(d.error);
      }
      const freshLink = await get(`/api/github/link/${projectId}`);
      const freshData = await freshLink.json();
      setLink(freshData);
      onLinkChanged?.(freshData);
      setSuccess(`Created and linked ${repoData.fullName}`);
    } catch (err) {
      setError(err.message);
    }
    setLoading('');
  };

  const linkExisting = async (repo) => {
    setError('');
    setLoading('link');
    try {
      const res = await put(`/api/github/link/${projectId}`, {
        repo: repo.fullName,
        branch: repo.defaultBranch || 'main',
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error);
      }
      const freshLink = await get(`/api/github/link/${projectId}`);
      const freshData = await freshLink.json();
      setLink(freshData);
      onLinkChanged?.(freshData);
      setSuccess('Repository linked');
    } catch (err) {
      setError(err.message);
    }
    setLoading('');
  };

  const unlinkRepo = async () => {
    await del(`/api/github/link/${projectId}`);
    const unlinked = { linked: false };
    setLink(unlinked);
    onLinkChanged?.(unlinked);
  };

  const handlePush = async () => {
    setLoading('push');
    setError('');
    setSuccess('');
    try {
      const res = await post(`/api/github/push/${projectId}`, { message: commitMsg || 'Update from FlowTex' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      setSuccess(`Pushed successfully${d.commit ? ` (${d.commit.substring(0, 7)})` : ''}`);
      setCommitMsg('');
      const linkRes = await get(`/api/github/link/${projectId}`);
      setLink(await linkRes.json());
    } catch (err) {
      setError(err.message);
    }
    setLoading('');
  };

  const handlePull = async () => {
    setLoading('pull');
    setError('');
    setSuccess('');
    try {
      const res = await post(`/api/github/pull/${projectId}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      setSuccess(`Pulled successfully${d.commit ? ` (${d.commit.substring(0, 7)})` : ''}`);
      if (d.files) onFilesUpdated?.(d.files);
      const linkRes = await get(`/api/github/link/${projectId}`);
      setLink(await linkRes.json());
    } catch (err) {
      setError(err.message);
    }
    setLoading('');
  };

  const filteredRepos = repos ? repos.filter((r) => r.fullName.toLowerCase().includes(repoSearch.toLowerCase())) : [];

  return (
    <div className="modal-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="modal-card github-sync-modal">
        <div className="modal-header">
          <h2>GitHub Sync</h2>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>

        {error && <div className="github-sync-msg error">{error}</div>}
        {success && <div className="github-sync-msg success">{success}</div>}

        {/* Not connected — direct to Account Settings */}
        {!hasToken && (
          <div className="github-sync-section">
            <p className="github-sync-hint">
              Connect your GitHub account first in <strong>Account Settings</strong> (gear icon on the dashboard
              sidebar), then come back here to link a repository.
            </p>
          </div>
        )}

        {/* Step 2: Create or pick a repo */}
        {hasToken && !link?.linked && (
          <div className="github-sync-section">
            <div className="github-sync-mode-tabs">
              <button className={repoMode === 'create' ? 'active' : ''} onClick={() => setRepoMode('create')}>
                Create new repo
              </button>
              <button
                className={repoMode === 'existing' ? 'active' : ''}
                onClick={() => {
                  setRepoMode('existing');
                  fetchRepos();
                }}
              >
                Link existing repo
              </button>
            </div>

            {repoMode === 'create' && (
              <div className="github-sync-create-form">
                <div className="github-sync-input-row">
                  <input
                    placeholder="repository-name"
                    value={newRepoName}
                    onChange={(e) => setNewRepoName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') createAndLink();
                    }}
                    autoFocus
                  />
                  <button onClick={createAndLink} disabled={!newRepoName.trim() || !!loading}>
                    {loading === 'create' ? 'Linking...' : 'Create & Link'}
                  </button>
                </div>
                <label className="github-sync-autosave-toggle">
                  <span className="github-sync-toggle-label">Private repository</span>
                  <span className={`github-sync-switch ${isPrivate ? 'on' : ''}`}>
                    <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
                    <span className="github-sync-switch-slider" />
                  </span>
                </label>
              </div>
            )}

            {repoMode === 'existing' && (
              <>
                {repos === null || (Array.isArray(repos) && repos.length === 0 && !repoSearch) ? (
                  <div className="github-sync-hint" style={{ padding: '12px 0' }}>
                    Loading repositories...
                  </div>
                ) : (
                  <>
                    <input
                      className="github-sync-repo-search"
                      placeholder="Search repositories..."
                      value={repoSearch}
                      onChange={(e) => setRepoSearch(e.target.value)}
                      autoFocus
                    />
                    <div className="github-sync-repo-list">
                      {filteredRepos.length === 0 && (
                        <div className="github-sync-hint" style={{ padding: '12px' }}>
                          {repoSearch ? 'No matching repositories' : 'No repositories found'}
                        </div>
                      )}
                      {filteredRepos.slice(0, 50).map((repo) => (
                        <button
                          key={repo.fullName}
                          className="github-sync-repo-item"
                          onClick={() => linkExisting(repo)}
                          disabled={!!loading}
                        >
                          <span className="github-sync-repo-name">{repo.fullName}</span>
                          <span className="github-sync-repo-meta">
                            {repo.private ? 'private' : 'public'} · {repo.defaultBranch}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* Step 3: Sync */}
        {hasToken && link?.linked && !confirmDisconnect && (
          <div className="github-sync-section github-sync-linked">
            <div className="github-sync-repo-info">
              <span className="github-sync-status-dot green" />
              <span style={{ wordBreak: 'break-all' }}>
                <strong>{link.repo}</strong> ({link.branch})
              </span>
            </div>
            {link.lastSyncAt && (
              <div className="github-sync-hint">
                Last sync: {new Date(link.lastSyncAt).toLocaleString()}
                {link.lastSyncCommit && ` — ${link.lastSyncCommit.substring(0, 7)}`}
              </div>
            )}
            <label className="github-sync-autosave-toggle">
              <span className="github-sync-toggle-label">
                <span className={`github-sync-status-dot ${link.autoPush ? 'green' : 'red'}`} />
                Auto-save to GitHub every 5 minutes
              </span>
              <span className={`github-sync-switch ${link.autoPush ? 'on' : ''}`}>
                <input
                  type="checkbox"
                  checked={!!link.autoPush}
                  onChange={async (e) => {
                    const enabled = e.target.checked;
                    await patch(`/api/github/link/${projectId}/auto-push`, { enabled });
                    const freshLink = await get(`/api/github/link/${projectId}`);
                    const freshData = await freshLink.json();
                    setLink(freshData);
                    onLinkChanged?.(freshData);
                  }}
                />
                <span className="github-sync-switch-slider" />
              </span>
            </label>
            <div className="github-sync-push">
              <input
                placeholder="Commit message (optional)"
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handlePush();
                }}
              />
              <button className="github-sync-btn push" onClick={handlePush} disabled={!!loading}>
                {loading === 'push' ? 'Pushing...' : 'Push to GitHub'}
              </button>
            </div>
            <div className="github-sync-bottom-row">
              <button className="github-sync-link-btn danger" onClick={() => setConfirmDisconnect(true)}>
                Disconnect from GitHub repository
              </button>
              <button className="github-sync-btn pull" onClick={handlePull} disabled={!!loading}>
                {loading === 'pull' ? 'Pulling...' : 'Pull from GitHub'}
              </button>
            </div>
          </div>
        )}

        {/* Disconnect confirmation */}
        {hasToken && link?.linked && confirmDisconnect && (
          <div className="github-sync-section github-sync-linked">
            <p className="github-sync-confirm-text">
              Disconnect this project from <strong style={{ wordBreak: 'break-all' }}>{link.repo}</strong>?
            </p>
            <p className="github-sync-hint">
              This will only unlink the project. Your GitHub repository will not be affected.
            </p>
            <div className="github-sync-confirm-buttons">
              <button
                className="github-sync-link-btn danger"
                onClick={() => {
                  setConfirmDisconnect(false);
                  unlinkRepo();
                }}
              >
                Yes, disconnect
              </button>
              <button className="github-sync-link-btn" onClick={() => setConfirmDisconnect(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="github-sync-footer">
          <button className="github-sync-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
