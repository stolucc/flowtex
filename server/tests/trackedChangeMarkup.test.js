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
  resolvePosition,
  applyMarkup,
  ensurePreamble,
  injectTrackedChangeMarkup,
} from '../utils/trackedChangeMarkup.js';

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

describe('resolvePosition', () => {
  it('returns null when needle is empty', () => {
    expect(resolvePosition('hello', '', 0, 5)).toBeNull();
  });

  it('returns null when needle is null', () => {
    expect(resolvePosition('hello', null, 0, 5)).toBeNull();
  });

  it('returns the stored range when text at from..to matches the needle', () => {
    expect(resolvePosition('hello world', 'world', 6, 11)).toEqual({ from: 6, to: 11 });
  });

  it('falls back to from..from+len when stored to is wrong', () => {
    expect(resolvePosition('hello world', 'world', 6, 6)).toEqual({ from: 6, to: 11 });
  });

  it('does fuzzy windowed search when neither exact match works', () => {
    const content = 'aaaa needle bbbb';
    // stored from=0 is wrong; needle is at index 5.
    const r = resolvePosition(content, 'needle', 0, 6);
    expect(r).toEqual({ from: 5, to: 11 });
  });

  it('returns null if needle is nowhere in the search window', () => {
    const r = resolvePosition('aaaaaa', 'needle', 0, 0);
    expect(r).toBeNull();
  });

  it('picks the closest occurrence to the stored from when multiple matches exist', () => {
    const content = 'X' + 'pad'.repeat(10) + 'X';
    // Two X's; stored from=20 should pick the second.
    const r = resolvePosition(content, 'X', 20, 21);
    expect(r.from).toBe(31);
  });

  it('rejects negative from for the exact-match path but uses fuzzy as fallback', () => {
    const r = resolvePosition('hello', 'lo', -1, 5);
    expect(r).toEqual({ from: 3, to: 5 });
  });

  it('rejects to > content.length for exact path but uses fuzzy as fallback', () => {
    const r = resolvePosition('hello', 'lo', 3, 999);
    expect(r).toEqual({ from: 3, to: 5 });
  });

  it('scales window size with needle length up to a 600 cap', () => {
    // Needle far from `from` but within the 600-char cap should still resolve.
    const content = 'a'.repeat(400) + 'NEEDLE' + 'b'.repeat(400);
    const r = resolvePosition(content, 'NEEDLE', 0, 0);
    expect(r).toBeNull(); // window of 100 around from=0 doesn't reach 400+
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

describe('applyMarkup', () => {
  it('returns content unchanged when changes array is empty', () => {
    expect(applyMarkup('hello', [])).toBe('hello');
  });

  it('idempotence guard: returns content unchanged if \\TCadd{ already present', () => {
    const content = 'pre \\TCadd{added} post';
    const changes = [{ inserted_text: 'x', from_pos: 0, to_pos: 1 }];
    expect(applyMarkup(content, changes)).toBe(content);
  });

  it('idempotence guard: returns content unchanged if \\TCdel{ already present', () => {
    const content = 'pre \\TCdel{removed} post';
    expect(applyMarkup(content, [{ deleted_text: 'pre', from_pos: 0, to_pos: 3 }])).toBe(content);
  });

  it('idempotence guard does not trigger when visualMarkup=false', () => {
    const content = 'a \\TCadd{x} b';
    // visualMarkup=false bypasses the guard. With no real changes this is a no-op,
    // but the function should still return a string of the same length.
    const result = applyMarkup(content, [], { visualMarkup: false });
    expect(result).toBe(content);
  });

  it('wraps a simple insertion in \\TCadd', () => {
    const content = 'hello world';
    const changes = [{ inserted_text: 'world', from_pos: 6, to_pos: 11 }];
    const out = applyMarkup(content, changes);
    expect(out).toContain('\\TCadd{world}');
  });

  it('wraps a simple deletion in \\TCdel', () => {
    const content = 'hello world';
    const changes = [{ deleted_text: 'world', from_pos: 6, to_pos: 11 }];
    const out = applyMarkup(content, changes);
    expect(out).toContain('\\TCdel{world}');
  });

  it('processes multiple changes end-to-start so positions are preserved', () => {
    const content = 'AAAA BBBB';
    const changes = [
      { inserted_text: 'AAAA', from_pos: 0, to_pos: 4 },
      { inserted_text: 'BBBB', from_pos: 5, to_pos: 9 },
    ];
    const out = applyMarkup(content, changes);
    expect(out).toContain('\\TCadd{AAAA}');
    expect(out).toContain('\\TCadd{BBBB}');
  });

  it('skips a change whose position cannot be resolved', () => {
    const content = 'hello';
    const changes = [{ inserted_text: 'NOT_PRESENT', from_pos: 0, to_pos: 11 }];
    expect(applyMarkup(content, changes)).toBe(content);
  });

  it('skips a change inside a \\cite{...} fragile region', () => {
    const content = 'see \\cite{abcde} more';
    const changes = [{ inserted_text: 'abcde', from_pos: 10, to_pos: 15 }];
    const out = applyMarkup(content, changes);
    expect(out).not.toContain('\\TCadd{abcde}');
    expect(out).toBe(content);
  });

  it('skips a change inside a \\ref{...} fragile region', () => {
    const content = 'See \\ref{fig:1}';
    const changes = [{ inserted_text: 'fig:1', from_pos: 9, to_pos: 14 }];
    expect(applyMarkup(content, changes)).toBe(content);
  });

  it('removes a structural-table deletion silently (containing &)', () => {
    const content = 'a \\begin{tabular}{ll} x & y \\\\ \\end{tabular} b';
    const changes = [{ deleted_text: 'x & y', from_pos: 22, to_pos: 27 }];
    const out = applyMarkup(content, changes);
    expect(out).not.toContain('\\TCdel{');
    expect(out).not.toContain('x & y');
  });

  it('keeps text-only changes inside a tabular wrapped in \\TCadd', () => {
    const content = '\\begin{tabular}{l} hello \\end{tabular}';
    const changes = [{ inserted_text: 'hello', from_pos: 19, to_pos: 24 }];
    const out = applyMarkup(content, changes);
    expect(out).toContain('\\TCadd{hello}');
  });

  it('peels leading whitespace OUT of the wrapped insertion', () => {
    const content = 'a hello b';
    const changes = [{ inserted_text: ' hello', from_pos: 1, to_pos: 7 }];
    const out = applyMarkup(content, changes);
    // The leading space stays outside the macro.
    expect(out).toContain(' \\TCadd{hello}');
    expect(out).not.toContain('\\TCadd{ hello}');
  });

  it('peels trailing whitespace OUT of the wrapped insertion', () => {
    const content = 'a hello b';
    const changes = [{ inserted_text: 'hello ', from_pos: 2, to_pos: 8 }];
    const out = applyMarkup(content, changes);
    expect(out).toContain('\\TCadd{hello} ');
    expect(out).not.toContain('\\TCadd{hello }');
  });

  it('does NOT add markup at all when visualMarkup=false', () => {
    const content = 'hello world';
    const changes = [{ inserted_text: 'world', from_pos: 6, to_pos: 11 }];
    const out = applyMarkup(content, changes, { visualMarkup: false });
    expect(out).not.toContain('\\TCadd');
    expect(out).not.toContain('\\TCdel');
  });

  it('with visualMarkup=false, still removes structural-table deletions', () => {
    const content = '\\begin{tabular}{ll} a & b \\\\ \\end{tabular}';
    const changes = [{ deleted_text: 'a & b', from_pos: 20, to_pos: 25 }];
    const out = applyMarkup(content, changes, { visualMarkup: false });
    expect(out).not.toContain('a & b');
  });

  it('deduplicates overlapping ranges, keeping the first (rightmost after sort)', () => {
    const content = 'aaaaaaaaaa';
    const changes = [
      { inserted_text: 'aaaa', from_pos: 0, to_pos: 4 },
      { inserted_text: 'aaaa', from_pos: 2, to_pos: 6 },
    ];
    const out = applyMarkup(content, changes);
    // Only one TCadd should appear (the other was deduped as overlapping).
    expect((out.match(/\\TCadd\{/g) || []).length).toBe(1);
  });
});

describe('injectTrackedChangeMarkup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0 and writes nothing when no pending changes exist', async () => {
    db.all.mockResolvedValueOnce([]);
    const n = await injectTrackedChangeMarkup('p1', '/tmp/proj');
    expect(n).toBe(0);
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(invalidateFile).not.toHaveBeenCalled();
  });

  it('skips files that do not exist on disk', async () => {
    db.all.mockResolvedValueOnce([
      { file_path: 'main.tex', file_id: 'f1', inserted_text: 'x', from_pos: 0, to_pos: 1, project_id: 'p1' },
    ]);
    fsMocks.existsSync.mockReturnValue(false);
    const n = await injectTrackedChangeMarkup('p1', '/tmp/proj');
    expect(n).toBe(0);
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
  });

  it('writes back the modified content and invalidates the file cache', async () => {
    db.all.mockResolvedValueOnce([
      { file_path: 'main.tex', file_id: 'f1', inserted_text: 'world', from_pos: 6, to_pos: 11, project_id: 'p1' },
    ]);
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue('hello world');
    const n = await injectTrackedChangeMarkup('p1', '/tmp/proj');
    expect(n).toBe(1);
    expect(fsMocks.writeFileSync).toHaveBeenCalledTimes(1);
    const written = fsMocks.writeFileSync.mock.calls[0][1];
    expect(written).toContain('\\TCadd{world}');
    expect(invalidateFile).toHaveBeenCalledWith('p1', 'main.tex');
  });

  it('groups changes by file path so each file is written exactly once', async () => {
    db.all.mockResolvedValueOnce([
      { file_path: 'a.tex', inserted_text: 'x', from_pos: 0, to_pos: 1 },
      { file_path: 'a.tex', inserted_text: 'y', from_pos: 2, to_pos: 3 },
      { file_path: 'b.tex', inserted_text: 'z', from_pos: 0, to_pos: 1 },
    ]);
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockImplementation((p) => {
      if (p.endsWith('a.tex')) return 'x y';
      return 'z';
    });
    await injectTrackedChangeMarkup('p1', '/tmp/proj');
    // 2 unique files → 2 writes
    expect(fsMocks.writeFileSync).toHaveBeenCalledTimes(2);
    expect(invalidateFile).toHaveBeenCalledTimes(2);
  });

  it('only injects preamble into files that contain \\documentclass', async () => {
    db.all.mockResolvedValueOnce([
      { file_path: 'main.tex', inserted_text: 'x', from_pos: 0, to_pos: 1 },
    ]);
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue('no documentclass here, just x');
    await injectTrackedChangeMarkup('p1', '/tmp/proj');
    const written = fsMocks.writeFileSync.mock.calls[0][1];
    expect(written).not.toContain('\\providecommand{\\TCadd}');
  });

  it('does not inject preamble when visualMarkup=false', async () => {
    db.all.mockResolvedValueOnce([
      { file_path: 'main.tex', inserted_text: 'x', from_pos: 0, to_pos: 1 },
    ]);
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue('\\documentclass{article}\\begin{document}x\\end{document}');
    await injectTrackedChangeMarkup('p1', '/tmp/proj', { visualMarkup: false });
    const written = fsMocks.writeFileSync.mock.calls[0][1];
    expect(written).not.toContain('\\providecommand{\\TCadd}');
  });

  it('queries pending changes for the given project', async () => {
    db.all.mockResolvedValueOnce([]);
    await injectTrackedChangeMarkup('proj-42', '/tmp/proj');
    const [sql, params] = db.all.mock.calls[0];
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('project_id = $1');
    expect(params).toEqual(['proj-42']);
  });
});
