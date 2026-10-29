import { describe, it, expect } from 'vitest';
import { routeParam } from '../utils/routeParam.js';

/** @param {Record<string, any>} params */
const reqWith = (params) => /** @type {any} */ ({ params });

describe('routeParam', () => {
  it('returns a named string segment as-is', () => {
    expect(routeParam(reqWith({ id: 'abc' }), 'id')).toBe('abc');
  });

  it('returns empty string for array (wildcard) or missing values', () => {
    expect(routeParam(reqWith({ id: ['a', 'b'] }), 'id')).toBe('');
    expect(routeParam(reqWith({}), 'id')).toBe('');
  });
});
