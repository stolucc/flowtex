import { describe, it, expect, afterEach } from 'vitest';
import {
  getErrorHelp,
  getCommandPackage,
  setDynamicCommandPackages,
  getDynamicCommandPackages,
} from '../latexErrorHelp.js';

describe('getErrorHelp', () => {
  it('returns null for empty / falsy input', () => {
    expect(getErrorHelp('')).toBeNull();
    expect(getErrorHelp(null)).toBeNull();
    expect(getErrorHelp(undefined)).toBeNull();
  });

  it('returns null when no rule matches', () => {
    expect(getErrorHelp('Some random message that no rule handles')).toBeNull();
  });

  it('returned object always has title, suggestion, tips[], searchUrl, fix', () => {
    const help = getErrorHelp('Missing $ inserted');
    expect(help).not.toBeNull();
    if (!help) return;
    expect(typeof help.title).toBe('string');
    expect(typeof help.suggestion).toBe('string');
    expect(Array.isArray(help.tips)).toBe(true);
    expect(typeof help.searchUrl).toBe('string');
    // fix is allowed to be null, but the field must be present.
    expect('fix' in help).toBe(true);
  });

  it('builds a tex.stackexchange search URL (not a verbatim string)', () => {
    const help = getErrorHelp('Missing $ inserted');
    expect(help?.searchUrl).toMatch(/^https:\/\/tex\.stackexchange\.com\/search\?q=/);
  });
});

// ─── Undefined command (the headline fix) ─────────────────────────────

describe('getErrorHelp — Undefined command fix descriptors', () => {
  it('static JSON:\\hl -> soul', () => {
    const help = getErrorHelp('Undefined control sequence \\hl');
    expect(help?.fix?.package).toBe('soul');
  });

  it('static JSON:\\dfrac -> amsmath', () => {
    const help = getErrorHelp('Undefined control sequence \\dfrac');
    expect(help?.fix?.package).toBe('amsmath');
  });

  it('static JSON:\\mathbb -> amssymb', () => {
    const help = getErrorHelp('Undefined control sequence \\mathbb');
    expect(help?.fix?.package).toBe('amssymb');
  });

  it('offers add-usepackage{xcolor} for \\textcolor', () => {
    // The regex is single-line (`.` doesn't match newlines). The LaTeX
    // log parser strips the "! " prefix and emits the command name on
    // the same line as the error in the lookahead pass; the real
    // PdfViewer calls getErrorHelp on that single line.
    const help = getErrorHelp('Undefined control sequence \\textcolor');
    expect(help?.fix).toEqual({
      kind: 'add-usepackage',
      package: 'xcolor',
      label: 'Add \\usepackage{xcolor} to preamble',
    });
  });

  it('offers add-usepackage{graphicx} for \\includegraphics', () => {
    const help = getErrorHelp('! Undefined control sequence \\includegraphics');
    expect(help?.fix?.package).toBe('graphicx');
  });

  it('offers add-usepackage{booktabs} for \\toprule / \\midrule / \\bottomrule', () => {
    expect(getErrorHelp('Undefined control sequence \\toprule')?.fix?.package).toBe('booktabs');
    expect(getErrorHelp('Undefined control sequence \\midrule')?.fix?.package).toBe('booktabs');
    expect(getErrorHelp('Undefined control sequence \\bottomrule')?.fix?.package).toBe('booktabs');
  });

  it('expanded COMMAND_PACKAGES coverage: cleveref / mhchem / fontawesome5 / todonotes', () => {
    expect(getErrorHelp('Undefined control sequence \\cref')?.fix?.package).toBe('cleveref');
    expect(getErrorHelp('Undefined control sequence \\Cref')?.fix?.package).toBe('cleveref');
    expect(getErrorHelp('Undefined control sequence \\ce')?.fix?.package).toBe('mhchem');
    expect(getErrorHelp('Undefined control sequence \\faIcon')?.fix?.package).toBe('fontawesome5');
    expect(getErrorHelp('Undefined control sequence \\todo')?.fix?.package).toBe('todonotes');
  });

  it('expanded COMMAND_PACKAGES coverage: amsmath family (\\dfrac, \\binom, \\substack)', () => {
    expect(getErrorHelp('Undefined control sequence \\dfrac')?.fix?.package).toBe('amsmath');
    expect(getErrorHelp('Undefined control sequence \\binom')?.fix?.package).toBe('amsmath');
    expect(getErrorHelp('Undefined control sequence \\substack')?.fix?.package).toBe('amsmath');
  });

  it('expanded COMMAND_PACKAGES coverage: amssymb (\\mathbb, \\mathfrak)', () => {
    expect(getErrorHelp('Undefined control sequence \\mathbb')?.fix?.package).toBe('amssymb');
    expect(getErrorHelp('Undefined control sequence \\mathfrak')?.fix?.package).toBe('amssymb');
  });

  it('expanded COMMAND_PACKAGES coverage: biblatex citation commands', () => {
    expect(getErrorHelp('Undefined control sequence \\autocite')?.fix?.package).toBe('biblatex');
    expect(getErrorHelp('Undefined control sequence \\parencite')?.fix?.package).toBe('biblatex');
    expect(getErrorHelp('Undefined control sequence \\textcite')?.fix?.package).toBe('biblatex');
  });

  it('expanded COMMAND_PACKAGES coverage: siunitx modern interface (\\qty, \\ang)', () => {
    expect(getErrorHelp('Undefined control sequence \\qty')?.fix?.package).toBe('siunitx');
    expect(getErrorHelp('Undefined control sequence \\ang')?.fix?.package).toBe('siunitx');
  });

  it('does NOT offer a fix for built-in commands the user has a typo on (e.g. \\textbf)', () => {
    // textbf maps to `null` in the lookup -- the command exists in
    // every standard class, so an undefined-command error means a
    // typo. Suggestion is still shown; no fix button.
    const help = getErrorHelp('Undefined control sequence \\textbf');
    expect(help).not.toBeNull();
    expect(help?.fix).toBeNull();
  });

  it('does NOT offer a fix when the suggestion is ambiguous (\\url could be url OR hyperref)', () => {
    const help = getErrorHelp('Undefined control sequence \\url');
    expect(help).not.toBeNull();
    // Suggestion text mentions both options; no single-package fix.
    expect(help?.fix).toBeNull();
  });

  it('does NOT offer a fix for an unknown command (no entry in the lookup)', () => {
    const help = getErrorHelp('Undefined control sequence \\customcommand');
    expect(help).not.toBeNull();
    expect(help?.fix).toBeNull();
  });

  it('falls back to the no-context rule when the message has no \\command capture', () => {
    // Older logs (or hand-typed test inputs) sometimes lose the
    // command-after-backslash context. The catch-all rule kicks in.
    const help = getErrorHelp('Undefined control sequence.');
    expect(help).not.toBeNull();
    expect(help?.title).toBe('Undefined command');
    expect(help?.fix).toBeNull();
  });
});

// ─── Undefined environment (the new fix) ──────────────────────────────

describe('getErrorHelp — Unknown environment fix descriptors', () => {
  it('offers add-usepackage{amsmath} for \\begin{align}', () => {
    const help = getErrorHelp('Environment align undefined.');
    expect(help?.fix).toEqual({
      kind: 'add-usepackage',
      package: 'amsmath',
      label: 'Add \\usepackage{amsmath} to preamble',
    });
  });

  it('offers add-usepackage{tikz} for \\begin{tikzpicture}', () => {
    expect(getErrorHelp('Environment tikzpicture undefined.')?.fix?.package).toBe('tikz');
  });

  it('offers add-usepackage{listings} for \\begin{lstlisting}', () => {
    expect(getErrorHelp('Environment lstlisting undefined.')?.fix?.package).toBe('listings');
  });

  it('offers add-usepackage{algorithm} for \\begin{algorithm}', () => {
    expect(getErrorHelp('Environment algorithm undefined.')?.fix?.package).toBe('algorithm');
  });

  it('offers add-usepackage{subcaption} for \\begin{subfigure}', () => {
    expect(getErrorHelp('Environment subfigure undefined.')?.fix?.package).toBe('subcaption');
  });

  it('does NOT offer a fix for built-in environments (typo, not a missing package)', () => {
    // itemize / enumerate / center / abstract are all base LaTeX --
    // an "undefined" error here means a typo.
    expect(getErrorHelp('Environment itemize undefined.')?.fix).toBeNull();
    expect(getErrorHelp('Environment center undefined.')?.fix).toBeNull();
    expect(getErrorHelp('Environment abstract undefined.')?.fix).toBeNull();
  });

  it('does NOT offer a fix for an unknown environment name', () => {
    const help = getErrorHelp('Environment frobozz undefined.');
    expect(help).not.toBeNull();
    expect(help?.fix).toBeNull();
  });

  it('mentions the required package in the suggestion text when known', () => {
    const help = getErrorHelp('Environment align undefined.');
    expect(help?.suggestion).toMatch(/\\usepackage\{amsmath\}/);
  });

  it('falls back to the generic suggestion when the environment is unknown', () => {
    const help = getErrorHelp('Environment frobozz undefined.');
    expect(help?.suggestion).toMatch(/Check spelling/);
  });
});

// ─── Missing package: offer to REMOVE the \usepackage line ────────────

describe('getErrorHelp — Missing package fix (remove-usepackage)', () => {
  it('offers remove-usepackage{X} for "File `X.sty\' not found"', () => {
    const help = getErrorHelp("LaTeX Error: File `obscure.sty' not found.");
    expect(help?.fix).toEqual({
      kind: 'remove-usepackage',
      package: 'obscure',
      label: 'Remove \\usepackage{obscure}',
    });
  });

  it("captures the package name without the .sty extension", () => {
    const help = getErrorHelp("LaTeX Error: File `tikz-cd.sty' not found.");
    expect(help?.fix?.package).toBe('tikz-cd');
  });
});

// ─── Mismatched environment: offer to rename the \end{X} ──────────────

describe('getErrorHelp — Mismatched environment fix (rename-env-end)', () => {
  it('offers rename-env-end with the begin/end names captured', () => {
    const help = getErrorHelp(
      '\\begin{itemize} on input line 5 ended by \\end{enumerate}',
    );
    expect(help?.fix).toMatchObject({
      kind: 'rename-env-end',
      beginName: 'itemize',
      endName: 'enumerate',
    });
    expect(help?.fix?.label).toContain('\\end{enumerate}');
    expect(help?.fix?.label).toContain('\\begin{itemize}');
  });
});

// ─── Citation fixes (Batch C) ─────────────────────────────────────────

describe('getErrorHelp — citation fix descriptors (multi-fix)', () => {
  it('returns an ARRAY of two fix descriptors for an undefined citation', () => {
    const help = getErrorHelp("Citation `smith2020' on page 1 undefined on input line 5.");
    expect(Array.isArray(help?.fix)).toBe(true);
    if (!help?.fix || !Array.isArray(help.fix)) return;
    expect(help.fix).toHaveLength(2);
    expect(help.fix[0]).toEqual({
      kind: 'open-bib-with-skeleton',
      citationKey: 'smith2020',
      label: 'Add "smith2020" skeleton to .bib',
    });
    expect(help.fix[1]).toEqual({
      kind: 'open-zotero-for-key',
      citationKey: 'smith2020',
      label: 'Search Zotero for "smith2020"',
    });
  });

  it('captures arXiv-style citation keys with colons and dots', () => {
    const help = getErrorHelp("Citation `arxiv:2402.12345' on page 1 undefined");
    if (!help?.fix || !Array.isArray(help.fix)) {
      throw new Error('expected array of fixes');
    }
    expect(help.fix[0].citationKey).toBe('arxiv:2402.12345');
  });
});

// ─── Image / graphicspath fixes (Batch B) ─────────────────────────────

describe('getErrorHelp — add-graphicspath descriptor', () => {
  it('offers add-graphicspath for "File `figs/foo.png\' not found"', () => {
    const help = getErrorHelp("LaTeX Error: File `figs/foo.png' not found.");
    expect(help?.fix).toEqual({
      kind: 'add-graphicspath',
      missingFile: 'figs/foo.png',
      label: 'Add \\graphicspath for "figs/foo.png"',
    });
  });

  it('offers add-graphicspath for "File `foo\' not found" (no extension)', () => {
    // \includegraphics{foo} -> LaTeX appends extensions and reports
    // "foo" missing. We still offer the fix because no-extension
    // looks like \includegraphics use.
    const help = getErrorHelp("LaTeX Error: File `foo' not found.");
    expect(help?.fix?.kind).toBe('add-graphicspath');
  });

  it('does NOT offer add-graphicspath for non-image files (.tex, .bib)', () => {
    expect(getErrorHelp("LaTeX Error: File `chapter1.tex' not found.")?.fix).toBeNull();
    expect(getErrorHelp("LaTeX Error: File `refs.bib' not found.")?.fix).toBeNull();
  });
});

describe('getErrorHelp — swap-image-ext descriptor', () => {
  it('offers swap-image-ext for "Cannot determine size of graphic in foo.svg"', () => {
    const help = getErrorHelp('Cannot determine size of graphic in foo.svg (no BoundingBox).');
    expect(help?.fix).toEqual({
      kind: 'swap-image-ext',
      badName: 'foo.svg',
      label: 'Swap "foo.svg" to a pdflatex-friendly extension',
    });
  });

  it('falls back to the no-capture rule when the message has no filename', () => {
    // Older log shapes that don't include the filename should still
    // surface help, just without a fix descriptor.
    const help = getErrorHelp('Cannot determine size of graphic.');
    expect(help).not.toBeNull();
    expect(help?.title).toBe('Image size unknown');
    expect(help?.fix).toBeNull();
  });
});

// ─── A handful of other rules — pin that getErrorHelp dispatches ───────

describe('getErrorHelp — other rules dispatch correctly', () => {
  it('Missing $ inserted -> Math mode required', () => {
    expect(getErrorHelp('! Missing $ inserted.')?.title).toBe('Math mode required');
  });

  it('Missing package (.sty not found) -> Missing package', () => {
    expect(getErrorHelp("LaTeX Error: File `foo.sty' not found.")?.title).toBe('Missing package');
  });

  it('Undefined citation -> Undefined citation', () => {
    expect(getErrorHelp("Citation `smith2020' on page 1 undefined")?.title).toBe('Undefined citation');
  });

  it('Undefined reference -> Undefined reference', () => {
    expect(getErrorHelp("Reference `fig:foo' on page 1 undefined")?.title).toBe('Undefined reference');
  });

  it('Overfull hbox -> Content too wide', () => {
    expect(getErrorHelp('Overfull \\hbox (12.34pt too wide) in paragraph at lines 100--105')?.title).toBe('Content too wide');
  });
});

describe('getCommandPackage (static + dynamic dispatch)', () => {
  afterEach(() => setDynamicCommandPackages(new Map()));

  it('resolves a command from the static JSON map', () => {
    expect(getCommandPackage('textcolor')).toBe('xcolor');
    expect(getCommandPackage('hl')).toBe('soul');
  });

  it('returns null for a built-in (typo, not a missing package)', () => {
    expect(getCommandPackage('section')).toBeNull();
    expect(getCommandPackage('textbf')).toBeNull();
  });

  it('returns undefined for an unknown command (caller should kick off a lookup)', () => {
    expect(getCommandPackage('totallymadeup')).toBeUndefined();
  });

  it('falls through to the dynamic map when the static map has no entry', () => {
    setDynamicCommandPackages(new Map([['obscurecmd', 'obscurepkg']]));
    expect(getCommandPackage('obscurecmd')).toBe('obscurepkg');
  });

  it('static map takes precedence over the dynamic map (no shadowing)', () => {
    // Even if the dynamic map disagrees, a known static entry wins.
    setDynamicCommandPackages(new Map([['textcolor', 'WRONG']]));
    expect(getCommandPackage('textcolor')).toBe('xcolor');
  });

  it('dynamic map can carry a null (built-in) verdict', () => {
    setDynamicCommandPackages(new Map([['dyncmd', null]]));
    expect(getCommandPackage('dyncmd')).toBeNull();
  });

  it('getDynamicCommandPackages round-trips the set map', () => {
    const m = new Map([['a', 'pkga']]);
    setDynamicCommandPackages(m);
    expect(getDynamicCommandPackages().get('a')).toBe('pkga');
  });
});

describe('JSON key-filter (section markers / placeholders excluded)', () => {
  it('does not expose underscore-prefixed section markers as commands', () => {
    // `_amsmath`, `_xcolor`, etc. are comment keys in the JSON. They
    // must never resolve as real commands.
    expect(getCommandPackage('_amsmath')).toBeUndefined();
    expect(getCommandPackage('_xcolor')).toBeUndefined();
  });

  it('does not expose _dup / _cmd / _kernel placeholder keys', () => {
    expect(getCommandPackage('boldsymbol_dup')).toBeUndefined();
    expect(getCommandPackage('_underscore_cmd')).toBeUndefined();
    expect(getCommandPackage('boldsymbol_kernel')).toBeUndefined();
  });

  it('still resolves real commands that sit next to the markers', () => {
    // sanity: the filter didn't nuke legitimate entries.
    expect(getCommandPackage('binom')).toBe('amsmath');
  });
});

describe('Undefined-command suggestion text branch', () => {
  it('names the required package when known', () => {
    const help = getErrorHelp('Undefined control sequence \\textcolor');
    expect(help?.suggestion).toContain('\\usepackage{xcolor}');
  });

  it('falls back to generic text for an unknown command', () => {
    const help = getErrorHelp('Undefined control sequence \\zzzznotacommand');
    expect(help?.suggestion).toMatch(/not defined|Check for typos/i);
    expect(help?.suggestion).not.toContain('\\usepackage{undefined}');
  });
});
