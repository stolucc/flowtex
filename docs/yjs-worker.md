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
Locks the dead worker held have a TTL (`LOCK_TTL_SEC`, 30 s) and
either expire or are reclaimed by `XAUTOCLAIM` from another worker.
Live workers renew their held locks every 10 s via a Lua
compare-and-set (only if still the owner).

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

### Split-brain (multi-instance without the worker tier)

**What it looks like:** boilerplate text appears twice (or N
times for N web instances) when you create a new document. Edits
get spuriously duplicated. The editor doesn't crash; it just
shows wrong content.

**What's happening:** every web instance is broadcasting Y.Doc
updates via Redis pub/sub (correctly — cluster mode wired this
up), but each instance is *also* holding its own copy of the
Y.Doc room in process (incorrectly — the selector should be
routing to the worker tier instead). When instance A seeds a
template into its room and broadcasts the result, instance B
inserts that result as a concurrent insert *on top of* its own
already-seeded template. Y.js correctly converges them as two
independent inserts, you see the template twice.

This was the actual failure mode of the 2026-06-08 production
incident.

**How to prevent it:**

- A boot guard in `websocket.js` (added 2026-06-08) refuses to
  start in cluster mode without the worker tier being active.
  You should never get into this state on current code.
- If you do see this on an older deploy: pull the latest main,
  the guard will catch the misconfiguration at boot rather than
  letting it corrupt data.
- **Deterministic seeding** (added 2026-06-15): a Y.Doc seeded
  from plain text uses a fixed `SEED_CLIENT_ID` (`= 1`, identical
  in `services/yjsRoom.js` and `client/src/utils/yjsBinding.js`)
  rather than a random client-id. Two seeds of the same text are
  then byte-identical, so even a worker re-acquiring a room, a
  worker restart, or a client falling back offline all converge
  instead of producing duplicate concurrent inserts. This is a
  second line of defense — the boot guard is still the primary
  one. Live edits keep using each peer's own random client-id;
  only the seed is pinned. See `project_flowtex_yjs_seed_invariant`.

**How to detect it after the fact** (in case you have a stale
deploy that pre-dates the guard):

```bash
# Stream should have entries flowing if cluster is routed
# correctly to the worker:
redis-cli XLEN flowtex:yjs:updates

# After a live edit, this should go up. If it stays at 0 while
# cluster mode is on, web tier is NOT routing to Redis -- which
# means it's holding rooms in-process, which means split-brain
# is happening as soon as you have 2+ web instances.
```

**How to recover:**

1. Stop cluster mode immediately:

   ```bash
   sudo systemctl disable --now flowtex-2 flowtex-yjs-worker
   sudo sed -i 's/^FLOWTEX_INSTANCE_MODE=/# FLOWTEX_INSTANCE_MODE=/' /opt/flowtex/.env
   sudo sed -i 's/^FLOWTEX_YJS_WORKER=/# FLOWTEX_YJS_WORKER=/' /opt/flowtex/.env
   sudo systemctl restart flowtex
   ```

2. Identify affected projects (anything edited during the window
   when both instances were live). Two ways:

   - **By eye**: open each project, look for doubled content.
   - **By query**: documents with a `\documentclass` line
     appearing more than once are almost certainly affected:

     ```sql
     SELECT project_id, path,
            length(regexp_replace(content, '\\\\documentclass', '', 'g'))
            < length(content)
            AS has_documentclass,
            (length(content) - length(regexp_replace(content, '\\\\documentclass', '', 'g'))) / length('\\documentclass')
            AS occurrences
     FROM files
     WHERE path LIKE '%.tex'
       AND content ~ '\\\\documentclass.*\\\\documentclass';
     ```

3. For each affected file, write clean content back. Example
   for one project's `main.tex`:

   ```bash
   PROJ=<project-uuid>
   sudo tee /opt/flowtex/projects/$PROJ/main.tex >/dev/null <<'EOF'
   \documentclass{article}
   \begin{document}
   ...your real content here...
   \end{document}
   EOF
   sudo chown flowtex:flowtex /opt/flowtex/projects/$PROJ/main.tex

   sudo -u postgres psql flowtex -c \
     "UPDATE files SET content = pg_read_file('/opt/flowtex/projects/$PROJ/main.tex') WHERE project_id = '$PROJ' AND path = 'main.tex';"
   ```

   Then close all browser tabs for FlowTex, hard refresh, reopen
   the project. The editor sees the clean content.

4. **Before re-enabling cluster mode**: pull latest `main` so you
   have the boot guard (`186a45b` or later). After that, the only
   way to get into split-brain is to explicitly set
   `FLOWTEX_YJS_WORKER=disabled` while in cluster mode — and the
   server refuses to boot in that combination.

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
