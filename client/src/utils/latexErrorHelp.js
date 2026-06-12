// @ts-check
// Maps common LaTeX error patterns to actionable fix suggestions.
// Each rule: { pattern, title, suggestion, searchQuery, optional fix }.
//
// The optional `fix` function returns a fix descriptor that the UI can
// surface as a one-click "Apply fix" button. Only return a fix when
// we're confident enough to mutate the user's source (e.g. there's a
// single canonical package for an undefined command -- ambiguous cases
// like `\url` / `\href` get a textual suggestion only).

/**
 * Lookup: command name (without the leading backslash) -> the canonical
 * package that provides it. `null` means the command is built-in (and
 * the error is probably a typo). A string containing spaces means
 * there are multiple plausible packages -- we surface the suggestion
 * but won't offer a one-click fix.
 *
 * Kept at module scope so both the suggestion text and the fix
 * descriptor read from the same source of truth.
 *
 * @type {Record<string, string | null>}
 */
const COMMAND_PACKAGES = {
  // Built-ins: an undefined-command error here is almost certainly a typo.
  textbf: null,
  textit: null,
  texttt: null,
  textrm: null,
  textsf: null,
  emph: null,
  multicolumn: null,
  hline: null,
  cline: null,

  // Color
  textcolor: 'xcolor',
  colorbox: 'xcolor',
  fcolorbox: 'xcolor',
  pagecolor: 'xcolor',
  rowcolor: 'xcolor',
  cellcolor: 'xcolor',
  columncolor: 'xcolor',
  definecolor: 'xcolor',

  // Graphics
  includegraphics: 'graphicx',
  graphicspath: 'graphicx',
  rotatebox: 'graphicx',
  scalebox: 'graphicx',
  reflectbox: 'graphicx',
  resizebox: 'graphicx',

  // Hyperref / URL (ambiguous: url could be either)
  url: 'url or hyperref',
  href: 'hyperref',
  hyperref: 'hyperref',
  hypersetup: 'hyperref',
  autoref: 'hyperref',
  nameref: 'hyperref',

  // Tables
  multirow: 'multirow',
  toprule: 'booktabs',
  midrule: 'booktabs',
  bottomrule: 'booktabs',
  cmidrule: 'booktabs',
  addlinespace: 'booktabs',

  // SI units (legacy + modern interface)
  SI: 'siunitx',
  si: 'siunitx',
  num: 'siunitx',
  qty: 'siunitx',
  ang: 'siunitx',
  numlist: 'siunitx',
  numrange: 'siunitx',
  SIrange: 'siunitx',
  SIlist: 'siunitx',

  // Code / listings
  lstlisting: 'listings',
  lstinputlisting: 'listings',
  lstset: 'listings',
  mintinline: 'minted',
  inputminted: 'minted',

  // Sub-figures / captions
  subcaption: 'subcaption',
  subfigure: 'subcaption',
  caption: 'caption',
  captionof: 'caption',

  // TikZ / PGF
  tikz: 'tikz',
  tikzset: 'tikz',
  begintikzpicture: 'tikz',
  pgfplotsset: 'pgfplots',
  addplot: 'pgfplots',

  // Algorithms
  algorithmiccomment: 'algorithmicx',

  // Chemistry
  ce: 'mhchem',
  chemfig: 'chemfig',

  // amsmath / amssymb
  text: 'amsmath',
  cfrac: 'amsmath',
  dfrac: 'amsmath',
  tfrac: 'amsmath',
  binom: 'amsmath',
  dbinom: 'amsmath',
  tbinom: 'amsmath',
  intertext: 'amsmath',
  substack: 'amsmath',
  pmatrix: 'amsmath',
  bmatrix: 'amsmath',
  vmatrix: 'amsmath',
  Bmatrix: 'amsmath',
  Vmatrix: 'amsmath',
  mathbb: 'amssymb',
  mathfrak: 'amssymb',
  varnothing: 'amssymb',
  blacksquare: 'amssymb',

  // amsthm
  theoremstyle: 'amsthm',
  newtheorem: 'amsthm',
  qedhere: 'amsthm',

  // Bibliography (biblatex)
  printbibliography: 'biblatex',
  addbibresource: 'biblatex',
  autocite: 'biblatex',
  parencite: 'biblatex',
  textcite: 'biblatex',
  citeauthor: 'biblatex',

  // ToDo / annotation
  todo: 'todonotes',
  missingfigure: 'todonotes',
  listoftodos: 'todonotes',

  // Lorem-ipsum
  lipsum: 'lipsum',
  blindtext: 'blindtext',
  Blindtext: 'blindtext',

  // Misc filler / text
  ifthenelse: 'ifthen',
  pageref: null,

  // Fancy headers
  fancyhead: 'fancyhdr',
  fancyfoot: 'fancyhdr',
  pagestyle: null,

  // Floats / placement
  FloatBarrier: 'placeins',

  // Icons / fonts
  faIcon: 'fontawesome5',
  textbullet: null,

  // Cross-ref groups
  cref: 'cleveref',
  Cref: 'cleveref',
  cpageref: 'cleveref',

  // Microtype / fonts
  microtypesetup: 'microtype',
};

/**
 * Lookup: environment name -> the canonical package that provides it.
 * Same shape as COMMAND_PACKAGES (null = built-in, no fix needed;
 * space-separated values = ambiguous, suggestion only).
 *
 * @type {Record<string, string | null>}
 */
const ENVIRONMENT_PACKAGES = {
  // Built-ins: typo, not a missing package.
  itemize: null,
  enumerate: null,
  description: null,
  verbatim: null,
  quote: null,
  quotation: null,
  center: null,
  flushleft: null,
  flushright: null,
  abstract: null,
  table: null,
  tabular: null,
  figure: null,
  'figure*': null,
  'table*': null,

  // amsmath
  align: 'amsmath',
  'align*': 'amsmath',
  gather: 'amsmath',
  'gather*': 'amsmath',
  multline: 'amsmath',
  'multline*': 'amsmath',
  equation: 'amsmath',
  'equation*': 'amsmath',
  cases: 'amsmath',
  split: 'amsmath',
  aligned: 'amsmath',
  gathered: 'amsmath',

  // amsthm
  proof: 'amsthm',

  // Source listings
  lstlisting: 'listings',
  minted: 'minted',
  verbatimwrite: 'fancyvrb',

  // Floats / figures
  subfigure: 'subcaption',
  subtable: 'subcaption',
  wrapfigure: 'wrapfig',
  sidewaystable: 'rotating',
  sidewaysfigure: 'rotating',

  // Graphics / drawing
  tikzpicture: 'tikz',
  pgfpicture: 'pgf',
  axis: 'pgfplots',
  semilogxaxis: 'pgfplots',
  semilogyaxis: 'pgfplots',
  loglogaxis: 'pgfplots',

  // Algorithms
  algorithm: 'algorithm',
  algorithmic: 'algorithmicx',
  algorithm2e: 'algorithm2e',

  // Tables
  longtable: 'longtable',
  tabularx: 'tabularx',
  tabulary: 'tabulary',
  threeparttable: 'threeparttable',

  // Math display environments common in inproc/article styles
  IEEEeqnarray: 'IEEEtrantools',

  // Frame / poster / slides (beamer is a documentclass not a package;
  // omitted on purpose).
  frame: null,
  block: null,
};

/**
 * Return a fix descriptor when we can offer a one-click fix for the
 * "Undefined command" error.
 *
 * @param {RegExpMatchArray} m
 * @returns {{ kind: 'add-usepackage', package: string, label: string } | null}
 */
function buildUndefinedCommandFix(m) {
  const cmd = m[1];
  const pkg = COMMAND_PACKAGES[cmd];
  // Skip null entries (built-in commands) and ambiguous suggestions
  // (the "url or hyperref" pattern) -- those need human judgement.
  if (!pkg || /\s/.test(pkg)) return null;
  return {
    kind: 'add-usepackage',
    package: pkg,
    label: `Add \\usepackage{${pkg}} to preamble`,
  };
}

/**
 * Same shape as buildUndefinedCommandFix, but for "Environment X
 * undefined" errors. Reuses the add-usepackage kind so the orchestrator
 * in App.jsx needs no changes.
 *
 * @param {RegExpMatchArray} m
 * @returns {{ kind: 'add-usepackage', package: string, label: string } | null}
 */
function buildUndefinedEnvironmentFix(m) {
  const env = m[1];
  const pkg = ENVIRONMENT_PACKAGES[env];
  if (!pkg || /\s/.test(pkg)) return null;
  return {
    kind: 'add-usepackage',
    package: pkg,
    label: `Add \\usepackage{${pkg}} to preamble`,
  };
}

/**
 * Build a "remove \usepackage{X}" fix for the "Missing package" error.
 * Used when the package is not installed on the system and the user
 * may want to compile without it.
 *
 * @param {RegExpMatchArray} m
 * @returns {{ kind: 'remove-usepackage', package: string, label: string }}
 */
function buildRemoveMissingPackageFix(m) {
  const pkg = m[1];
  return {
    kind: 'remove-usepackage',
    package: pkg,
    label: `Remove \\usepackage{${pkg}}`,
  };
}

/**
 * Build a "rename \end{X} to \end{Y}" fix for the "Mismatched
 * environments" error. Reuses the env-rename pipeline; the actual
 * begin/end names come from the source at fix-application time, not
 * the log, so this descriptor is small.
 *
 * @param {RegExpMatchArray} m
 * @returns {{ kind: 'rename-env-end', beginName: string, endName: string, label: string }}
 */
function buildRenameEndEnvFix(m) {
  return {
    kind: 'rename-env-end',
    beginName: m[1],
    endName: m[2],
    label: `Change \\end{${m[2]}} to match \\begin{${m[1]}}`,
  };
}

const IMAGE_EXTS_RE = /\.(?:png|jpe?g|pdf|eps|svg|gif|bmp)$/i;

/**
 * Build a "find a graphicspath candidate, then add \graphicspath{{X/}}"
 * fix for File-not-found errors that look like an image. The actual
 * project-file lookup happens in the orchestrator; the descriptor
 * just carries the missing path.
 *
 * Decline for non-image-looking files (.tex / .bib etc. — those have
 * their own fix flows in batch C and don't belong on this rule).
 *
 * @param {RegExpMatchArray} m
 * @returns {{ kind: 'add-graphicspath', missingFile: string, label: string } | null}
 */
function buildAddGraphicspathFix(m) {
  const missing = m[1];
  if (!missing) return null;
  // Image-y extension OR no extension at all -> probably
  // \includegraphics. Anything else (e.g. .bib, .tex) skip.
  const lastDot = missing.lastIndexOf('.');
  const lastSlash = Math.max(missing.lastIndexOf('/'), missing.lastIndexOf('\\'));
  const hasExtension = lastDot > lastSlash;
  if (hasExtension && !IMAGE_EXTS_RE.test(missing)) return null;
  return {
    kind: 'add-graphicspath',
    missingFile: missing,
    label: `Add \\graphicspath for "${missing}"`,
  };
}

/**
 * Build a "swap image extension" fix for "Cannot determine size of
 * graphic in foo.svg" errors. The orchestrator looks at the active
 * file at the reported line, finds the \includegraphics token, and
 * checks the project for a sibling with a pdflatex-friendly
 * extension.
 *
 * @param {RegExpMatchArray} m
 * @returns {{ kind: 'swap-image-ext', badName: string, label: string } | null}
 */
function buildSwapImageExtensionFix(m) {
  const badName = m[1];
  if (!badName) return null;
  return {
    kind: 'swap-image-ext',
    badName,
    label: `Swap "${badName}" to a pdflatex-friendly extension`,
  };
}

/**
 * Build two fix descriptors for a citation-undefined error: one to
 * append a skeleton entry to the project's .bib file, and one to
 * open the Zotero modal pre-filtered by the missing key. The LogItem
 * UI renders one button per descriptor; the orchestrator skips
 * silently when the underlying resource isn't available (no .bib in
 * the project for the first, Zotero not configured for the second).
 *
 * Returning an ARRAY here is the first use of the multi-fix shape;
 * LogItem normalises single-or-array via Array.isArray check.
 *
 * @param {RegExpMatchArray} m
 * @returns {Array<{ kind: string, citationKey: string, label: string }>}
 */
function buildCitationFix(m) {
  const key = m[1];
  return [
    {
      kind: 'open-bib-with-skeleton',
      citationKey: key,
      label: `Add "${key}" skeleton to .bib`,
    },
    {
      kind: 'open-zotero-for-key',
      citationKey: key,
      label: `Search Zotero for "${key}"`,
    },
  ];
}

const ERROR_RULES = [
  // ── Missing packages / commands ────────────────────────────
  {
    pattern: /Undefined control sequence.*\\(\w+)/i,
    title: 'Undefined command',
    suggestion: (/** @type {RegExpMatchArray} */ m) => {
      const cmd = m[1];
      const pkg = COMMAND_PACKAGES[cmd];
      if (pkg) return `The command \\${cmd} requires \\usepackage{${pkg}} in your preamble.`;
      return `\\${cmd} is not defined. Check for typos, or add the required \\usepackage{} in your preamble.`;
    },
    searchQuery: (/** @type {RegExpMatchArray} */ m) => `undefined control sequence ${m[1]}`,
    fix: buildUndefinedCommandFix,
    tips: [
      'Check for typos in the command name',
      'Add the missing \\usepackage{} in your preamble before \\begin{document}',
      'If this is a custom command, define it with \\newcommand{\\cmd}{definition}',
      'Some commands are only available in math mode — wrap them in $...$',
    ],
  },
  {
    pattern: /Undefined control sequence/i,
    title: 'Undefined command',
    suggestion: () =>
      'A command is not recognized. Check for typos or add the required \\usepackage{} in your preamble.',
    searchQuery: () => 'undefined control sequence latex',
    tips: [
      'Check for typos in the command name',
      'Add the missing \\usepackage{} in your preamble',
      'If this is a custom command, define it with \\newcommand',
    ],
  },

  // ── Missing $ ──────────────────────────────────────────────
  {
    pattern: /Missing \$ inserted/i,
    title: 'Math mode required',
    suggestion: () =>
      'You used a math-only character (like _ ^ \\sum \\alpha) outside of math mode. Wrap it in $...$ for inline math or \\[...\\] for display math. For a literal underscore in text, use \\_.',
    searchQuery: () => 'missing $ inserted latex',
    tips: [
      'Characters like _ ^ are math-only — use \\_ or \\^{} in text',
      'Wrap math expressions in $...$ for inline or \\[...\\] for display',
      'Greek letters like \\alpha \\beta need math mode: $\\alpha$',
      'For literal special characters: \\_ \\^{} \\& \\# \\%',
    ],
    example: 'Before: The value is x_1\nAfter:  The value is $x_1$\n   or:  The value is x\\_1',
  },

  // ── Environment errors ─────────────────────────────────────
  {
    pattern: /\\begin\{(\w+)\}.*\\end\{(\w+)\}/i,
    title: 'Mismatched environments',
    suggestion: (/** @type {RegExpMatchArray} */ m) =>
      `\\begin{${m[1]}} is closed by \\end{${m[2]}}. Make sure each \\begin has a matching \\end with the same name.`,
    searchQuery: (/** @type {RegExpMatchArray} */ m) => `mismatched begin end ${m[1]} ${m[2]} latex`,
    fix: buildRenameEndEnvFix,
    tips: [
      'Every \\begin{name} must have a matching \\end{name}',
      'Check for typos in the environment name',
      'Environments must be properly nested — no overlapping',
    ],
  },
  {
    pattern: /Environment (\w+) undefined/i,
    title: 'Unknown environment',
    suggestion: (/** @type {RegExpMatchArray} */ m) => {
      const env = m[1];
      const pkg = ENVIRONMENT_PACKAGES[env];
      if (pkg && !/\s/.test(pkg)) {
        return `The environment "${env}" requires \\usepackage{${pkg}} in your preamble.`;
      }
      return `The environment "${env}" is not defined. Check spelling or add the package that provides it.`;
    },
    searchQuery: (/** @type {RegExpMatchArray} */ m) => `environment ${m[1]} undefined latex`,
    fix: buildUndefinedEnvironmentFix,
    tips: ['Check the environment name for typos', 'Add the package that provides this environment'],
  },

  // ── Brace / bracket errors ─────────────────────────────────
  {
    pattern: /Too many \}'s/i,
    title: 'Extra closing brace',
    suggestion: () =>
      'There is an unmatched }. Check for missing opening braces or an extra closing brace near the reported line.',
    searchQuery: () => 'too many closing braces latex',
    tips: [
      'Count opening { and closing } braces — they must match',
      'Check for accidentally doubled closing braces }}',
      "Use your editor's bracket matching to find the mismatch",
    ],
  },
  {
    pattern: /Missing \} inserted|Runaway argument|Paragraph ended before.*was complete/i,
    title: 'Missing closing brace',
    suggestion: () =>
      'A { was opened but never closed before a paragraph break or \\end. Add the missing } or check for misplaced braces.',
    searchQuery: () => 'runaway argument missing brace latex',
    tips: [
      'A { was opened but never closed',
      'Blank lines inside command arguments can cause this',
      'Check that all { have matching }',
      'Look for commands where you forgot the closing brace',
    ],
    example:
      'Before: \\textbf{some bold text\n         more text\nAfter:  \\textbf{some bold text\n         more text}',
  },
  {
    pattern: /Extra alignment tab.*\\\\|Extra &/i,
    title: 'Extra column separator',
    suggestion: () =>
      'Too many & separators in a table row. The number of & in each row must be one less than the number of columns defined in \\begin{tabular}{...}.',
    searchQuery: () => 'extra alignment tab character latex tabular',
    tips: [
      'Count the & in each row — should be (columns - 1)',
      'Check your \\begin{tabular}{...} column specification',
      'For a literal &, use \\& instead',
    ],
    example:
      '\\begin{tabular}{lcc}  % 3 columns = max 2 "&" per row\n  A & B & C \\\\       % correct: 2 ampersands\n  D & E & F & G \\\\   % error: 3 ampersands\n\\end{tabular}',
  },

  // ── File not found ─────────────────────────────────────────
  // The .sty-specific rule MUST come before the generic "File X not
  // found" rule because rule iteration uses first-match-wins. With the
  // order reversed, the .sty rule was unreachable -- a finding caught
  // by the getErrorHelp test suite.
  {
    pattern: /LaTeX Error: File `(.+?)\.sty' not found/i,
    title: 'Missing package',
    suggestion: (/** @type {RegExpMatchArray} */ m) =>
      `The package "${m[1]}" is not installed. Check the package name for typos. If correct, this package may not be available in the current TeX installation.`,
    searchQuery: (/** @type {RegExpMatchArray} */ m) => `package ${m[1]} not found latex install`,
    fix: buildRemoveMissingPackageFix,
    tips: [
      'Check the package name for typos',
      'The package may need to be installed in the TeX distribution',
      'Try an alternative package that provides similar functionality',
    ],
  },
  {
    pattern: /File `(.+?)' not found/i,
    title: 'File not found',
    suggestion: (/** @type {RegExpMatchArray} */ m) =>
      `The file "${m[1]}" could not be found. Check that the filename and path are correct, and that the file exists in your project.`,
    searchQuery: (/** @type {RegExpMatchArray} */ m) => `file not found "${m[1]}" latex`,
    fix: buildAddGraphicspathFix,
    tips: [
      'Check that the file name and extension are correct',
      'File paths are relative to the main .tex file',
      'File names are case-sensitive',
      'Do not include the .tex extension in \\input{} commands',
    ],
  },

  // ── Citation / reference errors ────────────────────────────
  {
    pattern: /Citation `(.+?)' .* undefined/i,
    title: 'Undefined citation',
    suggestion: (/** @type {RegExpMatchArray} */ m) =>
      `The citation key "${m[1]}" was not found in your .bib file. Check spelling, ensure the .bib file is included with \\bibliography{} or \\addbibresource{}, and recompile twice.`,
    searchQuery: (/** @type {RegExpMatchArray} */ m) => `citation ${m[1]} undefined latex bibtex`,
    fix: buildCitationFix,
    tips: [
      'Check the citation key in your .bib file for exact spelling',
      'Make sure \\bibliography{file} or \\addbibresource{file.bib} is present',
      'Build twice — LaTeX needs multiple passes for citations',
      'Run BibTeX/Biber between compilations if needed',
    ],
  },
  {
    pattern: /Reference `(.+?)' .* undefined/i,
    title: 'Undefined reference',
    suggestion: (/** @type {RegExpMatchArray} */ m) =>
      `The label "${m[1]}" is not defined. Make sure you have a \\label{${m[1]}} somewhere, and recompile twice so cross-references resolve.`,
    searchQuery: (/** @type {RegExpMatchArray} */ m) => `reference ${m[1]} undefined latex label`,
    tips: [
      'Make sure \\label{name} exists for the referenced item',
      'Place \\label after \\caption in figures/tables',
      'Build twice for cross-references to resolve',
      'Labels are case-sensitive',
    ],
  },
  {
    pattern: /There were undefined references/i,
    title: 'Undefined references',
    suggestion: () =>
      'Some \\ref or \\cite commands could not be resolved. Try recompiling — LaTeX often needs two passes for cross-references. If it persists, check your \\label and \\cite keys.',
    searchQuery: () => 'undefined references latex recompile',
    tips: [
      'Build the document twice',
      'Check all \\ref{} and \\cite{} keys for typos',
      'Make sure .bib files are properly included',
    ],
  },

  // ── Figure / image errors ──────────────────────────────────
  {
    pattern: /Unknown graphics extension/i,
    title: 'Unsupported image format',
    suggestion: () =>
      'The image format is not supported. pdflatex supports .png, .jpg, .pdf. Convert your image or use a supported format.',
    searchQuery: () => 'unknown graphics extension latex pdflatex',
    tips: [
      'pdflatex supports: .png, .jpg, .jpeg, .pdf',
      'Convert .eps files to .pdf using epstopdf',
      'Convert .svg files to .pdf using inkscape or rsvg-convert',
      'Add \\usepackage{epstopdf} for automatic EPS conversion',
    ],
  },
  {
    // Capture the filename: LaTeX writes "Cannot determine size of graphic
    // in foo.svg (no BoundingBox)." -- the name (with extension) is the
    // first word after "in ".
    pattern: /Cannot determine size of graphic in ([^\s()]+)/i,
    title: 'Image size unknown',
    suggestion: (/** @type {RegExpMatchArray} */ m) =>
      `LaTeX cannot determine the dimensions of "${m[1]}". This usually means the file's format is unsupported (e.g. .svg or .eps with pdflatex). Convert to PDF or PNG, or use a sibling already in the project.`,
    searchQuery: (/** @type {RegExpMatchArray} */ m) => `cannot determine size of graphic ${m[1]} latex`,
    fix: buildSwapImageExtensionFix,
    tips: [
      'Specify dimensions: \\includegraphics[width=0.8\\textwidth]{img}',
      'Make sure the image file is not corrupted',
      'EPS files need \\usepackage{epstopdf} with pdflatex',
      'SVG files need conversion to PDF or PNG before use with pdflatex',
    ],
  },
  // Generic catch-all in case the format we captured above doesn't
  // match (older log shapes). Keeps the previous behaviour.
  {
    pattern: /Cannot determine size of graphic/i,
    title: 'Image size unknown',
    suggestion: () =>
      'LaTeX cannot determine the image dimensions. Try specifying width explicitly: \\includegraphics[width=0.8\\textwidth]{image}. EPS files require the epstopdf package with pdflatex.',
    searchQuery: () => 'cannot determine size of graphic latex',
    tips: [
      'Specify dimensions: \\includegraphics[width=0.8\\textwidth]{img}',
      'Make sure the image file is not corrupted',
      'EPS files need \\usepackage{epstopdf} with pdflatex',
      'Check the file extension is correct',
    ],
  },

  // ── Overfull / underfull ───────────────────────────────────
  {
    pattern: /Overfull \\hbox.*?(\d+\.?\d*)pt/i,
    title: 'Content too wide',
    suggestion: (/** @type {RegExpMatchArray} */ m) =>
      `Text or an element extends ${m[1]}pt past the margin. Try rewording, breaking long words with \\hyphenation{}, using a smaller font, or wrapping in a \\resizebox{}.`,
    searchQuery: () => 'overfull hbox latex fix',
    tips: [
      'Rephrase the sentence to allow better line breaking',
      'Add \\sloppy or \\emergencystretch=1em for more flexibility',
      'Use \\hyphenation{long-word} to specify break points',
      'For URLs, use \\usepackage{url} or \\usepackage{hyperref}',
      'Small overflows (< 1pt) are usually invisible',
    ],
  },
  {
    pattern: /Underfull \\hbox.*?badness (\d+)/i,
    title: 'Loose line spacing',
    suggestion: (/** @type {RegExpMatchArray} */ m) => {
      const badness = parseInt(m[1]);
      if (badness >= 10000)
        return 'A line is nearly empty. Check for forced line breaks (\\\\) or \\newline in running text. Let LaTeX handle line breaking.';
      return 'LaTeX had to stretch the line more than ideal. This is usually minor and can be ignored unless it looks bad.';
    },
    searchQuery: () => 'underfull hbox badness latex',
    tips: [
      'Usually safe to ignore unless the output looks bad',
      'Avoid forced line breaks (\\\\) in running text',
      'Use \\mbox{} to prevent unwanted word breaks',
    ],
  },

  // ── Font errors ────────────────────────────────────────────
  {
    pattern: /Font.*not found|font shape.*undefined/i,
    title: 'Missing font',
    suggestion: () =>
      'A requested font is not available. Check your font name for typos, or use a standard font family. With pdflatex, use packages like \\usepackage{lmodern} or \\usepackage{times}.',
    searchQuery: () => 'font not found latex pdflatex',
    tips: [
      'Use \\usepackage{lmodern} for a modern default font',
      'pdflatex has limited font support — consider LuaLaTeX for system fonts',
      'Check font name spelling in \\usepackage or \\fontfamily commands',
    ],
  },

  // ── Float / placement ──────────────────────────────────────
  {
    pattern: /Too many unprocessed floats/i,
    title: 'Float queue full',
    suggestion: () =>
      'Too many figures/tables are waiting to be placed. Add \\clearpage between some of them, or use the [H] placement specifier (requires the float package).',
    searchQuery: () => 'too many unprocessed floats latex',
    tips: [
      'Add \\clearpage to flush pending floats',
      'Use \\usepackage{float} and [H] for exact placement',
      'Use [!htbp] for maximum flexibility',
      'Break the document into smaller sections with \\clearpage',
    ],
  },
  {
    pattern: /`h' float specifier changed to `ht'/i,
    title: 'Float placement adjusted',
    suggestion: () =>
      "LaTeX changed [h] to [ht] because the float didn't fit here. Use [htbp] for more flexibility, or [H] (with \\usepackage{float}) to force placement.",
    searchQuery: () => 'float specifier changed ht latex',
    tips: [
      'Use [htbp] instead of [h] for more flexibility',
      'Use [H] with \\usepackage{float} to force exact placement',
      '[h] alone is almost never sufficient — LaTeX needs fallback options',
    ],
  },

  // ── Encoding / special characters ──────────────────────────
  {
    pattern: /Package inputenc Error.*Invalid UTF-8|Unicode char/i,
    title: 'Encoding error',
    suggestion: () =>
      'Your file contains a character that LaTeX cannot process. Make sure your file is saved as UTF-8, and add \\usepackage[utf8]{inputenc} to your preamble (often included by default).',
    searchQuery: () => 'invalid utf-8 byte latex inputenc',
    tips: [
      'Save your file as UTF-8 encoding',
      'Add \\usepackage[utf8]{inputenc} to your preamble',
      'Replace non-ASCII characters with LaTeX equivalents (e.g. \\"{u} for ü)',
      'Consider using LuaLaTeX for better Unicode support',
    ],
  },

  // ── Capacity exceeded ──────────────────────────────────────
  {
    pattern: /TeX capacity exceeded/i,
    title: 'TeX out of memory',
    suggestion: () =>
      "The document is too complex for TeX's memory. This usually indicates an infinite loop — check for recursive \\input or self-referencing macros.",
    searchQuery: () => 'tex capacity exceeded latex',
    tips: [
      'Check for recursive \\input or \\include commands',
      'Look for self-referencing or infinitely expanding macros',
      'Simplify very complex tables or TikZ diagrams',
    ],
  },

  // ── Misplaced alignment ────────────────────────────────────
  {
    pattern: /Misplaced \\noalign|Misplaced \\omit/i,
    title: 'Table structure error',
    suggestion: () =>
      'A command like \\hline or \\cline is in the wrong position. Make sure \\hline appears right after \\\\ or at the start of a tabular, not in the middle of a row.',
    searchQuery: () => 'misplaced noalign hline latex tabular',
    tips: [
      '\\hline must come right after \\\\ or at the start of the table',
      'Do not put \\hline in the middle of a row',
      'Use booktabs (\\toprule, \\midrule, \\bottomrule) for better tables',
    ],
  },

  // ── Option clash ───────────────────────────────────────────
  {
    pattern: /Option clash for package (\w+)/i,
    title: 'Conflicting package options',
    suggestion: (/** @type {RegExpMatchArray} */ m) =>
      `The package "${m[1]}" is loaded twice with different options. Load it once with all options, or use \\PassOptionsToPackage{options}{${m[1]}} before \\documentclass.`,
    searchQuery: (/** @type {RegExpMatchArray} */ m) => `option clash package ${m[1]} latex`,
    tips: [
      'Load the package only once with all needed options',
      'Use \\PassOptionsToPackage{opts}{pkg} before \\documentclass',
      'Some document classes load packages automatically — check the class docs',
    ],
  },

  // ── Lint errors (match actual lint message format) ──────────
  {
    pattern: /Unmatched.*too many closing braces/i,
    title: 'Extra closing brace',
    suggestion: () =>
      'A } without a matching {. Check the reported line and the lines above it for missing opening braces.',
    searchQuery: () => 'unmatched closing brace latex',
    tips: [
      'Count opening and closing braces — they must match',
      'Use bracket matching in the editor to find the mismatch',
      'Check for accidentally doubled }}',
    ],
  },
  {
    pattern: /unclosed.*missing closing brace/i,
    title: 'Missing closing brace',
    suggestion: () => 'A { was never closed. Add the missing } after the content that should be inside the braces.',
    searchQuery: () => 'missing closing brace latex',
    tips: ['Every { needs a matching }', 'Check commands like \\textbf{, \\emph{, etc. for missing }'],
  },
  {
    pattern: /Unclosed inline math mode/i,
    title: 'Unclosed math mode',
    suggestion: () =>
      'A $ was opened but never closed. Every $ must have a matching closing $. Check for missing $ after the math expression.',
    searchQuery: () => 'unclosed math mode dollar sign latex',
    tips: [
      'Every $ must have a matching $',
      'For a literal dollar sign, use \\$',
      'Consider using \\(...\\) instead of $...$ for clarity',
    ],
  },
  {
    pattern: /Unclosed display math mode/i,
    title: 'Unclosed math mode',
    suggestion: () =>
      'A $$ was opened but never closed. Every $$ must have a matching closing $$. Consider using \\[...\\] instead of $$...$$.',
    searchQuery: () => 'unclosed display math mode latex',
    tips: ['Every $$ must have a matching $$', 'Prefer \\[...\\] over $$...$$ for display math'],
  },
  {
    pattern: /Environment mismatch.*expected \\\\end/i,
    title: 'Environment mismatch',
    suggestion: () =>
      'A \\begin{...} does not match its \\end{...}. Check that every environment is opened and closed with the same name.',
    searchQuery: () => 'environment mismatch begin end latex',
    tips: [
      'Every \\begin{name} needs \\end{name} with the same name',
      'Environments must be properly nested',
      'Check for typos in environment names',
    ],
  },
  {
    pattern: /\\end\{.*\} without matching \\begin/i,
    title: 'Extra \\end',
    suggestion: () =>
      'An \\end{...} was found without a corresponding \\begin{...}. Remove the extra \\end or add the missing \\begin above it.',
    searchQuery: () => 'end without begin latex',
    tips: ['Remove the extra \\end, or add the missing \\begin above it'],
  },
  {
    pattern: /Unclosed environment.*\\begin\{(.*?)\}/i,
    title: 'Unclosed environment',
    suggestion: (/** @type {RegExpMatchArray} */ m) =>
      `The environment ${m[1]} was opened with \\begin{${m[1]}} but never closed. Add \\end{${m[1]}} at the appropriate position.`,
    searchQuery: (/** @type {RegExpMatchArray} */ m) => `unclosed environment ${m[1]} latex`,
    tips: ['Add the missing \\end{} at the correct position'],
  },
  {
    pattern: /Misplaced alignment character/i,
    title: 'Stray & character',
    suggestion: () =>
      'The & character is used for column alignment in tables and equations. In regular text, use \\& instead.',
    searchQuery: () => 'misplaced alignment character ampersand latex',
    tips: [
      'Use \\& for a literal ampersand in text',
      '& is only valid inside tabular, align, and similar environments',
    ],
    example: 'Before: Tom & Jerry\nAfter:  Tom \\& Jerry',
  },
  {
    pattern: /Misplaced "#"/i,
    title: 'Stray # character',
    suggestion: () => 'The # character is used for macro parameters. In regular text, use \\# instead.',
    searchQuery: () => 'hash character latex special',
    tips: [
      'Use \\# for a literal hash/number sign in text',
      '# is only valid inside \\newcommand definitions as parameter reference (#1, #2)',
    ],
  },
  {
    pattern: /Misplaced.*outside math mode/i,
    title: 'Math-only character in text',
    suggestion: () =>
      'This character is only valid inside math mode ($...$). Either wrap it in $...$ or use the escaped version (\\_ for underscore, \\^ for caret).',
    searchQuery: () => 'special character outside math mode latex underscore caret',
    tips: [
      'Use \\_ for a literal underscore in text',
      'Use \\^{} for a literal caret in text',
      'Or wrap the expression in math mode: $x_1$',
    ],
    example: 'Before: my_variable\nAfter:  my\\_variable\n   or:  $my\\_variable$',
  },
  {
    pattern: /Unknown command "\\(\w+)"/i,
    title: 'Unknown command',
    suggestion: (/** @type {RegExpMatchArray} */ m) => {
      const cmd = m[1];
      /** @type {Record<string, string>} */
      const packages = {
        includegraphics: 'graphicx',
        url: 'url or hyperref',
        href: 'hyperref',
        multirow: 'multirow',
        toprule: 'booktabs',
        midrule: 'booktabs',
        bottomrule: 'booktabs',
        cmidrule: 'booktabs',
        SI: 'siunitx',
        si: 'siunitx',
        num: 'siunitx',
        textcolor: 'xcolor',
        colorbox: 'xcolor',
        definecolor: 'xcolor',
        lstlisting: 'listings',
        lstinline: 'listings',
        mintinline: 'minted',
        mint: 'minted',
        subfigure: 'subcaption',
        subcaption: 'subcaption',
        tikz: 'tikz',
        draw: 'tikz',
        pgfplotsset: 'pgfplots',
        lipsum: 'lipsum',
        blindtext: 'blindtext',
        uline: 'ulem',
        sout: 'ulem',
        cref: 'cleveref',
        Cref: 'cleveref',
        mathbb: 'amssymb or amsfonts',
        mathfrak: 'amssymb or amsfonts',
        bm: 'bm',
        boldsymbol: 'amsmath',
      };
      const pkg = packages[cmd];
      if (pkg) return `\\${cmd} requires \\usepackage{${pkg}} in your preamble.`;
      return `\\${cmd} is not recognized. Check for typos, or add the required \\usepackage{} in your preamble. If this is a custom command, define it with \\newcommand.`;
    },
    searchQuery: (/** @type {RegExpMatchArray} */ m) => `undefined command ${m[1]} latex`,
    tips: [
      'Check the command name for typos',
      'Add the required \\usepackage{} in your preamble',
      'Define custom commands with \\newcommand',
    ],
  },
];

/**
 * Match an error message against known LaTeX error patterns and return help info.
 *
 * The returned `fix` field can be:
 *   - null, when the rule has no fix
 *   - a single fix descriptor object, when there's exactly one fix
 *   - an array of fix descriptors, when an error has multiple
 *     plausible fixes (e.g. citation undefined -> add to .bib OR
 *     search Zotero).
 * LogItem normalises via Array.isArray and renders one button per
 * descriptor.
 *
 * @param {string} message - Raw error or lint message
 * @returns {{
 *   title: string,
 *   suggestion: string,
 *   tips: string[],
 *   example: string|null,
 *   searchUrl: string,
 *   fix: { kind: string, [k: string]: any } | Array<{ kind: string, [k: string]: any }> | null
 * } | null}
 */
export function getErrorHelp(message) {
  if (!message) return null;
  for (const rule of ERROR_RULES) {
    const m = message.match(rule.pattern);
    if (m) {
      const query = typeof rule.searchQuery === 'function' ? rule.searchQuery(m) : rule.searchQuery || rule.title;
      // @ts-ignore -- `fix` is rule-defined and optional
      const fix = typeof rule.fix === 'function' ? rule.fix(m) : null;
      return {
        title: rule.title,
        suggestion: typeof rule.suggestion === 'function' ? rule.suggestion(m) : rule.suggestion,
        tips: rule.tips || [],
        example: rule.example || null,
        searchUrl: `https://tex.stackexchange.com/search?q=${encodeURIComponent(query)}`,
        fix,
      };
    }
  }
  return null;
}
