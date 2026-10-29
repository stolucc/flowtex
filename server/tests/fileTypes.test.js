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

import { looksBinary, isBinaryContent } from '../utils/fileTypes.js';

describe('looksBinary / isBinaryContent', () => {
  it('flags a NUL byte in the first 8000 bytes', () => {
    expect(looksBinary(Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x10]))).toBe(true); // RIFF....WEBP
    expect(looksBinary(Buffer.from('\\documentclass{article}\n', 'utf8'))).toBe(false);
    expect(looksBinary(Buffer.from('héllo — ünïcode ✓', 'utf8'))).toBe(false);
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
  });

  it('only scans the first 8000 bytes (cheap on big text files)', () => {
    const late = Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from([0])]);
    expect(looksBinary(late)).toBe(false);
  });

  it('binary by extension OR by content', () => {
    expect(isBinaryContent('.png', Buffer.from('text-looking'))).toBe(true);
    expect(isBinaryContent('.webp', Buffer.from([0x52, 0x00]))).toBe(true);
    expect(isBinaryContent('.heic', Buffer.from([0x00, 0x00, 0x00, 0x18]))).toBe(true);
    expect(isBinaryContent('.tex', Buffer.from('plain'))).toBe(false);
  });
});
