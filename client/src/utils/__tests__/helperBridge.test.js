// Tests for the helper-bridge client. Covers the compileLocal contract
// — every branch of the (ok | fatal | non-fatal) return shape is
// exercised so a future refactor cant silently change the fall-back
// semantics that useCompilation relies on.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  compileLocal,
  pairWithHelper,
  pairWithHelperCodeless,
  autoPairWithHelper,
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
    // Minimal valid PDF signature: %PDF-1.4\n. Base64 of the 9 bytes
    // [0x25,0x50,0x44,0x46,0x2D,0x31,0x2E,0x34,0x0A].
    // The bridge rejects anything that doesnt start with %PDF-, so
    // tests have to use a real signature.
    const b64 = 'JVBERi0xLjQK';
    mockFetchOnce(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, pdf: b64, log: 'Output written to main.pdf' }),
    }));
    const result = await compileLocal({ jobId: 'j1', mainFile: 'main.tex', files: [] });
    expect(result.ok).toBe(true);
    expect(result.pdfBlob).toBeInstanceOf(Blob);
    expect(result.pdfBlob.size).toBe(9);
    expect(result.log).toMatch(/main\.pdf/);
  });

  it('rejects non-PDF blobs as non-fatal (clearer than "Failed to load PDF" downstream)', async () => {
    setHelperToken('a'.repeat(64));
    // Base64 of "hello\n" — definitely not a PDF.
    mockFetchOnce(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, pdf: 'aGVsbG8K', log: '' }),
    }));
    const result = await compileLocal({ jobId: 'j1', mainFile: 'main.tex', files: [] });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(false); // server retry pointless — same source would fail there too
    expect(result.error).toMatch(/non-PDF/i);
  });

  it('rejects malformed base64 with a clear error', async () => {
    setHelperToken('a'.repeat(64));
    mockFetchOnce(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, pdf: '!!!not base64!!!', log: '' }),
    }));
    const result = await compileLocal({ jobId: 'j1', mainFile: 'main.tex', files: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/base64/i);
  });

  it('passes the bearer token through to the helper', async () => {
    setHelperToken('decafbad'.repeat(8));
    let seenAuth = null;
    mockFetchOnce((_, opts) => {
      seenAuth = opts?.headers?.Authorization;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, pdf: 'JVBERi0xLjQK', log: '' }),
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

describe('pairWithHelperCodeless', () => {
  it('posts an empty JSON body to /pair and stores the token', async () => {
    let seen = null;
    mockFetchOnce((url, opts) => {
      seen = { url, opts };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ token: 'feedbeef'.repeat(8) }),
      });
    });
    const result = await pairWithHelperCodeless();
    expect(result.ok).toBe(true);
    expect(seen.url).toMatch(/\/pair$/);
    expect(seen.opts.method).toBe('POST');
    expect(seen.opts.body).toBe('{}');
    expect(getHelperToken()).toBe('feedbeef'.repeat(8));
  });

  it('passes the helper reason through on a JSON refusal', async () => {
    mockFetchOnce(() => Promise.resolve({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'no pairing window open', reason: 'no_window' }),
    }));
    const result = await pairWithHelperCodeless();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_window');
    expect(result.error).toMatch(/no pairing window/);
  });

  it('reports reason=error on a legacy plain-text refusal', async () => {
    mockFetchOnce(() => Promise.resolve({
      ok: false,
      status: 400,
      json: () => Promise.reject(new SyntaxError('not json')),
    }));
    const result = await pairWithHelperCodeless();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('error');
    expect(result.error).toMatch(/400/);
  });

  it('reports reason=unreachable when the helper is down', async () => {
    global.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    const result = await pairWithHelperCodeless();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unreachable');
  });

  it('does not store a token when the helper omits it', async () => {
    mockFetchOnce(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }));
    const result = await pairWithHelperCodeless();
    expect(result.ok).toBe(false);
    expect(getHelperToken()).toBe('');
  });
});

describe('autoPairWithHelper', () => {
  const noSleep = () => Promise.resolve();

  it('keeps polling through no_window and returns the first success', async () => {
    const answers = [
      { ok: false, reason: 'no_window' },
      { ok: false, reason: 'unreachable' },
      { ok: false, reason: 'no_window' },
      { ok: true },
    ];
    const pairFn = vi.fn(() => Promise.resolve(answers.shift()));
    const result = await autoPairWithHelper({ pairFn, sleep: noSleep, timeoutMs: 10_000 });
    expect(result.ok).toBe(true);
    expect(pairFn).toHaveBeenCalledTimes(4);
  });

  it('stops immediately on peer_mismatch / unsupported', async () => {
    for (const reason of ['peer_mismatch', 'unsupported', 'error']) {
      const pairFn = vi.fn(() => Promise.resolve({ ok: false, reason, error: 'nope' }));
      const result = await autoPairWithHelper({ pairFn, sleep: noSleep, timeoutMs: 10_000 });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe(reason);
      expect(pairFn).toHaveBeenCalledTimes(1);
    }
  });

  it('gives up with reason=timeout once the deadline passes', async () => {
    let t = 0;
    const pairFn = vi.fn(() => Promise.resolve({ ok: false, reason: 'no_window' }));
    const sleep = (ms) => { t += ms; return Promise.resolve(); };
    const result = await autoPairWithHelper({ pairFn, sleep, now: () => t, timeoutMs: 5_000, intervalMs: 2_000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timeout');
    expect(result.error).toMatch(/Pair with FlowTex/);
    // Attempts at t = 0, 2000, 4000 and 6000; the deadline check runs
    // after each refusal, so the fourth attempt (t = 6000 >= 5000) is
    // the one that gives up.
    expect(pairFn).toHaveBeenCalledTimes(4);
  });

  it('honours shouldStop between attempts', async () => {
    let calls = 0;
    const pairFn = vi.fn(() => { calls += 1; return Promise.resolve({ ok: false, reason: 'no_window' }); });
    const result = await autoPairWithHelper({
      pairFn, sleep: noSleep, timeoutMs: 10_000, shouldStop: () => calls >= 2,
    });
    expect(result.reason).toBe('cancelled');
    expect(pairFn).toHaveBeenCalledTimes(2);
  });
});

describe('scheme fallback (http → https when http fails)', () => {
  // The helper listens on http by default but a --tls user has it on
  // https only. The bridge probes the cached scheme first, falls back
  // on network error. Cover both directions so a regression cant lock
  // out either operator mode.

  it('falls back to https when http throws', async () => {
    setHelperToken('a'.repeat(64));
    const seenUrls = [];
    global.fetch = vi.fn((url) => {
      seenUrls.push(url);
      if (url.startsWith('http://')) {
        return Promise.reject(new Error('connect refused'));
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, pdf: 'JVBERi0xLjQK', log: '' }),
      });
    });
    const result = await compileLocal({ jobId: 'j1', mainFile: 'main.tex', files: [] });
    expect(result.ok).toBe(true);
    expect(seenUrls).toHaveLength(2);
    expect(seenUrls[0]).toMatch(/^http:\/\//);
    expect(seenUrls[1]).toMatch(/^https:\/\//);
  });

  it('uses cached scheme on subsequent calls (no double-probe)', async () => {
    setHelperToken('a'.repeat(64));
    // First call: http fails, https wins → cache should remember https.
    let callCount = 0;
    global.fetch = vi.fn((url) => {
      callCount++;
      if (url.startsWith('http://')) return Promise.reject(new Error('no'));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, pdf: 'JVBERi0xLjQK', log: '' }),
      });
    });
    await compileLocal({ jobId: 'j1', mainFile: 'main.tex', files: [] });
    const afterFirst = callCount;
    // Second call: cache is now https, should not retry http.
    await compileLocal({ jobId: 'j2', mainFile: 'main.tex', files: [] });
    // Each compileLocal should have done exactly 1 fetch (no fallback
    // needed) on the second call.
    expect(callCount - afterFirst).toBe(1);
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
