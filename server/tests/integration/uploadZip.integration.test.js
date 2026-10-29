// uploadZipToProject: merge a ZIP into an existing project. Covers the
// default "strip one shared top-level directory" behaviour (project zips)
// and the preservePaths mode used by folder uploads from the file tree.
import { describe, it, expect, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { seedUser, seedProject, seedFile } from './setup.js';
import db from '../../db.js';
import { PROJECTS_DIR } from '../../paths.js';
import { uploadZipToProject } from '../../services/projectService.js';

/** @param {Record<string, string | Buffer>} entries */
function zipOf(entries) {
  const zip = new AdmZip();
  for (const [name, data] of Object.entries(entries)) {
    zip.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
  }
  return zip.toBuffer();
}

const createdProjects = [];
async function seed() {
  const user = await seedUser();
  const project = await seedProject(user.id);
  createdProjects.push(project.id);
  return project;
}

// Binary entries are written to the on-disk blob store, which the
// per-test ROLLBACK does not undo. Remove each test project's directory.
afterEach(async () => {
  for (const id of createdProjects.splice(0)) {
    await rm(path.join(PROJECTS_DIR, id), { recursive: true, force: true });
  }
});

const pathsOf = async (projectId) =>
  (await db.all('SELECT path FROM files WHERE project_id = $1 ORDER BY path', [projectId])).map((r) => r.path);

describe('uploadZipToProject', () => {
  it('default: strips a single shared top-level directory (project zip)', async () => {
    const p = await seed();
    await uploadZipToProject(p.id, zipOf({ 'my-paper/main.tex': 'x', 'my-paper/refs.bib': 'y' }));
    const paths = await pathsOf(p.id);
    expect(paths).toContain('main.tex');
    expect(paths).toContain('refs.bib');
    expect(paths).not.toContain('my-paper/main.tex');
  });

  it('preservePaths: keeps the folder (folder upload of images/)', async () => {
    const p = await seed();
    const res = await uploadZipToProject(
      p.id,
      zipOf({ 'images/a.png': Buffer.from('png-a'), 'images/sub/b.png': Buffer.from('png-b'), 'images/notes.txt': 'hi' }),
      { preservePaths: true },
    );
    expect(res.created).toBe(3);
    const paths = await pathsOf(p.id);
    expect(paths).toEqual(expect.arrayContaining(['images/a.png', 'images/sub/b.png', 'images/notes.txt']));
    const png = await db.get('SELECT is_binary, binary_sha256 FROM files WHERE project_id = $1 AND path = $2', [p.id, 'images/a.png']);
    expect(png.is_binary).toBe(true);
    expect(png.binary_sha256).toMatch(/^[0-9a-f]{64}$/);
    const txt = await db.get('SELECT is_binary, content FROM files WHERE project_id = $1 AND path = $2', [p.id, 'images/notes.txt']);
    expect(txt).toEqual({ is_binary: false, content: 'hi' });
  });

  it('preservePaths: merges into an existing folder and leaves other files alone', async () => {
    const p = await seed();
    await seedFile(p.id, 'main.tex', '\\documentclass{article}');
    await seedFile(p.id, 'figures/old.txt', 'old');
    await uploadZipToProject(p.id, zipOf({ 'figures/new.txt': 'new' }), { preservePaths: true });
    expect(await pathsOf(p.id)).toEqual(['figures/new.txt', 'figures/old.txt', 'main.tex']);
  });

  it('preservePaths: replaces an existing file at the same path', async () => {
    const p = await seed();
    await seedFile(p.id, 'data/table.csv', 'old');
    await uploadZipToProject(p.id, zipOf({ 'data/table.csv': 'new' }), { preservePaths: true });
    const row = await db.get('SELECT content FROM files WHERE project_id = $1 AND path = $2', [p.id, 'data/table.csv']);
    expect(row.content).toBe('new');
  });

  it('still drops unsafe entries in preservePaths mode', async () => {
    const p = await seed();
    const zip = new AdmZip();
    zip.addFile('ok/a.txt', Buffer.from('a'));
    zip.addFile('ok/.hidden', Buffer.from('h'));
    zip.addFile('__MACOSX/ok/._a.txt', Buffer.from('m'));
    // adm-zip normalises "../" on addFile, so set the raw entry name.
    zip.addFile('placeholder.txt', Buffer.from('evil'));
    zip.getEntry('placeholder.txt').entryName = '../escape.txt';
    await uploadZipToProject(p.id, zip.toBuffer(), { preservePaths: true });
    expect(await pathsOf(p.id)).toEqual(['ok/a.txt']);
  });
});
