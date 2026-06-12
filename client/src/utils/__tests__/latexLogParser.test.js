import { describe, it, expect } from 'vitest';
import parseLog from '../latexLogParser.js';

describe('parseLog', () => {
  it('returns empty errors/warnings for empty input', () => {
    expect(parseLog('')).toEqual({ errors: [], warnings: [] });
  });

  it('returns empty errors/warnings for null/undefined', () => {
    expect(parseLog(null)).toEqual({ errors: [], warnings: [] });
    expect(parseLog(undefined)).toEqual({ errors: [], warnings: [] });
  });

  it('returns empty when the log has only chatter (no ! and no warnings)', () => {
    const log = `This is pdfTeX, Version 3.14159265-2.6-1.40.21
(./main.tex
LaTeX2e <2020-02-02>
Document Class: article 2019/12/20 v1.4l
)
Output written on main.pdf (1 page).`;
    expect(parseLog(log)).toEqual({ errors: [], warnings: [] });
  });

  it('captures an error line starting with "!" and strips the "! " prefix, with source-context tail appended', () => {
    const log = `(./main.tex
! Undefined control sequence.
l.42 \\nonexistent
                 .
)`;
    const { errors } = parseLog(log);
    expect(errors).toHaveLength(1);
    // The parser now appends the source-context tail (the "\nonexistent"
    // part of "l.42 \\nonexistent") to the message so the rule matcher
    // can extract the command name.
    expect(errors[0].text).toContain('Undefined control sequence.');
    expect(errors[0].text).toContain('\\nonexistent');
  });

  it('attaches the line number from the "l.NNN" context line that follows the error', () => {
    const log = `(./main.tex
! Undefined control sequence.
l.42 \\nonexistent
                 .
)`;
    const { errors } = parseLog(log);
    expect(errors[0].line).toBe(42);
  });

  it('attaches the file from the most-recent "(./file.tex" frame', () => {
    const log = `(./main.tex
(./chapter1.tex
! Missing $ inserted.
l.7 x^2
)
)`;
    const { errors } = parseLog(log);
    // The parser keeps the leading './' the LaTeX log emits (it's part of
    // the captured path); strip both for comparison.
    expect(errors[0].file?.replace(/^\.\//, '')).toBe('chapter1.tex');
  });

  it('pops the file stack on ")" so the next error attributes to the outer file', () => {
    const log = `(./main.tex
(./chapter1.tex
)
! Missing \\end{document}.
l.99
)`;
    const { errors } = parseLog(log);
    expect(errors[0].file?.replace(/^\.\//, '')).toBe('main.tex');
  });

  it('strips the compile-job suffix from filenames in the file context', () => {
    // The driver names files with an 8-hex suffix like main_3b551ace.tex
    // during compile; the parser must surface the user-visible name.
    const log = `(./main_3b551ace.tex
! Undefined control sequence.
l.5 \\x
)`;
    const { errors } = parseLog(log);
    expect(errors[0].file?.replace(/^\.\//, '')).toBe('main.tex');
  });

  it('strips the compile-job suffix from error message TEXT too', () => {
    const log = `! LaTeX Error: File main_3b551ace.aux not found.`;
    const { errors } = parseLog(log);
    expect(errors[0].text).toBe('LaTeX Error: File main.aux not found.');
  });

  it('captures a LaTeX Warning on a single line', () => {
    const log = `(./main.tex
LaTeX Warning: Reference \`fig:foo' on page 1 undefined on input line 23.
)`;
    const { warnings } = parseLog(log);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].text).toMatch(/Reference `fig:foo'/);
  });

  it('extracts an input-line number from a warning into warning.line', () => {
    const log = `LaTeX Warning: Reference \`x\' on page 1 undefined on input line 23.`;
    const { warnings } = parseLog(log);
    expect(warnings[0].line).toBe(23);
  });

  it('captures Package <name> Warning entries (e.g. hyperref, acmart)', () => {
    const log = `Package hyperref Warning: Token not allowed in a PDFDocEncoded string on line 5.`;
    const { warnings } = parseLog(log);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].text).toMatch(/^Package hyperref Warning:/);
  });

  it('joins continuation lines of a multi-line Package Warning into one text', () => {
    const log = `Package biblatex Warning: Please rerun LaTeX.
(biblatex)                See manual section 5.5 for details.`;
    const { warnings } = parseLog(log);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].text).toContain('Please rerun LaTeX.');
    expect(warnings[0].text).toContain('See manual section 5.5 for details.');
    // The "(biblatex)" prefix must be stripped from the continuation.
    expect(warnings[0].text).not.toContain('(biblatex)');
  });

  it('captures Overfull/Underfull \\hbox warnings', () => {
    const log = `Overfull \\hbox (12.34pt too wide) in paragraph at lines 100--105`;
    const { warnings } = parseLog(log);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].text).toMatch(/^Overfull \\hbox/);
    expect(warnings[0].line).toBe(100);
  });

  it('deduplicates errors with the same {text, line, file} key', () => {
    const log = `(./main.tex
! Undefined control sequence.
l.42 \\foo

! Undefined control sequence.
l.42 \\foo
)`;
    const { errors } = parseLog(log);
    expect(errors).toHaveLength(1);
  });

  it('does NOT dedupe errors that differ only in the line number', () => {
    const log = `(./main.tex
! Undefined control sequence.
l.42 \\foo

! Undefined control sequence.
l.99 \\bar
)`;
    const { errors } = parseLog(log);
    expect(errors).toHaveLength(2);
  });

  it('suppresses known-harmless biblatex backend errors in .aux/.bbl files', () => {
    const log = `(./main.bbl
! Extra }, or forgotten \\endgroup.
l.10 }
)`;
    const { errors } = parseLog(log);
    expect(errors).toEqual([]);
  });

  it('does NOT suppress the same error class on a USER (.tex) file', () => {
    const log = `(./main.tex
! Extra }, or forgotten \\endgroup.
l.10 }
)`;
    const { errors } = parseLog(log);
    expect(errors).toHaveLength(1);
  });

  it('marks errors from system files (.sty / .cls / .aux / .bbl / etc.) with isSystemFile=true', () => {
    const log = `(./main.tex
(./foo.sty
! Some package error.
l.5
)
)`;
    const { errors } = parseLog(log);
    expect(errors[0].isSystemFile).toBe(true);
  });

  it('marks errors from user .tex files with isSystemFile=false', () => {
    const log = `(./main.tex
! Some user error.
l.5
)`;
    const { errors } = parseLog(log);
    expect(errors[0].isSystemFile).toBe(false);
  });

  it('does NOT treat package-description lines as warnings (they contain "Package <name>" but not "Warning")', () => {
    const log = `Package: hyperref 2022/02/21 v7.00n Hypertext links for LaTeX`;
    expect(parseLog(log).warnings).toEqual([]);
  });
});
