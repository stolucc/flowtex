import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process.execFile so the main entry point doesn't require a
// real `latexdiff` binary on the test runner.
const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (cmd, args, opts, cb) => execFileMock(cmd, args, opts, cb),
}));

// Track temp file IO without touching disk.
const writeFileSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
vi.mock('fs', () => ({
  default: {
    writeFileSync: (...a) => writeFileSyncMock(...a),
    unlinkSync: (...a) => unlinkSyncMock(...a),
  },
  writeFileSync: (...a) => writeFileSyncMock(...a),
  unlinkSync: (...a) => unlinkSyncMock(...a),
}));

import latexDiff, { postProcess } from '../utils/latexDiff.js';

describe('postProcess', () => {
  it('passes through plain text untouched', () => {
    const inp = 'Plain content with no DIF markers and no \\toprule.';
    expect(postProcess(inp)).toBe(inp);
  });

  it('strips \\DIFaddbegin / \\DIFaddend markers from a line containing \\toprule', () => {
    const inp = '\\DIFaddbegin \\toprule \\DIFaddend';
    const out = postProcess(inp);
    expect(out).not.toContain('DIF');
    expect(out).toContain('\\toprule');
  });

  it('strips DIF markers from lines containing \\midrule', () => {
    // The regex \DIF(add|del)(begin|end)(FL)?\s* consumes any trailing
    // whitespace after the marker; the leading space before \midrule
    // belongs to the match of \DIFdelbegin\s*.
    const out = postProcess('\\DIFdelbegin \\midrule \\DIFdelend');
    expect(out).toBe('\\midrule ');
  });

  it('strips DIF markers from lines containing \\bottomrule', () => {
    expect(postProcess('\\DIFaddbegin \\bottomrule')).toBe('\\bottomrule');
  });

  it('strips DIF markers from lines containing \\caption', () => {
    expect(postProcess('\\DIFaddbeginFL \\caption{Hi}'))
      .toBe('\\caption{Hi}');
  });

  it('strips DIF markers from lines containing \\addlinespace', () => {
    expect(postProcess('\\addlinespace \\DIFdelendFL')).toBe('\\addlinespace ');
  });

  it('strips DIF markers from lines containing \\endhead', () => {
    expect(postProcess('row \\\\ \\DIFaddbegin \\endhead'))
      .toBe('row \\\\ \\endhead');
  });

  it('strips DIF markers from lines containing \\endfirsthead', () => {
    expect(postProcess('\\DIFaddbegin \\endfirsthead')).toBe('\\endfirsthead');
  });

  it('strips DIF markers from lines containing \\endfoot', () => {
    expect(postProcess('\\DIFdelbegin \\endfoot')).toBe('\\endfoot');
  });

  it('strips DIF markers from lines containing \\endlastfoot', () => {
    expect(postProcess('\\DIFaddend \\endlastfoot')).toBe('\\endlastfoot');
  });

  it('strips DIF markers from lines containing \\multicolumn (omit case)', () => {
    expect(postProcess('\\DIFaddbegin \\multicolumn{2}{c}{x}'))
      .toBe('\\multicolumn{2}{c}{x}');
  });

  it('strips DIF markers from lines containing \\multirow (omit case)', () => {
    expect(postProcess('\\DIFdelbegin \\multirow{3}{*}{x}'))
      .toBe('\\multirow{3}{*}{x}');
  });

  it('strips a DIF marker line entirely if the next non-blank line has \\noalign cmds', () => {
    // Marker on its own line; the very next non-blank line contains
    // \toprule. The marker line collapses to '' and is dropped.
    const inp = '\\DIFaddbegin\n\\toprule';
    const out = postProcess(inp);
    expect(out).not.toContain('DIFaddbegin');
    expect(out).toBe('\\toprule');
  });

  it('looks past blank lines for the noalign successor', () => {
    const inp = '\\DIFaddbegin\n\n\n\\toprule';
    const out = postProcess(inp);
    expect(out).not.toContain('DIFaddbegin');
    expect(out).toContain('\\toprule');
  });

  it('does NOT look more than 4 lines ahead for the noalign successor', () => {
    // 5 blank lines between DIF and toprule — must NOT trigger the look-ahead strip.
    const inp = '\\DIFaddbegin{x}\n\n\n\n\n\n\\toprule';
    const out = postProcess(inp);
    // Marker stays because successor was not found within the window.
    expect(out).toContain('DIFadd');
  });

  it('keeps DIF markers when the line is plain prose and successor is plain prose', () => {
    const inp = 'Hello \\DIFaddbeginFL\\DIFaddFL{world}\\DIFaddendFL';
    expect(postProcess(inp)).toBe(inp);
  });

  it('preserves DIF markers when only \\section (not noalign/omit) follows', () => {
    const inp = '\\DIFaddbegin{x}\n\\section{New}';
    expect(postProcess(inp)).toContain('\\DIFaddbegin');
  });

  it('strips \\DIFaddFL{...} markup-with-content style markers', () => {
    expect(postProcess('\\caption{} \\DIFaddFL{caption text}'))
      .toBe('\\caption{} ');
  });

  it('handles empty string input', () => {
    expect(postProcess('')).toBe('');
  });

  it('preserves multi-line non-DIF content verbatim', () => {
    const inp = 'line1\nline2\nline3';
    expect(postProcess(inp)).toBe(inp);
  });

  it('only strips DIF markers, not other unrelated TeX', () => {
    const inp = '\\DIFaddbegin \\toprule\n\\textbf{Bold remains}';
    const out = postProcess(inp);
    expect(out).toContain('\\textbf{Bold remains}');
    expect(out).not.toContain('DIFaddbegin');
  });

  it('strips a \\DIFaddFL{content} marker followed by whitespace (\\s* trailing)', () => {
    // The regex \DIFaddFL\{[^}]*\}\s* eats the trailing whitespace too;
    // a mutation that swaps \s* for \S* would leave it behind.
    const inp = '\\caption{x} \\DIFaddFL{added}   ';
    const out = postProcess(inp);
    expect(out).not.toMatch(/DIFaddFL/);
    expect(out).not.toMatch(/\s\s\s$/); // trailing spaces consumed
  });

  it('on a DIF-only line whose successor is plain prose, the DIF stays put', () => {
    // hasDif() is true; the next non-blank line does not match noalignCmds
    // → keep the line unchanged. Catches a mutation that always strips.
    const inp = '\\DIFaddbegin{x}\nplain prose follows';
    const out = postProcess(inp);
    expect(out).toContain('\\DIFaddbegin');
    expect(out).toContain('plain prose follows');
  });
});

describe('latexDiff (main entry)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes both temp files, calls latexdiff, and returns post-processed stdout', async () => {
    execFileMock.mockImplementation((cmd, args, opts, cb) => {
      cb(null, { stdout: 'diff output\n', stderr: '' });
    });
    const result = await latexDiff('old tex', 'new tex');
    expect(writeFileSyncMock).toHaveBeenCalledTimes(2);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe('latexdiff');
    expect(args).toContain('--type=UNDERLINE');
    expect(args).toContain('--encoding=utf8');
    expect(result).toBe('diff output\n');
  });

  it('throws when latexdiff produces no output', async () => {
    execFileMock.mockImplementation((cmd, args, opts, cb) => {
      cb(null, { stdout: '', stderr: 'something went wrong' });
    });
    await expect(latexDiff('a', 'b')).rejects.toThrow(/no output/);
  });

  it('throws when stdout is whitespace-only (covers || vs && on the no-output check)', async () => {
    execFileMock.mockImplementation((cmd, args, opts, cb) => {
      cb(null, { stdout: '   \n\t   ', stderr: '' });
    });
    await expect(latexDiff('a', 'b')).rejects.toThrow(/no output/);
  });

  it('error message for no-output includes stderr verbatim when present', async () => {
    execFileMock.mockImplementation((cmd, args, opts, cb) => {
      cb(null, { stdout: '', stderr: 'broken: foo' });
    });
    await expect(latexDiff('a', 'b')).rejects.toThrow(/broken: foo/);
  });

  it('cleans up both temp files in the finally block (success path)', async () => {
    execFileMock.mockImplementation((cmd, args, opts, cb) => {
      cb(null, { stdout: 'ok', stderr: '' });
    });
    await latexDiff('a', 'b');
    expect(unlinkSyncMock).toHaveBeenCalledTimes(2);
  });

  it('cleans up both temp files in the finally block (error path)', async () => {
    execFileMock.mockImplementation((cmd, args, opts, cb) => {
      cb(new Error('binary missing'), { stdout: '', stderr: '' });
    });
    await expect(latexDiff('a', 'b')).rejects.toThrow();
    expect(unlinkSyncMock).toHaveBeenCalledTimes(2);
  });

  it('passes options.workDir through to fs writes when supplied', async () => {
    execFileMock.mockImplementation((cmd, args, opts, cb) => {
      cb(null, { stdout: 'ok', stderr: '' });
    });
    await latexDiff('a', 'b', { workDir: '/tmp/custom-dir' });
    const paths = writeFileSyncMock.mock.calls.map((c) => c[0]);
    for (const p of paths) expect(p).toContain('/tmp/custom-dir');
  });

  it('still works when fs.unlinkSync throws on cleanup (e.g. file was already removed)', async () => {
    execFileMock.mockImplementation((cmd, args, opts, cb) => {
      cb(null, { stdout: 'ok', stderr: '' });
    });
    unlinkSyncMock.mockImplementation(() => { throw new Error('ENOENT'); });
    await expect(latexDiff('a', 'b')).resolves.toBe('ok');
  });

  it('post-processes the latexdiff output before returning', async () => {
    execFileMock.mockImplementation((cmd, args, opts, cb) => {
      cb(null, { stdout: '\\DIFaddbegin \\toprule\n', stderr: '' });
    });
    const result = await latexDiff('a', 'b');
    expect(result).not.toContain('DIFaddbegin');
    expect(result).toContain('\\toprule');
  });
});
