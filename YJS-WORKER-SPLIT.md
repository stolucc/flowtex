# YJS-WORKER-SPLIT (SAAS-FOUNDATIONS item 3)

## Why this branch exists

After the YJS migration, every Y.Doc room lives in the web process's
memory. That's correct for a single instance but is the architectural
piece that holds back horizontal scaling: a second web instance has no
way to see the first's Y.Doc state, so two clients pinned to different
backends would diverge.

Splitting the Y.Doc into a dedicated worker process is the
high-leverage change that lets the web tier go stateless. After this
lands, the web tier holds nothing per-room — auth lives in PG, blob
storage abstracted (item 2), broadcasts already optionally fan out via
Redis (item 4). Item 6 — stateless web behind an ALB — is then mostly
load-balancer configuration.

## Architecture (after the full split)

```text
   ┌────────────────┐         Redis Streams         ┌──────────────────┐
   │   web tier     │  ───▶  flowtex:yjs:updates ──▶ │   yjs worker     │
   │  (N replicas)  │                                │   (M replicas)   │
   │                │  ◀── Redis pub/sub ───────── │                  │
   │                │      flowtex:yjs:broadcast    │  - holds Y.Docs  │
   │  - WS handler  │                                │  - applies updates│
   │  - HTTP routes │                                │  - snapshots PG  │
   │  - sessions PG │                                │  - releases idle │
   └────────────────┘                                └──────────────────┘
                                                            │
                                                            ▼
                                                     PostgreSQL
                                                     (files.content_yjs)
```

**Updates** flow web → worker via a Redis Stream so the worker can crash
and resume from where it left off (the stream is the durable log).

**Broadcasts** flow worker → web via Redis pub/sub (the existing channel
from item 4) so a fan-out to all WS clients in the room reaches every
web instance with a member of that room.

**State sync** for late joiners (the `yjs-request-state` round-trip):
web tier issues an `XADD` with the request type and a `replyTo` key;
worker resolves the room state and writes it back to `replyTo`. Web
tier polls the key with a short timeout. This is the "RPC over Streams"
shape — pragmatic and well-tested at scale.

**Ownership** of a `(projectId, fileId)` is a Redis lock with TTL
renewal. Exactly one worker holds the lock at any time. If a worker
dies the lock expires and another worker can acquire it on the next
update for the same room. Snapshots are durable (PG), so an ownership
transfer doesn't lose state.

## Phases

### Phase 1 — Plumbing only (this commit)

- `yjsRoomClient.js` — web-side proxy with the same four-method
  shape as `yjsRoom.js` (`acquireRoom` / `applyUpdate` /
  `encodeStateAsUpdate` / `releaseRoom`). When the flag
  `FLOWTEX_YJS_WORKER=enabled` is on, the client publishes via Redis
  Streams instead of doing the work in-process.
- `yjsWorker.js` — standalone Node entrypoint that reads from the
  Stream and calls into the existing `yjsRoom.js` code.
- Selector at the call sites: when the flag is off (default), code
  paths through `yjsRoom.js` exactly as today. When on, code paths
  through `yjsRoomClient.js`.
- Tests cover: client serialises updates to the Stream shape;
  worker dispatches by message type; flag gates the swap.

**Out of scope for phase 1**: actual cutover, ownership protocol,
metrics on the new path, graceful shutdown coordination. The flag
defaults OFF; phase 1 ships the wiring as latent code.

### Phase 2 — Ownership protocol + multi-worker ✓

- **Consumer group** `flowtex-yjs-workers` on the
  `flowtex:yjs:updates` Stream so each entry is delivered to
  exactly one worker (`XREADGROUP` + `XACK`).
- **Per-room Redis lock** `flowtex:yjs:lock:<projectId>:<fileId>`,
  acquired via `SET NX EX 30`, renewed every 10 s via `SET XX`,
  released via Lua compare-and-DEL so a slow worker never unlinks
  the new owner's key.
- **Lock-contention behaviour**: if a worker receives an entry for
  a room it doesn't own and can't acquire the lock, it deliberately
  *doesn't* `XACK`. The entry stays in the consumer group's PEL
  (pending entries list). An `XAUTOCLAIM` after 30 s hands it to
  whoever the lock-holder is by then.
- **Graceful shutdown**: SIGTERM / SIGINT releases every held lock
  (Lua CAS, never unlinks anyone else's), `releaseRoom` flushes
  snapshots to PG, then exit 0.
- **Tests** (24 cases): lock-key shape, SET NX semantics, SET XX
  renewal, Lua CAS rejecting cross-worker releases, two-worker
  contention scenario, fail-soft on Redis errors, lock-aware
  dispatch in the worker, releaseLock on file-missing, release
  entry is lockless, unknown-type as poison pill.

### Phase 3 — Cutover

- Flag default flipped to enabled.
- Metrics + traces span the web ↔ worker hop (already plumbed in
  item 5 — the histogram labels just need a `surface=worker` value).
- Operator runbook: scaling workers, draining, observability
  dashboard panels.
- Decommission of the in-process `yjsRoom` path (kept as a fallback
  for one release after cutover, then removed in phase 3.5 mirroring
  the YJS phase 6 / 6.5 split).

## Decisions worth flagging now

- **Redis Streams over BullMQ.** BullMQ is great for jobs, but a Y.js
  update is a *signal*, not a job — we don't want exponential backoff
  or retry semantics. Streams give us the durable log without the
  job-queue weight.
- **Pub/sub over WebSocket-back to web tier.** Same channel as
  the existing item-4 fan-out so we don't add a second moving part.
- **Lock-per-room, not consistent-hashing.** Consistent hashing
  rebalances on worker join/leave; locks let the work follow demand.
  At FlowTex's scale the contention rate is low (one writer per room)
  and locks are simpler to reason about.
- **Worker holds the Y.Doc; web holds nothing.** This is the
  invariant that makes the web tier stateless. A snapshot lives in
  PG; everything between snapshots lives in exactly one worker's
  memory. Web instances are interchangeable.

## What does this commit do?

Phase 1 only. The flag defaults OFF, the existing in-process path
ships unchanged, and the new wiring is exercised by unit tests but
not by production traffic yet. Phase 2 is the next focused session.
