# Local Compile Helper — Design

Status: draft, pre-implementation. Reviewer: project owner.
Pre-work rollback anchor: tag `v-pre-local-compile` on commit
`3effca6`. Any time during implementation, `git reset --hard
v-pre-local-compile` returns FlowTex to a known-good shipping state.

## 1. Why

Today every compile runs `latexmk` on the shared VPS. That's the
single biggest CPU + memory consumer on the box and the reason the
server-side compile is wrapped in `prlimit`. Moving compile to the
user's own machine — when they have a matching TeX Live install — has
three concrete wins:

- Server load drops roughly in proportion to the fraction of users who
  opt in. A user on `flowtex.click` with the helper installed never
  spawns a `latexmk` process on the VPS again.
- Latency on the typical edit-compile loop falls from ~2-4 s (network
  + queue + compile + stream) to roughly the local compile time alone
  (~300-800 ms for normal docs).
- Source for the compile step never leaves the user's machine, useful
  for institutions with data-residency concerns.

## 2. Non-goals

- Replacing the server compile path. The server path stays in place,
  unchanged, as the default and as the safety net.
- Offline editing. Editing, save, comments, mentions, OT, presence —
  all still go through the server. The helper compiles; it does not
  store project state.
- Cross-machine compile sharing. Each user's local compile is private
  to their browser tab; PDFs are not uploaded back to the server.

## 3. Compatibility & rollback contract

This is the contract under which we can begin work without risking the
current shipping behaviour.

### 3.1 No behavioural change for non-opt-in users

- All new settings default to "server" (the current behaviour).
- The compile button, the PDF viewer, the SyncTeX path, the streaming
  log — all unchanged for any user who has not toggled the new option.
- The helper binary is a separate artefact; it is not installed
  alongside FlowTex by default.

### 3.2 Schema is additive only

Two columns get added, both nullable, both with safe defaults:

```sql
ALTER TABLE users
  ADD COLUMN compile_location TEXT NOT NULL DEFAULT 'server';
  -- 'server' | 'local'

ALTER TABLE projects
  ADD COLUMN compile_location TEXT DEFAULT NULL;
  -- NULL means "use user default"
  -- 'server' or 'local' to override per project
```

Rollback path A (preferred): leave the columns in place, set every row
back to default, revert the application code. The columns become
unused but harmless.

Rollback path B (clean): `ALTER TABLE ... DROP COLUMN` after reverting
application code. Reversible, no data loss because the new columns
held only user preferences, not authored content.

### 3.3 Server-side code paths unchanged

The existing routes (`POST /api/compile/:id`, `GET
/api/compile/:id/compile-stream`, `GET /api/compile/:id/pdf`,
`/syncforward`, `/syncinverse`) keep their current implementations.
Local compile is a new client branch that does *not* call them; it
talks to the helper directly. No conditional logic added to the
existing routes.

### 3.4 Feature flag at every level

- **Server flag** `FEATURE_LOCAL_COMPILE` (env var, default false).
  When false, the new account/project settings are hidden from the
  UI and the columns are read-only at the API layer (no PUT/PATCH
  accepts them). This is the kill switch if a problem is found in
  production.
- **Client flag** `import.meta.env.VITE_FEATURE_LOCAL_COMPILE`,
  default false. When false, the helper-detection ping never fires
  and the settings panels render the legacy UI.

### 3.5 Tag and branch hygiene

- `v-pre-local-compile` already tagged at `3effca6`. Do not delete.
- All implementation work lives on a feature branch
  `feat/local-compile-helper` until it is end-to-end stable. Merges
  to `main` happen behind the flag, never before.
- Each phase (see §11) is its own commit. Reverting any single phase
  must leave the system in a working state.

## 4. Architecture

```
                          ┌────────────────────────────┐
                          │  Browser (FlowTex client)  │
                          │ ┌────────────────────────┐ │
                          │ │ CodeMirror editor      │ │
                          │ │ Project state, OT, TC  │ │
                          │ │ PDF viewer             │ │
                          │ └─────────┬──────────────┘ │
                          │           │                │
                 (a) ws / rest        │ (b) local http │
                          │           ▼                │
                          │  resolveCompileLocation()  │
                          └──┬─────────────────┬───────┘
                             │                 │
              ┌──────────────┘                 └───────────┐
              ▼                                            ▼
  ┌─────────────────────────┐               ┌──────────────────────────┐
  │ FlowTex server (VPS)    │               │ flowtex-helper (local)   │
  │ POST  /api/compile/:id  │               │ POST   /compile          │
  │ GET   .../compile-stream│               │ POST   /cancel/:jobId    │
  │ GET   .../pdf           │               │ GET    /version          │
  │ existing pipeline       │               │ GET    /health           │
  └─────────────────────────┘               │ binds 127.0.0.1 ONLY     │
                                            └──────────────────────────┘
```

The blue (a) arrows are the existing path (unchanged). The green (b)
arrow is new and only fires when the resolved compile location is
`local` and the helper is healthy and version-matched.

## 5. Settings resolution

```
project.compile_location   user.compile_location   helper status     →  effective
───────────────────────────────────────────────────────────────────────────────────
'server'                   *                       *                 →  server
'local'                    *                       healthy + match   →  local
'local'                    *                       missing           →  server (toast)
'local'                    *                       version mismatch  →  server (toast)
NULL                       'server'                *                 →  server
NULL                       'local'                 healthy + match   →  local
NULL                       'local'                 missing           →  server (toast)
NULL                       'local'                 version mismatch  →  server (toast)
```

The fallback is always to server. The user is never stuck.

```js
// client/src/utils/compileLocation.js (new)
export function resolveCompileLocation(project, user, helperStatus) {
  const wanted = project.compile_location || user.compile_location || 'server';
  if (wanted === 'server') return { source: 'server' };
  if (!helperStatus.available) {
    return { source: 'server', fallbackReason: 'no_helper' };
  }
  if (helperStatus.year !== (project.tex_distribution || helperStatus.year)) {
    return { source: 'server', fallbackReason: 'version_mismatch' };
  }
  return { source: 'local' };
}
```

## 6. The helper binary

### 6.1 Language and packaging

- Written in **Go** (rationale: single static binary, ~5 MB, trivial
  cross-compile to mac/linux/windows, mature HTTP + TLS stdlib, easy
  to ship as a homebrew formula / `.dmg` / `.msi` / `.deb`).
- Project lives in a sibling repo `flowtex-helper` so it has its own
  release cadence and a clean attack surface to audit.
- Reproducible builds via `go build -trimpath -ldflags="-s -w"`.

### 6.2 Filesystem layout

```
~/.flowtex-helper/
  config.json           # bearer token, allowed origins, port
  helper.log            # rolling log (10 MB max, 3 files)
  certs/                # local TLS cert (Let's Encrypt for
                        # helper.localhost.flowtex.click, see §7.4)
  jobs/<uuid>/          # per-compile temp dir (cleaned on exit)
```

`config.json`:

```json
{
  "version": 1,
  "port": 9876,
  "bearer_token": "<32 bytes hex, generated at install>",
  "allowed_origins": ["https://flowtex.click"],
  "tex_distribution_year": "2025",
  "shell_escape": false,
  "telemetry": false
}
```

### 6.3 Endpoints

All endpoints (except `/health` and `/pair`) require
`Authorization: Bearer <token>` and an `Origin` header on the allow
list.

| Method | Path              | Auth | Purpose                                  |
| ------ | ----------------- | ---- | ---------------------------------------- |
| GET    | `/health`         | no   | "Is the helper running?" — no info leak. |
| GET    | `/version`        | yes  | TeX Live year, engines available, biber. |
| POST   | `/pair`           | code | One-shot pairing (§7).                    |
| POST   | `/compile`        | yes  | Run a compile. Returns PDF + log.        |
| POST   | `/cancel/:jobId`  | yes  | Abort a running compile.                 |
| GET    | `/jobs/:jobId/pdf`  | yes  | Stream the PDF (or 404 if not ready).  |
| GET    | `/jobs/:jobId/log`  | yes  | SSE stream of compile output.          |

### 6.4 Compile request shape

```json
{
  "jobId": "<uuid the client picks>",
  "mainFile": "main.tex",
  "compiler": "pdflatex",
  "showTrackedChanges": false,
  "files": [
    { "path": "main.tex", "content": "\\documentclass…", "isBinary": false },
    { "path": "fig/diagram.pdf", "content": "<base64>", "isBinary": true },
    ...
  ]
}
```

### 6.5 Compile cage — parity with server

The helper *must* match `server/compiler.js` exactly. Specifically:

- `--no-shell-escape` on every engine.
- `--safer` injected for lualatex via `$lualatex` override (same trick
  as in `server/compiler.js`, since the helper also calls latexmk).
- `openin_any=p` + `openout_any=p` in the latexmk env.
- Resource caps via platform-appropriate primitive:
  - Linux/Mac: `prlimit` (mac via `setrlimit` syscall in Go, since
    `prlimit` is Linux-only).
  - Windows: Job Object with memory + CPU caps.
- Job temp dir is per-compile; cleaned on success, failure, or
  cancel. Symlinks refused (mirror the `O_NOFOLLOW` trick).

The helper must NOT relax any of these to "trust the local user". A
malicious project shared by a collaborator would otherwise execute
arbitrary code on the user's machine. Shell-escape opt-in (for
`minted` etc.) is a per-user setting in `config.json`, not a
per-project URL parameter.

## 7. Pairing flow

The single hardest design problem. The helper listens on
`127.0.0.1:9876` and must distinguish requests "from the user's
FlowTex tab" from requests "from any other process or website".

### 7.1 Threat model

| Adversary | Attack | Without mitigation | With proposed mitigation |
| --- | --- | --- | --- |
| Random website the user visits | `fetch('http://127.0.0.1:9876/compile', ...)` to exfiltrate or DoS | RCE if shell-escape, PDF exfil, DoS | Blocked: no bearer, wrong Origin |
| Other app on user's machine | Local `curl` to the helper | Same as above | Blocked: no bearer |
| Malicious browser extension | Reads localStorage, replays token | Token theft | Limited: extensions can already exfiltrate session cookies; this isn't a new attack surface |
| MitM on local network | Sniffs `127.0.0.1` traffic | None — loopback only | n/a |
| Compromised helper binary | Anything | Anything | Bundle into signed update channel |

### 7.2 The token

- Generated at helper install: 32 random bytes, hex-encoded.
- Stored once in `~/.flowtex-helper/config.json` (file mode 0600).
- Sent on every authenticated request as `Authorization: Bearer <hex>`.
- Rotated on user demand from the helper tray menu, which invalidates
  any browser tabs that paired previously (they re-pair).

### 7.3 The pairing handshake

The challenge: how does the browser learn the bearer token without
the user copy-pasting 64 hex chars?

**Two-step time-windowed pairing**:

1. User opens the helper's tray menu (macOS menu bar, Windows tray,
   Linux notification area). Clicks "Pair with FlowTex". A 6-digit
   pairing code is displayed and the helper enters "pairing mode"
   for 60 seconds.
2. In FlowTex → Settings → Local compile → "Pair helper" button. A
   dialog asks for the 6-digit code. User types it.
3. Browser POSTs `/pair?code=123456` to the helper. The helper
   validates the code, generates the bearer token (or rotates an
   existing one), and returns it in the response body.
4. Browser stores the bearer token in `localStorage` under
   `flowtex.helper.token`. Pairing mode exits immediately on success.

Why this shape:

- The user is **physically interacting with the helper** before any
  network call goes through — no website can pair without the user
  opening the tray and reading the code.
- The pairing code is 6 digits (~20 bits) — brute-forceable in
  theory but the 60-second window + per-second rate limit on `/pair`
  makes it 60 attempts max, so expected guesses is 500 k.
  Acceptable for a hands-on workflow.
- The actual bearer token is 256 bits — no brute force concern
  once handed off.

### 7.4 Cross-origin / mixed-content

The page is served from `https://flowtex.click`. Direct `fetch` to
`http://127.0.0.1:9876` triggers two problems:
- Mixed content (browser blocks HTTP from HTTPS page).
- CORS preflight noise.

**Solution**: the helper terminates TLS on a domain that points to
loopback.

- We control DNS for `flowtex.click`. Add an `A` record:
  `helper.localhost.flowtex.click → 127.0.0.1`.
- The helper requests a Let's-Encrypt cert for that hostname (via
  DNS-01 challenge proxied through the FlowTex server, or via HTTP-01
  if the helper is reachable on 80 during issuance — the former is
  simpler and avoids opening port 80).
- Browser does `fetch('https://helper.localhost.flowtex.click:9876/...')`.
  Cert is valid, hostname resolves to loopback, no mixed-content.

The cert renews every 60 days. The helper does this autonomously.

CORS is then a simple allowlist: helper sets
`Access-Control-Allow-Origin: https://flowtex.click` and rejects
anything else.

### 7.5 What if Let's-Encrypt is unreachable / cert expires?

Fallback path: ship a long-lived self-signed cert as a backup, with a
visible "Helper certificate is using a fallback signer, please check
your network" banner in FlowTex. The user can ignore it for a session
or fix their helper's connectivity.

## 8. Client integration

### 8.1 What stays the same

- All editor extensions, OT, comments, mentions, etc.
- The PDF viewer (`client/src/components/PdfViewer.jsx`) — it already
  accepts arbitrary URLs.
- The compile button, log panel, SyncTeX forward/inverse — same UI.

### 8.2 What's new

- `client/src/utils/compileLocation.js` — resolution function (see §5).
- `client/src/utils/helperBridge.js` — wraps the bearer-authenticated
  `fetch` calls to the helper. Returns the same shape the server's
  SSE stream returns (so the calling code is uniform).
- `client/src/components/PairHelperDialog.jsx` — the 6-digit pairing
  UI.
- Account-settings panel: "Compile location" radio.
- Project-settings panel: "Compile location for this project" radio
  with the "(currently: …)" annotation.
- Compile button label gains a `(local)` suffix when the resolved
  source is `local`. Mouseover tooltip shows the full reason chain
  ("local helper detected, TeX Live 2025 matches project").

### 8.3 What changes inside `useCompilation`

The hook currently opens an SSE stream to the server's
`/compile-stream`. Wrap that:

```js
async function startCompile() {
  const choice = resolveCompileLocation(project, user, helperStatus);
  if (choice.source === 'server') {
    return startServerCompile();   // existing code, unchanged
  }
  return startLocalCompile();      // new
}
```

`startLocalCompile`:

```js
async function startLocalCompile() {
  // 1. Drain OT save queue so local file state is canonical.
  await flushPendingSaves();

  // 2. Apply tracked-changes macros if showTC is on.
  const files = showTC
    ? applyTcMacros(filesRef.current, ctx)
    : filesRef.current;

  // 3. POST to helper, stream log via SSE on /jobs/:id/log.
  const jobId = uuid();
  const response = await fetch(`${HELPER_BASE}/compile`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getHelperToken()}`, ... },
    body: JSON.stringify({ jobId, mainFile, compiler, showTC, files }),
  });

  // 4. Stream log as it arrives (same UI updates as server path).
  // 5. On done, fetch /jobs/:id/pdf, turn it into a blob URL, hand
  //    to the PDF viewer.
}
```

If any step fails, the catch falls back to the server path with a
toast.

## 9. Tracked-changes pipeline

The server today calls `wrapPendingChangesAsMacros(content, file.tc_marks)`
and `injectTcMacros(content)` ([server/routes/compile.js:188-194][1])
before handing to `compileProject`. The helper doesn't know about TC
semantics, so the client must do this step before sending files.

[1]: server/routes/compile.js

### 9.1 Move the macros to a shared module

Both functions are pure string manipulation. Move them to
`shared/trackedChanges.js` (sibling of `shared/texDeps.js`) so both
the server and the client can import them.

Server-side: replace inline call with `import { wrapPendingChangesAsMacros } from '../shared/trackedChanges.js'`.

Client-side: import the same module in `helperBridge.js`.

Existing server test coverage stays valid because the function is
unchanged — only its location moves.

### 9.2 Existing TC tests stay green

`server/tests/compile-routes.test.js` and the tracked-changes
scenario tests in `client/src/utils/__tests__/` already cover the
input/output of these functions. Run them after the move; they
should pass unchanged.

## 10. Security model — explicit

### 10.1 Bridge bearer token

See §7. The token is the principal authentication mechanism. Without
it, no helper endpoint (except `/health` and `/pair`) responds.

### 10.2 Origin allowlist

`Origin` header must match `allowed_origins` in `config.json` (default
`["https://flowtex.click"]`). For self-hosters, the helper installer
prompts for the FlowTex base URL and writes it into the config.

### 10.3 Loopback binding

The helper's HTTP listener binds to `127.0.0.1` and explicitly
**never** `0.0.0.0`. This is the difference between "anyone on the
LAN can talk to my helper" and "only processes on my machine can".

### 10.4 Compile cage parity

Identical to server (§6.5). The single biggest implementation risk
is the temptation to relax these "because the user trusts their own
machine" — don't, because the source you compile may be from an
untrusted collaborator.

### 10.5 Update channel

Helper auto-update only via signed binaries verified against an
embedded public key. Or skip auto-update and rely on OS package
managers (homebrew, apt). The former is more convenient; the latter
is more secure. Defer choice to phase 2 if helper-install volume is
non-zero.

### 10.6 What we accept as residual risk

- A user with a malicious browser extension already has full session
  cookie access; the helper token in localStorage is a marginal extra
  exposure but not a new attack class.
- A user whose helper config file (`config.json`) is readable by
  other unix users on a shared box (rare for laptops, common for
  multi-user terminals) leaks the bearer token. Mitigation: file
  mode 0600 enforced at startup.
- Sophisticated DNS rebinding attacks against
  `helper.localhost.flowtex.click`. Mitigation: enforce
  `Host` header equality.

## 11. Phased delivery

Every phase is independently revertible. No phase ships with a flag
defaulted to "on" until the previous phase has been live for at least
one week without bug reports.

### Phase 0 — Spike (1 week, throwaway code)

- Stand up a minimal helper in Go that compiles a hardcoded `.tex`
  file. Measure: cold-start time, peak heap, compile time vs server
  for a real thesis, biber availability.
- Validate the loopback-TLS approach works in Chrome, Safari,
  Firefox.
- Decision gate: if any of the validations fail, stop and revisit
  in 6 months.

Branch: `spike/local-compile`. Discarded after the gate.

### Phase 1 — Helper binary (2 weeks)

- Full helper repo with all endpoints (§6.3).
- Pairing flow (§7), tested manually on all three OSes.
- Compile cage parity audit against `server/compiler.js`.
- No FlowTex code changes in this phase. Helper is published but
  unused.

Commit on `feat/local-compile-helper`.

### Phase 2 — Server flag + schema migration (2 days)

- `FEATURE_LOCAL_COMPILE` env var.
- Schema migration adds the two columns, both safe defaults.
- API: `PATCH /api/me` accepts `compile_location` when flag is on;
  `PATCH /api/projects/:id` accepts the same.
- Tests: behaviour with flag off matches current behaviour exactly.

Single commit, reversible by reverting plus the schema rollback in §3.2.

### Phase 3 — Client opt-in path (1 week)

- Account-settings UI + project-settings UI.
- `resolveCompileLocation`, `helperBridge`, `useCompilation` branch.
- Compile button label + tooltip.
- Move TC macros to `shared/` (§9.1).

Behind `VITE_FEATURE_LOCAL_COMPILE`. Default off.

### Phase 4 — Internal dogfood (2 weeks)

- Flip the flag on for the project owner and any willing collaborators.
- Daily check of `compile_source` telemetry (server vs local vs
  fallback).
- Bug fixes only, no new behaviour.

### Phase 5 — General opt-in (open-ended)

- Flag flipped on for all users; settings panel visible.
- Defaults remain "server" / `NULL`. No user is opted in by default.
- Document on USER_GUIDE.md and on a dedicated "Install the helper"
  page.

### Phase 6 — Reconsider (after 3 months of phase 5)

- If `local` adoption is meaningful and fallback rate is low, consider
  promoting "local" to default for users who have the helper.
- If adoption is low or fallback rate is high, leave it as a
  power-user feature and stop investing.

## 12. Testing strategy

### 12.1 Unit-level

- `resolveCompileLocation` covered by client-side tests
  (`compileLocation.test.js`) exhaustively — every row of the table
  in §5.
- `shared/trackedChanges.js` keeps the existing server-side tests; add
  a client-side import test.
- Helper Go tests cover: compile cage parity (mock latexmk to assert
  the exact CLI), pairing flow, bearer-token rejection, origin
  rejection, job cleanup on cancel.

### 12.2 Integration

- A new integration test that toggles the user's `compile_location`
  via the API and asserts the server compile route still produces
  the same PDF — i.e., proves the new column has zero effect on the
  server pipeline.

### 12.3 End-to-end (manual until automated)

- "Helper not installed" → fallback to server, toast shown.
- "Helper installed, wrong TL year" → fallback to server, toast
  shown.
- "Helper installed, matching year" → local compile, PDF appears in
  viewer, SyncTeX click works.
- "User toggles back to server mid-session" → next compile goes
  through server.
- Real-time collaboration: Alice (local) and Bob (server) edit the
  same file. Both see the same source text via WS. Each gets their
  own PDF from their own pipeline.
- Tracked changes: with "show TC in PDF" on, both Alice (local) and
  Bob (server) see identical struck-through deletions and underlined
  insertions in their respective PDFs.

### 12.4 Regression

- Every existing `npm test` / `npm run test:integration` /
  `npm run e2e` suite must pass with the flag off (the default) and
  with the flag on but no helper present (forces fallback).

## 13. What we are explicitly NOT changing

To keep the diff bounded:

- Server compile route handlers — untouched.
- Server compile cage (`server/compiler.js`) — untouched.
- WebSocket frame catalogue — untouched. No new frame types needed
  (local compile is a leaf operation, doesn't interact with OT).
- PDF storage on disk — untouched. Server-compiled PDFs still live in
  `projects/<id>/<base>_<userSuffix>.pdf`. Local-compiled PDFs live
  only in the browser as blob URLs.
- Comments, mentions, chat, presence — untouched.
- Email pipeline — untouched.
- Admin dashboard — untouched (could later add a "compile source"
  pie chart, but that's Phase 6 territory).

## 14. Open questions for the owner

1. **Multi-machine users.** Should the helper-paired token be tied
   to a machine fingerprint, or should the same user be able to
   pair multiple machines and use whichever they're on? (Default
   answer: multiple machines, each paired independently. Tokens are
   per-helper-install, not per-user.)
2. **Shell-escape opt-in.** A per-user "I trust my own files, allow
   shell-escape" toggle is useful for `minted` etc. Should it be in
   the helper UI only (user-local) or surfaced in FlowTex settings
   too? (Default: helper UI only, so a hostile collaborator can't
   flip it via a stolen session cookie.)
3. **Telemetry.** Should the helper report compile stats (anonymous
   count + duration buckets) back to FlowTex servers? Useful for
   measuring phase 6 promotion criteria. (Default: opt-in toggle in
   helper, off by default.)
4. **Self-hosters.** Should the installer ask "what FlowTex server
   do you use?" and write that into `allowed_origins`, or default to
   `flowtex.click` and require manual edit for self-hosters?
   (Default: ask, with `https://flowtex.click` pre-filled.)
5. **Windows support priority.** Mac and Linux are easy; Windows
   adds Job Object plumbing and `.msi` packaging. Worth a separate
   week, or skip until demand is proven?

## 15. Rollback drill

The first thing to verify when implementation begins:

```bash
# Pretend something is on fire. Reset everything to the known-good
# pre-work state.
git fetch
git reset --hard v-pre-local-compile
cd client && npm run build
# restart server
```

If `v-pre-local-compile` ever fails to be a viable production state,
that's a hard stop — the next phase doesn't start until the tag
points at a working version.

---

**Next step**, if this design is accepted: cut the
`feat/local-compile-helper` branch, then begin Phase 0 (the spike).
The spike is throwaway code whose only purpose is to validate the
loopback-TLS bridge and measure helper cold-start; nothing in this
phase touches the main FlowTex codebase.
