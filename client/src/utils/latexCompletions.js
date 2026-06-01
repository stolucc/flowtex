import { autocompletion } from '@codemirror/autocomplete';
import { snippet } from '@codemirror/autocomplete';

// Helper: create a snippet apply function that places cursor inside the first {}
function snip(template) {
  return snippet(template);
}

const commands = [
  // Document structure
  { label: '\\documentclass', type: 'keyword', detail: 'Document class', apply: snip('\\documentclass{${1:article}}') },
  { label: '\\usepackage', type: 'keyword', detail: 'Import package', apply: snip('\\usepackage{${1}}') },
  { label: '\\begin', type: 'keyword', detail: 'Begin environment', apply: snip('\\begin{${1}}') },
  { label: '\\end', type: 'keyword', detail: 'End environment', apply: snip('\\end{${1}}') },
  { label: '\\input', type: 'keyword', detail: 'Input file', apply: snip('\\input{${1}}') },
  { label: '\\include', type: 'keyword', detail: 'Include file', apply: snip('\\include{${1}}') },

  // Sections
  { label: '\\section', type: 'keyword', detail: 'Section', apply: snip('\\section{${1}}') },
  { label: '\\subsection', type: 'keyword', detail: 'Subsection', apply: snip('\\subsection{${1}}') },
  { label: '\\subsubsection', type: 'keyword', detail: 'Subsubsection', apply: snip('\\subsubsection{${1}}') },
  { label: '\\paragraph', type: 'keyword', detail: 'Paragraph', apply: snip('\\paragraph{${1}}') },
  { label: '\\chapter', type: 'keyword', detail: 'Chapter', apply: snip('\\chapter{${1}}') },
  { label: '\\part', type: 'keyword', detail: 'Part', apply: snip('\\part{${1}}') },

  // Text formatting
  { label: '\\textbf', type: 'function', detail: 'Bold', apply: snip('\\textbf{${1}}') },
  { label: '\\textit', type: 'function', detail: 'Italic', apply: snip('\\textit{${1}}') },
  { label: '\\texttt', type: 'function', detail: 'Monospace', apply: snip('\\texttt{${1}}') },
  { label: '\\textsc', type: 'function', detail: 'Small caps', apply: snip('\\textsc{${1}}') },
  { label: '\\textrm', type: 'function', detail: 'Roman', apply: snip('\\textrm{${1}}') },
  { label: '\\textsf', type: 'function', detail: 'Sans-serif', apply: snip('\\textsf{${1}}') },
  { label: '\\underline', type: 'function', detail: 'Underline', apply: snip('\\underline{${1}}') },
  { label: '\\emph', type: 'function', detail: 'Emphasis', apply: snip('\\emph{${1}}') },
  { label: '\\tiny', type: 'function', detail: 'Tiny size' },
  { label: '\\scriptsize', type: 'function', detail: 'Script size' },
  { label: '\\footnotesize', type: 'function', detail: 'Footnote size' },
  { label: '\\small', type: 'function', detail: 'Small size' },
  { label: '\\normalsize', type: 'function', detail: 'Normal size' },
  { label: '\\large', type: 'function', detail: 'Large size' },
  { label: '\\Large', type: 'function', detail: 'Larger size' },
  { label: '\\LARGE', type: 'function', detail: 'Even larger' },
  { label: '\\huge', type: 'function', detail: 'Huge size' },
  { label: '\\Huge', type: 'function', detail: 'Hugest size' },

  // References and citations
  { label: '\\label', type: 'function', detail: 'Label', apply: snip('\\label{${1}}') },
  { label: '\\ref', type: 'function', detail: 'Reference', apply: snip('\\ref{${1}}') },
  { label: '\\eqref', type: 'function', detail: 'Equation ref', apply: snip('\\eqref{${1}}') },
  { label: '\\pageref', type: 'function', detail: 'Page reference', apply: snip('\\pageref{${1}}') },
  { label: '\\cite', type: 'function', detail: 'Citation', apply: snip('\\cite{${1}}') },
  { label: '\\citep', type: 'function', detail: 'Parenthetical cite', apply: snip('\\citep{${1}}') },
  { label: '\\citet', type: 'function', detail: 'Textual cite', apply: snip('\\citet{${1}}') },
  { label: '\\footnote', type: 'function', detail: 'Footnote', apply: snip('\\footnote{${1}}') },
  { label: '\\bibliography', type: 'keyword', detail: 'Bibliography', apply: snip('\\bibliography{${1}}') },
  { label: '\\bibliographystyle', type: 'keyword', detail: 'Bib style', apply: snip('\\bibliographystyle{${1}}') },

  // Math
  { label: '\\frac', type: 'function', detail: 'Fraction', apply: snip('\\frac{${1}}{${2}}') },
  { label: '\\sqrt', type: 'function', detail: 'Square root', apply: snip('\\sqrt{${1}}') },
  { label: '\\sum', type: 'function', detail: 'Summation' },
  { label: '\\prod', type: 'function', detail: 'Product' },
  { label: '\\int', type: 'function', detail: 'Integral' },
  { label: '\\lim', type: 'function', detail: 'Limit' },
  { label: '\\infty', type: 'function', detail: 'Infinity' },
  { label: '\\partial', type: 'function', detail: 'Partial' },
  { label: '\\nabla', type: 'function', detail: 'Nabla' },
  { label: '\\forall', type: 'function', detail: 'For all' },
  { label: '\\exists', type: 'function', detail: 'Exists' },
  { label: '\\alpha', type: 'variable', detail: 'Greek' },
  { label: '\\beta', type: 'variable', detail: 'Greek' },
  { label: '\\gamma', type: 'variable', detail: 'Greek' },
  { label: '\\delta', type: 'variable', detail: 'Greek' },
  { label: '\\epsilon', type: 'variable', detail: 'Greek' },
  { label: '\\varepsilon', type: 'variable', detail: 'Greek' },
  { label: '\\zeta', type: 'variable', detail: 'Greek' },
  { label: '\\eta', type: 'variable', detail: 'Greek' },
  { label: '\\theta', type: 'variable', detail: 'Greek' },
  { label: '\\iota', type: 'variable', detail: 'Greek' },
  { label: '\\kappa', type: 'variable', detail: 'Greek' },
  { label: '\\lambda', type: 'variable', detail: 'Greek' },
  { label: '\\mu', type: 'variable', detail: 'Greek' },
  { label: '\\nu', type: 'variable', detail: 'Greek' },
  { label: '\\xi', type: 'variable', detail: 'Greek' },
  { label: '\\pi', type: 'variable', detail: 'Greek' },
  { label: '\\rho', type: 'variable', detail: 'Greek' },
  { label: '\\sigma', type: 'variable', detail: 'Greek' },
  { label: '\\tau', type: 'variable', detail: 'Greek' },
  { label: '\\upsilon', type: 'variable', detail: 'Greek' },
  { label: '\\phi', type: 'variable', detail: 'Greek' },
  { label: '\\varphi', type: 'variable', detail: 'Greek' },
  { label: '\\chi', type: 'variable', detail: 'Greek' },
  { label: '\\psi', type: 'variable', detail: 'Greek' },
  { label: '\\omega', type: 'variable', detail: 'Greek' },
  { label: '\\Gamma', type: 'variable', detail: 'Greek uppercase' },
  { label: '\\Delta', type: 'variable', detail: 'Greek uppercase' },
  { label: '\\Theta', type: 'variable', detail: 'Greek uppercase' },
  { label: '\\Lambda', type: 'variable', detail: 'Greek uppercase' },
  { label: '\\Xi', type: 'variable', detail: 'Greek uppercase' },
  { label: '\\Pi', type: 'variable', detail: 'Greek uppercase' },
  { label: '\\Sigma', type: 'variable', detail: 'Greek uppercase' },
  { label: '\\Phi', type: 'variable', detail: 'Greek uppercase' },
  { label: '\\Psi', type: 'variable', detail: 'Greek uppercase' },
  { label: '\\Omega', type: 'variable', detail: 'Greek uppercase' },
  { label: '\\mathbb', type: 'function', detail: 'Blackboard bold', apply: snip('\\mathbb{${1}}') },
  { label: '\\mathcal', type: 'function', detail: 'Calligraphic', apply: snip('\\mathcal{${1}}') },
  { label: '\\mathbf', type: 'function', detail: 'Bold math', apply: snip('\\mathbf{${1}}') },
  { label: '\\mathrm', type: 'function', detail: 'Roman math', apply: snip('\\mathrm{${1}}') },
  { label: '\\left', type: 'keyword', detail: 'Left delimiter' },
  { label: '\\right', type: 'keyword', detail: 'Right delimiter' },
  { label: '\\leq', type: 'function', detail: 'Less or equal' },
  { label: '\\geq', type: 'function', detail: 'Greater or equal' },
  { label: '\\neq', type: 'function', detail: 'Not equal' },
  { label: '\\approx', type: 'function', detail: 'Approximately' },
  { label: '\\equiv', type: 'function', detail: 'Equivalent' },
  { label: '\\times', type: 'function', detail: 'Times' },
  { label: '\\cdot', type: 'function', detail: 'Center dot' },
  { label: '\\cdots', type: 'function', detail: 'Center dots' },
  { label: '\\ldots', type: 'function', detail: 'Low dots' },
  { label: '\\vdots', type: 'function', detail: 'Vertical dots' },
  { label: '\\ddots', type: 'function', detail: 'Diagonal dots' },
  { label: '\\rightarrow', type: 'function', detail: 'Right arrow' },
  { label: '\\leftarrow', type: 'function', detail: 'Left arrow' },
  { label: '\\Rightarrow', type: 'function', detail: 'Double right arrow' },
  { label: '\\Leftarrow', type: 'function', detail: 'Double left arrow' },
  { label: '\\Leftrightarrow', type: 'function', detail: 'Double both arrow' },
  { label: '\\mapsto', type: 'function', detail: 'Maps to' },
  { label: '\\subset', type: 'function', detail: 'Subset' },
  { label: '\\supset', type: 'function', detail: 'Superset' },
  { label: '\\subseteq', type: 'function', detail: 'Subset or equal' },
  { label: '\\supseteq', type: 'function', detail: 'Superset or equal' },
  { label: '\\in', type: 'function', detail: 'Element of' },
  { label: '\\notin', type: 'function', detail: 'Not in' },
  { label: '\\cup', type: 'function', detail: 'Union' },
  { label: '\\cap', type: 'function', detail: 'Intersection' },
  { label: '\\setminus', type: 'function', detail: 'Set minus' },
  { label: '\\emptyset', type: 'function', detail: 'Empty set' },
  { label: '\\overline', type: 'function', detail: 'Overline', apply: snip('\\overline{${1}}') },
  { label: '\\hat', type: 'function', detail: 'Hat accent', apply: snip('\\hat{${1}}') },
  { label: '\\tilde', type: 'function', detail: 'Tilde accent', apply: snip('\\tilde{${1}}') },
  { label: '\\bar', type: 'function', detail: 'Bar accent', apply: snip('\\bar{${1}}') },
  { label: '\\vec', type: 'function', detail: 'Vector arrow', apply: snip('\\vec{${1}}') },
  { label: '\\dot', type: 'function', detail: 'Dot accent', apply: snip('\\dot{${1}}') },
  { label: '\\ddot', type: 'function', detail: 'Double dot', apply: snip('\\ddot{${1}}') },

  // Figures and tables
  {
    label: '\\includegraphics',
    type: 'function',
    detail: 'Include image',
    apply: snip('\\includegraphics[width=\\textwidth]{${1}}'),
  },
  { label: '\\caption', type: 'function', detail: 'Caption', apply: snip('\\caption{${1}}') },
  { label: '\\centering', type: 'keyword', detail: 'Center content' },
  { label: '\\hline', type: 'keyword', detail: 'Horizontal line' },
  { label: '\\toprule', type: 'keyword', detail: 'Top rule (booktabs)' },
  { label: '\\midrule', type: 'keyword', detail: 'Mid rule (booktabs)' },
  { label: '\\bottomrule', type: 'keyword', detail: 'Bottom rule (booktabs)' },
  { label: '\\multicolumn', type: 'function', detail: 'Multi-column', apply: snip('\\multicolumn{${1}}{${2}}{${3}}') },
  { label: '\\multirow', type: 'function', detail: 'Multi-row', apply: snip('\\multirow{${1}}{${2}}{${3}}') },

  // Lists
  { label: '\\item', type: 'keyword', detail: 'List item' },

  // Spacing and layout
  { label: '\\newpage', type: 'keyword', detail: 'New page' },
  { label: '\\clearpage', type: 'keyword', detail: 'Clear page' },
  { label: '\\linebreak', type: 'keyword', detail: 'Line break' },
  { label: '\\pagebreak', type: 'keyword', detail: 'Page break' },
  { label: '\\noindent', type: 'keyword', detail: 'No indent' },
  { label: '\\vspace', type: 'function', detail: 'Vertical space', apply: snip('\\vspace{${1}}') },
  { label: '\\hspace', type: 'function', detail: 'Horizontal space', apply: snip('\\hspace{${1}}') },
  { label: '\\quad', type: 'keyword', detail: 'Quad space' },
  { label: '\\qquad', type: 'keyword', detail: 'Double quad space' },

  // Title page
  { label: '\\title', type: 'keyword', detail: 'Title', apply: snip('\\title{${1}}') },
  { label: '\\author', type: 'keyword', detail: 'Author', apply: snip('\\author{${1}}') },
  { label: '\\date', type: 'keyword', detail: 'Date', apply: snip('\\date{${1}}') },
  { label: '\\maketitle', type: 'keyword', detail: 'Render title' },
  { label: '\\abstract', type: 'keyword', detail: 'Abstract' },
  { label: '\\tableofcontents', type: 'keyword', detail: 'Table of contents' },
  { label: '\\listoffigures', type: 'keyword', detail: 'List of figures' },
  { label: '\\listoftables', type: 'keyword', detail: 'List of tables' },

  // Misc
  { label: '\\newcommand', type: 'keyword', detail: 'Define command', apply: snip('\\newcommand{${1}}{${2}}') },
  { label: '\\renewcommand', type: 'keyword', detail: 'Redefine command', apply: snip('\\renewcommand{${1}}{${2}}') },
  { label: '\\newenvironment', type: 'keyword', detail: 'Define environment', apply: snip('\\newenvironment{${1}}{${2}}{${3}}') },
  { label: '\\def', type: 'keyword', detail: 'TeX definition' },
  { label: '\\url', type: 'function', detail: 'URL', apply: snip('\\url{${1}}') },
  { label: '\\href', type: 'function', detail: 'Hyperlink', apply: snip('\\href{${1}}{${2}}') },
  { label: '\\color', type: 'function', detail: 'Text color', apply: snip('\\color{${1}}') },
  { label: '\\textcolor', type: 'function', detail: 'Colored text', apply: snip('\\textcolor{${1}}{${2}}') },
];

const environments = [
  'document',
  'figure',
  'table',
  'tabular',
  'itemize',
  'enumerate',
  'description',
  'equation',
  'equation*',
  'align',
  'align*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'split',
  'cases',
  'array',
  'matrix',
  'pmatrix',
  'bmatrix',
  'vmatrix',
  'minipage',
  'center',
  'flushleft',
  'flushright',
  'abstract',
  'quote',
  'quotation',
  'verse',
  'verbatim',
  'lstlisting',
  'proof',
  'theorem',
  'lemma',
  'definition',
  'corollary',
  'proposition',
  'remark',
  'example',
  'thebibliography',
  'appendix',
];

/**
 * CodeMirror completion source for LaTeX backslash commands.
 * @param {CompletionContext} context
 * @returns {CompletionResult|null}
 */
function latexCompletionSource(context) {
  // Match \word at cursor — include the backslash in the replacement range
  const word = context.matchBefore(/\\[\w]*/);
  if (!word) return null;
  if (word.from === word.to && !context.explicit) return null;

  return {
    from: word.from,
    options: commands,
    validFor: /^\\[\w]*$/,
  };
}

// Environment snippet completions for \begin{...}
// For figure: caption and label go below the content
// For table: caption and label go above the tabular
// Snippet templates use CodeMirror snippet syntax:
// ${n:placeholder} for tab stops, \\$ for literal $, \\{ \\} for literal braces
// These replace everything after \begin{ so they start with the env name
/**
 * Wrap snippet apply to consume any auto-closed } after the cursor.
 * @param {string} template - CodeMirror snippet template
 * @returns {Function} Snippet apply function
 */
function snippetApply(template) {
  const snip = snippet(template);
  return (view, completion, from, to) => {
    if (view.state.sliceDoc(to, to + 1) === '}') to++;
    snip(view, completion, from, to);
  };
}

const envSnippets = {
  figure: {
    label: 'figure',
    type: 'type',
    detail: 'figure with caption & label',
    apply: snippetApply(
      'figure}[${1:htbp}]\n\t\\centering\n\t\\includegraphics[width=\\textwidth]{${2:filename}}\n\t\\caption{${3:Caption text}}\n\t\\label{fig:${4:label}}\n\\end{figure}',
    ),
  },
  'figure*': {
    label: 'figure*',
    type: 'type',
    detail: 'wide figure with caption & label',
    apply: snippetApply(
      'figure*}[${1:htbp}]\n\t\\centering\n\t\\includegraphics[width=\\textwidth]{${2:filename}}\n\t\\caption{${3:Caption text}}\n\t\\label{fig:${4:label}}\n\\end{figure*}',
    ),
  },
  table: {
    label: 'table',
    type: 'type',
    detail: 'table with caption & label',
    apply: snippetApply(
      'table}[${1:htbp}]\n\t\\centering\n\t\\caption{${2:Caption text}}\n\t\\label{tab:${3:label}}\n\t\\begin{tabular}{${4:lll}}\n\t\t\\toprule\n\t\t${5:Col1} & ${6:Col2} & ${7:Col3} \\\\\n\t\t\\midrule\n\t\t & & \\\\\n\t\t\\bottomrule\n\t\\end{tabular}\n\\end{table}',
    ),
  },
  'table*': {
    label: 'table*',
    type: 'type',
    detail: 'wide table with caption & label',
    apply: snippetApply(
      'table*}[${1:htbp}]\n\t\\centering\n\t\\caption{${2:Caption text}}\n\t\\label{tab:${3:label}}\n\t\\begin{tabular}{${4:lll}}\n\t\t\\toprule\n\t\t${5:Col1} & ${6:Col2} & ${7:Col3} \\\\\n\t\t\\midrule\n\t\t & & \\\\\n\t\t\\bottomrule\n\t\\end{tabular}\n\\end{table*}',
    ),
  },
};

// Environments that take a `\item` body (list-shaped) get a slightly
// richer default snippet with one `\item` already inserted so the
// caret lands where the user is about to type content.
const LIST_ENVS = new Set(['itemize', 'enumerate', 'description']);

/**
 * Build the default `\begin{name}…\end{name}` snippet for an environment
 * that doesn't have a custom hand-written scaffold in envSnippets. The
 * snippet template replaces everything after `\begin{` (the completion's
 * `from` cursor is positioned right after the opening brace) so we
 * include the closing `}` for the begin tag explicitly.
 *
 * - For list envs: drop in one `\item` and place the caret after it.
 * - For description: `\item[term] description` is more typical.
 * - For anything else: just an empty line with the caret on it.
 */
function defaultEnvSnippet(name) {
  if (name === 'description') {
    return `${name}}\n\t\\item[\${1:term}] \${0}\n\\end{${name}}`;
  }
  if (LIST_ENVS.has(name)) {
    return `${name}}\n\t\\item \${0}\n\\end{${name}}`;
  }
  return `${name}}\n\t\${0}\n\\end{${name}}`;
}

/**
 * CodeMirror completion source for LaTeX environment names inside \begin{} and \end{}.
 * @param {CompletionContext} context
 * @returns {CompletionResult|null}
 */
function envCompletionSource(context) {
  // Match \begin{ or \end{ with partial env name
  const match = context.matchBefore(/\\(begin|end)\{[\w*]*/);
  if (!match) return null;
  const braceIdx = match.text.indexOf('{');
  if (braceIdx < 0) return null;
  const from = match.from + braceIdx + 1;
  const isBegin = match.text.startsWith('\\begin');

  const options = [];
  if (isBegin) {
    // \begin{...}: every environment expands to the full block —
    // \begin{name}\n\t<caret>\n\\end{name} — so the user doesn't have
    // to type the closing tag. figure/table/figure*/table* have richer
    // hand-written scaffolds (centering, caption, label) and take
    // precedence via the higher `boost`.
    for (const env of Object.keys(envSnippets)) {
      options.push({ ...envSnippets[env], boost: 2 });
    }
    for (const e of environments) {
      if (envSnippets[e]) continue; // already added with custom scaffold
      options.push({
        label: e,
        type: 'type',
        detail: 'environment',
        apply: snippetApply(defaultEnvSnippet(e)),
      });
    }
  } else {
    // \end{...}: pick a plain name; no point auto-inserting another
    // \end here.
    for (const e of environments) {
      options.push({ label: e, type: 'type', detail: 'environment' });
    }
  }

  return {
    from,
    options,
    validFor: /^[\w*]*$/,
  };
}

// Citation key completion — triggers inside any cite-like command's braces.
// Matches \cite, \citep, \citet, \citeauthor, \citeyear, \citealt, \citealp,
// \Cite*, \nocite, \parencite, \textcite, \autocite, \fullcite, \footcite,
// \supercite, \notecite, \smartcite, \volcite, and any other \*cite* variant.
// Also handles comma-separated keys like \cite{key1,key2,...}
const citeCommandPattern = /\\(?:\w*[Cc]ite\w*|nocite)\*?(?:\[.*?\])*\{[^}]*$/;

/**
 * Create a completion source for citation keys inside \cite{} commands.
 * @param {React.RefObject} citeKeysRef - Ref holding an array of citation key completions
 * @returns {Function} CodeMirror completion source
 */
function makeCiteKeySource(citeKeysRef) {
  return function citeKeyCompletionSource(context) {
    // Check if we're inside a cite command's braces
    const lineText = context.state.sliceDoc(context.state.doc.lineAt(context.pos).from, context.pos);
    if (!citeCommandPattern.test(lineText)) return null;

    // Find the start of the current key (after { or ,)
    const lastBrace = lineText.lastIndexOf('{');
    const lastComma = lineText.lastIndexOf(',');
    const keyStart = Math.max(lastBrace, lastComma) + 1;
    const from = context.pos - (lineText.length - keyStart);

    const keys = citeKeysRef?.current || [];
    if (keys.length === 0) return null;

    return {
      from,
      options: keys,
      validFor: /^[\w:.@/+-]*$/,
    };
  };
}

// Label/ref completion — triggers inside \ref{}, \eqref{}, \pageref{}, \autoref{},
// \cref{}, \Cref{}, \nameref{}, \hyperref[], and similar commands.
const refCommandPattern = /\\(?:(?:eq|page|auto|name|c|C|v|V)?ref|hyperref)\*?(?:\[.*?\])*\{[^}]*$/;

/**
 * Create a completion source for label keys inside \ref{} commands.
 * @param {React.RefObject} labelKeysRef - Ref holding an array of label key completions
 * @returns {Function} CodeMirror completion source
 */
function makeRefKeySource(labelKeysRef) {
  return function refKeyCompletionSource(context) {
    const lineText = context.state.sliceDoc(context.state.doc.lineAt(context.pos).from, context.pos);
    if (!refCommandPattern.test(lineText)) return null;

    const lastBrace = lineText.lastIndexOf('{');
    const lastComma = lineText.lastIndexOf(',');
    const keyStart = Math.max(lastBrace, lastComma) + 1;
    const from = context.pos - (lineText.length - keyStart);

    const keys = labelKeysRef?.current || [];
    if (keys.length === 0) return null;

    return {
      from,
      options: keys,
      validFor: /^[\w:.@/+-]*$/,
    };
  };
}

/**
 * Create a CodeMirror autocompletion extension for LaTeX commands, environments, cite keys, and label refs.
 * @param {React.RefObject} [citeKeysRef] - Ref holding an array of citation key completions
 * @param {React.RefObject} [labelKeysRef] - Ref holding an array of label key completions
 * @returns {Extension} CodeMirror autocompletion extension
 */
export default function latexAutocomplete(citeKeysRef, labelKeysRef) {
  const sources = [envCompletionSource, latexCompletionSource];
  if (citeKeysRef) {
    sources.unshift(makeCiteKeySource(citeKeysRef));
  }
  if (labelKeysRef) {
    sources.unshift(makeRefKeySource(labelKeysRef));
  }
  return autocompletion({
    override: sources,
    activateOnTyping: true,
    maxRenderedOptions: 20,
    icons: false,
  });
}
