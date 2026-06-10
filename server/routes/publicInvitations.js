// @ts-check
// Public (no-auth) endpoints for the unregistered-invitee flow.
//
// Two entry points:
//   GET  /api/invitations/public/:id  — surface just enough invitation
//        context (inviter name, project name, invited email) so the
//        unregistered recipient's landing page can prefill the
//        register form and show a "you've been invited" banner. NOT
//        secret — the recipient already has the id in their email
//        link; an attacker who steals the link learns the same
//        non-secret context, and gains no privilege.
//   POST /api/invitations/by-token/decline  — the recipient declines
//        WITHOUT registering. Token-gated: the raw decline token
//        from the email is hashed and matched against
//        project_invitations.decline_token_hash. Idempotent.
//
// Mounted at /api/invitations OUTSIDE the requireAuth wrapper in
// server/index.js — both endpoints intentionally serve users who
// have not yet signed in.

import { Router } from 'express';
import crypto from 'node:crypto';
import db from '../db.js';
import logger from '../logger.js';
import { auditLog } from '../utils/audit.js';
import { sendInvitationDeclinedEmail } from '../utils/email.js';
import { sendError } from '../middleware/errorHandler.js';

const router = Router();

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** GET /api/invitations/public/:id
 *
 *  Returns: { email, projectName, inviterName, status, hasAccount }
 *  No secret values are leaked. The recipient is expected to already
 *  hold the invitation id (they got it in their email). Used by
 *  AuthPage to prefill the register form with the email and show
 *  the inviter / project context. */
router.get('/public/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid invitation id' });
  try {
    const row = await db.get(
      `SELECT i.email, i.status, p.name AS project_name, u.name AS inviter_name
       FROM project_invitations i
       JOIN projects p ON p.id = i.project_id
       JOIN users    u ON u.id = i.inviter_id
       WHERE i.id = $1`,
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'Invitation not found' });
    const account = await db.get('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)', [row.email]);
    // L1 (audit): only return the email when the recipient is
    // unregistered — i.e. when the AuthPage will use it to prefill
    // the register form. For an already-registered recipient the
    // AuthPage flips to login mode (no email prefill needed), so
    // there's no reason to leak which email an invitation was sent
    // to. Cuts the (theoretical) email-enumeration value of brute-
    // forcing invitation UUIDs.
    res.json({
      email: account ? null : row.email,
      projectName: row.project_name,
      inviterName: row.inviter_name,
      status: row.status,
      hasAccount: !!account,
    });
  } catch (err) {
    sendError(res, err);
  }
});

/** POST /api/invitations/by-token/decline
 *  body: { token }
 *
 *  Hashes the token, matches against decline_token_hash, marks the
 *  invitation declined. Idempotent — calling twice with the same
 *  token returns ok both times (so an email scanner pre-fetching the
 *  decline link doesn't poison the human's click; same posture as the
 *  email-verify endpoint). The token is invalidated once used so it
 *  can't be replayed long after the fact. */
router.post('/by-token/decline', async (req, res) => {
  const raw = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!raw) return res.status(400).json({ error: 'Token is required' });
  // Bound the input so a malformed token can't push pathological
  // strings through crypto.update — though it would be safe, it's
  // wasted work.
  if (raw.length > 256) return res.status(400).json({ error: 'Token too long' });
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  try {
    const row = await db.get(
      `SELECT id, project_id, email, status, inviter_id
       FROM project_invitations
       WHERE decline_token_hash = $1`,
      [hash],
    );
    if (!row) {
      // Either the token is bogus, or it was consumed and we already
      // nulled the hash. Idempotent success: a previous decline ran.
      return res.json({ ok: true, alreadyDeclined: true });
    }
    if (row.status === 'declined') {
      return res.json({ ok: true, alreadyDeclined: true });
    }
    // Mark declined + null the token so it can't be replayed later.
    await db.run(
      `UPDATE project_invitations
         SET status = 'declined', decline_token_hash = NULL
       WHERE id = $1`,
      [row.id],
    );
    await auditLog(null, 'invitation_declined_via_email', {
      targetType: 'invitation',
      targetId: row.id,
      detail: JSON.stringify({ projectId: row.project_id, email: row.email }),
      ip: req.ip,
    }).catch((e) => logger.warn({ err: e }, 'Audit log failed for token-decline'));
    // Push to the inviter over WS if they're online so the pending-
    // invitations list refreshes without a reload.
    if (req.app.locals.sendToUser) {
      req.app.locals.sendToUser(row.inviter_id, {
        type: 'invitation-declined',
        invitationId: row.id,
        projectId: row.project_id,
        email: row.email,
      });
    }
    // I3 (audit): email the inviter too. The WS push above only
    // fires if the inviter happens to be online at the exact moment
    // the decline lands — usually they aren't. Best-effort: a send
    // failure does NOT roll back the decline (declining is the
    // decliner's right, the inviter's notification is courtesy).
    // Fire-and-forget so the HTTP response isn't blocked on SMTP.
    (async () => {
      try {
        const inviter = await db.get(
          `SELECT u.email, u.name, p.name AS project_name
           FROM users u JOIN projects p ON p.id = $2
           WHERE u.id = $1`,
          [row.inviter_id, row.project_id],
        );
        if (!inviter?.email) return;
        const baseUrl = process.env.APP_URL || '';
        await sendInvitationDeclinedEmail(inviter.email, {
          inviterName: inviter.name,
          declinedEmail: row.email,
          projectName: inviter.project_name,
          projectUrl: baseUrl ? `${baseUrl}/project/${row.project_id}` : '',
        });
      } catch (err) {
        logger.warn({ err, invitationId: row.id }, 'Inviter notification email failed');
      }
    })();
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
