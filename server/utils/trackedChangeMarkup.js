import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { invalidateFile } from '../compiler.js';
import {
  TC_START,
  parseAll as parseMarkers,
  acceptAll as acceptAllMarkers,
} from '../../shared/tcMarkers.js';

/**
 * Build the preamble snippet, skipping package loads that already exist.
 *
 * Uses `\sout` from `ulem` for strikethrough (the same choice latexdiff
 * makes). `\st` from `soul` was an earlier attempt — soul throws
 * "Reconstruction failed" whenever the strikethrough contents include
 * math, fragile commands, or some unicode it can't decompose. `\sout`
 * just overlays a rule and works on essentially anything.
 */
export function buildPreamble(content) {
  const lines = ['%% --- Tracked-change markup (modelled on latexdiff) ---'];

  // Only load xcolor if not already present
  if (!/\\usepackage(\[.*?\])?\{xcolor\}/.test(content) && !/\\RequirePackage(\[.*?\])?\{xcolor\}/.test(content)) {
    lines.push('\\RequirePackage{xcolor}');
  }

  // Only load ulem if not already present (provides robust \sout strikethrough).
  // [normalem] keeps \emph behavior unchanged.
  if (!/\\usepackage(\[.*?\])?\{ulem\}/.test(content) && !/\\RequirePackage(\[.*?\])?\{ulem\}/.test(content)) {
    lines.push('\\RequirePackage[normalem]{ulem}');
  }

  lines.push(
    '\\providecommand{\\TCadd}[1]{\\textcolor{blue}{#1}}',
    '\\providecommand{\\TCdel}[1]{\\textcolor{red}{\\sout{#1}}}',
    '%% --- End tracked-change markup ---',
  );
  return lines.join('\n');
}

/**
 * Regex matching structural LaTeX lines that must NOT be wrapped inside
 * \\uwave{} or \\sout{} — these use \\noalign, \\omit, or other
 * primitives that break inside formatting groups.
 */
const STRUCTURAL_RE =
  /^\s*\\(begin|end)\{|^\s*\\(section|subsection|subsubsection|chapter|paragraph|subparagraph)\b|^\s*\\(toprule|midrule|bottomrule|hline|cline|endhead|endfirsthead|endfoot|endlastfoot|caption|label|centering|item)\b|^\s*\\(\\|&)\s*$/;

/** Lines that are purely whitespace or a paragraph break. */
const BLANK_RE = /^\s*$/;

/**
 * Wrap a block of text in a tracked-change macro, splitting at paragraph
 * breaks, structural lines, and display-math boundaries so the ulem
 * commands never span those contexts (which would cause errors).
 *
 * @param {string} text - The raw LaTeX text to wrap
 * @param {string} macro - '\\TCadd' or '\\TCdel'
 * @returns {string}
 */
/**
 * Pattern source for the citation/ref commands that must stay outside TC
 * markup. We construct a fresh `RegExp` on each `wrapSafe` call rather than
 * reusing a module-level `/g` regex — sharing a stateful global regex
 * across calls means a stray `.test()` or `.exec()` that doesn't reset
 * `lastIndex` silently produces wrong output on the next call. Per-call
 * construction is a few microseconds slower and impossible to misuse.
 */
const CITE_CMD_PATTERN = '\\\\(?:parencite|textcite|autocite|cite[pt]?|nocite|cite)\\{[^}]*\\}';

/**
 * Returns true if every `{` in `text` has a matching `}` (and vice versa),
 * ignoring escaped braces (`\{`, `\}`, `\\`). A chunk with unbalanced braces
 * cannot safely be wrapped in `\TCadd{…}` / `\TCdel{…}` — it would either
 * eat the wrapper's own brace or leave one orphaned.
 */
export function bracesBalanced(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) { i++; continue; } // skip \\, \{, \} etc.
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}

export function wrapSafe(text, macro) {
  if (!text) return '';

  // Fresh regex per call — see CITE_CMD_PATTERN comment above.
  const citeCmdRe = new RegExp(CITE_CMD_PATTERN, 'g');

  // Split into lines, accumulate safe runs, flush at boundaries
  const lines = text.split('\n');
  const out = [];
  let buf = [];

  /** Wrap a chunk, splitting around citation commands that break inside \textcolor. */
  function wrapChunk(chunk) {
    if (BLANK_RE.test(chunk)) { out.push(chunk); return; }
    // If braces don't balance inside the chunk, wrapping would corrupt the
    // surrounding LaTeX. Emit unwrapped — the change is still applied (added
    // text appears, deleted text stays in place) but without TC markup.
    if (!bracesBalanced(chunk)) { out.push(chunk); return; }
    // Drive the matcher off exec() alone so we never juggle lastIndex
    // between test() and exec() on the same regex.
    citeCmdRe.lastIndex = 0;
    let last = 0;
    let m;
    let foundAny = false;
    while ((m = citeCmdRe.exec(chunk)) !== null) {
      foundAny = true;
      const before = chunk.slice(last, m.index);
      if (before && !BLANK_RE.test(before) && bracesBalanced(before)) out.push(`${macro}{${before}}`);
      else if (before) out.push(before);
      out.push(m[0]); // citation command unwrapped
      last = m.index + m[0].length;
    }
    if (!foundAny) { out.push(`${macro}{${chunk}}`); return; }
    const after = chunk.slice(last);
    if (after && !BLANK_RE.test(after) && bracesBalanced(after)) out.push(`${macro}{${after}}`);
    else if (after) out.push(after);
  }

  function flush() {
    if (!buf.length) return;
    const chunk = buf.join('\n');
    buf = [];
    wrapChunk(chunk);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Paragraph break (blank line) — flush and keep the blank line unwrapped
    if (BLANK_RE.test(line) && buf.length) {
      flush();
      out.push(line);
      continue;
    }

    // Structural line — flush buffer, emit the line unwrapped
    if (STRUCTURAL_RE.test(line)) {
      flush();
      out.push(line);
      continue;
    }

    // Display math delimiters — flush, keep unwrapped
    if (/^\s*\\\[/.test(line) || /^\s*\\\]/.test(line)) {
      flush();
      out.push(line);
      continue;
    }

    buf.push(line);
  }
  flush();

  return out.join('\n');
}

/**
 * Convert inline tracked-change markers in `content` to LaTeX visual
 * markup macros. See `shared/tcMarkers.js` for the marker format.
 *
 * @param {string} content - File content with possibly-embedded markers.
 * @param {object} [options]
 * @param {boolean} [options.visualMarkup=true] - When false, the markers
 *   are stripped via acceptAll (insertions kept as plain text, deletions
 *   removed) — i.e. compile the document as if every pending change had
 *   been accepted, with no preamble or coloured macros.
 * @returns {string} The content with markers replaced.
 */
export function convertMarkersToTexMarkup(content, { visualMarkup = true } = {}) {
  if (!content || !content.includes(TC_START)) return content;
  if (!visualMarkup) return acceptAllMarkers(content);

  // Walk the markers in REVERSE document order so each replacement
  // doesn't shift positions of yet-to-process markers.
  const markers = parseMarkers(content);
  if (markers.length === 0) return content;

  let result = content;
  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i];
    const macro = m.type === 'ins' ? '\\TCadd' : '\\TCdel';

    // Same wrap-around-citations and structural-line splitting as the
    // legacy path. Markers placed by the editor in TC mode never sit
    // inside fragile arguments because the editor is responsible for not
    // placing them there, but defensively wrap with wrapSafe so a
    // marker that contains a structural construct still produces
    // compilable output.
    let wrapped;
    if (m.type === 'ins') {
      // Preserve leading/trailing whitespace OUTSIDE the macro — LaTeX
      // can drop spaces at the boundary of textcolor groups.
      let text = m.text;
      let prefix = '';
      let suffix = '';
      if (text.startsWith(' ')) { prefix = ' '; text = text.slice(1); }
      if (text.endsWith(' ') && text.length > 0) { suffix = ' '; text = text.slice(0, -1); }
      wrapped = prefix + (text ? wrapSafe(text, macro) : '') + suffix;
    } else {
      wrapped = wrapSafe(m.text, macro);
    }
    result = result.slice(0, m.from) + wrapped + result.slice(m.to);
  }

  return result;
}

/**
 * Inject TC preamble into the document.
 * Inserts right before \begin{document} to avoid option clashes with
 * user-loaded packages.
 */
export function ensurePreamble(content) {
  // Don't double-inject
  if (content.includes('--- Tracked-change markup')) return content;

  // Insert right before \begin{document}
  const beginDoc = content.indexOf('\\begin{document}');
  if (beginDoc === -1) return content;

  const preamble = buildPreamble(content);
  return content.slice(0, beginDoc) + preamble + '\n' + content.slice(beginDoc);
}

/**
 * Apply tracked change markup to .tex files on disk for a project.
 * Call this in onBeforeCompile (after files are synced to disk).
 * @param {string} projectId
 * @param {string} projectDir - Absolute path to the project directory on disk.
 * @param {object} [options]
 * @param {boolean} [options.visualMarkup=true] - If false, only accept structural
 *   table changes (removing deletions that would break compilation) without adding
 *   any visual TC markup (no preamble, no \TCadd/\TCdel).
 * @returns {Promise<number>} Number of tracked changes processed.
 */
export async function injectTrackedChangeMarkup(projectId, projectDir, { visualMarkup = true } = {}) {
  // Walk every text file in the project; convert any inline tcMarkers in
  // the content into LaTeX visual markup (\TCadd / \TCdel) — or strip
  // them via acceptAll semantics when visualMarkup is false. Files
  // without markers are skipped entirely.
  const allFiles = await db.all(
    'SELECT path FROM files WHERE project_id = $1 AND is_binary = FALSE',
    [projectId],
  );

  let count = 0;
  for (const fileRow of allFiles) {
    const filePath = fileRow.path;
    const absPath = path.join(projectDir, filePath);
    if (!fs.existsSync(absPath)) continue;

    const original = fs.readFileSync(absPath, 'utf-8');
    if (!original.includes(TC_START)) continue;

    const markersInFile = parseMarkers(original);
    let content = convertMarkersToTexMarkup(original, { visualMarkup });
    count += markersInFile.length;

    if (visualMarkup && content.includes('\\documentclass')) {
      content = ensurePreamble(content);
    }

    if (content !== original) {
      fs.writeFileSync(absPath, content);
      // The file on disk diverges from the DB-content hash that
      // syncFilesToDisk caches; invalidate this entry so the next
      // compile starts from clean DB content without churning siblings.
      invalidateFile(projectId, filePath);
    }
  }

  return count;
}
