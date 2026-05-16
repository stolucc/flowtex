// Integration: project CRUD + members against the real DB.

import { describe, it, expect } from 'vitest';
import { seedUser, seedProject, seedFile } from './setup.js';
import db from '../../db.js';
import { v4 as uuid } from 'uuid';
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
  copyProject,
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

describe('projects — copyProject carries over comments', () => {
  async function seedComment(fileId, authorId, text, fromPos = 0, toPos = 5) {
    const id = uuid();
    await db.run(
      `INSERT INTO comments (id, file_id, from_pos, to_pos, text, author, author_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, fileId, fromPos, toPos, text, 'Alice', authorId],
    );
    return id;
  }
  async function seedReply(commentId, authorId, text) {
    const id = uuid();
    await db.run(
      `INSERT INTO comment_replies (id, comment_id, text, author, author_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, commentId, text, 'Bob', authorId],
    );
    return id;
  }
  async function seedCommentReaction(commentId, userId, emoji) {
    await db.run(
      `INSERT INTO comment_reactions (id, comment_id, user_id, user_name, emoji)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuid(), commentId, userId, 'Alice', emoji],
    );
  }
  async function seedReplyReaction(replyId, userId, emoji) {
    await db.run(
      `INSERT INTO reply_reactions (id, reply_id, user_id, user_name, emoji)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuid(), replyId, userId, 'Bob', emoji],
    );
  }

  it('copies comments, replies, and their reactions; remaps file_id and comment_id', async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const src = await seedProject(owner.id);
    const f = await seedFile(src.id, 'main.tex', '\\section{A}');
    const cid = await seedComment(f.id, owner.id, 'fix this bit');
    const rid = await seedReply(cid, other.id, 'will do');
    await seedCommentReaction(cid, owner.id, '👍');
    await seedCommentReaction(cid, other.id, '👍');
    await seedReplyReaction(rid, owner.id, '🎉');

    const copy = await copyProject(src.id, owner.id, 'My Copy');
    expect(copy.id).not.toBe(src.id);
    expect(copy.name).toBe('My Copy');

    // The copy has its own file with the same path/content.
    const copyFiles = await db.all('SELECT id, path, content FROM files WHERE project_id = $1', [copy.id]);
    expect(copyFiles).toHaveLength(1);
    expect(copyFiles[0].path).toBe('main.tex');
    expect(copyFiles[0].id).not.toBe(f.id);

    // Comments are cloned with new IDs but text/positions preserved, and
    // their file_id points at the copy's file (NOT the source's).
    const copyComments = await db.all(
      'SELECT id, file_id, from_pos, to_pos, text, author_id FROM comments WHERE file_id = $1',
      [copyFiles[0].id],
    );
    expect(copyComments).toHaveLength(1);
    expect(copyComments[0].id).not.toBe(cid);
    expect(copyComments[0].text).toBe('fix this bit');
    expect(copyComments[0].author_id).toBe(owner.id);

    // Replies follow with the new comment_id.
    const copyReplies = await db.all(
      'SELECT id, comment_id, text, author_id FROM comment_replies WHERE comment_id = $1',
      [copyComments[0].id],
    );
    expect(copyReplies).toHaveLength(1);
    expect(copyReplies[0].id).not.toBe(rid);
    expect(copyReplies[0].text).toBe('will do');
    expect(copyReplies[0].author_id).toBe(other.id);

    // Reactions on both comment and reply are duplicated under new comment/reply IDs.
    const copyCReactions = await db.all(
      'SELECT user_id, emoji FROM comment_reactions WHERE comment_id = $1 ORDER BY user_id',
      [copyComments[0].id],
    );
    expect(copyCReactions.map((r) => r.emoji)).toEqual(['👍', '👍']);

    const copyRReactions = await db.all(
      'SELECT user_id, emoji FROM reply_reactions WHERE reply_id = $1',
      [copyReplies[0].id],
    );
    expect(copyRReactions).toEqual([{ user_id: owner.id, emoji: '🎉' }]);

    // The source project is untouched: original comment is still there.
    const sourceComment = await db.get('SELECT id FROM comments WHERE id = $1', [cid]);
    expect(sourceComment).toBeDefined();
  });

  it('copies the tc_marks sidecar so tracked changes survive a project copy', async () => {
    const owner = await seedUser();
    const src = await seedProject(owner.id);
    const f = await seedFile(src.id, 'main.tex', 'Hello world');
    // Mark a deletion of "world" and an insertion of "Earth" the way the
    // editor does.
    const marks = [
      { id: 'm1', type: 'del', from: 6, to: 11, authorId: owner.id, authorName: 'Owner', timestamp: '2026-01-01T00:00:00Z' },
      { id: 'm2', type: 'ins', from: 11, to: 16, authorId: owner.id, authorName: 'Owner', timestamp: '2026-01-01T00:00:00Z' },
    ];
    await db.run('UPDATE files SET content = $1, tc_marks = $2::jsonb WHERE id = $3', [
      'Hello worldEarth',
      JSON.stringify(marks),
      f.id,
    ]);

    const copy = await copyProject(src.id, owner.id);
    const copyFile = await db.get(
      'SELECT content, tc_marks FROM files WHERE project_id = $1 AND path = $2',
      [copy.id, 'main.tex'],
    );
    expect(copyFile.content).toBe('Hello worldEarth');
    expect(copyFile.tc_marks).toEqual(marks);
  });

  it('skips the comment_mentions notification log when copying', async () => {
    const owner = await seedUser();
    const mentioned = await seedUser();
    const src = await seedProject(owner.id);
    const f = await seedFile(src.id, 'main.tex');
    const cid = await seedComment(f.id, owner.id, 'hey @bob');
    // Manually insert a mention row mirroring what recordMentions writes.
    await db.run(
      `INSERT INTO comment_mentions (id, comment_id, mentioned_user_id, mentioner_user_id, project_id, snippet)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuid(), cid, mentioned.id, owner.id, src.id, 'hey @bob'],
    );

    const copy = await copyProject(src.id, owner.id);

    // No new mention rows for the copy's comment(s).
    const copyMentions = await db.all(
      'SELECT 1 AS x FROM comment_mentions WHERE project_id = $1',
      [copy.id],
    );
    expect(copyMentions).toHaveLength(0);
  });

  it('copies a project with no comments without erroring', async () => {
    const owner = await seedUser();
    const src = await seedProject(owner.id);
    await seedFile(src.id, 'main.tex', '\\section{A}');
    const copy = await copyProject(src.id, owner.id);
    const comments = await db.all(
      `SELECT 1 AS x FROM comments c JOIN files f ON c.file_id = f.id WHERE f.project_id = $1`,
      [copy.id],
    );
    expect(comments).toHaveLength(0);
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
