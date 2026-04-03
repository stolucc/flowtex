import { describe, it, expect } from 'vitest';
import { BINARY_EXTS } from '../utils/fileTypes.js';

describe('BINARY_EXTS', () => {
  it('is a Set', () => {
    expect(BINARY_EXTS).toBeInstanceOf(Set);
  });

  it('contains common image formats', () => {
    for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.eps']) {
      expect(BINARY_EXTS.has(ext)).toBe(true);
    }
  });

  it('contains archive formats', () => {
    for (const ext of ['.zip', '.tar', '.gz']) {
      expect(BINARY_EXTS.has(ext)).toBe(true);
    }
  });

  it('contains font formats', () => {
    for (const ext of ['.woff', '.woff2', '.ttf', '.otf']) {
      expect(BINARY_EXTS.has(ext)).toBe(true);
    }
  });

  it('contains office formats', () => {
    for (const ext of ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']) {
      expect(BINARY_EXTS.has(ext)).toBe(true);
    }
  });

  it('does not contain text formats', () => {
    for (const ext of ['.tex', '.bib', '.sty', '.cls', '.txt', '.js', '.css']) {
      expect(BINARY_EXTS.has(ext)).toBe(false);
    }
  });

  it('all entries start with a dot', () => {
    for (const ext of BINARY_EXTS) {
      expect(ext.startsWith('.')).toBe(true);
    }
  });
});
