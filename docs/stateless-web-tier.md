# Stateless web tier — operator runbook

How to put two or more FlowTex web instances behind a load balancer
without losing edits, comments, or live collaboration.

Companion to [yjs-worker.md](./yjs-worker.md) — the worker tier is
the *other half* of statelessness. This doc covers what the web
tier itself needs.

## The three things that keep the web tier stateless

| Concern | What FlowTex does | What you have to configure |
|---|---|---|
| Live Y.Doc rooms | Workers own them via Redis Streams | Enable the worker (see [yjs-worker.md](./yjs-worker.md)) |
| WebSocket fan-out | Redis pub/sub between web instances | `FLOWTEX_INSTANCE_MODE=cluster` + `REDIS_URL` |
| Sessions / CSRF | Stored in Postgres via `connect-pg-simple` | Already correct — nothing to do |
| Compile output | Per-project blob store (FS today, S3 swappable) | Set `FLOWTEX_BLOB_BACKEND=s3` + AWS creds if you need shared storage |

The first two are the meaningful changes. Everything else was
already stateless because FlowTex doesn't store anything else in
process memory.

## Load-balancer contract

Three endpoints to point your LB at:

| Path | Use | Frequency |
|---|---|---|
| `/api/health` | Liveness probe — "is the process responsive?" | Every 5–10 s |
| `/api/ready` | Readiness probe — "should I send new traffic here?" | Every 5–10 s |
| `/` (or anything routed) | Real traffic | n/a |

### `/api/health` — liveness

Returns `200 OK` `{"status":"ok"}` whenever the Node event loop is
responsive. Used to decide "kill this pod and restart it." Should
NOT depend on DB or Redis — those are downstream failures the
process can survive transiently.

If `/api/health` is sustained-failing, the process is wedged and a
restart is the right move.

### `/api/ready` — readiness

Returns `200 OK` `{"status":"ready"}` when the instance can serve
traffic. Returns `503` with a `status` field of:

- `draining` — graceful shutdown is in progress
- `not ready` with `error: 'database unreachable'`
- `not ready` with `error: 'redis unreachable'` (cluster mode only)

The LB should remove this instance from the rotation on 503 and
return it on 200.

This is the canonical "drain me" signal during deploys. The
SIGTERM handler flips `draining` BEFORE closing the WS server or
aborting compiles — gives the LB ~2 s to notice and stop sending
new connections.

### Probe tuning

Recommended for AWS ALB, GCP, K8s, anything similar:

```
livenessProbe:
  path: /api/health
  initialDelaySeconds: 10
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 3

readinessProbe:
  path: /api/ready
  initialDelaySeconds: 5
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 2
```

The readiness probe is faster + less tolerant on purpose — drain
during deploys needs to be quick. Liveness is slower + more
tolerant because we don't want to restart on a transient DB
hiccup.

## Sticky sessions

**You don't need them once the worker tier is live.**

Before the worker tier, Y.Doc rooms lived in the web process — so
all WebSocket traffic for a given project had to land on the
instance holding the room. Sticky sessions (cookie- or IP-based)
were the workaround.

With the worker tier:
- Rooms live in the worker.
- Web instances broadcast applies via Redis pub/sub.
- Any WebSocket connection on any web instance sees the same room
  state.

So: **turn sticky sessions off** when you enable the worker tier.
They add latency (concentrate connections), complicate failover
(LB has to re-sticky on instance loss), and are no longer needed.

## Graceful shutdown sequence

What `systemctl stop flowtex` or a K8s rolling deploy triggers:

1. `SIGTERM` received → `draining = true` immediately.
2. **2-second pause** so the LB's next readiness probe sees 503
   and removes this instance from the rotation. New traffic stops
   landing here.
3. `server.close()` — refuse new HTTP connections (but in-flight
   requests keep running).
4. WebSocket close frame to every connected client (`code: 1001
   server-shutting-down`). Clients reconnect to another instance.
5. `abortAllCompilations(2000)` — SIGTERM in-flight latexmk
   children with a 2 s grace before SIGKILL. Without this, the
   parent's exit leaves them blocked on closed stdio.
6. Disconnect Redis pub + sub clients.
7. Drain the PG pool.
8. `process.exit(0)`.

A 30 s watchdog (matching the systemd `TimeoutStopSec`) force-exits
if anything wedges. The order matters: readiness flips first so
the LB notices, then connections close, then in-flight work
drains.

## Capacity sketch

Per web instance, rough numbers from FlowTex at a small academic
deploy size:

- **Connections per instance**: ~500–1000 active WebSocket clients
  before event-loop lag becomes visible. Node + ws is happy past
  that; the limit is whatever else is doing work in the same
  process.
- **Compile concurrency**: bounded by CPU. With the Docker
  sandbox, each compile spins a fresh container (~100 ms cold
  start) and takes 2–10 s. Two parallel compiles per CPU core is
  a reasonable target.
- **Memory baseline**: ~150 MB resident with no rooms held; rooms
  in the worker tier so the web instance doesn't pay per-project
  memory. Auto-instrumented spans (when OTel is on) add ~20 MB.

These numbers are observational, not benchmarked. Use them as a
starting point for capacity planning, not a guarantee.

## What the LB should NOT do

- **Do not** terminate WebSockets at the LB without forwarding
  `Connection: Upgrade`. Caddy + Nginx + AWS ALB all handle this
  natively if configured to support WS.
- **Do not** add a request size limit smaller than 10 MB unless
  you also adjust it on the FlowTex side. Project import +
  binary file upload paths can legitimately push that much.
- **Do not** strip `Forwarded` / `X-Forwarded-*` headers. FlowTex
  uses `app.set('trust proxy', 1)` so the session cookie's
  `Secure` flag and the rate limiter both rely on those headers
  being present.

## Boot guards (fail-fast against split-brain)

Two server-side checks fire at boot. Either failing means you
land at a clear error instead of silent data corruption.

| Check | Triggers when | Why |
| --- | --- | --- |
| `FLOWTEX_INSTANCE_MODE=cluster` requires `REDIS_URL` | Operator sets cluster mode but no Redis | WebSocket broadcasts can't fan out without it; instances would silently diverge. |
| `FLOWTEX_INSTANCE_MODE=cluster` requires the Y.Doc worker tier | Operator sets cluster mode but no worker (either `FLOWTEX_YJS_WORKER=disabled` explicitly OR the deployed code pre-dates the phase-3 cutover commit `3996223`) | Each web instance would hold its own Y.Doc room while broadcasting updates between them; the inserts converge as concurrent operations, doubling content. The 2026-06-08 incident was exactly this. |

If you see `FLOWTEX_INSTANCE_MODE=cluster requires
FLOWTEX_YJS_WORKER=enabled` at boot, your fix is one of:

```bash
# (a) Flip it on (and run the worker unit if you haven't yet):
echo 'FLOWTEX_YJS_WORKER=enabled' | sudo tee -a /opt/flowtex/.env
sudo systemctl enable --now flowtex-yjs-worker
sudo systemctl restart flowtex

# (b) Or back out of cluster mode entirely (single-VPS shape):
sudo sed -i 's/^FLOWTEX_INSTANCE_MODE=/# FLOWTEX_INSTANCE_MODE=/' /opt/flowtex/.env
sudo systemctl restart flowtex
```

The full recovery procedure for projects already corrupted by
split-brain (boilerplate doubled, edits duplicated, etc.) lives
in [yjs-worker.md → Split-brain](./yjs-worker.md#split-brain-multi-instance-without-the-worker-tier).

## Provisioner support

`scripts/provision-vps.sh` ships:

- `flowtex.service` — the web tier systemd unit
- `flowtex-yjs-worker.service` — the worker unit (installed,
  disabled by default — see [yjs-worker.md](./yjs-worker.md))
- Generated `.env` carries commented hints for the cluster env
  vars (`FLOWTEX_INSTANCE_MODE`, `REDIS_URL`, etc.) so flipping
  them on is a 30-second edit.

Run the provisioner on each web host you add. The first run
generates a `.env`; subsequent runs leave it alone, so you can
safely re-provision an existing host without rotating secrets.

### Single-host scaling: `INSTANCE_COUNT`

For **multiple web processes on one host** (the common case — Node
is single-threaded, so N processes use N cores), set `INSTANCE_COUNT`
when provisioning:

```bash
DOMAIN=flowtex.example.com ADMIN_EMAIL=you@example.com \
  INSTANCE_COUNT=4 bash scripts/provision-vps.sh
```

`INSTANCE_COUNT > 1` is a single knob that:

- generates `flowtex-2.service … flowtex-N.service` (ports 3002…),
- forces Redis on and wires the cluster env into `.env`
  (`FLOWTEX_INSTANCE_MODE=cluster`, `REDIS_URL`, `FLOWTEX_YJS_WORKER=enabled`),
- enables + starts the Y.Doc worker (required, or the web tier
  refuses to boot — see the boot guards above),
- builds the Caddy upstream list (`reverse_proxy localhost:3001 …`
  with `lb_policy least_conn`),
- removes orphan `flowtex-N` units when you re-run with a lower count.

Sizing: `INSTANCE_COUNT ≈ nproc − 1` (leave a core for
Postgres/Redis/worker/Caddy). Re-running with a new value is safe and
idempotent — `.env` secrets are never rotated. `update-vps.sh` already
discovers and restarts the whole `flowtex*` set on deploy, so **routine
code updates use `update-vps.sh` and need no `INSTANCE_COUNT`**.

The count is **sticky**: it's persisted to `.env` as
`FLOWTEX_INSTANCE_COUNT`, so a bare `sudo bash provision-vps.sh` re-run
keeps the same number of instances. Pass it explicitly only to change it
— and note `sudo` strips inherited env, so the var must come **after**
`sudo`:

```bash
sudo INSTANCE_COUNT=6 bash scripts/provision-vps.sh   # ✓ reaches the script
INSTANCE_COUNT=6 sudo bash scripts/provision-vps.sh   # ✗ stripped → defaults to 1
```

**This is single-host only** — all instances share the local FS blob
store and one Postgres/Redis. For **multiple hosts** (HA against a host
failure, scale past one machine) you additionally need: a shared blob
backend (`FLOWTEX_BLOB_BACKEND=s3` + `@aws-sdk/*` installed), Postgres
and Redis reachable from every host, and an **external** load balancer
(the per-host Caddy only proxies `localhost`). Those pieces exist but
are not automated by the provisioner.

## Acceptance checklist

Before declaring a multi-instance deployment ready:

- [ ] At least one worker process is running (`systemctl status
      flowtex-yjs-worker` → `active (running)`)
- [ ] Redis is reachable from every web instance and every worker
      (`redis-cli -u "$REDIS_URL" PING` returns `PONG`)
- [ ] Each web instance has `FLOWTEX_INSTANCE_MODE=cluster` and
      `REDIS_URL=...` in its `.env`
- [ ] `/api/ready` returns `200` on every web instance
- [ ] `/metrics` exposes `flowtex_yjs_apply_latency_ms{surface="worker"}`
      (proves the worker tier is active)
- [ ] Sticky sessions are OFF on the LB
- [ ] A test edit on a project, made via instance A's WebSocket,
      appears live in a client connected to instance B
