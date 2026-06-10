// @ts-check
// Admin routes for SAML IdP management. All routes mount under
// /api/admin/saml/* and require admin auth (gating handled by the
// app.use(...) line in index.js, same pattern as adminRouter).

import { Router } from 'express';
import { z } from 'zod';
import logger from '../logger.js';
import { auditLog } from '../utils/audit.js';
import validateBody from '../middleware/validateBody.js';
import * as samlService from '../services/samlService.js';

const router = Router();

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ─── Schemas ───────────────────────────────────────────────────────────

const ATTR_MAP_OBJECT = z.object({
  email: z.string().max(512),
  name: z.string().max(512),
  nameId: z.string().max(512),
}).strict();

const createIdPSchema = z.object({
  displayName: z.string().min(1).max(200),
  // Either metadataXml OR the field-by-field trio. Validation that
  // exactly one is provided lives in the service.
  metadataXml: z.string().max(1024 * 1024).optional(),  // 1 MB ceiling on uploads
  entityId: z.string().max(1024).optional(),
  ssoUrl: z.string().url().max(2048).optional(),
  sloUrl: z.string().url().max(2048).optional().nullable(),
  certPem: z.string().max(64 * 1024).optional(),
  // Either a preset name or an object.
  attributeMapping: z.union([
    z.enum(['shibboleth', 'entra', 'okta', 'google', 'generic']),
    ATTR_MAP_OBJECT,
  ]).default('generic'),
  // Required: at least one domain.
  allowedEmailDomains: z.array(z.string().max(255)).min(1).max(50),
  jitProvisioning: z.boolean().default(true),
  enabled: z.boolean().default(false),
}).strict();

const updateIdPSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  sloUrl: z.string().url().max(2048).optional().nullable(),
  ssoUrl: z.string().url().max(2048).optional(),
  certPem: z.string().max(64 * 1024).optional(),
  attributeMapping: z.union([
    z.enum(['shibboleth', 'entra', 'okta', 'google', 'generic']),
    ATTR_MAP_OBJECT,
  ]).optional(),
  allowedEmailDomains: z.array(z.string().max(255)).min(1).max(50).optional(),
  jitProvisioning: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).strict();

const testMetadataSchema = z.object({
  metadataXml: z.string().min(10).max(1024 * 1024),
}).strict();

// ─── SP info ───────────────────────────────────────────────────────────

/** GET /api/admin/saml/sp-info
 *  Returns the FlowTex SP's entityID, certificate, fingerprint, and the
 *  URL operators give to their IdP for periodic metadata fetch.
 */
router.get('/sp-info', async (req, res) => {
  try {
    const entityId = spEntityId(req);
    const kp = await samlService.getSpKeypair(entityId);
    res.json({
      entityId,
      // Per-IdP metadata URL pattern; operators substitute the IdP ID
      // they're configuring. We don't surface IdP-specific URLs here
      // because the SP info is identical across all IdPs (same SP).
      metadataUrlTemplate: `${appOrigin(req)}/api/auth/saml/<idpId>/metadata`,
      acsUrlTemplate: `${appOrigin(req)}/api/auth/saml/<idpId>/acs`,
      certificatePem: kp.certificatePem,
      fingerprintSha256: kp.fingerprintSha256,
      notValidAfter: kp.notAfter,
    });
  } catch (err) {
    logger.error({ err }, 'admin/saml/sp-info failed');
    res.status(500).json({ error: 'Failed to load SP info.' });
  }
});

/** POST /api/admin/saml/sp/rotate
 *  Mint a fresh SP keypair. Operator coordinates re-import on the IdP
 *  side (out of band). Audit-logged.
 */
router.post('/sp/rotate', async (req, res) => {
  try {
    const entityId = spEntityId(req);
    const fresh = await samlService.rotateSpKeypair(entityId, req.session.userId);
    // Same silent-drop bug pattern as routes/auth.js audit calls:
    // fingerprintSha256 isn't on the auditLog opts shape, so the
    // old form was logging without any detail. Moving to detail.
    await auditLog(req.session.userId, 'saml_sp_rotate', {
      ip: req.ip,
      detail: { fingerprintSha256: fresh.fingerprintSha256 },
    }).catch(() => {});
    res.json({
      ok: true,
      fingerprintSha256: fresh.fingerprintSha256,
      notValidAfter: fresh.notAfter,
    });
  } catch (err) {
    logger.error({ err }, 'admin/saml/sp/rotate failed');
    res.status(500).json({ error: 'Failed to rotate SP keypair.' });
  }
});

// ─── IdP CRUD ─────────────────────────────────────────────────────────

router.get('/idps', async (req, res) => {
  try {
    const rows = await samlService.listIdPs();
    res.json({ idps: rows });
  } catch (err) {
    logger.error({ err }, 'admin/saml/idps list failed');
    res.status(500).json({ error: 'Failed to list IdPs.' });
  }
});

router.get('/idps/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const idp = await samlService.getIdP(req.params.id);
    if (!idp) return res.status(404).json({ error: 'Not found.' });
    res.json({ idp });
  } catch (err) {
    logger.error({ err, idpId: req.params.id }, 'admin/saml/idps get failed');
    res.status(500).json({ error: 'Failed to load IdP.' });
  }
});

router.post('/idps', validateBody(createIdPSchema), async (req, res) => {
  try {
    const created = await samlService.createIdP({
      ...req.body,
      createdBy: req.session.userId,
    });
    await auditLog(req.session.userId, 'saml_idp_create', {
      ip: req.ip,
      detail: {
        idpId: created.id,
        displayName: req.body.displayName,
        enabled: req.body.enabled,
      },
    }).catch(() => {});
    res.status(201).json({ idp: created });
  } catch (err) {
    const e = /** @type {{ status?: number, message?: string }} */ (err && typeof err === 'object' ? err : {});
    const status = e.status || 500;
    if (status >= 500) {
      logger.error({ err }, 'admin/saml/idps create failed');
      return res.status(500).json({ error: 'Failed to create IdP.' });
    }
    res.status(status).json({ error: e.message });
  }
});

router.patch('/idps/:id', validateBody(updateIdPSchema), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const updated = await samlService.updateIdP(req.params.id, req.body);
    await auditLog(req.session.userId, 'saml_idp_update', {
      ip: req.ip,
      detail: {
        idpId: req.params.id,
        patch: Object.keys(req.body),
      },
    }).catch(() => {});
    res.json({ idp: updated });
  } catch (err) {
    const e = /** @type {{ status?: number, message?: string }} */ (err && typeof err === 'object' ? err : {});
    const status = e.status || 500;
    if (status >= 500) {
      logger.error({ err, idpId: req.params.id }, 'admin/saml/idps update failed');
      return res.status(500).json({ error: 'Failed to update IdP.' });
    }
    res.status(status).json({ error: e.message });
  }
});

router.delete('/idps/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    await samlService.deleteIdP(req.params.id);
    await auditLog(req.session.userId, 'saml_idp_delete', {
      ip: req.ip,
      detail: { idpId: req.params.id },
    }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    const e = /** @type {{ status?: number, message?: string }} */ (err && typeof err === 'object' ? err : {});
    const status = e.status || 500;
    if (status >= 500) {
      logger.error({ err, idpId: req.params.id }, 'admin/saml/idps delete failed');
      return res.status(500).json({ error: 'Failed to delete IdP.' });
    }
    res.status(status).json({ error: e.message });
  }
});

/** POST /api/admin/saml/idps/test-metadata
 *  Validates that a pasted metadata XML is parseable without
 *  persisting anything. Useful preflight before pressing Save.
 */
router.post('/idps/test-metadata', validateBody(testMetadataSchema), (req, res) => {
  try {
    const parsed = samlService.parseIdpMetadataXml(req.body.metadataXml);
    res.json({
      ok: true,
      preview: {
        entityId: parsed.entityId,
        ssoUrl: parsed.ssoUrl,
        sloUrl: parsed.sloUrl,
        // Show fingerprint of the cert, not the cert itself (too long
        // for a preview UI).
        certPreview: parsed.certPem.slice(0, 120) + '...',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid metadata';
    res.status(400).json({ ok: false, error: msg });
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────

/** @param {import('express').Request} req */
function appOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

/** @param {import('express').Request} req */
function spEntityId(req) {
  return `${appOrigin(req)}/api/auth/saml/sp`;
}

export default router;
