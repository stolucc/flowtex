# YJS-MIGRATION

## What this branch is

A focused effort to replace FlowTex's broadcast-relay collaborative
editing with a **Y.js (CRDT) sync layer**. The motivation is the only
real correctness bug in the current real-time architecture: two users
typing at the same offset before either sees the other's change
produces divergent documents with no detection or recovery. CRDTs make
concurrent edits commute by construction; with Y.js this comes from a
mature, well-maintained library rather than a from-scratch OT engine
of the kind Overleaf maintains.

The migration is broken into phases so each phase is independently
reviewable and shippable. The default behaviour does not change until
phase 6.

## Phases

### Phase 1 — Plumbing (this commit)

- `client/src/utils/yjsBinding.js` — Y.Doc + Y.Text + `yCollab`
  CodeMirror extension, with self-echo filtering on a per-tab
  `originId`, base64 wire encoding, and an `isYjsSyncEnabled()`
  feature gate (URL `?yjs=1` or localStorage `flowtex-yjs-sync=1`).
- `server/websocket.js` — new `yjs-update` message type added to
  `messageHandlers`, `writeTypes`, and `editorOnlyWriteTypes`. The
  handler validates fileId-belongs-to-project, caps payload at
  256 KB base64, and broadcasts to room peers (does not echo to
  sender). Same role gate as the existing `changes` type
  (editor-or-better).
- Tests: 12 client unit cases for the binding (seeding behaviour,
  no-double-broadcast on remote-apply, self-echo filter, base64
  round-trip, destroy hygiene) and 7 server unit cases for the relay
  (rejects non-string, empty, oversize, wrong-project; preserves
  originId; drops oversize originId; does not echo to sender).

Default behaviour is unchanged. The flag defaults OFF.

### Phase 1.5 — Editor wiring

- Add an `extraExtensions` prop (or equivalent) to `Editor.jsx` so the
  Y.js extension can be appended to the CodeMirror config when the
  flag is on.
- Add an `useYjsSync(file, sendWs, originId)` hook in `client/src/hooks/`
  that creates a binding per (file, originId), listens for
  `ws:yjs-update` window events, and dispatches them to the right
  binding.
- Add a `ws:yjs-update` dispatch to `useWebSocket.js` mirroring the
  existing `ws:changes` dispatch.
- When the flag is on, suppress the legacy `changes` outgoing broadcast
  (avoid double-sync); leave the legacy receive path intact so older
  clients in the same room still produce visible updates.
- **Manual test:** open two tabs against the same project + file, one
  with `?yjs=1`, one without. Edits from each should appear in the
  other. (Comments / tracked changes are out of scope for this phase.)

### Phase 2 — Server-side Y.Doc persistence

- New column `files.content_yjs BYTEA` for the binary Y.Doc state.
- New server module `server/services/yjsRoom.js` holds an in-memory
  `Y.Doc` per (project, file) currently being collaborated on. The WS
  relay applies incoming updates to this server-side `Y.Doc` and then
  rebroadcasts (which doubles as a synchronisation source for
  late-joining clients).
- Snapshot to `files.content_yjs` on a debounce (every N seconds of
  idle, or every M operations).
- On client open: server sends current Y.Doc state as a single
  `yjs-state` message; client merges into local `Y.Doc`.

### Phase 3 — Migration of existing projects ✓

- **Lazy migration** (landed in phase 2): on first acquireRoom of a
  file with NULL content_yjs, the server seeds the Y.Doc from
  `files.content` and schedules a snapshot. Idempotent — the row is
  written exactly once per file because the seed only runs on the
  NULL branch.
- **Eager migration**: `server/migrate-yjs-init.js` is a one-shot
  CLI for operators who would rather pay the migration cost at
  deploy time than on the first interactive open. Paginated by id,
  filters `content_yjs IS NULL AND is_binary = FALSE`, scopes to a
  single project on `argv[2]` if supplied, safe to re-run.
- **Drift prevention**: every plain-text write to `files.content`
  also sets `content_yjs = NULL`, so the next yjs read re-seeds from
  the latest text. Applies to:
  - `services/projectService.saveFile` (the editor save path)
  - `services/projectService` ZIP import + convert-to-binary
  - `routes/history.js` restore-from-snapshot
  - `utils/gitSync.js` GitHub pull
- **Two-way coherence**: the Y.Doc snapshot path now also writes the
  current text view back to `files.content` so non-yjs read paths
  (HTTP file GET, compile, ZIP export, GitHub push, search) stay in
  sync. The plain column lags the Y.Doc by at most one snapshot
  debounce window (2 s).

### Phase 4 — Comments anchored on `Y.RelativePosition`

- New columns `comments.anchor_start_yjs BYTEA`,
  `comments.anchor_end_yjs BYTEA` storing the encoded relative
  positions.
- Comment-create paths capture the relative position at creation time.
- Comment render paths resolve relative positions to absolute offsets
  on demand.
- Migration: re-anchor existing comments at the time the project's
  Y.Doc is initialised in phase 3.

### Phase 5 — Tracked changes on `Y.RelativePosition`

- Same pattern as comments: relative-position anchors for each
  `TcEntry` (added/removed/range). The current absolute-offset model
  is what produces the worst class of TC drift bugs under concurrent
  edits; this phase eliminates the class.

### Phase 6 — Cut over and remove legacy

- Default `isYjsSyncEnabled()` to true.
- Remove the `changes` message type from the dispatcher and from the
  client's `EditorView.updateListener` broadcast.
- Remove the absolute-offset comment / TC code paths.
- Bump a "minimum-client" version on the server so older clients are
  refused (they would otherwise produce a divergent document by
  bypassing the CRDT layer).

## Risks and decisions

- **Memory.** Each active project's Y.Doc lives in server RAM. The
  largest realistic FlowTex project is in the tens of MB; multiplied
  across active rooms this is still small enough to fit on a single
  VPS. Multi-instance deployments need the Y.Doc to live in Redis or
  be sharded by room — defer until horizontal scaling is on the table.
- **Garbage collection.** `Y.Doc` history grows monotonically; the
  snapshot path in phase 2 implicitly bounds it (snapshot, drop
  history, restart the Y.Doc from the snapshot). A more sophisticated
  GC is unnecessary at FlowTex's scale.
- **Awareness.** `yCollab` accepts an `awareness` parameter for
  cursor and selection broadcast. Phase 1 passes `null` because
  FlowTex already has a working `cursor` message type. We can
  migrate cursors in a future phase if it simplifies the dispatcher.
- **Bandwidth.** Y.js updates are larger than the equivalent plain
  CodeMirror change descriptions because they carry HLC metadata, but
  they are bounded per keystroke and the relay only sends them once
  per local edit. Realistic per-user upload is sub-kilobyte.
- **Compatibility.** The legacy `changes` message stays in the
  dispatcher until phase 6 so a tab on an older build doesn't break
  the experience for a tab on the new build (they just won't see
  each other's edits — phase 1.5 documents this and phase 6 enforces
  it via a minimum-client gate).

## Cost estimate

Each phase is roughly one focused work session. Phases 1 and 1.5 are
straightforward. Phase 2 takes a careful afternoon. Phases 4 and 5 are
the longest because of the test coverage required for anchor
correctness under concurrent edits. End-to-end: ~6–8 sessions of
focused work, mirroring the original Y.js migration estimate.
