import { describe, it, expect } from 'vitest';
import { stripPendingDeletions, wrapPendingChangesAsMacros, injectTcMacros } from '../utils/tcMarks.js';

describe('stripPendingDeletions', () => {
  it('returns content unchanged when no marks', () => {
    expect(stripPendingDeletions('hello', null)).toBe('hello');
    expect(stripPendingDeletions('hello', [])).toBe('hello');
    expect(stripPendingDeletions('hello', undefined)).toBe('hello');
  });

  it('keeps ins ranges; only strips del ranges', () => {
    expect(
      stripPendingDeletions('hello world', [
        { id: 'a', type: 'ins', from: 0, to: 5 },
        { id: 'b', type: 'del', from: 6, to: 11 },
      ]),
    ).toBe('hello ');
  });

  it('strips a single del range from the middle', () => {
    expect(
      stripPendingDeletions('foobarbaz', [{ id: 'd', type: 'del', from: 3, to: 6 }]),
    ).toBe('foobaz');
  });

  it('strips multiple non-overlapping del ranges in order', () => {
    expect(
      stripPendingDeletions('AXBYC', [
        { id: 'a', type: 'del', from: 1, to: 2 },
        { id: 'b', type: 'del', from: 3, to: 4 },
      ]),
    ).toBe('ABC');
  });

  it('handles overlapping del ranges by merging them', () => {
    expect(
      stripPendingDeletions('abcdef', [
        { id: 'a', type: 'del', from: 1, to: 3 },
        { id: 'b', type: 'del', from: 2, to: 5 },
      ]),
    ).toBe('af');
  });

  it('clamps out-of-bounds ranges defensively', () => {
    expect(
      stripPendingDeletions('hi', [{ id: 'd', type: 'del', from: 1, to: 99 }]),
    ).toBe('h');
  });

  it('wrapPendingChangesAsMacros wraps ins with \\TCadd and del with \\TCdel', () => {
    expect(
      wrapPendingChangesAsMacros('hello world', [
        { type: 'ins', from: 0, to: 5 },
        { type: 'del', from: 6, to: 11 },
      ]),
    ).toBe('\\TCadd{hello} \\TCdel{world}');
  });

  it('wrapPendingChangesAsMacros leaves unmarked text untouched', () => {
    expect(
      wrapPendingChangesAsMacros('AbcD', [{ type: 'ins', from: 1, to: 3 }]),
    ).toBe('A\\TCadd{bc}D');
  });

  it('injectTcMacros adds preamble after \\documentclass', () => {
    const out = injectTcMacros('\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}\n');
    expect(out).toContain('\\providecommand{\\TCadd}');
    expect(out).toContain('\\providecommand{\\TCdel}');
    expect(out.indexOf('\\documentclass')).toBeLessThan(out.indexOf('\\providecommand'));
  });

  it('injectTcMacros is idempotent (skips if \\TCadd is already defined)', () => {
    const src = '\\documentclass{article}\n\\providecommand{\\TCadd}[1]{custom}\n';
    expect(injectTcMacros(src)).toBe(src);
  });

  it('drops invalid/empty del entries', () => {
    expect(
      stripPendingDeletions('abc', [
        { id: 'a', type: 'del', from: 1, to: 1 }, // empty
        { id: 'b', type: 'del', from: 2, to: 1 }, // inverted
        { id: 'c', type: 'del' }, // missing positions
      ]),
    ).toBe('abc');
  });
});
