// @ts-check
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.resolve(__dirname, '..', '..', 'projects');

/**
 * Redact filesystem paths from text emitted to clients (compile logs, error messages).
 * Strips Unix and Windows-style absolute paths, file:// URIs, the on-disk projects directory,
 * and any project UUID it contains.
 */
/** @param {string | null | undefined} text */
export function stripPaths(text) {
  if (text == null) return text;
  let out = String(text);
  // PROJECTS_DIR is a server-controlled constant — the regex constructor's
  // dynamic argument is safe and the replaceAll metachar-escape pass
  // makes the result a literal-match regex. ReDoS-reviewed 2026-06-02.
  // eslint-disable-next-line security/detect-non-literal-regexp
  out = out.replace(new RegExp(PROJECTS_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<projects>');
  out = out.replace(/file:\/\/[^\s)"]+/g, '<file>');
  // Path-strip regex: optional drive letter then alternating literal slash
  // + non-empty path segment. The required trailing slash after each
  // segment prevents backtrack ambiguity. Input is server error messages.
  // eslint-disable-next-line security/detect-unsafe-regex
  out = out.replace(/(?:[A-Za-z]:)?[\\/](?:[^\s\\/:)"]+[\\/])+/g, '<path>/');
  out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>');
  return out;
}

/** Format an error message for client display, with paths stripped.
 *  @param {{ message?: string } | null | undefined} err
 *  @param {string} [fallback]
 */
export function safeMsg(err, fallback = 'Internal server error') {
  return stripPaths(err?.message || fallback);
}

/** Narrow an unknown caught error to its status + message contract.
 *  Returns the shape every route uses internally; never throws.
 *  @param {unknown} err
 *  @returns {{ status: number | undefined, message: string | undefined }}
 */
export function errInfo(err) {
  const e = /** @type {{ status?: number, message?: string }} */ (
    err && typeof err === 'object' ? err : {}
  );
  return { status: e.status, message: e.message };
}

/** Send a JSON error response using the error's status (default 500).
 *  Accepts `unknown` because most call sites are `catch (err)` blocks,
 *  where TypeScript types the error as `unknown`. Narrows internally.
 *  @param {import('express').Response} res
 *  @param {unknown} err
 */
export function sendError(res, err) {
  const e = /** @type {{ status?: number, message?: string }} */ (
    err && typeof err === 'object' ? err : {}
  );
  const status = e.status || 500;
  // Only expose the message for intentional application errors (status explicitly set).
  // For unexpected 500s, return a generic message to avoid leaking internals.
  const message = e.status ? e.message : 'Internal server error';
  res.status(status).json({ error: message });
}
