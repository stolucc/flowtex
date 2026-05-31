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

/** Check whether GitHub OAuth credentials are configured. */
export function isOAuthAvailable() {
  return !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
}

export function getOAuthClientId() {
  return GITHUB_CLIENT_ID;
}

/**
 * Exchange a GitHub OAuth authorization code for an access token.
 *
 * Note on the 2026-05-15 GitHub App installation-token format change:
 * that changelog applies only to `ghs_…` *installation* tokens minted
 * via POST /app/installations/:id/access_tokens. FlowTex is registered
 * as an OAuth App (this endpoint mints `gho_…` user-to-server tokens)
 * and also accepts manually-pasted PATs (`ghp_…`). Neither format is
 * changing. We never introspect or length-check the token; the
 * github_tokens.token column is unbounded TEXT and would happily
 * accommodate the ~520-char JWT-shape `ghs_…` if FlowTex ever migrated
 * to a GitHub App. No code change needed for the rollout.
 *
 * @returns {string|null} The access token, or null on failure.
 */
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

/** Retrieve and decrypt the user's stored GitHub token (auto-encrypts legacy plaintext tokens). */
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

/** Store (insert or update) an encrypted GitHub token for a user. */
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

/** Delete a user's GitHub token and unlink all their project-GitHub links. */
export async function deleteToken(userId) {
  await db.run('DELETE FROM project_github_links WHERE linked_by = $1', [userId]);
  await db.run('DELETE FROM github_tokens WHERE user_id = $1', [userId]);
}

/** Fetch the GitHub username for a user via the GitHub API. */
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

/** Get the GitHub link record for a project (repo, branch, sync info). */
export async function getProjectLink(projectId) {
  return await db.get('SELECT * FROM project_github_links WHERE project_id = $1', [projectId]);
}

/** Link a project to a GitHub repository (creates or updates the link). */
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

/** Remove the GitHub link from a project. */
export async function unlinkProject(projectId) {
  await db.run('DELETE FROM project_github_links WHERE project_id = $1', [projectId]);
}

/** Update auto-push settings (enabled flag and/or interval) for a project's GitHub link. */
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

/** Fetch up to 500 repositories accessible by the user from the GitHub API. */
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

/** Create a new GitHub repository under the authenticated user's account. */
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

/** Push a project's files to its linked GitHub repo and update the sync timestamp. */
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
      // Strip CR so a user-supplied message with embedded \r doesn't render
      // weirdly in git tooling; embedded \n stays so multi-line commit
      // bodies still work (Git's first-line-is-subject convention).
      (message || 'Update from FlowTex').replace(/\r/g, '').slice(0, 5000),
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

/** Pull latest files from a project's linked GitHub repo into the database. */
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

/** Create a new project by importing all files from a GitHub repository. */
export async function importFromGitHub(userId, repo, _branch) {
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
    const { commit } = await pullFromGitHub(projectId, token, repo.trim(), branchName);
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
