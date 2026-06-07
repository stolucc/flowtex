// SAAS-FOUNDATIONS item 5 -- Prometheus metrics surface.
//
// One place that owns the metric registry, the names FlowTex
// exposes, and the helpers callers use to record observations. The
// /metrics endpoint in routes/metrics.js serializes this registry.
//
// Design principles:
//   - One default registry per process, exposed via getRegistry().
//   - Names follow the Prometheus convention
//     `<namespace>_<noun>_<unit>`; we use `flowtex_` as the
//     namespace so a Prometheus rolled up across multiple apps
//     keeps FlowTex metrics distinct.
//   - Histograms over counters for anything that has a latency or
//     size dimension -- the dashboards that matter at scale (p99
//     compile, p99 Y.Doc apply) need quantiles, not just totals.
//   - Buckets chosen for the realistic FlowTex profile: keystrokes
//     are sub-millisecond, compiles are 100ms - 60s.
//   - All record helpers are no-throw wrappers so an instrumentation
//     bug can never take down a hot path.

import client from 'prom-client';

const registry = new client.Registry();

// Default process metrics (event loop lag, GC pauses, RSS, FD count).
// These are the baseline the Overleaf libraries/metrics module also
// always emits; without them you can't tell whether a slow compile
// is the engine or the host.
client.collectDefaultMetrics({ register: registry, prefix: 'flowtex_' });

// ── Y.Doc / collaboration ──────────────────────────────────────────────

const yjsApplyLatencyMs = new client.Histogram({
  name: 'flowtex_yjs_apply_latency_ms',
  help: 'Latency of applying a Y.Doc update to the server-side room.',
  labelNames: ['result'],
  buckets: [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [registry],
});

const yjsRoomsActive = new client.Gauge({
  name: 'flowtex_yjs_rooms_active',
  help: 'In-memory Y.Doc rooms held by this process.',
  registers: [registry],
});

const yjsSnapshotBytes = new client.Histogram({
  name: 'flowtex_yjs_snapshot_bytes',
  help: 'Bytes written per Y.Doc snapshot to files.content_yjs.',
  buckets: [1024, 4096, 16384, 65536, 262144, 1048576, 4194304],
  registers: [registry],
});

// ── Compile ────────────────────────────────────────────────────────────

const compileDurationSec = new client.Histogram({
  name: 'flowtex_compile_duration_seconds',
  help: 'End-to-end compile duration including queue wait.',
  labelNames: ['result', 'engine'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300],
  registers: [registry],
});

const compileQueueDepth = new client.Gauge({
  name: 'flowtex_compile_queue_depth',
  help: 'Compiles currently queued waiting for a worker slot.',
  registers: [registry],
});

// ── WebSocket / fan-out ────────────────────────────────────────────────

const wsConnectionsActive = new client.Gauge({
  name: 'flowtex_ws_connections_active',
  help: 'Currently-connected WebSocket clients on this instance.',
  registers: [registry],
});

const wsFramesTotal = new client.Counter({
  name: 'flowtex_ws_frames_total',
  help: 'WebSocket frames processed, by type and direction.',
  labelNames: ['type', 'direction'],
  registers: [registry],
});

// ── HTTP ───────────────────────────────────────────────────────────────

const httpRequestDurationSec = new client.Histogram({
  name: 'flowtex_http_request_duration_seconds',
  help: 'HTTP request duration by route and status class.',
  labelNames: ['method', 'route', 'status_class'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// ── Record helpers ─────────────────────────────────────────────────────
//
// Every helper is wrapped in a try/catch so a broken metric can't
// throw on a hot path. Failure to record a metric is always a
// silent NOP -- never a 500.

export function recordYjsApply(latencyMs, result = 'ok') {
  try { yjsApplyLatencyMs.observe({ result }, latencyMs); } catch { /* nop */ }
}

export function setYjsRoomsActive(count) {
  try { yjsRoomsActive.set(count); } catch { /* nop */ }
}

export function recordYjsSnapshotBytes(bytes) {
  try { yjsSnapshotBytes.observe(bytes); } catch { /* nop */ }
}

export function recordCompile(durationSec, { result = 'ok', engine = 'unknown' } = {}) {
  try { compileDurationSec.observe({ result, engine }, durationSec); } catch { /* nop */ }
}

export function setCompileQueueDepth(depth) {
  try { compileQueueDepth.set(depth); } catch { /* nop */ }
}

export function setWsConnectionsActive(count) {
  try { wsConnectionsActive.set(count); } catch { /* nop */ }
}

export function recordWsFrame(type, direction = 'in') {
  try { wsFramesTotal.inc({ type, direction }); } catch { /* nop */ }
}

export function recordHttpRequest(method, route, statusCode, durationSec) {
  try {
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    httpRequestDurationSec.observe({ method, route, status_class: statusClass }, durationSec);
  } catch { /* nop */ }
}

// ── Registry export ────────────────────────────────────────────────────

export function getRegistry() {
  return registry;
}

// Reset helpers for tests. Production callers should never call these.
export function _resetForTests() {
  registry.resetMetrics();
}
