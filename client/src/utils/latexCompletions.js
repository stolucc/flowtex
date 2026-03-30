import { autocompletion, completeFromList } from '@codemirror/autocomplete';

const commands = [
  // Document structure
  { label: '\\documentclass', type: 'keyword', detail: 'Document class', apply: '\\documentclass{article}' },
  { label: '\\usepackage', type: 'keyword', detail: 'Import package', apply: '\\usepackage{$}' },
  { label: '\\begin', type: 'keyword', detail: 'Begin environment', apply: '\\begin{$}' },
  { label: '\\end', type: 'keyword', detail: 'End environment', apply: '\\end{$}' },
  { label: '\\input', type: 'keyword', detail: 'Input file', apply: '\\input{$}' },
  { label: '\\include', type: 'keyword', detail: 'Include file', apply: '\\include{$}' },

  // Sections
  { label: '\\section', type: 'keyword', detail: 'Section', apply: '\\section{$}' },
  { label: '\\subsection', type: 'keyword', detail: 'Subsection', apply: '\\subsection{$}' },
  { label: '\\subsubsection', type: 'keyword', detail: 'Subsubsection', apply: '\\subsubsection{$}' },
  { label: '\\paragraph', type: 'keyword', detail: 'Paragraph', apply: '\\paragraph{$}' },
  { label: '\\chapter', type: 'keyword', detail: 'Chapter', apply: '\\chapter{$}' },
  { label: '\\part', type: 'keyword', detail: 'Part', apply: '\\part{$}' },

  // Text formatting
  { label: '\\textbf', type: 'function', detail: 'Bold', apply: '\\textbf{$}' },
  { label: '\\textit', type: 'function', detail: 'Italic', apply: '\\textit{$}' },
  { label: '\\texttt', type: 'function', detail: 'Monospace', apply: '\\texttt{$}' },
  { label: '\\textsc', type: 'function', detail: 'Small caps', apply: '\\textsc{$}' },
  { label: '\\textrm', type: 'function', detail: 'Roman', apply: '\\textrm{$}' },
  { label: '\\textsf', type: 'function', detail: 'Sans-serif', apply: '\\textsf{$}' },
  { label: '\\underline', type: 'function', detail: 'Underline', apply: '\\underline{$}' },
  { label: '\\emph', type: 'function', detail: 'Emphasis', apply: '\\emph{$}' },
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
  { label: '\\label', type: 'function', detail: 'Label', apply: '\\label{$}' },
  { label: '\\ref', type: 'function', detail: 'Reference', apply: '\\ref{$}' },
  { label: '\\eqref', type: 'function', detail: 'Equation ref', apply: '\\eqref{$}' },
  { label: '\\pageref', type: 'function', detail: 'Page reference', apply: '\\pageref{$}' },
  { label: '\\cite', type: 'function', detail: 'Citation', apply: '\\cite{$}' },
  { label: '\\citep', type: 'function', detail: 'Parenthetical cite', apply: '\\citep{$}' },
  { label: '\\citet', type: 'function', detail: 'Textual cite', apply: '\\citet{$}' },
  { label: '\\footnote', type: 'function', detail: 'Footnote', apply: '\\footnote{$}' },
  { label: '\\bibliography', type: 'keyword', detail: 'Bibliography', apply: '\\bibliography{$}' },
  { label: '\\bibliographystyle', type: 'keyword', detail: 'Bib style', apply: '\\bibliographystyle{$}' },

  // Math
  { label: '\\frac', type: 'function', detail: 'Fraction', apply: '\\frac{$}{}' },
  { label: '\\sqrt', type: 'function', detail: 'Square root', apply: '\\sqrt{$}' },
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
  { label: '\\mathbb', type: 'function', detail: 'Blackboard bold', apply: '\\mathbb{$}' },
  { label: '\\mathcal', type: 'function', detail: 'Calligraphic', apply: '\\mathcal{$}' },
  { label: '\\mathbf', type: 'function', detail: 'Bold math', apply: '\\mathbf{$}' },
  { label: '\\mathrm', type: 'function', detail: 'Roman math', apply: '\\mathrm{$}' },
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
  { label: '\\overline', type: 'function', detail: 'Overline', apply: '\\overline{$}' },
  { label: '\\hat', type: 'function', detail: 'Hat accent', apply: '\\hat{$}' },
  { label: '\\tilde', type: 'function', detail: 'Tilde accent', apply: '\\tilde{$}' },
  { label: '\\bar', type: 'function', detail: 'Bar accent', apply: '\\bar{$}' },
  { label: '\\vec', type: 'function', detail: 'Vector arrow', apply: '\\vec{$}' },
  { label: '\\dot', type: 'function', detail: 'Dot accent', apply: '\\dot{$}' },
  { label: '\\ddot', type: 'function', detail: 'Double dot', apply: '\\ddot{$}' },

  // Figures and tables
  {
    label: '\\includegraphics',
    type: 'function',
    detail: 'Include image',
    apply: '\\includegraphics[width=\\textwidth]{$}',
  },
  { label: '\\caption', type: 'function', detail: 'Caption', apply: '\\caption{$}' },
  { label: '\\centering', type: 'keyword', detail: 'Center content' },
  { label: '\\hline', type: 'keyword', detail: 'Horizontal line' },
  { label: '\\toprule', type: 'keyword', detail: 'Top rule (booktabs)' },
  { label: '\\midrule', type: 'keyword', detail: 'Mid rule (booktabs)' },
  { label: '\\bottomrule', type: 'keyword', detail: 'Bottom rule (booktabs)' },
  { label: '\\multicolumn', type: 'function', detail: 'Multi-column', apply: '\\multicolumn{$}{}{}' },
  { label: '\\multirow', type: 'function', detail: 'Multi-row', apply: '\\multirow{$}{}{}' },

  // Lists
  { label: '\\item', type: 'keyword', detail: 'List item' },

  // Spacing and layout
  { label: '\\newpage', type: 'keyword', detail: 'New page' },
  { label: '\\clearpage', type: 'keyword', detail: 'Clear page' },
  { label: '\\linebreak', type: 'keyword', detail: 'Line break' },
  { label: '\\pagebreak', type: 'keyword', detail: 'Page break' },
  { label: '\\noindent', type: 'keyword', detail: 'No indent' },
  { label: '\\vspace', type: 'function', detail: 'Vertical space', apply: '\\vspace{$}' },
  { label: '\\hspace', type: 'function', detail: 'Horizontal space', apply: '\\hspace{$}' },
  { label: '\\quad', type: 'keyword', detail: 'Quad space' },
  { label: '\\qquad', type: 'keyword', detail: 'Double quad space' },

  // Title page
  { label: '\\title', type: 'keyword', detail: 'Title', apply: '\\title{$}' },
  { label: '\\author', type: 'keyword', detail: 'Author', apply: '\\author{$}' },
  { label: '\\date', type: 'keyword', detail: 'Date', apply: '\\date{$}' },
  { label: '\\maketitle', type: 'keyword', detail: 'Render title' },
  { label: '\\abstract', type: 'keyword', detail: 'Abstract' },
  { label: '\\tableofcontents', type: 'keyword', detail: 'Table of contents' },
  { label: '\\listoffigures', type: 'keyword', detail: 'List of figures' },
  { label: '\\listoftables', type: 'keyword', detail: 'List of tables' },

  // Misc
  { label: '\\newcommand', type: 'keyword', detail: 'Define command', apply: '\\newcommand{$}{}' },
  { label: '\\renewcommand', type: 'keyword', detail: 'Redefine command', apply: '\\renewcommand{$}{}' },
  { label: '\\newenvironment', type: 'keyword', detail: 'Define environment', apply: '\\newenvironment{$}{}{}' },
  { label: '\\def', type: 'keyword', detail: 'TeX definition' },
  { label: '\\url', type: 'function', detail: 'URL', apply: '\\url{$}' },
  { label: '\\href', type: 'function', detail: 'Hyperlink', apply: '\\href{$}{}' },
  { label: '\\color', type: 'function', detail: 'Text color', apply: '\\color{$}' },
  { label: '\\textcolor', type: 'function', detail: 'Colored text', apply: '\\textcolor{$}{}' },
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

function latexCompletionSource(context) {
  // Match \word at cursor
  const word = context.matchBefore(/\\[\w]*/);
  if (!word) return null;
  if (word.from === word.to && !context.explicit) return null;

  return {
    from: word.from,
    options: commands,
    validFor: /^\\[\w]*$/,
  };
}

function envCompletionSource(context) {
  // Match \begin{ or \end{ with partial env name
  const match = context.matchBefore(/\\(begin|end)\{[\w*]*/);
  if (!match) return null;
  const braceIdx = match.text.indexOf('{');
  if (braceIdx < 0) return null;
  const from = match.from + braceIdx + 1;

  return {
    from,
    options: environments.map((e) => ({ label: e, type: 'type', detail: 'environment' })),
    validFor: /^[\w*]*$/,
  };
}

// Citation key completion — triggers inside any cite-like command's braces.
// Matches \cite, \citep, \citet, \citeauthor, \citeyear, \citealt, \citealp,
// \Cite*, \nocite, \parencite, \textcite, \autocite, \fullcite, \footcite,
// \supercite, \notecite, \smartcite, \volcite, and any other \*cite* variant.
// Also handles comma-separated keys like \cite{key1,key2,...}
const citeCommandPattern = /\\(?:\w*[Cc]ite\w*|nocite)\*?(?:\[.*?\])*\{[^}]*$/;

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
