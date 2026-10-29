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
import {
  uploadZipToProject,
  createProjectFromZip,
  createFile,
  updateFileContent,
} from '../../services/projectService.js';

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

  it('accepts up to 2000 entries and rejects 2001 before touching the DB', async () => {
    const p = await seed();
    const many = (n) => {
      const zip = new AdmZip();
      for (let i = 0; i < n; i++) zip.addFile(`bulk/f${i}.txt`, Buffer.from('x'));
      return zip.toBuffer();
    };
    await expect(uploadZipToProject(p.id, many(2001), { preservePaths: true })).rejects.toThrow(
      'ZIP contains too many files (2001, max 2000)',
    );
    expect(await pathsOf(p.id)).toEqual([]);
    // 600 (> the old 500 cap) now goes through.
    const res = await uploadZipToProject(p.id, many(600), { preservePaths: true });
    expect(res.created).toBe(600);
  });
});


// "invalid byte sequence for encoding UTF8: 0x00": a binary file whose
// extension isn't in BINARY_EXTS used to be inserted as TEXT.
describe('binary content with an unknown extension', () => {
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

  it('uploadZipToProject stores it as a blob instead of failing', async () => {
    const p = await seed();
    await uploadZipToProject(p.id, zipOf({ 'img/photo.webp': webp, 'img/scan.heic': Buffer.from([0, 0, 0, 24, 1]) }), { preservePaths: true });
    const rows = await db.all('SELECT path, is_binary, content, binary_sha256 FROM files WHERE project_id = $1 ORDER BY path', [p.id]);
    expect(rows.map((r) => [r.path, r.is_binary])).toEqual([['img/photo.webp', true], ['img/scan.heic', true]]);
    expect(rows[0].binary_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('createProjectFromZip stores it as a blob too', async () => {
    const user = await seedUser();
    const proj = await createProjectFromZip(user.id, zipOf({ 'main.tex': 'x', 'fig.webp': webp }), 'p.zip');
    createdProjects.push(proj.id);
    const row = await db.get('SELECT is_binary FROM files WHERE project_id = $1 AND path = $2', [proj.id, 'fig.webp']);
    expect(row.is_binary).toBe(true);
  });

  it('text create / save refuse NUL with a clear 400 (not a driver error)', async () => {
    const p = await seed();
    await expect(createFile(p.id, 'bad.dat', 'a\u0000b')).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/binary data/),
    });
    const f = await seedFile(p.id, 'ok.txt', 'fine');
    await expect(updateFileContent(f.id, 'x\u0000y', 'nobody')).rejects.toMatchObject({ status: 400 });
    const row = await db.get('SELECT content FROM files WHERE id = $1', [f.id]);
    expect(row.content).toBe('fine');
  });

  it('a non-ZIP upload gets a clean 400', async () => {
    const p = await seed();
    await expect(uploadZipToProject(p.id, Buffer.from('not a zip at all'))).rejects.toMatchObject({
      status: 400,
      message: 'Not a valid ZIP file.',
    });
  });
});
