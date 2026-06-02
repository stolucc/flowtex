// Single source of truth for "give me the bytes for this file row" —
// works whether the row is a legacy base64-in-DB binary, a blob-stored
// binary (Phase A.2+), or a plain text row.
//
// Every code path that needs the raw bytes (compile sync, ZIP export,
// future migrators) should use this helper. The dual-mode logic lives
// here ONLY; callers pass a row dict and get back a Buffer (binary) or
// string (text).
//
// File rows passed in MUST have at least: { path, content, is_binary,
// binary_sha256 } — add binary_sha256 to your SELECT list if you don't
// already.

import { readFile } from 'node:fs/promises';
import { blobPath } from './blobStore.js';

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
  // Phase A.2+ binary row: bytes live in the blob store.
  if (file.binary_sha256) {
    return readFile(blobPath(projectId, file.binary_sha256));
  }
  // Legacy binary row: base64-in-content. (Should be empty after the
  // production purge, but keep the read path tolerant.)
  return Buffer.from(file.content || '', 'base64');
}
