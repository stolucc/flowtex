import { describe, it, expect } from 'vitest';
import { isSafeWebUrl } from '../urlSafety.js';

describe('isSafeWebUrl', () => {
  describe('accepts safe web URLs', () => {
    for (const url of [
      'http://example.com',
      'https://example.com/path?q=1',
      'https://example.com/#frag',
      'HTTPS://example.com',
      'mailto:user@example.com',
      'MAILTO:user@example.com',
      '/relative/path',
      '/api/projects/1/zip',
      '?query=only',
      '#fragment-only',
      'https://example.com/path with spaces',
    ]) {
      it(JSON.stringify(url), () => {
        expect(isSafeWebUrl(url)).toBe(true);
      });
    }
  });

  describe('rejects XSS-vector URL schemes', () => {
    for (const url of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      '\tjavascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'DATA:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'chrome://settings',
      'about:blank',
      'blob:https://example.com/abc',
    ]) {
      it(JSON.stringify(url), () => {
        expect(isSafeWebUrl(url)).toBe(false);
      });
    }
  });

  describe('rejects protocol-relative URLs', () => {
    // Uncommon in LaTeX \href; better to fail closed than open a new
    // scheme-inheriting navigation.
    for (const url of ['//example.com/foo', '//evil.example/']) {
      it(JSON.stringify(url), () => {
        expect(isSafeWebUrl(url)).toBe(false);
      });
    }
  });

  describe('rejects garbage / non-URL input', () => {
    for (const v of ['', '   ', null, undefined, 42, {}, [], 'not a url', 'http://']) {
      it(JSON.stringify(v), () => {
        expect(isSafeWebUrl(v)).toBe(false);
      });
    }
  });
});
