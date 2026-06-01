import { describe, it, expect } from 'vitest';
import { parseOutline } from '../latexOutline.js';

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
