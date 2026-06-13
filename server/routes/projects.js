// @ts-check
import { Router } from 'express';
// archiver + multer ship no .d.ts and we deliberately don't pull in
// @types/* for them -- the duplicate @types/express-serve-static-core
// they transitively install collides with our existing one. ts-ignore
// the imports; runtime behaviour is unaffected.
// @ts-ignore
import { ZipArchive } from 'archiver';
// @ts-ignore
import multer from 'multer';
import db from '../db.js';
import logger from '../logger.js';
import { auditLog } from '../utils/audit.js';
import { sendProjectInvitationEmail, sendUnregisteredInvitationEmail } from '../utils/email.js';
import * as projectService from '../services/projectService.js';
import * as encryptionService from '../services/encryptionService.js';
import { isProjectUnlocked } from '../services/projectKeyCache.js';
import { decryptRowsForRead } from '../services/projectContentCrypto.js';
import { statBlob, readBlobStream } from '../services/blobPersistor.js';
import { loadFileBytes } from '../services/fileBytes.js';
import { sendError } from '../middleware/errorHandler.js';
import { requireAdmin } from '../middleware/auth.js';
import { resolveUsedFiles } from '../../shared/texDeps.js';
import { isLocalCompileEnabled } from '../utils/featureFlags.js';
// TEMPLATES no longer imported here — all templates are in the DB

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const router = Router();

/** Verify the current user is a member of the project in req.params.id. Returns the member or null. */
/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function requireMembership(req, res) {
  const member = await projectService.checkMembership(req.params.id, req.session.userId);
  if (!member) {
    res.status(403).json({ error: 'No access to this project' });
    return null;
  }
  return member;
}

/** Verify the current user has editor (or owner) access to the project. Returns the member or null. */
/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function requireEditor(req, res) {
  const result = await projectService.checkEditor(req.params.id, req.session.userId);
  if (result.error) {
    res.status(result.status).json({ error: result.error });
    return null;
  }
  return result.member;
}

/** Verify the current user is the owner of the project. Returns the member or null. */
/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function requireOwner(req, res) {
  const result = await projectService.checkOwnership(req.params.id, req.session.userId);
  if (result.error) {
    res.status(result.status).json({ error: result.error });
    return null;
  }
  return result.member;
}

/** GET /api/projects -- List all projects the current user is a member of. */
router.get('/', async (req, res) => {
  res.json(await projectService.listUserProjects(req.session.userId));
});

/** POST /api/projects -- Create a new empty project. */
router.post('/', async (req, res) => {
  const project = await projectService.createProject(req.session.userId, req.body.name);
  await auditLog(req.session.userId, 'project_create', { targetType: 'project', targetId: project.id, ip: req.ip });
  res.json(project);
});

// --- Template tags ---

/** GET /api/projects/template-tags -- List all template tags. */
router.get('/template-tags', async (req, res) => {
  res.json(await projectService.listTemplateTags());
});

/** POST /api/projects/template-tags -- Create a new template tag (admin only). */
router.post('/template-tags', requireAdmin, async (req, res) => {
  try {
    const tag = await projectService.createTemplateTag(req.body.name, req.body.color);
    res.json(tag);
  } catch (err) {
    sendError(res, err);
  }
});

/** PUT /api/projects/template-tags/:tagId -- Update a template tag (admin only). */
router.put('/template-tags/:tagId', requireAdmin, async (req, res) => {
  try {
    const tag = await projectService.updateTemplateTag(req.params.tagId, req.body.name, req.body.color);
    res.json(tag);
  } catch (err) {
    sendError(res, err);
  }
});

/** DELETE /api/projects/template-tags/:tagId -- Delete a template tag (admin only). */
router.delete('/template-tags/:tagId', requireAdmin, async (req, res) => {
  try {
    await projectService.deleteTemplateTag(req.params.tagId);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

/** GET /api/projects/templates -- List all available project templates. */
router.get('/templates', async (req, res) => {
  res.json(await projectService.listAllTemplates());
});

/** POST /api/projects/from-template -- Create a new project from a template. */
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

/** POST /api/projects/templates/upload -- Upload a new project template from a ZIP file (admin only). */
router.post('/templates/upload', requireAdmin, upload.single('file'), async (req, res) => {
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
    const msg = err instanceof Error ? err.message : 'Failed to upload template';
    res.status(400).json({ error: msg });
  }
});

/** DELETE /api/projects/templates/:templateId -- Delete a user-uploaded template. */
router.delete('/templates/:templateId', async (req, res) => {
  try {
    await projectService.deleteUserTemplate(req.params.templateId, req.session.userId);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

/** PUT /api/projects/templates/:templateId/tags -- Set tags on a template (admin only). */
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

/** POST /api/projects/from-zip -- Create a new project by uploading a ZIP file. */
router.post('/from-zip', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    res.json(await projectService.createProjectFromZip(req.session.userId, req.file.buffer, req.file.originalname));
  } catch (err) {
    logger.error({ err }, 'ZIP project creation error');
    const msg = err instanceof Error ? err.message : 'Failed to create project from ZIP file';
    res.status(400).json({ error: msg });
  }
});

/** POST /api/projects/from-docx -- Create a new project by importing a .docx file.
 *  Streams SSE progress events, then a final 'result' or 'error' event. */
router.post('/from-docx', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Set up SSE stream for progress updates
  // Disable compression for this response so events flush immediately
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  /** @param {object} data */
  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    // compression middleware exposes res.flush so SSE events
    // arrive at the client immediately rather than waiting for the
    // response buffer. Not on the standard Response type, so we
    // narrow at the access point.
    const flush = /** @type {(() => void) | undefined} */ (/** @type {any} */ (res).flush);
    if (typeof flush === 'function') flush();
  };

  // Track client disconnect so we can abort long-running conversions
  const abortController = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abortController.abort(); });

  try {
    /** @type {{ docType?: string, signal: AbortSignal, onProgress: (m: string, p: number) => void }} */
    const options = {
      signal: abortController.signal,
      onProgress: (/** @type {string} */ message, /** @type {number} */ percent) => {
        sendEvent({ type: 'progress', message, percent });
      },
    };
    // typeof guard: req.body is parsed JSON, so docType could be an object
    // or array if the caller is hostile; the converter expects a short
    // string ('thesis', 'article', etc.).
    if (typeof req.body.docType === 'string' && req.body.docType.length <= 64) {
      options.docType = req.body.docType;
    }
    const result = await projectService.createProjectFromDocx(req.session.userId, req.file.buffer, req.file.originalname, options);
    sendEvent({ type: 'result', ...result });
    res.end();
  } catch (err) {
    if (abortController.signal.aborted) { res.end(); return; }
    logger.error({ err }, 'DOCX import error');
    const msg = err instanceof Error ? err.message : 'Failed to import DOCX file';
    sendEvent({ type: 'error', error: msg });
    res.end();
  }
});

/** GET /api/projects/invitations/mine -- List pending invitations for the current user. */
router.get('/invitations/mine', async (req, res) => {
  res.json(await projectService.getMyInvitations(req.session.userId));
});

/** POST /api/projects/invitations/:inviteId/accept -- Accept a project invitation. */
router.post('/invitations/:inviteId/accept', async (req, res) => {
  try {
    const result = await projectService.acceptInvitation(req.params.inviteId, req.session.userId);
    // Tell anyone already in the project room that the membership list
    // changed, so their @-mention autocomplete and avatar list refresh
    // without a page reload.
    if (result?.projectId) {
      req.app.locals.broadcastToRoom?.(result.projectId, { type: 'members-update' });
    }
    res.json(result);
  } catch (err) {
    const e = /** @type {{ emailMismatch?: boolean }} */ (err && typeof err === 'object' ? err : {});
    if (e.emailMismatch) {
      // Someone authenticated tried to accept an invitation addressed to a
      // different email. Inviteids are unguessable UUIDs, so reaching one
      // implies the link leaked (or was forwarded). Record it.
      await auditLog(req.session.userId, 'invitation_accept_email_mismatch', {
        targetType: 'invitation',
        targetId: req.params.inviteId,
        ip: req.ip,
      });
    }
    sendError(res, err);
  }
});

/** POST /api/projects/invitations/:inviteId/decline -- Decline a project invitation. */
router.post('/invitations/:inviteId/decline', async (req, res) => {
  try {
    await projectService.declineInvitation(req.params.inviteId, req.session.userId);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

/** PATCH /api/projects/:id -- Update project settings.
 *
 *  Build / compile settings (main_file, tex_distribution, compiler) are
 *  open to ANY project member — they are shared compile-target choices
 *  that any collaborator routinely needs to flip while working. Name and
 *  snapshot interval stay owner-only because they are administrative
 *  (renaming changes how the project appears to everyone, snapshot
 *  interval affects history storage costs). */
router.patch('/:id', async (req, res) => {
  const member = await requireMembership(req, res);
  if (!member) return;
  const { name, main_file, snapshot_interval_sec, tex_distribution, compiler } = req.body;
  // compile_location is gated behind FEATURE_LOCAL_COMPILE. When the flag
  // is off the field is silently ignored — keeps legacy clients working
  // and prevents users from setting a preference that nothing reads yet.
  // Same role gate as the other compile-shared fields: any member, not
  // just the owner.
  const compileLocationProvided = isLocalCompileEnabled() && req.body.compile_location !== undefined;
  if (
    !name &&
    !main_file &&
    snapshot_interval_sec == null &&
    tex_distribution == null &&
    compiler == null &&
    !compileLocationProvided
  )
    return res.status(400).json({ error: 'Nothing to update' });
  const wantsOwnerOnlyChange = !!name || snapshot_interval_sec != null;
  if (wantsOwnerOnlyChange && member.role !== 'owner') {
    return res.status(403).json({ error: 'Only the owner can modify these settings' });
  }
  try {
    /** @type {{ name: any, main_file: any, snapshot_interval_sec: any, tex_distribution: any, compiler: any, compile_location?: any }} */
    const updates = {
      name,
      main_file,
      snapshot_interval_sec,
      tex_distribution,
      compiler,
    };
    if (compileLocationProvided) updates.compile_location = req.body.compile_location;
    const updated = await projectService.updateProject(req.params.id, /** @type {any} */ (updates));
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

/** DELETE /api/projects/:id -- Delete a project (owner) or leave it (non-owner). */
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

/** GET /api/projects/:id/members -- List all members of a project. */
router.get('/:id/members', async (req, res) => {
  const member = await requireMembership(req, res);
  if (!member) return;
  // Emails are owner-only. Editors / viewers see names + roles, not
  // addresses — otherwise any collaborator added to a project can
  // harvest the emails of every other collaborator.
  res.json(await projectService.getProjectMembers(req.params.id, {
    includeEmail: member.role === 'owner',
  }));
});

/** POST /api/projects/:id/members -- Invite a user to the project by email. */
router.post('/:id/members', async (req, res) => {
  const { email, role } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Invalid email address' });
  if (!(await requireOwner(req, res))) return;

  // APP_URL is a precondition for sending an invitation email at all
  // (see the Host-header rationale below). Check it BEFORE persisting
  // the invitation row -- otherwise every retry in a misconfigured
  // production silently burns a slot against the per-project membership
  // cap (50) while no emails ever go out.
  // Prefer APP_URL (set in .env) over the request's host header so a
  // forged Host: can't redirect the invite link to an attacker domain.
  // In production we refuse if APP_URL is unset: the fallback would
  // expose the link's host to whoever can spoof the Host header
  // (depends on the reverse-proxy config), and an invitation pointing
  // at an attacker domain is a phishing-grade brand impersonation even
  // before any auth flow runs on the recipient's side.
  const baseUrl = process.env.APP_URL;
  if (!baseUrl && process.env.NODE_ENV === 'production') {
    logger.error('Refusing to send invitation: APP_URL is not configured');
    return res.status(503).json({
      error: 'APP_URL is not configured on this server. Invitations cannot be sent until an administrator sets it.',
    });
  }
  const safeBaseUrl = baseUrl || `${req.protocol}://${req.get('host')}`;

  try {
    const invitation = await projectService.inviteMember(req.params.id, email, role, req.session.userId);
    // Fetch shared data once
    const inviterName =
      req.session.userName ||
      (await db.get('SELECT name FROM users WHERE id = $1', [req.session.userId]))?.name ||
      'Someone';
    const project = await db.get('SELECT name FROM projects WHERE id = $1', [req.params.id]);
    const projectName = project?.name || 'a project';

    // Email is a precondition: if SMTP fails, undo the invitation so the
    // recipient never sees an in-app banner without ever getting the email
    // link.
    try {
      if (invitation.recipientHasAccount) {
        // Existing user — they'll see the invitation on their dashboard
        // after sign-in. The link is just a deep entry point.
        await sendProjectInvitationEmail(email, {
          inviterName,
          projectName,
          baseUrl: safeBaseUrl,
          inviteUrl: `${safeBaseUrl}/?invite=${encodeURIComponent(invitation.id)}`,
        });
      } else {
        // Unregistered email — different template. The recipient needs
        // to create an account first. ?invite=<id> on the landing page
        // switches the AuthPage to register mode with the email
        // prefilled + a "you've been invited" banner. The decline link
        // is token-gated and lets them refuse without ever registering;
        // it routes through /api/projects/invitations/by-token/decline.
        const registerUrl = `${safeBaseUrl}/?invite=${encodeURIComponent(invitation.id)}`;
        const declineUrl = `${safeBaseUrl}/?invite-decline=${encodeURIComponent(invitation.declineToken || '')}`;
        await sendUnregisteredInvitationEmail(email, {
          inviterName,
          projectName,
          registerUrl,
          declineUrl,
        });
      }
    } catch (err) {
      logger.warn({ err, email, invitationId: invitation.id }, 'Failed to send invitation email; rolling back invitation');
      await db.run('DELETE FROM project_invitations WHERE id = $1', [invitation.id]).catch((dbErr) =>
        logger.error({ err: dbErr, invitationId: invitation.id }, 'Failed to roll back invitation after email failure'),
      );
      return res.status(502).json({ error: 'Failed to send invitation email — invitation was not created' });
    }

    // Email landed — now push the in-app banner over WebSocket so the
    // recipient sees the pending invitation immediately if they're online.
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

/** GET /api/projects/:id/invitations -- List pending invitations for a project (owner only). */
router.get('/:id/invitations', async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  res.json(await projectService.getProjectInvitations(req.params.id));
});

/** DELETE /api/projects/:id/invitations/:inviteId -- Cancel a pending invitation (owner only). */
router.delete('/:id/invitations/:inviteId', async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  await projectService.cancelInvitation(req.params.inviteId, req.params.id);
  res.json({ ok: true });
});

/** DELETE /api/projects/:id/members/:userId -- Remove a member from the project (owner only). */
router.delete('/:id/members/:userId', async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  if (req.params.userId === req.session.userId) return res.status(400).json({ error: 'Cannot remove yourself' });
  await projectService.removeMember(req.params.id, req.params.userId);
  req.app.locals.disconnectUserFromProject?.(req.params.id, req.params.userId);
  req.app.locals.broadcastToRoom?.(req.params.id, { type: 'members-update' });
  await auditLog(req.session.userId, 'member_remove', {
    targetType: 'project',
    targetId: req.params.id,
    detail: req.params.userId,
    ip: req.ip,
  });
  res.json({ ok: true });
});

// ── Per-project encryption ───────────────────────────────────────────
//
// Simple in-process rate limiter for unlock attempts (passphrase
// guessing guard). Keyed by project+user; 10 attempts / 5 min.
const UNLOCK_ATTEMPTS = new Map();
const UNLOCK_WINDOW_MS = 5 * 60 * 1000;
const UNLOCK_MAX = 10;
/** @param {string} key */
function unlockRateOk(key) {
  const now = Date.now();
  const arr = (UNLOCK_ATTEMPTS.get(key) || []).filter((/** @type {number} */ t) => now - t < UNLOCK_WINDOW_MS);
  if (arr.length >= UNLOCK_MAX) {
    UNLOCK_ATTEMPTS.set(key, arr);
    return false;
  }
  arr.push(now);
  UNLOCK_ATTEMPTS.set(key, arr);
  return true;
}

/** POST /api/projects/:id/encrypt -- Enable encryption (owner only).
 *  Body: { passphrase, passphraseHint? }. Returns { recoveryCode } once. */
router.post('/:id/encrypt', async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  try {
    const { passphrase, passphraseHint } = req.body || {};
    const { recoveryCode } = await encryptionService.enableEncryption(
      req.params.id,
      passphrase,
      { passphraseHint: passphraseHint ?? null },
    );
    await auditLog(req.session.userId, 'project_encryption_enabled', {
      targetType: 'project',
      targetId: req.params.id,
      ip: req.ip,
    });
    res.json({ ok: true, recoveryCode });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/projects/:id/unlock -- Unlock for this session (member).
 *  Body: { secret } (passphrase OR recovery code). */
router.post('/:id/unlock', async (req, res) => {
  if (!(await requireMembership(req, res))) return;
  const key = `${req.params.id}:${req.session.userId}`;
  if (!unlockRateOk(key)) {
    return res.status(429).json({ error: 'Too many unlock attempts. Try again in a few minutes.' });
  }
  try {
    const { secret } = req.body || {};
    const result = await encryptionService.unlockWithSecret(req.params.id, secret);
    if (!result.ok) return res.status(401).json({ error: 'Incorrect passphrase or recovery code' });
    res.json({ ok: true, viaRecovery: !!result.viaRecovery });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/projects/:id/lock -- Release one unlock reference (member). */
router.post('/:id/lock', async (req, res) => {
  if (!(await requireMembership(req, res))) return;
  encryptionService.lock(req.params.id);
  res.json({ ok: true });
});

/** POST /api/projects/:id/rotate-passphrase -- Rotate passphrase (owner).
 *  Body: { currentSecret, newPassphrase }. Returns a NEW { recoveryCode }. */
router.post('/:id/rotate-passphrase', async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  const key = `${req.params.id}:${req.session.userId}:rotate`;
  if (!unlockRateOk(key)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  try {
    const { currentSecret, newPassphrase } = req.body || {};
    const { recoveryCode } = await encryptionService.rotatePassphrase(req.params.id, currentSecret, newPassphrase);
    await auditLog(req.session.userId, 'project_passphrase_rotated', {
      targetType: 'project',
      targetId: req.params.id,
      ip: req.ip,
    });
    res.json({ ok: true, recoveryCode });
  } catch (err) {
    sendError(res, err);
  }
});

/** GET /api/projects/:id/encryption -- Status: { encrypted, unlocked, passphraseHint } (member). */
router.get('/:id/encryption', async (req, res) => {
  if (!(await requireMembership(req, res))) return;
  const row = await db.get('SELECT encrypted, encryption_meta FROM projects WHERE id = $1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Project not found' });
  res.json({
    encrypted: !!row.encrypted,
    unlocked: row.encrypted ? isProjectUnlocked(req.params.id) : true,
    passphraseHint: row.encrypted ? (row.encryption_meta?.passphraseHint ?? null) : null,
  });
});

/** GET /api/projects/:id/zip -- Download all project files as a ZIP archive. */
router.get('/:id/zip', async (req, res) => {
  if (!(await requireMembership(req, res))) return;
  const project = await db.get('SELECT name FROM projects WHERE id = $1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const files = await db.all(
    'SELECT path, content, is_binary, binary_sha256 FROM files WHERE project_id = $1',
    [req.params.id],
  );
  // Decrypt text content for an encrypted (unlocked) project; 423 if
  // locked. No-op for plaintext projects.
  await decryptRowsForRead(req.params.id, files);
  const zipName = (project.name || 'project').replace(/[^a-zA-Z0-9_-]/g, '_') + '.zip';
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${zipName}"; filename*=UTF-8''${encodeURIComponent(zipName)}`);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.pipe(res);
  for (const f of files) archive.append(await loadFileBytes(req.params.id, f), { name: f.path });
  archive.finalize();
});

/** GET /api/projects/:id/zip-used -- Download only files referenced by the main .tex file as a ZIP. */
router.get('/:id/zip-used', async (req, res) => {
  if (!(await requireMembership(req, res))) return;
  const project = await db.get('SELECT name, main_file FROM projects WHERE id = $1', [req.params.id]);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const files = await db.all(
    'SELECT path, content, is_binary, binary_sha256 FROM files WHERE project_id = $1',
    [req.params.id],
  );
  const mainFile = project.main_file || 'main.tex';
  const usedPaths = resolveUsedFiles(files, mainFile);
  const usedFiles = files.filter((/** @type {{ path: string }} */ f) => usedPaths.has(f.path));
  const zipName = (project.name || 'project').replace(/[^a-zA-Z0-9_-]/g, '_') + '.zip';
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${zipName}"; filename*=UTF-8''${encodeURIComponent(zipName)}`);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.pipe(res);
  for (const f of usedFiles) archive.append(await loadFileBytes(req.params.id, f), { name: f.path });
  archive.finalize();
});

/** POST /api/projects/:id/upload-zip -- Upload a ZIP file and merge its contents into the project. */
router.post('/:id/upload-zip', upload.single('file'), async (req, res) => {
  if (!(await requireEditor(req, res))) return;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const result = await projectService.uploadZipToProject(req.params.id, req.file.buffer);
    res.json({ ok: true, files: result.files, created: result.created });
  } catch (err) {
    logger.error({ err }, 'ZIP upload error');
    const msg = err instanceof Error ? err.message : 'Failed to extract ZIP file';
    res.status(400).json({ error: msg });
  }
});

/** GET /api/projects/files/:fileId/raw -- Serve the raw content of a file (binary or text).
 *  Binary rows are streamed from the per-project blob store; text rows
 *  come from files.content. SVG is forced to attachment and sandbox-CSP
 *  + nosniff are set for any binary to neutralise embedded scripts. */
router.get('/files/:fileId/raw', async (req, res) => {
  const file = await projectService.getRawFile(req.params.fileId, req.session.userId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  if (!file.is_binary) {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    return res.send(file.content || '');
  }

  // Invariant since phase C.2: every binary row has binary_sha256 +
  // binary_mime. A row that doesn't would indicate a code path that
  // skipped writeBinaryFileInTx; refuse to serve rather than silently
  // fall back to a broken read.
  if (!file.binary_sha256) {
    logger.error({ fileId: file.id, path: file.path }, 'binary file row missing binary_sha256');
    return res.status(500).json({ error: 'File data unavailable' });
  }

  const ext = (file.path || '').split('.').pop().toLowerCase();
  res.set('Content-Type', file.binary_mime || 'application/octet-stream');
  // Force download for SVG (prevents inline script execution); inline for others
  res.set('Content-Disposition', ext === 'svg' ? 'attachment' : 'inline');
  // Sandbox all user-uploaded binary content to prevent embedded scripts
  res.set('Content-Security-Policy', "sandbox; default-src 'none'");
  res.set('X-Content-Type-Options', 'nosniff');

  // statBlob first so we can emit Content-Length and short-circuit a
  // missing-blob case (would be a GC bug; surface as 404 rather than a
  // half stream).
  const blobStat = await statBlob(file.project_id, file.binary_sha256);
  if (!blobStat) {
    logger.error({ fileId: file.id, sha256: file.binary_sha256 }, 'blob row references missing on-disk file');
    return res.status(404).json({ error: 'File data unavailable' });
  }
  res.set('Content-Length', blobStat.size);
  // SAAS-FOUNDATIONS item 2 phase 2.5: readBlobStream now returns a
  // promise so a future S3-backed persistor can resolve a request to
  // the appropriate backend (FS or remote) at call time.
  const stream = await readBlobStream(file.project_id, file.binary_sha256);
  if (!stream) {
    // Defensive: statBlob said the blob existed but the read couldn't
    // open it. Treat as the same 404 as the blob-missing case.
    return res.status(404).json({ error: 'File data unavailable' });
  }
  stream
    .on('error', (/** @type {unknown} */ err) => {
      logger.error({ err, fileId: file.id }, 'blob stream error');
      if (!res.headersSent) res.status(500).end();
    })
    .pipe(res);
});

/** GET /api/projects/:id/files -- List all files in a project. */
router.get('/:id/files', async (req, res) => {
  if (!(await requireMembership(req, res))) return;
  res.json(await projectService.getProjectFiles(req.params.id));
});

/** POST /api/projects/:id/files -- Create a new text file in the project. */
router.post('/:id/files', async (req, res) => {
  if (!(await requireEditor(req, res))) return;
  try {
    res.json(await projectService.createFile(req.params.id, req.body.path, req.body.content));
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/projects/:id/upload-file -- Upload a single binary file (e.g. images via drag-and-drop). */
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

/** PUT /api/projects/files/:fileId -- Update a file's content (and optionally tcMarks sidecar). */
router.put('/files/:fileId', async (req, res) => {
  const { content, tcMarks, baseVersion } = req.body;
  if (content && content.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'File too large (max 10MB)' });
  const access = /** @type {any} */ (await projectService.getFileWithAccess(req.params.fileId, req.session.userId, { edit: true }));
  if (access.error) return res.status(access.status).json({ error: access.error });
  const result = await projectService.updateFileContent(req.params.fileId, content, req.session.userId, tcMarks, baseVersion);
  if (result.conflict) {
    // V2-3 stale-save conflict — caller's baseVersion is older than the
    // current file row. Client should refetch and merge.
    return res.status(409).json({ error: 'Conflict', currentVersion: result.currentVersion });
  }
  if (result.newSnapshot) {
    req.app.locals.broadcastToRoom?.(result.projectId, { type: 'history_update', authorName: result.authorName });
  }
  res.json({ ok: true, version: result.version });
});

/** PATCH /api/projects/files/:fileId -- Rename a file. */
router.patch('/files/:fileId', async (req, res) => {
  if (!req.body.path) return res.status(400).json({ error: 'path required' });
  const access = /** @type {any} */ (await projectService.getFileWithAccess(req.params.fileId, req.session.userId, { edit: true }));
  if (access.error) return res.status(access.status).json({ error: access.error });
  try {
    res.json((await projectService.renameFile(req.params.fileId, req.body.path)) || { ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

/** DELETE /api/projects/files/:fileId -- Delete a file from the project. */
router.delete('/files/:fileId', async (req, res) => {
  const access = /** @type {any} */ (await projectService.getFileWithAccess(req.params.fileId, req.session.userId, { edit: true }));
  if (access.error) return res.status(access.status).json({ error: access.error });
  await projectService.deleteFile(req.params.fileId);
  res.json({ ok: true });
});

// --- Folders (explicit empty-folder persistence) ---

/** GET /api/projects/:id/folders -- List all explicit empty folders. */
router.get('/:id/folders', async (req, res) => {
  if (!(await requireMembership(req, res))) return;
  try {
    res.json(await projectService.listFolders(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/projects/:id/folders body {path} -- Create an empty folder. */
router.post('/:id/folders', async (req, res) => {
  const access = await requireEditor(req, res);
  if (!access) return;
  try {
    const result = await projectService.createFolder(req.params.id, req.body?.path);
    // Push to other members so their tree refreshes immediately.
    if (req.app.locals.broadcastToRoom) {
      req.app.locals.broadcastToRoom(req.params.id, {
        type: 'folder-create',
        path: result.path,
      });
    }
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

/** DELETE /api/projects/:id/folders body {path} -- Delete folder and everything under. */
router.delete('/:id/folders', async (req, res) => {
  const access = await requireEditor(req, res);
  if (!access) return;
  try {
    await projectService.deleteFolder(req.params.id, req.body?.path);
    if (req.app.locals.broadcastToRoom) {
      req.app.locals.broadcastToRoom(req.params.id, {
        type: 'folder-delete',
        path: req.body?.path,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

/** PATCH /api/projects/:id/folders body {oldPath, newPath} -- Rename a folder tree atomically. */
router.patch('/:id/folders', async (req, res) => {
  const access = await requireEditor(req, res);
  if (!access) return;
  try {
    await projectService.renameFolderTree(req.params.id, req.body?.oldPath, req.body?.newPath);
    if (req.app.locals.broadcastToRoom) {
      req.app.locals.broadcastToRoom(req.params.id, {
        type: 'folder-rename',
        oldPath: req.body?.oldPath,
        newPath: req.body?.newPath,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/projects/:id/archive -- Archive a project (owner) or leave it (non-owner). */
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
/** POST /api/projects/:id/unarchive -- Restore a project from the archive (owner only). */
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
/** POST /api/projects/:id/trash -- Move a project to trash (owner) or leave it (non-owner). */
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
/** POST /api/projects/:id/restore -- Restore a project from trash (owner only). */
router.post('/:id/restore', async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  await projectService.restoreProject(req.params.id);
  await auditLog(req.session.userId, 'project_restore', { targetType: 'project', targetId: req.params.id, ip: req.ip });
  res.json({ ok: true });
});

/** POST /api/projects/:id/copy  body { name?, includeMembers? }
 *  Duplicate a project for the current user. With includeMembers=true the
 *  source's collaborators are carried over with their original roles
 *  (caller is always the owner regardless). Because carrying members is
 *  an implicit share with people who have not opted in, that variant is
 *  restricted to editors/owners of the source — a viewer can clone the
 *  project for themselves, but cannot rebroadcast it. Every per-user
 *  add is recorded in the audit log so it is traceable. */
router.post('/:id/copy', async (req, res) => {
  const includeMembers = req.body?.includeMembers === true;
  if (includeMembers) {
    if (!(await requireEditor(req, res))) return;
  } else {
    if (!(await requireMembership(req, res))) return;
  }
  try {
    const result = await projectService.copyProject(
      req.params.id,
      req.session.userId,
      req.body?.name,
      { includeMembers },
    );
    await auditLog(req.session.userId, 'project_copy', {
      targetType: 'project',
      targetId: result.id,
      detail: { sourceId: req.params.id, includeMembers, addedMemberCount: result.addedMembers?.length || 0 },
      ip: req.ip,
    });
    if (result.addedMembers?.length) {
      for (const uid of result.addedMembers) {
        await auditLog(req.session.userId, 'project_member_added_via_copy', {
          targetType: 'user',
          targetId: uid,
          detail: { projectId: result.id, sourceId: req.params.id },
          ip: req.ip,
        });
      }
    }
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/projects/:id/tags/:tagId -- Add a tag to a project (editor+). */
router.post('/:id/tags/:tagId', async (req, res) => {
  if (!(await requireEditor(req, res))) return;
  try {
    await db.run('INSERT INTO project_tags (project_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      req.params.id,
      req.params.tagId,
    ]);
  } catch {}
  res.json({ ok: true });
});

/** DELETE /api/projects/:id/tags/:tagId -- Remove a tag from a project (editor+). */
router.delete('/:id/tags/:tagId', async (req, res) => {
  if (!(await requireEditor(req, res))) return;
  await db.run('DELETE FROM project_tags WHERE project_id = $1 AND tag_id = $2', [req.params.id, req.params.tagId]);
  res.json({ ok: true });
});

/** GET /api/projects/:id/search -- Search across all text files in a project. */
router.get('/:id/search', async (req, res) => {
  if (!(await requireMembership(req, res))) return;
  try {
    const q = (typeof req.query.q === 'string' ? req.query.q : '').trim();
    const scope = typeof req.query.scope === 'string' ? req.query.scope : 'all';
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
