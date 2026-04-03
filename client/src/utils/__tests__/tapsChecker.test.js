import { describe, it, expect } from 'vitest';
import tapsCheck from '../tapsChecker.js';

function makeFiles(filesObj) {
  return Object.entries(filesObj).map(([path, content]) => ({ path, content, is_binary: false }));
}

describe('tapsCheck', () => {
  it('returns no diagnostics for approved packages', () => {
    const files = makeFiles({
      'main.tex': String.raw`\documentclass{article}
\usepackage{amsmath}
\usepackage{graphicx}
\usepackage{hyperref}
\begin{document}
Hello
\end{document}`,
    });
    expect(tapsCheck(files, 'main.tex')).toEqual([]);
  });

  it('flags unapproved packages', () => {
    const files = makeFiles({
      'main.tex': String.raw`\documentclass{article}
\usepackage{tikz}
\begin{document}
Hello
\end{document}`,
    });
    const diags = tapsCheck(files, 'main.tex');
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      file: 'main.tex',
      severity: 'error',
    });
    expect(diags[0].message).toContain('tikz');
  });

  it('handles multiple packages in one \\usepackage', () => {
    const files = makeFiles({
      'main.tex': String.raw`\usepackage{amsmath,tikz,pgfplots}`,
    });
    const diags = tapsCheck(files, 'main.tex');
    // amsmath is approved, tikz and pgfplots are not
    expect(diags).toHaveLength(2);
    expect(diags.map((d) => d.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('tikz'), expect.stringContaining('pgfplots')]),
    );
  });

  it('allows acmart internal packages', () => {
    const files = makeFiles({
      'main.tex': String.raw`\usepackage{xparse}
\usepackage{etoolbox}
\usepackage{booktabs}`,
    });
    expect(tapsCheck(files, 'main.tex')).toEqual([]);
  });

  it('ignores commented-out usepackage lines', () => {
    const files = makeFiles({
      'main.tex': String.raw`% \usepackage{tikz}
\usepackage{amsmath}`,
    });
    expect(tapsCheck(files, 'main.tex')).toEqual([]);
  });

  it('only checks files reachable from main', () => {
    const files = makeFiles({
      'main.tex': String.raw`\documentclass{article}
\begin{document}
Hello
\end{document}`,
      'unused.tex': String.raw`\usepackage{tikz}`,
    });
    // unused.tex is not referenced from main.tex
    expect(tapsCheck(files, 'main.tex')).toEqual([]);
  });

  it('checks files referenced via \\input', () => {
    const files = makeFiles({
      'main.tex': String.raw`\documentclass{article}
\input{preamble}
\begin{document}
Hello
\end{document}`,
      'preamble.tex': String.raw`\usepackage{tikz}`,
    });
    const diags = tapsCheck(files, 'main.tex');
    expect(diags).toHaveLength(1);
    expect(diags[0].file).toBe('preamble.tex');
  });

  it('handles usepackage with options', () => {
    const files = makeFiles({
      'main.tex': String.raw`\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}`,
    });
    expect(tapsCheck(files, 'main.tex')).toEqual([]);
  });

  it('returns empty for empty file list', () => {
    expect(tapsCheck([], 'main.tex')).toEqual([]);
  });

  it('handles .sty files in dependency chain', () => {
    const files = makeFiles({
      'main.tex': String.raw`\usepackage{custom}`,
      'custom.sty': String.raw`\usepackage{tikz}`,
    });
    const diags = tapsCheck(files, 'main.tex');
    // "custom" is flagged on main.tex (not on approved list), and "tikz" on custom.sty
    expect(diags).toHaveLength(2);
    expect(diags.some((d) => d.file === 'main.tex' && d.message.includes('custom'))).toBe(true);
    expect(diags.some((d) => d.file === 'custom.sty' && d.message.includes('tikz'))).toBe(true);
  });
});
