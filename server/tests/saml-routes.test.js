// SAML routes — Day 3 unit tests for the pure helpers.
//
// The route handlers themselves are covered by the integration test
// added in Day 7 (samlify-as-IdP against a running FlowTex). Here we
// just pin the security-critical helper `safeRelayState`, which is
// what stops an open-redirect through the SAML RelayState parameter.

import { describe, it, expect } from 'vitest';
import { _testing } from '../routes/saml.js';

const { safeRelayState } = _testing;

describe('safeRelayState', () => {
  it('passes through a same-origin relative path', () => {
    expect(safeRelayState('/projects/abc')).toBe('/projects/abc');
    expect(safeRelayState('/')).toBe('/');
    expect(safeRelayState('/foo?bar=baz#fragment')).toBe('/foo?bar=baz#fragment');
  });

  it('rejects absolute URLs (open-redirect)', () => {
    expect(safeRelayState('http://evil.com/')).toBe('/');
    expect(safeRelayState('https://evil.com/')).toBe('/');
    expect(safeRelayState('javascript:alert(1)')).toBe('/');
  });

  it('rejects protocol-relative URLs (//evil.com)', () => {
    // The classic open-redirect bypass: most "starts with /" filters
    // miss `//evil.com/path` which the browser treats as
    // protocol-relative -> https://evil.com.
    expect(safeRelayState('//evil.com/path')).toBe('/');
    expect(safeRelayState('///evil.com')).toBe('/');
  });

  it('rejects paths with backslash (Windows path injection)', () => {
    expect(safeRelayState('/\\evil.com')).toBe('/');
    expect(safeRelayState('/foo\\bar')).toBe('/');
  });

  it('rejects SAML route loops', () => {
    expect(safeRelayState('/api/auth/saml/anything/login')).toBe('/');
    expect(safeRelayState('/api/auth/saml/x/acs')).toBe('/');
  });

  it('rejects non-string / empty / oversize inputs', () => {
    expect(safeRelayState(undefined)).toBe('/');
    expect(safeRelayState(null)).toBe('/');
    expect(safeRelayState({})).toBe('/');
    expect(safeRelayState('')).toBe('/');
    expect(safeRelayState('/' + 'a'.repeat(2000))).toBe('/');
  });

  it('rejects strings without leading slash', () => {
    expect(safeRelayState('projects/abc')).toBe('/');
    expect(safeRelayState('relative-path')).toBe('/');
  });
});
