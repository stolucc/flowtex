// @ts-check
// Service-level bridge between the raw crypto primitives
// (utils/projectCrypto.js), the unlocked-DEK cache
// (projectKeyCache.js), and the read/write paths that move
// files.content in and out of the DB.
//
// One job: given a projectId, transparently encrypt on write and
// decrypt on read WHEN the project is encrypted, and throw a
// 423-shaped "locked" error when it's encrypted but no DEK is cached
// (server restarted, or the user never unlocked this session).
//
// Plaintext projects (the default) pass straight through with a single
// cheap boolean check.

import db from '../db.js';
import { encryptFileContent, decryptFileContent } from '../utils/projectCrypto.js';
import { getProjectDEK, isProjectUnlocked } from './projectKeyCache.js';

/** Error thrown when an encrypted project is accessed without an
 *  unlocked DEK. Routes map `.status` to HTTP 423 (Locked). */
export class ProjectLockedError extends Error {
  /** @param {string} projectId */
  constructor(projectId) {
    super(`Project ${projectId} is encrypted and locked`);
    this.name = 'ProjectLockedError';
    this.status = 423;
    this.projectId = projectId;
  }
}

/**
 * Is this project encrypted? Cheap single-column lookup. Accepts an
 * optional tx so callers inside a transaction stay consistent.
 *
 * @param {string} projectId
 * @param {{ get: (sql: string, params?: unknown[]) => Promise<any> }} [tx]
 * @returns {Promise<boolean>}
 */
export async function isProjectEncrypted(projectId, tx) {
  const runner = tx || db;
  const row = await runner.get('SELECT encrypted FROM projects WHERE id = $1', [projectId]);
  return !!row?.encrypted;
}

/**
 * Resolve the encryption context for a project once, so a caller doing
 * many rows doesn't re-query the flag per row.
 *
 * @param {string} projectId
 * @param {{ get: (sql: string, params?: unknown[]) => Promise<any> }} [tx]
 * @returns {Promise<{ encrypted: boolean, dek: Buffer | null }>}
 */
export async function getEncryptionContext(projectId, tx) {
  const encrypted = await isProjectEncrypted(projectId, tx);
  if (!encrypted) return { encrypted: false, dek: null };
  const dek = getProjectDEK(projectId);
  if (!dek) throw new ProjectLockedError(projectId);
  return { encrypted: true, dek };
}

/**
 * Encrypt a single file's content for storage IF the project is
 * encrypted; otherwise return it unchanged. Throws ProjectLockedError
 * when encrypted but locked.
 *
 * @param {string} projectId
 * @param {string} content plaintext
 * @param {{ get: (sql: string, params?: unknown[]) => Promise<any> }} [tx]
 * @returns {Promise<string>} ciphertext (base64) or original plaintext
 */
export async function encryptContentForStorage(projectId, content, tx) {
  const ctx = await getEncryptionContext(projectId, tx);
  if (!ctx.encrypted) return content;
  return encryptFileContent(content, /** @type {Buffer} */ (ctx.dek));
}

/**
 * Decrypt file rows in place IF the project is encrypted. Each row's
 * `content` (when non-null and the row is not binary) is replaced with
 * its plaintext. No-op for plaintext projects. Throws
 * ProjectLockedError when encrypted but locked.
 *
 * @template {{ content?: string | null, is_binary?: boolean }} R
 * @param {string} projectId
 * @param {R[]} rows
 * @param {{ get: (sql: string, params?: unknown[]) => Promise<any> }} [tx]
 * @returns {Promise<R[]>} the same array (mutated) for convenience
 */
export async function decryptRowsForRead(projectId, rows, tx) {
  const ctx = await getEncryptionContext(projectId, tx);
  if (!ctx.encrypted) return rows;
  const dek = /** @type {Buffer} */ (ctx.dek);
  for (const row of rows) {
    if (row.is_binary) continue;
    if (typeof row.content !== 'string' || row.content.length === 0) continue;
    row.content = decryptFileContent(row.content, dek);
  }
  return rows;
}

/**
 * Decrypt a single content string IF the project is encrypted.
 *
 * @param {string} projectId
 * @param {string | null | undefined} content
 * @param {{ get: (sql: string, params?: unknown[]) => Promise<any> }} [tx]
 * @returns {Promise<string | null | undefined>}
 */
export async function decryptContentForRead(projectId, content, tx) {
  if (typeof content !== 'string' || content.length === 0) return content;
  const ctx = await getEncryptionContext(projectId, tx);
  if (!ctx.encrypted) return content;
  return decryptFileContent(content, /** @type {Buffer} */ (ctx.dek));
}

export { isProjectUnlocked };
