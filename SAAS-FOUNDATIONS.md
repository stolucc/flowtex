# SAAS-FOUNDATIONS

## What this branch is

A focused effort to close the operational gap between FlowTex and Overleaf's
production SaaS posture, starting from `yjs-migration` (the CRDT cutover
already completed the editor-correctness gap). The work is split into six
items, ordered so each one is independently shippable, the previous step
keeps running while the next lands, and every step removes a specific scale
ceiling.

## Items in order

### Item 1 — Docker compile sandbox (CLSI-shape) ✓

The only outright security blocker to letting untrusted users compile.
Lifts compile into a separate Node service that spawns a sibling Docker
container per compile (the model Overleaf's `services/clsi` uses). FlowTex
keeps its in-process `compiler.js` as the trusted-tenant default; the
Docker path is selected per-request via a config flag, so SaaS deployments
can demand sandbox while self-hosted academic groups keep the lightweight
path.

**Phase 1** (commit `c87c462`): `services/dockerCompileSandbox.js`,
`compile-sandbox/Dockerfile`, `run-latexmk.sh`, `README.md`. The
locked-down runner and image were ready but unused by `compiler.js`.

**Phase 1.5** (commit pending): `compiler.js` wired through the
sandbox. `onCompilerExit` extracted so both spawn paths (host
`execFile` + prlimit; Docker sibling-container) route into the same
exit handler. Translator maps `runDockerCompile`'s
`{exitCode, signal, stdout, stderr}` into the legacy `(error, stdout,
stderr)` shape the rest of `compileProject` expects. `activeCompilations`
gets a `{child: null}` entry on the Docker path so the count stays
correct without exposing a process handle. Enable with
`FLOWTEX_COMPILE_SANDBOX=docker` + `FLOWTEX_COMPILE_IMAGE=<tag>`.

### Item 2 — Blob storage abstraction (object-persistor shape) ✓

Pluggable backend behind `writeBinaryFileInTx` / `loadFileBytes`. FS
backend is the current `server/projects/<id>/_blobs/` layout; new S3
backend supports R2 / MinIO / AWS S3 with the same interface.
404-fallback chain so an in-flight migration FS → S3 keeps reads
working from either.

**Phase 1** (commit `06aecd0`): selector + FS + S3 backends as
standalone modules. Existing call sites still imported
`blobStore.js` directly.

**Phase 2.5** (commit pending): all four direct callers migrated to
the persistor — `projectService.writeBlob`,
`routes/projects.statBlob/readBlobStream`,
`fileBytes.loadBlobBytes` (replaces the old
`readFile(blobPath(…))` pattern), `blobGc.deleteBlob`. The
FS-specific `blobsDir` stays imported directly by `blobGc` for the
on-disk staging-sweep (S3 has no equivalent concept and the S3
backend manages its own _tmp keys internally during `writeBlob`'s
two-stage upload). 404-fallback chain added: when
`FLOWTEX_BLOB_FALLBACK_BACKEND` is set, `statBlob` and
`readBlobStream` consult the fallback when the primary returns
null. Writes only ever target the primary — the fallback is
read-only, used during an FS → S3 rollout to keep old blobs
reachable until a separate migrator promotes them.

### Item 3 — Y.Doc service split (deferred)

Promote `acquireRoom` / `applyUpdate` / `encodeStateAsUpdate` from
in-process functions into an RPC surface so Y.Docs can live in a separate
worker. Requires item 4 first (Redis fan-out is the cross-instance
synchronisation primitive). Deferred to follow-up session — too large to
do safely alongside items 1, 2, 5.

### Item 4 — Mandate Redis pub/sub for WS fan-out

Currently optional in `server/websocket.js`. For multi-instance deploys
it must be mandatory or two instances broadcasting to the same project
diverge silently. Small change: require `REDIS_URL` when
`FLOWTEX_INSTANCE_MODE=cluster`, fail-fast on startup otherwise.

### Item 5 — Observability

Three pieces:

- `/metrics` Prometheus endpoint with the metrics that matter at scale
  (compile p99, Y.Doc apply latency, room count, WS frame rate, queue
  depth).
- OpenTelemetry tracing hooks so a single compile is traceable end-to-end
  even across the editor/compile/blob service boundaries that items 1
  and 2 introduce.
- Sentry-shaped error reporter — pluggable so the dev / self-host
  installs don't need it but SaaS ops can wire it on.

### Item 6 — Stateless web tier (deferred)

After items 1, 2, 3, 4 are in place, the remaining state in the web
process is session (already in PG), helper-status cache (per-tab), and
Y.Doc rooms (item 3 moves them). Item 6 is then mostly: remove the last
in-memory caches, document the ALB / health-check contract, document the
graceful-shutdown sequence. Defer until items 1–5 are real.

## What this session aims to ship

- Item 4: Redis-required cluster mode.
- Item 5: Prometheus metrics endpoint + lightweight Sentry-shaped error
  reporter.
- Item 2: blob-persistor with FS + S3 backends behind a feature gate.
- Item 1: Docker compile sandbox runner + image, wired to compile.js
  behind a feature gate.

Items 3 and 6 are explicitly out of scope here — each is a focused
multi-day session of its own.

## Non-goals

- No multi-region, no CDN front-end, no SAML / OIDC / SCIM, no
  subscriptions or billing, no `modules/` plugin loader, no TypeScript
  migration. Those are the "you'll regret skipping these" tier from the
  comparison report — they are commercial-completeness work, not
  multi-tenant safety. Different roadmap.
