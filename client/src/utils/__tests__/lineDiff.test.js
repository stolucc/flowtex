import { describe, it, expect } from 'vitest';
import lineDiff from '../lineDiff.js';

// Helper to project the diff to a string per-line tag for compact assertions.
// 's' = same, 'a' = add, 'r' = remove.
/** @param {ReturnType<typeof lineDiff>} d */
function tags(d) {
  return d.map((x) => x.type[0]).join('');
}

describe('lineDiff', () => {
  it('returns all "same" entries when the inputs are identical', () => {
    const out = lineDiff('a\nb\nc', 'a\nb\nc');
    expect(out).toHaveLength(3);
    expect(out.every((x) => x.type === 'same')).toBe(true);
    expect(out.map((x) => x.text)).toEqual(['a', 'b', 'c']);
  });

  it('returns all "same" for two empty strings (single empty line)', () => {
    const out = lineDiff('', '');
    expect(out).toEqual([{ type: 'same', text: '' }]);
  });

  it('pure insertion: empty old → new produces all "add"', () => {
    const out = lineDiff('', 'a\nb\nc');
    // Empty string splits to [''], one line. New has 4 lines (incl. the
    // synthetic empty first). The first '' matches → 'same'; the rest add.
    // Verify the count of adds is the new line count minus the matched ''.
    const adds = out.filter((x) => x.type === 'add').map((x) => x.text);
    expect(adds).toEqual(['a', 'b', 'c']);
  });

  it('pure deletion: new is empty → all old lines marked "remove"', () => {
    const out = lineDiff('a\nb\nc', '');
    const removes = out.filter((x) => x.type === 'remove').map((x) => x.text);
    expect(removes).toEqual(['a', 'b', 'c']);
  });

  it('middle insertion: a\\nb → a\\nx\\nb gets one "add"', () => {
    const out = lineDiff('a\nb', 'a\nx\nb');
    expect(tags(out)).toBe('sas');
    expect(out[1]).toEqual({ type: 'add', text: 'x' });
  });

  it('middle deletion: a\\nx\\nb → a\\nb gets one "remove"', () => {
    const out = lineDiff('a\nx\nb', 'a\nb');
    expect(tags(out)).toBe('srs');
    expect(out[1]).toEqual({ type: 'remove', text: 'x' });
  });

  it('replacement is represented as remove-then-add (no "modify" type)', () => {
    const out = lineDiff('a\nold\nb', 'a\nnew\nb');
    // Should produce one add and one remove regardless of their relative order.
    const adds = out.filter((x) => x.type === 'add').map((x) => x.text);
    const removes = out.filter((x) => x.type === 'remove').map((x) => x.text);
    expect(adds).toEqual(['new']);
    expect(removes).toEqual(['old']);
    // And the surrounding lines remain matched.
    const sames = out.filter((x) => x.type === 'same').map((x) => x.text);
    expect(sames).toEqual(['a', 'b']);
  });

  it('preserves the total set of new lines (all "same"+"add" reconstruct new)', () => {
    const oldT = 'apple\nbanana\ncherry\ndate';
    const newT = 'banana\ncherry\ndate\nelderberry';
    const out = lineDiff(oldT, newT);
    const reconstructedNew = out
      .filter((x) => x.type === 'same' || x.type === 'add')
      .map((x) => x.text)
      .join('\n');
    expect(reconstructedNew).toBe(newT);
  });

  it('preserves the total set of old lines (all "same"+"remove" reconstruct old)', () => {
    const oldT = 'apple\nbanana\ncherry\ndate';
    const newT = 'banana\ncherry\ndate\nelderberry';
    const out = lineDiff(oldT, newT);
    const reconstructedOld = out
      .filter((x) => x.type === 'same' || x.type === 'remove')
      .map((x) => x.text)
      .join('\n');
    expect(reconstructedOld).toBe(oldT);
  });

  it('handles duplicate lines without spuriously matching them across positions', () => {
    // 'x' appears once in old and twice in new; the diff has to add the
    // extra 'x' rather than rearrange the surrounding context.
    const out = lineDiff('a\nx\nb', 'a\nx\nx\nb');
    expect(tags(out)).toMatch(/^s.a?s|^ssa+s$/);
    const adds = out.filter((x) => x.type === 'add').map((x) => x.text);
    expect(adds).toEqual(['x']);
  });

  it('keeps blank lines as first-class diff entries', () => {
    const out = lineDiff('a\n\nb', 'a\nb');
    // The blank line is a removal.
    const removes = out.filter((x) => x.type === 'remove').map((x) => x.text);
    expect(removes).toEqual(['']);
  });

  it('reorderings produce remove+add (algorithm is positional, not set-based)', () => {
    // Reversing 'a,b,c' to 'c,b,a': there's no common subsequence of length
    // > 1 since the relative order of every pair is inverted. The LCS
    // implementation will pick exactly ONE line to keep as "same" and
    // remove+add the other two. Which line gets picked is an
    // implementation detail; assert the invariants instead.
    const out = lineDiff('a\nb\nc', 'c\nb\na');
    const sames = out.filter((x) => x.type === 'same').map((x) => x.text);
    expect(sames).toHaveLength(1);
    const adds = out.filter((x) => x.type === 'add').map((x) => x.text).sort();
    const removes = out.filter((x) => x.type === 'remove').map((x) => x.text).sort();
    // The two lines NOT chosen as same must each appear as a remove AND
    // as an add (no line is silently dropped).
    expect(adds).toEqual(removes);
    expect(adds).toHaveLength(2);
  });

  it('handles a single-line file with no newline', () => {
    expect(lineDiff('hello', 'hello')).toEqual([{ type: 'same', text: 'hello' }]);
    const out = lineDiff('hello', 'world');
    expect(out.find((x) => x.type === 'remove')).toEqual({ type: 'remove', text: 'hello' });
    expect(out.find((x) => x.type === 'add')).toEqual({ type: 'add', text: 'world' });
  });

  it('handles many lines (exercise the hash-path branch with > 10M cells)', () => {
    // m * n > 10000000 triggers the hashLineDiff branch. Use ~3500 x 3500
    // identical-prefix lines so the anchors path resolves quickly.
    const same = Array.from({ length: 3500 }, (_, i) => `line ${i}`).join('\n');
    const newSame = same + '\nextra';
    const out = lineDiff(same, newSame);
    // The extra line must be an 'add'; everything else is 'same'.
    const adds = out.filter((x) => x.type === 'add').map((x) => x.text);
    expect(adds).toEqual(['extra']);
    const removes = out.filter((x) => x.type === 'remove');
    expect(removes).toEqual([]);
  });
});
