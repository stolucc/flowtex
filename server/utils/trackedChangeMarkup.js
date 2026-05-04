import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { invalidateFile } from '../compiler.js';

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
 * Resolve a tracked change's position in the file content.
 *
 * Strategy: trust the stored position first. Only fall back to fuzzy
 * windowed search when the text at the stored position doesn't match.
 * This avoids false matches for short strings like "W" or ",".
 */
export function resolvePosition(content, needle, from, to) {
  if (!needle) return null;

  // 1. Exact position match — text at stored range matches needle
  if (from >= 0 && to <= content.length && content.slice(from, to) === needle) {
    return { from, to };
  }

  // 2. Exact match at from..from+len (for deletions where to might equal from)
  const end2 = from + needle.length;
  if (from >= 0 && end2 <= content.length && content.slice(from, end2) === needle) {
    return { from, to: end2 };
  }

  // 3. Fuzzy: windowed search, but scale window to needle length to
  //    avoid false positives for very short needles
  const windowSize = Math.max(100, Math.min(600, needle.length * 20));
  const searchStart = Math.max(0, from - windowSize);
  const searchEnd = Math.min(content.length, from + windowSize + needle.length);
  const window = content.substring(searchStart, searchEnd);

  let bestIdx = -1;
  let bestDist = Infinity;
  let idx = 0;
  while (true) {
    const found = window.indexOf(needle, idx);
    if (found === -1) break;
    const absPos = searchStart + found;
    const dist = Math.abs(absPos - from);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = absPos;
    }
    idx = found + 1;
  }

  return bestIdx >= 0 ? { from: bestIdx, to: bestIdx + needle.length } : null;
}

/**
 * Inject tracked-change markup into .tex file content.
 *
 * - Insertions → blue wavy underline (matching latexdiff's UNDERLINE style)
 * - Deletions  → red strikethrough (re-inserted at the deletion position)
 *
 * Trusts stored positions first; falls back to fuzzy search only when
 * the text at the stored position doesn't match.
 * Processes changes end-to-start to preserve character positions.
 */
export function applyMarkup(content, changes, { visualMarkup = true } = {}) {
  if (!changes.length) return content;

  // Idempotence guard: if the content already shows our TC markup, the stored
  // change positions are stale relative to the marked-up text — re-applying
  // would corrupt the file. The pipeline contract is to invalidate the file
  // cache after every TC pass so the next compile starts from clean DB
  // content; this check defends against accidental double-invocation.
  if (visualMarkup && (content.includes('\\TCadd{') || content.includes('\\TCdel{'))) {
    return content;
  }

  // Resolve actual positions, then sort
  const resolved = [];
  for (const tc of changes) {
    if (tc.deleted_text) {
      const pos = resolvePosition(content, tc.deleted_text, tc.from_pos, tc.to_pos);
      if (pos) {
        resolved.push({ type: 'del', from: pos.from, to: pos.to, text: tc.deleted_text });
      }
    }
    if (tc.inserted_text) {
      const pos = resolvePosition(content, tc.inserted_text, tc.from_pos, tc.to_pos);
      if (pos) {
        resolved.push({ type: 'ins', from: pos.from, to: pos.to, text: tc.inserted_text });
      }
    }
  }

  // Drop any deletion whose range overlaps a pending insertion — match the
  // editor's UI rule (buildTcDeleteDecorations also does this). Otherwise
  // the PDF marks chars as struck that the editor renders as plain inserted
  // text, so the two views diverge. The most common cause is a phantom
  // deletion record left behind by a merge-into-insertion race in the
  // client; the insertion is the user's authentic intent.
  const insertRanges = resolved.filter((r) => r.type === 'ins').map((r) => ({ from: r.from, to: r.to }));
  const insertFiltered = resolved.filter((r) => {
    if (r.type !== 'del') return true;
    return !insertRanges.some((ir) => r.from < ir.to && r.to > ir.from);
  });

  // Sort by position descending so later edits don't shift earlier positions
  insertFiltered.sort((a, b) => {
    if (b.from !== a.from) return b.from - a.from;
    // Deletions before insertions at same position
    return (a.type === 'ins' ? 1 : 0) - (b.type === 'ins' ? 1 : 0);
  });

  // Deduplicate overlapping ranges (keep first = rightmost)
  const used = [];
  const deduped = [];
  for (const r of insertFiltered) {
    const overlaps = used.some((u) => r.from < u.to && r.to > u.from);
    if (!overlaps) {
      deduped.push(r);
      used.push(r);
    }
  }

  // Skip changes inside citation/ref command arguments where markup would break
  const fragile = [];
  const fragileRe = /\\(?:cite|parencite|textcite|autocite|citep|citet|nocite|ref|eqref|pageref|label|hyperref|url|href)\{[^}]*\}/g;
  let fm;
  while ((fm = fragileRe.exec(content)) !== null) {
    fragile.push({ from: fm.index, to: fm.index + fm[0].length });
  }

  // Defensive: index every `\command` token (the backslash-prefixed name,
  // not its argument). A change whose [from, to] lands inside a command
  // name produces output like `\b\TCdel{e}gin{document}` — broken LaTeX.
  // Stale positions from out-of-sync pending changes are the most common
  // way this happens; the change is still tracked, we just don't visualise
  // it rather than break the document.
  const controlSequences = [];
  const csRe = /\\[a-zA-Z@]+/g;
  let cm;
  while ((cm = csRe.exec(content)) !== null) {
    controlSequences.push({ from: cm.index, to: cm.index + cm[0].length });
  }
  // Following latexdiff's approach: skip TC markup for changes inside tabular
  // environments. Structural table commands (\multicolumn, \hline, &, \\, etc.)
  // break when wrapped in \TCadd/\TCdel. The changes remain tracked in the
  // database, just not visually marked in the PDF.
  // Find all tabular/longtable regions in the content
  const tabularRegions = [];
  const tabularStartRe = /\\begin\{(?:tabular|longtable|tabularx)\}/g;
  let tsm;
  while ((tsm = tabularStartRe.exec(content)) !== null) {
    const envName = tsm[0].match(/\{(\w+)\}/)[1];
    const endTag = `\\end{${envName}}`;
    const endIdx = content.indexOf(endTag, tsm.index);
    if (endIdx >= 0) {
      tabularRegions.push({ from: tsm.index, to: endIdx + endTag.length });
    }
  }

  // For table-overlapping changes, distinguish structural vs text-only:
  // - Structural changes (containing &, \\, \hline, \multicolumn, etc.) must be
  //   accepted silently — wrapping them would break compilation.
  // - Text-only changes within cells can still get TC markup safely.
  const TABLE_STRUCTURAL_RE = /(?:^|[^\\])&|\\\\(?:\s*$|\[)|\\(?:hline|cline|toprule|midrule|bottomrule|multicolumn|multirow|begin\{|end\{|caption|arraystretch|renewcommand|rule\{0pt)/;

  const filtered = [];
  const tableAcceptedDeletions = [];
  for (const r of deduped) {
    if (fragile.some(f => r.from >= f.from && r.to <= f.to)) continue;
    // Skip changes that fall inside a command-name token. We use
    // containment here, not overlap, so a change that legitimately spans
    // an argument like `\section{old name}` -> `\section{new name}` is
    // still wrapped — only changes whose entire range sits inside the
    // `\foo` token itself get filtered out.
    if (controlSequences.some(cs => r.from >= cs.from && r.to <= cs.to)) continue;
    // Use *containment*, not overlap. A change that straddles a tabular
    // boundary (starts inside, ends outside, or vice-versa) must NOT be
    // wholesale-removed by the table path — we'd delete content from outside
    // the table too. Treat such straddling changes as ordinary changes.
    const inTable = tabularRegions.some(t => r.from >= t.from && r.to <= t.to);
    if (inTable) {
      if (TABLE_STRUCTURAL_RE.test(r.text)) {
        // Structural change — accept silently (remove deletions, keep insertions)
        if (r.type === 'del') tableAcceptedDeletions.push(r);
        continue;
      }
      // Text-only change in table — safe to mark up
    }
    filtered.push(r);
  }

  let result = content;

  // First, remove table deletions (process end-to-start to preserve positions)
  tableAcceptedDeletions.sort((a, b) => b.from - a.from);
  for (const r of tableAcceptedDeletions) {
    result = result.slice(0, r.from) + result.slice(r.to);
  }

  // Adjust positions of remaining filtered changes for any table deletions that shifted text
  // (table deletions before each change reduce its position)
  for (const r of filtered) {
    let shift = 0;
    for (const td of tableAcceptedDeletions) {
      if (td.from < r.from) shift += (td.to - td.from);
    }
    r.from -= shift;
    r.to -= shift;
  }

  if (visualMarkup) {
    for (const r of filtered) {
      const macro = r.type === 'ins' ? '\\TCadd' : '\\TCdel';

      if (r.type === 'del') {
        // Deletion: wrap the still-present deleted text, then replace it
        // (deletion text is kept in document until accepted)
        const wrapped = wrapSafe(r.text, macro);
        result = result.slice(0, r.from) + wrapped + result.slice(r.to);
      } else {
        // Insertion: wrap the inserted text in-place.
        // Keep leading/trailing spaces OUTSIDE the macro — LaTeX can drop
        // spaces at the boundary of \textcolor/group commands.
        let text = result.slice(r.from, r.to);
        let prefix = '';
        let suffix = '';
        if (text.startsWith(' ')) { prefix = ' '; text = text.slice(1); }
        if (text.endsWith(' ') && text.length > 0) { suffix = ' '; text = text.slice(0, -1); }
        const wrapped = text ? wrapSafe(text, macro) : '';
        result = result.slice(0, r.from) + prefix + wrapped + suffix + result.slice(r.to);
      }
    }
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
  const changes = await db.all(
    `SELECT tc.*, f.path AS file_path
     FROM tracked_changes tc
     JOIN files f ON f.id = tc.file_id
     WHERE tc.project_id = $1 AND tc.status = 'pending'
     ORDER BY tc.from_pos ASC`,
    [projectId],
  );

  if (!changes.length) return 0;

  // Group by file path
  const byFile = new Map();
  for (const tc of changes) {
    if (!byFile.has(tc.file_path)) byFile.set(tc.file_path, []);
    byFile.get(tc.file_path).push(tc);
  }

  let count = 0;
  for (const [filePath, fileChanges] of byFile) {
    const absPath = path.join(projectDir, filePath);
    if (!fs.existsSync(absPath)) continue;

    let content = fs.readFileSync(absPath, 'utf-8');
    content = applyMarkup(content, fileChanges, { visualMarkup });

    // Inject preamble macros into the file that has \documentclass
    if (visualMarkup && content.includes('\\documentclass')) {
      content = ensurePreamble(content);
    }

    fs.writeFileSync(absPath, content);
    // This file on disk now diverges from the DB-content hash that
    // syncFilesToDisk caches; invalidate just this entry so the next compile
    // re-writes clean content here without churning the rest of the project.
    invalidateFile(projectId, filePath);
    count += fileChanges.length;
  }

  return count;
}
