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
