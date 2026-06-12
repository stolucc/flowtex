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

// ─── Remove a \usepackage line ────────────────────────────────────────

/**
 * Find the character range of the `\usepackage[opts]{name}` line for a
 * given package, plus a trailing newline if present. Returns null if
 * the package isn't loaded.
 *
 * Used by the "Remove \usepackage{X}" quick fix when the package isn't
 * installed on the system and the user wants to compile without it.
 *
 * @param {string} content
 * @param {string} packageName
 * @returns {{ from: number, to: number, line: string } | null}
 */
export function findUsepackageRange(content, packageName) {
  const safe = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Capture the WHOLE line that holds the \usepackage{name} call. We
  // anchor on the newline boundaries so removing the line also removes
  // its trailing \n (when present). A package listed alongside others
  // in a single brace -- `\usepackage{foo,bar}` -- is detected but the
  // remover declines to mutate, since picking only `foo` out of that
  // list requires understanding the surrounding context.
  const lineRe = new RegExp(
    `(^|\\n)([^\\n]*\\\\usepackage(?:\\[[^\\]]*\\])?\\{[^}]*\\b${safe}\\b[^}]*\\}[^\\n]*)(\\n?)`,
  );
  const m = content.match(lineRe);
  if (!m) return null;

  // If the brace contained MORE than one package name, don't touch it
  // -- the safe behaviour is to back off so the user resolves it by
  // hand. We detect "more than one" by counting commas in the brace.
  const braceMatch = m[2].match(/\\usepackage(?:\[[^\]]*\])?\{([^}]*)\}/);
  if (braceMatch && braceMatch[1].includes(',')) {
    return null;
  }

  const leadingLen = m[1].length; // 0 or 1 (the preceding \n)
  const trailingLen = m[3].length;
  const from = (m.index ?? 0) + leadingLen;
  const to = from + m[2].length + trailingLen;
  return { from, to, line: m[2] };
}

/**
 * Remove the `\usepackage{X}` line from the file. Returns the new
 * content + the removed range so the caller can scroll to roughly
 * where the deletion happened.
 *
 * @param {string} content
 * @param {string} packageName
 * @returns {{ changed: true, newContent: string, removedFrom: number, removedTo: number, removedText: string } | { changed: false, reason: 'not-found' | 'grouped-with-other-packages' }}
 */
export function applyRemoveUsepackage(content, packageName) {
  const range = findUsepackageRange(content, packageName);
  if (!range) {
    // Distinguish the two failure modes so the UI can explain them.
    const stillThere = hasPackage(content, packageName);
    return {
      changed: false,
      reason: stillThere ? 'grouped-with-other-packages' : 'not-found',
    };
  }
  const newContent = content.slice(0, range.from) + content.slice(range.to);
  return {
    changed: true,
    newContent,
    removedFrom: range.from,
    removedTo: range.to,
    removedText: range.line,
  };
}

// ─── Environment rename (auto-correct mismatched begin/end) ───────────

/**
 * Find the most-recent `\begin{name}` opening before character offset
 * `searchUpTo`, walking backwards. Returns the full match info so the
 * caller can replace the captured environment name.
 *
 * Used to support the "change \end{X} to match \begin{Y}" fix when
 * LaTeX reports a mismatched environment.
 *
 * @param {string} content
 * @param {number} searchUpTo - byte offset to search BEFORE
 * @returns {{ index: number, length: number, name: string } | null}
 */
export function findPrecedingBegin(content, searchUpTo) {
  // Scan backwards from `searchUpTo` for the most recent `\begin{X}`.
  const slice = content.slice(0, searchUpTo);
  // Use exec in a loop; capturing all \begin and keeping the last one
  // is simpler than reverse-iterating with a sticky regex.
  const re = /\\begin\{(\w+\*?)\}/g;
  let last = null;
  let m;
  while ((m = re.exec(slice)) !== null) {
    last = { index: m.index, length: m[0].length, name: m[1] };
  }
  return last;
}

/**
 * Find a `\end{name}` token at-or-near `targetLine` in the content.
 * Lines are 1-indexed (matching LaTeX log conventions).
 *
 * @param {string} content
 * @param {number} targetLine - 1-indexed line number reported by LaTeX
 * @param {string} endName    - the environment name reported in the \end
 * @returns {{ index: number, length: number, name: string } | null}
 */
export function findEndAtLine(content, targetLine, endName) {
  // Convert targetLine (1-indexed) to a character range.
  let lineStart = 0;
  let lineCount = 1;
  while (lineCount < targetLine && lineStart < content.length) {
    const nl = content.indexOf('\n', lineStart);
    if (nl < 0) break;
    lineStart = nl + 1;
    lineCount++;
  }
  // Search a small window starting at this line for the `\end{name}`.
  // We allow up to 3 lines ahead to tolerate the off-by-one that
  // LaTeX's error reporting sometimes introduces.
  const winEnd = (() => {
    let end = lineStart;
    for (let i = 0; i < 4 && end < content.length; i++) {
      const nl = content.indexOf('\n', end);
      if (nl < 0) return content.length;
      end = nl + 1;
    }
    return end;
  })();
  const window = content.slice(lineStart, winEnd);
  const safe = endName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\\\end\\{${safe}\\}`);
  const m = window.match(re);
  if (!m || m.index == null) return null;
  return {
    index: lineStart + m.index,
    length: m[0].length,
    name: endName,
  };
}

/**
 * Build a replacement for the \end{X} token, swapping the environment
 * name. Returns { changed: true, newContent, replaceAt, replaceLength,
 * insertedText } so the caller can scroll to the change.
 *
 * @param {string} content
 * @param {number} endIndex   - char offset of `\end{` token
 * @param {number} endLength  - length of the full `\end{X}` token
 * @param {string} newName
 */
export function buildEnvRename(content, endIndex, endLength, newName) {
  const replacement = `\\end{${newName}}`;
  const newContent =
    content.slice(0, endIndex) + replacement + content.slice(endIndex + endLength);
  return {
    changed: /** @type {true} */ (true),
    newContent,
    replaceAt: endIndex,
    replaceLength: endLength,
    insertedText: replacement,
  };
}

/**
 * High-level: given a "mismatched environments" error context, find the
 * `\end{bad}` at the reported line and propose renaming it to match the
 * most recent `\begin{good}` before it.
 *
 * Returns { changed: false } if the editor's snapshot of the source
 * doesn't agree with the log (likely the user already edited it).
 *
 * @param {string} content
 * @param {string} beginName - the name reported on the \begin side
 * @param {string} endName   - the name reported on the \end side
 * @param {number} [endLine] - 1-indexed line the \end appears on, when known
 * @returns {{ changed: true, newContent: string, replaceAt: number, replaceLength: number, insertedText: string } | { changed: false, reason: 'no-end-found' | 'no-begin-found' }}
 */
export function applyRenameEndEnv(content, beginName, endName, endLine) {
  // Locate the \end{endName} site. If we have a line, search there;
  // otherwise scan globally for the first match.
  let endHit;
  if (endLine != null) {
    endHit = findEndAtLine(content, endLine, endName);
  } else {
    const safe = endName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\\\end\\{${safe}\\}`);
    const m = content.match(re);
    endHit = m && m.index != null ? { index: m.index, length: m[0].length, name: endName } : null;
  }
  if (!endHit) return { changed: false, reason: 'no-end-found' };

  // Find the most recent \begin{X} BEFORE the \end site.
  const begin = findPrecedingBegin(content, endHit.index);
  if (!begin) return { changed: false, reason: 'no-begin-found' };

  // If the source's \begin disagrees with what the log called the
  // begin side, prefer the source's view -- the log might be stale.
  void beginName;

  return buildEnvRename(content, endHit.index, endHit.length, begin.name);
}
