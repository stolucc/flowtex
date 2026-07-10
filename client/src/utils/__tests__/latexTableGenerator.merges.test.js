import { describe, it, expect } from 'vitest';
import generateLatexTable from '../latexTableGenerator.js';

// The table builder flags `multirow` as a required package when a merge
// spans rows. These tests pin the premise behind that: a row-spanning
// merge emits \multirow (which needs the package), while a column-only
// span emits \multicolumn (core LaTeX — intentionally NOT flagged).

function gen(overrides = {}) {
  return generateLatexTable({
    rows: 2,
    cols: 2,
    colSettings: [{ align: 'l' }, { align: 'l' }],
    borders: 'none',
    headerRow: false,
    env: 'tabular',
    cells: [['a', 'b'], ['c', 'd']],
    merges: [],
    vlines: [],
    clines: [],
    ...overrides,
  });
}

describe('latexTableGenerator — merges vs package requirement', () => {
  it('a ROW-spanning merge emits \\multirow (→ needs multirow package)', () => {
    const out = gen({ merges: [{ row: 0, col: 0, rowSpan: 2, colSpan: 1 }] });
    expect(out).toContain('\\multirow');
  });

  it('a COLUMN-only span emits \\multicolumn but NOT \\multirow (no package)', () => {
    const out = gen({ merges: [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }] });
    expect(out).toContain('\\multicolumn');
    expect(out).not.toContain('\\multirow');
  });

  it('a row+column span emits both (still needs multirow)', () => {
    const out = gen({ rows: 2, cols: 2, merges: [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }] });
    expect(out).toContain('\\multirow');
    expect(out).toContain('\\multicolumn');
  });

  it('no merges → neither', () => {
    const out = gen();
    expect(out).not.toContain('\\multirow');
    expect(out).not.toContain('\\multicolumn');
  });

  // Mirrors TableGridPicker's requirement predicate.
  it('the "needs multirow" predicate is: any merge with rowSpan > 1', () => {
    const needsMultirow = (merges) => (merges || []).some((m) => m.rowSpan > 1);
    expect(needsMultirow([{ rowSpan: 1, colSpan: 3 }])).toBe(false); // column span only
    expect(needsMultirow([{ rowSpan: 2, colSpan: 1 }])).toBe(true);
    expect(needsMultirow([])).toBe(false);
  });
});
