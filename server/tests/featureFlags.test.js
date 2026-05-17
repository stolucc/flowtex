// Tests for the feature-flag util. The flag default and the
// case-insensitive truthy parsing matter — getting either wrong would
// either accidentally turn the local-compile path on in production
// (default off violated) or refuse to enable it for an operator who
// wrote 'true' vs '1' in their .env.

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { isLocalCompileEnabled } from '../utils/featureFlags.js';

describe('isLocalCompileEnabled', () => {
  let saved;
  beforeEach(() => { saved = process.env.FEATURE_LOCAL_COMPILE; });
  afterEach(() => {
    if (saved === undefined) delete process.env.FEATURE_LOCAL_COMPILE;
    else process.env.FEATURE_LOCAL_COMPILE = saved;
  });

  it('defaults to false when the env var is unset', () => {
    delete process.env.FEATURE_LOCAL_COMPILE;
    expect(isLocalCompileEnabled()).toBe(false);
  });

  it('reads false for an empty string', () => {
    process.env.FEATURE_LOCAL_COMPILE = '';
    expect(isLocalCompileEnabled()).toBe(false);
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'On'])(
    'reads true for truthy value %j',
    (v) => {
      process.env.FEATURE_LOCAL_COMPILE = v;
      expect(isLocalCompileEnabled()).toBe(true);
    },
  );

  it.each(['0', 'false', 'no', 'off', 'something_else', '   '])(
    'reads false for non-truthy value %j',
    (v) => {
      process.env.FEATURE_LOCAL_COMPILE = v;
      expect(isLocalCompileEnabled()).toBe(false);
    },
  );

  it('re-evaluates the env on every call (no module-load caching)', () => {
    delete process.env.FEATURE_LOCAL_COMPILE;
    expect(isLocalCompileEnabled()).toBe(false);
    process.env.FEATURE_LOCAL_COMPILE = '1';
    expect(isLocalCompileEnabled()).toBe(true);
    process.env.FEATURE_LOCAL_COMPILE = '0';
    expect(isLocalCompileEnabled()).toBe(false);
  });
});
