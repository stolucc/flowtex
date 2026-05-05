// Inline tracked-change markers in file content. Replaces the previous
// position-based `tracked_changes` table model, which couldn't keep its
// integer positions in sync across CodeMirror transactions, WebSocket OT
// broadcasts, accept/reject doc edits, and the React state mirror — every
// new feature surfaced a fresh race.
//
// A marker is a self-contained run of text the user never sees raw.
// The editor hides the sentinels via Decoration.replace and renders the
// inner text with the appropriate visual style (blue underline for
// insertions, red strikethrough for deletions). The compile pipeline
// strips or expands the markers depending on whether the user wants to
// see tracked changes in the PDF.
//
// Format:
//
//     U+E000 type ":" id ":" author ":" length ":" text U+E002
//
// Sentinels are Unicode private-use chars (U+E000 / U+E002), which can't
// occur in legitimate LaTeX source. We use a length prefix on the text
// instead of an end-sentinel scan so the text can contain anything —
// including the sentinels themselves, newlines, colons, or backslashes —
// without escaping. Parsing is unambiguous: read four colon-delimited
// fields, then read exactly `length` JS code units of text.
//
// `length` is in JS string code units (UTF-16). The text is
// length-counted, so multi-byte chars that decompose into surrogate pairs
// still parse correctly as long as the writer and reader agree on units.
//
// Author is a free-form string (display name or user id); empty is
// allowed. Id is a short opaque token that uniquely identifies the marker
// for accept/reject; empty is allowed (means "anonymous marker").

export const TC_START = '';
export const TC_END = '';
export const TC_REGEX_START = //g;

/**
 * Build a marker string.
 * @param {{type:'ins'|'del', id:string, author:string, text:string}} m
 */
export function serialize({ type, id, author, text }) {
  if (type !== 'ins' && type !== 'del') throw new Error(`bad marker type: ${type}`);
  if (id != null && /[:]/.test(id)) throw new Error('id must not contain : or sentinel chars');
  if (author != null && /[:]/.test(author)) throw new Error('author must not contain : or sentinel chars');
  const safeId = id || '';
  const safeAuthor = author || '';
  const t = text || '';
  return `${TC_START}${type}:${safeId}:${safeAuthor}:${t.length}:${t}${TC_END}`;
}

/**
 * Parse a single marker starting at `from` in `content`. Returns the
 * marker plus its inclusive-exclusive byte range, or null if the
 * sequence at `from` isn't a valid marker.
 */
export function parseAt(content, from) {
  if (content[from] !== TC_START) return null;
  // Read 4 colon-delimited header fields.
  let cursor = from + 1;
  const fields = [];
  for (let i = 0; i < 4; i++) {
    const colon = content.indexOf(':', cursor);
    if (colon === -1) return null;
    fields.push(content.slice(cursor, colon));
    cursor = colon + 1;
  }
  const [type, id, author, lenStr] = fields;
  if (type !== 'ins' && type !== 'del') return null;
  const len = Number(lenStr);
  if (!Number.isInteger(len) || len < 0) return null;
  const textEnd = cursor + len;
  if (textEnd >= content.length) return null;
  if (content[textEnd] !== TC_END) return null;
  const text = content.slice(cursor, textEnd);
  return {
    from,
    to: textEnd + 1,
    type,
    id,
    author,
    text,
    // Where the text portion sits inside the marker (useful for cursor
    // positioning and for decorations that highlight the inner text only).
    textFrom: cursor,
    textTo: textEnd,
  };
}

/**
 * Find every marker in the content, in document order.
 * @returns {Array<{from,to,type,id,author,text,textFrom,textTo}>}
 */
export function parseAll(content) {
  const out = [];
  if (!content) return out;
  let i = 0;
  while (i < content.length) {
    const idx = content.indexOf(TC_START, i);
    if (idx === -1) break;
    const m = parseAt(content, idx);
    if (m) {
      out.push(m);
      i = m.to;
    } else {
      i = idx + 1;
    }
  }
  return out;
}

/**
 * Strip every marker from the content, leaving NO trace — neither the
 * sentinels nor the inner text. Use for showing the "no tracked changes"
 * view of a file (e.g. an export with all changes rejected as a preview).
 */
export function stripAll(content) {
  if (!content) return content;
  let out = '';
  let i = 0;
  while (i < content.length) {
    const idx = content.indexOf(TC_START, i);
    if (idx === -1) {
      out += content.slice(i);
      break;
    }
    out += content.slice(i, idx);
    const m = parseAt(content, idx);
    if (m) i = m.to;
    else { out += content[idx]; i = idx + 1; }
  }
  return out;
}

/**
 * Apply an accept/reject decision to every marker in the content.
 * - acceptAll: for each insertion keep the inner text, drop the marker;
 *              for each deletion drop both the marker and the inner text.
 * - rejectAll: for each insertion drop both the marker and the inner text;
 *              for each deletion keep the inner text, drop the marker.
 */
export function acceptAll(content) {
  return resolveAll(content, /* keepIns */ true, /* keepDel */ false);
}
export function rejectAll(content) {
  return resolveAll(content, /* keepIns */ false, /* keepDel */ true);
}
function resolveAll(content, keepIns, keepDel) {
  if (!content) return content;
  let out = '';
  let i = 0;
  while (i < content.length) {
    const idx = content.indexOf(TC_START, i);
    if (idx === -1) { out += content.slice(i); break; }
    out += content.slice(i, idx);
    const m = parseAt(content, idx);
    if (!m) { out += content[idx]; i = idx + 1; continue; }
    if ((m.type === 'ins' && keepIns) || (m.type === 'del' && keepDel)) {
      out += m.text;
    }
    i = m.to;
  }
  return out;
}

/**
 * Resolve a single marker by id. Returns the new content, or the
 * original content unchanged if no marker with that id was found.
 *
 * decision === 'accept': insertions keep text, deletions remove text.
 * decision === 'reject': insertions remove text, deletions keep text.
 */
export function resolveOne(content, id, decision) {
  if (!content || !id) return content;
  if (decision !== 'accept' && decision !== 'reject') {
    throw new Error(`bad decision: ${decision}`);
  }
  let i = 0;
  while (i < content.length) {
    const idx = content.indexOf(TC_START, i);
    if (idx === -1) return content;
    const m = parseAt(content, idx);
    if (!m) { i = idx + 1; continue; }
    if (m.id === id) {
      const keep =
        (m.type === 'ins' && decision === 'accept') ||
        (m.type === 'del' && decision === 'reject');
      const replacement = keep ? m.text : '';
      return content.slice(0, m.from) + replacement + content.slice(m.to);
    }
    i = m.to;
  }
  return content;
}

/**
 * Convenience: count pending markers (used for "n pending changes" UI).
 */
export function countMarkers(content) {
  return parseAll(content).length;
}
