import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { isProjectMember } from '../middleware/auth.js';
import { pushToGitHub, pullFromGitHub } from '../utils/gitSync.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import logger from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GIT_REPOS_DIR = path.join(__dirname, '..', '..', 'git-repos');

const router = Router();

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const APP_URL = process.env.APP_URL || 'http://localhost:3001';

// --- GitHub OAuth ---

// Check if OAuth is configured
router.get('/oauth/available', (req, res) => {
  res.json({ available: !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET) });
});

// Start OAuth flow — redirect user to GitHub
router.get('/oauth/authorize', (req, res) => {
  if (!GITHUB_CLIENT_ID) return res.status(500).json({ error: 'GitHub OAuth not configured' });

  const state = crypto.randomBytes(16).toString('hex');
  req.session.githubOAuthState = state;
  // Remember where the user came from so we can redirect back after OAuth
  let returnTo = req.query.returnTo || '/';
  // Prevent open redirect — only allow relative paths
  if (!returnTo.startsWith('/') || returnTo.startsWith('//')) returnTo = '/';
  req.session.githubOAuthReturnTo = returnTo;
  req.session.save(() => {
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: `${APP_URL}/api/github/oauth/callback`,
      scope: 'repo',
      state,
    });
    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });
});

// OAuth callback — exchange code for token
router.get('/oauth/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state || state !== req.session.githubOAuthState) {
    return res.status(400).send('Invalid OAuth callback. <a href="/">Go back</a>');
  }
  delete req.session.githubOAuthState;

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return res.status(400).send('GitHub authorization failed. <a href="/">Go back</a>');
    }

    const encryptedToken = encrypt(tokenData.access_token);
    const existing = await db.get('SELECT 1 FROM github_tokens WHERE user_id = $1', [req.session.userId]);
    if (existing) {
      await db.run('UPDATE github_tokens SET token = $1, updated_at = NOW() WHERE user_id = $2',
        [encryptedToken, req.session.userId]);
    } else {
      await db.run('INSERT INTO github_tokens (user_id, token) VALUES ($1, $2)',
        [req.session.userId, encryptedToken]);
    }

    // Redirect back to where the user was
    const returnTo = req.session.githubOAuthReturnTo || '/';
    delete req.session.githubOAuthReturnTo;
    const sep = returnTo.includes('?') ? '&' : '?';
    res.redirect(`${returnTo}${sep}github=connected`);
  } catch (err) {
    logger.error({ err }, 'GitHub OAuth error');
    res.status(500).send('GitHub authorization failed. <a href="/">Go back</a>');
  }
});

// --- PAT Management (fallback when OAuth not configured) ---

// Save/update GitHub token (encrypted at rest)
router.put('/token', async (req, res) => {
  const { token } = req.body;
  if (!token || !token.trim()) return res.status(400).json({ error: 'Token is required' });

  const encryptedToken = encrypt(token.trim());
  const existing = await db.get('SELECT 1 FROM github_tokens WHERE user_id = $1', [req.session.userId]);
  if (existing) {
    await db.run(
      'UPDATE github_tokens SET token = $1, updated_at = NOW() WHERE user_id = $2',
      [encryptedToken, req.session.userId]
    );
  } else {
    await db.run(
      'INSERT INTO github_tokens (user_id, token) VALUES ($1, $2)',
      [req.session.userId, encryptedToken]
    );
  }
  res.json({ ok: true });
});

async function getUserToken(userId) {
  const row = await db.get('SELECT token FROM github_tokens WHERE user_id = $1', [userId]);
  if (!row?.token) return null;
  try {
    return decrypt(row.token);
  } catch {
    // Legacy unencrypted token — auto-encrypt it now
    logger.warn({ userId }, 'Found unencrypted GitHub token — encrypting in place');
    const encryptedToken = encrypt(row.token);
    await db.run('UPDATE github_tokens SET token = $1, updated_at = NOW() WHERE user_id = $2',
      [encryptedToken, userId]);
    return row.token;
  }
}

// Check if user has a token (and fetch GitHub username if connected)
router.get('/token', async (req, res) => {
  const row = await db.get('SELECT token FROM github_tokens WHERE user_id = $1', [req.session.userId]);
  if (!row) return res.json({ hasToken: false });

  // Try to fetch GitHub username
  let ghUsername = null;
  try {
    const token = await getUserToken(req.session.userId);
    if (token) {
      const ghRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      });
      if (ghRes.ok) {
        const ghData = await ghRes.json();
        ghUsername = ghData.login;
      }
    }
  } catch { /* ignore — just won't show username */ }

  res.json({ hasToken: true, username: ghUsername });
});

// Remove token
router.delete('/token', async (req, res) => {
  await db.run('DELETE FROM github_tokens WHERE user_id = $1', [req.session.userId]);
  res.json({ ok: true });
});

// --- Project Link Management ---

async function requireMembership(projectId, userId, res) {
  const member = await isProjectMember(projectId, userId);
  if (!member) {
    res.status(403).json({ error: 'No access to this project' });
    return null;
  }
  return member;
}

// Link a project to a GitHub repo
router.put('/link/:projectId', async (req, res) => {
  const member = await requireMembership(req.params.projectId, req.session.userId, res);
  if (!member) return;
  if (member.role !== 'owner') return res.status(403).json({ error: 'Only the owner can link a repo' });

  const { repo, branch } = req.body;
  if (!repo || !repo.includes('/')) return res.status(400).json({ error: 'Repo must be in owner/repo format' });
  if (branch && (!/^[a-zA-Z0-9._\/-]+$/.test(branch) || branch.startsWith('-'))) {
    return res.status(400).json({ error: 'Invalid branch name' });
  }

  const existing = await db.get('SELECT 1 FROM project_github_links WHERE project_id = $1', [req.params.projectId]);
  if (existing) {
    await db.run(
      'UPDATE project_github_links SET github_repo = $1, default_branch = $2, updated_at = NOW() WHERE project_id = $3',
      [repo.trim(), (branch || 'main').trim(), req.params.projectId]
    );
  } else {
    await db.run(
      'INSERT INTO project_github_links (project_id, github_repo, default_branch, linked_by) VALUES ($1, $2, $3, $4)',
      [req.params.projectId, repo.trim(), (branch || 'main').trim(), req.session.userId]
    );
  }
  res.json({ ok: true });
});

// Get link status
router.get('/link/:projectId', async (req, res) => {
  if (!(await requireMembership(req.params.projectId, req.session.userId, res))) return;

  const link = await db.get('SELECT * FROM project_github_links WHERE project_id = $1', [req.params.projectId]);
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

// Toggle auto-push (owner only)
router.patch('/link/:projectId/auto-push', async (req, res) => {
  const member = await requireMembership(req.params.projectId, req.session.userId, res);
  if (!member) return;
  if (member.role !== 'owner') {
    return res.status(403).json({ error: 'Only the project owner can change auto-push settings' });
  }

  const { enabled, interval } = req.body;
  const updates = [];
  const params = [];
  let idx = 1;

  if (typeof enabled === 'boolean') {
    updates.push(`auto_push = $${idx++}`);
    params.push(enabled);
  }
  if (typeof interval === 'number' && interval >= 60) {
    updates.push(`auto_push_interval = $${idx++}`);
    params.push(Math.min(interval, 3600));
  }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  params.push(req.params.projectId);
  await db.run(
    `UPDATE project_github_links SET ${updates.join(', ')} WHERE project_id = $${idx}`,
    params
  );
  res.json({ ok: true });
});

// Unlink
router.delete('/link/:projectId', async (req, res) => {
  const member = await requireMembership(req.params.projectId, req.session.userId, res);
  if (!member) return;
  if (member.role !== 'owner') return res.status(403).json({ error: 'Only the owner can unlink' });

  await db.run('DELETE FROM project_github_links WHERE project_id = $1', [req.params.projectId]);
  res.json({ ok: true });
});

// --- User's GitHub repos ---

router.get('/repos', async (req, res) => {
  const token = await getUserToken(req.session.userId);
  if (!token) return res.status(400).json({ error: 'No GitHub token' });

  try {
    // Fetch repos the user can push to (owns or has write access)
    const repos = [];
    let page = 1;
    while (page <= 5) { // cap at 5 pages (500 repos)
      const ghRes = await fetch(`https://api.github.com/user/repos?per_page=100&sort=updated&page=${page}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      });
      if (!ghRes.ok) break;
      const batch = await ghRes.json();
      if (!batch.length) break;
      repos.push(...batch.map(r => ({
        fullName: r.full_name,
        name: r.name,
        owner: r.owner.login,
        private: r.private,
        defaultBranch: r.default_branch,
        updatedAt: r.updated_at,
      })));
      page++;
    }
    res.json(repos);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch repos from GitHub' });
  }
});

// Create a new repo on GitHub
router.post('/repos', async (req, res) => {
  const token = await getUserToken(req.session.userId);
  if (!token) return res.status(400).json({ error: 'No GitHub token' });

  const { name, isPrivate } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Repository name is required' });

  try {
    const ghRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: name.trim(),
        private: isPrivate !== false,
        auto_init: false,
      }),
    });
    const data = await ghRes.json();
    if (!ghRes.ok) {
      // GitHub puts the real reason in errors[].message (e.g. "name already exists on this account")
      const detail = data.errors?.[0]?.message;
      const msg = detail ? `${data.message} ${detail}` : (data.message || 'Failed to create repository');
      return res.status(ghRes.status).json({ error: msg });
    }
    res.json({
      fullName: data.full_name,
      name: data.name,
      owner: data.owner.login,
      private: data.private,
      defaultBranch: data.default_branch || 'main',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create repository on GitHub' });
  }
});

// --- Sync Operations ---

async function getProjectLink(projectId) {
  return await db.get('SELECT * FROM project_github_links WHERE project_id = $1', [projectId]);
}

// Push to GitHub
router.post('/push/:projectId', async (req, res) => {
  const member = await requireMembership(req.params.projectId, req.session.userId, res);
  if (!member) return;
  if (member.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot push to GitHub' });

  const token = await getUserToken(req.session.userId);
  if (!token) return res.status(400).json({ error: 'No GitHub token configured. Add one in the GitHub sync settings.' });

  const link = await getProjectLink(req.params.projectId);
  if (!link) return res.status(400).json({ error: 'Project is not linked to a GitHub repo.' });

  try {
    const { commit } = await pushToGitHub(
      req.params.projectId, token, link.github_repo, link.default_branch,
      (req.body.message || 'Update from FlowTex').slice(0, 5000)
    );

    await db.run(
      'UPDATE project_github_links SET last_sync_at = NOW(), last_sync_commit = $1 WHERE project_id = $2',
      [commit, req.params.projectId]
    );

    res.json({ ok: true, commit });
  } catch (err) {
    logger.error({ err }, 'GitHub push error');
    // Sanitize error message to avoid leaking tokens or internal paths
    const safeMsg = (err.message || 'Unknown error').replace(/https?:\/\/[^@\s]*@/g, 'https://***@');
    res.status(500).json({ error: safeMsg });
  }
});

// Pull from GitHub
router.post('/pull/:projectId', async (req, res) => {
  const member = await requireMembership(req.params.projectId, req.session.userId, res);
  if (!member) return;
  if (member.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot pull from GitHub' });

  const token = await getUserToken(req.session.userId);
  if (!token) return res.status(400).json({ error: 'No GitHub token configured.' });

  const link = await getProjectLink(req.params.projectId);
  if (!link) return res.status(400).json({ error: 'Project is not linked to a GitHub repo.' });

  try {
    const { files, commit } = await pullFromGitHub(
      req.params.projectId, token, link.github_repo, link.default_branch
    );

    await db.run(
      'UPDATE project_github_links SET last_sync_at = NOW(), last_sync_commit = $1 WHERE project_id = $2',
      [commit, req.params.projectId]
    );

    res.json({ ok: true, files, commit });
  } catch (err) {
    logger.error({ err }, 'GitHub pull error');
    const safeMsg = (err.message || 'Unknown error').replace(/https?:\/\/[^@\s]*@/g, 'https://***@');
    res.status(500).json({ error: safeMsg });
  }
});

// --- Import from GitHub (create new project from a repo) ---

router.post('/import', async (req, res) => {
  const token = await getUserToken(req.session.userId);
  if (!token) return res.status(400).json({ error: 'No GitHub token configured.' });

  const { repo, branch } = req.body;
  if (!repo || !repo.includes('/')) return res.status(400).json({ error: 'Repo must be in owner/repo format' });

  const repoName = repo.split('/').pop();

  try {
    // Always resolve the default branch from GitHub
    const ghRes = await fetch(`https://api.github.com/repos/${repo.trim()}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!ghRes.ok) {
      return res.status(ghRes.status).json({ error: `Repository "${repo}" not found or not accessible.` });
    }
    const ghData = await ghRes.json();
    // Use the GitHub-reported default branch unless the user explicitly specified one that exists
    const branchName = ghData.default_branch || 'main';

    // Create a new project
    const projectId = uuid();
    await db.run(
      'INSERT INTO projects (id, name) VALUES ($1, $2)',
      [projectId, repoName]
    );
    await db.run(
      'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)',
      [projectId, req.session.userId, 'owner']
    );

    // Link it to the GitHub repo
    await db.run(
      'INSERT INTO project_github_links (project_id, github_repo, default_branch, linked_by) VALUES ($1, $2, $3, $4)',
      [projectId, repo.trim(), branchName, req.session.userId]
    );

    // Pull the files
    try {
      const { files, commit } = await pullFromGitHub(projectId, token, repo.trim(), branchName);

      await db.run(
        'UPDATE project_github_links SET last_sync_at = NOW(), last_sync_commit = $1 WHERE project_id = $2',
        [commit, projectId]
      );
    } catch (pullErr) {
      // Roll back: remove the project, link, and git-repo dir on pull failure
      await db.run('DELETE FROM project_github_links WHERE project_id = $1', [projectId]);
      await db.run('DELETE FROM files WHERE project_id = $1', [projectId]);
      await db.run('DELETE FROM project_members WHERE project_id = $1', [projectId]);
      await db.run('DELETE FROM projects WHERE id = $1', [projectId]);
      const repoDir = path.join(GIT_REPOS_DIR, projectId);
      fs.rmSync(repoDir, { recursive: true, force: true });
      throw pullErr;
    }

    // Return the project so the client can navigate to it
    const project = await db.get('SELECT * FROM projects WHERE id = $1', [projectId]);
    res.json(project);
  } catch (err) {
    logger.error({ err }, 'GitHub import error');
    const safeMsg = (err.message || 'Unknown error').replace(/https?:\/\/[^@\s]*@/g, 'https://***@');
    res.status(500).json({ error: safeMsg });
  }
});

export default router;
