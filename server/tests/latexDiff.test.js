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

  // The regex collapses one whitespace on either side of the marker into a
  // single space so adjacent tokens don't run together when a marker is
  // sandwiched between non-whitespace.
  it('strips DIF markers from lines containing \\midrule', () => {
    const out = postProcess('\\DIFdelbegin \\midrule \\DIFdelend');
    expect(out).toBe(' \\midrule ');
  });

  it('strips DIF markers from lines containing \\bottomrule', () => {
    expect(postProcess('\\DIFaddbegin \\bottomrule')).toBe(' \\bottomrule');
  });

  it('strips DIF markers from lines containing \\caption', () => {
    expect(postProcess('\\DIFaddbeginFL \\caption{Hi}'))
      .toBe(' \\caption{Hi}');
  });

  it('strips DIF markers from lines containing \\addlinespace', () => {
    expect(postProcess('\\addlinespace \\DIFdelendFL')).toBe('\\addlinespace ');
  });

  it('strips DIF markers from lines containing \\endhead', () => {
    expect(postProcess('row \\\\ \\DIFaddbegin \\endhead'))
      .toBe('row \\\\ \\endhead');
  });

  it('strips DIF markers from lines containing \\endfirsthead', () => {
    expect(postProcess('\\DIFaddbegin \\endfirsthead')).toBe(' \\endfirsthead');
  });

  it('strips DIF markers from lines containing \\endfoot', () => {
    expect(postProcess('\\DIFdelbegin \\endfoot')).toBe(' \\endfoot');
  });

  it('strips DIF markers from lines containing \\endlastfoot', () => {
    expect(postProcess('\\DIFaddend \\endlastfoot')).toBe(' \\endlastfoot');
  });

  it('strips DIF markers from lines containing \\multicolumn (omit case)', () => {
    expect(postProcess('\\DIFaddbegin \\multicolumn{2}{c}{x}'))
      .toBe(' \\multicolumn{2}{c}{x}');
  });

  it('strips DIF markers from lines containing \\multirow (omit case)', () => {
    expect(postProcess('\\DIFdelbegin \\multirow{3}{*}{x}'))
      .toBe(' \\multirow{3}{*}{x}');
  });

  it('preserves a single space when a marker is sandwiched between non-whitespace tokens', () => {
    // The whole motivation for the fix: `prefix\DIFaddbegin foo` and
    // `prefix \DIFaddbegin foo` should both yield words separated by one
    // space — not collapse into `prefixfoo`.
    expect(postProcess('prefix\\DIFaddbegin foo \\toprule')).toBe('prefix foo \\toprule');
    expect(postProcess('prefix \\DIFaddbeginfoo \\toprule')).toMatch(/^prefix /);
  });

  it('does not introduce a phantom space when neither side has whitespace', () => {
    // No leading or trailing whitespace at all: replacement is empty.
    expect(postProcess('a\\DIFaddbeginb \\midrule')).toBe('ab \\midrule');
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

  it('strips a \\DIFaddFL{content} marker; whitespace becomes single separator', () => {
    // The marker is replaced by a single space when surrounded by whitespace,
    // not by an empty string — so adjacent tokens never run together.
    const inp = '\\caption{x} \\DIFaddFL{added} more';
    const out = postProcess(inp);
    expect(out).not.toMatch(/DIFaddFL/);
    expect(out).toBe('\\caption{x} more');
  });

  it('on a DIF-only line whose successor is plain prose, the DIF stays put', () => {
    // hasDif() is true; the next non-blank line does not match noalignCmds
    // → keep the line unchanged. Catches a mutation that always strips.
    const inp = '\\DIFaddbegin{x}\nplain prose follows';
    const out = postProcess(inp);
    expect(out).toContain('\\DIFaddbegin');
    expect(out).toContain('plain prose follows');
  });

  it('strips a \\DIFaddFL{...} marker with NO surrounding whitespace down to empty', () => {
    // The (\s)? groups in the DIFaddFL regex are optional; with non-whitespace
    // on both sides the replacement must be '' (not a space), or adjacent
    // tokens gain a phantom separator.
    expect(postProcess('\\caption{x}a\\DIFaddFL{added}b')).toBe('\\caption{x}ab');
  });

  it('treats a whitespace-only line as blank when scanning for the noalign successor', () => {
    // nextNonBlank uses lines[j].trim() !== '' — a spaces-only line must be
    // skipped so the \toprule beyond it is still found (and the marker dropped).
    expect(postProcess('\\DIFaddbegin\n   \n\\toprule')).toBe('   \n\\toprule');
  });

  it('does not drop a plain blank line that merely precedes a noalign command', () => {
    // The hasDif(line) guard: a blank, non-DIF line before \toprule must be
    // left intact, not run through the strip-and-maybe-drop path.
    expect(postProcess('\n\\toprule')).toBe('\n\\toprule');
  });

  it('keeps a DIF line that still has real content after stripping, even with a noalign successor', () => {
    // stripped.trim() === '' decides drop-vs-keep. Stripping "text \DIFaddbegin
    // more" leaves "text more" — non-empty — so the line is kept, not dropped.
    expect(postProcess('text \\DIFaddbegin more\n\\toprule')).toBe('text more\n\\toprule');
  });

  it('drops a DIF line that strips down to a lone space when a noalign line follows', () => {
    // The marker has trailing whitespace, so stripDif yields ' '. .trim() makes
    // that '' → the line is dropped. Without .trim() it would linger as ' '.
    expect(postProcess('\\DIFaddbegin \n\\toprule')).toBe('\\toprule');
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

  it('prepends every TeX Live bin dir to PATH, ahead of the inherited PATH', async () => {
    execFileMock.mockImplementation((cmd, args, opts, cb) => cb(null, { stdout: 'ok', stderr: '' }));
    await latexDiff('a', 'b');
    const opts = execFileMock.mock.calls[0][2];
    for (const p of [
      '/Library/TeX/texbin',
      '/usr/local/texlive/2025/bin/universal-darwin',
      '/usr/local/bin',
      '/opt/local/bin',
    ]) {
      expect(opts.env.PATH).toContain(p);
    }
    // TeX dirs must come first (so the bundled latexdiff wins over any other),
    // joined by ':' and followed by the inherited PATH.
    expect(opts.env.PATH.startsWith('/Library/TeX/texbin:')).toBe(true);
    expect(opts.env.PATH).toContain(':' + (process.env.PATH || ''));
  });

  it('passes a 30s timeout, 50MB maxBuffer, and cwd=workDir to execFile', async () => {
    execFileMock.mockImplementation((cmd, args, opts, cb) => cb(null, { stdout: 'ok', stderr: '' }));
    await latexDiff('a', 'b', { workDir: '/tmp/custom-wd' });
    const opts = execFileMock.mock.calls[0][2];
    expect(opts.timeout).toBe(30000);
    expect(opts.maxBuffer).toBe(50 * 1024 * 1024);
    expect(opts.cwd).toBe('/tmp/custom-wd');
  });

  it('writes the temp files under the documented __diff_old__/__diff_new__ names with the right content', async () => {
    execFileMock.mockImplementation((cmd, args, opts, cb) => cb(null, { stdout: 'ok', stderr: '' }));
    await latexDiff('OLD-CONTENT', 'NEW-CONTENT', { workDir: '/tmp/custom-wd' });
    const byName = Object.fromEntries(
      writeFileSyncMock.mock.calls.map(([p, content]) => [p.split('/').pop(), content]),
    );
    expect(byName['__diff_old__.tex']).toBe('OLD-CONTENT');
    expect(byName['__diff_new__.tex']).toBe('NEW-CONTENT');
  });

  it('separates the no-output message from stderr with ": "', async () => {
    execFileMock.mockImplementation((cmd, args, opts, cb) => cb(null, { stdout: '', stderr: 'detail here' }));
    // Pins the exact ": " joiner — a mutation dropping it would still match
    // a loose /no output/ check, so assert the whole string.
    await expect(latexDiff('a', 'b')).rejects.toThrow('latexdiff produced no output: detail here');
  });
});
