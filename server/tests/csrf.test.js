import { describe, it, expect } from 'vitest';
import { csrfTokensMatch } from '../utils/csrf.js';

// AA2 (audit round 12): the CSRF token compare in index.js used to be
// `!==`, which short-circuits on the first differing byte. Replaced
// with crypto.timingSafeEqual via this helper. Tests pin the
// precondition behaviour (length / type rejection) and the
// equal/unequal cases that the constant-time path handles.

describe('csrfTokensMatch — AA2 constant-time CSRF compare', () => {
  const TOKEN = 'a'.repeat(64); // matches the 32-byte hex token shape

  it('returns true for an exact match', () => {
    expect(csrfTokensMatch(TOKEN, TOKEN)).toBe(true);
  });

  it('returns false for a different token of the same length', () => {
    const wrong = 'b' + TOKEN.slice(1);
    expect(csrfTokensMatch(wrong, TOKEN)).toBe(false);
  });

  it('rejects when the expected token is missing', () => {
    expect(csrfTokensMatch(TOKEN, null)).toBe(false);
    expect(csrfTokensMatch(TOKEN, undefined)).toBe(false);
    expect(csrfTokensMatch(TOKEN, '')).toBe(false);
  });

  it('rejects when the provided token is not a string', () => {
    expect(csrfTokensMatch(undefined, TOKEN)).toBe(false);
    expect(csrfTokensMatch(null, TOKEN)).toBe(false);
    expect(csrfTokensMatch(123456, TOKEN)).toBe(false);
    expect(csrfTokensMatch(['x'], TOKEN)).toBe(false);
  });

  it('rejects different-length inputs without throwing (timingSafeEqual would RangeError)', () => {
    // The length check is a precondition. A throw here means the
    // precondition regressed.
    expect(csrfTokensMatch('short', TOKEN)).toBe(false);
    expect(csrfTokensMatch(TOKEN + 'x', TOKEN)).toBe(false);
  });

  it('rejects empty provided when expected exists', () => {
    expect(csrfTokensMatch('', TOKEN)).toBe(false);
  });
});
