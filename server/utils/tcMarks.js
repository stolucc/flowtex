// Server-side TC utility — strip pending deletions before compiling.
//
// In the M2 client model (see client/src/utils/tcMarks.js + the spec at
// TRACK-CHANGES-RULES.md §1.1), the `content` column on `files` keeps
// every char including ones marked-deleted; the strikethrough is purely
// visual. For LaTeX compilation we need the "Final" view: drop the
// pending-del ranges so they don't leak into the PDF.
//
// `tc_marks` is the JSONB array stored alongside content. Each entry:
//   { id, type: 'ins'|'del', from, to, authorId, authorName, timestamp }
//
// `ins` entries are kept as-is (their text is current/final). `del`
// entries get their range stripped from the source.

/**
 * Inject the TC macro definitions just after `\documentclass{...}`. Used
 * by the "show changes in PDF" path so `\TCadd{}` / `\TCdel{}` resolve.
 * Idempotent: skipped if `\TCadd` is already defined (provider check).
 *
 * @param {string} content
 * @returns {string}
 */
export function injectTcMacros(content) {
  if (typeof content !== 'string' || content.length === 0) return content;
  if (/\\providecommand\s*{?\s*\\TCadd/.test(content) || /\\newcommand\s*{?\s*\\TCadd/.test(content)) {
    return content;
  }
  const preamble =
    '\n\\usepackage[normalem]{ulem}%\n' +
    '\\usepackage{xcolor}%\n' +
    '\\providecommand{\\TCadd}[1]{\\textcolor{blue}{\\uline{#1}}}%\n' +
    '\\providecommand{\\TCdel}[1]{\\textcolor{red}{\\sout{#1}}}%\n';
  const m = content.match(/\\documentclass\b[^\n]*/);
  if (!m) return content;
  return content.replace(m[0], m[0] + preamble);
}

/**
 * Wrap pending TC ranges with `\TCadd{...}` / `\TCdel{...}`. Used when
 * the user wants the compiled PDF to show pending changes (Word-style
 * "All Markup" view) instead of the default "Final" view.
 *
 * V1 invariant: ranges do not overlap. Defensive: skip overlapping
 * ranges silently rather than producing nested wraps.
 *
 * @param {string} content
 * @param {Array<object>|null|undefined} tcMarks
 * @returns {string}
 */
export function wrapPendingChangesAsMacros(content, tcMarks) {
  if (!Array.isArray(tcMarks) || tcMarks.length === 0) return content;
  if (typeof content !== 'string' || content.length === 0) return content;

  const sorted = tcMarks
    .filter(
      (m) =>
        m &&
        (m.type === 'ins' || m.type === 'del') &&
        Number.isFinite(m.from) &&
        Number.isFinite(m.to) &&
        m.from < m.to,
    )
    .map((m) => ({
      type: m.type,
      from: Math.max(0, Math.min(m.from, content.length)),
      to: Math.max(0, Math.min(m.to, content.length)),
    }))
    .filter((m) => m.from < m.to)
    .sort((a, b) => a.from - b.from);

  if (sorted.length === 0) return content;

  let out = '';
  let cursor = 0;
  for (const m of sorted) {
    if (m.from < cursor) continue; // overlap — skip defensively
    if (m.from > cursor) out += content.slice(cursor, m.from);
    const inner = content.slice(m.from, m.to);
    const macro = m.type === 'ins' ? '\\TCadd' : '\\TCdel';
    out += wrapInner(macro, inner);
    cursor = m.to;
  }
  if (cursor < content.length) out += content.slice(cursor);
  return out;
}

// Sectioning commands whose argument can't safely live inside ulem's
// \uline / \sout (used by \TCadd / \TCdel). \section etc. are fragile
// LaTeX commands — they emit \par, set page state, etc. — and crash with
// "File ended while scanning use of \@xdblarg" inside the hbox that ulem
// creates. When a marked range begins with one of these, we move the
// markup macro INSIDE the argument braces so the section command itself
// stays at top level.
const SECTIONING_RE =
  /^(\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{)/;

/** Find the index of the matching `}` in `s`, starting from the char after
 *  the implicit opening `{` (so depth begins at 1). Returns -1 on imbalance. */
function findClose(s) {
  let depth = 1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

// Matches a paragraph break: a blank line (one or more newlines with only
// whitespace between two of them) or an explicit `\par` token. We split
// on these so the wrapping macro is closed before the break — `\textcolor`,
// `\uline` and `\sout` are short LaTeX commands that crash with "Paragraph
// ended before \@textcolor was complete" if a `\par` lands inside them.
const PARA_BREAK_RE = /(\n[ \t]*\n[ \t\n]*|\\par\b[ \t]*)/g;

/**
 * Wrap `inner` with `macro` (`\TCadd` or `\TCdel`), splitting at paragraph
 * breaks so the macro never spans a `\par` (fragile-command crash), and
 * routing around sectioning commands so they don't end up inside ulem's hbox.
 */
function wrapInner(macro, inner) {
  // split() with a capturing group keeps the separators as alternating slots,
  // so we can wrap content chunks (even indexes) and pass separators through.
  const parts = inner.split(PARA_BREAK_RE);
  if (parts.length === 1) return wrapOneParagraph(macro, inner);
  return parts
    .map((p, i) => {
      if (i % 2 === 1) return p; // paragraph separator — leave outside the macro
      if (!p || p.trim().length === 0) return p; // empty content slot
      return wrapOneParagraph(macro, p);
    })
    .join('');
}

/** Wrap a single paragraph's worth of `inner` — no `\par` inside. */
function wrapOneParagraph(macro, inner) {
  const m = SECTIONING_RE.exec(inner);
  if (m) {
    const header = m[0];
    const rest = inner.slice(header.length);
    const closeIdx = findClose(rest);
    if (closeIdx >= 0) {
      const title = rest.slice(0, closeIdx);
      const tail = rest.slice(closeIdx); // includes the closing brace + anything after
      // If there's text after the section's closing brace, wrap that too.
      const wrappedTail = tail.length > 1 ? tail.slice(0, 1) + `${macro}{${tail.slice(1)}}` : tail;
      return `${header}${macro}{${title}}${wrappedTail}`;
    }
  }
  return `${macro}{${inner}}`;
}

/**
 * Return `content` with pending del ranges removed.
 *
 * @param {string} content
 * @param {Array<object>|null|undefined} tcMarks
 * @returns {string}
 */
export function stripPendingDeletions(content, tcMarks) {
  if (!Array.isArray(tcMarks) || tcMarks.length === 0) return content;
  if (typeof content !== 'string' || content.length === 0) return content;

  const dels = tcMarks
    .filter((m) => m && m.type === 'del' && Number.isFinite(m.from) && Number.isFinite(m.to) && m.from < m.to)
    .map((m) => ({
      from: Math.max(0, Math.min(m.from, content.length)),
      to: Math.max(0, Math.min(m.to, content.length)),
    }))
    .filter((m) => m.from < m.to);

  if (dels.length === 0) return content;

  // Sort + merge overlaps so the cut-out is well-defined.
  dels.sort((a, b) => a.from - b.from);
  const merged = [dels[0]];
  for (let i = 1; i < dels.length; i++) {
    const cur = dels[i];
    const last = merged[merged.length - 1];
    if (cur.from <= last.to) {
      last.to = Math.max(last.to, cur.to);
    } else {
      merged.push({ ...cur });
    }
  }

  // Splice the ranges out in left-to-right doc order.
  let out = '';
  let cursor = 0;
  for (const r of merged) {
    if (r.from > cursor) out += content.slice(cursor, r.from);
    cursor = r.to;
  }
  if (cursor < content.length) out += content.slice(cursor);
  return out;
}
