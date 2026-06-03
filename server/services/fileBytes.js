// Single source of truth for "give me the bytes for this file row."
// Binary rows are streamed from the per-project blob store; text rows
// return their content string. Every code path that needs the raw
// bytes (compile sync, ZIP export, project duplication) uses this
// helper.
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
  if (!file.binary_sha256) {
    // Invariant since phase C.2: every binary row carries a blob sha256.
    // A row that doesn't would be a code-path regression; surface it
    // loudly rather than silently returning an empty Buffer.
    throw new Error(`binary file row ${file.path} missing binary_sha256`);
  }
  return readFile(blobPath(projectId, file.binary_sha256));
}
