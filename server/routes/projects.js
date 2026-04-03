import { Router } from 'express';
import archiver from 'archiver';
import multer from 'multer';
import db from '../db.js';
import logger from '../logger.js';
import { auditLog } from '../utils/audit.js';
import { sendProjectInvitationEmail } from '../utils/email.js';
import * as projectService from '../services/projectService.js';
import { sendError } from '../middleware/errorHandler.js';
import { requireAdmin } from '../middleware/auth.js';
import { resolveUsedFiles } from '../../shared/texDeps.js';
// TEMPLATES no longer imported here — all templates are in the DB

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const router = Router();

async function requireMembership(req, res) {
  const member = await projectService.checkMembership(req.params.id, req.session.userId);
  if (!member) {
    res.status(403).json({ error: 'No access to this project' });
    return null;
  }
  return member;
}

async function requireEditor(req, res) {
  const result = await projectService.checkEditor(req.params.id, req.session.userId);
  if (result.error) {
    res.status(result.status).json({ error: result.error });
    return null;
  }
  return result.member;
}

async function requireOwner(req, res) {
  const result = await projectService.checkOwnership(req.params.id, req.session.userId);
  if (result.error) {
    res.status(result.status).json({ error: result.error });
    return null;
  }
  return result.member;
}

// List projects
router.get('/', async (req, res) => {
  res.json(await projectService.listUserProjects(req.session.userId));
});

// Create a project
router.post('/', async (req, res) => {
  const project = await projectService.createProject(req.session.userId, req.body.name);
  await auditLog(req.session.userId, 'project_create', { targetType: 'project', targetId: project.id, ip: req.ip });
  res.json(project);
});

// --- Template tags ---

router.get('/template-tags', async (req, res) => {
  res.json(await projectService.listTemplateTags());
});

router.post('/template-tags', requireAdmin, async (req, res) => {
  try {
    const tag = await projectService.createTemplateTag(req.body.name, req.body.color);
    res.json(tag);
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/template-tags/:tagId', requireAdmin, async (req, res) => {
  try {
    const tag = await projectService.updateTemplateTag(req.params.tagId, req.body.name, req.body.color);
    res.json(tag);
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/template-tags/:tagId', requireAdmin, async (req, res) => {
  try {
    await projectService.deleteTemplateTag(req.params.tagId);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// List available templates (built-in + user-uploaded)
router.get('/templates', async (req, res) => {
  res.json(await projectService.listAllTemplates());
});

// Create project from template
router.post('/from-template', async (req, res) => {
  const { templateId, name } = req.body;
  if (!templateId) return res.status(400).json({ error: 'templateId required' });
  try {
    const project = await projectService.createProjectFromTemplate(req.session.userId, templateId, name);
    await auditLog(req.session.userId, 'project_create', {
      targetType: 'project',
      targetId: project.id,
      detail: `template:${templateId}`,
      ip: req.ip,
    });
    res.json(project);
  } catch (err) {
    sendError(res, err);
  }
});

// Upload a user template from ZIP
router.post('/templates/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { name, description, category } = req.body;
    let tagIds = [];
    if (req.body.tagIds) {
      try {
        tagIds = JSON.parse(req.body.tagIds);
      } catch {
        return res.status(400).json({ error: 'Invalid tagIds format' });
      }
      if (!Array.isArray(tagIds)) return res.status(400).json({ error: 'tagIds must be an array' });
    }
    const tmpl = await projectService.createTemplateFromZip(
      req.session.userId,
      req.file.buffer,
      name || req.file.originalname,
      description,
      category,
      tagIds,
    );
    await auditLog(req.session.userId, 'template_upload', { targetType: 'template', targetId: tmpl.id, ip: req.ip });
    res.json(tmpl);
  } catch (err) {
    logger.error({ err }, 'Template upload error');
    res.status(400).json({ error: err.message || 'Failed to upload template' });
  }
});

// Delete a user template
router.delete('/templates/:templateId', async (req, res) => {
  try {
    await projectService.deleteUserTemplate(req.params.templateId, req.session.userId);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Update tags on a template (admin only)
router.put('/templates/:templateId/tags', requireAdmin, async (req, res) => {
  try {
    const { tagIds } = req.body;
    if (!Array.isArray(tagIds)) return res.status(400).json({ error: 'tagIds must be an array' });
    if (tagIds.length > 20) return res.status(400).json({ error: 'Too many tags (max 20)' });
    const tmpl = await db.get('SELECT * FROM user_templates WHERE id = $1', [req.params.templateId]);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });
    // Validate each tagId is a valid UUID
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const id of tagIds) {
      if (typeof id !== 'string' || !uuidRe.test(id)) {
        return res.status(400).json({ error: 'Invalid tag ID' });
      }
    }
    await projectService.setTemplateTags(req.params.templateId, tagIds);
    const tags = tagIds.length
      ? await db.all('SELECT id, name, color FROM template_tags WHERE id = ANY($1)', [tagIds])
      : [];
    res.json(tags);
  } catch (err) {
    sendError(res, err);
  }
});

// Create project from ZIP upload
router.post('/from-zip', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    res.json(await projectService.createProjectFromZip(req.session.userId, req.file.buffer, req.file.originalname));
  } catch (err) {
    logger.error({ err }, 'ZIP project creation error');
    res.status(400).json({ error: err.message || 'Failed to create project from ZIP file' });
  }
});

// --- Invitations (must be before /:id routes) ---
router.get('/invitations/mine', async (req, res) => {
  res.json(await projectService.getMyInvitations(req.session.userId));
});

router.post('/invitations/:inviteId/accept', async (req, res) => {
  try {
    res.json(await projectService.acceptInvitation(req.params.inviteId, req.session.userId));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/invitations/:inviteId/decline', async (req, res) => {
  try {
    await projectService.declineInvitation(req.params.inviteId, req.session.userId);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Project operations ---
router.patch('/:id', async (req, res) => {
  const member = await requireMembership(req, res);
  if (!member) return;
  if (member.role !== 'owner') return res.status(403).json({ error: 'Only the owner can modify project settings' });
  const { name, main_file, snapshot_interval_sec, tex_distribution, compiler } = req.body;
  if (!name && !main_file && snapshot_interval_sec == null && tex_distribution === undefined && compiler === undefined)
    return res.status(400).json({ error: 'Nothing to update' });
  try {
    const updated = await projectService.updateProject(req.params.id, {
      name,
      main_file,
      snapshot_interval_sec,
      tex_distribution,
      compiler,
    });
    await auditLog(req.session.userId, 'project_update', {
      targetType: 'project',
      targetId: req.params.id,
      ip: req.ip,
    });
    res.json(updated);
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/:id', async (req, res) => {
  const member = await requireMembership(req, res);
  if (!member) return;
  if (member.role === 'owner') {
    await projectService.deleteProject(req.params.id);
    await auditLog(req.session.userId, 'project_delete', {
      targetType: 'project',
      targetId: req.params.id,
      ip: req.ip,
    });
  } else {
    await projectService.removeMember(req.params.id, req.session.userId);
    await auditLog(req.session.userId, 'project_leave', { targetType: 'project', targetId: req.params.id, ip: req.ip });
  }
  res.json({ ok: true });
});

// --- Members ---
router.get('/:id/members', async (req, res) => {
  if (!(await requireMembership(req, res))) return;
  res.json(await projectService.getProjectMembers(req.params.id));
});

router.post('/:id/members', async (req, res) => {
  const { email, role } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Invalid email address' });
  if (!(await requireOwner(req, res))) return;
  try {
    const invitation = await projectService.inviteMember(req.params.id, email, role, req.session.userId);
    // Fetch shared data once
    const inviterName =
      req.session.userName ||
      (await db.get('SELECT name FROM users WHERE id = $1', [req.session.userId]))?.name ||
      'Someone';
    const project = await db.get('SELECT name FROM projects WHERE id = $1', [req.params.id]);
    const projectName = project?.name || 'a project';
    try {
      await sendProjectInvitationEmail(email, {
        inviterName,
        projectName,
        baseUrl: `${req.protocol}://${req.get('host')}`,
      });
    } catch (err) {
      logger.warn({ err, email }, 'Failed to send invitation email');
    }
    // Push invitation to invitee in real-time via WebSocket
    try {
      const invitee = await db.get('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
      if (invitee && req.app.locals.sendToUser) {
        req.app.locals.sendToUser(invitee.id, {
          type: 'invitation',
          invitation: {
            id: invitation.id,
            project_id: req.params.id,
            project_name: projectName,
            inviter_name: inviterName,
            role: invitation.role,
            status: 'pending',
            created_at: new Date().toISOString(),
          },
        });
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to push invitation via WS');
    }
    await auditLog(req.session.userId, 'member_invite', {
      targetType: 'project',
      targetId: req.params.id,
      detail: JSON.stringify({ email, role: role || 'editor' }),
      ip: req.ip,
    });
    res.json(invitation);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:id/invitations', async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  res.json(await projectService.getProjectInvitations(req.params.id));
});

router.delete('/:id/invitations/:inviteId', async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  await projectService.cancelInvitation(req.params.inviteId, req.params.id);
  res.json({ ok: true });
});

router.delete('/:id/members/:userId', async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  if (req.params.userId === req.session.userId) return res.status(400).json({ error: 'Cannot remove yourself' });
  await projectService.removeMember(req.params.id, req.params.userId);
  req.app.locals.disconnectUserFromProject?.(req.params.id, req.params.userId);
  await auditLog(req.session.userId, 'member_remove', {
    targetType: 'project',
    targetId: req.params.id,
    detail: req.params.userId,
    ip: req.ip,
  });
  res.json({ ok: true });
});

// --- ZIP download/upload ---
router.get('/:id/zip', async (req, res) => {
  if (!(await requireMembership(req, res))) return;
  const project = await db.get('SELECT name FROM projects WHERE id = $1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const files = await db.all('SELECT path, content, is_binary FROM files WHERE project_id = $1', [req.params.id]);
  const zipName = (project.name || 'project').replace(/[^a-zA-Z0-9_-]/g, '_') + '.zip';
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${zipName}"`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  for (const f of files) archive.append(f.is_binary ? Buffer.from(f.content, 'base64') : f.content, { name: f.path });
  archive.finalize();
});

router.get('/:id/zip-used', async (req, res) => {
  if (!(await requireMembership(req, res))) return;
  const project = await db.get('SELECT name, main_file FROM projects WHERE id = $1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const files = await db.all('SELECT path, content, is_binary FROM files WHERE project_id = $1', [req.params.id]);
  const mainFile = project.main_file || 'main.tex';
  const usedPaths = resolveUsedFiles(files, mainFile);
  const usedFiles = files.filter((f) => usedPaths.has(f.path));
  const zipName = (project.name || 'project').replace(/[^a-zA-Z0-9_-]/g, '_') + '.zip';
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${zipName}"`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  for (const f of usedFiles)
    archive.append(f.is_binary ? Buffer.from(f.content, 'base64') : f.content, { name: f.path });
  archive.finalize();
});

router.post('/:id/upload-zip', upload.single('file'), async (req, res) => {
  if (!(await requireEditor(req, res))) return;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const result = await projectService.uploadZipToProject(req.params.id, req.file.buffer);
    res.json({ ok: true, files: result.files, created: result.created });
  } catch (err) {
    logger.error({ err }, 'ZIP upload error');
    res.status(400).json({ error: err.message || 'Failed to extract ZIP file' });
  }
});

// --- Raw file serving ---
router.get('/files/:fileId/raw', async (req, res) => {
  const file = await projectService.getRawFile(req.params.fileId, req.session.userId);
  if (!file) return res.status(404).json({ error: 'File not found' });
  const ext = (file.path || '').split('.').pop().toLowerCase();
  const mimeMap = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    webp: 'image/webp',
    pdf: 'application/pdf',
    eps: 'application/postscript',
  };
  const mime = ext === 'svg' ? 'image/svg+xml' : mimeMap[ext] || 'application/octet-stream';
  if (file.is_binary) {
    const buf = Buffer.from(file.content, 'base64');
    res.set('Content-Type', mime);
    // Force download for SVG (prevents inline script execution); inline for others
    res.set('Content-Disposition', ext === 'svg' ? 'attachment' : 'inline');
    // Sandbox all user-uploaded binary content to prevent embedded scripts
    res.set('Content-Security-Policy', "sandbox; default-src 'none'");
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Length', buf.length);
    res.send(buf);
  } else {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(file.content || '');
  }
});

// --- File CRUD ---
router.get('/:id/files', async (req, res) => {
  if (!(await requireMembership(req, res))) return;
  res.json(await projectService.getProjectFiles(req.params.id));
});

router.post('/:id/files', async (req, res) => {
  if (!(await requireEditor(req, res))) return;
  try {
    res.json(await projectService.createFile(req.params.id, req.body.path, req.body.content));
  } catch (err) {
    sendError(res, err);
  }
});

// Upload a single binary file (drag-and-drop)
router.post('/:id/upload-file', upload.single('file'), async (req, res) => {
  if (!(await requireEditor(req, res))) return;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const filePath = req.body.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const result = await projectService.uploadBinaryFile(req.params.id, filePath, req.file.buffer);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/files/:fileId', async (req, res) => {
  const { content, tcPositions } = req.body;
  if (content && content.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'File too large (max 10MB)' });
  const access = await projectService.getFileWithAccess(req.params.fileId, req.session.userId, { edit: true });
  if (access.error) return res.status(access.status).json({ error: access.error });
  const result = await projectService.updateFileContent(req.params.fileId, content, req.session.userId, tcPositions);
  if (result.newSnapshot) {
    req.app.locals.broadcastToRoom?.(result.projectId, { type: 'history_update', authorName: result.authorName });
  }
  res.json({ ok: true });
});

router.patch('/files/:fileId', async (req, res) => {
  if (!req.body.path) return res.status(400).json({ error: 'path required' });
  const access = await projectService.getFileWithAccess(req.params.fileId, req.session.userId, { edit: true });
  if (access.error) return res.status(access.status).json({ error: access.error });
  try {
    res.json((await projectService.renameFile(req.params.fileId, req.body.path)) || { ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/files/:fileId', async (req, res) => {
  const access = await projectService.getFileWithAccess(req.params.fileId, req.session.userId, { edit: true });
  if (access.error) return res.status(access.status).json({ error: access.error });
  await projectService.deleteFile(req.params.fileId);
  res.json({ ok: true });
});

// --- Archive / Trash ---
// Non-owners: archive/trash/delete = leave project (remove membership)
router.post('/:id/archive', async (req, res) => {
  const member = await requireMembership(req, res);
  if (!member) return;
  if (member.role === 'owner') {
    await projectService.archiveProject(req.params.id);
    await auditLog(req.session.userId, 'project_archive', {
      targetType: 'project',
      targetId: req.params.id,
      ip: req.ip,
    });
  } else {
    await projectService.removeMember(req.params.id, req.session.userId);
    await auditLog(req.session.userId, 'project_leave', { targetType: 'project', targetId: req.params.id, ip: req.ip });
  }
  res.json({ ok: true });
});
router.post('/:id/unarchive', async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  await projectService.unarchiveProject(req.params.id);
  await auditLog(req.session.userId, 'project_unarchive', {
    targetType: 'project',
    targetId: req.params.id,
    ip: req.ip,
  });
  res.json({ ok: true });
});
router.post('/:id/trash', async (req, res) => {
  const member = await requireMembership(req, res);
  if (!member) return;
  if (member.role === 'owner') {
    await projectService.trashProject(req.params.id);
    await auditLog(req.session.userId, 'project_trash', { targetType: 'project', targetId: req.params.id, ip: req.ip });
  } else {
    await projectService.removeMember(req.params.id, req.session.userId);
    await auditLog(req.session.userId, 'project_leave', { targetType: 'project', targetId: req.params.id, ip: req.ip });
  }
  res.json({ ok: true });
});
router.post('/:id/restore', async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  await projectService.restoreProject(req.params.id);
  await auditLog(req.session.userId, 'project_restore', { targetType: 'project', targetId: req.params.id, ip: req.ip });
  res.json({ ok: true });
});

// --- Copy ---
router.post('/:id/copy', async (req, res) => {
  if (!(await requireMembership(req, res))) return;
  try {
    res.json(await projectService.copyProject(req.params.id, req.session.userId, req.body.name));
  } catch (err) {
    sendError(res, err);
  }
});

// --- Tags ---
router.post('/:id/tags/:tagId', async (req, res) => {
  if (!(await requireMembership(req, res))) return;
  try {
    await db.run('INSERT INTO project_tags (project_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      req.params.id,
      req.params.tagId,
    ]);
  } catch {}
  res.json({ ok: true });
});

router.delete('/:id/tags/:tagId', async (req, res) => {
  if (!(await requireMembership(req, res))) return;
  await db.run('DELETE FROM project_tags WHERE project_id = $1 AND tag_id = $2', [req.params.id, req.params.tagId]);
  res.json({ ok: true });
});

// --- Global search across project files ---
router.get('/:id/search', async (req, res) => {
  if (!(await requireMembership(req, res))) return;
  try {
    const q = (req.query.q || '').trim();
    const scope = req.query.scope || 'all';
    const cs = req.query.cs === '1';
    if (!q) return res.json([]);

    const files = await db.all('SELECT id, path, content FROM files WHERE project_id = $1 AND is_binary = false', [
      req.params.id,
    ]);

    const results = [];
    const searchStr = cs ? q : q.toLowerCase();

    for (const file of files) {
      if (scope === 'tex' && !file.path.endsWith('.tex')) continue;
      if (!file.content) continue;

      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const haystack = cs ? line : line.toLowerCase();
        let pos = 0;
        while (pos < haystack.length) {
          const idx = haystack.indexOf(searchStr, pos);
          if (idx === -1) break;
          results.push({ fileId: file.id, filePath: file.path, line: i + 1, col: idx, text: line.trim() });
          pos = idx + 1;
          if (results.length >= 500) break;
        }
        if (results.length >= 500) break;
      }
      if (results.length >= 500) break;
    }

    res.json(results);
  } catch (err) {
    logger.error({ err }, 'Project search error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
