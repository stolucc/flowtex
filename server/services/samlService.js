// SAML / multi-tenant SSO support.
//
// Day 1 surface (this file): just the SP keypair lifecycle.
//   - generateSpKeypair() -> { privateKey, certificatePem, fingerprintSha256 }
//   - getSpKeypair()      -> the (cached) current keypair, generating
//                            one on first call.
//   - rotateSpKeypair()   -> mint a new one, persist, return the new one.
//
// Days 2-4 will add IdP CRUD, assertion validation, JIT-link/provision,
// and the discovery endpoint. Day 5 will add the admin UI.
//
// Why the SP needs a keypair:
//   - Some IdPs require the SP to SIGN its AuthnRequests.
//   - All IdPs need the SP's certificate so they can verify those
//     signatures and (optionally) encrypt the assertion they send back.
//   - The cert is what we publish in our SP metadata XML.
//
// The private key is stored encrypted in PG via utils/crypto.js
// (AES-256-GCM with the per-install ENCRYPTION_KEY -- same primitive
// already used for totp_secret and OAuth tokens). The certificate is
// stored unencrypted (it's a public artefact by definition).

import crypto from 'node:crypto';
import { v4 as uuid } from 'uuid';
import selfsigned from 'selfsigned';
import { XMLParser } from 'fast-xml-parser';
import { SAML } from '@node-saml/node-saml';
import db from '../db.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import logger from '../logger.js';

// Cache the in-memory parsed form so we don't decrypt on every signing
// operation. Invalidated by rotate(). Multiple processes (cluster
// mode) will each hold their own copy -- that's fine, the underlying
// rows are the source of truth.
let _cached = null;

const KEYPAIR_ID = 'default';
const KEY_VALIDITY_DAYS = 365 * 3; // 3 years -- standard SAML SP convention
const SIG_BITS = 2048;             // RSA 2048 (SAML 2.0 baseline)

/**
 * Generate a fresh SP keypair: RSA-2048, self-signed X.509 cert with
 * an entity-ID-shaped CN. Returns the in-memory PEM strings; the
 * caller persists.
 *
 * @param {string} entityId - the SP's SAML entityID; used as the cert CN
 * @returns {Promise<{ privateKey: string, certificatePem: string, fingerprintSha256: string, notAfter: Date }>}
 */
export async function generateSpKeypair(entityId) {
  if (typeof entityId !== 'string' || entityId.length === 0) {
    throw new Error('generateSpKeypair: entityId is required');
  }
  // selfsigned 5.x issues an X.509 self-signed cert via @peculiar/x509
  // + Node webcrypto. The API became async in 5.0 -- the old sync
  // shape didn't have a path through webcrypto. Returns
  //   { cert, private, public, fingerprint }
  // all PEM strings + a SHA-1 fingerprint (we compute our own SHA-256
  // below).
  const attrs = [{ name: 'commonName', value: entityId }];
  const pems = await selfsigned.generate(attrs, {
    keySize: SIG_BITS,
    days: KEY_VALIDITY_DAYS,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
      { name: 'extKeyUsage', clientAuth: true, serverAuth: true },
    ],
  });
  const fingerprintSha256 = crypto
    .createHash('sha256')
    .update(pems.cert)
    .digest('hex');
  const notAfter = new Date(Date.now() + KEY_VALIDITY_DAYS * 24 * 3600 * 1000);
  return {
    privateKey: pems.private,
    certificatePem: pems.cert,
    fingerprintSha256,
    notAfter,
  };
}

/**
 * Return the currently-persisted SP keypair. Generates one on first
 * call (idempotent across instances: ON CONFLICT DO NOTHING + re-read).
 *
 * @param {string} entityId - SP's entityID, only used when generating
 *                            for the first time. Persists into the cert
 *                            CN. Subsequent calls IGNORE this value
 *                            (changing it would require rotation).
 */
export async function getSpKeypair(entityId) {
  if (_cached) return _cached;

  const existing = await db.get(
    'SELECT private_key_encrypted, certificate_pem, fingerprint_sha256, not_valid_after FROM saml_sp_keypair WHERE id = $1',
    [KEYPAIR_ID],
  );
  if (existing) {
    _cached = {
      privateKey: decrypt(existing.private_key_encrypted),
      certificatePem: existing.certificate_pem,
      fingerprintSha256: existing.fingerprint_sha256,
      notAfter: existing.not_valid_after,
    };
    return _cached;
  }

  // First-boot path: generate, persist, re-read.
  if (!entityId) {
    throw new Error(
      'getSpKeypair: no keypair exists and no entityId provided to generate one. ' +
      'Call with the SP entityID on first boot.',
    );
  }
  const fresh = await generateSpKeypair(entityId);
  await db.run(
    `INSERT INTO saml_sp_keypair (id, private_key_encrypted, certificate_pem, fingerprint_sha256, not_valid_after)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [
      KEYPAIR_ID,
      encrypt(fresh.privateKey),
      fresh.certificatePem,
      fresh.fingerprintSha256,
      fresh.notAfter,
    ],
  );
  // Re-read in case another process inserted first (idempotent boot).
  return getSpKeypair(undefined);
}

/**
 * Mint a NEW keypair, persist (replacing the old row), invalidate
 * the in-memory cache. Operators trigger this when:
 *   - The current cert is approaching its 3-year expiry.
 *   - The previous private key was suspected compromised.
 *   - The SP entityID changes (rare; the CN should match).
 *
 * Returns the new keypair shape from generateSpKeypair.
 *
 * NB: rotating leaves a window where IdPs that haven't yet re-read our
 * SP metadata still have the OLD cert. AuthnRequests signed with the
 * new private key will fail signature verification on the IdP side
 * until they re-import metadata. Some IdPs poll metadata URLs at a
 * configurable interval; others require a manual re-import. Either
 * way, operators should coordinate the cert rotation with their IdP
 * counterparts (out of band).
 */
export async function rotateSpKeypair(entityId, rotatedBy) {
  const fresh = await generateSpKeypair(entityId);
  await db.run(
    `INSERT INTO saml_sp_keypair (id, private_key_encrypted, certificate_pem, fingerprint_sha256, not_valid_after, rotated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (id) DO UPDATE SET
       private_key_encrypted = EXCLUDED.private_key_encrypted,
       certificate_pem = EXCLUDED.certificate_pem,
       fingerprint_sha256 = EXCLUDED.fingerprint_sha256,
       not_valid_after = EXCLUDED.not_valid_after,
       rotated_at = NOW()`,
    [
      KEYPAIR_ID,
      encrypt(fresh.privateKey),
      fresh.certificatePem,
      fresh.fingerprintSha256,
      fresh.notAfter,
    ],
  );
  logger.info(
    { rotatedBy, fingerprintSha256: fresh.fingerprintSha256, notAfter: fresh.notAfter },
    'SAML SP keypair rotated',
  );
  _cached = null;
  return fresh;
}

// ─── Attribute mapping presets ──────────────────────────────────────────
//
// Each preset is the URI under which an IdP exposes the named attribute
// in its assertion. Operator picks a preset when configuring an IdP;
// the advanced UI lets them override per-attribute. Covers ~95% of
// real-world deployments.
//
// Sources:
//   - shibboleth: standard eduPerson schema OIDs.
//   - entra: Microsoft Entra ID (formerly Azure AD) WS-* schemas.
//   - okta: Okta's "AttributeStatement" friendlyName form.
//   - google: Google Workspace SAML, which adopts eduPerson OIDs.
//   - generic: bare attribute names (works against many test IdPs).

export const ATTR_PRESETS = {
  shibboleth: {
    email:  'urn:oid:0.9.2342.19200300.100.1.3',     // mail
    name:   'urn:oid:2.16.840.1.113730.3.1.241',     // displayName
    nameId: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
  },
  entra: {
    email:  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    name:   'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
    nameId: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  },
  okta: {
    email:  'email',
    name:   'name',
    nameId: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  },
  google: {
    email:  'urn:oid:0.9.2342.19200300.100.1.3',
    name:   'urn:oid:2.16.840.1.113730.3.1.241',
    nameId: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  },
  generic: {
    email:  'email',
    name:   'name',
    nameId: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
  },
};

// ─── IdP metadata XML parser ────────────────────────────────────────────

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,            // strip md:, ds:, etc. — simplifies traversal
  isArray: (name) => ['SingleSignOnService', 'SingleLogoutService', 'KeyDescriptor'].includes(name),
});

/**
 * Parse an IdP metadata XML document into the four fields we persist:
 * entityID, SSO URL (HTTP-POST binding), SLO URL (optional), cert PEM.
 *
 * SAML metadata XML carries a lot more (encryption keys, AssertionConsumerService
 * for IdP-initiated, etc.) but for the SP→IdP relationship we only need
 * these four.
 *
 * @param {string} xml - raw metadata XML
 * @returns {{ entityId, ssoUrl, sloUrl: string|null, certPem }}
 * @throws if any required field is missing or malformed
 */
export function parseIdpMetadataXml(xml) {
  if (typeof xml !== 'string' || !xml.includes('EntityDescriptor')) {
    throw new Error('parseIdpMetadataXml: input does not look like SAML metadata XML');
  }
  const parsed = XML_PARSER.parse(xml);
  const ent = parsed.EntityDescriptor;
  if (!ent) throw new Error('parseIdpMetadataXml: no EntityDescriptor element');
  const entityId = ent['@_entityID'];
  if (!entityId) throw new Error('parseIdpMetadataXml: missing entityID attribute');

  const idp = ent.IDPSSODescriptor;
  if (!idp) throw new Error('parseIdpMetadataXml: not an IdP metadata document (no IDPSSODescriptor)');

  const findBinding = (services, binding) =>
    (services || []).find((s) => s['@_Binding'] === binding);

  const sso = findBinding(idp.SingleSignOnService, 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST')
    || findBinding(idp.SingleSignOnService, 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect');
  if (!sso) throw new Error('parseIdpMetadataXml: no HTTP-POST or HTTP-Redirect SingleSignOnService');
  const ssoUrl = sso['@_Location'];

  const slo = findBinding(idp.SingleLogoutService, 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST')
    || findBinding(idp.SingleLogoutService, 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect');
  const sloUrl = slo?.['@_Location'] || null;

  // Find a signing (or unspecified-use) KeyDescriptor and pull the
  // base64 cert out. IdPs sometimes ship multiple keys (signing +
  // encryption); we want the signing one.
  const keyDescriptors = idp.KeyDescriptor || [];
  const signingKey = keyDescriptors.find((k) => k['@_use'] === 'signing')
    || keyDescriptors.find((k) => !k['@_use']);
  if (!signingKey) throw new Error('parseIdpMetadataXml: no signing KeyDescriptor');
  const certBase64 = signingKey?.KeyInfo?.X509Data?.X509Certificate;
  if (!certBase64) throw new Error('parseIdpMetadataXml: KeyDescriptor has no X509Certificate');
  // The base64 in metadata is usually unwrapped; wrap as PEM.
  const certPem = wrapBase64AsPem(String(certBase64).replace(/\s+/g, ''), 'CERTIFICATE');

  return { entityId, ssoUrl, sloUrl, certPem };
}

function wrapBase64AsPem(b64, label) {
  const lines = b64.match(/.{1,64}/g) || [b64];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

// ─── IdP CRUD ───────────────────────────────────────────────────────────

/**
 * List all configured IdPs (admin UI). Returns the safe-to-display
 * shape with cert truncated to fingerprint.
 */
export async function listIdPs() {
  const rows = await db.all(
    `SELECT id, display_name, entity_id, sso_url, slo_url, enabled,
            jit_provisioning, allowed_email_domains, attribute_mapping,
            created_at, updated_at,
            substr(cert_pem, 1, 100) AS cert_pem_preview
       FROM saml_idp_config
       ORDER BY display_name`,
  );
  return rows;
}

export async function getIdP(id) {
  return db.get('SELECT * FROM saml_idp_config WHERE id = $1', [id]);
}

/**
 * Look up an IdP by email domain. Domain compared case-insensitively
 * (RFC 5321 §2.4: domain part of an email is case-insensitive).
 *
 * Returns the first enabled IdP whose allowed_email_domains contains
 * the requested domain. The domain-uniqueness invariant in createIdP
 * means there's at most one match.
 */
export async function getIdPByDomain(domain) {
  if (typeof domain !== 'string' || domain.length === 0) return null;
  const lower = domain.toLowerCase();
  return db.get(
    `SELECT * FROM saml_idp_config
       WHERE enabled = TRUE
         AND $1 = ANY(allowed_email_domains)
       LIMIT 1`,
    [lower],
  );
}

/**
 * Create a new IdP config. Enforces:
 *   - entityID is unique (UNIQUE constraint).
 *   - allowed_email_domains don't collide with any OTHER enabled IdP
 *     (advisory-lock-serialised app-level check; the UNIQUE constraint
 *     can't easily express "no overlap on array elements").
 *   - attribute_mapping uses one of the named presets OR is a
 *     concrete map of {email, name, nameId}.
 *   - allowed_email_domains is non-empty and each domain looks like
 *     a hostname (loose check).
 */
export async function createIdP({
  displayName,
  metadataXml,
  // OR field-by-field:
  entityId,
  ssoUrl,
  sloUrl,
  certPem,
  attributeMapping = 'generic',
  allowedEmailDomains,
  jitProvisioning = true,
  enabled = false,
  createdBy,
}) {
  // Step 1: resolve metadata. If XML provided, parse it; else require
  // the four fields.
  let resolved;
  if (typeof metadataXml === 'string' && metadataXml.trim().length > 0) {
    resolved = parseIdpMetadataXml(metadataXml);
  } else {
    if (!entityId || !ssoUrl || !certPem) {
      throw Object.assign(
        new Error('createIdP: provide either metadataXml OR (entityId + ssoUrl + certPem)'),
        { status: 400 },
      );
    }
    resolved = { entityId, ssoUrl, sloUrl: sloUrl || null, certPem };
  }

  // Step 2: validate inputs.
  if (typeof displayName !== 'string' || displayName.length === 0 || displayName.length > 200) {
    throw Object.assign(new Error('createIdP: displayName must be 1-200 chars'), { status: 400 });
  }
  const domains = normaliseEmailDomains(allowedEmailDomains);
  if (domains.length === 0) {
    throw Object.assign(
      new Error('createIdP: allowedEmailDomains must contain at least one domain'),
      { status: 400 },
    );
  }
  const attrMap = resolveAttributeMapping(attributeMapping);

  // Step 3: serialise the domain-uniqueness check + insert via advisory
  // lock so two concurrent admin operations can't both win.
  return db.transaction(async (tx) => {
    await tx.run('SELECT pg_advisory_xact_lock(hashtext($1))', ['saml-idp-domains']);
    // Collision check: any OTHER enabled IdP claiming one of our
    // requested domains?
    const collision = await tx.get(
      `SELECT id, display_name FROM saml_idp_config
         WHERE enabled = TRUE
           AND allowed_email_domains && $1::text[]
         LIMIT 1`,
      [domains],
    );
    if (collision && enabled) {
      throw Object.assign(
        new Error(`createIdP: email domain already claimed by IdP "${collision.display_name}"`),
        { status: 409 },
      );
    }
    const id = uuid();
    await tx.run(
      `INSERT INTO saml_idp_config
         (id, display_name, entity_id, sso_url, slo_url, cert_pem,
          attribute_mapping, enabled, jit_provisioning,
          allowed_email_domains, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        displayName,
        resolved.entityId,
        resolved.ssoUrl,
        resolved.sloUrl,
        resolved.certPem,
        JSON.stringify(attrMap),
        enabled,
        jitProvisioning,
        domains,
        createdBy || null,
      ],
    );
    return { id, ...resolved, attributeMapping: attrMap, allowedEmailDomains: domains };
  });
}

/**
 * Patch an existing IdP. Same domain-collision check as createIdP.
 * Patchable: displayName, sso/slo URLs, cert, attributeMapping,
 * allowedEmailDomains, jitProvisioning, enabled. entityID is
 * immutable (would require re-establishing trust with the IdP).
 */
export async function updateIdP(id, patch) {
  const existing = await getIdP(id);
  if (!existing) throw Object.assign(new Error('updateIdP: no such IdP'), { status: 404 });

  const next = { ...existing };
  if (patch.displayName !== undefined) next.display_name = patch.displayName;
  if (patch.ssoUrl !== undefined) next.sso_url = patch.ssoUrl;
  if (patch.sloUrl !== undefined) next.slo_url = patch.sloUrl;
  if (patch.certPem !== undefined) next.cert_pem = patch.certPem;
  if (patch.attributeMapping !== undefined) {
    next.attribute_mapping = JSON.stringify(resolveAttributeMapping(patch.attributeMapping));
  }
  if (patch.jitProvisioning !== undefined) next.jit_provisioning = !!patch.jitProvisioning;
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.allowedEmailDomains !== undefined) {
    next.allowed_email_domains = normaliseEmailDomains(patch.allowedEmailDomains);
    if (next.allowed_email_domains.length === 0) {
      throw Object.assign(
        new Error('updateIdP: allowedEmailDomains must contain at least one domain'),
        { status: 400 },
      );
    }
  }

  return db.transaction(async (tx) => {
    await tx.run('SELECT pg_advisory_xact_lock(hashtext($1))', ['saml-idp-domains']);
    // Collision check excluding self.
    if (next.enabled) {
      const collision = await tx.get(
        `SELECT id, display_name FROM saml_idp_config
           WHERE enabled = TRUE
             AND id <> $1
             AND allowed_email_domains && $2::text[]
           LIMIT 1`,
        [id, next.allowed_email_domains],
      );
      if (collision) {
        throw Object.assign(
          new Error(`updateIdP: email domain already claimed by IdP "${collision.display_name}"`),
          { status: 409 },
        );
      }
    }
    await tx.run(
      `UPDATE saml_idp_config
          SET display_name = $1, sso_url = $2, slo_url = $3, cert_pem = $4,
              attribute_mapping = $5::jsonb, enabled = $6, jit_provisioning = $7,
              allowed_email_domains = $8, updated_at = NOW()
        WHERE id = $9`,
      [
        next.display_name, next.sso_url, next.slo_url, next.cert_pem,
        next.attribute_mapping, next.enabled, next.jit_provisioning,
        next.allowed_email_domains, id,
      ],
    );
    return getIdP(id);
  });
}

/**
 * Delete an IdP. Refuses if any users are still linked to it -- those
 * users would be locked out otherwise. Operator must explicitly
 * re-provision or convert them to password auth first.
 */
export async function deleteIdP(id) {
  const linkedUsers = await db.get(
    'SELECT COUNT(*) AS cnt FROM users WHERE saml_idp_id = $1 AND deleted_at IS NULL',
    [id],
  );
  if (linkedUsers && parseInt(linkedUsers.cnt, 10) > 0) {
    throw Object.assign(
      new Error(`deleteIdP: ${linkedUsers.cnt} user(s) are linked to this IdP`),
      { status: 409 },
    );
  }
  await db.run('DELETE FROM saml_idp_config WHERE id = $1', [id]);
}

// ─── Attribute mapping resolution ───────────────────────────────────────

function resolveAttributeMapping(value) {
  if (typeof value === 'string') {
    if (!ATTR_PRESETS[value]) {
      throw Object.assign(
        new Error(`Unknown attribute-mapping preset "${value}". Known: ${Object.keys(ATTR_PRESETS).join(', ')}`),
        { status: 400 },
      );
    }
    return { preset: value, ...ATTR_PRESETS[value] };
  }
  if (value && typeof value === 'object') {
    const { email, name, nameId } = value;
    if (typeof email !== 'string' || typeof name !== 'string' || typeof nameId !== 'string') {
      throw Object.assign(
        new Error('attribute_mapping object must have string email/name/nameId fields'),
        { status: 400 },
      );
    }
    return { email, name, nameId };
  }
  throw Object.assign(new Error('attribute_mapping must be a preset name or an object'), { status: 400 });
}

function normaliseEmailDomains(domains) {
  if (!Array.isArray(domains)) return [];
  return domains
    .filter((d) => typeof d === 'string')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d))
    // Dedupe.
    .filter((d, i, arr) => arr.indexOf(d) === i);
}

// ─── Assertion validation ──────────────────────────────────────────────

/**
 * Validate a SAMLResponse against the configured IdP. Wraps
 * @node-saml/node-saml's strict-mode validator.
 *
 * @param {string} idpId
 * @param {string} samlResponseB64 - the SAMLResponse POST body value
 * @param {object} [opts]
 * @param {string} opts.audience  - this SP's entityID (we expect to be
 *                                  in the assertion's Audience)
 * @param {string} opts.callbackUrl - our ACS URL (the assertion's
 *                                    Destination must match)
 * @param {string} opts.spPrivateKey - SP private key PEM (for optional
 *                                     assertion decryption)
 * @returns {Promise<{ nameId, nameIdFormat, email, name, attributes, sessionIndex }>}
 * @throws on any validation failure (signature, audience, expiry, …)
 */
export async function validateAssertion(idpId, samlResponseB64, opts) {
  const idp = await getIdP(idpId);
  if (!idp) throw Object.assign(new Error('validateAssertion: no such IdP'), { status: 404 });

  const saml = new SAML({
    issuer: opts.audience,
    callbackUrl: opts.callbackUrl,
    entryPoint: idp.sso_url,
    idpCert: idp.cert_pem,
    audience: opts.audience,
    privateKey: opts.spPrivateKey,
    // Reject unsigned assertions. node-saml's signing requirement
    // defaults to "either response or assertion signed"; we want both
    // strict for production.
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: true,
    // Clock skew allowance for NotBefore/NotOnOrAfter (default 0,
    // unrealistic for inter-server clocks; 30s is a common bound).
    acceptedClockSkewMs: 30 * 1000,
    // Match a known issuer (the IdP we configured).
    idpIssuer: idp.entity_id,
    identifierFormat: null, // accept whatever the IdP sends
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
  });

  // node-saml's validatePostResponseAsync takes the raw form-encoded
  // body shape { SAMLResponse: <base64>, RelayState: <maybe> }.
  const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponseB64 });
  if (!profile) throw new Error('validateAssertion: empty profile from validator');

  // Extract our four attributes using the configured mapping.
  const attrMap = idp.attribute_mapping;
  const email = pickAttribute(profile, attrMap.email);
  const name = pickAttribute(profile, attrMap.name) || email;
  return {
    nameId: profile.nameID,
    nameIdFormat: profile.nameIDFormat,
    email: typeof email === 'string' ? email.toLowerCase().trim() : null,
    name: typeof name === 'string' ? name.trim() : '',
    sessionIndex: profile.sessionIndex,
    attributes: profile, // raw, for audit
  };
}

function pickAttribute(profile, uri) {
  if (!uri) return null;
  // node-saml gives attributes under their URI keys.
  if (profile[uri] !== undefined) return profile[uri];
  // Some IdPs also expose friendlyName aliases on the profile.
  return null;
}

// ─── JIT provision / link ───────────────────────────────────────────────

/**
 * Either log in an existing SAML-linked user, link an existing password
 * user, or JIT-create a new user.
 *
 * Returns { userId, isNew, isLinked, user } so the caller can audit-log
 * the path that fired.
 *
 * Path 1 -- existing SAML user: matched by (saml_idp_id, saml_name_id).
 * Path 2 -- link: existing password user with same email AND email
 *           domain is in this IdP's allowed_email_domains. Updates the
 *           user to auth_method='saml', sets saml_idp_id / saml_name_id,
 *           NULLs password_hash (per round-1 design decision).
 * Path 3 -- JIT: no user, jit_provisioning enabled, email domain
 *           allowed: create.
 * Refused: any other combination.
 */
export async function jitProvisionOrLink(idpId, attrs) {
  const idp = await getIdP(idpId);
  if (!idp) throw Object.assign(new Error('jitProvisionOrLink: no such IdP'), { status: 404 });
  if (!attrs.email) throw Object.assign(new Error('SAML assertion did not include an email'), { status: 400 });
  if (!attrs.nameId) throw Object.assign(new Error('SAML assertion did not include a NameID'), { status: 400 });

  const emailLower = attrs.email.toLowerCase().trim();
  const domain = emailLower.includes('@') ? emailLower.split('@')[1] : '';
  const domainAllowed = idp.allowed_email_domains.includes(domain);

  return db.transaction(async (tx) => {
    await tx.run('SELECT pg_advisory_xact_lock(hashtext($1))', [`saml-jit:${idpId}:${emailLower}`]);

    // Path 1: SAML-matched user
    const samlUser = await tx.get(
      'SELECT * FROM users WHERE saml_idp_id = $1 AND saml_name_id = $2 AND deleted_at IS NULL',
      [idpId, attrs.nameId],
    );
    if (samlUser) {
      return { userId: samlUser.id, isNew: false, isLinked: false, user: samlUser };
    }

    // Look up by email for paths 2 / 3.
    const emailUser = await tx.get(
      'SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL',
      [emailLower],
    );

    if (emailUser) {
      // Path 2a: confirm-link candidate.
      // The user exists as a password account, in an allowed email
      // domain. Don't link yet -- per the round-2 design decision,
      // require explicit user confirmation. The ACS route handles
      // the interstitial.
      if (emailUser.auth_method === 'password' && domainAllowed) {
        return {
          userId: null,
          isNew: false,
          isLinked: false,
          needsConfirmation: true,
          candidate: {
            existingUserId: emailUser.id,
            email: emailLower,
            existingName: emailUser.name,
          },
        };
      }
      // Refusal: domain mismatch or already linked to a different IdP.
      throw Object.assign(
        new Error('User with this email exists but cannot be linked to this IdP'),
        { status: 409 },
      );
    }

    // Path 3: JIT create
    if (!idp.jit_provisioning || !domainAllowed) {
      throw Object.assign(
        new Error('JIT provisioning refused: not enabled for this IdP or email domain not allowed'),
        { status: 403 },
      );
    }
    const newId = uuid();
    await tx.run(
      `INSERT INTO users (id, email, name, password_hash, email_verified,
                          auth_method, saml_idp_id, saml_name_id)
       VALUES ($1, $2, $3, NULL, TRUE, 'saml', $4, $5)`,
      [newId, emailLower, attrs.name || emailLower, idpId, attrs.nameId],
    );
    const created = await tx.get('SELECT * FROM users WHERE id = $1', [newId]);
    return { userId: newId, isNew: true, isLinked: false, user: created };
  });
}

/**
 * Apply a confirmed link from an existing password user to a SAML
 * identity. Called by the /confirm-link route after the user has
 * explicitly clicked "Yes, link my account" on the interstitial.
 *
 * Safety guards:
 *   - The (idpId, nameId) pair must not already be claimed by a
 *     different user (defends against a session-hijack attacker who
 *     races to claim the same NameID).
 *   - The userId must currently have auth_method='password' AND not
 *     have been linked to a different IdP in the meantime. If they
 *     have, the link is refused (someone else already won).
 *   - The user must not be soft-deleted.
 *
 * Wrapped in a per-user advisory lock so two concurrent confirms
 * for the same account serialise.
 */
export async function confirmSamlLink(userId, idpId, nameId) {
  return db.transaction(async (tx) => {
    await tx.run('SELECT pg_advisory_xact_lock(hashtext($1))', [`saml-link:${userId}`]);

    const user = await tx.get(
      'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL',
      [userId],
    );
    if (!user) {
      throw Object.assign(new Error('confirmSamlLink: user not found'), { status: 404 });
    }
    if (user.auth_method !== 'password') {
      throw Object.assign(
        new Error('confirmSamlLink: account is not in password mode (already linked or SAML-native)'),
        { status: 409 },
      );
    }
    // Race-condition guard: did someone else already grab this
    // (idpId, nameId) pair?
    const taken = await tx.get(
      'SELECT id FROM users WHERE saml_idp_id = $1 AND saml_name_id = $2 AND deleted_at IS NULL',
      [idpId, nameId],
    );
    if (taken) {
      throw Object.assign(
        new Error('confirmSamlLink: this SAML identity is already linked to another account'),
        { status: 409 },
      );
    }

    await tx.run(
      `UPDATE users SET
         auth_method = 'saml',
         saml_idp_id = $1,
         saml_name_id = $2,
         password_hash = NULL,
         email_verified = TRUE
       WHERE id = $3`,
      [idpId, nameId, userId],
    );
    return tx.get('SELECT * FROM users WHERE id = $1', [userId]);
  });
}

/**
 * Public-facing list of enabled IdPs. Used by the login page to
 * render the "Continue with <IdP>" buttons (Pattern B). Returns only
 * the fields safe to expose to anonymous visitors -- display name +
 * login URL. The cert, allowed_email_domains, attribute mapping,
 * etc. stay internal.
 */
export async function listPublicIdPs() {
  const rows = await db.all(
    `SELECT id, display_name FROM saml_idp_config
       WHERE enabled = TRUE
       ORDER BY display_name`,
  );
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    loginUrl: `/api/auth/saml/${r.id}/login`,
  }));
}

// Test-only helpers.
export const _testing = {
  KEYPAIR_ID,
  KEY_VALIDITY_DAYS,
  resetCache: () => { _cached = null; },
  setCache: (v) => { _cached = v; },
  normaliseEmailDomains,
  resolveAttributeMapping,
  wrapBase64AsPem,
};
