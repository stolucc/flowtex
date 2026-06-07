// SAAS-FOUNDATIONS item 4: FLOWTEX_INSTANCE_MODE=cluster must refuse
// to boot without REDIS_URL so a misconfigured multi-instance deploy
// doesn't silently diverge.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db.js', () => ({
  default: { get: vi.fn(), run: vi.fn(), all: vi.fn() },
}));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Stub ioredis so the "happy path" tests below don't try a real connect.
vi.mock('ioredis', () => ({
  default: class FakeRedis {
    constructor() {}
    on() { return this; }
    subscribe() { return this; }
    publish() { return Promise.resolve(); }
    disconnect() {}
  },
}));

import { initWebSocket } from '../websocket.js';

const PROD_ENV_KEYS = ['FLOWTEX_INSTANCE_MODE', 'REDIS_URL'];
const saved = {};
beforeEach(() => {
  for (const k of PROD_ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of PROD_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function makeFakeHttpServer() {
  return {
    on() {},
    listeners() { return []; },
  };
}
function makeFakeApp() {
  return { locals: {} };
}

// Module-scope redisPub / redisSub in websocket.js persist between
// initWebSocket calls (the production code intentionally holds them
// across the process lifetime). We use vi.resetModules() to give
// each test a fresh module instance so the assertion that redisPub
// is null when REDIS_URL is unset isn't contaminated by a previous
// test that set it.
async function freshInit({ instanceMode, redisUrl }) {
  if (instanceMode === undefined) delete process.env.FLOWTEX_INSTANCE_MODE;
  else process.env.FLOWTEX_INSTANCE_MODE = instanceMode;
  if (redisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = redisUrl;
  vi.resetModules();
  const mod = await import('../websocket.js');
  return mod.initWebSocket(makeFakeHttpServer(), makeFakeApp(), 'secret');
}

describe('FLOWTEX_INSTANCE_MODE gate', () => {
  it('throws when cluster mode is set without REDIS_URL', async () => {
    await expect(freshInit({ instanceMode: 'cluster' }))
      .rejects.toThrowError(/FLOWTEX_INSTANCE_MODE=cluster requires REDIS_URL/);
  });

  it('boots when cluster mode is set AND REDIS_URL is provided', async () => {
    const result = await freshInit({ instanceMode: 'cluster', redisUrl: 'redis://localhost:6379' });
    expect(result).toBeDefined();
    expect(result.redisPub).not.toBeNull();
    expect(result.redisSub).not.toBeNull();
  });

  it('defaults to single-instance mode when FLOWTEX_INSTANCE_MODE is unset', async () => {
    const result = await freshInit({});
    expect(result).toBeDefined();
    expect(result.redisPub).toBeNull();
    expect(result.redisSub).toBeNull();
  });

  it('accepts FLOWTEX_INSTANCE_MODE=single explicitly without REDIS_URL', async () => {
    const result = await freshInit({ instanceMode: 'single' });
    expect(result).toBeDefined();
    expect(result.redisPub).toBeNull();
  });

  it('case-insensitive on FLOWTEX_INSTANCE_MODE', async () => {
    await expect(freshInit({ instanceMode: 'CLUSTER' })).rejects.toThrow();
  });
});
