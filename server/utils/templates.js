// @ts-check
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(__dirname, '..', 'assets', 'templates');

/** Read a bundled template asset file by name, returning empty string on failure. */
/** @param {string} name */
function loadAsset(name) {
  try {
    return readFileSync(join(assetsDir, name), 'utf8');
  } catch {
    return '';
  }
}

const IEEEtranCls = loadAsset('IEEEtran.cls');
const IEEEtranBst = loadAsset('IEEEtran.bst');
const IEEEbareConf = loadAsset('bare_conf.tex');
const acmartCls = loadAsset('acmart.cls');
const acmRefFormat = loadAsset('ACM-Reference-Format.bst');
const acmSampleSigconf = loadAsset('sample-sigconf.tex');

// Project templates — each defines a set of files to create
const TEMPLATES = [
  {
    id: 'article',
    name: 'Article',
    description: 'Standard academic article',
    category: 'Academic',
    files: [
      {
        path: 'main.tex',
        content: `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath, amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\title{__TITLE__}
\\author{__AUTHOR__}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
Your abstract here.
\\end{abstract}

\\section{Introduction}
Start writing here.

\\section{Methods}

\\section{Results}

\\section{Discussion}

\\section{Conclusion}

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`,
      },
      {
        path: 'references.bib',
        content: `@article{example2024,
  author  = {Author, First},
  title   = {An Example Article},
  journal = {Journal of Examples},
  year    = {2024},
  volume  = {1},
  pages   = {1--10},
}
`,
      },
    ],
  },
  {
    id: 'report',
    name: 'Report',
    description: 'Structured report with table of contents',
    category: 'Academic',
    files: [
      {
        path: 'main.tex',
        content: `\\documentclass[12pt]{report}
\\usepackage[utf8]{inputenc}
\\usepackage[a4paper, margin=1in]{geometry}
\\usepackage{amsmath, amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{fancyhdr}

\\pagestyle{fancy}
\\fancyhf{}
\\rhead{__TITLE__}
\\lhead{\\leftmark}
\\rfoot{Page \\thepage}

\\title{__TITLE__}
\\author{__AUTHOR__}
\\date{\\today}

\\begin{document}

\\maketitle
\\tableofcontents
\\newpage

\\chapter{Introduction}
Start writing here.

\\chapter{Background}

\\chapter{Methodology}

\\chapter{Results}

\\chapter{Conclusion}

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`,
      },
      {
        path: 'references.bib',
        content: '',
      },
    ],
  },
  {
    id: 'thesis',
    name: 'Thesis',
    description: 'Multi-chapter thesis with front matter',
    category: 'Academic',
    files: [
      {
        path: 'main.tex',
        content: `\\documentclass[12pt, a4paper]{report}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath, amssymb, amsthm}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{setspace}
\\usepackage{fancyhdr}

\\onehalfspacing

\\title{__TITLE__}
\\author{__AUTHOR__}
\\date{\\today}

\\begin{document}

% --- Front matter ---
\\pagenumbering{roman}
\\maketitle

\\chapter*{Abstract}
Your abstract here.

\\chapter*{Acknowledgements}
Your acknowledgements here.

\\tableofcontents
\\listoffigures
\\listoftables

% --- Main matter ---
\\newpage
\\pagenumbering{arabic}

\\input{chapters/introduction}
\\input{chapters/literature}
\\input{chapters/methodology}
\\input{chapters/results}
\\input{chapters/conclusion}

\\bibliographystyle{plain}
\\bibliography{references}

\\appendix
\\input{chapters/appendix}

\\end{document}
`,
      },
      {
        path: 'chapters/introduction.tex',
        content: `\\chapter{Introduction}
\\label{ch:introduction}

Start writing your introduction here.

\\section{Background}

\\section{Research Questions}

\\section{Thesis Outline}
`,
      },
      {
        path: 'chapters/literature.tex',
        content: `\\chapter{Literature Review}
\\label{ch:literature}

Review of related work.
`,
      },
      {
        path: 'chapters/methodology.tex',
        content: `\\chapter{Methodology}
\\label{ch:methodology}

Describe your methodology here.
`,
      },
      {
        path: 'chapters/results.tex',
        content: `\\chapter{Results}
\\label{ch:results}

Present your results here.
`,
      },
      {
        path: 'chapters/conclusion.tex',
        content: `\\chapter{Conclusion}
\\label{ch:conclusion}

Summarise your findings here.
`,
      },
      {
        path: 'chapters/appendix.tex',
        content: `\\chapter{Appendix}
\\label{ch:appendix}

Additional material.
`,
      },
      {
        path: 'references.bib',
        content: '',
      },
    ],
  },
  {
    id: 'beamer',
    name: 'Presentation (Beamer)',
    description: 'Slide deck with Beamer',
    category: 'Presentation',
    files: [
      {
        path: 'main.tex',
        content: `\\documentclass{beamer}
\\usetheme{Madrid}
\\usecolortheme{default}

\\title{__TITLE__}
\\author{__AUTHOR__}
\\institute{}
\\date{\\today}

\\begin{document}

\\begin{frame}
  \\titlepage
\\end{frame}

\\begin{frame}{Outline}
  \\tableofcontents
\\end{frame}

\\section{Introduction}

\\begin{frame}{Introduction}
  \\begin{itemize}
    \\item First point
    \\item Second point
    \\item Third point
  \\end{itemize}
\\end{frame}

\\section{Main Content}

\\begin{frame}{Main Content}
  Your content here.
\\end{frame}

\\section{Conclusion}

\\begin{frame}{Conclusion}
  \\begin{itemize}
    \\item Summary point 1
    \\item Summary point 2
  \\end{itemize}
\\end{frame}

\\begin{frame}
  \\centering
  \\Huge Thank you!
\\end{frame}

\\end{document}
`,
      },
    ],
  },
  {
    id: 'letter',
    name: 'Letter',
    description: 'Formal letter',
    category: 'General',
    files: [
      {
        path: 'main.tex',
        content: `\\documentclass{letter}
\\usepackage[utf8]{inputenc}
\\usepackage[a4paper, margin=1in]{geometry}

\\signature{__AUTHOR__}
\\address{Your Address \\\\ City, Country}

\\begin{document}

\\begin{letter}{Recipient Name \\\\ Recipient Address \\\\ City, Country}

\\opening{Dear Sir or Madam,}

I am writing to you regarding...

\\closing{Yours faithfully,}

\\end{letter}

\\end{document}
`,
      },
    ],
  },
  {
    id: 'cv',
    name: 'CV / Resume',
    description: 'Simple curriculum vitae',
    category: 'General',
    files: [
      {
        path: 'main.tex',
        content: `\\documentclass[11pt, a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=0.8in]{geometry}
\\usepackage{enumitem}
\\usepackage{hyperref}
\\usepackage{titlesec}

\\titleformat{\\section}{\\large\\bfseries}{}{0em}{}[\\titlerule]
\\titlespacing{\\section}{0pt}{10pt}{6pt}

\\pagestyle{empty}

\\begin{document}

\\begin{center}
  {\\LARGE\\bfseries __AUTHOR__} \\\\[4pt]
  your.email@example.com \\quad | \\quad +00 000 000 0000 \\quad | \\quad City, Country
\\end{center}

\\section{Education}
\\textbf{University Name} \\hfill 2020 -- 2024 \\\\
Degree Title \\\\

\\section{Experience}
\\textbf{Job Title} --- Company Name \\hfill 2024 -- Present
\\begin{itemize}[nosep, leftmargin=*]
  \\item Responsibility or achievement
  \\item Another responsibility
\\end{itemize}

\\section{Skills}
\\textbf{Programming:} Python, JavaScript, LaTeX \\\\
\\textbf{Languages:} English (native), Other (fluent)

\\section{Publications}
Author, A. (2024). \\textit{Title of Paper}. Journal Name.

\\end{document}
`,
      },
    ],
  },
  {
    id: 'homework',
    name: 'Homework / Problem Set',
    description: 'Numbered problems with solutions',
    category: 'Academic',
    files: [
      {
        path: 'main.tex',
        content: `\\documentclass[11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath, amssymb}
\\usepackage{enumitem}

\\newcommand{\\problem}[1]{\\subsection*{Problem #1}}
\\newcommand{\\solution}{\\subsubsection*{Solution}}

\\title{__TITLE__}
\\author{__AUTHOR__}
\\date{\\today}

\\begin{document}

\\maketitle

\\problem{1}
State the problem here.

\\solution
Write your solution here.

\\problem{2}
Another problem.

\\solution
Another solution.

\\end{document}
`,
      },
    ],
  },
  {
    id: 'ieee',
    name: 'IEEE Conference Paper',
    description: 'Official IEEE bare conference template (IEEEtran)',
    category: 'Academic',
    files: [
      { path: 'main.tex', content: IEEEbareConf },
      { path: 'references.bib', content: '' },
      { path: 'IEEEtran.cls', content: IEEEtranCls },
      { path: 'IEEEtran.bst', content: IEEEtranBst },
    ],
  },
  {
    id: 'acm',
    name: 'ACM Conference Paper',
    description: 'Official ACM sigconf template (acmart)',
    category: 'Academic',
    files: [
      { path: 'main.tex', content: acmSampleSigconf },
      { path: 'references.bib', content: '' },
      { path: 'acmart.cls', content: acmartCls },
      { path: 'ACM-Reference-Format.bst', content: acmRefFormat },
    ],
  },
];

export default TEMPLATES;
