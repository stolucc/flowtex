// @ts-check
/**
 * BibTeX linter — checks for fields that are invalid for the entry type.
 * Returns an array of { line, col, len, severity, message }.
 */
import { ALL_KNOWN_FIELDS, isFieldValidForType } from './bibtexMode.js';

// Entry type aliases (same as bibtexMode.js)
/** @type {Record<string, string>} */
const TYPE_ALIASES = {
  conference: 'inproceedings',
  bookinbook: 'inbook',
  suppbook: 'inbook',
  suppcollection: 'incollection',
  reference: 'collection',
  mvreference: 'mvcollection',
  inreference: 'incollection',
  suppperiodical: 'article',
  mastersthesis: 'thesis',
  phdthesis: 'thesis',
  techreport: 'report',
  electronic: 'online',
  www: 'online',
  software: 'misc',
};

const FIELD_RE = /^(\s*)([a-zA-Z_][a-zA-Z0-9_-]*)\s*=/;

/**
 * Lint BibTeX source for invalid or unknown fields per entry type.
 * @param {string} text - BibTeX source text
 * @returns {Array<{line: number, col: number, len: number, severity: string, message: string}>}
 */
export default function bibtexLint(text) {
  const diagnostics = [];
  const lines = text.split('\n');

  // First pass: find all entry boundaries with their types
  // We track which entry type applies at each line
  const entryAtLine = new Array(lines.length).fill(null);
  let braceDepth = 0;
  let currentType = null;
  let inEntry = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (!inEntry && ch === '@') {
        // Try to match entry type
        const rest = line.slice(j);
        const m = rest.match(/^@(\w+)\s*[{(]/);
        if (m) {
          let type = m[1].toLowerCase();
          // Skip @string, @preamble, @comment
          if (type === 'string' || type === 'preamble' || type === 'comment') {
            currentType = null;
          } else {
            type = TYPE_ALIASES[type] || type;
            currentType = type;
          }
          inEntry = true;
          braceDepth = 0;
          j += m[0].length - 1; // skip past the opening brace
          braceDepth = 1;
          continue;
        }
      }
      if (inEntry) {
        if (ch === '{' || ch === '(') braceDepth++;
        else if (ch === '}' || ch === ')') {
          braceDepth--;
          if (braceDepth <= 0) {
            inEntry = false;
            currentType = null;
            braceDepth = 0;
          }
        }
      }
    }
    entryAtLine[i] = currentType;
  }

  // Second pass: find field names and validate
  // Re-parse to correctly handle brace depth for field detection
  braceDepth = 0;
  inEntry = false;
  currentType = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for entry start
    const entryMatch = line.match(/^\s*@(\w+)\s*[{(]/);
    if (entryMatch) {
      let type = entryMatch[1].toLowerCase();
      if (type !== 'string' && type !== 'preamble' && type !== 'comment') {
        type = TYPE_ALIASES[type] || type;
        currentType = type;
        inEntry = true;
        // Count braces on this line
        braceDepth = 0;
        for (const ch of line) {
          if (ch === '{' || ch === '(') braceDepth++;
          else if (ch === '}' || ch === ')') braceDepth--;
        }
        continue;
      }
    }

    if (inEntry && currentType) {
      // Check for field = pattern
      const fieldMatch = line.match(FIELD_RE);
      if (fieldMatch) {
        const fieldName = fieldMatch[2].toLowerCase();
        const col = fieldMatch[1].length; // 0-based offset of field name

        if (!ALL_KNOWN_FIELDS.has(fieldName)) {
          diagnostics.push({
            line: i + 1,
            col: col + 1,
            len: fieldMatch[2].length,
            severity: 'warning',
            message: `Unknown field "${fieldMatch[2]}"`,
          });
        } else if (!isFieldValidForType(fieldName, currentType)) {
          diagnostics.push({
            line: i + 1,
            col: col + 1,
            len: fieldMatch[2].length,
            severity: 'warning',
            message: `Field "${fieldMatch[2]}" is not standard for @${currentType}`,
          });
        }
      }
    }

    // Track brace depth for entry boundaries
    for (const ch of line) {
      if (ch === '{' || ch === '(') braceDepth++;
      else if (ch === '}' || ch === ')') braceDepth--;
    }
    if (inEntry && braceDepth <= 0) {
      inEntry = false;
      currentType = null;
      braceDepth = 0;
    }
  }

  return diagnostics;
}
