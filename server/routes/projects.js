import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { gzipSync } from 'node:zlib';
import archiver from 'archiver';
import AdmZip from 'adm-zip';
import multer from 'multer';
import db from '../db.js';
import logger from '../logger.js';
import { isProjectMember } from '../middleware/auth.js';
import { auditLog } from '../utils/audit.js';
import { sendProjectInvitationEmail } from '../utils/email.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const MAX_ZIP_ENTRIES = 500;
const MAX_ZIP_ENTRY_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_ZIP_TOTAL_SIZE = 200 * 1024 * 1024; // 200MB total decompressed

const router = Router();

function isValidFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  // Reject path traversal, absolute paths, null bytes
  if (filePath.includes('\0')) return false;
  if (filePath.startsWith('/') || filePath.startsWith('\\')) return false;
  const parts = filePath.split(/[/\\]/);
  if (parts.some(p => p === '..' || p === '')) return false;
  if (filePath.length > 500) return false;
  return true;
}

async function requireMembership(projectId, userId, res) {
  const member = await isProjectMember(projectId, userId);
  if (!member) {
    res.status(403).json({ error: 'No access to this project' });
    return null;
  }
  return member;
}

async function requireEditor(projectId, userId, res) {
  const member = await requireMembership(projectId, userId, res);
  if (!member) return null;
  if (member.role === 'viewer') {
    res.status(403).json({ error: 'Viewers cannot modify this project' });
    return null;
  }
  return member;
}

async function requireOwnership(projectId, userId, res) {
  const member = await db.get(
    'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, userId]
  );
  if (!member) {
    res.status(403).json({ error: 'No access to this project' });
    return false;
  }
  if (member.role !== 'owner') {
    res.status(403).json({ error: 'Only the project owner can perform this action' });
    return false;
  }
  return true;
}

async function requireFileAccess(fileId, userId, res, { edit = false } = {}) {
  const file = await db.get('SELECT * FROM files WHERE id = $1', [fileId]);
  if (!file) {
    res.status(404).json({ error: 'File not found' });
    return null;
  }
  const member = edit
    ? await requireEditor(file.project_id, userId, res)
    : await requireMembership(file.project_id, userId, res);
  if (!member) return null;
  return { file, member };
}

// List projects the user is a member of
router.get('/', async (req, res) => {
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
     LEFT JOIN project_github_links pgl ON pgl.project_id = p.id
     ORDER BY p.updated_at DESC`,
    [req.session.userId]
  );

  // Batch-fetch tags for all projects (avoids N+1)
  if (projects.length > 0) {
    const projectIds = projects.map(p => p.id);
    const placeholders = projectIds.map((_, i) => `$${i + 1}`).join(',');
    const allTags = await db.all(
      `SELECT pt.project_id, t.id, t.name, t.color FROM tags t
       JOIN project_tags pt ON pt.tag_id = t.id
       WHERE pt.project_id IN (${placeholders})`,
      projectIds
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

  res.json(projects);
});

// Create a project
router.post('/', async (req, res) => {
  const { name } = req.body;
  const id = uuid();
  const fileId = uuid();

  const defaultContent = `\\documentclass{article}
\\usepackage[utf8]{inputenc}

\\title{${name || 'Untitled'}}
\\author{}
\\date{\\today}

\\begin{document}

\\maketitle

\\section{Introduction}
Hello from FlowTex!

\\end{document}
`;

  await db.transaction(async (tx) => {
    const safeName = (name || 'Untitled').slice(0, 500);
    await tx.run('INSERT INTO projects (id, name) VALUES ($1, $2)', [id, safeName]);
    await tx.run(
      'INSERT INTO files (id, project_id, path, content) VALUES ($1, $2, $3, $4)',
      [fileId, id, 'main.tex', defaultContent]
    );
    await tx.run(
      'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)',
      [id, req.session.userId, 'owner']
    );
  });

  res.json({ id, name: name || 'Untitled' });
});

// Create project from ZIP upload
router.post('/from-zip', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();
    const binaryExts = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.ico', '.eps', '.ps', '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.class', '.jar', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.avi', '.mov', '.wav', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);

    const fileEntries = entries.filter(e => !e.isDirectory);
    if (fileEntries.length > MAX_ZIP_ENTRIES) {
      return res.status(400).json({ error: `ZIP contains too many files (${fileEntries.length}, max ${MAX_ZIP_ENTRIES})` });
    }
    const totalDecompressed = fileEntries.reduce((sum, e) => sum + (e.header.size || 0), 0);
    if (totalDecompressed > MAX_ZIP_TOTAL_SIZE) {
      return res.status(400).json({ error: `ZIP decompressed size too large (${Math.round(totalDecompressed / 1024 / 1024)}MB, max ${MAX_ZIP_TOTAL_SIZE / 1024 / 1024}MB)` });
    }

    // Derive project name from zip filename
    const originalName = req.file.originalname || 'Uploaded Project';
    const projectName = originalName.replace(/\.zip$/i, '');
    const projectId = uuid();
    const created = [];

    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO projects (id, name) VALUES ($1, $2)', [projectId, projectName]);
      await tx.run(
        'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)',
        [projectId, req.session.userId, 'owner']
      );

      let actualTotal = 0;
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        let entryPath = entry.entryName;
        if (entryPath.startsWith('__MACOSX/') || entryPath.split('/').some(p => p.startsWith('.'))) continue;
        if (entryPath.includes('..')) continue;
        if (!isValidFilePath(entryPath)) continue;
        if (entry.header.size > MAX_ZIP_ENTRY_SIZE) continue;

        const ext = entryPath.substring(entryPath.lastIndexOf('.')).toLowerCase();
        const isBinary = binaryExts.has(ext);
        const rawData = entry.getData();
        actualTotal += rawData.length;
        if (rawData.length > MAX_ZIP_ENTRY_SIZE || actualTotal > MAX_ZIP_TOTAL_SIZE) continue;
        const content = isBinary ? rawData.toString('base64') : rawData.toString('utf8');
        const id = uuid();

        await tx.run(
          'INSERT INTO files (id, project_id, path, content, is_binary) VALUES ($1, $2, $3, $4, $5)',
          [id, projectId, entryPath, content, isBinary]
        );
        created.push({ id, path: entryPath });
      }
    });

    // Strip common prefix folder
    if (created.length > 1) {
      const firstSlash = created[0].path.indexOf('/');
      if (firstSlash > 0) {
        const prefix = created[0].path.substring(0, firstSlash + 1);
        if (created.every(f => f.path.startsWith(prefix))) {
          await db.transaction(async (tx) => {
            for (const f of created) {
              const newPath = f.path.substring(prefix.length);
              if (newPath) {
                await tx.run('UPDATE files SET path = $1 WHERE id = $2', [newPath, f.id]);
              }
            }
          });
        }
      }
    }

    res.json({ id: projectId, name: projectName });
  } catch (err) {
    logger.error({ err }, 'ZIP project creation error');
    res.status(400).json({ error: 'Failed to create project from ZIP file' });
  }
});

// ── User-facing invitation endpoints (must be before /:id routes) ────

// List my pending invitations
router.get('/invitations/mine', async (req, res) => {
  const user = await db.get('SELECT email FROM users WHERE id = $1', [req.session.userId]);
  if (!user) return res.status(401).json({ error: 'Not logged in' });

  const invitations = await db.all(
    `SELECT pi.id, pi.project_id, pi.role, pi.status, pi.created_at,
            p.name AS project_name,
            u.name AS inviter_name
     FROM project_invitations pi
     JOIN projects p ON p.id = pi.project_id
     JOIN users u ON u.id = pi.inviter_id
     WHERE pi.email = $1 AND pi.status = 'pending'
     ORDER BY pi.created_at DESC`,
    [user.email]
  );
  res.json(invitations);
});

// Accept an invitation
router.post('/invitations/:inviteId/accept', async (req, res) => {
  const user = await db.get('SELECT id, email FROM users WHERE id = $1', [req.session.userId]);
  if (!user) return res.status(401).json({ error: 'Not logged in' });

  const invite = await db.get(
    "SELECT * FROM project_invitations WHERE id = $1 AND email = $2 AND status = 'pending'",
    [req.params.inviteId, user.email]
  );
  if (!invite) {
    return res.status(404).json({ error: 'Invitation not found' });
  }

  await db.transaction(async (tx) => {
    await tx.run("UPDATE project_invitations SET status = 'accepted' WHERE id = $1", [invite.id]);
    const existing = await tx.get(
      'SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2',
      [invite.project_id, user.id]
    );
    if (!existing) {
      await tx.run(
        'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)',
        [invite.project_id, user.id, invite.role]
      );
    }
  });

  res.json({ ok: true, projectId: invite.project_id });
});

// Decline an invitation
router.post('/invitations/:inviteId/decline', async (req, res) => {
  const user = await db.get('SELECT id, email FROM users WHERE id = $1', [req.session.userId]);
  if (!user) return res.status(401).json({ error: 'Not logged in' });

  const invite = await db.get(
    "SELECT * FROM project_invitations WHERE id = $1 AND email = $2 AND status = 'pending'",
    [req.params.inviteId, user.email]
  );
  if (!invite) {
    return res.status(404).json({ error: 'Invitation not found' });
  }

  await db.run("UPDATE project_invitations SET status = 'declined' WHERE id = $1", [invite.id]);
  res.json({ ok: true });
});

// Rename project (owner only)
router.patch('/:id', async (req, res) => {
  const member = await requireMembership(req.params.id, req.session.userId, res);
  if (!member) return;
  if (member.role !== 'owner') {
    return res.status(403).json({ error: 'Only the owner can rename a project' });
  }
  const { name, main_file, snapshot_interval_sec } = req.body;
  if (main_file) {
    if (!isValidFilePath(main_file)) return res.status(400).json({ error: 'Invalid main file path' });
    await db.run('UPDATE projects SET main_file = $1 WHERE id = $2', [main_file, req.params.id]);
  }
  if (name && name.trim()) {
    await db.run('UPDATE projects SET name = $1 WHERE id = $2', [name.trim(), req.params.id]);
  }
  if (snapshot_interval_sec != null) {
    const val = Math.max(10, Math.min(3600, parseInt(snapshot_interval_sec) || 30));
    await db.run('UPDATE projects SET snapshot_interval_sec = $1 WHERE id = $2', [val, req.params.id]);
  }
  if (!name && !main_file && snapshot_interval_sec == null) return res.status(400).json({ error: 'Nothing to update' });
  const project = await db.get('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  res.json(project);
});

// Delete a project (owner only)
router.delete('/:id', async (req, res) => {
  const member = await requireMembership(req.params.id, req.session.userId, res);
  if (!member) return;
  if (member.role !== 'owner') {
    return res.status(403).json({ error: 'Only the owner can delete a project' });
  }
  await db.run('DELETE FROM projects WHERE id = $1', [req.params.id]);
  await auditLog(req.session.userId, 'project_delete', { targetType: 'project', targetId: req.params.id, ip: req.ip });
  res.json({ ok: true });
});

// List project members
router.get('/:id/members', async (req, res) => {
  if (!(await requireMembership(req.params.id, req.session.userId, res))) return;
  const members = await db.all(
    `SELECT u.id, u.email, u.name, pm.role FROM project_members pm
     JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = $1`,
    [req.params.id]
  );
  res.json(members);
});

// Invite a user to a project (owner only)
router.post('/:id/members', async (req, res) => {
  const { email, role } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  const normalizedEmail = email.toLowerCase().trim();
  const member = await requireMembership(req.params.id, req.session.userId, res);
  if (!member) return;
  if (member.role !== 'owner') {
    return res.status(403).json({ error: 'Only the owner can invite members' });
  }

  const user = await db.get('SELECT id, email, name FROM users WHERE email = $1', [normalizedEmail]);
  if (!user) {
    return res.status(404).json({ error: 'User not found. They must register first.' });
  }

  const existing = await db.get(
    'SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2',
    [req.params.id, user.id]
  );
  if (existing) {
    return res.status(409).json({ error: 'User is already a member' });
  }

  const VALID_ROLES = ['editor', 'viewer'];
  const assignedRole = VALID_ROLES.includes(role) ? role : 'editor';

  const existingInvite = await db.get(
    "SELECT id, status FROM project_invitations WHERE project_id = $1 AND email = $2 AND status = 'pending'",
    [req.params.id, email]
  );
  if (existingInvite) {
    return res.status(409).json({ error: 'Invitation already pending' });
  }

  const id = uuid();
  await db.run(
    'INSERT INTO project_invitations (id, project_id, email, role, inviter_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (project_id, email) DO UPDATE SET role = $4, inviter_id = $5, status = \'pending\'',
    [id, req.params.id, email, assignedRole, req.session.userId]
  );

  // Send invitation email
  try {
    const inviter = await db.get('SELECT name FROM users WHERE id = $1', [req.session.userId]);
    const project = await db.get('SELECT name FROM projects WHERE id = $1', [req.params.id]);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    await sendProjectInvitationEmail(email, {
      inviterName: inviter?.name || 'Someone',
      projectName: project?.name || 'a project',
      baseUrl,
    });
  } catch (err) {
    logger.warn({ err, email }, 'Failed to send invitation email');
  }

  res.json({ id, email, role: assignedRole, status: 'pending' });
});

// List pending invitations for a project (owner only)
router.get('/:id/invitations', async (req, res) => {
  if (!(await requireOwnership(req.params.id, req.session.userId, res))) return;
  const invitations = await db.all(
    `SELECT pi.id, pi.email, pi.role, pi.status, pi.created_at, u.name AS inviter_name
     FROM project_invitations pi
     JOIN users u ON u.id = pi.inviter_id
     WHERE pi.project_id = $1 AND pi.status = 'pending'
     ORDER BY pi.created_at DESC`,
    [req.params.id]
  );
  res.json(invitations);
});

// Cancel a pending invitation (owner only)
router.delete('/:id/invitations/:inviteId', async (req, res) => {
  const member = await requireMembership(req.params.id, req.session.userId, res);
  if (!member) return;
  if (member.role !== 'owner') {
    return res.status(403).json({ error: 'Only the owner can cancel invitations' });
  }
  await db.run(
    'DELETE FROM project_invitations WHERE id = $1 AND project_id = $2',
    [req.params.inviteId, req.params.id]
  );
  res.json({ ok: true });
});

// Remove a member from a project (owner only)
router.delete('/:id/members/:userId', async (req, res) => {
  const member = await requireMembership(req.params.id, req.session.userId, res);
  if (!member) return;
  if (member.role !== 'owner') {
    return res.status(403).json({ error: 'Only the owner can remove members' });
  }
  if (req.params.userId === req.session.userId) {
    return res.status(400).json({ error: 'Cannot remove yourself' });
  }
  await db.run(
    'DELETE FROM project_members WHERE project_id = $1 AND user_id = $2',
    [req.params.id, req.params.userId]
  );
  // Immediately disconnect the removed user's WebSocket
  req.app.locals.disconnectUserFromProject?.(req.params.id, req.params.userId);
  await auditLog(req.session.userId, 'member_remove', { targetType: 'project', targetId: req.params.id, detail: req.params.userId, ip: req.ip });
  res.json({ ok: true });
});

// Download project as ZIP
router.get('/:id/zip', async (req, res) => {
  if (!(await requireMembership(req.params.id, req.session.userId, res))) return;

  const project = await db.get('SELECT name FROM projects WHERE id = $1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const files = await db.all('SELECT path, content, is_binary FROM files WHERE project_id = $1', [req.params.id]);
  const zipName = (project.name || 'project').replace(/[^a-zA-Z0-9_-]/g, '_') + '.zip';

  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  for (const f of files) {
    archive.append(f.is_binary ? Buffer.from(f.content, 'base64') : f.content, { name: f.path });
  }
  archive.finalize();
});

// Upload a ZIP file and extract into project
router.post('/:id/upload-zip', upload.single('file'), async (req, res) => {
  if (!(await requireEditor(req.params.id, req.session.userId, res))) return;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();
    const created = [];
    const binaryExts = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.ico', '.eps', '.ps', '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.class', '.jar', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.avi', '.mov', '.wav', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);

    // Validate entry count and total size
    const fileEntries = entries.filter(e => !e.isDirectory);
    if (fileEntries.length > MAX_ZIP_ENTRIES) {
      return res.status(400).json({ error: `ZIP contains too many files (${fileEntries.length}, max ${MAX_ZIP_ENTRIES})` });
    }
    const totalDecompressed = fileEntries.reduce((sum, e) => sum + (e.header.size || 0), 0);
    if (totalDecompressed > MAX_ZIP_TOTAL_SIZE) {
      return res.status(400).json({ error: `ZIP decompressed size too large (${Math.round(totalDecompressed / 1024 / 1024)}MB, max ${MAX_ZIP_TOTAL_SIZE / 1024 / 1024}MB)` });
    }

    await db.transaction(async (tx) => {
      let actualTotal = 0;
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        let entryPath = entry.entryName;
        if (entryPath.startsWith('__MACOSX/') || entryPath.split('/').some(p => p.startsWith('.'))) continue;
        if (entryPath.includes('..')) continue;
        if (!isValidFilePath(entryPath)) continue;

        // Validate individual file size
        if (entry.header.size > MAX_ZIP_ENTRY_SIZE) continue;

        const ext = entryPath.substring(entryPath.lastIndexOf('.')).toLowerCase();
        const isBinary = binaryExts.has(ext);
        const rawData = entry.getData();
        actualTotal += rawData.length;
        if (rawData.length > MAX_ZIP_ENTRY_SIZE || actualTotal > MAX_ZIP_TOTAL_SIZE) continue;
        const content = isBinary ? rawData.toString('base64') : rawData.toString('utf8');

        const existing = await tx.get(
          'SELECT id FROM files WHERE project_id = $1 AND path = $2',
          [req.params.id, entryPath]
        );
        if (existing) {
          await tx.run(
            'UPDATE files SET content = $1, is_binary = $2, updated_at = NOW() WHERE id = $3',
            [content, isBinary, existing.id]
          );
          created.push({ id: existing.id, path: entryPath, updated: true });
        } else {
          const id = uuid();
          await tx.run(
            'INSERT INTO files (id, project_id, path, content, is_binary) VALUES ($1, $2, $3, $4, $5)',
            [id, req.params.id, entryPath, content, isBinary]
          );
          created.push({ id, path: entryPath, updated: false });
        }
      }
      await tx.run('UPDATE projects SET updated_at = NOW() WHERE id = $1', [req.params.id]);
    });

    // If all files share a common prefix folder, strip it
    if (created.length > 1) {
      const firstSlash = created[0].path.indexOf('/');
      if (firstSlash > 0) {
        const prefix = created[0].path.substring(0, firstSlash + 1);
        if (created.every(f => f.path.startsWith(prefix))) {
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
      }
    }

    const files = await db.all('SELECT * FROM files WHERE project_id = $1 ORDER BY path', [req.params.id]);
    res.json({ ok: true, files, created: created.length });
  } catch (err) {
    logger.error({ err }, 'ZIP upload error');
    res.status(400).json({ error: 'Failed to extract ZIP file' });
  }
});

// Get project files
// Serve raw file content (for binary file preview)
router.get('/files/:fileId/raw', async (req, res) => {
  const file = await db.get('SELECT f.*, pm.user_id FROM files f JOIN project_members pm ON f.project_id = pm.project_id WHERE f.id = $1 AND pm.user_id = $2', [req.params.fileId, req.session.userId]);
  if (!file) return res.status(404).json({ error: 'File not found' });
  const ext = (file.path || '').split('.').pop().toLowerCase();
  const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', ico: 'image/x-icon', webp: 'image/webp', pdf: 'application/pdf', eps: 'application/postscript' };
  // SVG can contain scripts — serve as attachment or plain text to prevent XSS
  const mime = ext === 'svg' ? 'image/svg+xml' : (mimeMap[ext] || 'application/octet-stream');
  const isSvg = ext === 'svg';
  if (file.is_binary) {
    const buf = Buffer.from(file.content, 'base64');
    res.set('Content-Type', mime);
    res.set('Content-Disposition', isSvg ? 'attachment' : 'inline');
    if (isSvg) res.set('Content-Security-Policy', "sandbox; default-src 'none'");
    res.set('Content-Length', buf.length);
    res.send(buf);
  } else {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(file.content || '');
  }
});

router.get('/:id/files', async (req, res) => {
  if (!(await requireMembership(req.params.id, req.session.userId, res))) return;
  const files = await db.all('SELECT * FROM files WHERE project_id = $1 ORDER BY path', [req.params.id]);
  res.json(files);
});

// Create a file in a project
router.post('/:id/files', async (req, res) => {
  if (!(await requireEditor(req.params.id, req.session.userId, res))) return;
  const { path: filePath, content } = req.body;
  if (!isValidFilePath(filePath)) return res.status(400).json({ error: 'Invalid file path' });
  if (content && content.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'File too large (max 10MB)' });
  const existing = await db.get(
    'SELECT id FROM files WHERE project_id = $1 AND path = $2',
    [req.params.id, filePath]
  );
  if (existing) return res.status(409).json({ error: 'A file with that name already exists' });
  const id = uuid();
  await db.run(
    'INSERT INTO files (id, project_id, path, content) VALUES ($1, $2, $3, $4)',
    [id, req.params.id, filePath, content || '']
  );
  await db.run('UPDATE projects SET updated_at = NOW() WHERE id = $1', [req.params.id]);
  res.json({ id, project_id: req.params.id, path: filePath, content: content || '' });
});

// Update file content
router.put('/files/:fileId', async (req, res) => {
  const { content } = req.body;
  if (content && content.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'File too large (max 10MB)' });

  const result = await requireFileAccess(req.params.fileId, req.session.userId, res, { edit: true });
  if (!result) return;
  const { file } = result;

  // Skip save if content hasn't changed
  if (file.content === content) return res.json({ ok: true });

  const user = req.session?.userId
    ? await db.get('SELECT id, name FROM users WHERE id = $1', [req.session.userId])
    : null;
  const authorId = user?.id || null;
  const authorName = user?.name || 'Unknown';

  let newSnapshot = false;

  await db.transaction(async (tx) => {
    // Save the file content
    await tx.run('UPDATE files SET content = $1, updated_at = NOW() WHERE id = $2', [content, file.id]);
    await tx.run('UPDATE projects SET updated_at = NOW() WHERE id = $1', [file.project_id]);

    // Check if we should create a project-wide snapshot
    const proj = await tx.get('SELECT snapshot_interval_sec FROM projects WHERE id = $1', [file.project_id]);
    const intervalSec = proj?.snapshot_interval_sec || 30;

    const latestSnap = await tx.get(
      'SELECT id, created_at FROM project_snapshots WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
      [file.project_id]
    );

    const elapsed = latestSnap ? (Date.now() - new Date(latestSnap.created_at).getTime()) / 1000 : Infinity;

    if (elapsed >= intervalSec) {
      // Gather all files in the project (with the just-saved content already in place)
      const allFiles = await tx.all(
        'SELECT id, path, content, is_binary FROM files WHERE project_id = $1 ORDER BY path',
        [file.project_id]
      );

      const payload = JSON.stringify({ files: allFiles });
      const compressed = gzipSync(Buffer.from(payload, 'utf8'));

      await tx.run(
        'INSERT INTO project_snapshots (id, project_id, data, author_id, author_name) VALUES ($1, $2, $3, $4, $5)',
        [uuid(), file.project_id, compressed, authorId, authorName]
      );
      newSnapshot = true;
    }
  });

  // Broadcast to all users in the project so their history panel updates
  if (newSnapshot) {
    const broadcast = req.app.locals.broadcastToRoom;
    if (broadcast) {
      broadcast(file.project_id, { type: 'history_update', authorName });
    }
  }

  res.json({ ok: true });
});

// Rename a file
router.patch('/files/:fileId', async (req, res) => {
  const { path: newPath } = req.body;
  if (!newPath) return res.status(400).json({ error: 'path required' });
  if (!isValidFilePath(newPath)) return res.status(400).json({ error: 'Invalid file path' });

  const result = await requireFileAccess(req.params.fileId, req.session.userId, res, { edit: true });
  if (!result) return;

  await db.run('UPDATE files SET path = $1, updated_at = NOW() WHERE id = $2', [newPath, req.params.fileId]);
  const file = await db.get('SELECT * FROM files WHERE id = $1', [req.params.fileId]);
  if (file) {
    await db.run('UPDATE projects SET updated_at = NOW() WHERE id = $1', [file.project_id]);
  }
  res.json(file || { ok: true });
});

// Delete a file
router.delete('/files/:fileId', async (req, res) => {
  const result = await requireFileAccess(req.params.fileId, req.session.userId, res, { edit: true });
  if (!result) return;

  await db.run('DELETE FROM files WHERE id = $1', [req.params.fileId]);
  res.json({ ok: true });
});

// Archive / unarchive a project (owner only)
router.post('/:id/archive', async (req, res) => {
  if (!(await requireOwnership(req.params.id, req.session.userId, res))) return;
  await db.run('UPDATE projects SET archived = TRUE WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

router.post('/:id/unarchive', async (req, res) => {
  if (!(await requireOwnership(req.params.id, req.session.userId, res))) return;
  await db.run('UPDATE projects SET archived = FALSE WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Trash / restore a project (owner only)
router.post('/:id/trash', async (req, res) => {
  if (!(await requireOwnership(req.params.id, req.session.userId, res))) return;
  await db.run('UPDATE projects SET trashed = TRUE WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

router.post('/:id/restore', async (req, res) => {
  if (!(await requireOwnership(req.params.id, req.session.userId, res))) return;
  await db.run('UPDATE projects SET trashed = FALSE WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Copy a project
router.post('/:id/copy', async (req, res) => {
  const member = await requireMembership(req.params.id, req.session.userId, res);
  if (!member) return;

  const source = await db.get('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  if (!source) return res.status(404).json({ error: 'Project not found' });

  const newId = uuid();
  const newName = (req.body.name || source.name + ' (Copy)').slice(0, 200);

  const files = await db.all('SELECT path, content, is_binary FROM files WHERE project_id = $1', [req.params.id]);

  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO projects (id, name, main_file) VALUES ($1, $2, $3)', [newId, newName, source.main_file]);
    await tx.run('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [newId, req.session.userId, 'owner']);
    for (const file of files) {
      await tx.run(
        'INSERT INTO files (id, project_id, path, content, is_binary) VALUES ($1, $2, $3, $4, $5)',
        [uuid(), newId, file.path, file.content, file.is_binary]
      );
    }
  });

  const project = await db.get('SELECT * FROM projects WHERE id = $1', [newId]);
  res.json(project);
});

// Tag a project
router.post('/:id/tags/:tagId', async (req, res) => {
  const member = await requireMembership(req.params.id, req.session.userId, res);
  if (!member) return;
  try {
    await db.run(
      'INSERT INTO project_tags (project_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, req.params.tagId]
    );
  } catch (e) {}
  res.json({ ok: true });
});

router.delete('/:id/tags/:tagId', async (req, res) => {
  const member = await requireMembership(req.params.id, req.session.userId, res);
  if (!member) return;
  await db.run('DELETE FROM project_tags WHERE project_id = $1 AND tag_id = $2', [req.params.id, req.params.tagId]);
  res.json({ ok: true });
});

export default router;
