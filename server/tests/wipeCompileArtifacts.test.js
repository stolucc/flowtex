import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { wipeCompileArtifacts } from '../compiler.js';
import { PROJECTS_DIR } from '../paths.js';

// Each test uses a unique project id so they don't collide, and cleans
// up its own dir afterwards.
const made = [];
async function makeProjectDir(id, files) {
  const dir = path.join(PROJECTS_DIR, id);
  await mkdir(dir, { recursive: true });
  made.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    if (typeof content === 'object' && content.dir) {
      await mkdir(full, { recursive: true });
      for (const [inner, body] of Object.entries(content.files || {})) {
        await writeFile(path.join(full, inner), body);
      }
    } else {
      await writeFile(full, /** @type {string} */ (content));
    }
  }
  return dir;
}

afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('wipeCompileArtifacts', () => {
  it('removes generated outputs, the rendered PDF, and synced cleartext source', async () => {
    const id = `wipe-test-${Date.now()}-a`;
    const dir = await makeProjectDir(id, {
      'main.tex': '\\documentclass{article}',
      'refs.bib': '@book{x,title={y}}',
      'main.pdf': '%PDF-1.5 fake',
      'main.aux': 'aux',
      'main.log': 'log',
      'main.synctex.gz': 'synctex',
    });
    await wipeCompileArtifacts(id);
    const left = await readdir(dir);
    expect(left).toEqual([]); // everything wiped
  });

  it('leaves the _blobs store untouched', async () => {
    const id = `wipe-test-${Date.now()}-b`;
    const dir = await makeProjectDir(id, {
      'main.tex': 'x',
      'main.pdf': 'pdf',
      _blobs: { dir: true, files: { 'ab': 'blobbytes' } },
    });
    await wipeCompileArtifacts(id);
    const left = await readdir(dir);
    expect(left).toEqual(['_blobs']);
    const blobFiles = await readdir(path.join(dir, '_blobs'));
    expect(blobFiles).toEqual(['ab']);
  });

  it('does not throw when the project dir does not exist', async () => {
    await expect(wipeCompileArtifacts(`nonexistent-${Date.now()}`)).resolves.toBeUndefined();
  });

  it('wipes .sty/.cls/.bbl/.out and other generated + source extensions', async () => {
    const id = `wipe-test-${Date.now()}-c`;
    const dir = await makeProjectDir(id, {
      'custom.sty': 'sty',
      'main.bbl': 'bbl',
      'main.out': 'out',
      'main.toc': 'toc',
    });
    await wipeCompileArtifacts(id);
    expect(await readdir(dir)).toEqual([]);
  });
});
