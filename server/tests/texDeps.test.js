import { describe, it, expect } from 'vitest';
import { resolveUsedFiles } from '../../shared/texDeps.js';

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
    expect(resolveUsedFiles(files, 'main.tex').has('main.tex')).toBe(true);
  });

  it('returns empty set when main file missing', () => {
    const files = makeFiles({ 'other.tex': 'Hello' });
    expect(resolveUsedFiles(files, 'main.tex').size).toBe(0);
  });

  it('resolves \\input without extension', () => {
    const files = makeFiles({
      'main.tex': '\\input{intro}',
      'intro.tex': 'Intro',
    });
    expect(resolveUsedFiles(files, 'main.tex').has('intro.tex')).toBe(true);
  });

  it('resolves \\includegraphics with extension probing', () => {
    const files = makeFiles({
      'main.tex': '\\includegraphics{fig}',
      'fig.png': null,
    });
    expect(resolveUsedFiles(files, 'main.tex').has('fig.png')).toBe(true);
  });

  it('resolves \\bibliography with .bib extension', () => {
    const files = makeFiles({
      'main.tex': '\\bibliography{refs}',
      'refs.bib': '',
    });
    expect(resolveUsedFiles(files, 'main.tex').has('refs.bib')).toBe(true);
  });

  it('resolves local .cls from \\documentclass', () => {
    const files = makeFiles({
      'main.tex': '\\documentclass{mythesis}',
      'mythesis.cls': '',
    });
    expect(resolveUsedFiles(files, 'main.tex').has('mythesis.cls')).toBe(true);
  });

  it('resolves transitive deps', () => {
    const files = makeFiles({
      'main.tex': '\\input{a}',
      'a.tex': '\\input{b}',
      'b.tex': 'end',
    });
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.has('a.tex')).toBe(true);
    expect(used.has('b.tex')).toBe(true);
  });

  it('handles cycles', () => {
    const files = makeFiles({
      'main.tex': '\\input{a}',
      'a.tex': '\\input{main}',
    });
    // Should not hang
    const used = resolveUsedFiles(files, 'main.tex');
    expect(used.size).toBe(2);
  });

  it('does not include unreferenced files', () => {
    const files = makeFiles({
      'main.tex': 'Hello',
      'orphan.tex': 'Unused',
    });
    expect(resolveUsedFiles(files, 'main.tex').size).toBe(1);
  });
});
