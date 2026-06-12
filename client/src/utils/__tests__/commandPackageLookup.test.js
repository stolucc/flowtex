import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock helperBridge BEFORE importing the unit under test so the LLM
// path is fully controllable.
vi.mock('../helperBridge.js', () => ({
  streamLlmComplete: vi.fn(),
  fetchLlmStatus: vi.fn(),
}));

import {
  parseLlmAnswer,
  cacheLookup,
  readCache,
  queryHelperLlm,
  lookupCommandPackage,
  _resetForTesting,
} from '../commandPackageLookup.js';
import { streamLlmComplete, fetchLlmStatus } from '../helperBridge.js';

beforeEach(() => {
  _resetForTesting();
  if (typeof localStorage !== 'undefined') localStorage.clear();
  vi.clearAllMocks();
});

describe('parseLlmAnswer', () => {
  it('passes through a bare package name', () => {
    expect(parseLlmAnswer('xcolor')).toBe('xcolor');
    expect(parseLlmAnswer('amsmath')).toBe('amsmath');
  });

  it('strips surrounding whitespace and trailing punctuation', () => {
    expect(parseLlmAnswer('  xcolor  ')).toBe('xcolor');
    expect(parseLlmAnswer('xcolor.')).toBe('xcolor');
    expect(parseLlmAnswer('xcolor\n')).toBe('xcolor');
  });

  it('strips markdown backticks / stars / backslashes', () => {
    expect(parseLlmAnswer('`xcolor`')).toBe('xcolor');
    expect(parseLlmAnswer('**xcolor**')).toBe('xcolor');
    expect(parseLlmAnswer('\\xcolor')).toBe('xcolor');
  });

  it('takes only the FIRST token of a multi-word answer (prose-resistant)', () => {
    expect(parseLlmAnswer('xcolor (the colour package)')).toBe('xcolor');
    expect(parseLlmAnswer('xcolor or hyperref')).toBe('xcolor');
  });

  it('returns null for "unknown"/"none"/"n/a"/etc.', () => {
    expect(parseLlmAnswer('unknown')).toBeNull();
    expect(parseLlmAnswer('Unknown')).toBeNull();
    expect(parseLlmAnswer('none')).toBeNull();
    expect(parseLlmAnswer('n/a')).toBeNull();
    expect(parseLlmAnswer('null')).toBeNull();
  });

  it('normalises uppercase to lowercase (LLM may capitalise)', () => {
    expect(parseLlmAnswer('XColor')).toBe('xcolor');
    expect(parseLlmAnswer('AMSmath')).toBe('amsmath');
  });

  it('returns the first sentence-word when the model rambles', () => {
    expect(parseLlmAnswer('this is a sentence')).toBe('this');
  });

  it('rejects answers starting with non-alphanumeric characters', () => {
    expect(parseLlmAnswer('@latex')).toBeNull();
    expect(parseLlmAnswer('-foo')).toBeNull();
  });

  it('returns null for empty / whitespace-only', () => {
    expect(parseLlmAnswer('')).toBeNull();
    expect(parseLlmAnswer('   ')).toBeNull();
    expect(parseLlmAnswer(null)).toBeNull();
    expect(parseLlmAnswer(undefined)).toBeNull();
  });

  it('accepts hyphenated package names (e.g. fontawesome5, tikz-cd)', () => {
    expect(parseLlmAnswer('fontawesome5')).toBe('fontawesome5');
    expect(parseLlmAnswer('tikz-cd')).toBe('tikz-cd');
  });
});

describe('cacheLookup + readCache (in-memory)', () => {
  it('round-trips a result through the cache', () => {
    cacheLookup('cref', { package: 'cleveref', source: 'index' });
    expect(readCache('cref')).toEqual({ package: 'cleveref', source: 'index', confidence: 'high' });
  });

  it('marks LLM-sourced answers as low confidence', () => {
    cacheLookup('weird', { package: 'something', source: 'llm' });
    expect(readCache('weird')?.confidence).toBe('low');
  });

  it('caches null answers (so we don\'t re-query the same unknown)', () => {
    cacheLookup('totallyunknown', { package: null, source: 'unknown' });
    const r = readCache('totallyunknown');
    expect(r).not.toBeNull();
    expect(r?.package).toBeNull();
  });

  it('returns null for an uncached command', () => {
    expect(readCache('whatever')).toBeNull();
  });
});

describe('queryHelperLlm', () => {
  it('returns null when helper is unavailable', async () => {
    fetchLlmStatus.mockResolvedValueOnce({ ok: false, error: 'not paired' });
    expect(await queryHelperLlm('cref')).toBeNull();
  });

  it("returns null when status.available is false", async () => {
    fetchLlmStatus.mockResolvedValueOnce({
      ok: true,
      status: { available: false, error: 'ollama offline' },
    });
    expect(await queryHelperLlm('cref')).toBeNull();
  });

  it('returns null when no model is configured', async () => {
    fetchLlmStatus.mockResolvedValueOnce({
      ok: true,
      status: { available: true, models: [] },
    });
    expect(await queryHelperLlm('cref')).toBeNull();
  });

  it('streams + parses a successful LLM answer', async () => {
    fetchLlmStatus.mockResolvedValueOnce({
      ok: true,
      status: { available: true, defaultModel: 'llama3', models: ['llama3'] },
    });
    streamLlmComplete.mockImplementationOnce(async (_req, onDelta) => {
      onDelta('cleveref');
      return { ok: true };
    });
    expect(await queryHelperLlm('cref')).toBe('cleveref');
  });

  it('returns null when the LLM answers "unknown"', async () => {
    fetchLlmStatus.mockResolvedValueOnce({
      ok: true,
      status: { available: true, defaultModel: 'llama3' },
    });
    streamLlmComplete.mockImplementationOnce(async (_req, onDelta) => {
      onDelta('unknown');
      return { ok: true };
    });
    expect(await queryHelperLlm('whatever')).toBeNull();
  });

  it('returns null when streamLlmComplete signals failure', async () => {
    fetchLlmStatus.mockResolvedValueOnce({
      ok: true,
      status: { available: true, defaultModel: 'llama3' },
    });
    streamLlmComplete.mockResolvedValueOnce({ ok: false, error: 'oom' });
    expect(await queryHelperLlm('cref')).toBeNull();
  });
});

describe('lookupCommandPackage (orchestrator)', () => {
  it('serves from cache without hitting the LLM', async () => {
    cacheLookup('cref', { package: 'cleveref', source: 'static' });
    const r = await lookupCommandPackage('cref');
    expect(r.package).toBe('cleveref');
    expect(fetchLlmStatus).not.toHaveBeenCalled();
  });

  it('falls through to the LLM when no cache entry exists', async () => {
    fetchLlmStatus.mockResolvedValueOnce({
      ok: true,
      status: { available: true, defaultModel: 'llama3' },
    });
    streamLlmComplete.mockImplementationOnce(async (_req, onDelta) => {
      onDelta('obscurepkg');
      return { ok: true };
    });
    const r = await lookupCommandPackage('obscurecmd');
    expect(r.package).toBe('obscurepkg');
    expect(r.source).toBe('llm');
    expect(r.confidence).toBe('low');
  });

  it('caches the result so a second call is LLM-free', async () => {
    fetchLlmStatus.mockResolvedValueOnce({
      ok: true,
      status: { available: true, defaultModel: 'llama3' },
    });
    streamLlmComplete.mockImplementationOnce(async (_req, onDelta) => {
      onDelta('foo');
      return { ok: true };
    });
    await lookupCommandPackage('something');
    await lookupCommandPackage('something');
    expect(fetchLlmStatus).toHaveBeenCalledTimes(1);
  });

  it("caches null results so we don't re-query unknown commands", async () => {
    fetchLlmStatus.mockResolvedValueOnce({ ok: false, error: 'no helper' });
    await lookupCommandPackage('totallyunknown');
    await lookupCommandPackage('totallyunknown');
    expect(fetchLlmStatus).toHaveBeenCalledTimes(1);
  });

  it('skips the LLM entirely when { allowLlm: false }', async () => {
    const r = await lookupCommandPackage('weird', { allowLlm: false });
    expect(r.package).toBeNull();
    expect(streamLlmComplete).not.toHaveBeenCalled();
  });
});
