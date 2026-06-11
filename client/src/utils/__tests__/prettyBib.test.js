import { describe, it, expect } from 'vitest';
import prettyBib from '../prettyBib.js';

describe('prettyBib', () => {
  it('formats a basic entry', () => {
    const input = `@article{smith2024, author={John Smith}, title={A Paper}, year={2024}}`;
    const output = prettyBib(input);
    expect(output).toContain('@article{smith2024,');
    expect(output).toContain('author');
    expect(output).toContain('title');
    expect(output).toContain('year');
    expect(output).toMatch(/\n$/); // ends with newline
  });

  it('normalizes entry types to lowercase', () => {
    const input = `@Article{key, author={A}, title={B}}`;
    expect(prettyBib(input)).toMatch(/^@article\{/);
  });

  it('lowercases field names', () => {
    const input = `@article{key, Author={A}, Title={B}}`;
    const output = prettyBib(input);
    expect(output).toContain('author');
    expect(output).toContain('title');
    expect(output).not.toContain('Author');
  });

  it('aligns field values', () => {
    const input = `@article{key, author={A}, year={2024}}`;
    const output = prettyBib(input);
    const lines = output.split('\n').filter((l) => l.includes('='));
    // Both "author" and "year" should be padded to same width
    const eqPositions = lines.map((l) => l.indexOf('='));
    expect(new Set(eqPositions).size).toBe(1); // all = signs align
  });

  it('converts quoted values to braced', () => {
    const input = `@article{key, title="My Paper"}`;
    const output = prettyBib(input);
    expect(output).toContain('{My Paper}');
    expect(output).not.toContain('"');
  });

  it('wraps bare numbers in braces', () => {
    const input = `@article{key, year=2024}`;
    expect(prettyBib(input)).toContain('{2024}');
  });

  it('handles @string entries', () => {
    const input = `@string{jrnl = {Journal of Something}}`;
    const output = prettyBib(input);
    expect(output).toContain('@string{');
    expect(output).toContain('jrnl');
  });

  it('handles @preamble entries', () => {
    const input = `@preamble{some preamble text}`;
    expect(prettyBib(input)).toContain('@preamble{');
  });

  it('handles @comment entries', () => {
    const input = `@comment{this is a comment}`;
    expect(prettyBib(input)).toContain('@comment{');
  });

  it('handles nested braces in values', () => {
    const input = `@article{key, title={A {B} C}}`;
    const output = prettyBib(input);
    expect(output).toContain('{A {B} C}');
  });

  it('handles macro concatenation with #', () => {
    const input = `@article{key, journal=jrnl # { Extra}}`;
    const output = prettyBib(input);
    expect(output).toContain('#');
  });

  it('handles empty input', () => {
    expect(prettyBib('')).toBe('\n');
  });

  it('preserves non-entry comments', () => {
    const input = `% This is a comment\n\n@article{key, title={A}}`;
    const output = prettyBib(input);
    expect(output).toContain('% This is a comment');
  });

  it('handles multiple entries', () => {
    const input = `@article{a, title={First}}
@inproceedings{b, title={Second}}`;
    const output = prettyBib(input);
    expect(output).toContain('@article{a,');
    expect(output).toContain('@inproceedings{b,');
  });

  it('handles entries with many fields', () => {
    const input = `@article{key, author={A}, title={B}, year={2024}, journal={J}, volume={1}, pages={1--10}}`;
    const output = prettyBib(input);
    expect(output.split('\n').filter((l) => l.includes('=')).length).toBe(6);
  });

  // Termination guarantees. Mutation testing produced 67 timeout mutants
  // against the original file; the root cause was a missing forward-
  // progress branch in readFieldValue's else arm when src[i] is none of
  // {, ", digit, #, ',', '}', or a macro-name char. Without that
  // guarantee, a stray `:` / `;` / `<` inside an unquoted value spins
  // the outer while-loop forever. These tests pin the fix.

  it('terminates on a malformed unquoted value containing a colon', () => {
    // Pre-fix: this input infinite-loops at the ':' between 'bar' and
    // 'baz' inside readFieldValue. Post-fix: the stray character is
    // consumed verbatim and the pretty-print completes.
    const input = `@article{key, foo = bar:baz}`;
    expect(() => prettyBib(input)).not.toThrow();
    const out = prettyBib(input);
    expect(out).toContain('@article{key,');
    expect(out).toContain('foo');
  });

  it('terminates on a malformed value containing a semicolon', () => {
    const input = `@article{key, foo = a;b}`;
    expect(() => prettyBib(input)).not.toThrow();
  });

  it('terminates on a malformed value with a non-ascii character outside the macro charset', () => {
    // A character like '<' or '%' isn't in [a-zA-Z0-9_], isn't a digit,
    // not in the structural set ({ " # , }), so the same loop would
    // wedge without a fallback i++.
    expect(() => prettyBib('@article{k, foo = a<b}')).not.toThrow();
    expect(() => prettyBib('@article{k, foo = a%b}')).not.toThrow();
  });

  it('completes within a generous deadline on every malformed-value shape (defensive)', () => {
    // Sanity wall-clock: even if a future mutation re-introduces a slow
    // path, anything that takes more than a few seconds on a one-line
    // input is broken. (vitest's default test timeout would otherwise
    // also catch this; we keep the explicit check so the failure
    // message clearly says "termination".)
    const start = Date.now();
    prettyBib('@article{k, foo = a:b:c:d:e:f:g}');
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
