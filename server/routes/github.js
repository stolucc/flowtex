// @ts-check
import { Router } from 'express';
import crypto from 'crypto';
import { requireMember } from '../middleware/auth.js';
import * as gh from '../services/githubService.js';
import { auditLog } from '../utils/audit.js';
import logger from '../logger.js';
import { stripPaths, errInfo } from '../middleware/errorHandler.js';

const router = Router();

const APP_URL = process.env.APP_URL || 'http://localhost:3001';

// --- GitHub OAuth ---

/** GET /api/github/oauth/available -- Check if GitHub OAuth is configured on this instance. */
router.get('/oauth/available', (req, res) => {
  res.json({ available: gh.isOAuthAvailable() });
});

/** GET /api/github/oauth/authorize -- Redirect the user to GitHub's OAuth authorization page. */
router.get('/oauth/authorize', (req, res) => {
  const clientId = gh.getOAuthClientId();
  if (!clientId) return res.status(500).json({ error: 'GitHub OAuth not configured' });

  const state = crypto.randomBytes(16).toString('hex');
  req.session.githubOAuthState = state;
  let returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '/';
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
    const parsed = new URL(returnTo, APP_URL);
    if (parsed.origin !== new URL(APP_URL).origin) returnTo = '/';
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

/** GET /api/github/oauth/callback -- Handle GitHub OAuth callback, exchange code for token. */
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
    await auditLog(req.session.userId, 'github_token_set', { ip: req.ip, detail: 'oauth' });

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

/** PUT /api/github/token -- Save a GitHub personal access token for the current user. */
router.put('/token', async (req, res) => {
  const { token } = req.body;
  if (!token || !token.trim()) return res.status(400).json({ error: 'Token is required' });
  await gh.upsertToken(req.session.userId, token.trim());
  await auditLog(req.session.userId, 'github_token_set', { ip: req.ip, detail: 'pat' });
  res.json({ ok: true });
});

/** GET /api/github/token -- Check if the user has a GitHub token and return the GitHub username. */
router.get('/token', async (req, res) => {
  const token = await gh.getUserToken(req.session.userId);
  if (!token) return res.json({ hasToken: false });
  const username = await gh.getGitHubUsername(req.session.userId);
  if (!username) return res.json({ hasToken: false });
  res.json({ hasToken: true, username });
});

/** DELETE /api/github/token -- Remove the user's stored GitHub token. */
router.delete('/token', async (req, res) => {
  await gh.deleteToken(req.session.userId);
  await auditLog(req.session.userId, 'github_token_revoked', { ip: req.ip });
  res.json({ ok: true });
});

// --- Project Link Management ---

/** PUT /api/github/link/:projectId -- Link a project to a GitHub repository. */
router.put('/link/:projectId', async (req, res) => {
  const member = await requireMember(req.params.projectId, req.session.userId, res);
  if (!member) return;
  if (member.role !== 'editor' && member.role !== 'owner') {
    return res.status(403).json({ error: 'Only editors can link a GitHub repo' });
  }

  const { repo, branch } = req.body;
  if (!repo || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo.trim()))
    return res.status(400).json({ error: 'Repo must be in owner/repo format' });
  if (branch && (!/^[a-zA-Z0-9._/-]+$/.test(branch) || branch.startsWith('-'))) {
    return res.status(400).json({ error: 'Invalid branch name' });
  }

  await gh.linkProject(req.params.projectId, repo, branch, req.session.userId);
  res.json({ ok: true });
});

/** GET /api/github/link/:projectId -- Get the GitHub link details for a project. */
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

/** PATCH /api/github/link/:projectId/auto-push -- Update auto-push settings for a linked project. */
router.patch('/link/:projectId/auto-push', async (req, res) => {
  const member = await requireMember(req.params.projectId, req.session.userId, res);
  if (!member) return;
  if (member.role !== 'editor' && member.role !== 'owner') {
    return res.status(403).json({ error: 'Only editors can change auto-push settings' });
  }

  const updated = await gh.updateAutoPush(req.params.projectId, req.body.enabled, req.body.interval);
  if (!updated) return res.status(400).json({ error: 'Nothing to update' });
  res.json({ ok: true });
});

/** DELETE /api/github/link/:projectId -- Unlink a project from its GitHub repository. */
router.delete('/link/:projectId', async (req, res) => {
  const member = await requireMember(req.params.projectId, req.session.userId, res);
  if (!member) return;
  if (member.role !== 'editor' && member.role !== 'owner') {
    return res.status(403).json({ error: 'Only editors can unlink the GitHub repo' });
  }

  await gh.unlinkProject(req.params.projectId);
  res.json({ ok: true });
});

// --- User's GitHub repos ---

/** GET /api/github/repos -- List the user's GitHub repositories. */
router.get('/repos', async (req, res) => {
  try {
    const repos = await gh.fetchUserRepos(req.session.userId);
    res.json(repos);
  } catch (err) {
    const e = errInfo(err);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Failed to fetch repos from GitHub' });
  }
});

/** POST /api/github/repos -- Create a new GitHub repository for the user. */
router.post('/repos', async (req, res) => {
  const { name, isPrivate } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Repository name is required' });

  try {
    const repo = await gh.createRepo(req.session.userId, name, isPrivate);
    res.json(repo);
  } catch (err) {
    const e = errInfo(err);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Failed to create repository on GitHub' });
  }
});

// --- Sync Operations ---

/** POST /api/github/push/:projectId -- Push project files to the linked GitHub repository. */
router.post('/push/:projectId', async (req, res) => {
  const member = await requireMember(req.params.projectId, req.session.userId, res);
  if (!member) return;
  // Push exfiltrates project files to GitHub -- editor-only. A commenter
  // could otherwise ship the whole project to an attacker-controlled
  // fork by submitting this route with a previously-linked repo.
  if (member.role !== 'editor' && member.role !== 'owner') {
    return res.status(403).json({ error: 'Only editors can push to GitHub' });
  }

  try {
    const result = await gh.pushProject(req.params.projectId, req.session.userId, req.body.message);
    res.json({ ok: true, commit: result.commit });
  } catch (err) {
    const e = errInfo(err);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Failed to push to GitHub' });
  }
});

/** POST /api/github/pull/:projectId -- Pull latest files from GitHub into the project. */
router.post('/pull/:projectId', async (req, res) => {
  const member = await requireMember(req.params.projectId, req.session.userId, res);
  if (!member) return;
  // Pull overwrites file content -- editor-only.
  if (member.role !== 'editor' && member.role !== 'owner') {
    return res.status(403).json({ error: 'Only editors can pull from GitHub' });
  }

  try {
    const result = await gh.pullProject(req.params.projectId, req.session.userId);
    res.json({ ok: true, files: result.files, commit: result.commit });
  } catch (err) {
    const e = errInfo(err);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Failed to pull from GitHub' });
  }
});

/** POST /api/github/import -- Import a GitHub repository as a new FlowTex project. */
router.post('/import', async (req, res) => {
  const { repo, branch } = req.body;
  if (!repo || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo.trim()))
    return res.status(400).json({ error: 'Repo must be in owner/repo format' });

  try {
    const project = await gh.importFromGitHub(req.session.userId, repo, branch);
    res.json(project);
  } catch (err) {
    logger.error({ err }, 'GitHub import error');
    const e = errInfo(err);
    const msg = stripPaths(((e.message || 'Unknown error')).replace(/https?:\/\/[^@\s]*@/g, 'https://***@'));
    res.status(e.status || 500).json({ error: msg });
  }
});

export default router;
