// Tests for the helper-bridge client. Covers the compileLocal contract
// — every branch of the (ok | fatal | non-fatal) return shape is
// exercised so a future refactor cant silently change the fall-back
// semantics that useCompilation relies on.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  compileLocal,
  pairWithHelper,
  getHelperToken,
  setHelperToken,
  clearHelperToken,
} from '../helperBridge.js';

// Each test resets localStorage + restores fetch so they're independent.
const ORIG_FETCH = global.fetch;
const STORE = {};

beforeEach(() => {
  Object.defineProperty(global, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (k in STORE ? STORE[k] : null),
      setItem: (k, v) => { STORE[k] = String(v); },
      removeItem: (k) => { delete STORE[k]; },
    },
  });
  // Mirror onto window too — helperBridge reads window.localStorage.
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: global.localStorage },
  });
  for (const k of Object.keys(STORE)) delete STORE[k];
});

afterEach(() => {
  global.fetch = ORIG_FETCH;
});

function mockFetchOnce(implementation) {
  global.fetch = vi.fn(implementation);
}

describe('compileLocal — return shape', () => {
  it('returns fatal=true when no token has been paired', async () => {
    const result = await compileLocal({ jobId: 'j1', mainFile: 'main.tex', files: [] });
    expect(result).toMatchObject({ ok: false, fatal: true });
    expect(result.error).toMatch(/no helper token/i);
  });

  it('returns fatal=true on network error (helper unreachable)', async () => {
    setHelperToken('a'.repeat(64));
    mockFetchOnce(() => Promise.reject(new Error('TypeError: Failed to fetch')));
    const result = await compileLocal({ jobId: 'j1', mainFile: 'main.tex', files: [] });
    expect(result).toMatchObject({ ok: false, fatal: true });
    expect(result.error).toMatch(/unreachable/i);
  });

  it('returns fatal=true on 401 AND clears the stored token', async () => {
    setHelperToken('a'.repeat(64));
    expect(getHelperToken()).not.toBe('');
    mockFetchOnce(() => Promise.resolve({ ok: false, status: 401 }));
    const result = await compileLocal({ jobId: 'j1', mainFile: 'main.tex', files: [] });
    expect(result).toMatchObject({ ok: false, fatal: true });
    expect(result.error).toMatch(/authentication/i);
    expect(getHelperToken()).toBe(''); // token cleared
  });

  it('returns fatal=true on non-200 helper response', async () => {
    setHelperToken('a'.repeat(64));
    mockFetchOnce(() => Promise.resolve({ ok: false, status: 500 }));
    const result = await compileLocal({ jobId: 'j1', mainFile: 'main.tex', files: [] });
    expect(result).toMatchObject({ ok: false, fatal: true });
    expect(result.error).toMatch(/HTTP 500/);
  });

  it('returns fatal=false when helper ran but compile produced no PDF (server retry pointless)', async () => {
    setHelperToken('a'.repeat(64));
    mockFetchOnce(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: false, error: 'pdflatex exited 1', log: '! Undefined control sequence.' }),
    }));
    const result = await compileLocal({ jobId: 'j1', mainFile: 'main.tex', files: [] });
    expect(result).toMatchObject({
      ok: false,
      fatal: false, // <- the contract that useCompilation relies on for "don't bounce"
    });
    expect(result.error).toMatch(/pdflatex/);
    expect(result.log).toMatch(/Undefined/);
  });

  it('returns ok=true + pdfBlob when helper produced a PDF', async () => {
    setHelperToken('a'.repeat(64));
    // 4-byte payload so we can verify the round-trip without depending
    // on a real PDF parser. Base64 of [0x25, 0x50, 0x44, 0x46] = "%PDF" header.
    const b64 = 'JVBERg==';
    mockFetchOnce(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, pdf: b64, log: 'Output written to main.pdf' }),
    }));
    const result = await compileLocal({ jobId: 'j1', mainFile: 'main.tex', files: [] });
    expect(result.ok).toBe(true);
    expect(result.pdfBlob).toBeInstanceOf(Blob);
    expect(result.pdfBlob.size).toBe(4);
    expect(result.log).toMatch(/main\.pdf/);
  });

  it('passes the bearer token through to the helper', async () => {
    setHelperToken('decafbad'.repeat(8));
    let seenAuth = null;
    mockFetchOnce((_, opts) => {
      seenAuth = opts?.headers?.Authorization;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, pdf: 'JVBERg==', log: '' }),
      });
    });
    await compileLocal({ jobId: 'j1', mainFile: 'main.tex', files: [] });
    expect(seenAuth).toBe('Bearer ' + 'decafbad'.repeat(8));
  });
});

describe('pairWithHelper', () => {
  it('rejects a non-6-digit code without hitting the network', async () => {
    let called = false;
    mockFetchOnce(() => { called = true; return Promise.resolve({ ok: true }); });
    const result = await pairWithHelper('abc');
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('stores the returned token on success', async () => {
    mockFetchOnce(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token: 'feedbeef'.repeat(8) }),
    }));
    const result = await pairWithHelper('123456');
    expect(result.ok).toBe(true);
    expect(getHelperToken()).toBe('feedbeef'.repeat(8));
  });

  it('returns ok=false when helper responds non-2xx', async () => {
    mockFetchOnce(() => Promise.resolve({ ok: false, status: 403 }));
    const result = await pairWithHelper('123456');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/403/);
  });

  it('returns ok=false when helper responds without a token', async () => {
    mockFetchOnce(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    }));
    const result = await pairWithHelper('123456');
    expect(result.ok).toBe(false);
  });
});

describe('token storage', () => {
  it('round-trips via setHelperToken / getHelperToken / clearHelperToken', () => {
    expect(getHelperToken()).toBe('');
    setHelperToken('abc');
    expect(getHelperToken()).toBe('abc');
    clearHelperToken();
    expect(getHelperToken()).toBe('');
  });
});
