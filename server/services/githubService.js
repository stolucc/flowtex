import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { pushToGitHub, pullFromGitHub } from '../utils/gitSync.js';
import logger from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GIT_REPOS_DIR = path.join(__dirname, '..', '..', 'git-repos');

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

// --- OAuth ---

export function isOAuthAvailable() {
  return !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
}

export function getOAuthClientId() {
  return GITHUB_CLIENT_ID;
}

export async function exchangeOAuthCode(code) {
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
  if (!tokenData.access_token) return null;
  return tokenData.access_token;
}

// --- Token Management ---

export async function getUserToken(userId) {
  const row = await db.get('SELECT token FROM github_tokens WHERE user_id = $1', [userId]);
  if (!row?.token) return null;
  try {
    return decrypt(row.token);
  } catch {
    // Legacy unencrypted token — auto-encrypt it now
    logger.warn({ userId }, 'Found unencrypted GitHub token — encrypting in place');
    const encryptedToken = encrypt(row.token);
    await db.run('UPDATE github_tokens SET token = $1, updated_at = NOW() WHERE user_id = $2', [
      encryptedToken,
      userId,
    ]);
    return row.token;
  }
}

export async function upsertToken(userId, token) {
  const encryptedToken = encrypt(token);
  const existing = await db.get('SELECT 1 FROM github_tokens WHERE user_id = $1', [userId]);
  if (existing) {
    await db.run('UPDATE github_tokens SET token = $1, updated_at = NOW() WHERE user_id = $2', [
      encryptedToken,
      userId,
    ]);
  } else {
    await db.run('INSERT INTO github_tokens (user_id, token) VALUES ($1, $2)', [userId, encryptedToken]);
  }
}

export async function deleteToken(userId) {
  await db.run('DELETE FROM github_tokens WHERE user_id = $1', [userId]);
}

export async function getGitHubUsername(userId) {
  const token = await getUserToken(userId);
  if (!token) return null;
  try {
    const ghRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!ghRes.ok) return null;
    const ghData = await ghRes.json();
    return ghData.login;
  } catch {
    return null;
  }
}

// --- Project Link Management ---

export async function getProjectLink(projectId) {
  return await db.get('SELECT * FROM project_github_links WHERE project_id = $1', [projectId]);
}

export async function linkProject(projectId, repo, branch, userId) {
  const existing = await db.get('SELECT 1 FROM project_github_links WHERE project_id = $1', [projectId]);
  if (existing) {
    await db.run(
      'UPDATE project_github_links SET github_repo = $1, default_branch = $2, updated_at = NOW() WHERE project_id = $3',
      [repo.trim(), (branch || 'main').trim(), projectId],
    );
  } else {
    await db.run(
      'INSERT INTO project_github_links (project_id, github_repo, default_branch, linked_by) VALUES ($1, $2, $3, $4)',
      [projectId, repo.trim(), (branch || 'main').trim(), userId],
    );
  }
}

export async function unlinkProject(projectId) {
  await db.run('DELETE FROM project_github_links WHERE project_id = $1', [projectId]);
}

export async function updateAutoPush(projectId, enabled, interval) {
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

  if (updates.length === 0) return false;

  params.push(projectId);
  await db.run(`UPDATE project_github_links SET ${updates.join(', ')} WHERE project_id = $${idx}`, params);
  return true;
}

// --- GitHub API ---

export async function fetchUserRepos(userId) {
  const token = await getUserToken(userId);
  if (!token) throw Object.assign(new Error('No GitHub token'), { status: 400 });

  const repos = [];
  let page = 1;
  while (page <= 5) {
    const ghRes = await fetch(`https://api.github.com/user/repos?per_page=100&sort=updated&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!ghRes.ok) break;
    const batch = await ghRes.json();
    if (!batch.length) break;
    repos.push(
      ...batch.map((r) => ({
        fullName: r.full_name,
        name: r.name,
        owner: r.owner.login,
        private: r.private,
        defaultBranch: r.default_branch,
        updatedAt: r.updated_at,
      })),
    );
    page++;
  }
  return repos;
}

export async function createRepo(userId, name, isPrivate) {
  const token = await getUserToken(userId);
  if (!token) throw Object.assign(new Error('No GitHub token'), { status: 400 });

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
    const detail = data.errors?.[0]?.message;
    const msg = detail ? `${data.message} ${detail}` : data.message || 'Failed to create repository';
    throw Object.assign(new Error(msg), { status: ghRes.status });
  }
  return {
    fullName: data.full_name,
    name: data.name,
    owner: data.owner.login,
    private: data.private,
    defaultBranch: data.default_branch || 'main',
  };
}

// --- Sync Operations ---

function sanitizeError(err) {
  return (err.message || 'Unknown error').replace(/https?:\/\/[^@\s]*@/g, 'https://***@');
}

export async function pushProject(projectId, userId, message) {
  const token = await getUserToken(userId);
  if (!token)
    throw Object.assign(new Error('No GitHub token configured. Add one in the GitHub sync settings.'), { status: 400 });

  const link = await getProjectLink(projectId);
  if (!link) throw Object.assign(new Error('Project is not linked to a GitHub repo.'), { status: 400 });

  try {
    const { commit } = await pushToGitHub(
      projectId,
      token,
      link.github_repo,
      link.default_branch,
      (message || 'Update from FlowTex').slice(0, 5000),
    );

    await db.run('UPDATE project_github_links SET last_sync_at = NOW(), last_sync_commit = $1 WHERE project_id = $2', [
      commit,
      projectId,
    ]);

    return { commit };
  } catch (err) {
    logger.error({ err }, 'GitHub push error');
    throw Object.assign(new Error(sanitizeError(err)), { status: 500 });
  }
}

export async function pullProject(projectId, userId) {
  const token = await getUserToken(userId);
  if (!token) throw Object.assign(new Error('No GitHub token configured.'), { status: 400 });

  const link = await getProjectLink(projectId);
  if (!link) throw Object.assign(new Error('Project is not linked to a GitHub repo.'), { status: 400 });

  try {
    const { files, commit } = await pullFromGitHub(projectId, token, link.github_repo, link.default_branch);

    await db.run('UPDATE project_github_links SET last_sync_at = NOW(), last_sync_commit = $1 WHERE project_id = $2', [
      commit,
      projectId,
    ]);

    return { files, commit };
  } catch (err) {
    logger.error({ err }, 'GitHub pull error');
    throw Object.assign(new Error(sanitizeError(err)), { status: 500 });
  }
}

export async function importFromGitHub(userId, repo, branch) {
  const token = await getUserToken(userId);
  if (!token) throw Object.assign(new Error('No GitHub token configured.'), { status: 400 });

  // Resolve default branch from GitHub
  const ghRes = await fetch(`https://api.github.com/repos/${repo.trim()}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!ghRes.ok) {
    throw Object.assign(new Error(`Repository "${repo}" not found or not accessible.`), { status: ghRes.status });
  }
  const ghData = await ghRes.json();
  const branchName = ghData.default_branch || 'main';

  // Create project
  const projectId = uuid();
  await db.run('INSERT INTO projects (id, name) VALUES ($1, $2)', [projectId, repo.split('/').pop()]);
  await db.run('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [
    projectId,
    userId,
    'owner',
  ]);
  await db.run(
    'INSERT INTO project_github_links (project_id, github_repo, default_branch, linked_by) VALUES ($1, $2, $3, $4)',
    [projectId, repo.trim(), branchName, userId],
  );

  // Pull files
  try {
    const { files, commit } = await pullFromGitHub(projectId, token, repo.trim(), branchName);
    await db.run('UPDATE project_github_links SET last_sync_at = NOW(), last_sync_commit = $1 WHERE project_id = $2', [
      commit,
      projectId,
    ]);
  } catch (pullErr) {
    // Roll back on pull failure
    await db.run('DELETE FROM project_github_links WHERE project_id = $1', [projectId]);
    await db.run('DELETE FROM files WHERE project_id = $1', [projectId]);
    await db.run('DELETE FROM project_members WHERE project_id = $1', [projectId]);
    await db.run('DELETE FROM projects WHERE id = $1', [projectId]);
    const repoDir = path.join(GIT_REPOS_DIR, projectId);
    fs.rmSync(repoDir, { recursive: true, force: true });
    throw pullErr;
  }

  const project = await db.get('SELECT * FROM projects WHERE id = $1', [projectId]);
  return project;
}
