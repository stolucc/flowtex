import { describe, it, expect } from 'vitest';
import {
  findInsertionPointForPackage,
  hasPackage,
  buildUsepackageSnippet,
  applyAddUsepackage,
  findUsepackageRange,
  applyRemoveUsepackage,
  findPrecedingBegin,
  findEndAtLine,
  buildEnvRename,
  applyRenameEndEnv,
  looksLikeImagePath,
  splitPath,
  findGraphicspathCandidate,
  findExtensionSibling,
  applyAddGraphicspath,
  findIncludegraphicsAtLine,
  buildIncludegraphicsRename,
  applySwapImageExtension,
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

// ─── findUsepackageRange + applyRemoveUsepackage ──────────────────────

describe('findUsepackageRange', () => {
  it('returns the range of a bare \\usepackage{name} line including its trailing newline', () => {
    const src =
      '\\documentclass{article}\n' +
      '\\usepackage{amsmath}\n' +
      '\\usepackage{xcolor}\n' +
      '\\begin{document}';
    const r = findUsepackageRange(src, 'xcolor');
    expect(r).not.toBeNull();
    if (!r) return;
    // The range should remove the \usepackage{xcolor}\n exactly.
    expect(src.slice(r.from, r.to)).toBe('\\usepackage{xcolor}\n');
  });

  it('returns the range when the package is loaded with options', () => {
    const src = '\\documentclass{article}\n\\usepackage[table]{xcolor}\n\\begin{document}';
    const r = findUsepackageRange(src, 'xcolor');
    expect(r).not.toBeNull();
    if (!r) return;
    expect(src.slice(r.from, r.to)).toBe('\\usepackage[table]{xcolor}\n');
  });

  it('returns null when the package is not loaded', () => {
    expect(findUsepackageRange('\\documentclass{article}\n', 'xcolor')).toBeNull();
  });

  it('returns null (declines to mutate) when the package shares a brace with other packages', () => {
    // \usepackage{foo,bar,baz} -- picking out one without breaking the
    // line is annoying and rare; back off and let the user resolve it.
    const src = '\\usepackage{amsmath,xcolor,graphicx}\n';
    expect(findUsepackageRange(src, 'xcolor')).toBeNull();
  });
});

describe('applyRemoveUsepackage', () => {
  it('removes the line cleanly when the package is on its own line', () => {
    const src =
      '\\documentclass{article}\n' +
      '\\usepackage{amsmath}\n' +
      '\\usepackage{xcolor}\n' +
      '\\begin{document}';
    const r = applyRemoveUsepackage(src, 'xcolor');
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.newContent).toBe(
      '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}',
    );
    expect(r.removedText).toBe('\\usepackage{xcolor}');
  });

  it("returns reason 'not-found' when the package isn't there at all", () => {
    const r = applyRemoveUsepackage('\\documentclass{article}\n\\begin{document}', 'xcolor');
    expect(r.changed).toBe(false);
    if (r.changed) return;
    expect(r.reason).toBe('not-found');
  });

  it("returns reason 'grouped-with-other-packages' when the package is in a shared brace", () => {
    const r = applyRemoveUsepackage('\\usepackage{amsmath,xcolor}\n\\begin{document}', 'xcolor');
    expect(r.changed).toBe(false);
    if (r.changed) return;
    expect(r.reason).toBe('grouped-with-other-packages');
  });

  it("does not match a different package name (regression: prefix-collision safety)", () => {
    // Removing 'xcolor' must not knock out '\usepackage{xcolors}'.
    const src = '\\usepackage{xcolors}\n\\begin{document}';
    const r = applyRemoveUsepackage(src, 'xcolor');
    expect(r.changed).toBe(false);
    if (r.changed) return;
    expect(r.reason).toBe('not-found');
  });
});

// ─── Environment rename (auto-correct mismatched environments) ────────

describe('findPrecedingBegin', () => {
  it('returns the most recent \\begin{X} before the search offset', () => {
    const src = '\\begin{itemize}\nfoo\n\\begin{enumerate}\nbar\n\\end{enumerate}';
    const target = src.indexOf('\\end{enumerate}');
    const r = findPrecedingBegin(src, target);
    expect(r?.name).toBe('enumerate');
  });

  it('returns null when no \\begin appears before the offset', () => {
    expect(findPrecedingBegin('plain text', 5)).toBeNull();
  });

  it('handles starred environment names (align* / equation*)', () => {
    const src = '\\begin{align*}\nx = 1\n\\end{align}';
    const target = src.indexOf('\\end{align}');
    expect(findPrecedingBegin(src, target)?.name).toBe('align*');
  });
});

describe('findEndAtLine', () => {
  it('finds \\end{X} on the reported line', () => {
    const src = 'line 1\n\\begin{itemize}\n\\end{itemize}\nline 4';
    const r = findEndAtLine(src, 3, 'itemize');
    expect(r).not.toBeNull();
    if (!r) return;
    expect(src.slice(r.index, r.index + r.length)).toBe('\\end{itemize}');
  });

  it('tolerates the reported line being off-by-one or off-by-two', () => {
    // LaTeX sometimes reports an environment error a line or two early.
    const src = '\\begin{itemize}\n\n\n\\end{itemize}\nrest';
    expect(findEndAtLine(src, 1, 'itemize')).not.toBeNull();
    expect(findEndAtLine(src, 2, 'itemize')).not.toBeNull();
  });

  it('returns null if the \\end is not at-or-near the reported line', () => {
    const src = '\\begin{x}\n' + '\n'.repeat(20) + '\\end{x}';
    expect(findEndAtLine(src, 1, 'x')).toBeNull();
  });
});

describe('buildEnvRename', () => {
  it('replaces \\end{old} with \\end{new}, leaving surrounding text intact', () => {
    const src = 'a\\end{old}b';
    const endIdx = src.indexOf('\\end{old}');
    const endLen = '\\end{old}'.length;
    const r = buildEnvRename(src, endIdx, endLen, 'new');
    expect(r.newContent).toBe('a\\end{new}b');
    expect(r.replaceAt).toBe(endIdx);
    expect(r.replaceLength).toBe(endLen);
    expect(r.insertedText).toBe('\\end{new}');
  });
});

describe('applyRenameEndEnv', () => {
  it('renames \\end{enumerate} to \\end{itemize} when the matching begin is itemize', () => {
    const src = '\\begin{itemize}\n\\item a\n\\end{enumerate}\n';
    const r = applyRenameEndEnv(src, 'itemize', 'enumerate', 3);
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.newContent).toBe('\\begin{itemize}\n\\item a\n\\end{itemize}\n');
  });

  it("returns reason 'no-end-found' when the source's \\end is gone (stale log)", () => {
    const r = applyRenameEndEnv('\\begin{itemize}\n\\end{itemize}\n', 'itemize', 'enumerate', 3);
    expect(r.changed).toBe(false);
    if (r.changed) return;
    expect(r.reason).toBe('no-end-found');
  });

  it("returns reason 'no-begin-found' when no opening \\begin exists before the \\end", () => {
    const r = applyRenameEndEnv('\\end{itemize}\n', 'itemize', 'itemize', 1);
    expect(r.changed).toBe(false);
    if (r.changed) return;
    expect(r.reason).toBe('no-begin-found');
  });

  it('prefers the source\'s view of the matching \\begin over the log\'s `beginName` arg', () => {
    // If the user has \begin{enumerate} but the log called it \begin{itemize}
    // (stale or wrong), the rename uses the source's actual environment.
    const src = '\\begin{enumerate}\n\\end{itemize}\n';
    const r = applyRenameEndEnv(src, 'itemize', 'itemize', 2);
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.insertedText).toBe('\\end{enumerate}');
  });

  it('works without a line hint (scans globally for the first \\end{name})', () => {
    const r = applyRenameEndEnv('\\begin{itemize}\nx\n\\end{enumerate}', 'itemize', 'enumerate');
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.insertedText).toBe('\\end{itemize}');
  });
});

// ─── Image / graphicspath fixes (Batch B) ─────────────────────────────

describe('looksLikeImagePath', () => {
  it('is true for common image extensions', () => {
    expect(looksLikeImagePath('foo.png')).toBe(true);
    expect(looksLikeImagePath('foo.jpg')).toBe(true);
    expect(looksLikeImagePath('foo.jpeg')).toBe(true);
    expect(looksLikeImagePath('foo.pdf')).toBe(true);
    expect(looksLikeImagePath('foo.eps')).toBe(true);
    expect(looksLikeImagePath('foo.svg')).toBe(true);
  });

  it('is true for a no-extension path (typical of \\includegraphics{foo})', () => {
    expect(looksLikeImagePath('foo')).toBe(true);
    expect(looksLikeImagePath('figs/foo')).toBe(true);
  });

  it('is false for non-image extensions', () => {
    expect(looksLikeImagePath('chapter1.tex')).toBe(false);
    expect(looksLikeImagePath('refs.bib')).toBe(false);
    expect(looksLikeImagePath('mystyle.sty')).toBe(false);
  });

  it('handles a dot in a directory name correctly', () => {
    // The dot is in the directory, not the basename. Treated as
    // no-extension (image-like).
    expect(looksLikeImagePath('v1.2/foo')).toBe(true);
  });
});

describe('splitPath', () => {
  it('splits a path with directories', () => {
    expect(splitPath('figs/foo.png')).toEqual({ dir: 'figs/', base: 'foo.png' });
  });

  it('handles paths with no directory', () => {
    expect(splitPath('foo.png')).toEqual({ dir: '', base: 'foo.png' });
  });

  it('handles nested directories', () => {
    expect(splitPath('a/b/c/foo')).toEqual({ dir: 'a/b/c/', base: 'foo' });
  });

  it('handles backslash separators (Windows-style)', () => {
    expect(splitPath('figs\\foo.png')).toEqual({ dir: 'figs\\', base: 'foo.png' });
  });
});

describe('findGraphicspathCandidate', () => {
  const projectFiles = [
    { path: 'main.tex' },
    { path: 'figs/diagram.png' },
    { path: 'figs/intro.pdf' },
    { path: 'assets/logo.jpg' },
    { path: 'rootImage.png' }, // at root — would not suggest a graphicspath
  ];

  it('finds the directory of a same-stem file when the user referenced just the basename', () => {
    expect(findGraphicspathCandidate('diagram.png', projectFiles)).toBe('figs/');
  });

  it('finds the directory when the missing file has no extension', () => {
    // \includegraphics{diagram} -> LaTeX looks for diagram.png etc. and
    // reports "diagram" missing. We strip the extension on both sides.
    expect(findGraphicspathCandidate('diagram', projectFiles)).toBe('figs/');
  });

  it('returns null when no matching basename exists', () => {
    expect(findGraphicspathCandidate('nope.png', projectFiles)).toBeNull();
  });

  it('returns null when the only match is at the project root', () => {
    // rootImage.png is at the root -> \graphicspath wouldn't help.
    expect(findGraphicspathCandidate('rootImage.png', projectFiles)).toBeNull();
  });

  it('handles the user-referenced-with-directory case (figs/diagram.png)', () => {
    // If the user has \includegraphics{figs/diagram.png} but the file
    // is actually at assets/figs/diagram.png, we still match on the
    // basename and point at assets/figs/.
    const files = [{ path: 'assets/figs/diagram.png' }];
    expect(findGraphicspathCandidate('figs/diagram.png', files)).toBe('assets/figs/');
  });
});

describe('findExtensionSibling', () => {
  const projectFiles = [
    { path: 'figs/foo.svg' },
    { path: 'figs/foo.pdf' },
    { path: 'figs/foo.png' },
    { path: 'figs/bar.svg' },
    { path: 'other/bar.png' }, // not in same dir as bar.svg, ignored
  ];

  it('returns the same-dir sibling with the preferred extension', () => {
    // foo has .svg, .pdf, .png siblings -> prefer .pdf
    expect(findExtensionSibling('figs/foo.svg', projectFiles)).toBe('figs/foo.pdf');
  });

  it('returns null when no sibling exists in the same directory', () => {
    // bar has .svg in figs/ and .png in other/ -- the .png is in a
    // different directory, so swapping the extension on the source
    // wouldn't resolve unless graphicspath is set up. Conservative: null.
    expect(findExtensionSibling('figs/bar.svg', projectFiles)).toBeNull();
  });

  it('returns null when the filename has no extension to swap', () => {
    expect(findExtensionSibling('foo', projectFiles)).toBeNull();
  });

  it('handles a file at the project root', () => {
    const files = [{ path: 'foo.svg' }, { path: 'foo.pdf' }];
    expect(findExtensionSibling('foo.svg', files)).toBe('foo.pdf');
  });

  it('prefers .pdf > .png > .jpg in that order', () => {
    const files = [{ path: 'foo.jpg' }, { path: 'foo.png' }, { path: 'foo.pdf' }];
    expect(findExtensionSibling('foo.svg', files)).toBe('foo.pdf');
    const files2 = [{ path: 'foo.jpg' }, { path: 'foo.png' }];
    expect(findExtensionSibling('foo.svg', files2)).toBe('foo.png');
    const files3 = [{ path: 'foo.jpg' }];
    expect(findExtensionSibling('foo.svg', files3)).toBe('foo.jpg');
  });
});

describe('applyAddGraphicspath', () => {
  it('inserts \\graphicspath{{dir/}} after the last \\usepackage line', () => {
    const src =
      '\\documentclass{article}\n' +
      '\\usepackage{graphicx}\n' +
      '\\begin{document}';
    const r = applyAddGraphicspath(src, 'figs');
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.newContent).toBe(
      '\\documentclass{article}\n' +
      '\\usepackage{graphicx}\n' +
      '\\graphicspath{{figs/}}\n' +
      '\\begin{document}',
    );
  });

  it("normalises the directory (appends a trailing slash if missing)", () => {
    const r = applyAddGraphicspath('\\documentclass{article}\n', 'images');
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.newContent).toContain('\\graphicspath{{images/}}');
  });

  it("keeps a trailing slash the caller already supplied", () => {
    const r = applyAddGraphicspath('\\documentclass{article}\n', 'images/');
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    // Should not double up the slash.
    expect(r.newContent).toContain('\\graphicspath{{images/}}');
    expect(r.newContent).not.toContain('images//');
  });

  it("returns reason 'already-present' when \\graphicspath is already defined", () => {
    const src =
      '\\documentclass{article}\n' +
      '\\graphicspath{{old/}}\n' +
      '\\begin{document}';
    const r = applyAddGraphicspath(src, 'new');
    expect(r.changed).toBe(false);
    if (r.changed) return;
    expect(r.reason).toBe('already-present');
  });
});

describe('findIncludegraphicsAtLine', () => {
  it('locates the \\includegraphics token on the reported line', () => {
    const src = 'intro\n\\includegraphics{foo.png}\noutro';
    const r = findIncludegraphicsAtLine(src, 2);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.filename).toBe('foo.png');
    expect(src.slice(r.from, r.to)).toBe('\\includegraphics{foo.png}');
  });

  it('captures options inside [opts]', () => {
    const src = '\\includegraphics[width=0.5\\textwidth]{img.pdf}';
    const r = findIncludegraphicsAtLine(src, 1);
    expect(r?.filename).toBe('img.pdf');
    expect(src.slice(r?.from ?? 0, r?.to ?? 0)).toBe(src);
  });

  it('tolerates the reported line being off by 1-2 lines', () => {
    const src = '\\begin{figure}\n\\includegraphics{foo}\n\\end{figure}';
    // The error might be reported at line 1 (the \begin) or line 3
    // (the \end); both should still find the token.
    expect(findIncludegraphicsAtLine(src, 1)?.filename).toBe('foo');
    expect(findIncludegraphicsAtLine(src, 3)?.filename).toBe('foo');
  });

  it('returns null when no \\includegraphics is near the line', () => {
    const src = 'no images here\njust text';
    expect(findIncludegraphicsAtLine(src, 1)).toBeNull();
  });
});

describe('buildIncludegraphicsRename', () => {
  it('rewrites the filename, preserving [opts]', () => {
    const src = 'before \\includegraphics[width=0.5\\textwidth]{old.svg} after';
    const r = buildIncludegraphicsRename(
      src,
      { from: src.indexOf('\\includegraphics'), to: src.indexOf(' after') },
      'new.pdf',
    );
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.newContent).toContain('\\includegraphics[width=0.5\\textwidth]{new.pdf}');
    expect(r.newContent).not.toContain('old.svg');
  });

  it('returns changed=false when the range does not actually contain an \\includegraphics token', () => {
    const src = 'plain text here';
    const r = buildIncludegraphicsRename(src, { from: 0, to: src.length }, 'x.pdf');
    expect(r.changed).toBe(false);
  });
});

describe('applySwapImageExtension', () => {
  const projectFiles = [
    { path: 'figs/diagram.svg' },
    { path: 'figs/diagram.pdf' },
    { path: 'other/thing.png' },
  ];

  it('swaps .svg to .pdf when a sibling exists in the project', () => {
    const src = '\\begin{figure}\n\\includegraphics{figs/diagram.svg}\n\\end{figure}';
    const r = applySwapImageExtension(src, 2, 'figs/diagram.svg', projectFiles);
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.insertedText).toContain('figs/diagram.pdf');
    expect(r.newExtension).toBe('.pdf');
  });

  it("returns 'no-sibling' when no preferred sibling exists in the project", () => {
    const src = '\\includegraphics{figs/orphan.svg}';
    const r = applySwapImageExtension(src, 1, 'figs/orphan.svg', projectFiles);
    expect(r.changed).toBe(false);
    if (r.changed) return;
    expect(r.reason).toBe('no-sibling');
  });

  it("returns 'no-token' when the active file has no \\includegraphics near the line", () => {
    const src = 'just text';
    const r = applySwapImageExtension(src, 1, 'figs/diagram.svg', projectFiles);
    expect(r.changed).toBe(false);
    if (r.changed) return;
    expect(r.reason).toBe('no-token');
  });

  it("returns 'name-mismatch' when the line's \\includegraphics refers to a different file", () => {
    const src = '\\includegraphics{figs/unrelated.svg}';
    const r = applySwapImageExtension(src, 1, 'figs/diagram.svg', projectFiles);
    expect(r.changed).toBe(false);
    if (r.changed) return;
    expect(r.reason).toBe('name-mismatch');
  });

  it('matches when the source has no extension and the bad name has one (LaTeX appended)', () => {
    // \includegraphics{figs/diagram} -> LaTeX tried figs/diagram.svg
    // and couldn't size it. We should still swap to figs/diagram.pdf.
    const src = '\\includegraphics{figs/diagram}';
    const r = applySwapImageExtension(src, 1, 'figs/diagram.svg', projectFiles);
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.insertedText).toContain('figs/diagram.pdf');
  });
});
