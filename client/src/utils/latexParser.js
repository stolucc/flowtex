/**
 * LaTeX Parser — tokenizer, tree builder, and query utilities.
 *
 * LaTeX is not a context-free grammar: commands can redefine the parser itself.
 * This parser is pragmatic — it handles the patterns that appear in real documents
 * without trying to execute TeX. It tracks:
 *
 *   - Brace groups with full nesting and position info
 *   - Math modes: $, $$, \(, \), \[, \]
 *   - Environments: \begin{name}...\end{name} with proper nesting
 *   - Commands with optional [...] and required {...} arguments
 *   - Comments (% to end of line)
 *   - Verbatim environments and \verb
 *   - Special characters in context (&, #, _, ^)
 *   - Macro definitions (\newcommand, \def, etc.)
 *
 * The parser produces a flat token stream and a lightweight AST (tree of nodes).
 * Utility functions allow querying structure (find tables, sections, environments, etc.)
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 *   import { parse, tokenize, findEnvironments, findTables, nodeAtPos } from './latexParser.js';
 *
 *   const tree = parse(source);
 *   const tables = findTables(tree);
 *   const node = nodeAtPos(tree, cursorPos);
 */

// ─── Token Types ─────────────────────────────────────────────────────────────

export const T = Object.freeze({
  TEXT:        'text',
  COMMAND:     'command',      // \name or \name*
  BEGIN:       'begin',        // \begin  (the command itself)
  END:         'end',          // \end    (the command itself)
  OPEN_BRACE:  '{',
  CLOSE_BRACE: '}',
  OPEN_BRACKET:'[',
  CLOSE_BRACKET:']',
  MATH_INLINE: 'math_inline', // $ or \( or \)
  MATH_DISPLAY:'math_display', // $$ or \[ or \]
  AMPERSAND:   '&',
  HASH:        '#',
  SUBSCRIPT:   '_',
  SUPERSCRIPT: '^',
  TILDE:       '~',
  NEWLINE:     'newline',      // \\
  COMMENT:     'comment',      // % to end of line
  VERBATIM:    'verbatim',     // contents of verbatim env or \verb
  WHITESPACE:  'whitespace',
  PARAM:       'param',        // #1, #2, etc.
});

// ─── AST Node Types ──────────────────────────────────────────────────────────

export const N = Object.freeze({
  ROOT:        'root',
  ENVIRONMENT: 'environment',
  COMMAND:     'command',
  GROUP:       'group',        // { ... }
  OPT_ARG:     'opt_arg',     // [ ... ]
  MATH_INLINE: 'math_inline',
  MATH_DISPLAY:'math_display',
  TEXT:        'text',
  COMMENT:     'comment',
  VERBATIM:    'verbatim',
});

// ─── Known Sets ──────────────────────────────────────────────────────────────

const VERBATIM_ENVS = new Set([
  'verbatim', 'verbatim*', 'lstlisting', 'minted', 'alltt', 'comment',
  'Verbatim', 'BVerbatim', 'LVerbatim', 'SaveVerbatim',
]);

const MATH_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'aligned', 'alignat',
  'alignat*', 'gather', 'gather*', 'gathered', 'multline', 'multline*',
  'flalign', 'flalign*', 'split', 'math', 'displaymath', 'eqnarray',
  'eqnarray*', 'matrix', 'pmatrix', 'bmatrix', 'vmatrix', 'Vmatrix',
  'Bmatrix', 'cases', 'dcases', 'rcases',
]);

const ALIGN_ENVS = new Set([
  'tabular', 'tabular*', 'tabularx', 'tabulary', 'tabu', 'longtabu',
  'array', 'longtable', 'supertabular', 'supertabular*',
  'delarray', 'NiceTabular', 'NiceTabular*', 'NiceArray',
  'blockarray', 'block', 'ctabular',
  'matrix', 'pmatrix', 'bmatrix', 'vmatrix', 'Vmatrix', 'Bmatrix',
  'smallmatrix', 'cases', 'dcases', 'rcases', 'drcases', 'cases*',
  'align', 'align*', 'aligned', 'alignat', 'alignat*', 'alignedat',
  'eqnarray', 'eqnarray*', 'split', 'gathered', 'multline', 'multline*',
  'flalign', 'flalign*',
  'IEEEeqnarray', 'IEEEeqnarray*', 'systeme',
]);

const TABLE_ENVS = new Set([
  'tabular', 'tabular*', 'tabularx', 'tabulary', 'tabu', 'longtabu',
  'array', 'longtable', 'supertabular', 'supertabular*',
  'NiceTabular', 'NiceTabular*', 'NiceArray',
]);

// Commands whose first brace argument is not prose (labels, refs, filenames, etc.)
const NON_PROSE_COMMANDS = new Set([
  'cite', 'citep', 'citet', 'autocite', 'parencite', 'textcite', 'fullcite',
  'nocite', 'citeauthor', 'citeyear', 'citealt', 'citealp',
  'Cite', 'Citep', 'Citet',
  'ref', 'eqref', 'pageref', 'label', 'hyperref', 'url', 'href',
  'includegraphics', 'input', 'include', 'bibliography', 'bibliographystyle',
  'usepackage', 'RequirePackage', 'documentclass',
  'newcommand', 'renewcommand', 'providecommand',
  'newcommand*', 'renewcommand*', 'providecommand*',
  'newenvironment', 'renewenvironment',
  'DeclareMathOperator', 'DeclareMathOperator*',
  'DeclareRobustCommand', 'NewDocumentCommand', 'RenewDocumentCommand',
  'def',
]);

// Commands whose brace argument IS prose (should be spell-checked)
const PROSE_COMMANDS = new Set([
  'title', 'author', 'date', 'thanks', 'abstract',
  'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph',
  'section*', 'subsection*', 'subsubsection*', 'paragraph*', 'subparagraph*',
  'chapter', 'chapter*', 'part', 'part*',
  'caption', 'footnote', 'footnotetext', 'marginpar',
  'text', 'textbf', 'textit', 'texttt', 'textrm', 'textsf', 'textsc',
  'textsl', 'textup', 'textmd',
  'emph', 'underline', 'mbox', 'fbox', 'parbox', 'minipage',
  'quote', 'quotation',
  'item',
]);

// Commands known to take at least one argument (brace or optional)
// Only these will have readArgs() called — prevents greedy consumption
const COMMANDS_WITH_ARGS = new Set([
  // Sectioning
  'part', 'part*', 'chapter', 'chapter*',
  'section', 'section*', 'subsection', 'subsection*',
  'subsubsection', 'subsubsection*', 'paragraph', 'paragraph*', 'subparagraph', 'subparagraph*',
  // Text formatting
  'textbf', 'textit', 'texttt', 'textrm', 'textsf', 'textsc', 'textsl', 'textup', 'textmd',
  'emph', 'underline', 'mbox', 'fbox', 'makebox', 'framebox', 'parbox', 'raisebox',
  'textsuperscript', 'textsubscript',
  // Math
  'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'mathcal', 'mathbb', 'mathfrak', 'mathscr',
  'frac', 'dfrac', 'tfrac', 'sqrt', 'binom', 'overset', 'underset', 'stackrel',
  'hat', 'bar', 'vec', 'dot', 'ddot', 'tilde', 'widetilde', 'widehat', 'overline', 'underline',
  'overbrace', 'underbrace', 'operatorname',
  // References, citations, labels
  'cite', 'citep', 'citet', 'autocite', 'parencite', 'textcite', 'fullcite',
  'nocite', 'citeauthor', 'citeyear', 'citealt', 'citealp',
  'Cite', 'Citep', 'Citet',
  'ref', 'eqref', 'pageref', 'label', 'hyperref', 'url', 'href', 'hypersetup',
  // Structure
  'title', 'author', 'date', 'thanks', 'institute',
  'caption', 'caption*', 'footnote', 'footnotetext', 'marginpar',
  // Includes
  'input', 'include', 'usepackage', 'RequirePackage', 'documentclass',
  'bibliography', 'bibliographystyle', 'addbibresource',
  'includegraphics', 'graphicspath',
  // Definitions
  'newcommand', 'renewcommand', 'providecommand',
  'newcommand*', 'renewcommand*', 'providecommand*',
  'newenvironment', 'renewenvironment',
  'NewDocumentCommand', 'RenewDocumentCommand', 'ProvideDocumentCommand',
  'DeclareRobustCommand', 'DeclareMathOperator', 'DeclareMathOperator*',
  'newlength', 'setlength', 'addtolength', 'setcounter', 'addtocounter', 'newcounter',
  'newtheorem', 'newtheorem*',
  // Layout
  'geometry', 'setmainfont', 'setsansfont', 'setmonofont',
  'pagestyle', 'thispagestyle', 'pagenumbering',
  'hspace', 'hspace*', 'vspace', 'vspace*',
  'minipage', 'resizebox', 'scalebox', 'rotatebox',
  // Floats and figures
  'centering',
  // Tables
  'multicolumn', 'multirow', 'cline', 'rowcolor', 'cellcolor', 'columncolor', 'rowcolors',
  // Colors
  'color', 'textcolor', 'colorbox', 'definecolor',
  // Lists
  'item',
  // Misc
  'phantom', 'hphantom', 'vphantom',
  'rule', 'renewcommand', 'providecommand',
]);

const MACRO_DEF_COMMANDS = new Set([
  'newcommand', 'renewcommand', 'providecommand',
  'newcommand*', 'renewcommand*', 'providecommand*',
  'newenvironment', 'renewenvironment',
  'NewDocumentCommand', 'RenewDocumentCommand', 'ProvideDocumentCommand',
  'DeclareRobustCommand', 'DeclareMathOperator', 'DeclareMathOperator*',
]);


// ─── Tokenizer ───────────────────────────────────────────────────────────────
//
// Scans source text and produces a flat array of tokens, each with:
//   { type, value, from, to, line, col }
//
// The tokenizer is position-aware and handles:
//   - Escaped characters (\& \# \$ \_ \% \^ \~ \{ \})
//   - \verb|...|
//   - Comments (% to EOL)
//   - Command names (\letters with optional *)
//   - Consecutive $$ vs single $
//   - \( \) \[ \] math delimiters
//   - \\ line breaks (vs commands starting with \\)

export function tokenize(source) {
  const tokens = [];
  const len = source.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;

  function col() { return i - lineStart + 1; }

  function push(type, from, to, value) {
    tokens.push({ type, value: value ?? source.slice(from, to), from, to, line, col: from - lineStart + 1 });
  }

  function advanceLine() {
    line++;
    lineStart = i;
  }

  while (i < len) {
    const ch = source[i];

    // ── Newlines (track line/col) ──
    if (ch === '\n') {
      i++;
      advanceLine();
      continue;
    }

    // ── Comment: % to end of line ──
    if (ch === '%' && (i === 0 || source[i - 1] !== '\\')) {
      const start = i;
      while (i < len && source[i] !== '\n') i++;
      push(T.COMMENT, start, i);
      continue;
    }

    // ── Backslash sequences ──
    if (ch === '\\') {
      const start = i;

      // Escaped special characters: \& \# \$ \_ \% \^ \~ \{ \} \\
      if (i + 1 < len) {
        const next = source[i + 1];

        // \verb|...|
        if (next === 'v' && source.slice(i, i + 5) === '\\verb') {
          const afterVerb = i + 5;
          // \verb* variant
          const verbEnd = source[afterVerb] === '*' ? afterVerb + 1 : afterVerb;
          if (verbEnd < len) {
            const delim = source[verbEnd];
            const closeIdx = source.indexOf(delim, verbEnd + 1);
            if (closeIdx >= 0) {
              i = closeIdx + 1;
              push(T.VERBATIM, start, i);
              continue;
            }
          }
        }

        // \( \) — math inline delimiters
        if (next === '(') { i += 2; push(T.MATH_INLINE, start, i, '\\('); continue; }
        if (next === ')') { i += 2; push(T.MATH_INLINE, start, i, '\\)'); continue; }

        // \[ \] — math display delimiters
        if (next === '[') { i += 2; push(T.MATH_DISPLAY, start, i, '\\['); continue; }
        if (next === ']') { i += 2; push(T.MATH_DISPLAY, start, i, '\\]'); continue; }

        // \\ — line break (not a command)
        if (next === '\\') {
          i += 2;
          // optional * and optional [length]
          if (i < len && source[i] === '*') i++;
          if (i < len && source[i] === '[') {
            const close = source.indexOf(']', i);
            if (close >= 0) i = close + 1;
          }
          push(T.NEWLINE, start, i);
          continue;
        }

        // Escaped special: \& \# \$ \_ \% \^ \~ \{ \}
        if ('&#$_%^~{}'.includes(next)) {
          i += 2;
          push(T.COMMAND, start, i);
          continue;
        }

        // \begin{ or \end{ — only match when followed by { to avoid
        // matching \begingroup, \endgroup, \endfirsthead, \endhead, etc.
        if (next === 'b' && source.slice(i, i + 7) === '\\begin{') {
          i += 6;
          push(T.BEGIN, start, i, '\\begin');
          continue;
        }
        if (next === 'e' && source.slice(i, i + 5) === '\\end{') {
          i += 4;
          push(T.END, start, i, '\\end');
          continue;
        }

        // Command: \letters with optional trailing *
        if (/[a-zA-Z@]/.test(next)) {
          i++;
          while (i < len && /[a-zA-Z@]/.test(source[i])) i++;
          if (i < len && source[i] === '*') i++;
          push(T.COMMAND, start, i);
          continue;
        }

        // Single non-letter command: \, or \; or \! etc.
        i += 2;
        push(T.COMMAND, start, i);
        continue;
      }

      // Lone \ at end of input
      i++;
      push(T.TEXT, start, i);
      continue;
    }

    // ── Braces ──
    if (ch === '{') { push(T.OPEN_BRACE, i, i + 1); i++; continue; }
    if (ch === '}') { push(T.CLOSE_BRACE, i, i + 1); i++; continue; }
    if (ch === '[') { push(T.OPEN_BRACKET, i, i + 1); i++; continue; }
    if (ch === ']') { push(T.CLOSE_BRACKET, i, i + 1); i++; continue; }

    // ── Dollar math ──
    if (ch === '$') {
      const start = i;
      if (i + 1 < len && source[i + 1] === '$') {
        i += 2;
        push(T.MATH_DISPLAY, start, i, '$$');
      } else {
        i++;
        push(T.MATH_INLINE, start, i, '$');
      }
      continue;
    }

    // ── Special characters ──
    if (ch === '&') { push(T.AMPERSAND, i, i + 1); i++; continue; }
    if (ch === '#') {
      const start = i;
      if (i + 1 < len && /[1-9]/.test(source[i + 1])) {
        i += 2;
        push(T.PARAM, start, i);
      } else {
        i++;
        push(T.HASH, start, i);
      }
      continue;
    }
    if (ch === '_') { push(T.SUBSCRIPT, i, i + 1); i++; continue; }
    if (ch === '^') { push(T.SUPERSCRIPT, i, i + 1); i++; continue; }
    if (ch === '~') { push(T.TILDE, i, i + 1); i++; continue; }

    // ── Whitespace runs ──
    if (/\s/.test(ch)) {
      const start = i;
      while (i < len && /\s/.test(source[i]) && source[i] !== '\n') i++;
      push(T.WHITESPACE, start, i);
      continue;
    }

    // ── Plain text ──
    const start = i;
    while (i < len && !/[\\{}[\]$%&#_^~\n\s]/.test(source[i])) i++;
    if (i > start) {
      push(T.TEXT, start, i);
    } else {
      // Safety: advance past any unrecognized character
      i++;
      push(T.TEXT, start, i);
    }
  }

  return tokens;
}


// ─── Tree Builder ────────────────────────────────────────────────────────────
//
// Builds a lightweight AST from the token stream. Each node has:
//   { type, from, to, children, ... }
//
// Environment nodes also have: { name, args }
// Command nodes also have:     { name, args }
// Group nodes represent:       { ... }
// Math nodes represent:        $ ... $ or $$ ... $$ or \( \) or \[ \]

export function parse(source) {
  const tokens = tokenize(source);
  const root = { type: N.ROOT, from: 0, to: source.length, children: [], source };

  const stack = [root]; // stack of open containers

  function current() { return stack[stack.length - 1]; }

  function pushChild(node) {
    current().children.push(node);
  }

  function openContainer(node) {
    pushChild(node);
    stack.push(node);
  }

  function closeContainer() {
    if (stack.length > 1) {
      const closed = stack.pop();
      closed.to = closed._lastTo || closed.to;
      delete closed._lastTo;
      return closed;
    }
    return null;
  }

  let ti = 0;
  const tlen = tokens.length;

  // Lookahead helpers
  function peek(offset = 0) { return ti + offset < tlen ? tokens[ti + offset] : null; }
  function advance() { return ti < tlen ? tokens[ti++] : null; }
  function skipWhitespace() {
    while (ti < tlen && (tokens[ti].type === T.WHITESPACE || (tokens[ti].type === T.TEXT && tokens[ti].value === '\n'))) ti++;
  }

  // Read a brace group: { ... } — returns a GROUP node or null
  function readBraceGroup() {
    if (!peek() || peek().type !== T.OPEN_BRACE) return null;
    const open = advance();
    const group = { type: N.GROUP, from: open.from, to: open.to, children: [] };
    let depth = 1;
    // Collect tokens into group until matching close
    while (ti < tlen && depth > 0) {
      const tok = tokens[ti];
      if (tok.type === T.OPEN_BRACE) depth++;
      if (tok.type === T.CLOSE_BRACE) {
        depth--;
        if (depth === 0) {
          group.to = tok.to;
          ti++;
          break;
        }
      }
      // For the group's text content, just collect raw
      group.children.push(tok);
      ti++;
    }
    // Flatten group text for convenience
    group.text = group.children.map(t => t.value).join('');
    return group;
  }

  // Read an optional argument: [ ... ] — returns an OPT_ARG node or null
  function readOptArg() {
    skipWhitespace();
    if (!peek() || peek().type !== T.OPEN_BRACKET) return null;
    const open = advance();
    const arg = { type: N.OPT_ARG, from: open.from, to: open.to, children: [] };
    let depth = 1;
    while (ti < tlen && depth > 0) {
      const tok = tokens[ti];
      if (tok.type === T.OPEN_BRACKET) depth++;
      if (tok.type === T.CLOSE_BRACKET) {
        depth--;
        if (depth === 0) {
          arg.to = tok.to;
          ti++;
          break;
        }
      }
      arg.children.push(tok);
      ti++;
    }
    arg.text = arg.children.map(t => t.value).join('');
    return arg;
  }

  // Read arguments for a command: optional [...] and required {...}
  // Greedily reads alternating optional and required args
  function readArgs() {
    const args = [];
    while (ti < tlen) {
      skipWhitespace();
      const next = peek();
      if (!next) break;
      if (next.type === T.OPEN_BRACKET) {
        const opt = readOptArg();
        if (opt) args.push(opt);
        else break;
      } else if (next.type === T.OPEN_BRACE) {
        const grp = readBraceGroup();
        if (grp) args.push(grp);
        else break;
      } else {
        break;
      }
    }
    return args;
  }

  // ── Main parse loop ──

  // Math mode tracking (to pair open/close)
  const mathStack = []; // stack of { type, node }

  while (ti < tlen) {
    const tok = tokens[ti];

    // ── Comments ──
    if (tok.type === T.COMMENT) {
      pushChild({ type: N.COMMENT, from: tok.from, to: tok.to, value: tok.value });
      ti++;
      continue;
    }

    // ── \begin{name} ──
    if (tok.type === T.BEGIN) {
      ti++;
      const nameGroup = readBraceGroup();
      const envName = nameGroup ? nameGroup.text : '';
      const args = readArgs();

      // Verbatim environments: slurp everything until \end{envName}
      if (VERBATIM_ENVS.has(envName)) {
        const startPos = tok.from;
        const endPattern = '\\end{' + envName + '}';
        // Find the end marker in source text
        const searchFrom = ti < tlen ? tokens[ti].from : source.length;
        const endIdx = source.indexOf(endPattern, searchFrom);
        const verbEnd = endIdx >= 0 ? endIdx + endPattern.length : source.length;
        const verbContent = source.slice(searchFrom, endIdx >= 0 ? endIdx : source.length);

        const envNode = {
          type: N.VERBATIM,
          name: envName,
          from: startPos,
          to: verbEnd,
          content: verbContent,
          children: [],
        };
        pushChild(envNode);

        // Skip tokens until we're past the end
        while (ti < tlen && tokens[ti].from < verbEnd) ti++;
        continue;
      }

      const envNode = {
        type: N.ENVIRONMENT,
        name: envName,
        from: tok.from,
        to: nameGroup ? nameGroup.to : tok.to,
        args,
        children: [],
        isMath: MATH_ENVS.has(envName),
        isAlign: ALIGN_ENVS.has(envName),
        isTable: TABLE_ENVS.has(envName),
      };
      openContainer(envNode);
      continue;
    }

    // ── \end{name} ──
    if (tok.type === T.END) {
      ti++;
      const nameGroup = readBraceGroup();
      const envName = nameGroup ? nameGroup.text : '';
      const endTo = nameGroup ? nameGroup.to : tok.to;

      // Walk up the stack to find the matching \begin
      let found = false;
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].type === N.ENVIRONMENT && stack[s].name === envName) {
          // Close everything down to and including the match
          while (stack.length > s) {
            const closed = stack.pop();
            closed.to = endTo;
          }
          // The matched environment is now popped; it was already a child of its parent
          found = true;
          break;
        }
      }
      if (!found) {
        // Unmatched \end — record as error node
        pushChild({
          type: N.COMMAND,
          name: '\\end',
          from: tok.from,
          to: endTo,
          args: nameGroup ? [nameGroup] : [],
          children: [],
          error: `\\end{${envName}} without matching \\begin`,
        });
      }
      continue;
    }

    // ── Commands ──
    if (tok.type === T.COMMAND) {
      const cmdName = tok.value.slice(1); // strip leading \
      ti++;

      // Only read arguments for commands known to take them
      const isMacroDef = MACRO_DEF_COMMANDS.has(cmdName);
      const takesArgs = COMMANDS_WITH_ARGS.has(cmdName) || isMacroDef;
      const args = takesArgs ? readArgs() : [];

      const cmdNode = {
        type: N.COMMAND,
        name: cmdName,
        from: tok.from,
        to: args.length > 0 ? args[args.length - 1].to : tok.to,
        args,
        children: [],
        isMacroDef,
        isProse: PROSE_COMMANDS.has(cmdName),
        isNonProse: NON_PROSE_COMMANDS.has(cmdName),
      };
      pushChild(cmdNode);
      continue;
    }

    // ── Math delimiters ──
    if (tok.type === T.MATH_INLINE || tok.type === T.MATH_DISPLAY) {
      const nodeType = tok.type === T.MATH_INLINE ? N.MATH_INLINE : N.MATH_DISPLAY;
      const isOpen = tok.value === '$' || tok.value === '$$' || tok.value === '\\(' || tok.value === '\\[';
      const isClose = tok.value === '$' || tok.value === '$$' || tok.value === '\\)' || tok.value === '\\]';

      // For $ and $$, they toggle — check if we're already in math mode
      const inMath = mathStack.length > 0 && mathStack[mathStack.length - 1].type === nodeType;

      if (inMath && isClose) {
        // Close math
        const openInfo = mathStack.pop();
        // Close everything down to the math container
        while (stack.length > 0 && stack[stack.length - 1] !== openInfo.node) {
          const closed = stack.pop();
          closed.to = tok.to;
        }
        if (stack.length > 0 && stack[stack.length - 1] === openInfo.node) {
          const closed = stack.pop();
          closed.to = tok.to;
        }
      } else if (isOpen) {
        // Open math
        const mathNode = {
          type: nodeType,
          from: tok.from,
          to: tok.to,
          children: [],
          delimiter: tok.value,
        };
        openContainer(mathNode);
        mathStack.push({ type: nodeType, node: mathNode });
      }

      ti++;
      continue;
    }

    // ── Brace groups (standalone, not part of a command) ──
    if (tok.type === T.OPEN_BRACE) {
      const group = { type: N.GROUP, from: tok.from, to: tok.to, children: [] };
      openContainer(group);
      ti++;
      continue;
    }
    if (tok.type === T.CLOSE_BRACE) {
      // Find the nearest group on the stack to close
      let found = false;
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].type === N.GROUP) {
          while (stack.length > s) {
            const closed = stack.pop();
            closed.to = tok.to;
          }
          found = true;
          break;
        }
      }
      if (!found) {
        // Unmatched }
        pushChild({ type: N.TEXT, from: tok.from, to: tok.to, value: '}', error: 'Unmatched }' });
      }
      ti++;
      continue;
    }

    // ── Everything else: text, whitespace, special chars, newlines ──
    pushChild({
      type: N.TEXT,
      from: tok.from,
      to: tok.to,
      value: tok.value,
      tokenType: tok.type, // preserve the original token type for special chars
    });
    ti++;
  }

  // Close any unclosed containers
  while (stack.length > 1) {
    const unclosed = stack.pop();
    unclosed.to = source.length;
    unclosed.unclosed = true;
  }

  root.to = source.length;
  return root;
}


// ─── Query Utilities ─────────────────────────────────────────────────────────

/**
 * Walk the tree depth-first, calling visitor(node, depth) for each node.
 * Return false from visitor to skip children.
 */
export function walk(node, visitor, depth = 0) {
  const result = visitor(node, depth);
  if (result === false) return;
  if (node.children) {
    for (const child of node.children) {
      walk(child, visitor, depth + 1);
    }
  }
}

/**
 * Collect all nodes matching a predicate.
 */
export function findAll(tree, predicate) {
  const results = [];
  walk(tree, (node) => {
    if (predicate(node)) results.push(node);
  });
  return results;
}

/**
 * Find the deepest node containing a given position.
 */
export function nodeAtPos(tree, pos) {
  let best = tree;
  walk(tree, (node) => {
    if (pos >= node.from && pos <= node.to) {
      best = node;
      return; // continue into children
    }
    return false; // skip children outside range
  });
  return best;
}

/**
 * Find all ancestors of the deepest node at a position.
 * Returns [root, ..., deepest] — outermost to innermost.
 */
export function ancestorsAtPos(tree, pos) {
  const path = [];
  function descend(node) {
    if (pos >= node.from && pos <= node.to) {
      path.push(node);
      if (node.children) {
        for (const child of node.children) {
          descend(child);
        }
      }
    }
  }
  descend(tree);
  return path;
}

/**
 * Find all environment nodes, optionally filtered by name.
 */
export function findEnvironments(tree, name) {
  return findAll(tree, (node) =>
    node.type === N.ENVIRONMENT && (name == null || node.name === name)
  );
}

/**
 * Find all table environments (tabular, tabularx, longtable, array, etc.)
 * and their optional \begin{table} float wrappers.
 */
export function findTables(tree) {
  const tables = [];
  walk(tree, (node) => {
    if (node.type === N.ENVIRONMENT && node.isTable) {
      tables.push(node);
      return false; // don't recurse into nested tables
    }
  });
  return tables;
}

/**
 * Find the table environment (or table float) containing a position.
 * Returns { inner, outer, from, to } where inner is the tabular env
 * and outer is the table float wrapper (if any).
 */
export function findTableAtPos(tree, pos) {
  const ancestors = ancestorsAtPos(tree, pos);

  let inner = null;
  let outer = null;

  for (const node of ancestors) {
    if (node.type === N.ENVIRONMENT) {
      if (node.isTable) inner = node;
      if (node.name === 'table' || node.name === 'table*') outer = node;
    }
  }

  if (!inner) return null;

  // If there's a float wrapper, use its range
  const container = outer || inner;
  return {
    inner,
    outer,
    from: container.from,
    to: container.to,
  };
}

/**
 * Find all command nodes by name.
 */
export function findCommands(tree, name) {
  return findAll(tree, (node) =>
    node.type === N.COMMAND && node.name === name
  );
}

/**
 * Get the document structure: sections, subsections, etc.
 * Returns a flat list of { level, title, from, to } objects.
 */
export function getStructure(tree) {
  const levels = {
    'part': 0, 'part*': 0,
    'chapter': 1, 'chapter*': 1,
    'section': 2, 'section*': 2,
    'subsection': 3, 'subsection*': 3,
    'subsubsection': 4, 'subsubsection*': 4,
    'paragraph': 5, 'paragraph*': 5,
    'subparagraph': 6, 'subparagraph*': 6,
  };

  const structure = [];
  walk(tree, (node) => {
    if (node.type === N.COMMAND && node.name in levels) {
      const titleArg = node.args.find(a => a.type === N.GROUP);
      structure.push({
        level: levels[node.name],
        name: node.name,
        title: titleArg ? titleArg.text : '',
        from: node.from,
        to: node.to,
      });
    }
  });
  return structure;
}


// ─── Table Parsing ───────────────────────────────────────────────────────────
//
// Parse a table environment node (from the AST) into a structured representation
// with rows, columns, alignment, borders, captions, labels, etc.

/**
 * Parse a table from its AST node(s) into structured data.
 * Accepts the result of findTableAtPos() or a single environment node.
 */
export function parseTable(tableInfo, source) {
  const inner = tableInfo.inner || tableInfo;
  const outer = tableInfo.outer || null;
  const text = source.slice(tableInfo.from ?? inner.from, tableInfo.to ?? inner.to);

  const result = {
    env: inner.name,
    alignment: 'c',
    alignments: [],    // per-column alignment
    borders: 'none',
    headerRow: false,
    boldHeader: false,
    caption: false,
    captionText: '',
    label: '',
    centering: false,
    zebra: false,
    booktabs: false,
    rows: 0,
    cols: 0,
    cells: [],
    merges: [],     // Array of { row, col, rowSpan, colSpan, align }
    // Position info for replacement
    from: tableInfo.from ?? inner.from,
    to: tableInfo.to ?? inner.to,
  };

  // ── Parse column spec from the environment's arguments ──
  // The first required arg (GROUP) of the inner env is the col spec
  // For tabularx, the first arg is the width, second is the col spec
  const innerArgs = inner.args || [];
  let colSpecArg = null;
  if (inner.name === 'tabularx' || inner.name === 'tabulary') {
    colSpecArg = innerArgs.filter(a => a.type === N.GROUP)[1]; // second brace group
  } else {
    colSpecArg = innerArgs.find(a => a.type === N.GROUP);
  }

  if (colSpecArg) {
    result.rawColSpec = colSpecArg.text;
    // Parse custom column types from preamble
    const customTypes = parseCustomColumnTypes(source);
    result.customColumnTypes = customTypes.size > 0 ? Object.fromEntries(customTypes) : undefined;
    parseColumnSpec(colSpecArg.text, result, customTypes);
  }

  // ── Scan the outer float wrapper for caption, label, centering ──
  if (outer) {
    walk(outer, (node) => {
      if (node === inner) return false; // don't recurse into the tabular itself
      if (node.type === N.COMMAND) {
        if (node.name === 'caption' || node.name === 'caption*') {
          result.caption = true;
          const arg = node.args.find(a => a.type === N.GROUP);
          result.captionText = arg ? arg.text : '';
        }
        if (node.name === 'label') {
          const arg = node.args.find(a => a.type === N.GROUP);
          result.label = arg ? arg.text : '';
        }
        if (node.name === 'centering') {
          result.centering = true;
        }
        if (node.name === 'rowcolors') {
          result.zebra = true;
        }
      }
    });
  }

  // Also check inside longtable for caption/label (they go inside)
  if (inner.name === 'longtable') {
    walk(inner, (node) => {
      if (node.type === N.COMMAND) {
        if (node.name === 'caption' || node.name === 'caption*') {
          result.caption = true;
          const arg = node.args.find(a => a.type === N.GROUP);
          result.captionText = arg ? arg.text : '';
        }
        if (node.name === 'label') {
          const arg = node.args.find(a => a.type === N.GROUP);
          result.label = arg ? arg.text : '';
        }
      }
    });
  }

  // ── Parse rows from the environment body ──
  // Rows are separated by \\ (NEWLINE tokens in the children)
  // \hline, \toprule, \midrule, \bottomrule are row separators/decorations
  parseTableRows(inner, source, result);

  return result;
}

/**
 * Parse a LaTeX column specification string like |c|l|r| or >{\centering}p{5cm}
 */
function parseColumnSpec(spec, result, customTypes) {
  const alignments = [];
  const vlinePositions = []; // track which positions have |
  let hasVerticalBars = false;
  let pendingVline = false;
  let i = 0;

  while (i < spec.length) {
    const ch = spec[i];

    // Vertical bar
    if (ch === '|') {
      hasVerticalBars = true;
      pendingVline = true;
      vlinePositions.push(alignments.length); // position = current column count (before next col)
      i++;
      continue;
    }

    // Simple alignment: l, c, r, X (tabularx)
    if ('lcrX'.includes(ch)) {
      alignments.push(ch === 'X' ? 'c' : ch);
      i++;
      continue;
    }

    // Paragraph columns: p{width}, m{width}, b{width}
    // Also uppercase variants as fallback (when not defined via \newcolumntype)
    if ('pmbPMBLRC'.includes(ch) && !(customTypes && customTypes.has(ch)) && i + 1 < spec.length && spec[i + 1] === '{') {
      const align = ch === 'R' ? 'r' : ch === 'C' || ch === 'P' ? 'c' : 'l';
      alignments.push(align);
      i++;
      // Skip {width}
      if (i < spec.length && spec[i] === '{') {
        let depth = 1;
        i++;
        while (i < spec.length && depth > 0) {
          if (spec[i] === '{') depth++;
          if (spec[i] === '}') depth--;
          i++;
        }
      }
      continue;
    }

    // Column modifier: >{...} or <{...} or @{...} or !{...}
    if ('><!@'.includes(ch)) {
      i++;
      if (i < spec.length && spec[i] === '{') {
        let depth = 1;
        i++;
        while (i < spec.length && depth > 0) {
          if (spec[i] === '{') depth++;
          if (spec[i] === '}') depth--;
          i++;
        }
      }
      continue;
    }

    // *{count}{spec} — repeated columns
    if (ch === '*') {
      i++;
      // Read count
      let count = '';
      if (i < spec.length && spec[i] === '{') {
        let depth = 1;
        i++;
        while (i < spec.length && depth > 0) {
          if (spec[i] === '{') depth++;
          else if (spec[i] === '}') depth--;
          else if (depth === 1) count += spec[i];
          i++;
        }
      }
      // Read sub-spec
      let subSpec = '';
      if (i < spec.length && spec[i] === '{') {
        let depth = 1;
        i++;
        while (i < spec.length && depth > 0) {
          if (spec[i] === '{') depth++;
          else if (spec[i] === '}') depth--;
          else if (depth === 1) subSpec += spec[i];
          i++;
        }
      }
      // Recursively parse the sub-spec and repeat
      const subResult = { alignments: [] };
      parseColumnSpec(subSpec, subResult);
      const n = parseInt(count, 10) || 1;
      for (let j = 0; j < n; j++) {
        alignments.push(...subResult.alignments);
      }
      continue;
    }

    // Custom column types from \newcolumntype declarations
    if (customTypes && customTypes.has(ch)) {
      const ct = customTypes.get(ch);
      alignments.push(ct.alignment);
      i++;
      // If the custom type takes a width arg, skip {width}
      if (ct.hasWidth && i < spec.length && spec[i] === '{') {
        let depth = 1;
        i++;
        while (i < spec.length && depth > 0) {
          if (spec[i] === '{') depth++;
          if (spec[i] === '}') depth--;
          i++;
        }
      }
      continue;
    }

    // Skip whitespace and other unknown chars
    i++;
  }

  result.alignments = alignments;
  result.cols = alignments.length || result.cols;

  // Determine dominant alignment
  if (alignments.length > 0) {
    const counts = { l: 0, c: 0, r: 0 };
    for (const a of alignments) counts[a] = (counts[a] || 0) + 1;
    result.alignment = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }

  // Build vlines array: cols+1 booleans
  const numCols = alignments.length || result.cols;
  const vlines = Array(numCols + 1).fill(false);
  for (const pos of vlinePositions) {
    if (pos >= 0 && pos <= numCols) vlines[pos] = true;
  }
  result.vlines = vlines;

  // Border detection
  if (hasVerticalBars) {
    result.borders = 'all';
  }
}

/**
 * Parse table rows from the environment's children.
 */
function parseTableRows(envNode, source, result) {
  // Extract the body text between \begin{env}{spec} and \end{env}
  // We work from the raw source for reliability
  const envText = source.slice(envNode.from, envNode.to);

  // Find the end of the opening \begin{env}{spec}[opts] — must handle nested braces
  const beginTag = '\\begin{' + envNode.name + '}';
  let bodyStart = envText.indexOf(beginTag);
  if (bodyStart < 0) bodyStart = 0;
  else {
    bodyStart += beginTag.length;
    // Skip brace groups and bracket groups after the begin tag
    while (bodyStart < envText.length) {
      const ch = envText[bodyStart];
      if (ch === '{') {
        let depth = 1;
        bodyStart++;
        while (bodyStart < envText.length && depth > 0) {
          if (envText[bodyStart] === '{') depth++;
          if (envText[bodyStart] === '}') depth--;
          bodyStart++;
        }
      } else if (ch === '[') {
        let depth = 1;
        bodyStart++;
        while (bodyStart < envText.length && depth > 0) {
          if (envText[bodyStart] === '[') depth++;
          if (envText[bodyStart] === ']') depth--;
          bodyStart++;
        }
      } else {
        break;
      }
    }
  }

  // Find \end{env}
  const endPattern = new RegExp('\\\\end\\{' + escapeRegex(envNode.name) + '\\}');
  const endMatch = envText.match(endPattern);
  const bodyEnd = endMatch ? endMatch.index : envText.length;

  let body = envText.slice(bodyStart, bodyEnd);

  // Detect booktabs from full body (including preamble)
  result.booktabs = /\\toprule|\\midrule|\\bottomrule/.test(body);

  // For longtable: strip preamble sections (\caption, \endfirsthead, \endhead, \endfoot, \endlastfoot)
  // Data rows appear after the last of these markers.
  const longtableMarkers = ['\\endlastfoot', '\\endfoot', '\\endhead', '\\endfirsthead'];
  let preambleEnd = -1;
  for (const marker of longtableMarkers) {
    const idx = body.indexOf(marker);
    if (idx >= 0) {
      const end = idx + marker.length;
      if (end > preambleEnd) preambleEnd = end;
    }
  }
  // For longtable: extract header row from preamble, then keep only data rows
  let longtableHeader = null;
  if (preambleEnd > 0) {
    const preamble = body.slice(0, preambleEnd);
    // Find the first \endfirsthead section — header row is between \begin and \endfirsthead
    const firstheadIdx = preamble.indexOf('\\endfirsthead');
    if (firstheadIdx >= 0) {
      const headerSection = preamble.slice(0, firstheadIdx);
      const headerRows = splitTableRows(headerSection);
      for (const rowText of headerRows) {
        // Strip rule commands and \caption{...}\label{...} before checking for header content
        const cleaned = rowText
          .replace(/\\(?:toprule|midrule|bottomrule|hline|addlinespace(?:\[[^\]]*\])?)\s*/g, '')
          .replace(/\\caption\{[^}]*\}(?:\\label\{[^}]*\})?\s*/g, '')
          .replace(/\\caption\*?\{[^}]*\}\s*/g, '')
          .replace(/\\label\{[^}]*\}\s*/g, '')
          .trim();
        if (!cleaned) continue;
        // Must contain & to be a real header row
        if (cleaned.includes('&')) {
          longtableHeader = splitOnAmpersand(cleaned);
          break;
        }
      }
    }
    result.longtablePreamble = body.slice(0, preambleEnd);
    body = body.slice(preambleEnd);
  }
  if (!result.booktabs && /\\hline/.test(body)) {
    if (result.borders !== 'all') result.borders = 'horizontal';
  }

  // Split on \\ (line breaks), being careful with brace nesting
  const rows = splitTableRows(body);

  const dataRows = [];
  for (const rowText of rows) {
    const trimmed = rowText.trim();
    // Skip empty rows and rows that are just \hline / \toprule / etc.
    if (!trimmed) continue;
    if (/^\\(?:hline|toprule|midrule|bottomrule|cline\{[^}]*\}|addlinespace(?:\[[^\]]*\])?)$/.test(trimmed)) continue;

    // Remove leading/trailing \hline etc. from the row
    const cleaned = trimmed
      .replace(/^\\(?:hline|toprule|midrule|bottomrule)\s*/g, '')
      .replace(/\s*\\(?:hline|toprule|midrule|bottomrule)\s*$/g, '')
      .trim();

    if (!cleaned) continue;

    // Split on & (respecting brace nesting)
    const cells = splitOnAmpersand(cleaned);
    dataRows.push(cells);
  }

  // Prepend longtable header if extracted from preamble
  if (longtableHeader) {
    dataRows.unshift(longtableHeader);
  }

  // ── Detect \multicolumn and \multirow, build merges array ──
  const merges = [];
  const multicolRe = /^\\multicolumn\{(\d+)\}\{([^}]*)\}/;
  const multirowRe = /^\\multirow(?:\[([^\]]*)\])?\{(\d+)\}\{([^}]*)\}/;

  for (let r = 0; r < dataRows.length; r++) {
    const row = dataRows[r];
    // Process cells right-to-left so index insertions don't shift
    for (let c = row.length - 1; c >= 0; c--) {
      // Strip \addlinespace and surrounding whitespace before checking for multi commands
      const cell = (row[c] || '').replace(/\\addlinespace(?:\[[^\]]*\])?\s*/g, '').trim();
      row[c] = cell; // update the cell with cleaned content
      const mcolMatch = cell.match(multicolRe);
      if (mcolMatch) {
        const colSpan = parseInt(mcolMatch[1], 10);
        const align = mcolMatch[2].replace(/\|/g, '');
        // Extract inner content — need brace-aware extraction after the 2nd }
        const innerContent = extractMulticolContent(cell);
        // Check if inner content is a \multirow
        const mrowInner = innerContent.trim().match(multirowRe);
        if (mrowInner) {
          const rowSpan = parseInt(mrowInner[2], 10);
          const mrowContent = extractMultirowContent(innerContent.trim());
          merges.push({ row: r, col: c, rowSpan, colSpan, align });
          row[c] = mrowContent;
        } else {
          merges.push({ row: r, col: c, rowSpan: 1, colSpan, align });
          row[c] = innerContent;
        }
        // Expand row: insert (colSpan - 1) null placeholders after this cell
        const nulls = new Array(colSpan - 1).fill(null);
        row.splice(c + 1, 0, ...nulls);
      } else {
        const mrowMatch = cell.match(multirowRe);
        if (mrowMatch) {
          const rowSpan = parseInt(mrowMatch[2], 10);
          const content = extractMultirowContent(cell);
          merges.push({ row: r, col: c, rowSpan, colSpan: 1, align: null });
          row[c] = content;
        }
      }
    }
  }

  // Mark cells covered by multirow spans as null
  for (const m of merges) {
    if (m.rowSpan > 1) {
      for (let dr = 1; dr < m.rowSpan; dr++) {
        const tr = m.row + dr;
        if (tr < dataRows.length) {
          for (let dc = 0; dc < m.colSpan; dc++) {
            if (m.col + dc < dataRows[tr].length) {
              dataRows[tr][m.col + dc] = null;
            }
          }
        }
      }
    }
  }

  result.merges = merges;
  result.cells = dataRows;
  result.rows = dataRows.length;
  if (dataRows.length > 0) {
    result.cols = Math.max(result.cols, ...dataRows.map(r => r.length));
  }

  // Detect header row
  if (dataRows.length > 0) {
    const firstRow = dataRows[0];
    const hasContent = firstRow.some(c => c != null && c.trim().length > 0);
    if (hasContent) {
      result.headerRow = true;
      result.boldHeader = firstRow.some(c => c != null && /\\textbf\s*\{/.test(c));
    }
  }
}

/**
 * Extract the 3rd brace-group content from \multicolumn{n}{align}{content}.
 */
function extractMulticolContent(cell) {
  let depth = 0, groups = 0, start = -1;
  for (let i = 0; i < cell.length; i++) {
    if (cell[i] === '{') {
      depth++;
      if (depth === 1) { groups++; start = i + 1; }
    } else if (cell[i] === '}') {
      depth--;
      if (depth === 0 && groups === 3) return cell.slice(start, i);
    }
  }
  return cell;
}

/**
 * Extract the 3rd brace-group content from \multirow{n}{width}{content}.
 * Handles optional [] arg: \multirow[vpos]{n}{width}{content}
 */
function extractMultirowContent(cell) {
  let i = 0;
  // Skip past \multirow
  const cmd = cell.match(/^\\multirow(?:\[[^\]]*\])?/);
  if (cmd) i = cmd[0].length;
  let depth = 0, groups = 0, start = -1;
  for (; i < cell.length; i++) {
    if (cell[i] === '{') {
      depth++;
      if (depth === 1) { groups++; start = i + 1; }
    } else if (cell[i] === '}') {
      depth--;
      if (depth === 0 && groups === 3) return cell.slice(start, i);
    }
  }
  return cell;
}

/**
 * Split table body on \\ respecting brace nesting.
 */
function splitTableRows(body) {
  const rows = [];
  let current = '';
  let depth = 0;
  let i = 0;

  while (i < body.length) {
    const ch = body[i];

    if (ch === '{') { depth++; current += ch; i++; continue; }
    if (ch === '}') { depth--; current += ch; i++; continue; }

    // Check for \\ at depth 0
    if (depth === 0 && ch === '\\' && i + 1 < body.length && body[i + 1] === '\\') {
      rows.push(current);
      current = '';
      i += 2;
      // Skip optional * and [length]
      if (i < body.length && body[i] === '*') i++;
      if (i < body.length && body[i] === '[') {
        const close = body.indexOf(']', i);
        if (close >= 0) i = close + 1;
      }
      continue;
    }

    // Skip LaTeX comments
    if (ch === '%' && (i === 0 || body[i - 1] !== '\\')) {
      while (i < body.length && body[i] !== '\n') i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (current.trim()) rows.push(current);
  return rows;
}

/**
 * Split a row on & characters, respecting brace nesting.
 */
function splitOnAmpersand(text) {
  const cells = [];
  let current = '';
  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    if (ch === '}') depth--;

    if (ch === '&' && depth === 0) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


// ─── Context Queries ─────────────────────────────────────────────────────────
//
// These functions answer questions about what context a given position is in.

/**
 * Determine the context at a given position.
 * Returns an object describing the context:
 *   { inMath, inAlign, inVerbatim, inComment, inMacroDef, environments }
 */
export function contextAtPos(tree, pos) {
  const ancestors = ancestorsAtPos(tree, pos);

  const ctx = {
    inMath: false,
    inMathInline: false,
    inMathDisplay: false,
    inAlign: false,
    inVerbatim: false,
    inComment: false,
    inMacroDef: false,
    inTable: false,
    environments: [],
    commands: [],
  };

  for (const node of ancestors) {
    if (node.type === N.MATH_INLINE) {
      ctx.inMath = true;
      ctx.inMathInline = true;
    }
    if (node.type === N.MATH_DISPLAY) {
      ctx.inMath = true;
      ctx.inMathDisplay = true;
    }
    if (node.type === N.ENVIRONMENT) {
      ctx.environments.push(node.name);
      if (node.isMath) ctx.inMath = true;
      if (node.isAlign) ctx.inAlign = true;
      if (node.isTable) ctx.inTable = true;
    }
    if (node.type === N.VERBATIM) {
      ctx.inVerbatim = true;
    }
    if (node.type === N.COMMENT) {
      ctx.inComment = true;
    }
    if (node.type === N.COMMAND && node.isMacroDef) {
      ctx.inMacroDef = true;
    }
  }

  return ctx;
}

/**
 * Check if a position is inside math mode.
 */
export function inMath(tree, pos) {
  return contextAtPos(tree, pos).inMath;
}

/**
 * Check if a position is inside a verbatim context.
 */
export function inVerbatim(tree, pos) {
  return contextAtPos(tree, pos).inVerbatim;
}


// ─── Linting with the AST ───────────────────────────────────────────────────
//
// Walk the tree and check for common errors.

/**
 * Lint using the parsed AST. Returns array of { line, col, len, severity, message }.
 * This replaces the character-by-character linter with one that understands structure.
 */
export function lint(tree, source) {
  const diagnostics = [];

  // Pre-build line offset table for O(1) position lookups
  const lineOffsets = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineOffsets.push(i + 1);
  }

  function posToLineCol(pos) {
    // Binary search for line
    let lo = 0, hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineOffsets[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: pos - lineOffsets[lo] + 1 };
  }

  function report(from, len, severity, message) {
    const { line, col } = posToLineCol(from);
    diagnostics.push({ line, col, len, severity, message });
  }

  // Single-pass walk tracking context via a stack — no contextAtPos calls
  const ctxStack = [{ inMath: false, inAlign: false, inVerbatim: false, inMacroDef: false }];

  function ctx() { return ctxStack[ctxStack.length - 1]; }

  function lintWalk(node) {
    // Push context for container nodes
    let pushed = false;
    if (node.type === N.ENVIRONMENT || node.type === N.MATH_INLINE ||
        node.type === N.MATH_DISPLAY || node.type === N.VERBATIM ||
        (node.type === N.COMMAND && node.isMacroDef)) {
      const parent = ctx();
      ctxStack.push({
        inMath: parent.inMath || node.type === N.MATH_INLINE || node.type === N.MATH_DISPLAY ||
                (node.type === N.ENVIRONMENT && node.isMath),
        inAlign: parent.inAlign || (node.type === N.ENVIRONMENT && node.isAlign),
        inVerbatim: parent.inVerbatim || node.type === N.VERBATIM,
        inMacroDef: parent.inMacroDef || (node.type === N.COMMAND && node.isMacroDef),
      });
      pushed = true;
    }

    const c = ctx();

    // ── Structural errors ──
    if (node.type === N.ENVIRONMENT && node.unclosed) {
      report(node.from, 0, 'error', `Unclosed environment: \\begin{${node.name}} never closed`);
    }
    if (node.type === N.COMMAND && node.error) {
      report(node.from, node.to - node.from, 'error', node.error);
    }
    if (node.type === N.TEXT && node.error) {
      report(node.from, 1, 'error', node.error);
    }
    if ((node.type === N.MATH_INLINE || node.type === N.MATH_DISPLAY) && node.unclosed) {
      const kind = node.type === N.MATH_INLINE ? 'inline' : 'display';
      report(node.from, 0, 'error', `Unclosed ${kind} math mode`);
    }
    if (node.type === N.GROUP && node.unclosed) {
      report(node.from, 1, 'error', 'Unclosed "{" — missing closing brace');
    }

    // ── Special characters in wrong context ──
    if (node.type === N.TEXT && !c.inVerbatim) {
      if (node.tokenType === T.AMPERSAND && !c.inAlign) {
        report(node.from, 1, 'error', 'Misplaced alignment character "&" — use \\& for a literal ampersand');
      }
      if (node.tokenType === T.HASH && !c.inMacroDef) {
        report(node.from, 1, 'error', 'Misplaced "#" — only valid in macro definitions, use \\# for a literal hash');
      }
      if (node.tokenType === T.SUBSCRIPT && !c.inMath) {
        report(node.from, 1, 'error', 'Misplaced "_" outside math mode — use \\_ for a literal underscore');
      }
      if (node.tokenType === T.SUPERSCRIPT && !c.inMath) {
        report(node.from, 1, 'error', 'Misplaced "^" outside math mode — use \\^{} for a literal caret');
      }
    }

    // Recurse into children
    if (node.children) {
      for (const child of node.children) {
        lintWalk(child);
      }
    }

    if (pushed) ctxStack.pop();
  }

  lintWalk(tree);

  // Sort by position
  diagnostics.sort((a, b) => a.line - b.line || a.col - b.col);
  return diagnostics;
}


// ─── Exports ─────────────────────────────────────────────────────────────────

/**
 * Parse \newcolumntype declarations from the document preamble.
 * Returns a Map of letter -> { hasWidth: boolean, alignment: string, definition: string }
 * e.g. \newcolumntype{P}[1]{>{\centering\arraybackslash}p{#1}} -> P: { hasWidth: true, alignment: 'c', definition: '...' }
 */
export function parseCustomColumnTypes(source) {
  const types = new Map();
  // Find preamble (before \begin{document})
  const docStart = source.indexOf('\\begin{document}');
  const preamble = docStart >= 0 ? source.slice(0, docStart) : source;

  // Find \newcolumntype{X}[n]{definition} with brace-aware extraction
  const re = /\\newcolumntype\{([A-Za-z])\}(?:\[\d+\])?\{/g;
  let m;
  while ((m = re.exec(preamble)) !== null) {
    const letter = m[1];
    // Extract the full brace-balanced definition starting after the opening {
    let depth = 1, start = m.index + m[0].length, end = start;
    while (end < preamble.length && depth > 0) {
      if (preamble[end] === '{') depth++;
      else if (preamble[end] === '}') depth--;
      if (depth > 0) end++;
    }
    const def = preamble.slice(start, end);
    const hasWidth = /#1/.test(def);
    // Infer alignment from definition
    let alignment = 'l';
    if (/\\centering|\\center/.test(def)) alignment = 'c';
    else if (/\\raggedleft|\\flushright/.test(def)) alignment = 'r';
    else if (/\\raggedright|\\flushleft/.test(def)) alignment = 'l';
    // Check base type
    const baseMatch = def.match(/[pmbPMB]\{/);
    if (baseMatch && alignment === 'l') {
      // If no explicit centering/ragged, inherit from base (p = left by default)
      alignment = 'l';
    }
    types.set(letter, { hasWidth, alignment, definition: def });
  }
  return types;
}

export {
  VERBATIM_ENVS,
  MATH_ENVS,
  ALIGN_ENVS,
  TABLE_ENVS,
  NON_PROSE_COMMANDS,
  PROSE_COMMANDS,
  MACRO_DEF_COMMANDS,
};
