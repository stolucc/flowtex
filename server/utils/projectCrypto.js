// @ts-check
// Per-project at-rest encryption primitives (Phase 1 — pure crypto,
// no DB, no UI).
//
// Model (see project plan):
//   - DEK: 32 random bytes per project. Encrypts every files.content
//     row directly with AES-256-GCM.
//   - KEK: derived from a passphrase via Argon2id with a per-project
//     salt + tunable kdf params. Wraps (AES-256-GCM-encrypts) the DEK.
//   - The DEK is wrapped TWICE — once under the passphrase KEK, once
//     under a recovery-code KEK — so either secret can unlock it.
//
// This module is deliberately storage-agnostic: it returns/accepts
// plain strings + buffers. The DB schema, key cache, and routes are
// later phases.
//
// IMPORTANT (threat model): this protects DB dumps / backup theft /
// SQL-injection exfil of files.content. It does NOT protect against a
// compromised server — cleartext exists on disk during compile, and
// the unlocked DEK lives in server memory. Do not reuse the
// `server/utils/crypto.js` salt (that key protects TOTP/GitHub tokens
// and is a different purpose); per-project salts are generated here.

import { randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';

const DEK_BYTES = 32;          // AES-256
const IV_BYTES = 12;           // GCM standard nonce
const TAG_BYTES = 16;          // GCM auth tag
const SALT_BYTES = 16;
const RECOVERY_CODE_CHARS = 32; // 32 base32 chars (~160 bits via %32)

/**
 * Default Argon2id cost params for KEK derivation. Stored per-project
 * in `kdf_params` so they can be rotated without breaking old wraps
 * (each project records the params it was wrapped with).
 *
 * 64 MiB / t=3 / p=1 mirrors passwordHash.js — ~250-500 ms per derive,
 * paid once per unlock per session.
 *
 * @typedef {{ type: 'argon2id', memoryCost: number, timeCost: number, parallelism: number }} KdfParams
 * @type {KdfParams}
 */
export const DEFAULT_KDF_PARAMS = {
  type: 'argon2id',
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
};

/** @returns {Buffer} 32 fresh random bytes for a new project DEK. */
export function generateDEK() {
  return randomBytes(DEK_BYTES);
}

/** @returns {Buffer} a fresh per-project KDF salt. */
export function generateSalt() {
  return randomBytes(SALT_BYTES);
}

/**
 * Generate a human-transcribable recovery code: Crockford-ish base32,
 * uppercase, grouped in 4s for readability (e.g. ABCD-EFGH-...). The
 * grouping hyphens are cosmetic — deriveKEK strips non-alphanumerics
 * before use, so the user can type it with or without them.
 *
 * @returns {string}
 */
export function generateRecoveryCode() {
  // Crockford base32 alphabet (no I/L/O/U to avoid transcription
  // ambiguity).
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const raw = randomBytes(RECOVERY_CODE_CHARS);
  let out = '';
  for (let i = 0; i < RECOVERY_CODE_CHARS; i++) {
    out += ALPHABET[raw[i] % 32];
  }
  // Group into blocks of 4.
  return out.replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

/**
 * Normalise a user-entered recovery code: strip whitespace + hyphens,
 * uppercase. So "abcd-efgh" and "ABCDEFGH" derive the same KEK.
 * @param {string} code
 */
export function normalizeRecoveryCode(code) {
  return String(code).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/**
 * Derive a 32-byte KEK from a secret (passphrase OR normalised
 * recovery code) using Argon2id with the given salt + params.
 *
 * @param {string} secret
 * @param {Buffer} salt
 * @param {KdfParams} [params]
 * @returns {Promise<Buffer>} 32-byte key
 */
export async function deriveKEK(secret, salt, params = DEFAULT_KDF_PARAMS) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('deriveKEK: secret must be a non-empty string');
  }
  if (!Buffer.isBuffer(salt) || salt.length === 0) {
    throw new Error('deriveKEK: salt must be a non-empty Buffer');
  }
  const key = await argon2.hash(secret, {
    type: argon2.argon2id,
    memoryCost: params.memoryCost,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
    salt,
    hashLength: DEK_BYTES,
    raw: true,
  });
  return /** @type {Buffer} */ (key);
}

/**
 * AES-256-GCM encrypt `plaintextBuf` under `key`. Returns the packed
 * buffer IV(12) || ciphertext || tag(16).
 *
 * @param {Buffer} plaintextBuf
 * @param {Buffer} key 32 bytes
 * @returns {Buffer}
 */
function gcmEncrypt(plaintextBuf, key) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

/**
 * Reverse of gcmEncrypt. Throws if the tag doesn't verify (wrong key
 * or tampering).
 *
 * @param {Buffer} packed IV(12) || ciphertext || tag(16)
 * @param {Buffer} key 32 bytes
 * @returns {Buffer} plaintext
 */
function gcmDecrypt(packed, key) {
  if (!Buffer.isBuffer(packed) || packed.length < IV_BYTES + TAG_BYTES) {
    throw new Error('gcmDecrypt: ciphertext too short');
  }
  const iv = packed.subarray(0, IV_BYTES);
  const tag = packed.subarray(packed.length - TAG_BYTES);
  const ct = packed.subarray(IV_BYTES, packed.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Wrap (encrypt) a DEK under a KEK. Returns base64(IV || ct || tag).
 *
 * @param {Buffer} dek 32 bytes
 * @param {Buffer} kek 32 bytes
 * @returns {string} base64 wrapped DEK
 */
export function wrapDEK(dek, kek) {
  if (!Buffer.isBuffer(dek) || dek.length !== DEK_BYTES) {
    throw new Error('wrapDEK: dek must be 32 bytes');
  }
  if (!Buffer.isBuffer(kek) || kek.length !== DEK_BYTES) {
    throw new Error('wrapDEK: kek must be 32 bytes');
  }
  return gcmEncrypt(dek, kek).toString('base64');
}

/**
 * Unwrap (decrypt) a DEK previously wrapped with wrapDEK. Throws on a
 * wrong KEK (GCM tag mismatch).
 *
 * @param {string} wrapped base64 from wrapDEK
 * @param {Buffer} kek 32 bytes
 * @returns {Buffer} the 32-byte DEK
 */
export function unwrapDEK(wrapped, kek) {
  if (typeof wrapped !== 'string' || wrapped.length === 0) {
    throw new Error('unwrapDEK: wrapped must be a non-empty base64 string');
  }
  const dek = gcmDecrypt(Buffer.from(wrapped, 'base64'), kek);
  if (dek.length !== DEK_BYTES) {
    throw new Error('unwrapDEK: decrypted DEK has wrong length');
  }
  return dek;
}

/**
 * Encrypt a file's text content under the project DEK. Returns
 * base64(IV || ciphertext || tag) suitable for storage in the
 * (still-TEXT) files.content column.
 *
 * @param {string} plaintext UTF-8 file content
 * @param {Buffer} dek
 * @returns {string}
 */
export function encryptFileContent(plaintext, dek) {
  if (typeof plaintext !== 'string') {
    throw new Error('encryptFileContent: plaintext must be a string');
  }
  return gcmEncrypt(Buffer.from(plaintext, 'utf8'), dek).toString('base64');
}

/**
 * Decrypt content produced by encryptFileContent. Throws on wrong DEK
 * or tampering (GCM tag mismatch).
 *
 * @param {string} blob base64 from encryptFileContent
 * @param {Buffer} dek
 * @returns {string} UTF-8 plaintext
 */
export function decryptFileContent(blob, dek) {
  if (typeof blob !== 'string') {
    throw new Error('decryptFileContent: blob must be a string');
  }
  return gcmDecrypt(Buffer.from(blob, 'base64'), dek).toString('utf8');
}

/**
 * Constant-time compare of two buffers (e.g. comparing an unwrapped
 * DEK against an expected value in tests / sanity checks). Returns
 * false on length mismatch without leaking via timing.
 *
 * @param {Buffer} a
 * @param {Buffer} b
 */
export function buffersEqual(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
