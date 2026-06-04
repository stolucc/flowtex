import simpleGit from 'simple-git';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import logger from '../logger.js';
import { invalidateFileCache } from '../compiler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GIT_REPOS_DIR = path.join(__dirname, '..', '..', 'git-repos');

import { BINARY_EXTS } from './fileTypes.js';
import { loadFileBytes } from '../services/fileBytes.js';
import { writeBinaryFileInTx, decrementBlobRefcount } from '../services/projectService.js';

const syncLocks = new Map();

/** Serialize async operations on a project to prevent concurrent git mutations. */
async function withLock(projectId, fn) {
  while (syncLocks.has(projectId)) {
    await syncLocks.get(projectId);
  }
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  syncLocks.set(projectId, promise);
  try {
    return await fn();
  } finally {
    syncLocks.delete(projectId);
    resolve();
  }
}

function getRepoDir(projectId) {
  return path.join(GIT_REPOS_DIR, projectId);
}

/** Ensure a local git repo exists for the project, initializing if needed. */
async function ensureRepo(projectId) {
  const repoDir = getRepoDir(projectId);
  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(repoDir, { recursive: true });
  }
  const git = simpleGit(repoDir);
  // Must check for .git directly — checkIsRepo() walks up parent dirs
  const isRepo = fs.existsSync(path.join(repoDir, '.git'));
  if (!isRepo) {
    await git.init();
    await git.addConfig('user.email', 'noreply@flowtex.app');
    await git.addConfig('user.name', 'FlowTex');
    await git.addConfig('pull.rebase', 'false');
  }
  return git;
}

/** Configure the 'origin' remote URL and auth header for the given repo/token. */
async function configureRemote(git, repo, token) {
  // Validate repo format strictly to prevent SSRF
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo)) {
    throw new Error('Invalid repository format. Use owner/repo.');
  }
  const url = `https://github.com/${repo}.git`;
  const remotes = await git.getRemotes();
  if (remotes.find((r) => r.name === 'origin')) {
    await git.remote(['set-url', 'origin', url]);
  } else {
    await git.addRemote('origin', url);
  }
  // Force-set (not append) the auth header
  const authHeader = `Authorization: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  await git.raw(['config', '--local', '--replace-all', 'http.https://github.com/.extraheader', authHeader]);
}

/** Remove the auth header from git config after a push/pull operation. */
async function clearRemoteAuth(git) {
  try {
    await git.raw(['config', '--local', '--unset-all', 'http.https://github.com/.extraheader']);
  } catch {
    // Config key may not exist; ignore
  }
}

/** Write all project files from the database to the local git repo directory. */
async function writeProjectFilesToDisk(projectId, repoDir) {
  // SELECT binary_sha256 so loadFileBytes can resolve binary rows via
  // the blob store. Pre-migration this column didn't exist; post-C.3
  // binary rows have empty content here and the bytes live on disk.
  const files = await db.all(
    'SELECT path, content, is_binary, binary_sha256 FROM files WHERE project_id = $1',
    [projectId],
  );

  // Remove existing files (except .git)
  for (const entry of fs.readdirSync(repoDir)) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(repoDir, entry), { recursive: true, force: true });
  }

  for (const file of files) {
    if (file.path.includes('..') || file.path.includes('\0') || path.isAbsolute(file.path)) continue;
    const filePath = path.resolve(repoDir, file.path);
    if (!filePath.startsWith(repoDir + path.sep) && filePath !== repoDir) continue;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // loadFileBytes returns a Buffer for binary rows (reads from the
    // blob store via binary_sha256) and a string for text rows. Pre-
    // migration this used Buffer.from(content, 'base64') for binaries,
    // which silently wrote empty files post-C.3 because content was ''.
    try {
      const bytes = await loadFileBytes(projectId, file);
      fs.writeFileSync(filePath, bytes ?? '');
    } catch (err) {
      logger.warn({ err, projectId, path: file.path }, 'gitSync: skipping file with unloadable bytes');
    }
  }
}

/** Read files from the local git repo directory back into the database, syncing additions/deletions. */
async function readDiskFilesToProject(projectId, repoDir) {
  const dbFiles = await db.all('SELECT id, path FROM files WHERE project_id = $1', [projectId]);
  const dbPathMap = new Map(dbFiles.map((f) => [f.path, f.id]));
  const diskPaths = new Set();

  function walkDir(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      // Skip symlinks to prevent reading arbitrary files outside the repo
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      // Verify resolved path stays within repoDir (catches hardlinks and race conditions)
      let realPath;
      try {
        realPath = fs.realpathSync(fullPath);
      } catch {
        continue; // Skip unresolvable paths
      }
      if (!realPath.startsWith(repoDir + path.sep) && realPath !== repoDir) continue;
      const relPath = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        walkDir(fullPath, relPath);
      } else {
        diskPaths.add(relPath);
      }
    }
  }

  walkDir(repoDir, '');

  await db.transaction(async (tx) => {
    for (const relPath of diskPaths) {
      const fullPath = path.join(repoDir, relPath);
      const ext = relPath.substring(relPath.lastIndexOf('.')).toLowerCase();
      const isBinary = BINARY_EXTS.has(ext);

      if (isBinary) {
        // Land binaries through the blob store so files.binary_sha256
        // is populated and /raw can serve them. Pre-migration this
        // wrote base64 into files.content which the post-C.3 read path
        // refuses.
        const buf = fs.readFileSync(fullPath);
        try {
          await writeBinaryFileInTx(tx, projectId, relPath, buf);
        } catch (err) {
          logger.warn({ err, projectId, path: relPath }, 'gitSync: skipping unimportable binary');
        }
      } else if (dbPathMap.has(relPath)) {
        await tx.run('UPDATE files SET content = $1, is_binary = FALSE, updated_at = NOW() WHERE id = $2', [
          fs.readFileSync(fullPath, 'utf8'),
          dbPathMap.get(relPath),
        ]);
      } else {
        await tx.run(
          'INSERT INTO files (id, project_id, path, content, is_binary) VALUES ($1, $2, $3, $4, FALSE)',
          [uuid(), projectId, relPath, fs.readFileSync(fullPath, 'utf8')],
        );
      }
    }

    // Delete DB files no longer on disk. For binary rows, decrement the
    // blob refcount inside the same tx so the GC sweep can collect the
    // now-unreferenced blob.
    for (const [dbPath, dbId] of dbPathMap) {
      if (!diskPaths.has(dbPath)) {
        const row = await tx.get(
          'SELECT binary_sha256 FROM files WHERE id = $1',
          [dbId],
        );
        if (row?.binary_sha256) {
          await decrementBlobRefcount(tx, projectId, row.binary_sha256);
        }
        await tx.run('DELETE FROM files WHERE id = $1', [dbId]);
      }
    }

    await tx.run('UPDATE projects SET updated_at = NOW() WHERE id = $1', [projectId]);
  });

  return await db.all('SELECT * FROM files WHERE project_id = $1 ORDER BY path', [projectId]);
}

/** Ensure the GitHub repository exists, creating it (as private) if necessary. */
async function ensureGitHubRepoExists(token, repo) {
  const [owner, name] = repo.split('/');
  // Check if the repo already exists
  const checkRes = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (checkRes.ok) return; // already exists

  // Try creating under the authenticated user
  const createRes = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, private: true, auto_init: false }),
  });
  if (createRes.ok) return;

  // If that failed, try creating under an org
  const orgRes = await fetch(`https://api.github.com/orgs/${owner}/repos`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, private: true, auto_init: false }),
  });
  if (orgRes.ok) return;

  const err = await orgRes.json().catch(() => ({}));
  throw new Error(`Could not create GitHub repo: ${err.message || orgRes.status}`);
}

/**
 * Push project files to a GitHub repository, merging remote changes first.
 * @returns {{commit: string|null}} The latest commit hash after pushing.
 */
export async function pushToGitHub(projectId, token, repo, branch, commitMessage) {
  return withLock(projectId, async () => {
    await ensureGitHubRepoExists(token, repo);

    const git = await ensureRepo(projectId);
    const repoDir = getRepoDir(projectId);
    await configureRemote(git, repo, token);

    try {
      // Fetch remote history first so we can build on top of it
      await git.fetch('origin').catch((e) => logger.warn({ err: e }, 'Git fetch failed, continuing with local state'));
      const remoteRefs = await git.raw(['branch', '-r']).catch(() => '');
      const hasRemoteBranch = remoteRefs.split('\n').some((l) => l.trim().startsWith(`origin/${branch}`));

      const hasLocalCommits = await git
        .raw(['rev-parse', 'HEAD'])
        .then(() => true)
        .catch(() => false);
      if (hasRemoteBranch && !hasLocalCommits) {
        // Fresh local repo — start from remote branch
        await git.checkout(['-b', branch, `origin/${branch}`]);
      } else if (hasRemoteBranch && hasLocalCommits) {
        // Ensure we're on the right branch
        const branchList = await git.branchLocal();
        if (branchList.current !== branch) {
          if (branchList.all.includes(branch)) {
            await git.checkout(branch);
          } else {
            await git.checkout(['-b', branch, `origin/${branch}`]);
          }
        }
        // Merge remote changes before pushing
        await git.raw([
          'pull',
          'origin',
          branch,
          '--no-rebase',
          '--strategy-option=theirs',
          '--allow-unrelated-histories',
        ]);
      } else if (!hasLocalCommits) {
        // No remote, no local — just create the branch
        await git.checkoutLocalBranch(branch);
      }

      await writeProjectFilesToDisk(projectId, repoDir);

      await git.add('-A');
      const status = await git.status();
      if (status.files.length > 0) {
        await git.commit(commitMessage || 'Update from FlowTex');
      }

      await git.push('origin', branch, ['--set-upstream']);

      const log = await git.log({ maxCount: 1 });
      return { commit: log.latest?.hash || null };
    } finally {
      await clearRemoteAuth(git);
    }
  });
}

/**
 * Pull files from a GitHub repository into the database.
 * @returns {{files: Array, commit: string|null}} Updated file list and the latest commit hash.
 */
export async function pullFromGitHub(projectId, token, repo, branch) {
  return withLock(projectId, async () => {
    const git = await ensureRepo(projectId);
    const repoDir = getRepoDir(projectId);
    await configureRemote(git, repo, token);

    try {
      await git.fetch('origin');

      // Check if the remote has any branches at all (empty repo check)
      const remoteRefs = await git.raw(['branch', '-r']).catch(() => '');
      const remoteBranches = remoteRefs
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('origin/'));
      if (remoteBranches.length === 0) {
        throw new Error(
          'This GitHub repository is empty (no commits yet). Push some content to it first, or use "Create & Link" to start from your FlowTex project.',
        );
      }

      const hasRemoteBranch = remoteBranches.some((l) => l === `origin/${branch}` || l.startsWith(`origin/${branch} `));
      if (!hasRemoteBranch) {
        const available = remoteBranches.map((l) => l.replace('origin/', ''));
        throw new Error(`Branch "${branch}" not found on remote. Available: ${available.join(', ')}`);
      }

      // Check if the local repo has any commits (HEAD must exist)
      const hasLocalCommits = await git
        .raw(['rev-parse', 'HEAD'])
        .then(() => true)
        .catch(() => false);
      if (!hasLocalCommits) {
        await git.checkout(['-b', branch, `origin/${branch}`]);
      } else {
        const branchList = await git.branchLocal();
        if (branchList.current !== branch) {
          if (branchList.all.includes(branch)) {
            await git.checkout(branch);
          } else {
            await git.checkout(['-b', branch, `origin/${branch}`]);
          }
        }
        await git.raw([
          'pull',
          'origin',
          branch,
          '--no-rebase',
          '--strategy-option=theirs',
          '--allow-unrelated-histories',
        ]);
      }

      const files = await readDiskFilesToProject(projectId, repoDir);
      invalidateFileCache(projectId);
      const log = await git.log({ maxCount: 1 });
      return { files, commit: log.latest?.hash || null };
    } finally {
      await clearRemoteAuth(git);
    }
  });
}
