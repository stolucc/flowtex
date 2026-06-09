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
import selfsigned from 'selfsigned';
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

// Test-only helpers.
export const _testing = {
  KEYPAIR_ID,
  KEY_VALIDITY_DAYS,
  resetCache: () => { _cached = null; },
  setCache: (v) => { _cached = v; },
};
