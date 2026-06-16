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
  - `services/projectService` ZIP import + convert-to-binary
  - `routes/history.js` restore-from-snapshot
  - `utils/gitSync.js` GitHub pull
  - **Not** the interactive editor save path under Y.js — see the
    post-cutover note below. When Y.js owns a file the HTTP autosave
    is marks-only and never writes `content` / `content_yjs`; the
    Y.Doc snapshot keeps both columns current.
- **Two-way coherence**: the Y.Doc snapshot path now also writes the
  current text view back to `files.content` so non-yjs read paths
  (HTTP file GET, compile, ZIP export, GitHub push, search) stay in
  sync. The plain column lags the Y.Doc by at most one snapshot
  debounce window (2 s).

### Phase 4 — Comments anchored on `Y.RelativePosition` ✓ (foundations)

- New columns `comments.anchor_start_yjs BYTEA`,
  `comments.anchor_end_yjs BYTEA` storing the encoded relative
  positions.
- `services/yjsAnchors.js` -- two pure helpers (`makeAnchorBytes`,
  `resolveAnchor`) wrap `Y.createRelativePositionFromTypeIndex` /
  `Y.encodeRelativePosition` / `Y.decodeRelativePosition` /
  `Y.createAbsolutePositionFromRelativePosition`. `side` option
  controls left vs right binding: end-of-span anchors use
  `side='left'` so typing immediately after a comment doesn't
  auto-extend the highlighted range.
- `routes/comments.js` POST captures anchors when a Y.Doc room is
  active for the file; rows with no active room save NULL anchors
  and rely on the legacy `from_pos` / `to_pos` integers (rows are
  re-anchored later by phase 5 / phase 6 or on next create when a
  room is present).
- `routes/comments.js` GET resolves stored anchors against the
  active room and overwrites `from_pos` / `to_pos` in the response.
  Resolution failures (item garbage-collected, etc.) silently fall
  back to the legacy integers.

### Phase 4.5 — Anchor backfill for legacy comment rows ✓

- `services/yjsAnchors.backfillCommentAnchors(projectId, fileId, ydoc)`
  -- runs once on first `acquireRoom`, captures anchors for every
  comment row on the file whose anchor_start_yjs or anchor_end_yjs
  is still NULL using the row's existing from_pos / to_pos against
  the just-loaded Y.Doc.
- Idempotent + race-safe: the UPDATE predicates on the anchor
  columns still being NULL, so a comment-create that supplies its
  own anchors in parallel isn't clobbered.
- Failures are logged and swallowed -- legacy from_pos / to_pos
  remain authoritative for unmigrated rows; the GET path falls
  back transparently. Phase 6 cutover will retire the legacy
  columns once enough rooms have acquired to drain unanchored rows.

### Phase 5 — Tracked changes on `Y.RelativePosition` ✓

- tc_marks lives in `files.tc_marks` JSONB, so anchors are
  base64-encoded and ride along inside each entry rather than as
  separate columns. New per-entry fields: `anchorStart`, `anchorEnd`
  (both `string|undefined`). Legacy `from` / `to` remain fallbacks.
- `services/yjsAnchors.{captureTcMarkAnchors, resolveTcMarkAnchors,
  serializeAnchorB64, deserializeAnchorB64}` -- the JSON-friendly
  layer over `makeAnchorBytes` / `resolveAnchor`.
- `services/projectService.saveFile` -- when persisting tc_marks
  with an active Y.Doc room, captures anchors per entry before
  serialising. No-op when no room is active; the integer columns
  remain authoritative.
- `services/projectService.getProjectFiles` -- when serving project
  files, walks tc_marks for each file and resolves anchors against
  the active room, overwriting `from` / `to` with CRDT-aware
  values. Entries without anchors fall through.
- `services/yjsAnchors.backfillTcMarkAnchors` -- runs on first
  `acquireRoom` (same place as the comments backfill). Captures
  anchors for tc_marks entries that lack them, race-safe (only
  writes if at least one entry was actually upgraded).

Together with phase 4, this eliminates the largest correctness gap
in the legacy collaborative model: both comments and tracked
changes now follow the characters they're attached to, regardless
of how aggressively other users edit the surrounding text.

### Phase 6 — Cut over ✓ (default flipped)

- `isYjsSyncEnabled()` now defaults to **true**. New sessions use
  CRDT sync end-to-end. Opt-out is explicit:
  - `?yjs=0` in the URL (per-tab, e.g. for debugging the legacy
    relay path)
  - `localStorage.setItem('flowtex-yjs-sync', '0')` (persistent)
- The legacy `changes` relay path stays in place as a hot-pluggable
  fallback. Removing the dispatcher entry, the client's
  `EditorView.updateListener` broadcast, and the absolute-offset
  comment / TC code is deferred to **phase 6.5** so we can monitor
  the production cutover without burning the bridge in the same
  commit.

### Phase 6.5 — Legacy retirement (pending)

- Once two or three production deploys have passed without anyone
  flipping to `?yjs=0`, remove:
  - `changes` from `messageHandlers`, `writeTypes`,
    `editorOnlyWriteTypes`
  - the editor's `onChanges` invocation when not in tracked-changes
    mode (TC marks still ride the `changes` frame because their
    sync moved to anchors but the broadcast didn't)
  - the legacy fall-through in `getProjectFiles` /
    `routes/comments.js` GET that used integer `from`/`to` when
    no anchors were present
- Bump a "minimum-client" version on the server so a very stale
  browser tab can't send `changes` that would produce a divergent
  document by bypassing the CRDT layer.

## Post-cutover production hardening (2026-06)

Four bugs surfaced once Y.js was the default in the flowtex.click
cluster. All fixed; each shipped with tests.

- **HTTP autosave fought the Y.Doc snapshot** (`fcbc478`). The editor
  still ran the legacy debounced `PUT /files/:id` alongside Y.js. Every
  keystroke the Y.Doc snapshot bumped `files.updated_at` and the PUT's
  `baseVersion` went stale → **409 Conflict** on every save; worse, the
  PUT set `content_yjs = NULL`, desyncing live collaborators. Fix: under
  Y.js the autosave is **marks-only** — it omits `content` (and
  `baseVersion`), persists only the `tc_marks` sidecar, and skips the
  request entirely when there are no marks. The Y.Doc snapshot is the
  sole writer of `content` / `content_yjs`. The send/skip decision is a
  pure `client/src/utils/saveBody.js` (`buildFileSaveBody`); the server
  branch is `updateFileContent(... content === undefined ...)`.

- **Split-brain from non-deterministic seeds** (`6817dfb`). Edits
  reached the other tab over the wire but never appeared. Each
  independent seed of the same text used a random Y.Doc client-id, so
  the bases were incompatible and a delta couldn't integrate. Fix:
  seed with a fixed `SEED_CLIENT_ID` (identical in `yjsRoom.js` and
  `yjsBinding.js`) so all seeds of the same text are byte-identical and
  converge. See `project_flowtex_yjs_seed_invariant`.

- **Worker lock churn** (`6817dfb`). `renewLock` used `SET XX`, which
  re-armed/stole another worker's lock and dropped the room on a
  transient Redis blip (re-seeding the Y.Doc, forking collaborators).
  Fix: a Lua compare-and-set that renews only a lock we own and treats
  a transient error as still-held. See YJS-WORKER-SPLIT.md.

- **Large files opened blank** (`5ba2f4c`). The canonical state applied
  fine, but the editor mounted with an EMPTY doc, CodeMirror measured
  line heights while empty, and yCollab then filled the doc via an async
  transaction that CodeMirror never re-measured — the text was in the
  DOM but the viewport painted blank (only large files; small ones sit
  near the top). Fix: mount the editor straight from `file.content`
  (full doc measured at creation, no blank, no flicker), hold the
  yCollab extension back until the binding hydrates (`useYjsSync` exposes
  `hydrated`; `App` gates `editorExtraExtensions` on it), then attach
  yCollab and reconcile the doc to the canonical Y.Text in the SAME
  transaction (no duplicate insert). See
  `project_flowtex_yjs_editor_mount`.

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
