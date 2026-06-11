import { describe, it, expect } from 'vitest';
import { getMimeType } from '../mimeType.js';

describe('getMimeType', () => {
  it('returns image/png for .png', () => {
    expect(getMimeType('foo.png')).toBe('image/png');
  });

  it('returns image/jpeg for both .jpg and .jpeg', () => {
    expect(getMimeType('a.jpg')).toBe('image/jpeg');
    expect(getMimeType('a.jpeg')).toBe('image/jpeg');
  });

  it('returns image/gif for .gif', () => {
    expect(getMimeType('a.gif')).toBe('image/gif');
  });

  it('returns image/bmp for .bmp', () => {
    expect(getMimeType('a.bmp')).toBe('image/bmp');
  });

  it('returns image/svg+xml for .svg', () => {
    expect(getMimeType('a.svg')).toBe('image/svg+xml');
  });

  it('returns image/x-icon for .ico', () => {
    expect(getMimeType('a.ico')).toBe('image/x-icon');
  });

  it('returns image/webp for .webp', () => {
    expect(getMimeType('a.webp')).toBe('image/webp');
  });

  it('returns application/pdf for .pdf', () => {
    expect(getMimeType('a.pdf')).toBe('application/pdf');
  });

  it('is case-insensitive on the extension', () => {
    expect(getMimeType('A.PNG')).toBe('image/png');
    expect(getMimeType('A.Pdf')).toBe('application/pdf');
  });

  it('uses the LAST dot as the extension separator', () => {
    // foo.bar.png — extension is `png`.
    expect(getMimeType('foo.bar.png')).toBe('image/png');
    // path/with.dots/file.pdf — last segment after the last dot is `pdf`.
    expect(getMimeType('a/b.c/d.pdf')).toBe('application/pdf');
  });

  it('returns application/octet-stream for an unknown extension', () => {
    expect(getMimeType('foo.zzz')).toBe('application/octet-stream');
    expect(getMimeType('foo.docx')).toBe('application/octet-stream');
  });

  it('returns application/octet-stream when the path has no extension', () => {
    // No dot at all -> split yields one segment -> pop -> entire string,
    // which won't be in the lookup table -> octet-stream.
    expect(getMimeType('README')).toBe('application/octet-stream');
  });

  it('returns application/octet-stream for empty string', () => {
    expect(getMimeType('')).toBe('application/octet-stream');
  });

  it('returns application/octet-stream for null and undefined (defensive)', () => {
    expect(getMimeType(null)).toBe('application/octet-stream');
    expect(getMimeType(undefined)).toBe('application/octet-stream');
  });

  it('handles a path that is JUST a dot-prefixed name (no real extension)', () => {
    // '.eslintrc' splits to ['', 'eslintrc'] -> pop returns 'eslintrc',
    // which isn't in the table -> octet-stream.
    expect(getMimeType('.eslintrc')).toBe('application/octet-stream');
  });
});
