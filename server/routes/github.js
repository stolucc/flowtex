import { Router } from 'express';
import crypto from 'crypto';
import { requireMember } from '../middleware/auth.js';
import * as gh from '../services/githubService.js';
import logger from '../logger.js';

const router = Router();

const APP_URL = process.env.APP_URL || 'http://localhost:3001';

// --- GitHub OAuth ---

router.get('/oauth/available', (req, res) => {
  res.json({ available: gh.isOAuthAvailable() });
});

router.get('/oauth/authorize', (req, res) => {
  const clientId = gh.getOAuthClientId();
  if (!clientId) return res.status(500).json({ error: 'GitHub OAuth not configured' });

  const state = crypto.randomBytes(16).toString('hex');
  req.session.githubOAuthState = state;
  let returnTo = req.query.returnTo || '/';
  // Prevent open redirect: must be a relative path, no protocol-relative URLs,
  // no backslashes, no encoded variants, and no authority component
  if (
    !returnTo.startsWith('/') ||
    returnTo.startsWith('//') ||
    returnTo.includes('\\') ||
    returnTo.includes('\0') ||
    /^\/[^/]*@/.test(returnTo)
  ) {
    returnTo = '/';
  }
  // Double-check: parse and reject if it resolves to an external host
  try {
    const parsed = new URL(returnTo, 'http://localhost');
    if (parsed.hostname !== 'localhost') returnTo = '/';
  } catch {
    returnTo = '/';
  }
  req.session.githubOAuthReturnTo = returnTo;
  req.session.save(() => {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${APP_URL}/api/github/oauth/callback`,
      scope: 'repo',
      state,
    });
    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });
});

router.get('/oauth/callback', async (req, res) => {
  if (!req.session?.userId) {
    return res.redirect('/?error=session_expired');
  }
  const { code, state } = req.query;
  if (!code || !state || state !== req.session.githubOAuthState) {
    return res.status(400).send('Invalid OAuth callback. <a href="/">Go back</a>');
  }
  delete req.session.githubOAuthState;

  try {
    const accessToken = await gh.exchangeOAuthCode(code);
    if (!accessToken) {
      return res.status(400).send('GitHub authorization failed. <a href="/">Go back</a>');
    }

    await gh.upsertToken(req.session.userId, accessToken);

    const returnTo = req.session.githubOAuthReturnTo || '/';
    delete req.session.githubOAuthReturnTo;
    const sep = returnTo.includes('?') ? '&' : '?';
    res.redirect(`${returnTo}${sep}github=connected`);
  } catch (err) {
    logger.error({ err }, 'GitHub OAuth error');
    res.status(500).send('GitHub authorization failed. <a href="/">Go back</a>');
  }
});

// --- PAT Management ---

router.put('/token', async (req, res) => {
  const { token } = req.body;
  if (!token || !token.trim()) return res.status(400).json({ error: 'Token is required' });
  await gh.upsertToken(req.session.userId, token.trim());
  res.json({ ok: true });
});

router.get('/token', async (req, res) => {
  const username = await gh.getGitHubUsername(req.session.userId);
  if (username === null) {
    // Check if token exists at all (getGitHubUsername returns null for both no-token and failed-fetch)
    const token = await gh.getUserToken(req.session.userId);
    if (!token) return res.json({ hasToken: false });
  }
  res.json({ hasToken: true, username });
});

router.delete('/token', async (req, res) => {
  await gh.deleteToken(req.session.userId);
  res.json({ ok: true });
});

// --- Project Link Management ---

router.put('/link/:projectId', async (req, res) => {
  const member = await requireMember(req.params.projectId, req.session.userId, res);
  if (!member) return;
  if (member.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot link a repo' });

  const { repo, branch } = req.body;
  if (!repo || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo.trim()))
    return res.status(400).json({ error: 'Repo must be in owner/repo format' });
  if (branch && (!/^[a-zA-Z0-9._\/-]+$/.test(branch) || branch.startsWith('-'))) {
    return res.status(400).json({ error: 'Invalid branch name' });
  }

  await gh.linkProject(req.params.projectId, repo, branch, req.session.userId);
  res.json({ ok: true });
});

router.get('/link/:projectId', async (req, res) => {
  if (!(await requireMember(req.params.projectId, req.session.userId, res))) return;

  const link = await gh.getProjectLink(req.params.projectId);
  if (!link) return res.json({ linked: false });
  res.json({
    linked: true,
    repo: link.github_repo,
    branch: link.default_branch,
    lastSyncAt: link.last_sync_at,
    lastSyncCommit: link.last_sync_commit,
    autoPush: !!link.auto_push,
    autoPushInterval: link.auto_push_interval || 300,
  });
});

router.patch('/link/:projectId/auto-push', async (req, res) => {
  const member = await requireMember(req.params.projectId, req.session.userId, res);
  if (!member) return;
  if (member.role === 'viewer') {
    return res.status(403).json({ error: 'Viewers cannot change auto-push settings' });
  }

  const updated = await gh.updateAutoPush(req.params.projectId, req.body.enabled, req.body.interval);
  if (!updated) return res.status(400).json({ error: 'Nothing to update' });
  res.json({ ok: true });
});

router.delete('/link/:projectId', async (req, res) => {
  const member = await requireMember(req.params.projectId, req.session.userId, res);
  if (!member) return;
  if (member.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot unlink' });

  await gh.unlinkProject(req.params.projectId);
  res.json({ ok: true });
});

// --- User's GitHub repos ---

router.get('/repos', async (req, res) => {
  try {
    const repos = await gh.fetchUserRepos(req.session.userId);
    res.json(repos);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to fetch repos from GitHub' });
  }
});

router.post('/repos', async (req, res) => {
  const { name, isPrivate } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Repository name is required' });

  try {
    const repo = await gh.createRepo(req.session.userId, name, isPrivate);
    res.json(repo);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to create repository on GitHub' });
  }
});

// --- Sync Operations ---

router.post('/push/:projectId', async (req, res) => {
  const member = await requireMember(req.params.projectId, req.session.userId, res);
  if (!member) return;
  if (member.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot push to GitHub' });

  try {
    const result = await gh.pushProject(req.params.projectId, req.session.userId, req.body.message);
    res.json({ ok: true, commit: result.commit });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/pull/:projectId', async (req, res) => {
  const member = await requireMember(req.params.projectId, req.session.userId, res);
  if (!member) return;
  if (member.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot pull from GitHub' });

  try {
    const result = await gh.pullProject(req.params.projectId, req.session.userId);
    res.json({ ok: true, files: result.files, commit: result.commit });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/import', async (req, res) => {
  const { repo, branch } = req.body;
  if (!repo || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo.trim()))
    return res.status(400).json({ error: 'Repo must be in owner/repo format' });

  try {
    const project = await gh.importFromGitHub(req.session.userId, repo, branch);
    res.json(project);
  } catch (err) {
    logger.error({ err }, 'GitHub import error');
    const safeMsg = (err.message || 'Unknown error').replace(/https?:\/\/[^@\s]*@/g, 'https://***@');
    res.status(err.status || 500).json({ error: safeMsg });
  }
});

export default router;
