# FlowTex Grafana dashboard

Ready-to-import dashboard JSON for the metrics exported by
[server/services/metrics.js](../../server/services/metrics.js).

## Import

1. **Stand up Prometheus** pointing at the FlowTex `/metrics`
   endpoint. Minimal `prometheus.yml`:

   ```yaml
   scrape_configs:
     - job_name: flowtex
       metrics_path: /metrics
       scrape_interval: 15s
       static_configs:
         - targets: ['flowtex-web-1:3001', 'flowtex-web-2:3001', 'flowtex-yjs-worker-1:3001']
   ```

   The worker process exposes the same `/metrics` endpoint as the
   web tier on the same port (it shares the Express bootstrap; only
   the route handlers differ between roles).

2. **Add Prometheus as a data source** in Grafana
   (`Connections → Data sources → Add → Prometheus`). Point it at
   the Prometheus URL.

3. **Import the dashboard**: `Dashboards → New → Import → Upload
   JSON file → flowtex-dashboard.json`. Pick the Prometheus data
   source you just added when prompted.

## What you see

| Row | Panels | What it tells you |
|---|---|---|
| Compile | p50/p99 duration, success ratio, queue depth | "are compiles healthy" |
| Y.js | apply p99 split by `surface`, rooms active, snapshot bytes | "is the worker tier keeping up" |
| WebSocket | active connections, in/out frame rate per second | "how loaded is the realtime tier" |
| HTTP | request rate by status class, top-10 routes by p99 | "is anything web-tier slow / failing" |
| Node runtime | event-loop lag p99, resident memory | "is the process itself happy" |

The `surface` label on the Y.js apply panel is what tells you
where the bottleneck is:

- `client` p99 spike → Redis Streams `XADD` is slow (network or
  Redis-side contention).
- `worker` p99 spike → actual Y.Doc apply is slow (Y.js work, not
  transport).
- `in-process` p99 spike → single-VPS deploy, your Y.Doc work on
  the web tier itself is slow.

## Customising

The dashboard uses `$DS_PROMETHEUS` and `$instance` variables
(populated automatically on import). To filter to a single
instance, pick it from the dropdown at the top.

If you change a metric name in `metrics.js`, update the
corresponding `expr` in the JSON. The dashboard is hand-curated
rather than generated from a registry, so renames need a
matching edit here.

## Alerts (not included)

This file is dashboards only. For alerts (page on compile p99 > 10s,
worker apply p99 > 100 ms, event loop lag > 200 ms, etc.) write
PromQL alert rules in your Prometheus / Alertmanager config —
the same expressions used by the panels above work as alert
predicates with a `for: 5m` clause.
