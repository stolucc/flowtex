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

// ─── Graphics path / image extension fixes ────────────────────────────

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.pdf', '.eps', '.svg', '.gif', '.bmp'];
/** Render-by-pdflatex order: pdf is preferred (vector + native),
 *  then png, then jpg/jpeg. Used when picking a replacement extension. */
const PREFERRED_RASTERIZE_TARGETS = ['.pdf', '.png', '.jpg', '.jpeg'];

/**
 * Heuristic: does the given filename look like an image (so it makes
 * sense to offer image-related fixes)? An empty extension counts as
 * image-like because \includegraphics{foo} omits the extension on
 * purpose (LaTeX picks it).
 *
 * @param {string} name
 */
export function looksLikeImagePath(name) {
  const lastDot = name.lastIndexOf('.');
  // No extension at all -> likely \includegraphics{name} site.
  if (lastDot < 0) return true;
  // Extension on the last path segment.
  const lastSlash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (lastDot < lastSlash) return true; // the dot is in a directory name
  const ext = name.slice(lastDot).toLowerCase();
  return IMAGE_EXTS.includes(ext);
}

/**
 * Split a path into directory and basename. Cross-platform on `/` and
 * `\\`.
 *
 * @param {string} p
 */
export function splitPath(p) {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (idx < 0) return { dir: '', base: p };
  return { dir: p.slice(0, idx + 1), base: p.slice(idx + 1) };
}

/**
 * Given a missing image filename and the project's file list, look
 * for a file in another directory with the same basename (with any
 * image-y extension). Returns the directory that, when added to
 * \graphicspath, would resolve the reference.
 *
 * Returns null when no such candidate exists.
 *
 * @param {string} missing - the filename LaTeX reported missing
 * @param {Array<{ path: string }>} projectFiles
 * @returns {string | null}
 */
export function findGraphicspathCandidate(missing, projectFiles) {
  const { base: missingBase } = splitPath(missing);
  if (!missingBase) return null;
  // Strip extension from the missing basename so `foo.png` lookups
  // also match a `foo.pdf` in another directory.
  const missingStem = missingBase.replace(/\.[^./\\]+$/, '');
  for (const f of projectFiles) {
    if (!f?.path) continue;
    const { dir, base } = splitPath(f.path);
    if (!dir) continue; // file is at the root -- adding \graphicspath{{/}} is silly
    const stem = base.replace(/\.[^./\\]+$/, '');
    if (stem !== missingStem) continue;
    const ext = base.slice(stem.length).toLowerCase();
    if (!IMAGE_EXTS.includes(ext) && ext !== '') continue;
    return dir;
  }
  return null;
}

/**
 * Given a filename whose current extension renders badly (e.g. svg,
 * eps with pdflatex) and the project's file list, pick the best
 * alternative extension for the same basename if a sibling exists.
 *
 * Returns the new filename, or null when no sibling is present.
 *
 * @param {string} filename - e.g. 'figs/foo.svg' or 'foo.svg'
 * @param {Array<{ path: string }>} projectFiles
 * @returns {string | null}
 */
export function findExtensionSibling(filename, projectFiles) {
  const { dir, base } = splitPath(filename);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null; // no extension or hidden-file
  const stem = base.slice(0, dot);
  const haveExts = new Set();
  for (const f of projectFiles) {
    if (!f?.path) continue;
    const { dir: fdir, base: fbase } = splitPath(f.path);
    // Match in the same directory (so the existing \includegraphics
    // path keeps working). If the user has graphicspath set up, we'd
    // need more context to know whether the alternative is reachable
    // -- the conservative check is "same explicit dir".
    if ((dir || '') !== fdir) continue;
    const fdot = fbase.lastIndexOf('.');
    if (fdot <= 0) continue;
    if (fbase.slice(0, fdot) !== stem) continue;
    haveExts.add(fbase.slice(fdot).toLowerCase());
  }
  for (const ext of PREFERRED_RASTERIZE_TARGETS) {
    if (haveExts.has(ext)) {
      return dir + stem + ext;
    }
  }
  return null;
}

/**
 * Apply an "add \graphicspath{{dir/}}" fix to a file's content. Mirrors
 * applyAddUsepackage's shape.
 *
 * @param {string} content
 * @param {string} dir
 * @returns {{ changed: true, newContent: string, insertAt: number, insertLength: number } | { changed: false, reason: 'already-present' }}
 */
export function applyAddGraphicspath(content, dir) {
  const normalised = dir.endsWith('/') ? dir : dir + '/';
  // Detect any existing \graphicspath; we don't try to merge braces,
  // we just back off so the user can integrate by hand. Detect ANY
  // \graphicspath usage as already-present rather than risk an
  // overlapping definition.
  if (/\\graphicspath\b/.test(content)) {
    return { changed: false, reason: 'already-present' };
  }
  const { offset, needsLeadingNewline } = findInsertionPointForPackage(content);
  const line = `\\graphicspath{{${normalised}}}`;
  const snippet = needsLeadingNewline ? `\n${line}` : `${line}\n`;
  const newContent = content.slice(0, offset) + snippet + content.slice(offset);
  return {
    changed: true,
    newContent,
    insertAt: offset,
    insertLength: snippet.length,
  };
}

/**
 * Find the `\includegraphics[opts]{name}` token nearest to the given
 * 1-indexed line. Returns the captured filename plus the char range
 * of the WHOLE `\includegraphics{...}` token so callers can replace it.
 *
 * @param {string} content
 * @param {number} targetLine
 * @returns {{ from: number, to: number, filename: string } | null}
 */
export function findIncludegraphicsAtLine(content, targetLine) {
  let lineStart = 0;
  let n = 1;
  while (n < targetLine && lineStart < content.length) {
    const nl = content.indexOf('\n', lineStart);
    if (nl < 0) break;
    lineStart = nl + 1;
    n++;
  }
  // Allow +/- 2 lines of fuzz.
  const winStart = (() => {
    let s = lineStart;
    for (let i = 0; i < 2 && s > 0; i++) {
      const prev = content.lastIndexOf('\n', s - 2);
      if (prev < 0) return 0;
      s = prev + 1;
    }
    return s;
  })();
  const winEnd = (() => {
    let e = lineStart;
    for (let i = 0; i < 3 && e < content.length; i++) {
      const nl = content.indexOf('\n', e);
      if (nl < 0) return content.length;
      e = nl + 1;
    }
    return e;
  })();
  const window = content.slice(winStart, winEnd);
  // Match \includegraphics[opts]{filename}. Filename allows directory
  // separators and dots.
  const re = /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/;
  const m = window.match(re);
  if (!m || m.index == null) return null;
  return {
    from: winStart + m.index,
    to: winStart + m.index + m[0].length,
    filename: m[1],
  };
}

/**
 * Replace the captured filename inside an `\includegraphics{...}`
 * token with a new filename. Preserves any `[opts]` block.
 *
 * @param {string} content
 * @param {{ from: number, to: number }} range
 * @param {string} newFilename
 */
export function buildIncludegraphicsRename(content, range, newFilename) {
  const slice = content.slice(range.from, range.to);
  const re = /\\includegraphics(\[[^\]]*\])?\{[^}]+\}/;
  const m = slice.match(re);
  if (!m) {
    return { changed: /** @type {false} */ (false), reason: /** @type {'no-token'} */ ('no-token') };
  }
  const opts = m[1] || '';
  const replacement = `\\includegraphics${opts}{${newFilename}}`;
  const newContent =
    content.slice(0, range.from) + replacement + content.slice(range.to);
  return {
    changed: /** @type {true} */ (true),
    newContent,
    replaceAt: range.from,
    replaceLength: range.to - range.from,
    insertedText: replacement,
  };
}

/**
 * High-level: given a "Cannot determine size of graphic in <name>" or
 * similar error context, find the \includegraphics site and swap to a
 * sibling extension.
 *
 * @param {string} content
 * @param {number} line       - 1-indexed line of the error
 * @param {string} badName    - filename as reported in the error
 * @param {Array<{ path: string }>} projectFiles
 * @returns {{ changed: true, newContent: string, replaceAt: number, replaceLength: number, insertedText: string, newExtension: string } | { changed: false, reason: 'no-token' | 'no-sibling' | 'name-mismatch' }}
 */
export function applySwapImageExtension(content, line, badName, projectFiles) {
  const token = findIncludegraphicsAtLine(content, line);
  if (!token) {
    return { changed: false, reason: 'no-token' };
  }
  // Defensive: the token at the line should reference the bad name.
  // The log might quote `foo.svg` while the source has just `foo`
  // (LaTeX appended the extension during search). Accept either.
  const sourceName = token.filename;
  const badStem = badName.replace(/\.[^./\\]+$/, '');
  const sourceStem = sourceName.replace(/\.[^./\\]+$/, '');
  const { base: badBase } = splitPath(badStem);
  const { base: sourceBase } = splitPath(sourceStem);
  if (badBase !== sourceBase) {
    return { changed: false, reason: 'name-mismatch' };
  }
  // Find a sibling. If sourceName has no extension, treat badName's
  // extension as the "current" one for sibling lookup purposes.
  const probeName = sourceName.includes('.') ? sourceName : badName;
  const sibling = findExtensionSibling(probeName, projectFiles);
  if (!sibling) {
    return { changed: false, reason: 'no-sibling' };
  }
  const rewrite = buildIncludegraphicsRename(content, token, sibling);
  if (!rewrite.changed) {
    return { changed: false, reason: 'no-token' };
  }
  const dot = sibling.lastIndexOf('.');
  return {
    changed: true,
    newContent: rewrite.newContent,
    replaceAt: rewrite.replaceAt,
    replaceLength: rewrite.replaceLength,
    insertedText: rewrite.insertedText,
    newExtension: dot > 0 ? sibling.slice(dot) : '',
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
