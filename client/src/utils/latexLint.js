// @ts-check
/**
 * Simple LaTeX linter that checks for special characters in invalid contexts.
 * Tracks math mode, tabular environments, verbatim, and macro definitions.
 * Returns an array of { line, col, len, severity, message }.
 */

// Environments where & is valid (alignment character)
const ALIGN_ENVS = new Set([
  // Standard LaTeX tabular environments
  'tabular',
  'tabular*',
  'tabularx',
  'tabulary',
  'tabu',
  'longtabu',
  'array',
  'longtable',
  'supertabular',
  'supertabular*',
  'xtabular',
  'mpsupertabular',
  'mpsupertabular*',
  'delarray',
  'NiceTabular',
  'NiceTabular*',
  'NiceArray',
  'pNiceArray',
  'bNiceArray',
  'BNiceArray',
  'vNiceArray',
  'VNiceArray',
  'blockarray',
  'block',
  'ctabular',
  // Math alignment environments
  'matrix',
  'pmatrix',
  'bmatrix',
  'vmatrix',
  'Vmatrix',
  'Bmatrix',
  'smallmatrix',
  'psmallmatrix',
  'bsmallmatrix',
  'vsmallmatrix',
  'cases',
  'dcases',
  'rcases',
  'drcases',
  'cases*',
  'align',
  'align*',
  'aligned',
  'alignat',
  'alignat*',
  'alignedat',
  'eqnarray',
  'eqnarray*',
  'split',
  'gathered',
  'multline',
  'multline*',
  'flalign',
  'flalign*',
  'xalignat',
  'xalignat*',
  'xxalignat',
  // Other
  'IEEEeqnarray',
  'IEEEeqnarray*',
  'systeme',
]);

// Environments that start math mode
const MATH_ENVS = new Set([
  'equation',
  'equation*',
  'align',
  'align*',
  'aligned',
  'alignat',
  'alignat*',
  'gather',
  'gather*',
  'gathered',
  'multline',
  'multline*',
  'flalign',
  'flalign*',
  'split',
  'math',
  'displaymath',
  'eqnarray',
  'eqnarray*',
  'matrix',
  'pmatrix',
  'bmatrix',
  'vmatrix',
  'Vmatrix',
  'Bmatrix',
  'cases',
]);

// Environments where content is verbatim (no checking)
const VERBATIM_ENVS = new Set([
  'verbatim', 'verbatim*', 'lstlisting', 'minted', 'alltt', 'comment',
  'CCSXML',        // ACM acmart: raw XML block
  'filecontents', 'filecontents*',
  'luacode', 'luacode*',
]);

/**
 * Lint LaTeX source for misplaced special characters, unclosed math/environments, and brace mismatches.
 * @param {string} text - LaTeX source text
 * @returns {Array<{line: number, col: number, len?: number, severity: string, message: string}>}
 */
export default function latexLint(text) {
  /** @type {Array<{line: number, col: number, len?: number, severity: string, message: string}>} */
  const diagnostics = [];
  const lines = text.split('\n');

  // State tracking
  let inMathInline = false; // $ ... $
  let inMathDisplay = false; // $$ ... $$
  let mathParenDepth = 0; // \( ... \) nesting
  let mathBracketDepth = 0; // \[ ... \] nesting
  /** @type {Array<{ name: string, line: number }>} */
  const envStack = []; // stack of { name, line }
  let inVerbatim = false;
  let verbatimEnv = null;
  let inMacroDef = false; // after \newcommand etc, until end of definition
  let braceDepthAtMacroDef = 0;
  let braceDepth = 0;
  let skipBraceDepth = 0; // >0 when inside a command argument that should be skipped (e.g. \cite{...})

  function inMath() {
    return (
      inMathInline ||
      inMathDisplay ||
      mathParenDepth > 0 ||
      mathBracketDepth > 0 ||
      envStack.some((e) => MATH_ENVS.has(e.name))
    );
  }

  function inAlignEnv() {
    return envStack.some((e) => ALIGN_ENVS.has(e.name));
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineNum = lineIdx + 1;
    let i = 0;

    // Empty line inside a math environment causes a compilation error
    if (line.trim() === '' && !inVerbatim) {
      const mathEnv = envStack.findLast((e) => MATH_ENVS.has(e.name));
      if (mathEnv) {
        diagnostics.push({
          line: lineNum,
          col: 1,
          severity: 'error',
          message: `Empty line in ${mathEnv.name} environment — this will cause a compilation error. Remove the blank line.`,
        });
      }
    }

    while (i < line.length) {
      const ch = line[i];

      // Inside verbatim environment — only look for \end{verbatim}
      if (inVerbatim) {
        const endMatch = line.slice(i).match(/^\\end\{([^}]+)\}/);
        if (endMatch && endMatch[1] === verbatimEnv) {
          inVerbatim = false;
          verbatimEnv = null;
          // Pop the verbatim environment from the stack
          if (envStack.length > 0 && envStack[envStack.length - 1].name === endMatch[1]) {
            envStack.pop();
          }
          i += endMatch[0].length;
          continue;
        }
        i++;
        continue;
      }

      // Inside a skipped command argument (e.g. \cite{...} spanning multiple lines)
      if (skipBraceDepth > 0) {
        if (ch === '{') skipBraceDepth++;
        else if (ch === '}') skipBraceDepth--;
        i++;
        continue;
      }

      // Comment — skip rest of line
      if (ch === '%' && (i === 0 || line[i - 1] !== '\\')) {
        break;
      }

      // Escaped special characters — skip (e.g. \& \# \$ \_ \%)
      if (ch === '\\' && i + 1 < line.length && '&#$_%^~{}'.includes(line[i + 1])) {
        i += 2;
        continue;
      }

      // \verb|...|
      if (ch === '\\' && line.slice(i).startsWith('\\verb')) {
        const verbMatch = line.slice(i).match(/^\\verb(.)(.*?)\1/);
        if (verbMatch) {
          i += verbMatch[0].length;
          continue;
        }
      }

      // \begin{env}
      if (ch === '\\' && line.slice(i).startsWith('\\begin{')) {
        const envMatch = line.slice(i).match(/^\\begin\{([^}]+)\}/);
        if (envMatch) {
          const envName = envMatch[1];
          if (VERBATIM_ENVS.has(envName)) {
            inVerbatim = true;
            verbatimEnv = envName;
          }
          envStack.push({ name: envName, line: lineNum });
          i += envMatch[0].length;
          continue;
        }
      }

      // \end{env}
      if (ch === '\\' && line.slice(i).startsWith('\\end{')) {
        const envMatch = line.slice(i).match(/^\\end\{([^}]+)\}/);
        if (envMatch) {
          const envName = envMatch[1];
          // Pop stack — check for mismatch
          if (envStack.length > 0) {
            const top = envStack[envStack.length - 1];
            if (top.name === envName) {
              envStack.pop();
            } else {
              diagnostics.push({
                line: lineNum,
                col: i + 1,
                len: envMatch[0].length,
                severity: 'error',
                message: `Environment mismatch: expected \\end{${top.name}}, got \\end{${envName}}`,
              });
              // Try to recover — pop if we find the matching one
              const matchIdx = envStack.findLastIndex((e) => e.name === envName);
              if (matchIdx >= 0) {
                envStack.splice(matchIdx);
              }
            }
          } else {
            diagnostics.push({
              line: lineNum,
              col: i + 1,
              len: envMatch[0].length,
              severity: 'error',
              message: `\\end{${envName}} without matching \\begin{${envName}}`,
            });
          }
          i += envMatch[0].length;
          continue;
        }
      }

      // \newcommand, \renewcommand, \def, etc. — enters macro definition mode
      if (
        ch === '\\' &&
        /^\\(re)?(newcommand|newenvironment|providecommand)|^\\def[^a-zA-Z]|^\\Declare|^\\NewDocument|^\\RenewDocument|^\\ProvideDocument/.test(
          line.slice(i),
        )
      ) {
        inMacroDef = true;
        braceDepthAtMacroDef = braceDepth;
        // Skip the command preamble (name, arg specs, etc.)
        const cmdMatch = line
          .slice(i)
          .match(
            /^\\(?:re)?(?:newcommand|providecommand)\*?\{[^}]*\}(\[\d+\](\[[^\]]*\])?)*|^\\(?:re)?newenvironment\*?\{[^}]*\}(\[\d+\])*|^\\def\\[a-zA-Z]+|^\\(?:Declare\w+|(?:New|Renew|Provide)Document\w+)\*?\{[^}]*\}(\{[^}]*\})*(\[\d+\])*/,
          );
        if (cmdMatch) {
          i += cmdMatch[0].length;
          continue;
        }
      }

      // \( and \)
      if (ch === '\\' && line[i + 1] === '(') {
        mathParenDepth++;
        i += 2;
        continue;
      }
      if (ch === '\\' && line[i + 1] === ')') {
        if (mathParenDepth > 0) mathParenDepth--;
        i += 2;
        continue;
      }

      // \[ and \]
      if (ch === '\\' && line[i + 1] === '[') {
        mathBracketDepth++;
        i += 2;
        continue;
      }
      if (ch === '\\' && line[i + 1] === ']') {
        if (mathBracketDepth > 0) mathBracketDepth--;
        i += 2;
        continue;
      }

      // Skip other commands (don't check their letters)
      if (ch === '\\' && i + 1 < line.length && /[a-zA-Z]/.test(line[i + 1])) {
        i++;
        const cmdStart = i;
        while (i < line.length && /[a-zA-Z*]/.test(line[i])) i++;
        const cmd = line.slice(cmdStart, i);
        // Skip brace arguments of commands that take keys/labels/references
        if (
          /^(cite[a-z]*\*?|Cite[a-z]*\*?|autocite\*?|Autocite\*?|parencite\*?|Parencite\*?|textcite\*?|Textcite\*?|fullcite|nocite|footcite\*?|supercite|smartcite\*?|notecite|ref|eqref|pageref|label|hyperref|url|href|includegraphics|input|include|bibliography|bibliographystyle|usepackage|documentclass|RequirePackage)$/.test(
            cmd,
          )
        ) {
          // Skip optional [...]
          while (i < line.length && /\s/.test(line[i])) i++;
          if (i < line.length && line[i] === '[') {
            let depth = 1;
            i++;
            while (i < line.length && depth > 0) {
              if (line[i] === '[') depth++;
              else if (line[i] === ']') depth--;
              i++;
            }
          }
          // Skip brace {...} — may span multiple lines
          while (i < line.length && /\s/.test(line[i])) i++;
          if (i < line.length && line[i] === '{') {
            skipBraceDepth = 1;
            i++;
            // Consume as much as possible on this line
            while (i < line.length && skipBraceDepth > 0) {
              if (line[i] === '{') skipBraceDepth++;
              else if (line[i] === '}') skipBraceDepth--;
              i++;
            }
          }
        }
        continue;
      }

      // $$ display math toggle
      if (ch === '$' && i + 1 < line.length && line[i + 1] === '$') {
        inMathDisplay = !inMathDisplay;
        i += 2;
        continue;
      }

      // $ inline math toggle
      if (ch === '$') {
        inMathInline = !inMathInline;
        i++;
        continue;
      }

      // Track brace depth for macro def scope
      if (ch === '{') {
        braceDepth++;
        i++;
        continue;
      }
      if (ch === '}') {
        braceDepth--;
        if (braceDepth < 0) {
          diagnostics.push({
            line: lineNum,
            col: i + 1,
            len: 1,
            severity: 'error',
            message: 'Unmatched "}" — too many closing braces',
          });
          braceDepth = 0; // reset to avoid cascading errors
        }
        if (inMacroDef && braceDepth <= braceDepthAtMacroDef) {
          inMacroDef = false;
        }
        i++;
        continue;
      }

      // --- Check special characters ---

      // & — only valid in alignment environments
      if (ch === '&') {
        if (!inAlignEnv()) {
          diagnostics.push({
            line: lineNum,
            col: i + 1,
            len: 1,
            severity: 'error',
            message: 'Misplaced alignment character "&" — use \\& for a literal ampersand',
          });
        }
        i++;
        continue;
      }

      // # — valid in macro definitions; #1-#9 is always a parameter reference
      if (ch === '#') {
        if (i + 1 < line.length && /[1-9]/.test(line[i + 1])) {
          i += 2; // skip #N parameter reference
        } else if (!inMacroDef) {
          diagnostics.push({
            line: lineNum,
            col: i + 1,
            len: 1,
            severity: 'error',
            message: 'Misplaced "#" — only valid in macro definitions, use \\# for a literal hash',
          });
          i++;
        } else {
          i++;
        }
        continue;
      }

      // _ and ^ — only valid in math mode
      if (ch === '_' || ch === '^') {
        if (!inMath()) {
          const name = ch === '_' ? 'underscore' : 'caret';
          const escape = ch === '_' ? '\\_' : '\\^{}';
          diagnostics.push({
            line: lineNum,
            col: i + 1,
            len: 1,
            severity: 'error',
            message: `Misplaced "${ch}" outside math mode — use ${escape} for a literal ${name}`,
          });
        }
        i++;
        continue;
      }

      i++;
    }
  }

  // Check for unclosed math modes
  if (inMathInline) {
    diagnostics.push({
      line: lines.length,
      col: 1,
      len: 0,
      severity: 'error',
      message: 'Unclosed inline math mode ($)',
    });
  }
  if (inMathDisplay) {
    diagnostics.push({
      line: lines.length,
      col: 1,
      len: 0,
      severity: 'error',
      message: 'Unclosed display math mode ($$)',
    });
  }

  // Check for unclosed braces
  if (braceDepth > 0) {
    diagnostics.push({
      line: lines.length,
      col: 1,
      len: 0,
      severity: 'error',
      message: `${braceDepth} unclosed "{" — missing closing brace${braceDepth > 1 ? 's' : ''}`,
    });
  }

  // Check for unclosed environments
  for (const env of envStack) {
    diagnostics.push({
      line: env.line,
      col: 1,
      len: 0,
      severity: 'error',
      message: `Unclosed environment: \\begin{${env.name}} never closed`,
    });
  }

  return diagnostics;
}
