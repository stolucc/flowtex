// @ts-check

/**
 * Decide the HTTP request body for a file save. Pure logic, split out of
 * useProject.handleSave so it can be unit- and mutation-tested without a
 * React render.
 *
 * `content === undefined` means a Y.js marks-only save: the Y.Doc and its
 * server-side snapshot own the document text, so we must NOT send content
 * (sending it would null content_yjs and 409 against the snapshot's
 * version bump) and must NOT send baseVersion (the CRDT owns ordering, so
 * there is no stale-save conflict to detect). Only the tc_marks sidecar
 * is persisted. With no marks either, there is nothing to persist at all
 * and the caller should skip the request.
 *
 * @param {{ content?: string, tcMarks?: any[], baseVersion?: any }} args
 * @returns {{ skip: boolean, contentless: boolean, body?: Record<string, any> }}
 */
export function buildFileSaveBody({ content, tcMarks, baseVersion }) {
  const contentless = content === undefined;
  // Marks-only with no marks => nothing to write.
  if (contentless && !Array.isArray(tcMarks)) return { skip: true, contentless };

  /** @type {Record<string, any>} */
  const body = {};
  if (!contentless) body.content = content;
  if (Array.isArray(tcMarks)) body.tcMarks = tcMarks;
  // baseVersion conflict detection applies only to content writes.
  if (!contentless && baseVersion) body.baseVersion = baseVersion;

  return { skip: false, contentless, body };
}
