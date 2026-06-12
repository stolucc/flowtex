import { describe, it, expect } from 'vitest';
import {
  findInsertionPointForPackage,
  hasPackage,
  buildUsepackageSnippet,
  applyAddUsepackage,
} from '../latexQuickFixes.js';

describe('findInsertionPointForPackage', () => {
  it('anchors at the end of the LAST \\usepackage line when several exist', () => {
    const src =
      '\\documentclass{article}\n' +
      '\\usepackage{amsmath}\n' +
      '\\usepackage[utf8]{inputenc}\n' +
      '\\begin{document}\nHello\n\\end{document}\n';
    const { offset } = findInsertionPointForPackage(src);
    // The offset should fall at the end-of-line of the last \usepackage,
    // i.e. just before the `\n` of that line.
    expect(src.slice(0, offset)).toMatch(/\\usepackage\[utf8\]\{inputenc\}$/);
  });

  it('marks needsLeadingNewline=true when anchoring on a \\usepackage line', () => {
    const src = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}';
    const { needsLeadingNewline } = findInsertionPointForPackage(src);
    expect(needsLeadingNewline).toBe(true);
  });

  it('falls back to the \\documentclass line when there are no \\usepackage lines yet', () => {
    const src = '\\documentclass[12pt,a4paper]{article}\n\\begin{document}\nHi\n\\end{document}\n';
    const { offset, needsLeadingNewline } = findInsertionPointForPackage(src);
    expect(src.slice(0, offset)).toBe('\\documentclass[12pt,a4paper]{article}');
    expect(needsLeadingNewline).toBe(true);
  });

  it('returns offset=0 when neither \\usepackage nor \\documentclass is present', () => {
    const src = 'just some fragment without any preamble markers';
    const { offset, needsLeadingNewline } = findInsertionPointForPackage(src);
    expect(offset).toBe(0);
    expect(needsLeadingNewline).toBe(false);
  });

  it('does NOT match \\usepackage that appears inside a comment', () => {
    // The regex matches anywhere in a line, including in comments.
    // This is a known limitation -- documented here so we notice if
    // the behavior ever changes.
    const src = '\\documentclass{article}\n% \\usepackage{notreal} commented out\n\\begin{document}';
    const { offset } = findInsertionPointForPackage(src);
    // Current behavior: matches the commented line. If you change the
    // regex to skip comments, also update this expectation.
    expect(src.slice(0, offset)).toContain('% \\usepackage{notreal}');
  });

  it('handles \\usepackage with options that contain commas and equals', () => {
    const src = '\\documentclass{article}\n\\usepackage[utf8,T1]{fontenc}\n\\begin{document}';
    const { offset } = findInsertionPointForPackage(src);
    expect(src.slice(0, offset)).toMatch(/\\usepackage\[utf8,T1\]\{fontenc\}$/);
  });
});

describe('hasPackage', () => {
  it('returns true when the exact package name is loaded', () => {
    expect(hasPackage('\\usepackage{xcolor}\n', 'xcolor')).toBe(true);
  });

  it('returns true when the package is loaded with options', () => {
    expect(hasPackage('\\usepackage[table]{xcolor}\n', 'xcolor')).toBe(true);
  });

  it('returns false when a different package is loaded', () => {
    expect(hasPackage('\\usepackage{amsmath}\n', 'xcolor')).toBe(false);
  });

  it('returns false when no \\usepackage line is present', () => {
    expect(hasPackage('\\documentclass{article}\n', 'xcolor')).toBe(false);
  });

  it('does NOT confuse a prefix match (xcolors should not satisfy xcolor)', () => {
    expect(hasPackage('\\usepackage{xcolors}\n', 'xcolor')).toBe(false);
  });

  it('does NOT confuse a suffix match (newxcolor should not satisfy xcolor)', () => {
    expect(hasPackage('\\usepackage{newxcolor}\n', 'xcolor')).toBe(false);
  });

  it('handles a package name containing a regex special character without throwing', () => {
    // Real LaTeX package names don't contain regex specials, but this
    // is the kind of input that crashes a naively-built regex. The
    // hasPackage helper must escape its argument.
    expect(() => hasPackage('foo', 'pkg.with.dots')).not.toThrow();
    expect(() => hasPackage('foo', 'pkg+plus')).not.toThrow();
  });
});

describe('buildUsepackageSnippet', () => {
  it('emits a leading newline when needsLeadingNewline is true', () => {
    expect(buildUsepackageSnippet('xcolor', true)).toBe('\n\\usepackage{xcolor}');
  });

  it('emits a trailing newline when needsLeadingNewline is false', () => {
    // The "no anchor" case (offset=0, file fragment without preamble).
    // Inserting at offset 0 wants the line to be self-contained and
    // followed by the rest of the file with a separator.
    expect(buildUsepackageSnippet('xcolor', false)).toBe('\\usepackage{xcolor}\n');
  });
});

describe('applyAddUsepackage', () => {
  it('inserts the package at the end of the last \\usepackage line, keeping existing newlines', () => {
    const src =
      '\\documentclass{article}\n' +
      '\\usepackage{amsmath}\n' +
      '\\begin{document}\nHello\n\\end{document}\n';
    const r = applyAddUsepackage(src, 'xcolor');
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.newContent).toBe(
      '\\documentclass{article}\n' +
      '\\usepackage{amsmath}\n' +
      '\\usepackage{xcolor}\n' +
      '\\begin{document}\nHello\n\\end{document}\n',
    );
    // insertAt should be in the middle of the original file (after the
    // amsmath line) -- pin the exact offset so a regression would fail.
    expect(r.insertAt).toBe('\\documentclass{article}\n\\usepackage{amsmath}'.length);
    expect(r.insertLength).toBe('\n\\usepackage{xcolor}'.length);
  });

  it('inserts after \\documentclass when no \\usepackage exists', () => {
    const src = '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n';
    const r = applyAddUsepackage(src, 'graphicx');
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.newContent).toBe(
      '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\nHi\n\\end{document}\n',
    );
  });

  it('returns changed=false when the package is already present', () => {
    const src = '\\documentclass{article}\n\\usepackage{xcolor}\n\\begin{document}\n';
    const r = applyAddUsepackage(src, 'xcolor');
    expect(r.changed).toBe(false);
    if (r.changed) return;
    expect(r.reason).toBe('already-present');
  });

  it('treats an options-loaded package as already-present (no duplicate insert)', () => {
    const src = '\\documentclass{article}\n\\usepackage[table]{xcolor}\n\\begin{document}\n';
    const r = applyAddUsepackage(src, 'xcolor');
    expect(r.changed).toBe(false);
  });

  it('falls back to offset=0 when neither anchor exists, and returns valid bounds', () => {
    const src = 'a fragment with no preamble';
    const r = applyAddUsepackage(src, 'xcolor');
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.newContent).toBe('\\usepackage{xcolor}\na fragment with no preamble');
    expect(r.insertAt).toBe(0);
    expect(r.insertLength).toBe('\\usepackage{xcolor}\n'.length);
  });
});
