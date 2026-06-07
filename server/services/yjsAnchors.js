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

// ── tc_marks anchors (phase 5) ─────────────────────────────────────────────
//
// tc_marks lives in a JSONB column (one array per file), so the
// anchor bytes are base64-encoded to ride along inside the JSON
// rather than being stored in separate BYTEA columns. The shape
// each entry adopts (additive, backwards compatible):
//
//   {
//     id, type: 'ins'|'del', from, to, authorId, authorName,
//     timestamp,                           // legacy fields
//     anchorStart: <base64 of Y.RelativePosition>?,  // phase 5
//     anchorEnd:   <base64 of Y.RelativePosition>?,  // phase 5
//   }
//
// `from` / `to` remain the integer fallback that the client and the
// LaTeX compile pipeline read directly. When a Y.Doc room is
// active, the server resolves the anchors into fresh from / to
// values BEFORE handing the JSON to the consumer, so CRDT-driven
// drift never reaches the wire.

/** Encode a Y.RelativePosition for storage inside JSON. */
export function serializeAnchorB64(ytext, index, opts) {
  const bytes = makeAnchorBytes(ytext, index, opts);
  if (!bytes) return null;
  return bytes.toString('base64');
}

/** Decode a base64-encoded Y.RelativePosition and resolve it against ydoc. */
export function deserializeAnchorB64(ydoc, b64) {
  if (typeof b64 !== 'string' || b64.length === 0) return null;
  let bytes;
  try { bytes = Buffer.from(b64, 'base64'); } catch { return null; }
  return resolveAnchor(ydoc, bytes);
}

/**
 * Return a copy of the tc_marks array with anchorStart / anchorEnd
 * captured for every entry (re-deriving each time so the anchors
 * always reflect the entry's current from / to in the active doc).
 *
 * Entries that don't pass shape validation are passed through
 * unmodified. The end-of-span uses side='left' so typing right
 * after a tracked change doesn't extend the highlighted region.
 */
export function captureTcMarkAnchors(ytext, marks) {
  if (!Array.isArray(marks) || !ytext) return marks;
  return marks.map((m) => {
    if (!m || typeof m !== 'object') return m;
    if (typeof m.from !== 'number' || typeof m.to !== 'number') return m;
    const anchorStart = serializeAnchorB64(ytext, m.from);
    const anchorEnd = serializeAnchorB64(ytext, m.to, { side: 'left' });
    if (!anchorStart || !anchorEnd) return m;
    return { ...m, anchorStart, anchorEnd };
  });
}

/**
 * Return a copy of the tc_marks array with from / to overwritten by
 * resolving the stored anchors against ydoc. Entries without
 * anchors, or whose anchors fail to resolve, fall through with
 * their legacy from / to intact.
 */
export function resolveTcMarkAnchors(ydoc, marks) {
  if (!Array.isArray(marks) || !ydoc) return marks;
  return marks.map((m) => {
    if (!m || typeof m !== 'object') return m;
    let from = m.from;
    let to = m.to;
    if (typeof m.anchorStart === 'string') {
      const idx = deserializeAnchorB64(ydoc, m.anchorStart);
      if (idx !== null) from = idx;
    }
    if (typeof m.anchorEnd === 'string') {
      const idx = deserializeAnchorB64(ydoc, m.anchorEnd);
      if (idx !== null) to = idx;
    }
    if (from === m.from && to === m.to) return m;
    return { ...m, from, to };
  });
}

/**
 * Phase 5 backfill: SELECT tc_marks for the file, capture anchors
 * for any entries that lack them, write back if anything changed.
 * Same race/idempotency posture as backfillCommentAnchors --
 * failures are logged + swallowed; the UPDATE is a JSONB-replace so
 * a concurrent saveFile that wrote different marks won't be lost
 * here (we only UPDATE when the row's tc_marks JSON equals what we
 * read, via the `updated_at` guard already on saveFile -- this
 * function intentionally skips that guard because it's
 * upgrade-on-touch, not a save).
 */
export async function backfillTcMarkAnchors(projectId, fileId, ydoc) {
  if (!projectId || !fileId || !ydoc) return 0;
  let row;
  try {
    row = await db.get(
      'SELECT tc_marks FROM files WHERE id = $1 AND project_id = $2',
      [fileId, projectId],
    );
  } catch (err) {
    logger.warn({ err, projectId, fileId }, 'yjsAnchors: tc_marks backfill SELECT failed');
    return 0;
  }
  if (!row) return 0;
  const marks = Array.isArray(row.tc_marks) ? row.tc_marks : [];
  if (marks.length === 0) return 0;
  const needsAny = marks.some(
    (m) => m && typeof m === 'object' && (typeof m.anchorStart !== 'string' || typeof m.anchorEnd !== 'string'),
  );
  if (!needsAny) return 0;
  const ytext = ydoc.getText('content');
  const upgraded = marks.map((m) => {
    if (!m || typeof m !== 'object') return m;
    if (typeof m.anchorStart === 'string' && typeof m.anchorEnd === 'string') return m;
    if (typeof m.from !== 'number' || typeof m.to !== 'number') return m;
    const anchorStart = serializeAnchorB64(ytext, m.from);
    const anchorEnd = serializeAnchorB64(ytext, m.to, { side: 'left' });
    if (!anchorStart || !anchorEnd) return m;
    return { ...m, anchorStart, anchorEnd };
  });
  // Count how many entries we actually changed. If the only entries
  // that "needed" anchors were ones we couldn't anchor (bad shape,
  // non-numeric from/to), skip the UPDATE -- writing a no-op
  // tc_marks just bumps fragments and rewrites the JSONB for no
  // gain.
  const changedCount = upgraded.reduce((n, m, i) => (m !== marks[i] ? n + 1 : n), 0);
  if (changedCount === 0) return 0;
  try {
    await db.run(
      'UPDATE files SET tc_marks = $1::jsonb WHERE id = $2 AND project_id = $3',
      [JSON.stringify(upgraded), fileId, projectId],
    );
    return changedCount;
  } catch (err) {
    logger.warn({ err, projectId, fileId }, 'yjsAnchors: tc_marks backfill UPDATE failed');
    return 0;
  }
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
