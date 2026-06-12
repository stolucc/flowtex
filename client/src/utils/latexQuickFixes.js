// @ts-check
//
// Pure-logic helpers for the LaTeX one-click quick-fix UX. The error
// list in PdfViewer shows a "Apply fix" button for errors whose
// latexErrorHelp rule supplied a `fix` descriptor; the orchestrator in
// App.jsx routes the descriptor through these helpers to compute the
// edit to dispatch via the editor ref.
//
// All functions here operate on plain strings and integer offsets. No
// CodeMirror import, no React. Stays trivially testable.

/**
 * Find the best character offset at which to insert a new
 * `\usepackage{...}` line in a LaTeX document.
 *
 * Strategy (highest priority first):
 *   1. Insert immediately after the LAST existing `\usepackage{...}`
 *      line so packages cluster together.
 *   2. Otherwise, insert immediately after the `\documentclass{...}`
 *      line so the package lands at the top of the preamble.
 *   3. Otherwise, insert at offset 0 (no documentclass found — caller
 *      is presumably looking at a fragment or a child include file).
 *
 * Returns a character offset and a flag describing whether the
 * inserted text needs a leading newline (when inserting at offset 0
 * of a non-empty file, no leading newline is needed; otherwise yes).
 *
 * @param {string} content - Full file text
 * @returns {{ offset: number, needsLeadingNewline: boolean }}
 */
export function findInsertionPointForPackage(content) {
  // Match each `\usepackage[opts]{name}` or `\usepackage{name}` line.
  // Multi-line option lists (rare) are NOT supported here; for those,
  // we fall back to the documentclass anchor.
  const usepkgRe = /^[^\n]*\\usepackage(?:\[[^\]]*\])?\{[^}]*\}[^\n]*$/gm;
  let lastMatch = null;
  let m;
  while ((m = usepkgRe.exec(content)) !== null) {
    lastMatch = m;
  }
  if (lastMatch) {
    // Insert at the end of the matched line.
    const endOfLine = lastMatch.index + lastMatch[0].length;
    return { offset: endOfLine, needsLeadingNewline: true };
  }

  // No \usepackage line — anchor on \documentclass.
  const docclassRe = /^[^\n]*\\documentclass(?:\[[^\]]*\])?\{[^}]*\}[^\n]*$/m;
  const dc = content.match(docclassRe);
  if (dc && dc.index != null) {
    const endOfLine = dc.index + dc[0].length;
    return { offset: endOfLine, needsLeadingNewline: true };
  }

  // No anchor at all.
  return { offset: 0, needsLeadingNewline: false };
}

/**
 * Check whether `\usepackage{<name>}` is already present in `content`.
 * Allows the package to appear with or without options. Used to avoid
 * inserting a duplicate when the user already has the package but the
 * compile cache produced a stale error.
 *
 * @param {string} content
 * @param {string} packageName
 */
export function hasPackage(content, packageName) {
  // Strict match on `\usepackage[..]{name}` or `\usepackage{name}`.
  // The `\b` after the captured name guards against matching `xcolors`
  // when looking for `xcolor`.
  const safe = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\\\usepackage(?:\\[[^\\]]*\\])?\\{[^}]*\\b${safe}\\b[^}]*\\}`);
  return re.test(content);
}

/**
 * Build the snippet to insert for an "add \usepackage" fix.
 *
 * @param {string} packageName
 * @param {boolean} needsLeadingNewline
 */
export function buildUsepackageSnippet(packageName, needsLeadingNewline) {
  const line = `\\usepackage{${packageName}}`;
  return needsLeadingNewline ? `\n${line}` : `${line}\n`;
}

/**
 * Apply an "add usepackage" fix to a file's content. Returns either
 * { changed: true, newContent, insertAt, insertLength } so the caller
 * can scroll to the new line, or { changed: false } when the package
 * is already present.
 *
 * @param {string} content
 * @param {string} packageName
 * @returns {{ changed: true, newContent: string, insertAt: number, insertLength: number } | { changed: false, reason: 'already-present' }}
 */
export function applyAddUsepackage(content, packageName) {
  if (hasPackage(content, packageName)) {
    return { changed: false, reason: 'already-present' };
  }
  const { offset, needsLeadingNewline } = findInsertionPointForPackage(content);
  const snippet = buildUsepackageSnippet(packageName, needsLeadingNewline);
  const newContent = content.slice(0, offset) + snippet + content.slice(offset);
  return {
    changed: true,
    newContent,
    insertAt: offset,
    insertLength: snippet.length,
  };
}
