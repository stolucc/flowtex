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
});
