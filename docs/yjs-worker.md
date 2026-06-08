# Y.Doc worker tier — operator runbook

This is the dedicated process that owns the live Y.Doc rooms when
you scale the web tier horizontally. **Single-VPS deploys don't
need it** — the in-process default is correct for that shape. Read
this when you're moving to multi-instance.

## What it does

In the in-process default, every web instance holds its own Y.Doc
rooms in memory. WebSocket connections must be sticky-routed to the
instance that holds the room, or the room state diverges. That's
fine on one VPS; it breaks the moment you put two web instances
behind a load balancer.

The worker tier moves all Y.Doc rooms into a separate process
fronted by Redis Streams:

```
┌──────────┐    Stream XADD   ┌─────────────────┐
│ Web tier │ ───────────────▶ │ Redis           │
│ (any #)  │                  │  flowtex:yjs:   │
│          │                  │   updates       │
└──────────┘                  └────────┬────────┘
      ▲                                │ XREADGROUP
      │  pub/sub fanout                ▼
      │                       ┌─────────────────┐
      └─────────────────────  │ Y.Doc worker    │
                              │ (1+ instances)  │
                              └─────────────────┘
```

The web tier becomes stateless. Sticky sessions stop being
required.

## When to flip it on

Concrete signal: you're adding a second web instance behind a load
balancer, OR your current single instance is hitting a CPU wall
that scaling vertically can't solve.

If you're on one VPS and not seeing CPU pressure, **don't enable
this**. The added moving parts cost more than they buy.

## Prerequisites

1. **Redis 6.2+** reachable from both the web tier and the worker.
   Local install: `apt-get install redis-server`. Test:
   `redis-cli -u "$REDIS_URL" PING` returns `PONG`.

2. **`REDIS_URL`** set in `.env`. Format
   `redis://[user:pass@]host:port/db` — pick a dedicated DB number
   to keep the Stream namespace isolated from anything else.

3. **`FLOWTEX_INSTANCE_MODE=cluster`** in `.env`. The web tier
   refuses to boot without `REDIS_URL` in cluster mode — fail-fast
   so you can't accidentally run multi-instance without the
   fan-out plumbing.

## Enabling on an existing single-VPS deploy

Three steps. Roughly 5 minutes elapsed.

### 1. Edit `.env`

```bash
sudo -u flowtex tee -a /opt/flowtex/.env >/dev/null <<'ENV'

# Y.Doc worker tier
FLOWTEX_YJS_WORKER=enabled
ENV
```

`FLOWTEX_INSTANCE_MODE=cluster` and `REDIS_URL=...` should already
be set if you're enabling this — if not, set them first.

### 2. Enable + start the worker

The unit file lands during `provision-vps.sh` but is deliberately
not enabled. To turn it on:

```bash
sudo systemctl enable --now flowtex-yjs-worker
sudo systemctl status flowtex-yjs-worker --no-pager | head -10
```

You should see `active (running)`. The worker log line at boot is:

```
yjsWorker: starting   consumer=worker-<pid>-<random>
                      group=flowtex-yjs-workers
```

### 3. Restart the web tier so it picks up `FLOWTEX_YJS_WORKER`

```bash
sudo systemctl restart flowtex
```

The web tier's `yjsRoomSelector` now routes through `yjsRoomClient`
instead of the in-process `yjsRoom`. Rooms previously held in the
web process are released; the next client edit creates the room
on the worker side.

There's a short window (~5–15 s for connected sessions) during the
web restart where WebSocket connections drop and reconnect. Pending
edits queued in the client are replayed on reconnect.

## Scaling to multiple workers

The consumer group handles distribution automatically. Just run
more workers:

```bash
# On a second host
sudo systemctl enable --now flowtex-yjs-worker
```

Each worker picks a unique consumer name (`worker-<pid>-<random>`)
and the consumer group balances pending entries across them via
`XREADGROUP`. Per-room ownership is enforced by a SET NX EX lock on
the canonical key `flowtex:yjs:lock:<projectId>:<fileId>`, so two
workers can't apply concurrent updates to the same room even if
they both pull from the stream.

## What "graceful shutdown" looks like

`SIGTERM` (sent by `systemctl stop` or a rolling deploy):

1. Worker stops calling `XREADGROUP`.
2. For every room in its `heldRooms` set:
   - Acquires the lock (no-op — already holds it).
   - Snapshots the Y.Doc to `file_snapshots` in PG.
   - Calls `releaseLock` (Lua compare-and-DEL).
3. Exits 0.

`systemctl restart flowtex-yjs-worker` should complete in 1–3
seconds for a healthy worker. If it takes longer, check
`journalctl -u flowtex-yjs-worker -n 50` — the most common cause
is a stuck PG snapshot under DB load.

## Failure modes

### Worker crashes mid-apply

`Restart=always` brings it back in `RestartSec=3` seconds.
Locks the dead worker held have a TTL (60 s default) and either
expire or are reclaimed by `XAUTOCLAIM` from another worker.

Clients see a brief pause (worst case ~60 s) where their edits
queue locally. On reconnect, the queue replays into the stream.

### Redis is unreachable

The worker exits with code `2` at boot. `systemctl` retries every
3 s. Set Redis to start before flowtex-yjs-worker:

```ini
[Unit]
After=redis-server.service
Wants=redis-server.service
```

(Already in the unit file shipped by `provision-vps.sh`.)

### Lock contention spike

If `flowtex_yjs_apply_latency_ms{surface="client"}` p99 climbs
above 100 ms, you have lock contention — either too few workers
or rooms are being hammered. Add a worker or look for the
hot-room in traces (`yjs.applyUpdate` span with `project_id` /
`file_id` attributes).

## Disabling (rolling back to in-process)

If something goes wrong and you want to bail:

```bash
# 1. Stop the worker.
sudo systemctl disable --now flowtex-yjs-worker

# 2. Flip the env back.
sudo sed -i 's/^FLOWTEX_YJS_WORKER=enabled/# FLOWTEX_YJS_WORKER=enabled/' /opt/flowtex/.env

# 3. Restart the web tier.
sudo systemctl restart flowtex
```

The web tier reverts to the in-process path and resumes holding
rooms in-process. No data loss — snapshots in PG remain
authoritative regardless of which tier holds the live room.

## What to watch in dashboards

| Metric | What it tells you |
|---|---|
| `flowtex_yjs_apply_latency_ms{surface="client"}` | XADD enqueue latency (web tier → Redis) |
| `flowtex_yjs_apply_latency_ms{surface="worker"}` | Actual Y.Doc apply latency in the worker |
| `flowtex_yjs_rooms_active` (worker process) | How many rooms each worker holds |
| `flowtex_yjs_snapshot_bytes` | Snapshot size distribution — sustained climb means unbounded history growth (file_versions table needs a sweep) |

In traces, the named spans you'll see:

- `yjs.applyUpdate` — per-update apply, attributed to project + file + bytes
- `compile.project` — per-compile pipeline (web-tier only, the worker doesn't compile)
- Auto-instrumented HTTP / pg / ioredis spans as children of the above

## Why a separate process (vs. a thread / worker_threads)

Three reasons:

1. **Crash isolation.** A Y.Doc bug that brings down the process
   shouldn't take the web tier with it.
2. **Independent scaling.** Worker tier is CPU-bound on Y.Doc
   work; web tier is I/O-bound on HTTP. Scaling them together
   wastes capacity in one or the other.
3. **Restart cost.** Restarting the worker doesn't drop active
   HTTP requests. Restarting the web tier doesn't lose Y.Doc
   state.

The cost is operational complexity (one more service to babysit)
plus an extra Redis round-trip per update. The benefits show up at
2+ web instances and disappear at 1 — hence the "don't enable on
single-VPS" guidance at the top.
