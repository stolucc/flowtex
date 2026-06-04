import { describe, it, expect } from 'vitest';

// V1 (audit round 7): the audit-log CSV export must neutralise
// spreadsheet-formula injection. User-controlled data (e.g. the MFA
// trust-device User-Agent header) lands in audit_log.detail; an
// admin opening the export in Excel / LibreOffice Calc would
// otherwise execute attacker-supplied formulas.

import { escapeCsv } from '../routes/admin.js';

describe('escapeCsv — V1 CSV-formula injection mitigation', () => {
  it.each([
    ['=cmd|"/c calc"!A1', "'=cmd|\"/c calc\"!A1"],
    ['=1+1', "'=1+1"],
    ['+1+1', "'+1+1"],
    ['-1+1', "'-1+1"],
    ['@SUM(1,1)', "'@SUM(1,1)"],
    ['\t=hidden', "'\t=hidden"],
    ['\r=carriage', "'\r=carriage"],
  ])('prefixes %s with a single quote', (input, expectedAfterPrefix) => {
    const out = escapeCsv(input);
    // The cell may also need quote-wrapping if it contains a comma/quote/
    // newline; check it starts with the apostrophe regardless.
    expect(out.startsWith("'") || out.startsWith('"')).toBe(true);
    if (out.startsWith('"')) {
      // Quote-wrapped form: the cell content (between the outer quotes)
      // still starts with the apostrophe.
      expect(out.slice(1)).toMatch(/^'/);
    } else {
      expect(out).toBe(expectedAfterPrefix);
    }
  });

  it.each([
    ['plain text', 'plain text'],
    ['number 42', 'number 42'],
    ['equation is x=5', 'equation is x=5'], // = not at start -> safe
    ['', ''],
  ])('leaves benign content untouched: %s', (input, expected) => {
    expect(escapeCsv(input)).toBe(expected);
  });

  it.each([
    ['has, comma', '"has, comma"'],
    ['has "quote"', '"has ""quote"""'],
    ['has\nnewline', '"has\nnewline"'],
  ])('quote-wraps + escapes interior quotes: %s', (input, expected) => {
    expect(escapeCsv(input)).toBe(expected);
  });

  it('handles null and undefined as empty string', () => {
    expect(escapeCsv(null)).toBe('');
    expect(escapeCsv(undefined)).toBe('');
  });

  it('coerces non-string values to strings before checking', () => {
    expect(escapeCsv(42)).toBe('42');
    expect(escapeCsv(true)).toBe('true');
  });

  it('combines formula-prefix with quote-wrap when the cell needs both', () => {
    // "=SUM(A1,B1)" -- starts with = AND contains a comma.
    const out = escapeCsv('=SUM(A1,B1)');
    expect(out).toBe('"\'=SUM(A1,B1)"');
    // When parsed by a CSV reader, the cell value is `'=SUM(A1,B1)` --
    // the leading apostrophe forces Excel to interpret as text.
  });
});
