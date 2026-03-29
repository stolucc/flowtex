import React, { useState, useEffect, useRef } from 'react';
import { get, post, put, patch, del } from '../api.js';

export default function GitHubSyncModal({ projectId, projectName, onClose, onFilesUpdated, onLinkChanged }) {
  const [hasToken, setHasToken] = useState(false);
  const [oauthAvailable, setOauthAvailable] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [link, setLink] = useState(null);
  const [showAutoSavePrompt, setShowAutoSavePrompt] = useState(false);
  const [repoMode, setRepoMode] = useState('create'); // 'create' | 'existing'
  const [newRepoName, setNewRepoName] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [repos, setRepos] = useState(null);
  const [repoSearch, setRepoSearch] = useState('');
  const [commitMsg, setCommitMsg] = useState('');
  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const overlayRef = useRef(null);

  useEffect(() => {
    // Suggest a repo name from the project name
    if (projectName) {
      setNewRepoName(projectName.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''));
    }
  }, [projectName]);

  useEffect(() => {
    get('/api/github/token').then((r) => r.json()).then((d) => {
      setHasToken(d.hasToken);
    });
    get('/api/github/oauth/available').then((r) => r.json()).then((d) => {
      setOauthAvailable(d.available);
    });
    get(`/api/github/link/${projectId}`).then((r) => r.json()).then(setLink);

    const params = new URLSearchParams(window.location.search);
    if (params.get('github') === 'connected') {
      setHasToken(true);
      setSuccess('GitHub connected successfully');
      window.history.replaceState({}, '', window.location.pathname);
      setTimeout(() => setSuccess(''), 3000);
    }
  }, [projectId]);

  const fetchRepos = () => {
    if (repos !== null) return; // already loaded
    setRepos([]);
    get('/api/github/repos').then((r) => r.json()).then((data) => {
      if (Array.isArray(data)) setRepos(data);
    }).catch(() => {});
  };

  const handleOverlayClick = (e) => {
    if (e.target === overlayRef.current) onClose();
  };

  const connectWithOAuth = () => {
    window.location.href = '/api/github/oauth/authorize';
  };

  const saveToken = async () => {
    if (!tokenInput.trim()) return;
    setError('');
    const res = await put('/api/github/token', { token: tokenInput.trim() });
    if (res.ok) {
      setHasToken(true);
      setShowTokenInput(false);
      setTokenInput('');
      setSuccess('Token saved');
      setTimeout(() => setSuccess(''), 2000);
    } else {
      const d = await res.json();
      setError(d.error);
    }
  };

  const removeToken = async () => {
    await del('/api/github/token');
    setHasToken(false);
    setShowTokenInput(false);
    setRepos(null);
  };

  const createAndLink = async () => {
    if (!newRepoName.trim()) return;
    setError('');
    setLoading('create');
    try {
      const createRes = await post('/api/github/repos', { name: newRepoName.trim(), isPrivate });
      const repo = await createRes.json();
      if (!createRes.ok) throw new Error(repo.error);

      const linkRes = await put(`/api/github/link/${projectId}`, {
        repo: repo.fullName,
        branch: repo.defaultBranch || 'main',
      });
      if (!linkRes.ok) {
        const d = await linkRes.json();
        throw new Error(d.error);
      }
      const freshLink = await get(`/api/github/link/${projectId}`);
      const freshData = await freshLink.json();
      setLink(freshData);
      onLinkChanged?.(freshData);
      setSuccess(`Created and linked ${repo.fullName}`);
      setShowAutoSavePrompt(true);
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
      setShowAutoSavePrompt(true);
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
    setShowAutoSavePrompt(false);
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

  const filteredRepos = repos
    ? repos.filter((r) => r.fullName.toLowerCase().includes(repoSearch.toLowerCase()))
    : [];

  return (
    <div className="modal-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="modal-card github-sync-modal">
        <div className="modal-header">
          <h2>GitHub Sync</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        {error && <div className="github-sync-msg error">{error}</div>}
        {success && <div className="github-sync-msg success">{success}</div>}

        {/* Step 1: Connect to GitHub */}
        {!hasToken && (
          <div className="github-sync-section">
            <div className="github-sync-connect">
              {oauthAvailable ? (
                <>
                  <button className="github-sync-btn oauth" onClick={connectWithOAuth}>
                    Connect to GitHub
                  </button>
                  <p className="github-sync-hint">
                    Or{' '}
                    <button className="github-sync-link-btn" onClick={() => setShowTokenInput(true)}>
                      use a Personal Access Token
                    </button>{' '}
                    instead.
                  </p>
                </>
              ) : (
                <p className="github-sync-hint">
                  Create a token at GitHub &rarr; Settings &rarr; Developer settings &rarr; Personal access tokens. Needs <code>repo</code> scope.
                </p>
              )}
              {(showTokenInput || !oauthAvailable) && (
                <div className="github-sync-input-row">
                  <input
                    type="password"
                    placeholder="ghp_..."
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveToken(); }}
                  />
                  <button onClick={saveToken} disabled={!tokenInput.trim()}>Save</button>
                  {oauthAvailable && (
                    <button onClick={() => setShowTokenInput(false)}>Cancel</button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Step 2: Create or pick a repo */}
        {hasToken && !link?.linked && (
          <div className="github-sync-section">
            <div className="github-sync-mode-tabs">
              <button className={repoMode === 'create' ? 'active' : ''} onClick={() => setRepoMode('create')}>
                Create new repo
              </button>
              <button className={repoMode === 'existing' ? 'active' : ''} onClick={() => { setRepoMode('existing'); fetchRepos(); }}>
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
                    onKeyDown={(e) => { if (e.key === 'Enter') createAndLink(); }}
                    autoFocus
                  />
                  <button onClick={createAndLink} disabled={!newRepoName.trim() || !!loading}>
                    {loading === 'create' ? 'Creating...' : 'Create & Link'}
                  </button>
                </div>
                <label className="github-sync-private-label">
                  <input
                    type="checkbox"
                    checked={isPrivate}
                    onChange={(e) => setIsPrivate(e.target.checked)}
                  />
                  Private repository
                </label>
              </div>
            )}

            {repoMode === 'existing' && (
              <>
                {repos === null || (Array.isArray(repos) && repos.length === 0 && !repoSearch) ? (
                  <div className="github-sync-hint" style={{ padding: '12px 0' }}>Loading repositories...</div>
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

            <div className="github-sync-disconnect-row">
              <button className="github-sync-link-btn danger" onClick={removeToken}>Disconnect GitHub</button>
            </div>
          </div>
        )}

        {/* Step 3: Sync */}
        {hasToken && link?.linked && (
          <div className="github-sync-section">
            {showAutoSavePrompt && !link.autoPush && (
              <div className="github-sync-autosave-prompt">
                <p>Would you like to enable auto-save? Your project will be automatically saved to GitHub every 5 minutes.</p>
                <div className="github-sync-autosave-prompt-buttons">
                  <button className="github-sync-btn push" onClick={async () => {
                    await patch(`/api/github/link/${projectId}/auto-push`, { enabled: true });
                    const freshLink = await get(`/api/github/link/${projectId}`);
                    const freshData = await freshLink.json();
                    setLink(freshData);
                    onLinkChanged?.(freshData);
                    setShowAutoSavePrompt(false);
                    setSuccess('Auto-save enabled');
                    setTimeout(() => setSuccess(''), 3000);
                  }}>Enable auto-save</button>
                  <button className="github-sync-link-btn" onClick={() => setShowAutoSavePrompt(false)}>Not now</button>
                </div>
              </div>
            )}
            <div className="github-sync-row">
              <span className="github-sync-status-dot green" />
              <span><strong>{link.repo}</strong> ({link.branch})</span>
              <button className="github-sync-link-btn danger" onClick={unlinkRepo}>Unlink</button>
            </div>
            {link.lastSyncAt && (
              <div className="github-sync-hint">
                Last sync: {new Date(link.lastSyncAt).toLocaleString()}
                {link.lastSyncCommit && ` — ${link.lastSyncCommit.substring(0, 7)}`}
              </div>
            )}
            <div className="github-sync-actions">
              <div className="github-sync-push">
                <input
                  placeholder="Commit message (optional)"
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handlePush(); }}
                />
                <button className="github-sync-btn push" onClick={handlePush} disabled={!!loading}>
                  {loading === 'push' ? 'Pushing...' : 'Push to GitHub'}
                </button>
              </div>
              <button className="github-sync-btn pull" onClick={handlePull} disabled={!!loading}>
                {loading === 'pull' ? 'Pulling...' : 'Pull from GitHub'}
              </button>
            </div>
            <label className="github-sync-autosave-toggle">
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
              Auto-save to GitHub every 5 minutes
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
