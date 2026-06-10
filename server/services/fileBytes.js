// @ts-check
// Single source of truth for "give me the bytes for this file row."
// Binary rows are streamed from the per-project blob store; text rows
// return their content string. Every code path that needs the raw
// bytes (compile sync, ZIP export, project duplication) uses this
// helper.
//
// File rows passed in MUST have at least: { path, content, is_binary,
// binary_sha256 } — add binary_sha256 to your SELECT list if you don't
// already.
//
// SAAS-FOUNDATIONS item 2 phase 2.5: routes through services/
// blobPersistor.js instead of importing blobStore's FS-specific
// blobPath directly. When the persistor's backend is FS this is
// identical to the prior code; when the persistor switches to S3
// (FLOWTEX_BLOB_BACKEND=s3) bytes stream from the remote store with
// no edits here.

import { loadBlobBytes } from './blobPersistor.js';

/**
 * Resolve a file row to its bytes.
 *
 * @param {string} projectId
 * @param {{ path: string, content: string|null, is_binary: boolean,
 *           binary_sha256?: string|null }} file
 * @returns {Promise<Buffer|string>} Buffer for binary rows, string for text.
 */
export async function loadFileBytes(projectId, file) {
  if (!file.is_binary) {
    return file.content ?? '';
  }
  if (!file.binary_sha256) {
    // Invariant since phase C.2: every binary row carries a blob sha256.
    // A row that doesn't would be a code-path regression; surface it
    // loudly rather than silently returning an empty Buffer.
    throw new Error(`binary file row ${file.path} missing binary_sha256`);
  }
  const bytes = await loadBlobBytes(projectId, file.binary_sha256);
  if (!bytes) {
    // The blob row exists but neither primary nor fallback backend
    // has the data. Surface the same shape ENOENT used to produce
    // so callers don't have to change their error handling.
    // Node's standard Error doesn't declare .code, but callers grep
    // for it as the ENOENT-shape error contract. Cast to a typed
    // shape on assignment so the JSDoc-aware checker accepts it
    // without losing the runtime behaviour.
    const err = /** @type {Error & { code: string }} */ (
      new Error(`blob for ${file.path} (${file.binary_sha256}) not found`)
    );
    err.code = 'ENOENT';
    throw err;
  }
  return bytes;
}
