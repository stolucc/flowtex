// Integration: project CRUD + members against the real DB.

import { describe, it, expect } from 'vitest';
import { seedUser, seedProject, seedFile } from './setup.js';
import db from '../../db.js';
import {
  isValidFilePath,
  renameFile,
  deleteFile,
  listFolders,
  createFolder,
  deleteFolder,
  renameFolderTree,
  inviteMember,
  acceptInvitation,
  removeMember,
} from '../../services/projectService.js';

describe('projects — file rename / move', () => {
  it('renames a file in place (no slash)', async () => {
    const u = await seedUser();
    const p = await seedProject(u.id);
    const f = await seedFile(p.id, 'intro.tex', '\\section{Hi}');
    await renameFile(f.id, 'introduction.tex');
    const row = await db.get('SELECT path FROM files WHERE id = $1', [f.id]);
    expect(row.path).toBe('introduction.tex');
  });

  it('moves a file into a folder by renaming to a slashed path', async () => {
    const u = await seedUser();
    const p = await seedProject(u.id);
    const f = await seedFile(p.id, 'chapter1.tex');
    await renameFile(f.id, 'parts/chapter1.tex');
    const row = await db.get('SELECT path FROM files WHERE id = $1', [f.id]);
    expect(row.path).toBe('parts/chapter1.tex');
  });

  it('rejects invalid paths (.. or absolute)', async () => {
    expect(isValidFilePath('../escape.tex')).toBe(false);
    expect(isValidFilePath('/etc/passwd')).toBe(false);
    expect(isValidFilePath('ok/fine.tex')).toBe(true);
  });

  it('renaming the main file updates the project pointer', async () => {
    const u = await seedUser();
    const p = await seedProject(u.id, { main_file: 'main.tex' });
    const f = await seedFile(p.id, 'main.tex');
    await renameFile(f.id, 'manuscript.tex');
    const proj = await db.get('SELECT main_file FROM projects WHERE id = $1', [p.id]);
    expect(proj.main_file).toBe('manuscript.tex');
  });

  it('deleteFile removes the row', async () => {
    const u = await seedUser();
    const p = await seedProject(u.id);
    const f = await seedFile(p.id, 'gone.tex');
    await deleteFile(f.id);
    const row = await db.get('SELECT id FROM files WHERE id = $1', [f.id]);
    expect(row).toBeUndefined();
  });
});

describe('projects — folders (server-backed)', () => {
  it('createFolder is idempotent', async () => {
    const u = await seedUser();
    const p = await seedProject(u.id);
    await createFolder(p.id, 'parts');
    await createFolder(p.id, 'parts');
    const rows = await db.all(`SELECT path FROM project_folders WHERE project_id = $1`, [p.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe('parts');
  });

  it('listFolders returns sorted paths', async () => {
    const u = await seedUser();
    const p = await seedProject(u.id);
    await createFolder(p.id, 'zeta');
    await createFolder(p.id, 'alpha');
    await createFolder(p.id, 'mu');
    const paths = await listFolders(p.id);
    expect(paths).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('deleteFolder removes both the folder row and every file under it', async () => {
    const u = await seedUser();
    const p = await seedProject(u.id);
    await createFolder(p.id, 'doomed');
    await seedFile(p.id, 'doomed/a.tex');
    await seedFile(p.id, 'doomed/nested/b.tex');
    await seedFile(p.id, 'survives.tex');
    await createFolder(p.id, 'doomed/nested'); // explicit empty folder under prefix

    await deleteFolder(p.id, 'doomed');

    const remainingFiles = await db.all(`SELECT path FROM files WHERE project_id = $1`, [p.id]);
    expect(remainingFiles.map((r) => r.path)).toEqual(['survives.tex']);
    const remainingFolders = await db.all(`SELECT path FROM project_folders WHERE project_id = $1`, [p.id]);
    expect(remainingFolders).toEqual([]);
  });

  it('renameFolderTree rewrites every file path AND folder row under the prefix', async () => {
    const u = await seedUser();
    const p = await seedProject(u.id);
    await createFolder(p.id, 'old');
    await createFolder(p.id, 'old/inner');
    await seedFile(p.id, 'old/intro.tex');
    await seedFile(p.id, 'old/inner/ch1.tex');
    await seedFile(p.id, 'unrelated.tex');

    await renameFolderTree(p.id, 'old', 'new');

    const files = await db.all(`SELECT path FROM files WHERE project_id = $1 ORDER BY path`, [p.id]);
    expect(files.map((f) => f.path)).toEqual(['new/inner/ch1.tex', 'new/intro.tex', 'unrelated.tex']);
    const folders = await db.all(`SELECT path FROM project_folders WHERE project_id = $1 ORDER BY path`, [p.id]);
    expect(folders.map((f) => f.path)).toEqual(['new', 'new/inner']);
  });

  it('renameFolderTree refuses to move into a descendant', async () => {
    const u = await seedUser();
    const p = await seedProject(u.id);
    await createFolder(p.id, 'parts');
    await expect(renameFolderTree(p.id, 'parts', 'parts/inner')).rejects.toThrow(/into itself/);
  });

  it('renameFolderTree refuses to overwrite an existing target prefix', async () => {
    const u = await seedUser();
    const p = await seedProject(u.id);
    await createFolder(p.id, 'a');
    await seedFile(p.id, 'a/file.tex');
    await createFolder(p.id, 'b');
    await seedFile(p.id, 'b/clash.tex');
    await expect(renameFolderTree(p.id, 'a', 'b')).rejects.toThrow(/already exists/);
  });

  it('folder ops follow the main_file pointer when it lives under the prefix', async () => {
    const u = await seedUser();
    const p = await seedProject(u.id, { main_file: 'src/main.tex' });
    await seedFile(p.id, 'src/main.tex');
    await renameFolderTree(p.id, 'src', 'manuscript');
    const proj = await db.get('SELECT main_file FROM projects WHERE id = $1', [p.id]);
    expect(proj.main_file).toBe('manuscript/main.tex');
  });
});

describe('projects — invitations', () => {
  it('acceptInvitation requires the invitee email to match the session email', async () => {
    const inviter = await seedUser();
    const target = await seedUser();
    const stranger = await seedUser();
    const project = await seedProject(inviter.id);
    const invitation = await inviteMember(project.id, target.email, 'editor', inviter.id);

    // Stranger trying to accept gets an error with emailMismatch=true
    const result = await acceptInvitation(invitation.id, stranger.id).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect(result.status).toBe(404);
    expect(result.emailMismatch).toBe(true);

    // Real invitee succeeds
    const ok = await acceptInvitation(invitation.id, target.id);
    expect(ok.ok).toBe(true);
    expect(ok.projectId).toBe(project.id);
    const mem = await db.get(
      'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
      [project.id, target.id],
    );
    expect(mem.role).toBe('editor');
  });
});

describe('projects — members', () => {
  it('removeMember drops the project_members row', async () => {
    const owner = await seedUser();
    const editor = await seedUser();
    const project = await seedProject(owner.id);
    await db.run(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')`,
      [project.id, editor.id],
    );
    await removeMember(project.id, editor.id);
    const row = await db.get(
      `SELECT 1 AS x FROM project_members WHERE project_id = $1 AND user_id = $2`,
      [project.id, editor.id],
    );
    expect(row).toBeUndefined();
  });
});
