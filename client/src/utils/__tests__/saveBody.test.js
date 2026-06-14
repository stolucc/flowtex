import { describe, it, expect } from 'vitest';
import { buildFileSaveBody } from '../saveBody.js';

describe('buildFileSaveBody', () => {
  it('content write: includes content + baseVersion', () => {
    const r = buildFileSaveBody({ content: 'hello', baseVersion: 'v1' });
    expect(r.skip).toBe(false);
    expect(r.contentless).toBe(false);
    expect(r.body).toEqual({ content: 'hello', baseVersion: 'v1' });
  });

  it('content write: omits baseVersion when none supplied', () => {
    const r = buildFileSaveBody({ content: 'hello' });
    expect(r.body).toEqual({ content: 'hello' });
    expect(r.body).not.toHaveProperty('baseVersion');
  });

  it('content write: includes tcMarks alongside content', () => {
    const marks = [{ id: 'm', from: 0, to: 1, kind: 'insert' }];
    const r = buildFileSaveBody({ content: 'hi', tcMarks: marks, baseVersion: 'v2' });
    expect(r.body).toEqual({ content: 'hi', tcMarks: marks, baseVersion: 'v2' });
  });

  it('empty-string content is still a content write (not contentless)', () => {
    const r = buildFileSaveBody({ content: '' });
    expect(r.skip).toBe(false);
    expect(r.contentless).toBe(false);
    expect(r.body).toEqual({ content: '' });
  });

  it('marks-only (content undefined) with marks: omits content AND baseVersion', () => {
    const marks = [{ id: 'm', from: 0, to: 1, kind: 'insert' }];
    const r = buildFileSaveBody({ content: undefined, tcMarks: marks, baseVersion: 'v9' });
    expect(r.skip).toBe(false);
    expect(r.contentless).toBe(true);
    expect(r.body).toEqual({ tcMarks: marks });
    expect(r.body).not.toHaveProperty('content');
    expect(r.body).not.toHaveProperty('baseVersion');
  });

  it('marks-only with an EMPTY marks array still sends (server can clear marks)', () => {
    const r = buildFileSaveBody({ content: undefined, tcMarks: [] });
    expect(r.skip).toBe(false);
    expect(r.body).toEqual({ tcMarks: [] });
  });

  it('marks-only with NO marks: skip entirely (nothing to persist)', () => {
    const r = buildFileSaveBody({ content: undefined });
    expect(r.skip).toBe(true);
    expect(r.contentless).toBe(true);
    expect(r.body).toBeUndefined();
  });

  it('marks-only with non-array tcMarks: skip', () => {
    const r = buildFileSaveBody({ content: undefined, tcMarks: /** @type {any} */ (null) });
    expect(r.skip).toBe(true);
  });
});
