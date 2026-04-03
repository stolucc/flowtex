import { describe, it, expect } from 'vitest';
import { resolveUsedFiles } from '@shared/texDeps.js';

function makeFiles(filesObj) {
  return Object.entries(filesObj).map(([path, content]) => ({
    path,
    content: typeof content === 'string' ? content : '',
    is_binary: typeof content !== 'string',
  }));
}

describe('resolveUsedFiles', () => {
  it('includes the main file', () => {
    const files = makeFiles({ 'main.tex': 'Hello' });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('main.tex')).toBe(true);
  });

  it('returns empty set when main file does not exist', () => {
    const files = makeFiles({ 'other.tex': 'Hello' });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.size).toBe(0);
  });

  it('resolves \\input without .tex extension', () => {
    const files = makeFiles({
      'main.tex': String.raw`\input{intro}`,
      'intro.tex': 'Introduction',
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('intro.tex')).toBe(true);
  });

  it('resolves \\input with .tex extension', () => {
    const files = makeFiles({
      'main.tex': String.raw`\input{intro.tex}`,
      'intro.tex': 'Introduction',
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('intro.tex')).toBe(true);
  });

  it('resolves \\include', () => {
    const files = makeFiles({
      'main.tex': String.raw`\include{chapter1}`,
      'chapter1.tex': 'Chapter 1',
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('chapter1.tex')).toBe(true);
  });

  it('resolves \\subfile', () => {
    const files = makeFiles({
      'main.tex': String.raw`\subfile{sections/intro}`,
      'sections/intro.tex': 'Intro',
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('sections/intro.tex')).toBe(true);
  });

  it('resolves \\includegraphics with extension', () => {
    const files = makeFiles({
      'main.tex': String.raw`\includegraphics{fig1.png}`,
      'fig1.png': null, // binary
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('fig1.png')).toBe(true);
  });

  it('resolves \\includegraphics without extension', () => {
    const files = makeFiles({
      'main.tex': String.raw`\includegraphics{fig1}`,
      'fig1.pdf': null,
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('fig1.pdf')).toBe(true);
  });

  it('resolves \\includegraphics with options', () => {
    const files = makeFiles({
      'main.tex': String.raw`\includegraphics[width=0.5\textwidth]{diagram}`,
      'diagram.png': null,
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('diagram.png')).toBe(true);
  });

  it('resolves \\bibliography', () => {
    const files = makeFiles({
      'main.tex': String.raw`\bibliography{refs}`,
      'refs.bib': '@article{key, title={T}}',
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('refs.bib')).toBe(true);
  });

  it('resolves comma-separated \\bibliography', () => {
    const files = makeFiles({
      'main.tex': String.raw`\bibliography{refs,extra}`,
      'refs.bib': '',
      'extra.bib': '',
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('refs.bib')).toBe(true);
    expect(used.has('extra.bib')).toBe(true);
  });

  it('resolves \\addbibresource', () => {
    const files = makeFiles({
      'main.tex': String.raw`\addbibresource{refs.bib}`,
      'refs.bib': '',
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('refs.bib')).toBe(true);
  });

  it('resolves \\bibliographystyle to local .bst', () => {
    const files = makeFiles({
      'main.tex': String.raw`\bibliographystyle{custom}`,
      'custom.bst': '',
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('custom.bst')).toBe(true);
  });

  it('resolves local \\usepackage .sty files', () => {
    const files = makeFiles({
      'main.tex': String.raw`\usepackage{custom}`,
      'custom.sty': '',
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('custom.sty')).toBe(true);
  });

  it('resolves local \\documentclass .cls files', () => {
    const files = makeFiles({
      'main.tex': String.raw`\documentclass{mythesis}`,
      'mythesis.cls': '',
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('mythesis.cls')).toBe(true);
  });

  it('resolves transitive dependencies', () => {
    const files = makeFiles({
      'main.tex': String.raw`\input{a}`,
      'a.tex': String.raw`\input{b}`,
      'b.tex': String.raw`\input{c}`,
      'c.tex': 'content',
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('a.tex')).toBe(true);
    expect(used.has('b.tex')).toBe(true);
    expect(used.has('c.tex')).toBe(true);
  });

  it('handles circular dependencies without infinite loop', () => {
    const files = makeFiles({
      'main.tex': String.raw`\input{a}`,
      'a.tex': String.raw`\input{main}`,
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('main.tex')).toBe(true);
    expect(used.has('a.tex')).toBe(true);
  });

  it('does not include unreferenced files', () => {
    const files = makeFiles({
      'main.tex': 'Hello',
      'unused.tex': 'Not used',
      'also_unused.bib': '',
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.size).toBe(1);
    expect(used.has('main.tex')).toBe(true);
  });

  it('skips binary files for content scanning', () => {
    const files = makeFiles({
      'main.tex': String.raw`\includegraphics{fig.png}`,
      'fig.png': null, // binary — should not be scanned for \input etc.
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('fig.png')).toBe(true);
    expect(used.size).toBe(2);
  });

  it('resolves \\makeindex files', () => {
    const files = makeFiles({
      'main.tex': String.raw`\makeindex`,
      'main.ist': '',
      'main.idx': '',
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('main.ist')).toBe(true);
    expect(used.has('main.idx')).toBe(true);
  });
});
