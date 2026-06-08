import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getRegistry,
  recordYjsApply,
  setYjsRoomsActive,
  recordYjsSnapshotBytes,
  recordCompile,
  setCompileQueueDepth,
  setWsConnectionsActive,
  recordWsFrame,
  recordHttpRequest,
  setDefaultSurface,
  getDefaultSurface,
  _resetForTests,
} from '../services/metrics.js';

const savedSurface = 'in-process';
beforeEach(() => { _resetForTests(); setDefaultSurface(savedSurface); });
afterEach(() => { setDefaultSurface(savedSurface); });

async function scrape() {
  return await getRegistry().metrics();
}

describe('metrics registry surface', () => {
  it('exposes the default node-runtime metrics under the flowtex_ prefix', async () => {
    const text = await scrape();
    expect(text).toMatch(/^# HELP flowtex_process_/m);
    // event_loop_lag and resident set are part of the default set --
    // their presence is a useful regression flag against accidental
    // prefix mismatches.
    expect(text).toMatch(/flowtex_nodejs_eventloop_lag_seconds/);
  });

  it('emits flowtex_yjs_apply_latency_ms after recordYjsApply()', async () => {
    recordYjsApply(7.5, 'ok');
    recordYjsApply(120, 'ok');
    recordYjsApply(50, 'err');
    const text = await scrape();
    expect(text).toMatch(/flowtex_yjs_apply_latency_ms_bucket\{[^}]*result="ok"/);
    // Default surface is 'in-process' when no explicit surface is passed
    // and setDefaultSurface hasn't been called.
    expect(text).toMatch(/flowtex_yjs_apply_latency_ms_count\{[^}]*result="ok"[^}]*surface="in-process"\} 2/);
    expect(text).toMatch(/flowtex_yjs_apply_latency_ms_count\{[^}]*result="err"[^}]*surface="in-process"\} 1/);
  });

  it('honours the explicit `surface` argument over the default', async () => {
    recordYjsApply(2.0, 'ok', 'client');
    recordYjsApply(5.0, 'ok', 'worker');
    const text = await scrape();
    expect(text).toMatch(/flowtex_yjs_apply_latency_ms_count\{[^}]*surface="client"\} 1/);
    expect(text).toMatch(/flowtex_yjs_apply_latency_ms_count\{[^}]*surface="worker"\} 1/);
  });

  it('setDefaultSurface changes the per-process label until reset', async () => {
    setDefaultSurface('worker');
    expect(getDefaultSurface()).toBe('worker');
    recordYjsApply(3.0, 'ok');                    // no explicit surface
    const text = await scrape();
    expect(text).toMatch(/flowtex_yjs_apply_latency_ms_count\{[^}]*surface="worker"\} 1/);
  });

  it('setDefaultSurface rejects empty / non-string input (keeps prior default)', async () => {
    setDefaultSurface('worker');
    setDefaultSurface('');                        // no-op
    setDefaultSurface(null);                      // no-op
    expect(getDefaultSurface()).toBe('worker');
  });

  it('emits flowtex_yjs_rooms_active as a Gauge', async () => {
    setYjsRoomsActive(42);
    const text = await scrape();
    expect(text).toMatch(/flowtex_yjs_rooms_active 42/);
  });

  it('emits flowtex_yjs_snapshot_bytes as a Histogram', async () => {
    recordYjsSnapshotBytes(20000);
    const text = await scrape();
    expect(text).toMatch(/flowtex_yjs_snapshot_bytes_count 1/);
  });

  it('emits flowtex_compile_duration_seconds keyed by result + engine', async () => {
    recordCompile(2.3, { result: 'ok', engine: 'pdflatex' });
    recordCompile(45.0, { result: 'timeout', engine: 'lualatex' });
    const text = await scrape();
    expect(text).toMatch(/flowtex_compile_duration_seconds_count\{[^}]*engine="pdflatex"/);
    expect(text).toMatch(/flowtex_compile_duration_seconds_count\{[^}]*result="timeout"/);
  });

  it('emits flowtex_compile_queue_depth as a Gauge', async () => {
    setCompileQueueDepth(7);
    const text = await scrape();
    expect(text).toMatch(/flowtex_compile_queue_depth 7/);
  });

  it('emits ws frames counter labelled by type/direction', async () => {
    recordWsFrame('changes', 'in');
    recordWsFrame('changes', 'in');
    recordWsFrame('yjs-update', 'out');
    const text = await scrape();
    expect(text).toMatch(/flowtex_ws_frames_total\{[^}]*type="changes"[^}]*direction="in"\} 2/);
    expect(text).toMatch(/flowtex_ws_frames_total\{[^}]*type="yjs-update"[^}]*direction="out"\} 1/);
  });

  it('emits ws connections active', async () => {
    setWsConnectionsActive(15);
    const text = await scrape();
    expect(text).toMatch(/flowtex_ws_connections_active 15/);
  });

  it('records HTTP requests with status_class label', async () => {
    recordHttpRequest('GET', '/api/projects', 200, 0.05);
    recordHttpRequest('POST', '/api/projects', 500, 1.2);
    const text = await scrape();
    expect(text).toMatch(/flowtex_http_request_duration_seconds_count\{[^}]*status_class="2xx"/);
    expect(text).toMatch(/flowtex_http_request_duration_seconds_count\{[^}]*status_class="5xx"/);
  });
});

describe('metrics recorder fail-soft semantics', () => {
  it('record helpers do not throw on garbage input', () => {
    expect(() => recordYjsApply(undefined)).not.toThrow();
    expect(() => setYjsRoomsActive(NaN)).not.toThrow();
    expect(() => recordCompile('not-a-number')).not.toThrow();
    expect(() => recordWsFrame(null, null)).not.toThrow();
    expect(() => recordHttpRequest(null, null, 'wat', 'wat')).not.toThrow();
  });
});
