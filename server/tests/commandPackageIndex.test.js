import { describe, it, expect } from 'vitest';
import {
  extractCommandsFromStyContent,
  extractInputs,
  styPathToPackageName,
  pickPreferredPackage,
  buildIndexFromFileContents,
} from '../services/commandPackageIndex.js';

describe('extractCommandsFromStyContent', () => {
  it('captures \\newcommand{\\X}{...} and \\newcommand\\X{...} shapes', () => {
    const src = `
\\newcommand{\\foo}{bar}
\\newcommand\\baz{qux}
`;
    const cmds = extractCommandsFromStyContent(src);
    expect(cmds.has('foo')).toBe(true);
    expect(cmds.has('baz')).toBe(true);
  });

  it('captures \\renewcommand and \\providecommand', () => {
    const src = `\\renewcommand{\\alpha}{a}\n\\providecommand{\\beta}{b}\n`;
    const cmds = extractCommandsFromStyContent(src);
    expect(cmds.has('alpha')).toBe(true);
    expect(cmds.has('beta')).toBe(true);
  });

  it('captures \\NewDocumentCommand{\\X} (xparse / LaTeX3)', () => {
    const src = `\\NewDocumentCommand{\\cref}{m}{\\@cref{cref}{#1}}`;
    expect(extractCommandsFromStyContent(src).has('cref')).toBe(true);
  });

  it('captures \\DeclareRobustCommand', () => {
    const src = `\\DeclareRobustCommand{\\emph}[1]{\\textit{#1}}`;
    expect(extractCommandsFromStyContent(src).has('emph')).toBe(true);
  });

  it('captures \\def\\X plain-TeX style', () => {
    const src = `\\def\\foo#1{...}\n\\long\\def\\bar{...}\n\\global\\def\\baz{...}\n`;
    const cmds = extractCommandsFromStyContent(src);
    expect(cmds.has('foo')).toBe(true);
    expect(cmds.has('bar')).toBe(true);
    expect(cmds.has('baz')).toBe(true);
  });

  it('captures \\let\\X = \\Y or \\let\\X\\Y', () => {
    const src = `\\let\\alpha=\\beta\n\\let\\gamma\\delta\n`;
    const cmds = extractCommandsFromStyContent(src);
    expect(cmds.has('alpha')).toBe(true);
    expect(cmds.has('gamma')).toBe(true);
  });

  it('captures \\newenvironment{name}', () => {
    const src = `\\newenvironment{mybox}{...}{...}`;
    expect(extractCommandsFromStyContent(src).has('mybox')).toBe(true);
  });

  it('IGNORES definitions inside comments', () => {
    const src = `% \\newcommand{\\notreal}{xxx}
\\newcommand{\\real}{yyy}`;
    const cmds = extractCommandsFromStyContent(src);
    expect(cmds.has('notreal')).toBe(false);
    expect(cmds.has('real')).toBe(true);
  });

  it('keeps definitions after an escaped percent', () => {
    // `\%` is a literal percent sign in LaTeX, NOT the start of a comment.
    const src = `% Real comment\n\\\\% literal percent then \\newcommand{\\valid}{x}\n`;
    expect(extractCommandsFromStyContent(src).has('valid')).toBe(true);
  });

  it('skips single-character internal names (e.g. \\@, \\i)', () => {
    const src = `\\newcommand{\\a}{x}\n\\newcommand{\\foo}{y}`;
    const cmds = extractCommandsFromStyContent(src);
    expect(cmds.has('a')).toBe(false);
    expect(cmds.has('foo')).toBe(true);
  });

  it('skips LaTeX-internal @-prefixed names (already only matches \\w+)', () => {
    // \w doesn't match @, so \@foo wouldn't be captured anyway.
    const src = `\\def\\@internal{x}`;
    expect(extractCommandsFromStyContent(src).has('@internal')).toBe(false);
  });
});

describe('styPathToPackageName', () => {
  it('strips the .sty extension and directory', () => {
    expect(styPathToPackageName('/usr/share/texmf-dist/tex/latex/cleveref/cleveref.sty')).toBe('cleveref');
    expect(styPathToPackageName('cleveref.sty')).toBe('cleveref');
  });

  it('handles uppercase .STY (case-insensitive)', () => {
    expect(styPathToPackageName('FOO.STY')).toBe('FOO');
  });

  it('does not strip .sty if it appears in the middle of the basename', () => {
    expect(styPathToPackageName('mystylepkg.sty')).toBe('mystylepkg');
  });
});

describe('pickPreferredPackage', () => {
  it('returns the single candidate verbatim', () => {
    expect(pickPreferredPackage('foo', new Set(['onlypkg']))).toBe('onlypkg');
  });

  it('prefers a package whose name shares a prefix with the command', () => {
    // \tikzset is defined in tikz; not in some unrelated pkg also using
    // a tikzset command. Prefer the prefix match.
    expect(pickPreferredPackage('tikzset', new Set(['tikz', 'unrelated']))).toBe('tikz');
  });

  it('demotes packages with implementation-suffix names', () => {
    expect(pickPreferredPackage('foo', new Set(['amsmath', 'amsmath-tools']))).toBe('amsmath');
    expect(pickPreferredPackage('foo', new Set(['x-internal', 'amsmath']))).toBe('amsmath');
    expect(pickPreferredPackage('foo', new Set(['caption', 'caption-kernel']))).toBe('caption');
  });

  it('tie-breaks on shorter name when neither prefix nor demote applies', () => {
    expect(pickPreferredPackage('foo', new Set(['x', 'xx', 'xxx']))).toBe('x');
  });
});

describe('buildIndexFromFileContents', () => {
  it('builds a Map<cmd, pkg> from .sty file records', () => {
    const files = [
      {
        path: '/share/cleveref/cleveref.sty',
        content: `\\newcommand{\\cref}{...}\n\\newcommand{\\Cref}{...}`,
      },
      {
        path: '/share/amsmath/amsmath.sty',
        content: `\\newcommand{\\dfrac}{...}\n\\newcommand{\\binom}{...}`,
      },
    ];
    const idx = buildIndexFromFileContents(files);
    expect(idx.get('cref')).toBe('cleveref');
    expect(idx.get('Cref')).toBe('cleveref');
    expect(idx.get('dfrac')).toBe('amsmath');
    expect(idx.get('binom')).toBe('amsmath');
  });

  it('uses pickPreferredPackage to break multi-definer ties', () => {
    // Same command defined in two packages. The kernel-suffix one should
    // be demoted in favour of the plain name.
    const files = [
      { path: '/x/foo.sty', content: `\\newcommand{\\bar}{...}` },
      { path: '/x/foo-kernel.sty', content: `\\newcommand{\\bar}{...}` },
    ];
    expect(buildIndexFromFileContents(files).get('bar')).toBe('foo');
  });

  it('captures multiple definition styles in the same file', () => {
    const files = [
      {
        path: '/x/multi.sty',
        content: `\\newcommand{\\one}{1}
\\renewcommand\\two{2}
\\DeclareRobustCommand{\\three}{3}
\\def\\four{4}
\\NewDocumentCommand{\\five}{m}{#1}`,
      },
    ];
    const idx = buildIndexFromFileContents(files);
    expect(idx.get('one')).toBe('multi');
    expect(idx.get('two')).toBe('multi');
    expect(idx.get('three')).toBe('multi');
    expect(idx.get('four')).toBe('multi');
    expect(idx.get('five')).toBe('multi');
  });

  it('produces an empty map for an empty input', () => {
    expect(buildIndexFromFileContents([])).toEqual(new Map());
  });

  it('skips commands defined only inside comments', () => {
    const files = [
      {
        path: '/x/y.sty',
        content: `% \\newcommand{\\fake}{...}\n\\newcommand{\\real}{...}\n`,
      },
    ];
    const idx = buildIndexFromFileContents(files);
    expect(idx.has('fake')).toBe(false);
    expect(idx.get('real')).toBe('y');
  });

  // Regression: soul/soul-ori (the bug the user reported on \hl)
  it('resolves commands defined in an \\input-ed backend to the user-facing wrapper', () => {
    const files = [
      {
        path: '/x/soul/soul.sty',
        content: `\\input soul-ori.sty\\relax`,
      },
      {
        path: '/x/soul/soul-ori.sty',
        content: `\\newcommand{\\hl}[1]{...}`,
      },
    ];
    const idx = buildIndexFromFileContents(files);
    // \hl is defined in soul-ori.sty, but \usepackage{soul} loads it
    // transitively. The user-facing package must be `soul`.
    expect(idx.get('hl')).toBe('soul');
  });

  it('handles \\RequirePackage in addition to \\input', () => {
    const files = [
      { path: '/x/outer.sty', content: `\\RequirePackage{inner}` },
      { path: '/x/inner.sty', content: `\\newcommand{\\fancycmd}{...}` },
    ];
    const idx = buildIndexFromFileContents(files);
    expect(idx.get('fancycmd')).toBe('outer');
  });

  it('handles \\RequirePackage with options like [draft]{X}', () => {
    const files = [
      { path: '/x/wrapper.sty', content: `\\RequirePackage[draft]{backend}` },
      { path: '/x/backend.sty', content: `\\newcommand{\\widget}{...}` },
    ];
    const idx = buildIndexFromFileContents(files);
    expect(idx.get('widget')).toBe('wrapper');
  });

  it('handles comma-separated \\RequirePackage{a,b,c}', () => {
    const files = [
      { path: '/x/outer.sty', content: `\\RequirePackage{a,b}` },
      { path: '/x/a.sty', content: `\\newcommand{\\fromA}{...}` },
      { path: '/x/b.sty', content: `\\newcommand{\\fromB}{...}` },
    ];
    const idx = buildIndexFromFileContents(files);
    expect(idx.get('fromA')).toBe('outer');
    expect(idx.get('fromB')).toBe('outer');
  });

  it('walks transitive \\input chains (A inputs B which inputs C)', () => {
    const files = [
      { path: '/x/a.sty', content: `\\input{b.sty}` },
      { path: '/x/b.sty', content: `\\input{c.sty}` },
      { path: '/x/c.sty', content: `\\newcommand{\\threehopcmd}{...}` },
    ];
    const idx = buildIndexFromFileContents(files);
    expect(idx.get('threehopcmd')).toBe('a');
  });
});

describe('extractInputs', () => {
  it('captures \\input filename and \\input{filename}', () => {
    expect(extractInputs('\\input foo.sty\n').has('foo')).toBe(true);
    expect(extractInputs('\\input{foo.sty}\n').has('foo')).toBe(true);
    expect(extractInputs('\\input{foo}\n').has('foo')).toBe(true);
  });

  it('captures \\RequirePackage', () => {
    expect(extractInputs('\\RequirePackage{xcolor}').has('xcolor')).toBe(true);
  });

  it('captures \\RequirePackage with options', () => {
    expect(extractInputs('\\RequirePackage[table]{xcolor}').has('xcolor')).toBe(true);
  });

  it('captures \\LoadPackage', () => {
    expect(extractInputs('\\LoadPackage{foo}').has('foo')).toBe(true);
  });

  it('strips extensions', () => {
    const out = extractInputs('\\input{foo.sty}\n\\input{bar.tex}\n');
    expect(out.has('foo')).toBe(true);
    expect(out.has('bar')).toBe(true);
  });

  it('rejects paths and relative refs (we cannot resolve them confidently)', () => {
    expect(extractInputs('\\input{../foo.sty}').size).toBe(0);
    expect(extractInputs('\\input{dir/foo.sty}').size).toBe(0);
  });

  it('splits comma-separated package lists', () => {
    expect(extractInputs('\\RequirePackage{a, b, c}')).toEqual(new Set(['a', 'b', 'c']));
  });

  it('ignores definitions inside comments', () => {
    const out = extractInputs('% \\RequirePackage{notreal}\n\\RequirePackage{real}\n');
    expect(out.has('notreal')).toBe(false);
    expect(out.has('real')).toBe(true);
  });
});

describe('pickPreferredPackage with internalPkgs (Batch F)', () => {
  it("prefers a wrapper package over its internal backend", () => {
    const internals = new Set(['soul-ori']);
    const chosen = pickPreferredPackage('hl', new Set(['soul', 'soul-ori']), internals);
    expect(chosen).toBe('soul');
  });

  it("still prefers shorter / prefix-matching names when no internal is involved", () => {
    expect(pickPreferredPackage('foo', new Set(['amsmath', 'amsmath-tools']), new Set())).toBe('amsmath');
  });

  it("demotes the '-ori' suffix (used by Heiko's renamed-original-source idiom)", () => {
    expect(pickPreferredPackage('foo', new Set(['amsmath', 'amsmath-ori']), new Set())).toBe('amsmath');
  });
});
