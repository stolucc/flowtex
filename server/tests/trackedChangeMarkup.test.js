import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted, so any references they need must be
// hoisted alongside via vi.hoisted().
const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('../db.js', () => ({
  default: { all: vi.fn(), run: vi.fn() },
}));
vi.mock('../compiler.js', () => ({
  invalidateFile: vi.fn(),
}));
vi.mock('fs', () => ({ default: fsMocks, ...fsMocks }));

import db from '../db.js';
import { invalidateFile } from '../compiler.js';
import {
  buildPreamble,
  bracesBalanced,
  wrapSafe,
  ensurePreamble,
  injectTrackedChangeMarkup,
  convertMarkersToTexMarkup,
} from '../utils/trackedChangeMarkup.js';
import { serialize as serializeMarker } from '../../shared/tcMarkers.js';

describe('buildPreamble', () => {
  it('emits both \\RequirePackage lines when neither package is loaded', () => {
    const out = buildPreamble('\\documentclass{article}');
    expect(out).toContain('\\RequirePackage{xcolor}');
    expect(out).toContain('\\RequirePackage[normalem]{ulem}');
  });

  it('omits xcolor RequirePackage when xcolor is already loaded via \\usepackage', () => {
    const out = buildPreamble('\\usepackage{xcolor}');
    expect(out).not.toContain('\\RequirePackage{xcolor}');
    expect(out).toContain('\\RequirePackage[normalem]{ulem}');
  });

  it('omits xcolor when xcolor is loaded via \\usepackage with options', () => {
    const out = buildPreamble('\\usepackage[dvipsnames]{xcolor}');
    expect(out).not.toContain('\\RequirePackage{xcolor}');
  });

  it('omits xcolor when xcolor is loaded via \\RequirePackage', () => {
    const out = buildPreamble('\\RequirePackage{xcolor}');
    expect(out).not.toContain('\\RequirePackage{xcolor}\n'); // not the auto-injected one
    // But the existing one in input is fine — buildPreamble emits the
    // sentinel marker plus only the missing pieces.
    expect(out.split('\\RequirePackage{xcolor}').length).toBe(1);
  });

  it('omits ulem when ulem is already loaded', () => {
    const out = buildPreamble('\\usepackage{ulem}');
    expect(out).not.toContain('[normalem]{ulem}');
  });

  it('always emits the \\TCadd and \\TCdel macros', () => {
    const out = buildPreamble('\\usepackage{xcolor}\\usepackage{ulem}');
    expect(out).toContain('\\providecommand{\\TCadd}');
    expect(out).toContain('\\providecommand{\\TCdel}');
  });

  it('starts with the marker comment', () => {
    expect(buildPreamble('').split('\n')[0]).toBe('%% --- Tracked-change markup (modelled on latexdiff) ---');
  });

  it('ends with the closing marker comment', () => {
    const lines = buildPreamble('').split('\n');
    expect(lines[lines.length - 1]).toBe('%% --- End tracked-change markup ---');
  });

  it('uses textcolor blue for additions and red+sout for deletions', () => {
    const out = buildPreamble('');
    expect(out).toContain('\\textcolor{blue}{#1}');
    expect(out).toContain('\\textcolor{red}{\\sout{#1}}');
  });
});

describe('bracesBalanced', () => {
  it('returns true for the empty string', () => {
    expect(bracesBalanced('')).toBe(true);
  });

  it('returns true for plain text with no braces', () => {
    expect(bracesBalanced('hello world')).toBe(true);
  });

  it('returns true for a single matched pair', () => {
    expect(bracesBalanced('{a}')).toBe(true);
  });

  it('returns true for nested matched pairs', () => {
    expect(bracesBalanced('{a{b{c}}}')).toBe(true);
  });

  it('returns false when a closing brace appears with no opener', () => {
    expect(bracesBalanced('}')).toBe(false);
  });

  it('returns false when an opener has no closer', () => {
    expect(bracesBalanced('{')).toBe(false);
  });

  it('returns false when } appears before {', () => {
    expect(bracesBalanced('}{')).toBe(false);
  });

  it('treats \\{ and \\} as escaped — they do not count', () => {
    expect(bracesBalanced('\\{a\\}')).toBe(true);
  });

  it('treats \\\\ as a no-op (the second \\ is the escaped char)', () => {
    expect(bracesBalanced('\\\\')).toBe(true);
  });

  it('returns true for a real-world TeX snippet', () => {
    expect(bracesBalanced('\\textbf{hello \\emph{world}}')).toBe(true);
  });

  it('returns false for an unbalanced TeX snippet', () => {
    expect(bracesBalanced('\\textbf{hello')).toBe(false);
  });

  it('handles a final \\ at end of string without crashing', () => {
    expect(bracesBalanced('text\\')).toBe(true);
  });
});

describe('wrapSafe', () => {
  it('returns empty string for empty input', () => {
    expect(wrapSafe('', '\\TCadd')).toBe('');
  });

  it('returns empty string for null/undefined input', () => {
    expect(wrapSafe(null, '\\TCadd')).toBe('');
    expect(wrapSafe(undefined, '\\TCadd')).toBe('');
  });

  it('wraps a plain single-line chunk in the macro', () => {
    expect(wrapSafe('hello', '\\TCadd')).toBe('\\TCadd{hello}');
  });

  it('uses the provided macro name', () => {
    expect(wrapSafe('x', '\\TCdel')).toBe('\\TCdel{x}');
  });

  it('keeps a blank line unwrapped', () => {
    expect(wrapSafe('\n', '\\TCadd')).toBe('\n');
  });

  it('flushes and emits a structural \\section line unwrapped', () => {
    const out = wrapSafe('text\n\\section{X}\nmore', '\\TCadd');
    expect(out).toContain('\\section{X}');
    expect(out).toContain('\\TCadd{text}');
    expect(out).toContain('\\TCadd{more}');
  });

  it('flushes around \\begin{...} structural lines', () => {
    const out = wrapSafe('a\n\\begin{itemize}\nb', '\\TCadd');
    expect(out).toContain('\\begin{itemize}');
    expect(out).toContain('\\TCadd{a}');
    expect(out).toContain('\\TCadd{b}');
  });

  it('keeps a chunk with unbalanced braces unwrapped', () => {
    expect(wrapSafe('text {with unbalanced', '\\TCadd')).toBe('text {with unbalanced');
  });

  it('splits around a citation command, keeping the citation unwrapped', () => {
    const out = wrapSafe('see \\cite{foo} more', '\\TCadd');
    expect(out).toContain('\\cite{foo}');
    expect(out).toContain('\\TCadd{see }');
    expect(out).toContain('\\TCadd{ more}');
  });

  it('handles citation command at the start of the chunk', () => {
    const out = wrapSafe('\\cite{x} after', '\\TCadd');
    expect(out).toContain('\\cite{x}');
    expect(out).toContain('\\TCadd{ after}');
  });

  it('handles citation command at the end of the chunk', () => {
    const out = wrapSafe('before \\cite{x}', '\\TCadd');
    expect(out).toContain('\\TCadd{before }');
    expect(out).toContain('\\cite{x}');
  });

  it('handles \\parencite and \\textcite as fragile commands', () => {
    expect(wrapSafe('\\parencite{a}', '\\TCadd')).toContain('\\parencite{a}');
    expect(wrapSafe('\\textcite{a}', '\\TCadd')).toContain('\\textcite{a}');
  });

  it('flushes the buffer at a paragraph break (blank line)', () => {
    const out = wrapSafe('a\n\nb', '\\TCadd');
    expect(out).toBe('\\TCadd{a}\n\n\\TCadd{b}');
  });

  it('flushes around display math \\[ and \\]', () => {
    const out = wrapSafe('text\n\\[\nx = 1\n\\]\nmore', '\\TCadd');
    expect(out).toContain('\\[');
    expect(out).toContain('\\]');
    expect(out).toContain('\\TCadd{text}');
    expect(out).toContain('\\TCadd{more}');
  });

  it('emits structural \\toprule line unwrapped', () => {
    const out = wrapSafe('a\n\\toprule\nb', '\\TCadd');
    expect(out).toContain('\\toprule');
    expect(out).not.toContain('\\TCadd{\\toprule}');
  });

  it('emits \\item line unwrapped', () => {
    const out = wrapSafe('\\item one', '\\TCadd');
    expect(out).toBe('\\item one');
  });
});


describe('ensurePreamble', () => {
  it('returns content unchanged when sentinel comment is already present', () => {
    const inp = '\\documentclass{article}\n%% --- Tracked-change markup foo\n\\begin{document}\nx\n\\end{document}';
    expect(ensurePreamble(inp)).toBe(inp);
  });

  it('returns content unchanged when there is no \\begin{document}', () => {
    const inp = '\\documentclass{article}\nNo begin doc here.';
    expect(ensurePreamble(inp)).toBe(inp);
  });

  it('inserts preamble immediately before \\begin{document}', () => {
    const inp = '\\documentclass{article}\n\\begin{document}\nx\n\\end{document}';
    const out = ensurePreamble(inp);
    expect(out).toContain('\\providecommand{\\TCadd}');
    const idxPreamble = out.indexOf('\\providecommand{\\TCadd}');
    const idxBeginDoc = out.indexOf('\\begin{document}');
    expect(idxPreamble).toBeLessThan(idxBeginDoc);
  });
});


// ─── New marker-based path ─────────────────────────────────────────────

describe('convertMarkersToTexMarkup', () => {
  const ins = (id, text) => serializeMarker({ type: 'ins', id, author: 'u1', text });
  const del = (id, text) => serializeMarker({ type: 'del', id, author: 'u1', text });

  it('returns content unchanged when no markers are present', () => {
    expect(convertMarkersToTexMarkup('plain content')).toBe('plain content');
  });

  it('replaces an insertion marker with \\TCadd{...}', () => {
    const out = convertMarkersToTexMarkup(`hi ${ins('a', 'world')}`);
    expect(out).toBe('hi \\TCadd{world}');
  });

  it('replaces a deletion marker with \\TCdel{...}', () => {
    const out = convertMarkersToTexMarkup(`hi ${del('a', 'gone')} foo`);
    expect(out).toBe('hi \\TCdel{gone} foo');
  });

  it('handles adjacent insertion + deletion (replace operation)', () => {
    const content = `Header 1 & ${ins('i1', 'eee')}${del('d1', 'Header 2')} & Header 3`;
    const out = convertMarkersToTexMarkup(content);
    expect(out).toBe('Header 1 & \\TCadd{eee}\\TCdel{Header 2} & Header 3');
  });

  it('preserves leading/trailing spaces of insertions OUTSIDE the macro', () => {
    const content = `a${ins('a', ' x ')}b`;
    const out = convertMarkersToTexMarkup(content);
    expect(out).toBe('a \\TCadd{x} b');
  });

  it('drops the marker entirely when its insertion text is just whitespace', () => {
    const content = `a${ins('a', '   ')}b`;
    const out = convertMarkersToTexMarkup(content);
    expect(out).toBe('a   b');
  });

  it('strips markers in visualMarkup=false (acceptAll semantics)', () => {
    const content = `pre ${ins('a', 'NEW')}${del('b', 'OLD')} post`;
    expect(convertMarkersToTexMarkup(content, { visualMarkup: false }))
      .toBe('pre NEW post');
  });

  it('processes markers right-to-left so positions never collide', () => {
    const content = `${ins('a', 'X')} mid ${ins('b', 'Y')}`;
    expect(convertMarkersToTexMarkup(content)).toBe('\\TCadd{X} mid \\TCadd{Y}');
  });
});

describe('injectTrackedChangeMarkup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const ins = (id, text) => serializeMarker({ type: 'ins', id, author: 'u1', text });

  it('returns 0 and writes nothing when no markers exist anywhere', async () => {
    db.all.mockResolvedValueOnce([{ path: 'main.tex' }]);
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue('plain document, no markers');
    const n = await injectTrackedChangeMarkup('p1', '/tmp/proj');
    expect(n).toBe(0);
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(invalidateFile).not.toHaveBeenCalled();
  });

  it('skips files that do not exist on disk', async () => {
    db.all.mockResolvedValueOnce([{ path: 'main.tex' }]);
    fsMocks.existsSync.mockReturnValue(false);
    const n = await injectTrackedChangeMarkup('p1', '/tmp/proj');
    expect(n).toBe(0);
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
  });

  it('converts inline markers to LaTeX markup and writes back', async () => {
    db.all.mockResolvedValueOnce([{ path: 'main.tex' }]);
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(`hello ${ins('a', 'world')}`);
    const n = await injectTrackedChangeMarkup('p1', '/tmp/proj');
    expect(n).toBe(1);
    expect(fsMocks.writeFileSync).toHaveBeenCalledTimes(1);
    const written = fsMocks.writeFileSync.mock.calls[0][1];
    expect(written).toContain('\\TCadd{world}');
    expect(invalidateFile).toHaveBeenCalledWith('p1', 'main.tex');
  });

  it('processes each file independently across the project', async () => {
    db.all.mockResolvedValueOnce([{ path: 'a.tex' }, { path: 'b.tex' }]);
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockImplementation((p) =>
      p.endsWith('a.tex') ? `A ${ins('a', 'X')}` : `B ${ins('b', 'Y')}`,
    );
    await injectTrackedChangeMarkup('p1', '/tmp/proj');
    expect(fsMocks.writeFileSync).toHaveBeenCalledTimes(2);
    expect(invalidateFile).toHaveBeenCalledTimes(2);
  });

  it('only injects preamble into files that contain \\documentclass', async () => {
    db.all.mockResolvedValueOnce([{ path: 'main.tex' }]);
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(`no documentclass here, ${ins('a', 'word')}`);
    await injectTrackedChangeMarkup('p1', '/tmp/proj');
    const written = fsMocks.writeFileSync.mock.calls[0][1];
    expect(written).not.toContain('\\providecommand{\\TCadd}');
  });

  it('does not inject preamble when visualMarkup=false (markers are stripped instead)', async () => {
    db.all.mockResolvedValueOnce([{ path: 'main.tex' }]);
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(
      `\\documentclass{article}\\begin{document}hi ${ins('a', 'world')}\\end{document}`,
    );
    await injectTrackedChangeMarkup('p1', '/tmp/proj', { visualMarkup: false });
    expect(fsMocks.writeFileSync).toHaveBeenCalledTimes(1);
    const written = fsMocks.writeFileSync.mock.calls[0][1];
    expect(written).toContain('hi world');
    expect(written).not.toContain('\\providecommand{\\TCadd}');
    expect(written).not.toContain('\\TCadd{world}');
  });

  it('queries the files table scoped to the given project', async () => {
    db.all.mockResolvedValueOnce([]);
    await injectTrackedChangeMarkup('proj-42', '/tmp/proj');
    const [sql, params] = db.all.mock.calls[0];
    expect(sql).toContain('FROM files');
    expect(sql).toContain('project_id = $1');
    expect(params).toEqual(['proj-42']);
  });
});
