// SAAS-FOUNDATIONS item 5 (continued) -- OpenTelemetry tracing.
//
// Opt-in via OTEL_EXPORTER_OTLP_ENDPOINT. When unset (the default
// for self-hosted single-VPS deploys), the OTel SDK is never loaded
// and the helpers below are NOPs. When set, the SDK initialises and
// installs auto-instrumentations on http / express / pg / ioredis,
// plus the `withSpan` helper below for manual instrumentation of
// the things auto-instrumentation can't see (Y.Doc apply, compile,
// blob persistor).
//
// Wired in via a top-of-file import in server/index.js so the SDK
// initialises BEFORE the modules it auto-instruments are first
// required. ESM hoists imports, so the wiring is:
//
//   server/index.js, line 1:
//     import './tracing.js';
//   server/index.js, line 2+:
//     import express from 'express';   <-- gets instrumented
//
// The order matters: if any other module imports express first the
// instrumentation misses it. server/index.js is the only top-level
// process entrypoint, so this works.
//
// `withSpan(name, fn)` is the manual-span helper. Callers wrap a
// hot path:
//
//   import { withSpan } from '../tracing.js';
//   await withSpan('yjs.applyUpdate', async (span) => {
//     span.setAttribute('flowtex.project_id', projectId);
//     ... actual work ...
//   });
//
// When tracing is off, withSpan calls fn() with a no-op span. The
// caller doesn't need to know whether tracing is live.

import logger from './logger.js';

let tracer = null;
let sdkRef = null;

const ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'flowtex';

// No-op span shim that matches the parts of the OTel Span interface
// we touch from caller code. Used when tracing is disabled.
const NOOP_SPAN = {
  setAttribute() { return this; },
  setAttributes() { return this; },
  setStatus() { return this; },
  recordException() { return this; },
  addEvent() { return this; },
  end() { /* no-op */ },
};

if (ENDPOINT) {
  // Dynamic import + start. Async, but the SDK is happy to register
  // instrumentations late as long as it runs before the routes
  // actually start handling requests -- which is microseconds after
  // app boot in our case.
  (async () => {
    try {
      const { NodeSDK } = await import('@opentelemetry/sdk-node');
      const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node');
      const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
      const { Resource } = await import('@opentelemetry/resources');
      const semConv = await import('@opentelemetry/semantic-conventions');
      const { trace } = await import('@opentelemetry/api');

      // semantic-conventions exports moved between versions; resolve
      // the service-name key defensively rather than hard-coding the
      // import path.
      const SERVICE_NAME_KEY =
        semConv.ATTR_SERVICE_NAME
        || semConv.SemanticResourceAttributes?.SERVICE_NAME
        || 'service.name';

      const sdk = new NodeSDK({
        resource: new Resource({ [SERVICE_NAME_KEY]: SERVICE_NAME }),
        traceExporter: new OTLPTraceExporter({ url: ENDPOINT }),
        instrumentations: [getNodeAutoInstrumentations({
          // ioredis + pg auto-instrumentation can be very chatty;
          // leave the defaults but document the override hook for
          // operators who want quieter traces.
          '@opentelemetry/instrumentation-fs': { enabled: false },
        })],
      });

      sdk.start();
      sdkRef = sdk;
      tracer = trace.getTracer(SERVICE_NAME);
      logger.info({ endpoint: ENDPOINT, serviceName: SERVICE_NAME }, 'OTel tracing initialised');

      // Graceful shutdown so the last batch of spans flushes on
      // SIGTERM. Without this a Kubernetes rolling restart loses
      // a few seconds of traces on every pod recycle.
      const shutdown = async () => {
        try { await sdk.shutdown(); } catch (err) {
          logger.warn({ err }, 'OTel tracing shutdown failed');
        }
      };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    } catch (err) {
      logger.error({ err }, 'OTel tracing init failed; continuing without tracing');
    }
  })();
} else {
  logger.info('OTel tracing disabled (set OTEL_EXPORTER_OTLP_ENDPOINT to enable)');
}

/**
 * Wrap a function in a span. When tracing is off (no endpoint), `fn`
 * runs with a no-op span and the wrapper is a thin pass-through.
 * When tracing is on, `fn` runs inside the OTel active context with
 * a real span so any auto-instrumented work it triggers (DB queries,
 * Redis commands, child fetches) is correctly attributed.
 *
 * Polymorphic in sync vs async:
 *   - If fn returns a thenable, withSpan also returns a thenable
 *     and ends the span on resolve/reject.
 *   - If fn returns a plain value, withSpan returns the plain value
 *     and ends the span before returning.
 *
 * This lets sync hot paths (e.g. yjsRoom.applyUpdate) be wrapped
 * without forcing every caller to `await`.
 *
 * Throws (sync or async) are recorded with span.recordException +
 * ERROR status, then re-thrown.
 *
 * @typedef {{
 *   setAttribute: (key: string, value: string | number | boolean) => void,
 *   setAttributes: (attrs: Record<string, string | number | boolean>) => void,
 *   recordException: (err: unknown) => void,
 *   setStatus: (status: { code: number, message?: string }) => void,
 *   end: () => void,
 * }} Span
 *
 * @template T
 * @param {string} name
 * @param {(span: Span) => T | Promise<T>} fn
 * @returns {T | Promise<T>}
 */
export function withSpan(name, fn) {
  if (!tracer) {
    // Pass-through. We do NOT wrap in a Promise so a sync caller
    // stays sync.
    return fn(NOOP_SPAN);
  }
  return tracer.startActiveSpan(name, (span) => {
    let result;
    try {
      result = fn(span);
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: 2, message: err?.message || 'error' });
      span.end();
      throw err;
    }
    if (result && typeof result.then === 'function') {
      // Async path -- end the span when the promise settles.
      return result.then(
        (value) => { span.end(); return value; },
        (err) => {
          span.recordException(err);
          span.setStatus({ code: 2, message: err?.message || 'error' });
          span.end();
          throw err;
        },
      );
    }
    // Sync path.
    span.end();
    return result;
  });
}

/** True iff a tracer was successfully initialised. Useful for
 *  observability dashboards / health checks. */
export function isTracingEnabled() {
  return tracer !== null;
}

// Test-only helpers.
export const _testing = {
  _resetForTests() {
    tracer = null;
    sdkRef = null;
  },
  _setTracerForTests(t) { tracer = t; },
  _setSdkForTests(s) { sdkRef = s; },
  get sdkRef() { return sdkRef; },
};
