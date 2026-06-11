// @ts-check
/** Strip the compile-job hash suffix from filenames (e.g. "main_3b551ace.aux" → "main.aux").
 *  @param {string} filename
 */
function stripJobSuffix(filename) {
  return filename.replace(/_[0-9a-f]{8}(?=\.)/, '');
}

/**
 * Extract a line number from a LaTeX log line (e.g. "l.42" or "line 42").
 * @param {string} text
 * @returns {number|null}
 */
function extractLineNumber(text) {
  const match = text.match(/\bl\.(\d+)\b/) || text.match(/lines?\s+(\d+)/i) || text.match(/at lines?\s+(\d+)/i);
  return match ? parseInt(match[1]) : null;
}

/**
 * Parse a LaTeX compilation log into structured errors and warnings.
 * @param {string} log - Raw LaTeX log output
 * @returns {{errors: Array<{text: string, line: number|null, col: number|null, file: string|null, isSystemFile: boolean}>, warnings: any[]}} Deduplicated errors and warnings
 */
export default function parseLog(log) {
  if (!log) return { errors: [], warnings: [] };
  const lines = log.split('\n');
  /** @type {Array<{ text: string, line: number | null, col: number | null, file: string | null, isSystemFile: boolean }>} */
  const errors = [];
  /** @type {any[]} */
  const warnings = [];

  // Track current file context from LaTeX log "(./file.tex" entries
  /** @type {string | null} */
  let currentFile = null;
  /** @type {string[]} */
  const fileStack = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track file context: LaTeX logs "(./foo.tex" when entering, ")" when leaving
    const opens =
      line.match(/\(\.\/([^\s)]+\.(?:tex|sty|cls|clo|def|fd|bbl|aux|cfg|ldf))/g) ||
      line.match(/\(([^\s)]+\.(?:tex|sty|cls|clo|def|fd|bbl|aux|cfg|ldf))/g);
    if (opens) {
      for (const m of opens) {
        const fileMatch = m.match(/\((.+)/);
        if (!fileMatch) continue;
        const f = stripJobSuffix(fileMatch[1]);
        fileStack.push(f);
        currentFile = f;
      }
    }
    const closes = (line.match(/\)/g) || []).length;
    for (let c = 0; c < closes && fileStack.length > 0; c++) {
      fileStack.pop();
      currentFile = fileStack.length > 0 ? fileStack[fileStack.length - 1] : null;
    }

    // Errors: lines starting with "!"
    if (line.startsWith('!')) {
      const msg = line.substring(2).trim();
      if (msg) {
        // Look ahead for line number and column from "l.NNN text" context line
        let lineNum = null;
        let col = null;
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const lMatch = lines[j].match(/^l\.(\d+)\s?(.*)/);
          if (lMatch) {
            lineNum = parseInt(lMatch[1]);
            // Column is length of text after "l.NNN " — the error is at/near the end
            const textAfter = lMatch[2] || '';
            col = textAfter.length;
            break;
          }
        }
        errors.push({ text: msg, line: lineNum, col, file: currentFile, isSystemFile: false });
        // Skip context lines until we hit the "l.NNN" line or a blank line
        while (i + 1 < lines.length && !lines[i + 1].startsWith('!') && !/^\s*$/.test(lines[i + 1])) {
          i++;
          if (/^l\.\d+/.test(lines[i])) break;
        }
      }
      continue;
    }
    // Warnings — only match actual LaTeX/package warnings, not package description lines
    if (/^(LaTeX|Package\s+\S+|Class\s+\S+)\s+Warning/i.test(line.trim())) {
      // Collect continuation lines (LaTeX wraps long warnings across multiple lines)
      let fullText = line.trim();
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        // Stop at blank lines, new warnings, errors, or other log entries
        if (/^\s*$/.test(next) || next.startsWith('!') || /^(LaTeX|Package\s+\S+|Class\s+\S+)\s+Warning/i.test(next.trim()) || /^(Overfull|Underfull)/.test(next)) break;
        // Continuation lines are typically indented or start with (PackageName)
        if (/^\s+\S/.test(next) || /^\(\w+\)/.test(next.trim())) {
          i++;
          // Strip leading package/class prefix like "(acmart)" from continuation lines
          const cleaned = next.trim().replace(/^\(\w+\)\s*/, '');
          fullText += ' ' + cleaned;
        } else {
          break;
        }
      }
      warnings.push({ text: fullText, line: extractLineNumber(fullText), file: currentFile });
    } else if (/^(Overfull|Underfull)/.test(line)) {
      warnings.push({ text: line.trim(), line: extractLineNumber(line), file: currentFile });
    }
  }

  // Deduplicate errors with same message and line
  const seenErrors = new Set();
  const uniqueErrors = errors.filter((e) => {
    const key = `${e.text}:${e.line}:${e.file}`;
    if (seenErrors.has(key)) return false;
    seenErrors.add(key);
    return true;
  });

  // Deduplicate warnings
  const seenWarnings = new Set();
  const uniqueWarnings = warnings.filter((w) => {
    const key = `${w.text}:${w.line}:${w.file}`;
    if (seenWarnings.has(key)) return false;
    seenWarnings.add(key);
    return true;
  });

  // Strip job suffix from error/warning text (e.g. "main_3b551ace.aux" → "main.aux")
  const JOB_SUFFIX_RE = /_[0-9a-f]{8}(?=\.)/g;
  for (const e of uniqueErrors) {
    e.text = e.text.replace(JOB_SUFFIX_RE, '');
  }
  for (const w of uniqueWarnings) {
    w.text = w.text.replace(JOB_SUFFIX_RE, '');
  }

  // Suppress known harmless biblatex+bibtex backend errors in .aux/.bbl files
  const suppressedErrors = uniqueErrors.filter((e) => {
    if (e.file && /\.(?:aux|bbl)$/.test(e.file)) {
      if (/extra\s*\}|forgotten\s*\\endgroup|unmatched/i.test(e.text)) return false;
    }
    return true;
  });

  // Separate errors from non-user files (class/package files the user can't edit)
  const SYSTEM_FILE_RE = /\.(?:sty|cls|clo|def|fd|cfg|ldf|bbx|cbx|lbx|aux|bbl)$/;
  for (const e of suppressedErrors) {
    e.isSystemFile = !!(e.file && SYSTEM_FILE_RE.test(e.file));
  }
  for (const w of uniqueWarnings) {
    w.isSystemFile = !!(w.file && SYSTEM_FILE_RE.test(w.file));
  }

  return { errors: suppressedErrors, warnings: uniqueWarnings };
}
