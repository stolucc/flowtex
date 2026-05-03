import { describe, it, expect } from 'vitest';
import {
  T,
  N,
  tokenize,
  parse,
  walk,
  findAll,
  nodeAtPos,
  ancestorsAtPos,
  findEnvironments,
  findTables,
  findTableAtPos,
  findCommands,
  getStructure,
  parseTable,
  contextAtPos,
  inMath,
  inVerbatim,
  parseCustomColumnTypes,
  lint,
} from '../latexParser.js';

// ─── Tokenizer ──────────────────────────────────────────────────────────────

describe('tokenize', () => {
  it('tokenizes plain text', () => {
    const tokens = tokenize('Hello world');
    expect(tokens).toHaveLength(3); // 'Hello', ' ', 'world'
    expect(tokens[0]).toMatchObject({ type: T.TEXT, value: 'Hello' });
    expect(tokens[1]).toMatchObject({ type: T.WHITESPACE });
    expect(tokens[2]).toMatchObject({ type: T.TEXT, value: 'world' });
  });

  it('tokenizes a simple command', () => {
    const tokens = tokenize(String.raw`\textbf{hello}`);
    expect(tokens[0]).toMatchObject({ type: T.COMMAND, value: '\\textbf' });
    expect(tokens[1]).toMatchObject({ type: T.OPEN_BRACE });
    expect(tokens[2]).toMatchObject({ type: T.TEXT, value: 'hello' });
    expect(tokens[3]).toMatchObject({ type: T.CLOSE_BRACE });
  });

  it('tokenizes starred commands', () => {
    const tokens = tokenize(String.raw`\section*`);
    expect(tokens[0]).toMatchObject({ type: T.COMMAND, value: '\\section*' });
  });

  it('tokenizes \\begin and \\end with brace lookahead', () => {
    const tokens = tokenize(String.raw`\begin{document}`);
    expect(tokens[0]).toMatchObject({ type: T.BEGIN, value: '\\begin' });
    expect(tokens[1]).toMatchObject({ type: T.OPEN_BRACE });
    expect(tokens[2]).toMatchObject({ type: T.TEXT, value: 'document' });
    expect(tokens[3]).toMatchObject({ type: T.CLOSE_BRACE });
  });

  it('does not match \\begingroup as BEGIN token', () => {
    const tokens = tokenize(String.raw`\begingroup`);
    expect(tokens[0]).toMatchObject({ type: T.COMMAND, value: '\\begingroup' });
  });

  it('tokenizes comments', () => {
    const tokens = tokenize('text % a comment\nmore');
    const comment = tokens.find((t) => t.type === T.COMMENT);
    expect(comment).toBeDefined();
    expect(comment.value).toBe('% a comment');
  });

  it('tokenizes inline math $', () => {
    const tokens = tokenize('$x$');
    expect(tokens[0]).toMatchObject({ type: T.MATH_INLINE, value: '$' });
    expect(tokens[2]).toMatchObject({ type: T.MATH_INLINE, value: '$' });
  });

  it('tokenizes display math $$', () => {
    const tokens = tokenize('$$x$$');
    expect(tokens[0]).toMatchObject({ type: T.MATH_DISPLAY, value: '$$' });
    expect(tokens[2]).toMatchObject({ type: T.MATH_DISPLAY, value: '$$' });
  });

  it('tokenizes \\( \\) and \\[ \\] delimiters', () => {
    const tokens1 = tokenize(String.raw`\(x\)`);
    expect(tokens1[0]).toMatchObject({ type: T.MATH_INLINE, value: '\\(' });
    expect(tokens1[2]).toMatchObject({ type: T.MATH_INLINE, value: '\\)' });

    const tokens2 = tokenize(String.raw`\[x\]`);
    expect(tokens2[0]).toMatchObject({ type: T.MATH_DISPLAY, value: '\\[' });
    expect(tokens2[2]).toMatchObject({ type: T.MATH_DISPLAY, value: '\\]' });
  });

  it('tokenizes escaped special characters as commands', () => {
    const tokens = tokenize(String.raw`\& \# \$ \_ \%`);
    const cmds = tokens.filter((t) => t.type === T.COMMAND);
    expect(cmds.map((t) => t.value)).toEqual(['\\&', '\\#', '\\$', '\\_', '\\%']);
  });

  it('tokenizes \\\\ as NEWLINE', () => {
    const tokens = tokenize('a \\\\ b');
    const nl = tokens.find((t) => t.type === T.NEWLINE);
    expect(nl).toBeDefined();
  });

  it('tokenizes \\\\*[2mm] as NEWLINE', () => {
    const tokens = tokenize('a \\\\*[2mm] b');
    const nl = tokens.find((t) => t.type === T.NEWLINE);
    expect(nl).toBeDefined();
    expect(nl.value).toContain('\\\\');
  });

  it('tokenizes special characters &, #, _, ^, ~', () => {
    expect(tokenize('&')[0]).toMatchObject({ type: T.AMPERSAND });
    expect(tokenize('#')[0]).toMatchObject({ type: T.HASH });
    expect(tokenize('_')[0]).toMatchObject({ type: T.SUBSCRIPT });
    expect(tokenize('^')[0]).toMatchObject({ type: T.SUPERSCRIPT });
    expect(tokenize('~')[0]).toMatchObject({ type: T.TILDE });
  });

  it('tokenizes #1 as PARAM', () => {
    const tokens = tokenize('#1');
    expect(tokens[0]).toMatchObject({ type: T.PARAM, value: '#1' });
  });

  it('tokenizes \\verb|...|', () => {
    const tokens = tokenize(String.raw`\verb|code here|`);
    expect(tokens[0]).toMatchObject({ type: T.VERBATIM });
    expect(tokens[0].value).toBe(String.raw`\verb|code here|`);
  });

  it('tokenizes \\verb*|...|', () => {
    const tokens = tokenize(String.raw`\verb*|x y|`);
    expect(tokens[0]).toMatchObject({ type: T.VERBATIM });
  });

  it('tracks line and column correctly', () => {
    const tokens = tokenize('ab\ncd');
    const cd = tokens.find((t) => t.value === 'cd');
    expect(cd.line).toBe(2);
    expect(cd.col).toBe(1);
  });

  it('handles empty input', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('handles lone backslash at end of input', () => {
    const tokens = tokenize('x\\');
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).toMatchObject({ type: T.TEXT, value: '\\' });
  });
});

// ─── Parser (AST) ───────────────────────────────────────────────────────────

describe('parse', () => {
  it('returns a root node', () => {
    const tree = parse('Hello');
    expect(tree.type).toBe(N.ROOT);
    expect(tree.children.length).toBeGreaterThan(0);
  });

  it('parses environments', () => {
    const tree = parse(String.raw`\begin{itemize}\item A\end{itemize}`);
    const envs = findEnvironments(tree);
    expect(envs).toHaveLength(1);
    expect(envs[0].name).toBe('itemize');
  });

  it('parses nested environments', () => {
    const src = String.raw`\begin{figure}\begin{tabular}{cc}a & b\end{tabular}\end{figure}`;
    const tree = parse(src);
    const figures = findEnvironments(tree, 'figure');
    const tabulars = findEnvironments(tree, 'tabular');
    expect(figures).toHaveLength(1);
    expect(tabulars).toHaveLength(1);
  });

  it('parses commands with arguments', () => {
    const tree = parse(String.raw`\section{Introduction}`);
    const cmds = findCommands(tree, 'section');
    expect(cmds).toHaveLength(1);
    expect(cmds[0].args).toHaveLength(1);
    expect(cmds[0].args[0].text).toBe('Introduction');
  });

  it('parses commands with optional and required arguments', () => {
    const tree = parse(String.raw`\section[short]{Long Title}`);
    const cmds = findCommands(tree, 'section');
    expect(cmds).toHaveLength(1);
    expect(cmds[0].args).toHaveLength(2);
    expect(cmds[0].args[0].type).toBe(N.OPT_ARG);
    expect(cmds[0].args[0].text).toBe('short');
    expect(cmds[0].args[1].type).toBe(N.GROUP);
    expect(cmds[0].args[1].text).toBe('Long Title');
  });

  it('parses inline math', () => {
    const tree = parse('$x^2$');
    const mathNodes = findAll(tree, (n) => n.type === N.MATH_INLINE);
    expect(mathNodes).toHaveLength(1);
  });

  it('parses display math', () => {
    const tree = parse('$$E=mc^2$$');
    const mathNodes = findAll(tree, (n) => n.type === N.MATH_DISPLAY);
    expect(mathNodes).toHaveLength(1);
  });

  it('parses verbatim environments', () => {
    const src = `\\begin{verbatim}raw \\textbf{stuff}\\end{verbatim}`;
    const tree = parse(src);
    const verbs = findAll(tree, (n) => n.type === N.VERBATIM);
    expect(verbs).toHaveLength(1);
    expect(verbs[0].name).toBe('verbatim');
  });

  it('marks unclosed environments', () => {
    const tree = parse(String.raw`\begin{itemize}\item A`);
    const envs = findEnvironments(tree);
    expect(envs).toHaveLength(1);
    expect(envs[0].unclosed).toBe(true);
  });

  it('handles unmatched \\end gracefully', () => {
    const tree = parse(String.raw`\end{itemize}`);
    // Should not throw; produces an error command node
    const errorNodes = findAll(tree, (n) => n.error != null);
    expect(errorNodes.length).toBeGreaterThan(0);
  });

  it('handles empty input', () => {
    const tree = parse('');
    expect(tree.type).toBe(N.ROOT);
    expect(tree.children).toEqual([]);
  });

  it('parses macro definitions', () => {
    const tree = parse(String.raw`\newcommand{\foo}[1]{bar #1}`);
    const cmds = findCommands(tree, 'newcommand');
    expect(cmds).toHaveLength(1);
    expect(cmds[0].isMacroDef).toBe(true);
  });
});

// ─── Walk & Query Utilities ─────────────────────────────────────────────────

describe('walk', () => {
  it('visits all nodes', () => {
    const tree = parse('Hello \\textbf{world}');
    const visited = [];
    walk(tree, (node) => visited.push(node.type));
    expect(visited).toContain(N.ROOT);
    expect(visited).toContain(N.COMMAND);
  });

  it('supports skipping children by returning false', () => {
    const tree = parse(String.raw`\begin{itemize}\item A\end{itemize}`);
    const types = [];
    walk(tree, (node) => {
      types.push(node.type);
      if (node.type === N.ENVIRONMENT) return false;
    });
    // Should have root and env but NOT the children of env
    expect(types).toContain(N.ROOT);
    expect(types).toContain(N.ENVIRONMENT);
    // item command should not be visited
    const cmdNodes = types.filter((t) => t === N.COMMAND);
    expect(cmdNodes).toHaveLength(0);
  });
});

describe('findAll', () => {
  it('collects matching nodes', () => {
    const tree = parse(String.raw`\textbf{a} \textit{b}`);
    const cmds = findAll(tree, (n) => n.type === N.COMMAND);
    expect(cmds.length).toBeGreaterThanOrEqual(2);
  });
});

describe('nodeAtPos', () => {
  it('finds the deepest node at a position', () => {
    const src = String.raw`\begin{document}Hello\end{document}`;
    const tree = parse(src);
    const helloPos = src.indexOf('Hello');
    const node = nodeAtPos(tree, helloPos);
    // Should be a text node inside the document environment
    expect(node.type).toBe(N.TEXT);
  });

  it('returns root for position 0 in empty doc', () => {
    const tree = parse('');
    expect(nodeAtPos(tree, 0).type).toBe(N.ROOT);
  });
});

describe('ancestorsAtPos', () => {
  it('returns path from root to deepest node', () => {
    const src = String.raw`\begin{document}Hello\end{document}`;
    const tree = parse(src);
    const pos = src.indexOf('Hello');
    const path = ancestorsAtPos(tree, pos);
    expect(path[0].type).toBe(N.ROOT);
    expect(path.length).toBeGreaterThanOrEqual(2);
  });
});

describe('findEnvironments', () => {
  it('finds all environments', () => {
    const src = String.raw`\begin{figure}\end{figure}\begin{table}\end{table}`;
    const tree = parse(src);
    expect(findEnvironments(tree)).toHaveLength(2);
  });

  it('filters by name', () => {
    const src = String.raw`\begin{figure}\end{figure}\begin{table}\end{table}`;
    const tree = parse(src);
    expect(findEnvironments(tree, 'figure')).toHaveLength(1);
  });
});

describe('findTables', () => {
  it('finds tabular environments', () => {
    const src = String.raw`\begin{tabular}{cc}a & b\end{tabular}`;
    const tree = parse(src);
    const tables = findTables(tree);
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('tabular');
  });

  it('does not recurse into nested tables', () => {
    // Unlikely but tests the return-false behaviour
    const src = String.raw`\begin{tabular}{c}\begin{tabular}{c}x\end{tabular}\end{tabular}`;
    const tree = parse(src);
    const tables = findTables(tree);
    expect(tables).toHaveLength(1); // only outer
  });
});

describe('findTableAtPos', () => {
  it('returns table info with inner and outer', () => {
    const src = String.raw`\begin{table}\begin{tabular}{cc}a & b\end{tabular}\end{table}`;
    const tree = parse(src);
    const tabPos = src.indexOf('a & b');
    const info = findTableAtPos(tree, tabPos);
    expect(info).not.toBeNull();
    expect(info.inner.name).toBe('tabular');
    expect(info.outer.name).toBe('table');
  });

  it('returns null when not inside a table', () => {
    const src = String.raw`\section{Hello}`;
    const tree = parse(src);
    expect(findTableAtPos(tree, 0)).toBeNull();
  });
});

describe('findCommands', () => {
  it('finds commands by name', () => {
    const src = String.raw`\label{a}\ref{b}\label{c}`;
    const tree = parse(src);
    expect(findCommands(tree, 'label')).toHaveLength(2);
    expect(findCommands(tree, 'ref')).toHaveLength(1);
  });
});

describe('getStructure', () => {
  it('extracts sectioning commands', () => {
    const src = String.raw`\section{Intro}\subsection{Background}\section{Methods}`;
    const tree = parse(src);
    const struct = getStructure(tree);
    expect(struct).toHaveLength(3);
    expect(struct[0]).toMatchObject({ level: 2, name: 'section', title: 'Intro' });
    expect(struct[1]).toMatchObject({ level: 3, name: 'subsection', title: 'Background' });
    expect(struct[2]).toMatchObject({ level: 2, name: 'section', title: 'Methods' });
  });

  it('handles starred section commands', () => {
    const src = String.raw`\section*{Unnumbered}`;
    const tree = parse(src);
    const struct = getStructure(tree);
    expect(struct).toHaveLength(1);
    expect(struct[0].name).toBe('section*');
  });

  it('returns empty for document without sections', () => {
    const tree = parse('Hello world');
    expect(getStructure(tree)).toEqual([]);
  });
});

// ─── Context Queries ────────────────────────────────────────────────────────

describe('contextAtPos', () => {
  it('detects inline math context', () => {
    const src = '$x^2$';
    const tree = parse(src);
    const ctx = contextAtPos(tree, 2); // inside the math
    expect(ctx.inMath).toBe(true);
    expect(ctx.inMathInline).toBe(true);
  });

  it('detects display math context', () => {
    const src = '$$E=mc^2$$';
    const tree = parse(src);
    const ctx = contextAtPos(tree, 4);
    expect(ctx.inMath).toBe(true);
    expect(ctx.inMathDisplay).toBe(true);
  });

  it('detects math environment context', () => {
    const src = String.raw`\begin{equation}x=1\end{equation}`;
    const tree = parse(src);
    const pos = src.indexOf('x=1');
    const ctx = contextAtPos(tree, pos);
    expect(ctx.inMath).toBe(true);
    expect(ctx.environments).toContain('equation');
  });

  it('detects align context', () => {
    const src = String.raw`\begin{align}a &= b\end{align}`;
    const tree = parse(src);
    const pos = src.indexOf('a &');
    const ctx = contextAtPos(tree, pos);
    expect(ctx.inAlign).toBe(true);
    expect(ctx.inMath).toBe(true);
  });

  it('detects table context', () => {
    const src = String.raw`\begin{tabular}{cc}a & b\end{tabular}`;
    const tree = parse(src);
    const pos = src.indexOf('a & b');
    const ctx = contextAtPos(tree, pos);
    expect(ctx.inTable).toBe(true);
  });

  it('detects verbatim context', () => {
    const src = `\\begin{verbatim}code\\end{verbatim}`;
    const tree = parse(src);
    const pos = src.indexOf('code');
    const ctx = contextAtPos(tree, pos);
    expect(ctx.inVerbatim).toBe(true);
  });

  it('not in math outside math delimiters', () => {
    const src = 'text $x$ more';
    const tree = parse(src);
    const ctx = contextAtPos(tree, 0);
    expect(ctx.inMath).toBe(false);
  });
});

describe('inMath', () => {
  it('returns true inside math', () => {
    const src = '$x$';
    const tree = parse(src);
    expect(inMath(tree, 1)).toBe(true);
  });

  it('returns false outside math', () => {
    const tree = parse('text');
    expect(inMath(tree, 0)).toBe(false);
  });
});

describe('inVerbatim', () => {
  it('returns true inside verbatim', () => {
    const src = `\\begin{verbatim}x\\end{verbatim}`;
    const tree = parse(src);
    expect(inVerbatim(tree, src.indexOf('x'))).toBe(true);
  });

  it('returns false outside verbatim', () => {
    const tree = parse('plain text');
    expect(inVerbatim(tree, 0)).toBe(false);
  });
});

// ─── Table Parsing ──────────────────────────────────────────────────────────

describe('parseTable', () => {
  it('parses a simple tabular', () => {
    const src = String.raw`\begin{tabular}{|l|c|r|}
\hline
a & b & c \\
d & e & f \\
\hline
\end{tabular}`;
    const tree = parse(src);
    const tables = findTables(tree);
    expect(tables).toHaveLength(1);
    const result = parseTable({ inner: tables[0] }, src);
    expect(result.env).toBe('tabular');
    expect(result.alignments).toEqual(['l', 'c', 'r']);
    expect(result.cols).toBe(3);
    expect(result.rows).toBe(2);
    expect(result.cells[0]).toEqual(['a', 'b', 'c']);
    expect(result.cells[1]).toEqual(['d', 'e', 'f']);
    expect(result.borders).toBe('all');
  });

  it('parses booktabs-style tables', () => {
    const src = String.raw`\begin{tabular}{lc}
\toprule
Header & Value \\
\midrule
a & 1 \\
b & 2 \\
\bottomrule
\end{tabular}`;
    const tree = parse(src);
    const tables = findTables(tree);
    const result = parseTable({ inner: tables[0] }, src);
    expect(result.booktabs).toBe(true);
    expect(result.rows).toBe(3);
    expect(result.headerRow).toBe(true);
  });

  it('parses column spec with *{n}{spec}', () => {
    const src = String.raw`\begin{tabular}{*{3}{c}}
a & b & c \\
\end{tabular}`;
    const tree = parse(src);
    const tables = findTables(tree);
    const result = parseTable({ inner: tables[0] }, src);
    expect(result.alignments).toEqual(['c', 'c', 'c']);
    expect(result.cols).toBe(3);
  });

  it('handles empty table', () => {
    const src = String.raw`\begin{tabular}{cc}\end{tabular}`;
    const tree = parse(src);
    const tables = findTables(tree);
    const result = parseTable({ inner: tables[0] }, src);
    expect(result.rows).toBe(0);
    expect(result.cells).toEqual([]);
  });

  it('detects bold header', () => {
    const src = String.raw`\begin{tabular}{cc}
\textbf{Name} & \textbf{Value} \\
a & 1 \\
\end{tabular}`;
    const tree = parse(src);
    const tables = findTables(tree);
    const result = parseTable({ inner: tables[0] }, src);
    expect(result.boldHeader).toBe(true);
  });

  it('extracts caption and label from float wrapper', () => {
    const src = String.raw`\begin{table}
\centering
\caption{My table}
\label{tab:mine}
\begin{tabular}{cc}
a & b \\
\end{tabular}
\end{table}`;
    const tree = parse(src);
    const tableInfo = findTableAtPos(tree, src.indexOf('a & b'));
    const result = parseTable(tableInfo, src);
    expect(result.caption).toBe(true);
    expect(result.captionText).toBe('My table');
    expect(result.label).toBe('tab:mine');
    expect(result.centering).toBe(true);
  });

  it('handles paragraph columns p{width}', () => {
    const src = String.raw`\begin{tabular}{p{3cm}l}
long text & short \\
\end{tabular}`;
    const tree = parse(src);
    const tables = findTables(tree);
    const result = parseTable({ inner: tables[0] }, src);
    expect(result.alignments).toEqual(['p', 'l']);
    expect(result.cols).toBe(2);
  });

  it('handles X columns in tabularx', () => {
    const src = String.raw`\begin{tabularx}{\textwidth}{|X|X|}
a & b \\
\end{tabularx}`;
    const tree = parse(src);
    const tables = findTables(tree);
    const result = parseTable({ inner: tables[0] }, src);
    expect(result.alignments).toEqual(['c', 'c']); // X maps to 'c'
  });

  it('parses multicolumn cells', () => {
    const src = String.raw`\begin{tabular}{|l|c|r|}
\multicolumn{2}{|c|}{Merged} & c \\
a & b & c \\
\end{tabular}`;
    const tree = parse(src);
    const tables = findTables(tree);
    const result = parseTable({ inner: tables[0] }, src);
    expect(result.merges.length).toBeGreaterThan(0);
    expect(result.merges[0]).toMatchObject({ row: 0, col: 0, colSpan: 2 });
  });
});

// ─── parseCustomColumnTypes ─────────────────────────────────────────────────

describe('parseCustomColumnTypes', () => {
  it('parses \\newcolumntype with centering', () => {
    const src = String.raw`\newcolumntype{P}[1]{>{\centering\arraybackslash}p{#1}}
\begin{document}
\end{document}`;
    const types = parseCustomColumnTypes(src);
    expect(types.has('P')).toBe(true);
    expect(types.get('P').alignment).toBe('c');
    expect(types.get('P').hasWidth).toBe(true);
  });

  it('parses raggedleft as right-aligned', () => {
    const src = String.raw`\newcolumntype{R}[1]{>{\raggedleft\arraybackslash}p{#1}}
\begin{document}\end{document}`;
    const types = parseCustomColumnTypes(src);
    expect(types.get('R').alignment).toBe('r');
  });

  it('returns empty map for document without custom columns', () => {
    const types = parseCustomColumnTypes(String.raw`\begin{document}Hello\end{document}`);
    expect(types.size).toBe(0);
  });

  it('only scans preamble', () => {
    const src = String.raw`\begin{document}
\newcolumntype{Z}{c}
\end{document}`;
    const types = parseCustomColumnTypes(src);
    expect(types.size).toBe(0);
  });
});

// ─── Lint (AST-based) ───────────────────────────────────────────────────────

describe('lint', () => {
  it('reports unclosed environments', () => {
    const src = String.raw`\begin{itemize}\item A`;
    const tree = parse(src);
    const diags = lint(tree, src);
    expect(diags.some((d) => d.message.includes('Unclosed environment'))).toBe(true);
  });

  it('reports unmatched \\end', () => {
    const src = String.raw`\end{itemize}`;
    const tree = parse(src);
    const diags = lint(tree, src);
    expect(diags.some((d) => d.message.includes('without matching'))).toBe(true);
  });

  it('reports & outside alignment context', () => {
    const src = 'a & b';
    const tree = parse(src);
    const diags = lint(tree, src);
    expect(diags.some((d) => d.message.includes('&'))).toBe(true);
  });

  it('allows & in tabular', () => {
    const src = String.raw`\begin{tabular}{cc}a & b\end{tabular}`;
    const tree = parse(src);
    const diags = lint(tree, src);
    expect(diags.filter((d) => d.message.includes('&'))).toHaveLength(0);
  });

  it('reports _ outside math mode', () => {
    const src = 'a_b';
    const tree = parse(src);
    const diags = lint(tree, src);
    expect(diags.some((d) => d.message.includes('_'))).toBe(true);
  });

  it('allows _ in math mode', () => {
    const src = '$a_b$';
    const tree = parse(src);
    const diags = lint(tree, src);
    expect(diags.filter((d) => d.message.includes('_'))).toHaveLength(0);
  });

  it('reports ^ outside math mode', () => {
    const src = 'a^b';
    const tree = parse(src);
    const diags = lint(tree, src);
    expect(diags.some((d) => d.message.includes('^'))).toBe(true);
  });

  it('reports unclosed math', () => {
    const src = '$x';
    const tree = parse(src);
    const diags = lint(tree, src);
    expect(diags.some((d) => d.message.includes('math'))).toBe(true);
  });

  it('returns no diagnostics for valid LaTeX', () => {
    const src = String.raw`\documentclass{article}
\begin{document}
Hello world.
\end{document}`;
    const tree = parse(src);
    expect(lint(tree, src)).toEqual([]);
  });

  it('does not lint inside verbatim environments', () => {
    const src = `\\begin{verbatim}a & b _ c\\end{verbatim}`;
    const tree = parse(src);
    const diags = lint(tree, src);
    expect(diags.filter((d) => d.message.includes('&') || d.message.includes('_'))).toHaveLength(0);
  });

  it('does not report # in macro definitions', () => {
    const src = String.raw`\newcommand{\foo}[1]{#1}`;
    const tree = parse(src);
    const diags = lint(tree, src);
    expect(diags.filter((d) => d.message.includes('#'))).toHaveLength(0);
  });
});
