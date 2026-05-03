import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.resolve(__dirname, '..', '..', 'projects');

/**
 * Redact filesystem paths from text emitted to clients (compile logs, error messages).
 * Strips Unix and Windows-style absolute paths, file:// URIs, the on-disk projects directory,
 * and any project UUID it contains.
 */
export function stripPaths(text) {
  if (text == null) return text;
  let out = String(text);
  out = out.replace(new RegExp(PROJECTS_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<projects>');
  out = out.replace(/file:\/\/[^\s)"]+/g, '<file>');
  out = out.replace(/(?:[A-Za-z]:)?[\\/](?:[^\s\\/:)"]+[\\/])+/g, '<path>/');
  out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>');
  return out;
}

/** Format an error message for client display, with paths stripped. */
export function safeMsg(err, fallback = 'Internal server error') {
  return stripPaths(err?.message || fallback);
}

/** Send a JSON error response using the error's status (default 500). */
export function sendError(res, err) {
  const status = err.status || 500;
  // Only expose the message for intentional application errors (status explicitly set).
  // For unexpected 500s, return a generic message to avoid leaking internals.
  const message = err.status ? err.message : 'Internal server error';
  res.status(status).json({ error: message });
}
