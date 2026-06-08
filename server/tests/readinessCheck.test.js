// SAAS-FOUNDATIONS item 6: unit tests for evaluateReadiness.
//
// The /api/ready route is a thin wrapper; covering the function
// directly is cheaper than spinning up the whole Express app.

import { describe, it, expect, vi } from 'vitest';
import { evaluateReadiness } from '../services/readinessCheck.js';

const okDb = () => Promise.resolve(1);
const badDb = () => Promise.reject(new Error('connection refused'));
const readyRedis = { status: 'ready' };
const reconnectingRedis = { status: 'reconnecting' };

describe('evaluateReadiness', () => {
  it('returns ready when DB is up and we are NOT in cluster mode', async () => {
    const r = await evaluateReadiness({
      draining: false,
      probeDb: okDb,
      instanceMode: 'single',
      redisClient: null,
    });
    expect(r).toEqual({ ready: true, status: 'ready' });
  });

  it('returns ready when DB and Redis are both up in cluster mode', async () => {
    const r = await evaluateReadiness({
      draining: false,
      probeDb: okDb,
      instanceMode: 'cluster',
      redisClient: readyRedis,
    });
    expect(r.ready).toBe(true);
  });

  it('treats Redis status "connect" as ready (initial handshake completed)', async () => {
    const r = await evaluateReadiness({
      draining: false,
      probeDb: okDb,
      instanceMode: 'cluster',
      redisClient: { status: 'connect' },
    });
    expect(r.ready).toBe(true);
  });

  it('returns draining when the draining flag is set, BEFORE probing anything', async () => {
    // Even if DB and Redis would be broken, draining short-circuits
    // so the route stays cheap during graceful shutdown.
    const probeDb = vi.fn(badDb);
    const r = await evaluateReadiness({
      draining: true,
      probeDb,
      instanceMode: 'cluster',
      redisClient: null,
    });
    expect(r).toEqual({ ready: false, status: 'draining' });
    expect(probeDb).not.toHaveBeenCalled();
  });

  it('returns 503-shape with error=database unreachable when probeDb throws', async () => {
    const r = await evaluateReadiness({
      draining: false,
      probeDb: badDb,
      instanceMode: 'single',
      redisClient: null,
    });
    expect(r.ready).toBe(false);
    expect(r.error).toBe('database unreachable');
  });

  it('returns redis unreachable in cluster mode when client is null', async () => {
    const r = await evaluateReadiness({
      draining: false,
      probeDb: okDb,
      instanceMode: 'cluster',
      redisClient: null,
    });
    expect(r.ready).toBe(false);
    expect(r.error).toBe('redis unreachable');
    expect(r.redisStatus).toBe('absent');
  });

  it('returns redis unreachable in cluster mode when client is reconnecting', async () => {
    const r = await evaluateReadiness({
      draining: false,
      probeDb: okDb,
      instanceMode: 'cluster',
      redisClient: reconnectingRedis,
    });
    expect(r.ready).toBe(false);
    expect(r.redisStatus).toBe('reconnecting');
  });

  it('ignores Redis state when NOT in cluster mode (single-VPS deploys)', async () => {
    // A single-VPS deploy doesn't run Redis, so the readiness check
    // should be DB-only -- a missing or reconnecting Redis must NOT
    // mark us not-ready.
    const r = await evaluateReadiness({
      draining: false,
      probeDb: okDb,
      instanceMode: 'single',
      redisClient: reconnectingRedis,
    });
    expect(r.ready).toBe(true);
  });

  it('treats missing instanceMode as "single" (safe default)', async () => {
    const r = await evaluateReadiness({
      draining: false,
      probeDb: okDb,
      instanceMode: undefined,
      redisClient: null,
    });
    expect(r.ready).toBe(true);
  });
});
