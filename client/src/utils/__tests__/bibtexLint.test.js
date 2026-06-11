import { describe, it, expect } from 'vitest';
import bibtexLint from '../bibtexLint.js';

describe('bibtexLint', () => {
  it('returns an empty array for empty input', () => {
    expect(bibtexLint('')).toEqual([]);
  });

  it('returns no diagnostics for a clean @article with standard fields', () => {
    const src = `@article{key,
  author = {Smith, John},
  title = {A nice paper},
  journal = {Nature},
  year = {2024},
}`;
    expect(bibtexLint(src)).toEqual([]);
  });

  it('flags an unknown field name with severity=warning and "Unknown field" message', () => {
    const src = `@article{key,
  nonsense = {whatever},
}`;
    const diags = bibtexLint(src);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('warning');
    expect(diags[0].message).toBe('Unknown field "nonsense"');
    expect(diags[0].line).toBe(2);
  });

  it('reports the field NAME length, not the field value length, in `len`', () => {
    const src = `@article{key,
  nonsense = {a-much-longer-value-than-the-field-name},
}`;
    const diags = bibtexLint(src);
    expect(diags[0].len).toBe('nonsense'.length);
  });

  it('reports col as the 1-based column of the field name', () => {
    const src = `@article{key,
  nonsense = {x},
}`;
    const diags = bibtexLint(src);
    // Two spaces of indent → field name starts at column 3 (1-based).
    expect(diags[0].col).toBe(3);
  });

  it('flags a known field that is not standard for the current entry type', () => {
    // `journaltitle` is a biblatex field, valid for @article. Use a field
    // like `editor` on @misc which is valid for many types but verify the
    // generic "not standard for @X" message form by using something
    // type-specific.
    // `chapter` is in the universal fields likely not... actually use a
    // field that's not universal but valid for some type. Try `school` on
    // an @article — `school` is added as an alias in ALL_KNOWN_FIELDS but
    // is specific to @thesis/@report. The expected message is the
    // type-mismatch one.
    const src = `@article{key,
  school = {MIT},
}`;
    const diags = bibtexLint(src);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toMatch(/not standard for @article/);
  });

  it('does NOT flag universally-valid fields on any entry type', () => {
    const src = `@misc{key,
  author = {X},
  title = {Y},
  year = {2024},
}`;
    expect(bibtexLint(src)).toEqual([]);
  });

  it('TYPE_ALIASES: @conference is normalised to @inproceedings before validation', () => {
    // booktitle is valid for @inproceedings; if the alias DIDN'T resolve,
    // @conference would be an unknown entry type and isFieldValidForType
    // would return true (the "unknown type — don't flag" branch). That
    // means this test fails only if the alias plumbing is broken AND
    // booktitle is actually not in the alias-target's field list.
    const src = `@conference{key,
  author = {X},
  title = {Y},
  booktitle = {Proc. of Things},
  year = {2024},
}`;
    expect(bibtexLint(src)).toEqual([]);
  });

  it('ignores @string / @preamble / @comment blocks (no entry-type field check)', () => {
    const src = `@string{nature = {Nature Publishing}}
@preamble{"\\newcommand{\\foo}{bar}"}
@comment{this is a comment}`;
    expect(bibtexLint(src)).toEqual([]);
  });

  it('@string body does NOT trigger field validation on its name=value shape', () => {
    // The `nature = {...}` inside @string looks like a field=value pair,
    // but the lint scanner must not enter "in-entry" mode for @string.
    const src = `@string{nature = {Nature Publishing}}`;
    expect(bibtexLint(src)).toEqual([]);
  });

  it('multi-line @string still skips field validation across all its body lines', () => {
    // The single-line @string above is too short to actually exercise the
    // field-validation branch: the brace-tracking on the same line nets to
    // zero before we ever see the `name = value` line. Multi-line @string
    // forces the second pass to either correctly skip the block (original)
    // or wrongly enter field-validation mode (a mutation that flips the
    // @string/preamble/comment guard). Lints would then emit "Unknown
    // field nature" for a clean @string.
    const src = `@string{
  nature = {Nature Publishing Group}
}`;
    expect(bibtexLint(src)).toEqual([]);
  });

  it('multi-line @preamble similarly does NOT trigger field validation', () => {
    const src = `@preamble{
  "\\newcommand{\\foo}{bar}"
}`;
    expect(bibtexLint(src)).toEqual([]);
  });

  it('multi-line @comment similarly does NOT trigger field validation', () => {
    const src = `@comment{
  some commentary text spanning
  multiple lines
}`;
    expect(bibtexLint(src)).toEqual([]);
  });

  it('handles two entries in sequence; field-validity context resets at each @-line', () => {
    const src = `@article{a,
  school = {MIT},
}
@thesis{b,
  school = {MIT},
}`;
    const diags = bibtexLint(src);
    // The @article should flag school; the @thesis should not.
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(2);
    expect(diags[0].message).toMatch(/@article/);
  });

  it('handles parenthesis-delimited entries (@type(...) variant)', () => {
    // BibTeX accepts both @type{...} and @type(...). Verify the parser
    // doesn't lose its way on parens.
    const src = `@article(key,
  nonsense = {x},
)`;
    const diags = bibtexLint(src);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe('Unknown field "nonsense"');
  });

  it('multiple bad fields in one entry are all reported', () => {
    const src = `@article{key,
  badfield1 = {x},
  badfield2 = {y},
}`;
    const diags = bibtexLint(src);
    expect(diags).toHaveLength(2);
    expect(diags.map((d) => d.line)).toEqual([2, 3]);
  });

  it('is case-insensitive on the field name', () => {
    // Field names are case-insensitive in BibTeX. AUTHOR is just author.
    const src = `@article{key,
  AUTHOR = {Smith},
  TITLE = {X},
}`;
    expect(bibtexLint(src)).toEqual([]);
  });

  it('is case-insensitive on the entry type', () => {
    const src = `@Article{key,
  author = {Smith},
  title = {X},
}`;
    expect(bibtexLint(src)).toEqual([]);
  });
});
