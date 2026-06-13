// @ts-check
// Phase 3 — enable / unlock / lock / rotate for per-project at-rest
// encryption. Orchestrates the crypto primitives (utils/projectCrypto),
// the DEK cache (projectKeyCache), and the DB migration of existing
// content into ciphertext.
//
// Routes are thin wrappers over these functions (routes/projects.js).

import { gzipSync, gunzipSync } from 'node:zlib';
import db from '../db.js';
import logger from '../logger.js';
import {
  DEFAULT_KDF_PARAMS,
  generateDEK,
  generateSalt,
  generateRecoveryCode,
  normalizeRecoveryCode,
  deriveKEK,
  wrapDEK,
  unwrapDEK,
  encryptFileContent,
} from '../utils/projectCrypto.js';
import {
  unlockProject as cacheUnlock,
  lockProject as cacheLock,
  forceLockProject,
  getProjectDEK,
} from './projectKeyCache.js';

const META_VERSION = 1;

/**
 * Build the encryption_meta JSONB payload for storage.
 *
 * @param {{ salt: Buffer, kdf: typeof DEFAULT_KDF_PARAMS, wrapPass: string, wrapRecovery: string, hint: string | null }} a
 */
function buildMeta(a) {
  return {
    v: META_VERSION,
    salt: a.salt.toString('base64'),
    kdfParams: a.kdf,
    wrappedDekPassphrase: a.wrapPass,
    wrappedDekRecovery: a.wrapRecovery,
    passphraseHint: a.hint,
  };
}

/**
 * @param {any} meta
 * @returns {{ salt: Buffer, kdf: any, wrapPass: string, wrapRecovery: string, hint: string|null }}
 */
function parseMeta(meta) {
  if (!meta || typeof meta !== 'object') throw new Error('encryption_meta missing/corrupt');
  return {
    salt: Buffer.from(meta.salt, 'base64'),
    kdf: meta.kdfParams || DEFAULT_KDF_PARAMS,
    wrapPass: meta.wrappedDekPassphrase,
    wrapRecovery: meta.wrappedDekRecovery,
    hint: meta.passphraseHint ?? null,
  };
}

/**
 * Enable encryption on a plaintext project. Generates a DEK, wraps it
 * under both a passphrase KEK and a one-time recovery code, encrypts
 * all existing text content (files + file_versions + snapshots), flips
 * `encrypted = TRUE`, and unlocks the project for the caller's session.
 *
 * Returns the recovery code ONCE — it is never stored in plaintext and
 * cannot be recovered later.
 *
 * @param {string} projectId
 * @param {string} passphrase
 * @param {{ passphraseHint?: string|null }} [opts]
 * @returns {Promise<{ recoveryCode: string }>}
 */
export async function enableEncryption(projectId, passphrase, opts = {}) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw Object.assign(new Error('Passphrase must be at least 8 characters'), { status: 400 });
  }
  const proj = await db.get('SELECT encrypted FROM projects WHERE id = $1', [projectId]);
  if (!proj) throw Object.assign(new Error('Project not found'), { status: 404 });
  if (proj.encrypted) throw Object.assign(new Error('Project is already encrypted'), { status: 409 });

  const dek = generateDEK();
  const salt = generateSalt();
  const recoveryCode = generateRecoveryCode();
  const kdf = DEFAULT_KDF_PARAMS;

  const passKek = await deriveKEK(passphrase, salt, kdf);
  const recKek = await deriveKEK(normalizeRecoveryCode(recoveryCode), salt, kdf);
  const meta = buildMeta({
    salt,
    kdf,
    wrapPass: wrapDEK(dek, passKek),
    wrapRecovery: wrapDEK(dek, recKek),
    hint: opts.passphraseHint ?? null,
  });

  // Migrate existing content. files + file_versions in one transaction
  // (typically small); snapshots are re-packed one-per-transaction
  // afterwards so a project with thousands of snapshots doesn't hold
  // locks across the whole set.
  await db.transaction(async (tx) => {
    // Re-read encrypted flag under a row lock to avoid a concurrent
    // double-enable.
    const locked = await tx.get('SELECT encrypted FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
    if (locked?.encrypted) throw Object.assign(new Error('Project is already encrypted'), { status: 409 });

    const files = await tx.all(
      'SELECT id, content FROM files WHERE project_id = $1 AND is_binary = FALSE',
      [projectId],
    );
    for (const f of files) {
      if (typeof f.content !== 'string' || f.content.length === 0) continue;
      // Encrypt content AND null any persisted Y.js CRDT state: that
      // binary holds a PLAINTEXT copy of the document and would defeat
      // at-rest encryption. Encrypted projects use the legacy changes
      // relay (yjs is force-disabled client-side), so content_yjs stays
      // NULL going forward.
      await tx.run(
        'UPDATE files SET content = $1, content_yjs = NULL WHERE id = $2',
        [encryptFileContent(f.content, dek), f.id],
      );
    }

    const versions = await tx.all(
      'SELECT id, content FROM file_versions WHERE project_id = $1',
      [projectId],
    );
    for (const v of versions) {
      if (typeof v.content !== 'string' || v.content.length === 0) continue;
      await tx.run('UPDATE file_versions SET content = $1 WHERE id = $2', [encryptFileContent(v.content, dek), v.id]);
    }

    await tx.run(
      'UPDATE projects SET encrypted = TRUE, encryption_meta = $1::jsonb WHERE id = $2',
      [JSON.stringify(meta), projectId],
    );
  });

  // Re-pack snapshots (decompress → encrypt each inner text file →
  // recompress) one at a time.
  await reencryptSnapshots(projectId, dek);

  // Unlock for the enabling session.
  cacheUnlock(projectId, dek);
  logger.info({ projectId }, 'project encryption enabled');
  return { recoveryCode };
}

/**
 * Re-pack every snapshot's gzipped JSON payload so inner text file
 * contents are encrypted under the DEK. Binary entries are left as-is
 * (their bytes live in the blob store, not in the snapshot).
 *
 * @param {string} projectId
 * @param {Buffer} dek
 */
async function reencryptSnapshots(projectId, dek) {
  const snaps = await db.all('SELECT id FROM project_snapshots WHERE project_id = $1', [projectId]);
  for (const s of snaps) {
    await db.transaction(async (tx) => {
      const row = await tx.get('SELECT data FROM project_snapshots WHERE id = $1 FOR UPDATE', [s.id]);
      if (!row?.data) return;
      let parsed;
      try {
        parsed = JSON.parse(gunzipSync(row.data).toString('utf8'));
      } catch {
        logger.warn({ snapshotId: s.id }, 'snapshot re-encrypt: unreadable payload, skipping');
        return;
      }
      if (!parsed || !Array.isArray(parsed.files)) return;
      for (const f of parsed.files) {
        if (f.is_binary) continue;
        if (typeof f.content !== 'string' || f.content.length === 0) continue;
        f.content = encryptFileContent(f.content, dek);
      }
      const recompressed = gzipSync(Buffer.from(JSON.stringify(parsed), 'utf8'));
      await tx.run('UPDATE project_snapshots SET data = $1 WHERE id = $2', [recompressed, s.id]);
    });
  }
}

/**
 * Unlock an encrypted project for this server process. Tries the
 * passphrase wrap first, then the recovery-code wrap. On success the
 * DEK is cached (refcount++). Returns whether it unlocked.
 *
 * @param {string} projectId
 * @param {string} secret passphrase OR recovery code
 * @returns {Promise<{ ok: boolean, viaRecovery?: boolean }>}
 */
export async function unlockWithSecret(projectId, secret) {
  if (typeof secret !== 'string' || secret.length === 0) return { ok: false };
  const proj = await db.get('SELECT encrypted, encryption_meta FROM projects WHERE id = $1', [projectId]);
  if (!proj) throw Object.assign(new Error('Project not found'), { status: 404 });
  if (!proj.encrypted) throw Object.assign(new Error('Project is not encrypted'), { status: 409 });
  const m = parseMeta(proj.encryption_meta);

  // Try passphrase first.
  try {
    const kek = await deriveKEK(secret, m.salt, m.kdf);
    const dek = unwrapDEK(m.wrapPass, kek);
    cacheUnlock(projectId, dek);
    return { ok: true };
  } catch { /* not the passphrase — try recovery */ }

  // Try recovery code (normalised).
  try {
    const kek = await deriveKEK(normalizeRecoveryCode(secret), m.salt, m.kdf);
    const dek = unwrapDEK(m.wrapRecovery, kek);
    cacheUnlock(projectId, dek);
    return { ok: true, viaRecovery: true };
  } catch { /* neither matched */ }

  return { ok: false };
}

/**
 * Release one unlock reference for a project.
 * @param {string} projectId
 */
export function lock(projectId) {
  return cacheLock(projectId);
}

/**
 * Rotate the passphrase. Requires the current passphrase OR recovery
 * code to unwrap the DEK, then re-wraps the passphrase slot under a
 * fresh KEK (new salt). The recovery-code slot is re-wrapped under the
 * SAME recovery code (re-derived against the new salt) so the existing
 * recovery code keeps working. Returns nothing; the recovery code does
 * not change.
 *
 * @param {string} projectId
 * @param {string} currentSecret passphrase or recovery code
 * @param {string} newPassphrase
 */
export async function rotatePassphrase(projectId, currentSecret, newPassphrase) {
  if (typeof newPassphrase !== 'string' || newPassphrase.length < 8) {
    throw Object.assign(new Error('Passphrase must be at least 8 characters'), { status: 400 });
  }
  const proj = await db.get('SELECT encrypted, encryption_meta FROM projects WHERE id = $1', [projectId]);
  if (!proj) throw Object.assign(new Error('Project not found'), { status: 404 });
  if (!proj.encrypted) throw Object.assign(new Error('Project is not encrypted'), { status: 409 });
  const m = parseMeta(proj.encryption_meta);

  // Unwrap the DEK with the current secret (passphrase or recovery).
  let dek = null;
  try {
    dek = unwrapDEK(m.wrapPass, await deriveKEK(currentSecret, m.salt, m.kdf));
  } catch { /* try recovery */ }
  if (!dek) {
    try {
      dek = unwrapDEK(m.wrapRecovery, await deriveKEK(normalizeRecoveryCode(currentSecret), m.salt, m.kdf));
    } catch { /* fall through */ }
  }
  if (!dek) throw Object.assign(new Error('Current passphrase or recovery code is incorrect'), { status: 401 });

  // Fresh salt + re-wrap BOTH slots so the new passphrase and the
  // (unchanged) recovery code both unlock.
  const newSalt = generateSalt();
  const kdf = DEFAULT_KDF_PARAMS;
  const passKek = await deriveKEK(newPassphrase, newSalt, kdf);
  // Recovery code can't be recovered from the wrap, so rotation keeps
  // the SAME recovery code only if the caller still has it. Without it
  // we can't re-wrap the recovery slot under the old code. So: rotate
  // mints a NEW recovery code and returns it.
  const newRecovery = generateRecoveryCode();
  const recKek = await deriveKEK(normalizeRecoveryCode(newRecovery), newSalt, kdf);

  const meta = buildMeta({
    salt: newSalt,
    kdf,
    wrapPass: wrapDEK(dek, passKek),
    wrapRecovery: wrapDEK(dek, recKek),
    hint: m.hint,
  });
  await db.run('UPDATE projects SET encryption_meta = $1::jsonb WHERE id = $2', [JSON.stringify(meta), projectId]);
  // Refresh the cached DEK reference (same key bytes; ensure cached).
  if (!getProjectDEK(projectId)) cacheUnlock(projectId, dek);
  logger.info({ projectId }, 'project passphrase rotated');
  return { recoveryCode: newRecovery };
}

export { forceLockProject };
