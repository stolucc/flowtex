import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { simpleGit } from 'simple-git';

// gitSync pulls in db/compiler/projectService at import time; stub them so
// the module loads cheaply. The helpers under test only touch real git.
vi.mock('../db.js', () => ({ default: {} }));
vi.mock('../compiler.js', () => ({ invalidateFileCache: vi.fn() }));
vi.mock('../services/fileBytes.js', () => ({ loadFileBytes: vi.fn() }));
vi.mock('../services/projectService.js', () => ({
  writeBinaryFileInTx: vi.fn(),
  decrementBlobRefcount: vi.fn(),
}));
vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { _testing } from '../utils/gitSync.js';
const { configureRemote, clearRemoteAuth } = _testing;

// Exercises the simple-git v4 API surface gitSync depends on (named export,
// full-length long options, remote management) against a real repo.
describe('gitSync remote auth helpers (real git, simple-git v4)', () => {
  let dir;
  let git;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowtex-gitsync-'));
    git = simpleGit(dir);
    await git.init();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const header = async () =>
    (await git.raw(['config', '--local', '--get-all', 'http.https://github.com/.extraheader'])).trim();

  it('adds origin and sets exactly one auth header', async () => {
    await configureRemote(git, 'owner/repo', 'tok1');
    const remotes = await git.getRemotes(true);
    expect(remotes).toEqual([
      expect.objectContaining({ name: 'origin', refs: expect.objectContaining({ push: 'https://github.com/owner/repo.git' }) }),
    ]);
    const expected = `Authorization: basic ${Buffer.from('x-access-token:tok1').toString('base64')}`;
    expect(await header()).toBe(expected);
  });

  it('re-configuring replaces (not appends) the header and updates the URL', async () => {
    await configureRemote(git, 'owner/repo', 'tok1');
    await configureRemote(git, 'owner/other', 'tok2');
    const lines = (await header()).split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(Buffer.from('x-access-token:tok2').toString('base64'));
    const [origin] = await git.getRemotes(true);
    expect(origin.refs.push).toBe('https://github.com/owner/other.git');
  });

  it('clearRemoteAuth removes the header and tolerates a missing key', async () => {
    await configureRemote(git, 'owner/repo', 'tok1');
    await clearRemoteAuth(git);
    const { all } = await git.listConfig('local');
    expect(all['http.https://github.com/.extraheader']).toBeUndefined();
    await expect(clearRemoteAuth(git)).resolves.toBeUndefined();
  });

  it('rejects malformed repo names before touching git', async () => {
    await expect(configureRemote(git, 'owner/repo;rm -rf /', 't')).rejects.toThrow(/Invalid repository format/);
    expect(await git.getRemotes()).toEqual([]);
  });
});
