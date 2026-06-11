// @ts-check
// Tiny outline parser: scans a .tex file for sectioning commands and
// returns a flat list of { level, title, line } entries the UI can
// render with indentation. Cheap to recompute on every keystroke even
// for large files — single linear regex pass.
//
// Levels follow standard LaTeX nesting:
//   0 part
//   1 chapter
//   2 section
//   3 subsection
//   4 subsubsection
//   5 paragraph
//   6 subparagraph
//
// We don't try to build a tree here — the UI flattens to a list and
// indents by level, which is what readers expect and avoids
// re-balancing edge cases (e.g. \subsection without an enclosing
// \section, common in fragments or imported docs).
/** @type {Record<string, number>} */
const SECTION_LEVELS = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

// One regex that matches any sectioning command, optional star (\section*),
// optional short title in [], then captures the braced title. We allow
// one level of nested braces in the title so things like
// \section{Hello \texttt{world}} parse cleanly.
//
// Anchored to a line start (with optional whitespace) so \section
// appearing inside a comment or inside another macro body doesn't
// register. A leading % comment also disqualifies the line.
const SECTION_RE = /^[ \t]*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\[[^\]]*\])?\{((?:[^{}]|\{[^{}]*\})*)\}/;

/**
 * Parse sectioning commands from a LaTeX source string.
 * @param {string} source - The .tex file contents.
 * @returns {{ level: number, label: string, title: string, line: number }[]}
 *   - level: 0..6 (see SECTION_LEVELS)
 *   - label: the LaTeX command without the backslash ("section" etc.)
 *   - title: the brace-content title, with one level of nested macros stripped
 *   - line: 1-indexed line number (matches the editor goToLine API)
 */
export function parseOutline(source) {
  if (typeof source !== 'string' || source.length === 0) return [];
  const out = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Cheap reject: skip lines whose first non-whitespace char is %
    // (line is in a comment). Doesn't catch %-mid-line, but the
    // section pattern anchors to start-of-line so it doesn't matter.
    if (/^\s*%/.test(line)) continue;
    const m = SECTION_RE.exec(line);
    if (!m) continue;
    const label = m[1];
    const rawTitle = m[2];
    // Strip simple inline macros like \texttt{foo} -> foo so the
    // outline reads as natural text. Be conservative: only collapse
    // single-arg macros without options.
    const title = rawTitle.replace(/\\[A-Za-z]+\{([^{}]*)\}/g, '$1').trim();
    out.push({
      level: SECTION_LEVELS[label],
      label,
      title: title || `(empty ${label})`,
      line: i + 1,
    });
  }
  return out;
}

// \input{foo} / \include{foo} — same regex shape as the section
// scanner. We only walk these from files we already have in the
// project file table; remote/system inputs (tex live packages) are
// outside our scope.
const INPUT_RE = /\\(?:input|include)\{((?:[^{}]|\{[^{}]*\})*)\}/g;

// Resolve `\input{rel}` from `fromPath`. LaTeX is happy with or without
// the .tex extension and treats the path as relative to the directory
// of the file doing the \input. Returns null when no matching file
// exists in the project.
/**
 * @param {string} rel
 * @param {string} fromPath
 * @param {Map<string, any>} byPath
 */
function resolveInput(rel, fromPath, byPath) {
  if (!rel) return null;
  // Strip a leading "./" — LaTeX accepts it, normalizing keeps the
  // lookup deterministic.
  const cleaned = rel.replace(/^\.\//, '');
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/') + 1) : '';
  const candidates = [
    cleaned,                                // project-root-relative
    dir + cleaned,                          // sibling-relative
    cleaned + '.tex',                       // with .tex
    dir + cleaned + '.tex',                 // sibling-relative with .tex
  ];
  for (const c of candidates) {
    if (byPath.has(c)) return c;
  }
  return null;
}

/**
 * Walk \input/\include from `mainFilePath` and return a flat outline
 * spanning every reachable .tex file. Each entry carries the source
 * `path` and 1-indexed `line` so the UI can jump cross-file.
 *
 * Falls back to a single-file scan when:
 *   - mainFilePath is missing / not in the project
 *   - no .tex files exist
 *
 * Cycles (a inputs b, b inputs a) are bounded by a visited Set so the
 * walk always terminates. Each file is parsed at most once even if
 * \input'd from multiple places — duplicates would just clutter the
 * outline without adding information.
 *
 * @param {{path:string,is_binary:boolean,content:string}[]} files
 * @param {string|null|undefined} mainFilePath
 * @returns {{level:number,label:string,title:string,line:number,path:string}[]}
 */
export function parseDocumentOutline(files, mainFilePath) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const byPath = new Map();
  for (const f of files) {
    if (!f?.path || f.is_binary) continue;
    if (typeof f.content !== 'string') continue;
    byPath.set(f.path, f);
  }
  if (byPath.size === 0) return [];

  // Determine the entry file. Prefer the project main_file; fall back
  // to main.tex if present; finally the first .tex we have.
  const candidates = [mainFilePath, 'main.tex'].filter(Boolean);
  let entry = null;
  for (const c of candidates) {
    if (byPath.has(c)) { entry = c; break; }
  }
  if (!entry) {
    for (const path of byPath.keys()) {
      if (path.endsWith('.tex')) { entry = path; break; }
    }
  }
  if (!entry) return [];

  /** @type {Array<{ level: number, label: string, title: string, line: number, path: string }>} */
  const out = [];
  /** @type {Set<string>} */
  const visited = new Set();
  /**
   * Walk a file: emit its sectioning entries in source order, then
   * recurse on each \input/\include it makes. The depth-first order
   * matches what a reader scrolling through the rendered PDF would
   * see, which is what the user expects from an outline.
   */
  const walk = (/** @type {string} */ path) => {
    if (visited.has(path)) return;
    visited.add(path);
    const file = byPath.get(path);
    if (!file) return;
    const source = file.content || '';
    const sections = parseOutline(source);
    // Interleave sections + nested inputs in source-line order so a
    // chapter that lives in a separate file shows in its logical
    // place rather than at the end of the outline.
    //
    // Find all input/include positions with their line numbers, merge
    // with section entries, sort by line, emit in order.
    /** @type {Array<{ rel: string, line: number }>} */
    const inputs = [];
    INPUT_RE.lastIndex = 0;
    let m;
    while ((m = INPUT_RE.exec(source)) !== null) {
      // Line containing the match start.
      const before = source.slice(0, m.index);
      const line = before.split('\n').length;
      inputs.push({ rel: m[1], line });
    }
    /** @type {Array<any>} */
    const events = [
      ...sections.map((s) => ({ kind: 'sec', ...s })),
      ...inputs.map((i) => ({ kind: 'input', ...i })),
    ].sort((a, b) => a.line - b.line);

    for (const ev of events) {
      if (ev.kind === 'sec') {
        out.push({
          level: ev.level,
          label: ev.label,
          title: ev.title,
          line: ev.line,
          path,
        });
      } else {
        const resolved = resolveInput(ev.rel, path, byPath);
        if (resolved) walk(resolved);
      }
    }
  };
  walk(entry);
  return out;
}
