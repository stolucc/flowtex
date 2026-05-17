// Truth table for resolveCompileLocation. Every row in
// LOCAL_COMPILE_DESIGN.md §5 gets a case here so a refactor cant silently
// invert the safety net.

import { describe, it, expect } from 'vitest';
import { resolveCompileLocation, describeChoice } from '../compileLocation.js';

const UP_2025 = { available: true, year: '2025' };
const UP_2023 = { available: true, year: '2023' };
const DOWN = { available: false };

describe('resolveCompileLocation — when neither side asked for local', () => {
  it('user=server, project=null → server', () => {
    expect(resolveCompileLocation(
      { compile_location: null }, { compileLocation: 'server' }, UP_2025,
    )).toEqual({ source: 'server' });
  });
  it('user=server, project=server → server', () => {
    expect(resolveCompileLocation(
      { compile_location: 'server' }, { compileLocation: 'server' }, UP_2025,
    )).toEqual({ source: 'server' });
  });
  it('user=server, project=null, helper down → server (no helper not relevant)', () => {
    expect(resolveCompileLocation(
      { compile_location: null }, { compileLocation: 'server' }, DOWN,
    )).toEqual({ source: 'server' });
  });
});

describe('resolveCompileLocation — when project explicitly says server', () => {
  it('overrides a local user preference', () => {
    expect(resolveCompileLocation(
      { compile_location: 'server' }, { compileLocation: 'local' }, UP_2025,
    )).toEqual({ source: 'server' });
  });
});

describe('resolveCompileLocation — when project=local', () => {
  it('local + helper up + year matches → local', () => {
    expect(resolveCompileLocation(
      { compile_location: 'local', tex_distribution: '2025' },
      { compileLocation: 'server' },
      UP_2025,
    )).toEqual({ source: 'local' });
  });
  it('local + helper up + no project year pinned → local (helper year accepted)', () => {
    expect(resolveCompileLocation(
      { compile_location: 'local', tex_distribution: null },
      { compileLocation: 'server' },
      UP_2025,
    )).toEqual({ source: 'local' });
  });
  it('local + helper up + year mismatch → server with version_mismatch', () => {
    expect(resolveCompileLocation(
      { compile_location: 'local', tex_distribution: '2025' },
      { compileLocation: 'server' },
      UP_2023,
    )).toEqual({ source: 'server', fallbackReason: 'version_mismatch' });
  });
  it('local + helper down → server with no_helper', () => {
    expect(resolveCompileLocation(
      { compile_location: 'local', tex_distribution: '2025' },
      { compileLocation: 'server' },
      DOWN,
    )).toEqual({ source: 'server', fallbackReason: 'no_helper' });
  });
});

describe('resolveCompileLocation — when project=null and user=local', () => {
  it('inherits user default → local when healthy and version match', () => {
    expect(resolveCompileLocation(
      { compile_location: null, tex_distribution: '2025' },
      { compileLocation: 'local' },
      UP_2025,
    )).toEqual({ source: 'local' });
  });
  it('inherits user default → server fallback when helper down', () => {
    expect(resolveCompileLocation(
      { compile_location: null, tex_distribution: '2025' },
      { compileLocation: 'local' },
      DOWN,
    )).toEqual({ source: 'server', fallbackReason: 'no_helper' });
  });
});

describe('resolveCompileLocation — defensive', () => {
  it('missing project/user/helper objects → server', () => {
    expect(resolveCompileLocation(undefined, undefined, undefined)).toEqual({ source: 'server' });
    expect(resolveCompileLocation(null, null, null)).toEqual({ source: 'server' });
  });
  it('helperStatus.available undefined → treated as not available', () => {
    expect(resolveCompileLocation(
      { compile_location: 'local' }, { compileLocation: 'local' }, { year: '2025' },
    )).toEqual({ source: 'server', fallbackReason: 'no_helper' });
  });
});

describe('describeChoice', () => {
  it('local source mentions the helper TeX Live year', () => {
    expect(describeChoice({ source: 'local' }, {}, {}, { year: '2025' }))
      .toMatch(/2025/);
  });
  it('no_helper fallback mentions the server', () => {
    expect(describeChoice({ source: 'server', fallbackReason: 'no_helper' }, {}, {}, {}))
      .toMatch(/FlowTex server/);
  });
  it('version_mismatch fallback names both years', () => {
    expect(describeChoice(
      { source: 'server', fallbackReason: 'version_mismatch' },
      { tex_distribution: '2025' }, {}, { year: '2023' },
    )).toMatch(/2023.*2025|2025.*2023/);
  });
});
