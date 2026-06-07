// YJS-MIGRATION phase 4 — Y.RelativePosition helpers.
//
// Comments (and later tracked changes) need to point at a span of
// characters that survives concurrent edits by other users. The legacy
// model stores absolute integer offsets in `comments.from_pos` /
// `to_pos`; those drift on every insertion or deletion ahead of the
// span, and the client has to compensate at render time.
//
// Y.RelativePosition is the CRDT-native answer: a stable identifier
// for a character position that follows the character through edits.
// We encode it to bytes for storage in PG (BYTEA) and decode it on
// read.
//
// Two helpers, deliberately tiny:
//
//   makeAnchorBytes(ytext, index)
//     -> Buffer | null         (serialised Y.RelativePosition)
//
//   resolveAnchor(ydoc, bytes)
//     -> number | null         (absolute index in the current Y.Text)
//
// Both round-trip through Y.js's own encoding so the wire/disk shape
// matches what the upstream library produces and consumes. Helpers are
// stateless and safe to call from any layer (services, WS handlers,
// migration scripts).

import * as Y from 'yjs';
import db from '../db.js';
import logger from '../logger.js';

/**
 * Serialise a Y.RelativePosition for the given index of the
 * provided Y.Text into a Buffer suitable for storage in a BYTEA
 * column. Returns null when the inputs are unusable so callers can
 * fall back to absolute offsets without crashing.
 *
 * `side` controls what happens when text is inserted AT the anchor's
 * index by a concurrent user:
 *
 *   'right' (default): anchor binds to the character to the right
 *     of the index. Insertion at this index pushes the anchor's
 *     resolved index forward. Right behaviour for the START of a
 *     comment span -- the comment stays on the same original
 *     characters when text is prepended.
 *
 *   'left': anchor binds to the character to the left of the index.
 *     Insertion at this index does NOT push the anchor. Right
 *     behaviour for the END of a comment span -- the comment does
 *     NOT auto-extend when the user types immediately after it.
 *
 * Insertions strictly INSIDE the [start, end) range push only the
 * end anchor forward (assuming side='left'), correctly growing the
 * comment to include the new text.
 *
 * @param {Y.Text} ytext  the live Y.Text inside an active Y.Doc
 * @param {number} index  0-based absolute index
 * @param {object} [opts]
 * @param {'left'|'right'} [opts.side='right']
 */
export function makeAnchorBytes(ytext, index, opts = {}) {
  if (!ytext || typeof index !== 'number' || index < 0 || !Number.isInteger(index)) {
    return null;
  }
  // Defensive cap: indexes past the end of the text become end-of-text
  // anchors. That matches the legacy `Math.min(to_pos, length)` clamp
  // and keeps "comment past the end" rows from throwing here.
  const clamped = Math.min(index, ytext.length);
  const assoc = opts.side === 'left' ? -1 : 0;
  let rel;
  try {
    rel = Y.createRelativePositionFromTypeIndex(ytext, clamped, assoc);
  } catch {
    return null;
  }
  try {
    return Buffer.from(Y.encodeRelativePosition(rel));
  } catch {
    return null;
  }
}

/**
 * Inverse: decode a stored Y.RelativePosition and resolve it against
 * the supplied Y.Doc. Returns the absolute index in the doc's Y.Text
 * named 'content', or null if the anchor can't be resolved (item was
 * garbage-collected, doc structure no longer matches, malformed
 * bytes). Callers MUST be prepared for null and fall back to the
 * legacy from_pos / to_pos columns.
 *
 * @param {Y.Doc} ydoc
 * @param {Buffer|Uint8Array|null} bytes
 */
/**
 * Phase 4.5 -- back-fill anchor_start_yjs / anchor_end_yjs for any
 * comment rows on this file that don't have them yet, using the
 * just-loaded Y.Doc and the row's existing from_pos / to_pos.
 *
 * Runs once per acquireRoom (the first time the Y.Doc is brought into
 * memory). Idempotent: the UPDATE predicates on the anchor columns
 * still being NULL, so a concurrent comment-create that supplied its
 * own anchors won't be overwritten.
 *
 * Failures are logged but never propagated -- this is opportunistic
 * upgrade-on-touch; if it fails the row keeps using the legacy
 * integer offsets and the GET path falls back transparently.
 */
export async function backfillCommentAnchors(projectId, fileId, ydoc) {
  if (!projectId || !fileId || !ydoc) return 0;
  let rows;
  try {
    rows = await db.all(
      `SELECT id, from_pos, to_pos
         FROM comments
        WHERE file_id = $1
          AND (anchor_start_yjs IS NULL OR anchor_end_yjs IS NULL)`,
      [fileId],
    );
  } catch (err) {
    logger.warn({ err, projectId, fileId }, 'yjsAnchors: backfill SELECT failed');
    return 0;
  }
  if (!rows || rows.length === 0) return 0;
  const ytext = ydoc.getText('content');
  let migrated = 0;
  for (const row of rows) {
    const startBytes = makeAnchorBytes(ytext, row.from_pos);
    const endBytes = makeAnchorBytes(ytext, row.to_pos, { side: 'left' });
    if (!startBytes || !endBytes) continue;
    try {
      await db.run(
        `UPDATE comments
            SET anchor_start_yjs = $1, anchor_end_yjs = $2
          WHERE id = $3
            AND (anchor_start_yjs IS NULL OR anchor_end_yjs IS NULL)`,
        [startBytes, endBytes, row.id],
      );
      migrated += 1;
    } catch (err) {
      logger.warn({ err, commentId: row.id }, 'yjsAnchors: backfill UPDATE failed');
    }
  }
  return migrated;
}

export function resolveAnchor(ydoc, bytes) {
  if (!ydoc || !bytes) return null;
  let arr;
  if (Buffer.isBuffer(bytes)) {
    arr = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } else if (bytes instanceof Uint8Array) {
    arr = bytes;
  } else {
    return null;
  }
  let rel;
  try { rel = Y.decodeRelativePosition(arr); } catch { return null; }
  let abs;
  try { abs = Y.createAbsolutePositionFromRelativePosition(rel, ydoc); } catch { return null; }
  if (!abs) return null;
  return typeof abs.index === 'number' ? abs.index : null;
}
