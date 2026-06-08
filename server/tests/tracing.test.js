// SAAS-FOUNDATIONS item 5: tracing.js unit tests.
//
// Verify the opt-in gate (the SDK should NOT load when
// OTEL_EXPORTER_OTLP_ENDPOINT is unset), the no-op withSpan, and
// the real withSpan path. We mock the OTel SDK rather than installing
// it twice in the test environment -- the real SDK is heavy (cold-
// start cost + side effects on global require hooks) and not worth
// exercising in unit tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const PRESERVE = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_SERVICE_NAME'];
const saved = {};

beforeEach(() => {
  for (const k of PRESERVE) saved[k] = process.env[k];
  vi.clearAllMocks();
  // Each test imports tracing.js fresh (vi.resetModules below) so
  // the env at import time controls behaviour.
});

afterEach(() => {
  for (const k of PRESERVE) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function freshTracing() {
  vi.resetModules();
  return import('../tracing.js');
}

describe('tracing: opt-in gate', () => {
  it('does NOT touch the OTel SDK when OTEL_EXPORTER_OTLP_ENDPOINT is unset', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const m = await freshTracing();
    expect(m.isTracingEnabled()).toBe(false);
    // sdkRef stays null -- this is the canonical "did we boot" check.
    expect(m._testing.sdkRef).toBeNull();
  });

  it('isTracingEnabled returns true once a tracer is injected (real-init equivalent)', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const m = await freshTracing();
    // Inject a fake tracer to simulate "init ran".
    m._testing._setTracerForTests({
      startActiveSpan: vi.fn(),
    });
    expect(m.isTracingEnabled()).toBe(true);
  });
});

describe('withSpan: no-op when tracing is disabled', () => {
  it('calls fn with a no-op span object', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const m = await freshTracing();
    const calls = [];
    const result = await m.withSpan('test.op', (span) => {
      // Every API we touch from caller code should be safe to call.
      span.setAttribute('foo', 'bar');
      span.setAttributes({ a: 1, b: 2 });
      span.setStatus({ code: 1 });
      span.addEvent('hello');
      span.recordException(new Error('whatever'));
      span.end();
      calls.push('inside');
      return 42;
    });
    expect(result).toBe(42);
    expect(calls).toEqual(['inside']);
  });

  it('preserves async returns + throws', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const m = await freshTracing();
    await expect(m.withSpan('ok', async () => 'value')).resolves.toBe('value');
    await expect(m.withSpan('boom', async () => { throw new Error('x'); })).rejects.toThrow('x');
  });
});

describe('withSpan: passes through to OTel when a tracer is present', () => {
  it('starts an active span, calls fn with it, ends + returns', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const m = await freshTracing();

    const span = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    };
    const startActiveSpan = vi.fn((name, fn) => fn(span));
    m._testing._setTracerForTests({ startActiveSpan });

    const result = await m.withSpan('test.op', (s) => {
      s.setAttribute('k', 'v');
      return 'value';
    });
    expect(result).toBe('value');
    expect(startActiveSpan).toHaveBeenCalledWith('test.op', expect.any(Function));
    expect(span.setAttribute).toHaveBeenCalledWith('k', 'v');
    expect(span.end).toHaveBeenCalled();
  });

  it('records exceptions + sets ERROR status + re-throws', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const m = await freshTracing();

    const span = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    };
    const startActiveSpan = vi.fn((name, fn) => fn(span));
    m._testing._setTracerForTests({ startActiveSpan });

    const err = new Error('boom');
    await expect(m.withSpan('test.boom', async () => { throw err; })).rejects.toBe(err);
    expect(span.recordException).toHaveBeenCalledWith(err);
    // status code 2 = ERROR in OTel semantics.
    expect(span.setStatus).toHaveBeenCalledWith({ code: 2, message: 'boom' });
    expect(span.end).toHaveBeenCalled();
  });
});
