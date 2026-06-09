// Regression tests for the security audit round 3 fixes.
//
//   * Per-WS token bucket on yjs-update messages (rate limit / DoS)
//   * Object.create(null) for worker dispatchEntry field map
//     (prototype-pollution defence)
//   * HMAC on flowtex:ws:control messages (cluster-mode kick auth)

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { _testing } from '../websocket.js';
import { dispatchEntry } from '../yjsWorker.js';

const {
  takeYjsUpdateToken,
  YJS_BUDGET_MAX,
  YJS_REFILL_PER_SEC,
  signControlPayload,
  verifyControlPayload,
  _setControlChannelHmacKey,
} = _testing;

describe('per-WS yjs-update token bucket', () => {
  it('allows up to YJS_BUDGET_MAX requests in a burst', () => {
    const state = {};
    for (let i = 0; i < YJS_BUDGET_MAX; i++) {
      expect(takeYjsUpdateToken(state)).toBe(true);
    }
    // The (MAX+1)th call should be denied (only sub-1 token remains).
    expect(takeYjsUpdateToken(state)).toBe(false);
  });

  it('refills at YJS_REFILL_PER_SEC tokens/sec', async () => {
    const state = {};
    for (let i = 0; i < YJS_BUDGET_MAX; i++) takeYjsUpdateToken(state);
    expect(takeYjsUpdateToken(state)).toBe(false);
    // Wait long enough for one token to refill, plus slack for jitter.
    await new Promise((r) => setTimeout(r, Math.ceil(1000 / YJS_REFILL_PER_SEC) + 30));
    expect(takeYjsUpdateToken(state)).toBe(true);
  });

  it('budget is per-state, not shared across connections', () => {
    const a = {};
    const b = {};
    for (let i = 0; i < YJS_BUDGET_MAX; i++) takeYjsUpdateToken(a);
    expect(takeYjsUpdateToken(b)).toBe(true);
  });
});

describe('worker dispatchEntry: prototype-pollution-resistant field map', () => {
  it('treats __proto__ as a regular field (no prototype leakage)', async () => {
    const result = await dispatchEntry(
      ['__proto__', 'attacker-controlled-value',
       'type', 'apply', 'projectId', 'p', 'fileId', 'f', 'update', 'YWFh'],
      {
        acquireRoom: async () => ({ projectId: 'p', fileId: 'f' }),
        applyUpdate: () => {},
        encodeStateAsUpdate: () => null,
        releaseRoom: async () => {},
        redis: { set: async () => 'OK' },
        consumerName: 'test',
      },
    );
    expect(result.ok).toBe(true);
  });

  it('does not expose Object.prototype methods through field map', async () => {
    const result = await dispatchEntry(
      ['projectId', 'p', 'fileId', 'f'],
      { acquireRoom: async () => null, applyUpdate: () => {}, redis: null, consumerName: 'test' },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing-required-fields');
  });
});

describe('control-channel HMAC (flowtex:ws:control)', () => {
  beforeEach(() => {
    _setControlChannelHmacKey(crypto.randomBytes(32));
  });

  it('round-trip: a payload signed with the configured key verifies', () => {
    const payload = JSON.stringify({ type: 'kick-user-from-project', projectId: 'p', userId: 'u', ts: Date.now() });
    const sig = signControlPayload(payload);
    expect(verifyControlPayload(payload, sig)).toBe(true);
  });

  it('rejects a forged signature', () => {
    const payload = JSON.stringify({ type: 'kick-user-from-project', projectId: 'p', userId: 'u', ts: Date.now() });
    const validSig = signControlPayload(payload);
    const forgedSig = (validSig[0] === '0' ? '1' : '0') + validSig.slice(1);
    expect(verifyControlPayload(payload, forgedSig)).toBe(false);
  });

  it('rejects a signature length mismatch (no timingSafeEqual crash)', () => {
    const payload = JSON.stringify({ type: 'kick' });
    expect(verifyControlPayload(payload, 'short')).toBe(false);
  });

  it('rejects when the HMAC key is not configured', () => {
    _setControlChannelHmacKey(null);
    const payload = JSON.stringify({ type: 'kick' });
    expect(verifyControlPayload(payload, 'anything-at-all-just-anything')).toBe(false);
  });

  it('signature changes when payload changes', () => {
    const a = signControlPayload('{"a":1}');
    const b = signControlPayload('{"a":2}');
    expect(a).not.toBe(b);
  });
});
