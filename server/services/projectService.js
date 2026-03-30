import { v4 as uuid } from 'uuid';
import { gzipSync } from 'node:zlib';
import AdmZip from 'adm-zip';
import db from '../db.js';
import { isProjectMember } from '../middleware/auth.js';
import { BINARY_EXTS } from '../utils/fileTypes.js';

const MAX_ZIP_ENTRIES = 500;
const MAX_ZIP_ENTRY_SIZE = 10 * 1024 * 1024;
const MAX_ZIP_TOTAL_SIZE = 200 * 1024 * 1024;

export function isValidFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  if (filePath.includes('\0')) return false;
  if (filePath.startsWith('/') || filePath.startsWith('\\')) return false;
  const parts = filePath.split(/[/\\]/);
  if (parts.some((p) => p === '..' || p === '')) return false;
  if (filePath.length > 500) return false;
  return true;
}

// --- Authorization helpers ---

export async function checkMembership(projectId, userId) {
  return isProjectMember(projectId, userId);
}

export async function checkEditor(projectId, userId) {
  const member = await isProjectMember(projectId, userId);
  if (!member) return { error: 'No access to this project', status: 403 };
  if (member.role === 'viewer') return { error: 'Viewers cannot modify this project', status: 403 };
  return { member };
}

export async function checkOwnership(projectId, userId) {
  const member = await db.get('SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2', [
    projectId,
    userId,
  ]);
  if (!member) return { error: 'No access to this project', status: 403 };
  if (member.role !== 'owner') return { error: 'Only the project owner can perform this action', status: 403 };
  return { member };
}

export async function getFileWithAccess(fileId, userId, { edit = false } = {}) {
  const file = await db.get('SELECT * FROM files WHERE id = $1', [fileId]);
  if (!file) return { error: 'File not found', status: 404 };
  const check = edit
    ? await checkEditor(file.project_id, userId)
    : { member: await checkMembership(file.project_id, userId) };
  if (check.error) return check;
  if (!check.member) return { error: 'No access to this project', status: 403 };
  return { file, member: check.member };
}

// --- Project CRUD ---

export async function listUserProjects(userId) {
  const projects = await db.all(
    `SELECT p.*, pm.role,
       owner_u.name AS owner_name,
       owner_pm.user_id AS owner_id,
       pgl.github_repo,
       (SELECT COUNT(*) FROM project_members pm2 WHERE pm2.project_id = p.id) AS member_count,
       (SELECT ps.author_name FROM project_snapshots ps
        WHERE ps.project_id = p.id
        ORDER BY ps.created_at DESC LIMIT 1) AS last_editor
     FROM projects p
     JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
     LEFT JOIN project_members owner_pm ON owner_pm.project_id = p.id AND owner_pm.role = 'owner'
     LEFT JOIN users owner_u ON owner_u.id = owner_pm.user_id
     LEFT JOIN project_github_links pgl ON pgl.project_id = p.id AND pgl.linked_by = $1
     ORDER BY p.updated_at DESC`,
    [userId],
  );

  if (projects.length > 0) {
    const projectIds = projects.map((p) => p.id);
    const placeholders = projectIds.map((_, i) => `$${i + 1}`).join(',');
    const allTags = await db.all(
      `SELECT pt.project_id, t.id, t.name, t.color FROM tags t
       JOIN project_tags pt ON pt.tag_id = t.id
       WHERE pt.project_id IN (${placeholders})`,
      projectIds,
    );
    const tagsByProject = {};
    for (const t of allTags) {
      if (!tagsByProject[t.project_id]) tagsByProject[t.project_id] = [];
      tagsByProject[t.project_id].push({ id: t.id, name: t.name, color: t.color });
    }
    for (const p of projects) {
      p.tags = tagsByProject[p.id] || [];
    }
  }

  return projects;
}

export async function createProject(userId, name) {
  const id = uuid();
  const fileId = uuid();
  const safeName = (name || 'Untitled').slice(0, 500);
  const defaultContent = `\\documentclass{article}
\\usepackage[utf8]{inputenc}

\\title{${safeName}}
\\author{}
\\date{\\today}

\\begin{document}

\\maketitle

\\section{Introduction}
Hello from FlowTex!

\\end{document}
`;

  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO projects (id, name) VALUES ($1, $2)', [id, safeName]);
    await tx.run('INSERT INTO files (id, project_id, path, content) VALUES ($1, $2, $3, $4)', [
      fileId,
      id,
      'main.tex',
      defaultContent,
    ]);
    await tx.run('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [id, userId, 'owner']);
  });

  return { id, name: safeName };
}

export async function createProjectFromZip(userId, buffer, originalName) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  const fileEntries = entries.filter((e) => !e.isDirectory);
  if (fileEntries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP contains too many files (${fileEntries.length}, max ${MAX_ZIP_ENTRIES})`);
  }
  const totalDecompressed = fileEntries.reduce((sum, e) => sum + (e.header.size || 0), 0);
  if (totalDecompressed > MAX_ZIP_TOTAL_SIZE) {
    throw new Error(
      `ZIP decompressed size too large (${Math.round(totalDecompressed / 1024 / 1024)}MB, max ${MAX_ZIP_TOTAL_SIZE / 1024 / 1024}MB)`,
    );
  }

  const projectName = (originalName || 'Uploaded Project').replace(/\.zip$/i, '');
  const projectId = uuid();
  const created = [];

  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO projects (id, name) VALUES ($1, $2)', [projectId, projectName]);
    await tx.run('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [
      projectId,
      userId,
      'owner',
    ]);

    let actualTotal = 0;
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      let entryPath = entry.entryName;
      if (entryPath.startsWith('__MACOSX/') || entryPath.split('/').some((p) => p.startsWith('.'))) continue;
      if (entryPath.includes('..') || !isValidFilePath(entryPath)) continue;
      if (entry.header.size > MAX_ZIP_ENTRY_SIZE) continue;

      const ext = entryPath.substring(entryPath.lastIndexOf('.')).toLowerCase();
      const isBinary = BINARY_EXTS.has(ext);
      const rawData = entry.getData();
      actualTotal += rawData.length;
      if (rawData.length > MAX_ZIP_ENTRY_SIZE || actualTotal > MAX_ZIP_TOTAL_SIZE) continue;
      const content = isBinary ? rawData.toString('base64') : rawData.toString('utf8');
      const id = uuid();

      await tx.run('INSERT INTO files (id, project_id, path, content, is_binary) VALUES ($1, $2, $3, $4, $5)', [
        id,
        projectId,
        entryPath,
        content,
        isBinary,
      ]);
      created.push({ id, path: entryPath });
    }
  });

  await stripCommonPrefix(created);
  return { id: projectId, name: projectName };
}

export async function uploadZipToProject(projectId, buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const created = [];

  const fileEntries = entries.filter((e) => !e.isDirectory);
  if (fileEntries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP contains too many files (${fileEntries.length}, max ${MAX_ZIP_ENTRIES})`);
  }
  const totalDecompressed = fileEntries.reduce((sum, e) => sum + (e.header.size || 0), 0);
  if (totalDecompressed > MAX_ZIP_TOTAL_SIZE) {
    throw new Error(
      `ZIP decompressed size too large (${Math.round(totalDecompressed / 1024 / 1024)}MB, max ${MAX_ZIP_TOTAL_SIZE / 1024 / 1024}MB)`,
    );
  }

  await db.transaction(async (tx) => {
    let actualTotal = 0;
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      let entryPath = entry.entryName;
      if (entryPath.startsWith('__MACOSX/') || entryPath.split('/').some((p) => p.startsWith('.'))) continue;
      if (entryPath.includes('..') || !isValidFilePath(entryPath)) continue;
      if (entry.header.size > MAX_ZIP_ENTRY_SIZE) continue;

      const ext = entryPath.substring(entryPath.lastIndexOf('.')).toLowerCase();
      const isBinary = BINARY_EXTS.has(ext);
      const rawData = entry.getData();
      actualTotal += rawData.length;
      if (rawData.length > MAX_ZIP_ENTRY_SIZE || actualTotal > MAX_ZIP_TOTAL_SIZE) continue;
      const content = isBinary ? rawData.toString('base64') : rawData.toString('utf8');

      const existing = await tx.get('SELECT id FROM files WHERE project_id = $1 AND path = $2', [projectId, entryPath]);
      if (existing) {
        await tx.run('UPDATE files SET content = $1, is_binary = $2, updated_at = NOW() WHERE id = $3', [
          content,
          isBinary,
          existing.id,
        ]);
        created.push({ id: existing.id, path: entryPath, updated: true });
      } else {
        const id = uuid();
        await tx.run('INSERT INTO files (id, project_id, path, content, is_binary) VALUES ($1, $2, $3, $4, $5)', [
          id,
          projectId,
          entryPath,
          content,
          isBinary,
        ]);
        created.push({ id, path: entryPath, updated: false });
      }
    }
    await tx.run('UPDATE projects SET updated_at = NOW() WHERE id = $1', [projectId]);
  });

  await stripCommonPrefix(created);
  const files = await db.all('SELECT * FROM files WHERE project_id = $1 ORDER BY path', [projectId]);
  return { files, created: created.length };
}

async function stripCommonPrefix(created) {
  if (created.length <= 1) return;
  const firstSlash = created[0].path.indexOf('/');
  if (firstSlash <= 0) return;
  const prefix = created[0].path.substring(0, firstSlash + 1);
  if (!created.every((f) => f.path.startsWith(prefix))) return;
  await db.transaction(async (tx) => {
    for (const f of created) {
      const newPath = f.path.substring(prefix.length);
      if (newPath) {
        await tx.run('UPDATE files SET path = $1 WHERE id = $2', [newPath, f.id]);
        f.path = newPath;
      }
    }
  });
}

export async function updateProject(projectId, { name, main_file, snapshot_interval_sec, tex_distribution, compiler }) {
  if (main_file) {
    if (!isValidFilePath(main_file)) throw new Error('Invalid main file path');
    if (!main_file.endsWith('.tex')) throw new Error('Main file must be a .tex file');
    // Verify the file actually exists in the project
    const fileExists = await db.get('SELECT id FROM files WHERE project_id = $1 AND path = $2', [projectId, main_file]);
    if (!fileExists) throw new Error('Main file not found in project');
    await db.run('UPDATE projects SET main_file = $1 WHERE id = $2', [main_file, projectId]);
  }
  if (name && name.trim()) {
    await db.run('UPDATE projects SET name = $1 WHERE id = $2', [name.trim(), projectId]);
  }
  if (snapshot_interval_sec != null) {
    const val = Math.max(10, Math.min(3600, parseInt(snapshot_interval_sec) || 30));
    await db.run('UPDATE projects SET snapshot_interval_sec = $1 WHERE id = $2', [val, projectId]);
  }
  if (tex_distribution !== undefined) {
    await db.run('UPDATE projects SET tex_distribution = $1 WHERE id = $2', [tex_distribution || null, projectId]);
  }
  if (compiler !== undefined) {
    const valid = ['pdflatex', 'xelatex', 'lualatex'];
    const val = valid.includes(compiler) ? compiler : 'pdflatex';
    await db.run('UPDATE projects SET compiler = $1 WHERE id = $2', [val, projectId]);
  }
  return db.get('SELECT * FROM projects WHERE id = $1', [projectId]);
}

export async function deleteProject(projectId) {
  await db.run('DELETE FROM projects WHERE id = $1', [projectId]);
}

export async function copyProject(projectId, userId, newName) {
  const source = await db.get('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (!source) throw new Error('Project not found');
  const newId = uuid();
  const name = (newName || source.name + ' (Copy)').slice(0, 200);
  const files = await db.all('SELECT path, content, is_binary FROM files WHERE project_id = $1', [projectId]);
  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO projects (id, name, main_file) VALUES ($1, $2, $3)', [newId, name, source.main_file]);
    await tx.run('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [
      newId,
      userId,
      'owner',
    ]);
    for (const file of files) {
      await tx.run('INSERT INTO files (id, project_id, path, content, is_binary) VALUES ($1, $2, $3, $4, $5)', [
        uuid(),
        newId,
        file.path,
        file.content,
        file.is_binary,
      ]);
    }
  });
  return db.get('SELECT * FROM projects WHERE id = $1', [newId]);
}

// --- File operations ---

export async function getProjectFiles(projectId) {
  return db.all('SELECT * FROM files WHERE project_id = $1 ORDER BY path', [projectId]);
}

export async function createFile(projectId, filePath, content) {
  if (!isValidFilePath(filePath)) throw new Error('Invalid file path');
  if (content && content.length > 10 * 1024 * 1024) throw new Error('File too large (max 10MB)');
  const existing = await db.get('SELECT id FROM files WHERE project_id = $1 AND path = $2', [projectId, filePath]);
  if (existing) throw Object.assign(new Error('A file with that name already exists'), { status: 409 });
  const id = uuid();
  await db.run('INSERT INTO files (id, project_id, path, content) VALUES ($1, $2, $3, $4)', [
    id,
    projectId,
    filePath,
    content || '',
  ]);
  await db.run('UPDATE projects SET updated_at = NOW() WHERE id = $1', [projectId]);
  return { id, project_id: projectId, path: filePath, content: content || '' };
}

export async function updateFileContent(fileId, content, userId) {
  const file = await db.get('SELECT * FROM files WHERE id = $1', [fileId]);
  if (!file) throw new Error('File not found');
  if (file.content === content) return { ok: true, newSnapshot: false };

  const user = userId ? await db.get('SELECT id, name FROM users WHERE id = $1', [userId]) : null;
  const authorId = user?.id || null;
  const authorName = user?.name || 'Unknown';
  let newSnapshot = false;

  await db.transaction(async (tx) => {
    await tx.run('UPDATE files SET content = $1, updated_at = NOW() WHERE id = $2', [content, file.id]);
    await tx.run('UPDATE projects SET updated_at = NOW() WHERE id = $1', [file.project_id]);

    const proj = await tx.get('SELECT snapshot_interval_sec FROM projects WHERE id = $1', [file.project_id]);
    const intervalSec = proj?.snapshot_interval_sec || 30;
    const latestSnap = await tx.get(
      'SELECT id, created_at FROM project_snapshots WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
      [file.project_id],
    );
    const elapsed = latestSnap ? (Date.now() - new Date(latestSnap.created_at).getTime()) / 1000 : Infinity;
    if (elapsed >= intervalSec) {
      const allFiles = await tx.all(
        'SELECT id, path, content, is_binary FROM files WHERE project_id = $1 ORDER BY path',
        [file.project_id],
      );
      const payload = JSON.stringify({ files: allFiles });
      const compressed = gzipSync(Buffer.from(payload, 'utf8'));
      await tx.run(
        'INSERT INTO project_snapshots (id, project_id, data, author_id, author_name) VALUES ($1, $2, $3, $4, $5)',
        [uuid(), file.project_id, compressed, authorId, authorName],
      );
      newSnapshot = true;
    }
  });

  return { ok: true, newSnapshot, projectId: file.project_id, authorName };
}

export async function renameFile(fileId, newPath) {
  if (!isValidFilePath(newPath)) throw new Error('Invalid file path');
  await db.run('UPDATE files SET path = $1, updated_at = NOW() WHERE id = $2', [newPath, fileId]);
  const file = await db.get('SELECT * FROM files WHERE id = $1', [fileId]);
  if (file) await db.run('UPDATE projects SET updated_at = NOW() WHERE id = $1', [file.project_id]);
  return file;
}

export async function deleteFile(fileId) {
  await db.run('DELETE FROM files WHERE id = $1', [fileId]);
}

export async function getRawFile(fileId, userId) {
  const file = await db.get(
    'SELECT f.*, pm.user_id FROM files f JOIN project_members pm ON f.project_id = pm.project_id WHERE f.id = $1 AND pm.user_id = $2',
    [fileId, userId],
  );
  return file;
}

// --- Member management ---

export async function getProjectMembers(projectId) {
  return db.all(
    `SELECT u.id, u.email, u.name, pm.role FROM project_members pm
     JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = $1`,
    [projectId],
  );
}

export async function inviteMember(projectId, email, role, inviterId) {
  const normalizedEmail = email.toLowerCase().trim();
  const user = await db.get('SELECT id, email, name FROM users WHERE email = $1', [normalizedEmail]);
  if (!user) throw Object.assign(new Error('User not found. They must register first.'), { status: 404 });

  const existing = await db.get('SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2', [
    projectId,
    user.id,
  ]);
  if (existing) throw Object.assign(new Error('User is already a member'), { status: 409 });

  const VALID_ROLES = ['editor', 'viewer'];
  const assignedRole = VALID_ROLES.includes(role) ? role : 'editor';

  const existingInvite = await db.get(
    "SELECT id FROM project_invitations WHERE project_id = $1 AND email = $2 AND status = 'pending'",
    [projectId, email],
  );
  if (existingInvite) throw Object.assign(new Error('Invitation already pending'), { status: 409 });

  const id = uuid();
  await db.run(
    "INSERT INTO project_invitations (id, project_id, email, role, inviter_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (project_id, email) DO UPDATE SET role = $4, inviter_id = $5, status = 'pending'",
    [id, projectId, email, assignedRole, inviterId],
  );
  return { id, email, role: assignedRole, status: 'pending' };
}

export async function removeMember(projectId, userId) {
  await db.run('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
}

// --- Invitations ---

export async function getMyInvitations(userId) {
  const user = await db.get('SELECT email FROM users WHERE id = $1', [userId]);
  if (!user) return [];
  return db.all(
    `SELECT pi.id, pi.project_id, pi.role, pi.status, pi.created_at,
            p.name AS project_name, u.name AS inviter_name
     FROM project_invitations pi
     JOIN projects p ON p.id = pi.project_id
     JOIN users u ON u.id = pi.inviter_id
     WHERE pi.email = $1 AND pi.status = 'pending'
     ORDER BY pi.created_at DESC`,
    [user.email],
  );
}

export async function acceptInvitation(inviteId, userId) {
  const user = await db.get('SELECT id, email FROM users WHERE id = $1', [userId]);
  if (!user) throw new Error('Not logged in');
  const invite = await db.get("SELECT * FROM project_invitations WHERE id = $1 AND email = $2 AND status = 'pending'", [
    inviteId,
    user.email,
  ]);
  if (!invite) throw Object.assign(new Error('Invitation not found'), { status: 404 });

  await db.transaction(async (tx) => {
    await tx.run("UPDATE project_invitations SET status = 'accepted' WHERE id = $1", [invite.id]);
    const existing = await tx.get('SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2', [
      invite.project_id,
      user.id,
    ]);
    if (!existing) {
      await tx.run('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [
        invite.project_id,
        user.id,
        invite.role,
      ]);
    }
  });
  return { ok: true, projectId: invite.project_id };
}

export async function declineInvitation(inviteId, userId) {
  const user = await db.get('SELECT id, email FROM users WHERE id = $1', [userId]);
  if (!user) throw new Error('Not logged in');
  const invite = await db.get("SELECT * FROM project_invitations WHERE id = $1 AND email = $2 AND status = 'pending'", [
    inviteId,
    user.email,
  ]);
  if (!invite) throw Object.assign(new Error('Invitation not found'), { status: 404 });
  await db.run("UPDATE project_invitations SET status = 'declined' WHERE id = $1", [invite.id]);
}

export async function getProjectInvitations(projectId) {
  return db.all(
    `SELECT pi.id, pi.email, pi.role, pi.status, pi.created_at, u.name AS inviter_name
     FROM project_invitations pi JOIN users u ON u.id = pi.inviter_id
     WHERE pi.project_id = $1 AND pi.status = 'pending' ORDER BY pi.created_at DESC`,
    [projectId],
  );
}

export async function cancelInvitation(inviteId, projectId) {
  await db.run('DELETE FROM project_invitations WHERE id = $1 AND project_id = $2', [inviteId, projectId]);
}

// --- Archive / Trash ---

export async function archiveProject(projectId) {
  await db.run('UPDATE projects SET archived = TRUE WHERE id = $1', [projectId]);
}

export async function unarchiveProject(projectId) {
  await db.run('UPDATE projects SET archived = FALSE WHERE id = $1', [projectId]);
}

export async function trashProject(projectId) {
  await db.run('UPDATE projects SET trashed = TRUE WHERE id = $1', [projectId]);
}

export async function restoreProject(projectId) {
  await db.run('UPDATE projects SET trashed = FALSE WHERE id = $1', [projectId]);
}
