import { describe, it, expect } from 'vitest';
import { parseOutline, parseDocumentOutline } from '../latexOutline.js';

describe('parseOutline', () => {
  it('returns [] for empty / non-string input', () => {
    expect(parseOutline('')).toEqual([]);
    expect(parseOutline(null)).toEqual([]);
    expect(parseOutline(undefined)).toEqual([]);
    expect(parseOutline(42)).toEqual([]);
  });

  it('extracts standard sectioning commands with 1-indexed lines', () => {
    const src = [
      '\\documentclass{article}',
      '\\begin{document}',
      '\\section{Intro}',
      '\\subsection{Background}',
      '\\subsubsection{Prior work}',
      'Plain text.',
      '\\section{Method}',
      '\\end{document}',
    ].join('\n');
    expect(parseOutline(src)).toEqual([
      { level: 2, label: 'section', title: 'Intro', line: 3 },
      { level: 3, label: 'subsection', title: 'Background', line: 4 },
      { level: 4, label: 'subsubsection', title: 'Prior work', line: 5 },
      { level: 2, label: 'section', title: 'Method', line: 7 },
    ]);
  });

  it('handles part / chapter / paragraph / subparagraph', () => {
    const src = [
      '\\part{Foundations}',
      '\\chapter{Sets}',
      '\\paragraph{Note}',
      '\\subparagraph{Aside}',
    ].join('\n');
    const out = parseOutline(src);
    expect(out.map((e) => [e.label, e.level])).toEqual([
      ['part', 0],
      ['chapter', 1],
      ['paragraph', 5],
      ['subparagraph', 6],
    ]);
  });

  it('accepts the starred (unnumbered) form', () => {
    expect(parseOutline('\\section*{Acknowledgements}')).toEqual([
      { level: 2, label: 'section', title: 'Acknowledgements', line: 1 },
    ]);
  });

  it('accepts the optional short-title in brackets', () => {
    expect(parseOutline('\\section[Short]{Long title here}')).toEqual([
      { level: 2, label: 'section', title: 'Long title here', line: 1 },
    ]);
  });

  it('strips simple inline macros in the title', () => {
    expect(parseOutline('\\section{Hello \\texttt{world}}')[0].title).toBe('Hello world');
    expect(parseOutline('\\subsection{\\emph{Italics} matter}')[0].title).toBe('Italics matter');
  });

  it('falls back to "(empty section)" for an empty title', () => {
    expect(parseOutline('\\section{}')[0].title).toBe('(empty section)');
  });

  it('ignores sectioning commands that appear in line comments', () => {
    const src = [
      '% \\section{Hidden}',
      '   % \\subsection{Also hidden}',
      '\\section{Visible}',
    ].join('\n');
    expect(parseOutline(src)).toEqual([
      { level: 2, label: 'section', title: 'Visible', line: 3 },
    ]);
  });

  it('ignores \\section inside another macro body (not anchored to line start)', () => {
    // \texttt{\section{x}} is anchored mid-line; we only match at the
    // start of a line (after optional whitespace). Confirms this.
    expect(parseOutline('\\texttt{\\section{should not match}}')).toEqual([]);
  });

  it('handles one level of brace nesting in the title', () => {
    expect(parseOutline('\\section{Group {A} results}')[0].title).toBe('Group {A} results');
  });

  it('preserves source order across mixed levels', () => {
    const src = '\\section{A}\n\\chapter{B}\n\\subsection{C}';
    expect(parseOutline(src).map((e) => e.label)).toEqual(['section', 'chapter', 'subsection']);
  });
});

describe('parseDocumentOutline', () => {
  const tex = (path, content) => ({ path, content, is_binary: false });

  it('returns [] when there are no .tex files', () => {
    expect(parseDocumentOutline([], 'main.tex')).toEqual([]);
    expect(parseDocumentOutline([{ path: 'a.png', is_binary: true, content: '' }], 'main.tex')).toEqual([]);
  });

  it('returns sections from the main file when no inputs', () => {
    const files = [tex('main.tex', '\\section{Hello}\n\\subsection{Sub}')];
    const out = parseDocumentOutline(files, 'main.tex');
    expect(out.map((e) => [e.label, e.path, e.line])).toEqual([
      ['section', 'main.tex', 1],
      ['subsection', 'main.tex', 2],
    ]);
  });

  it('walks \\input across files and interleaves entries in source order', () => {
    const files = [
      tex('main.tex', '\\section{Intro}\n\\input{chap1}\n\\section{End}'),
      tex('chap1.tex', '\\subsection{Detail A}\n\\subsection{Detail B}'),
    ];
    const out = parseDocumentOutline(files, 'main.tex');
    expect(out.map((e) => [e.label, e.path, e.title])).toEqual([
      ['section', 'main.tex', 'Intro'],
      ['subsection', 'chap1.tex', 'Detail A'],
      ['subsection', 'chap1.tex', 'Detail B'],
      ['section', 'main.tex', 'End'],
    ]);
  });

  it('resolves \\input both with and without .tex extension', () => {
    const files = [
      tex('main.tex', '\\input{chap}'),
      tex('chap.tex', '\\section{From chap}'),
    ];
    expect(parseDocumentOutline(files, 'main.tex').map((e) => e.title)).toEqual(['From chap']);
  });

  it('resolves \\input relative to the including file', () => {
    const files = [
      tex('main.tex', '\\input{parts/intro}'),
      tex('parts/intro.tex', '\\section{Intro}\n\\input{detail}'),
      tex('parts/detail.tex', '\\subsection{Detail}'),
    ];
    expect(parseDocumentOutline(files, 'main.tex').map((e) => [e.path, e.title])).toEqual([
      ['parts/intro.tex', 'Intro'],
      ['parts/detail.tex', 'Detail'],
    ]);
  });

  it('handles \\include like \\input', () => {
    const files = [
      tex('main.tex', '\\include{chap1}'),
      tex('chap1.tex', '\\section{From include}'),
    ];
    expect(parseDocumentOutline(files, 'main.tex').map((e) => e.title)).toEqual(['From include']);
  });

  it('terminates on input cycles (visited bound)', () => {
    const files = [
      tex('a.tex', '\\section{A}\n\\input{b}'),
      tex('b.tex', '\\section{B}\n\\input{a}'),
    ];
    expect(parseDocumentOutline(files, 'a.tex').map((e) => e.title)).toEqual(['A', 'B']);
  });

  it('falls back to main.tex when given an unknown mainFilePath', () => {
    const files = [tex('main.tex', '\\section{Main}')];
    expect(parseDocumentOutline(files, 'nonexistent.tex').map((e) => e.title)).toEqual(['Main']);
  });

  it('falls back to the first .tex if main.tex is also missing', () => {
    const files = [tex('paper.tex', '\\section{Paper}')];
    expect(parseDocumentOutline(files, null).map((e) => e.title)).toEqual(['Paper']);
  });

  it('skips inputs that do not resolve to a project file (system / missing)', () => {
    const files = [
      tex('main.tex', '\\input{external}\n\\section{Still here}'),
    ];
    expect(parseDocumentOutline(files, 'main.tex').map((e) => e.title)).toEqual(['Still here']);
  });
});
