# FlowTex Architecture

## System Overview

FlowTex is a full-stack web application with a React single-page application frontend, an Express.js backend, PostgreSQL for persistence, and optional Redis for horizontal scaling. LaTeX compilation is delegated to a local TeX Live installation — by default running on the server, or optionally on the user's own machine via the `flowtex-helper` companion app (see `helper/` and `LOCAL_COMPILE_DESIGN.md`). The helper is a single Go binary; on macOS it ships as a `.app` menu-bar app, on Windows as a `.exe` system-tray app (built with `-H=windowsgui`), on Linux it runs headless. The web app and the helper communicate via a loopback HTTPS/HTTP bridge with bearer-token + Origin allowlist + Host pin auth.

The helper also brokers a **local LLM writing assistant**: it proxies a closed set of writing tasks (`write-to-length`, `paraphrase`, `itemize`, `write-it-out`, `custom`) to a locally-installed [Ollama](https://ollama.com/) instance. The browser sends a `task` name + parameters; the helper builds the system prompt from a server-side template, validates the Ollama URL is loopback-only (127.0.0.1 / ::1 / localhost) on every request, streams the response back via SSE, and the editor's right-click menu replaces the selection on Accept. Selected text and model output never traverse the FlowTex server — the path is `browser → helper (loopback) → Ollama (loopback) → helper → browser`. See `helper/llm.go` for the task catalog and `helper/README.md` for setup.

---

## Architecture Diagram

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                   CLIENTS                                       │
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                        React SPA (Vite)                                  │   │
│  │                                                                          │   │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────────────┐   │   │
│  │  │  AuthPage   │ │ProjectList │ │  Toolbar   │ │   ErrorBoundary     │   │   │
│  │  └────────────┘ └────────────┘ └────────────┘ └─────────────────────┘   │   │
│  │                                                                          │   │
│  │  ┌──────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐   │   │
│  │  │ FileTree │ │    Editor    │ │  PdfViewer   │ │ CommentsSidebar  │   │   │
│  │  │          │ │ (CodeMirror) │ │  (PDF.js)    │ │                  │   │   │
│  │  └──────────┘ └──────┬───────┘ └──────┬───────┘ └──────────────────┘   │   │
│  │                      │                │                                  │   │
│  │              SyncTeX forward/inverse                                     │   │
│  │                                                                          │   │
│  │  ┌──────────────┐ ┌───────────────┐ ┌──────────────┐ ┌──────────────┐  │   │
│  │  │ ShareModal   │ │HistoryPanel   │ │GitHubSync    │ │ MfaSetup     │  │   │
│  │  └──────────────┘ └───────────────┘ └──────────────┘ └──────────────┘  │   │
│  │                                                                          │   │
│  │  ┌───────────────────────────┐  ┌────────────────────────────────────┐  │   │
│  │  │       api.js              │  │        WebSocket Client            │  │   │
│  │  │  (CSRF, fetch, auth)      │  │  (presence, cursors, changes,     │  │   │
│  │  │                           │  │   comments, real-time sync)        │  │   │
│  │  └─────────┬─────────────────┘  └──────────────┬─────────────────────┘  │   │
│  └────────────┼───────────────────────────────────┼────────────────────────┘   │
│               │ HTTPS (REST API)                  │ WSS                        │
└───────────────┼───────────────────────────────────┼────────────────────────────┘
                │                                   │
═══════════════════════════════════════════════════════════════════════ NETWORK ═══
                │                                   │
┌───────────────┼───────────────────────────────────┼────────────────────────────┐
│               ▼                                   ▼                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                     Express.js Server (Node.js)                         │   │
│  │                                                                         │   │
│  │  ┌─────────────────────── Middleware Pipeline ───────────────────────┐  │   │
│  │  │                                                                   │  │   │
│  │  │  TLS Redirect ─► Helmet/CSP ─► CORS ─► JSON Parser ─► pino-http │  │   │
│  │  │       ─► Session (connect-pg-simple) ─► CSRF Verify ─► Rate Limit│  │   │
│  │  │                                                                   │  │   │
│  │  └───────────────────────────────────────────────────────────────────┘  │   │
│  │                                                                         │   │
│  │  ┌────────── REST API Routes ──────────┐  ┌──── WebSocket Server ───┐  │   │
│  │  │                                     │  │                         │  │   │
│  │  │  /api/auth/*     Auth & MFA         │  │  Session-based auth     │  │   │
│  │  │  /api/projects/* CRUD, copy, files, │  │  Project rooms          │  │   │
│  │  │                  members, invites   │  │  Presence broadcast     │  │   │
│  │  │  /api/compile/*  Compile, PDF, sync │  │  Change + cursor sync   │  │   │
│  │  │  /api/comments/* Threads, replies,  │  │  Comment + reaction     │  │   │
│  │  │                  @mentions          │  │   events                │  │   │
│  │  │  /api/notifications/* @mention inbox│  │  Chat + reactions       │  │   │
│  │  │  /api/chat/*     Per-project chat   │  │  In-app mention push    │  │   │
│  │  │  /api/history/*  Versions & restore │  │  members-update         │  │   │
│  │  │  /api/github/*   Push/pull/link     │  │  Heartbeat (ping/pong)  │  │   │
│  │  │  /api/tags/*     Tag management     │  │                         │  │   │
│  │  │  /api/admin/*    Admin dashboard +  │  │                         │  │   │
│  │  │                  user delete        │  │                         │  │   │
│  │  │  /api/health     Liveness probe     │  │                         │  │   │
│  │  │  /api/ready      Readiness probe    │  │                         │  │   │
│  │  │                                     │  │                         │  │   │
│  │  └──────────────┬──────────────────────┘  └──────────┬──────────────┘  │   │
│  │                 │                                     │                 │   │
│  │  ┌──────────────┴─────────────────────────────────────┴──────────────┐  │   │
│  │  │                        Core Services                              │  │   │
│  │  │                                                                   │  │   │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────────────┐ │  │   │
│  │  │  │compiler  │ │ gitSync  │ │  crypto  │ │     audit           │ │  │   │
│  │  │  │.js       │ │ .js      │ │  .js     │ │     .js             │ │  │   │
│  │  │  │          │ │          │ │          │ │                     │ │  │   │
│  │  │  │ latexmk  │ │ simple-  │ │ AES-256  │ │ Action logging     │ │  │   │
│  │  │  │ synctex  │ │ git      │ │ -GCM     │ │                     │ │  │   │
│  │  │  │ lacheck  │ │          │ │          │ │                     │ │  │   │
│  │  │  └────┬─────┘ └────┬─────┘ └──────────┘ └─────────────────────┘ │  │   │
│  │  │       │             │                                            │  │   │
│  │  └───────┼─────────────┼────────────────────────────────────────────┘  │   │
│  └──────────┼─────────────┼──────────────────────────┬────────────────────┘   │
│             │             │                          │                         │
│             ▼             ▼                          ▼                         │
│  ┌──────────────┐ ┌──────────────┐    ┌──────────────────────────────────┐    │
│  │   TeX Live   │ │  git-repos/  │    │        PostgreSQL                 │    │
│  │              │ │              │    │                                   │    │
│  │  latexmk     │ │ Working      │    │  users          sessions         │    │
│  │  pdflatex    │ │ copies for   │    │  projects       audit_log        │    │
│  │  bibtex      │ │ GitHub sync  │    │  files          login_attempts   │    │
│  │  synctex     │ │              │    │  comments       github_tokens    │    │
│  │  lacheck     │ │              │    │  comment_replies                 │    │
│  │  latexdiff   │ │              │    │  project_members                 │    │
│  │              │ │              │    │  project_invitations             │    │
│  └──────────────┘ └──────────────┘    │  project_github_links            │    │
│                                       │  tags / project_tags             │    │
│  ┌──────────────┐ ┌──────────────┐    │  file_versions                   │    │
│  │  projects/   │ │ Redis        │    │                                   │    │
│  │              │ │ (optional)   │    └──────────────────────────────────┘    │
│  │ Compiled     │ │              │                                            │
│  │ PDFs, aux    │ │ pub/sub for  │                                            │
│  │ files,       │ │ WebSocket    │                                            │
│  │ SyncTeX      │ │ scaling      │                                            │
│  └──────────────┘ └──────────────┘                                            │
│                                                                                │
│                              SERVER HOST                                       │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### 1. Authentication Flow

```text
Client                     Server                      PostgreSQL
  │                          │                              │
  │  POST /api/auth/login    │                              │
  │  { email, password }     │                              │
  │ ─────────────────────►   │                              │
  │                          │  Check login_attempts        │
  │                          │ ────────────────────────►    │
  │                          │                              │
  │                          │  SELECT user by email        │
  │                          │ ────────────────────────►    │
  │                          │                              │
  │                          │  bcrypt.compare password     │
  │                          │  Verify TOTP (if enabled)    │
  │                          │                              │
  │                          │  Regenerate session          │
  │                          │  Store in session table      │
  │                          │ ────────────────────────►    │
  │                          │                              │
  │  Set-Cookie: session     │  INSERT audit_log            │
  │  Set-Cookie: csrf-token  │ ────────────────────────►    │
  │ ◄─────────────────────   │                              │
```

### 2. Real-Time Editing Flow

```text
User A (Editor)         Server (WebSocket)        User B (Editor)
  │                          │                          │
  │  join { projectId }      │                          │
  │ ─────────────────────►   │                          │
  │                          │  Verify membership       │
  │                          │  Add to project room     │
  │  joined { userId }       │                          │
  │ ◄─────────────────────   │                          │
  │                          │  presence broadcast      │
  │ ◄─────────────────────   │ ─────────────────────►   │
  │                          │                          │
  │  changes { fileId,       │                          │
  │    changes, userId }     │                          │
  │ ─────────────────────►   │                          │
  │                          │  changes { fileId,       │
  │                          │    changes, userId }     │
  │                          │ ─────────────────────►   │
  │                          │                          │
  │  cursor { head, anchor } │                          │
  │ ─────────────────────►   │  cursor { head, anchor,  │
  │                          │    userId, userName }    │
  │                          │ ─────────────────────►   │
```

**WebSocket frame catalogue.** Every frame is JSON `{type, ...}`. Inbound frames from clients are handled by `server/websocket.js` dispatch table; outbound frames are sent via `broadcastToRoom(projectId, msg, [exceptWs])` or `sendToUser(userId, msg)`. Both helpers are exposed at `app.locals.broadcastToRoom` / `app.locals.sendToUser` so HTTP routes (e.g. invite-accept, comment POST) can fan out updates without going through a WS round-trip.

| Direction | Type | Purpose |
| --- | --- | --- |
| in / out | `presence`, `join` | Room membership + user list |
| in / out | `changes` | OT edits, stamped with per-tab `originId` to filter own echoes on reconnect |
| in / out | `cursor` | Remote cursor positions (same `originId` filter) |
| in / out | `comment`, `comment-reply`, `comment-resolve`, `comment-delete`, `comment-edit` | Comment thread events |
| in | `comment-react`, `reply-react` | Toggle emoji reaction on a comment / reply |
| out | `comment-reaction-update`, `reply-reaction-update` | Authoritative full reaction set after a toggle (server replays this to everyone, including the sender, so all clients converge) |
| out | `mention` | Real-time fan-out of a new @-mention to the mentioned user only (via `sendToUser`); offline users get a digest email instead |
| in / out | `chat` | Chat message |
| in | `chat-react` | Toggle emoji reaction on a chat message |
| out | `chat-reaction-update` | Authoritative reaction set after chat react |
| in / out | `typing` | Typing indicator (chat + comment compose) |
| in / out | `tracked-change`, `tracked-change-resolve`, `tracked-change-delete`, `tc-delete-mark` | Tracked-changes pipeline |
| out | `members-update` | Server signals that membership changed (invite accept / member remove); client refetches `/members` to keep avatars + @-autocomplete fresh |
| out | `folder-create`, `folder-delete`, `folder-rename` | File-tree updates fan-out from HTTP write routes |
| out | `history_update` | A new snapshot was created — refresh the history panel |
| out | `invitation` | A new project invitation for this user |

With Redis enabled, the server publishes WebSocket messages to a Redis channel, allowing multiple server instances to relay messages to their local clients.

**Mention → bell → email pipeline.** When a comment or reply is posted, `recordMentions` (in `server/utils/mentions.js`) parses the body for `@Name` / `@"Full Name"` tokens, resolves each to a project-member `user_id`, and writes a row into `comment_mentions` with `notified_at = NULL` and `seen_at = NULL`. The path also accepts an optional `assignedToUserId` so the comment-assignment UI always records a row for the assignee — including the case where the author assigns the comment to themselves (the plain @-mention path still skips self-mentions; assignment is treated as an explicit subscription). Dedup by user id means a user who is both assigned and @-mentioned gets one row, one bell entry, one email.

Two consumers feed off this table:

1. **Bell push.** `comments.js` calls `app.locals.sendToUser(userId, { type: 'mention', ... })` for every recorded mention. Connected clients update the bell badge in real time via `useNotifications`; disconnected users see the badge update on next page load via `GET /api/notifications/mentions`.
2. **Digest email.** A background job (every ~5 minutes) finds rows with `notified_at IS NULL`, batches them by recipient, sends one email per recipient via `renderEmailLayout`, and stamps `notified_at`. `seen_at` is updated independently when the user opens the bell or marks an item read — so closing the tab and re-opening it later still shows the unread count correctly.

**Bell deep-link executor.** Clicking a bell entry doesn't just switch projects — it walks a multi-step state machine in `client/src/App.jsx`:

1. Stash a target (`projectId`, `fileId`, `commentId`) and tick a render counter.
2. An effect picks it up and advances one step per render: wait until the right project is loaded (`selectProject` is async, files stream in via `setFiles`), find the target file by id (preferred) or path (fallback for renames), switch the editor to that file, and re-enter so `activeFile` updates and new-file comments are in flight. Once comments load, look up the target comment and scroll the editor to `from_pos`.
3. If the file or the comment was deleted in the meantime, the executor aborts silently rather than spinning forever.

Tiered rather than one giant when-everything-true gate because state arrives across multiple renders; a single gate would silently misfire if comments showed up before the file switch settled. The mention payload from `/api/notifications/mentions` already includes `file_id` + `file_path` via a `LEFT JOIN`, so no API change was needed.

**Email layout helper (`renderEmailLayout`).** Every transactional email — invitations, email verification, account deletion, password change, mention digests, password reset, admin bug report — runs through one helper in `server/utils/email.js`. It produces a Google-Docs-style card (white card on soft grey, accent-blue wordmark, optional heading, body, single blue CTA button, divider + footnote, tiny footer below the card) using table-based layout and inline styles only (Outlook / Apple Mail won't render `flex`/`grid` or `<style>` blocks). The helper auto-escapes the `preheader` parameter because two callers pass user-controllable strings; the other parameters (`heading`, `bodyHtml`, `footnoteHtml`) deliberately accept HTML and are the caller's responsibility to escape.

**Rate-limit hierarchy.** Limiters are mounted in `server/index.js` in this order:

| Bucket | Limit | Keyed by | Routes |
| --- | --- | --- | --- |
| `apiLimiter` | 1000/15min | IP | catch-all under `/api/` |
| `authLimiter` | 30/15min | IP | login, register, forgot, reset, resend-verification, setup/init |
| `uploadLimiter` | 100/hour | IP | `from-zip`, `upload-zip`, `upload-file` |
| `compileLimiter` (per-project) | 15/min | project id | `/api/compile/*` |
| `compileUserLimiter` | 30/min | user id | `/api/compile/*` |
| `commentCreateLimiter` | 60/min | user id (IPv6-safe fallback) | **method-specific** on `POST /api/comments/:fileId` only |
| `bugReportLimiter` | 5/hour | user id (IPv6-safe fallback) | `/api/bug-reports` |

The IPv6 fallback uses `express-rate-limit`'s `ipKeyGenerator` helper so co-tenants behind a shared `/64` don't share a bucket. All limiters honour `DISABLE_RATE_LIMIT=1` only when `NODE_ENV !== 'production'`. The comment-create limiter is mounted method-specifically so resolve / edit / delete / reply on existing comments stay under the generic limiter — only fresh creation triggers the fan-out the cap is defending against.

**Bug-report flow.** `POST /api/bug-reports` (Help → Report a bug) accepts `{ description, features[] }`, resolves admin recipients via `SELECT email FROM users WHERE is_admin = TRUE` (falls back to `ADMIN_EMAIL` if empty), sends one email per recipient via `sendBugReportEmail` → `renderEmailLayout`, and writes one `bug_report_submitted` audit row whose `targetId` is `count:N` rather than the raw email list (PII hygiene + column-overflow safety on many-admin deployments).

**File-identity invariant.** Both the OT change broadcaster and the tracked-change pipeline carry an explicit `fileId` end-to-end (capture-time on the editor side, payload field on the wire, `change.fileId` in the server-bound POST). Receivers — `applyRemoteChanges`, `applyRemoteTcDelete`, `useTrackedChanges.doHandleTrackChange`, and the WebSocket `tracked-change` handler — drop or shunt-aside any message whose `fileId` doesn't match the file currently being shown / edited. The same pattern protects the local debounced autosave: `handleSave` accepts an explicit `fileId`, and the editor's tcDelBuffer / tcInsertBuffer carry the file id captured at edit time so a buffer flush after a file switch can never write into the wrong file.

### Compile sandbox

`server/compiler.js` invokes `latexmk` with `--no-shell-escape`, TeX-level `openin_any=p` / `openout_any=p`, and (on Linux) `prlimit` caps on address space, file size, CPU time, and pid count. CPU time is set slightly above the JS-side timeout so the kernel never beats the in-process abort to the punch.

For `lualatex` the wrap goes one step further: `$lualatex` is overridden via `-e '$lualatex = q(lualatex --safer %O %S)'` so the engine runs in safer mode, which sandboxes Lua's `os` and `io` libraries to a safe read-only subset. `--no-shell-escape` alone does not gate `io.open`, `os.remove`, or `os.rename` from `\directlua` — they bypass `openin_any` / `openout_any` (which are TeX-level, not Lua-level). `pdflatex` and `xelatex` have no embedded scripting and are already sealed by `--no-shell-escape`.

`compiler`, `tex_distribution`, and `main_file` are settable by any project member (PATCH `/api/projects/:id`) — they're shared compile choices, not administrative settings. This is safe because the compiler engines themselves are sandboxed as above.

### 3. Compilation Flow

```text
Client                Server                TeX Live            Filesystem
  │                     │                      │                    │
  │ GET /compile-stream │                      │                    │
  │ ────────────────►   │                      │                    │
  │                     │  Sync DB files       │                    │
  │                     │  to disk             │                    │
  │ SSE: "Syncing..."   │ ─────────────────────┼───────────────►    │
  │ ◄────────────────   │                      │                    │
  │                     │  exec latexmk        │                    │
  │                     │ ────────────────►     │                    │
  │ SSE: stdout chunks  │                      │                    │
  │ ◄────────────────   │ ◄─── stdout ────     │                    │
  │ ◄────────────────   │ ◄─── stdout ────     │                    │
  │                     │                      │  Write PDF, .synctex.gz
  │                     │                      │ ──────────────►    │
  │ SSE: done {success} │                      │                    │
  │ ◄────────────────   │                      │                    │
  │                     │                      │                    │
  │ GET /pdf            │                      │                    │
  │ ────────────────►   │                      │                    │
  │                     │  Read PDF from disk   │                    │
  │ ◄──── PDF bytes ──  │ ◄────────────────────┼───────────────     │
```

### 4. GitHub Sync Flow

```text
Client              Server              Git (simple-git)         GitHub
  │                   │                      │                      │
  │ POST /push        │                      │                      │
  │ ──────────────►   │                      │                      │
  │                   │ Write DB files       │                      │
  │                   │ to git-repos/        │                      │
  │                   │ ─────────────────►   │                      │
  │                   │                      │                      │
  │                   │ git add -A           │                      │
  │                   │ git commit           │                      │
  │                   │ ─────────────────►   │                      │
  │                   │                      │ git push origin      │
  │                   │                      │ ─────────────────►   │
  │                   │                      │                      │
  │ { commit: hash }  │                      │                      │
  │ ◄──────────────   │                      │                      │
```

---

## Database Schema

```text
┌──────────────┐       ┌──────────────────┐       ┌──────────────┐
│    users     │       │   projects       │       │    tags      │
├──────────────┤       ├──────────────────┤       ├──────────────┤
│ id (PK)      │◄──┐   │ id (PK)          │   ┌──►│ id (PK)      │
│ email        │   │   │ name             │   │   │ user_id (FK) │
│ name         │   │   │ main_file        │   │   │ name         │
│ password_hash│   │   │ archived         │   │   │ color        │
│ totp_secret  │   │   │ trashed          │   │   └──────────────┘
│ totp_enabled │   │   │ created_at       │   │
│ created_at   │   │   │ updated_at       │   │   ┌──────────────┐
└──────────────┘   │   └──────────────────┘   │   │ project_tags │
                   │          │               │   ├──────────────┤
                   │          │               │   │ project_id(FK│
                   │          ▼               └───│ tag_id (FK)  │
                   │   ┌──────────────────┐       └──────────────┘
                   │   │     files        │
                   │   ├──────────────────┤       ┌──────────────────┐
                   │   │ id (PK)          │       │  file_versions   │
                   │   │ project_id (FK)  │       ├──────────────────┤
                   │   │ path             │◄──────│ file_id (FK)     │
                   │   │ content (text)   │       │ project_id (FK)  │
                   │   │ is_binary        │       │ file_path        │
                   │   │ binary_sha256    │──┐    │ content          │
                   │   │ binary_size      │  │    │ author_id        │
                   │   │ binary_mime      │  │    │ author_name      │
                   │   │ created_at       │  │    │ created_at       │
                   │   │ updated_at       │  │    └──────────────────┘
                   │   └──────────────────┘  ▼
                   │          │      ┌──────────────────┐
                   │          │      │  project_blobs   │
                   │          │      │ (project_id +    │
                   │          │      │  sha256 PK)      │
                   │          │      │ size, ref_count  │
                   │          │      └──────────────────┘
                   │          │      on disk:
                   │          │      server/projects/<id>/_blobs/<sh[0:2]>/<sh>
                   │          ▼
                   │   ┌──────────────────┐
                   │   │   comments       │       ┌──────────────────┐
                   │   ├──────────────────┤       │ comment_replies  │
                   │   │ id (PK)          │◄──────┤──────────────────┤
                   │   │ file_id (FK)     │       │ id (PK)          │
                   │   │ from_pos         │       │ comment_id (FK)  │
                   │   │ to_pos           │       │ text             │
                   │   │ text             │       │ author           │
                   │   │ author           │       │ author_id (FK)   │
                   │   │ author_id (FK)───┼───┐   │ created_at       │
                   │   │ resolved         │   │   └──────────────────┘
                   │   │ created_at       │   │
                   │   └──────────────────┘   │
                   │                          │
                   │   ┌──────────────────┐   │   ┌───────────────────────┐
                   ├───│ project_members  │   │   │ project_github_links  │
                   │   ├──────────────────┤   │   ├───────────────────────┤
                   │   │ project_id (FK)  │   │   │ project_id (PK, FK)   │
                   │   │ user_id (FK)─────┼───┤   │ github_repo           │
                   │   │ role             │   │   │ default_branch        │
                   │   │ created_at       │   │   │ last_sync_at          │
                   │   └──────────────────┘   │   │ last_sync_commit      │
                   │                          │   │ linked_by (FK)────────┤
                   │   ┌──────────────────┐   │   │ created_at            │
                   ├───│project_invitations│  │   └───────────────────────┘
                   │   ├──────────────────┤   │
                   │   │ id (PK)          │   │   ┌──────────────────┐
                   │   │ project_id (FK)  │   │   │ github_tokens    │
                   │   │ email            │   │   ├──────────────────┤
                   │   │ role             │   ├───│ user_id (PK, FK) │
                   │   │ inviter_id (FK)──┼───┤   │ token (encrypted)│
                   │   │ status           │   │   │ updated_at       │
                   │   │ created_at       │   │   └──────────────────┘
                   │   └──────────────────┘   │
                   │                          │   ┌──────────────────┐
                   │                          │   │   audit_log      │
                   │                          │   ├──────────────────┤
                   │                          └───│ user_id          │
                   │                              │ action           │
                   │                              │ target_type      │
                   │                              │ target_id        │
                   │                              │ detail           │
                   │                              │ ip               │
                   │                              │ created_at       │
                   │                              └──────────────────┘
                   │
                   │   ┌──────────────────┐       ┌──────────────────┐
                   │   │  session         │       │ login_attempts   │
                   │   ├──────────────────┤       ├──────────────────┤
                   │   │ sid (PK)         │       │ id (PK)          │
                   │   │ sess (JSON)      │       │ email            │
                   │   │ expire           │       │ ip               │
                   └───┤ (contains userId)│       │ success          │
                       └──────────────────┘       │ created_at       │
                                                  └──────────────────┘

Collaboration tables (FKs back to comments / comment_replies / chat_messages):

  comment_mentions       — log of every @-mention; powers in-app bell + 5-min digest
    (id, comment_id?, reply_id?, mentioned_user_id, mentioner_user_id,
     project_id, snippet, created_at, notified_at, seen_at)

  comment_reactions      — emoji reactions on comments
    (id, comment_id, user_id, user_name, emoji, created_at)
    UNIQUE(comment_id, user_id, emoji) → re-applying toggles off

  reply_reactions        — emoji reactions on comment replies (same shape)

  chat_messages          — per-project chat history (last 500 returned via /api/chat)

  chat_message_reactions — emoji reactions on chat messages (same toggle pattern)

  chat_read_cursors      — one row per (project, user); tracks each member's
                           "last read at" timestamp for the per-message read
                           receipts. The GET /api/chat response hydrates a
                           cursor row per project member (LEFT JOIN) so the
                           client can derive own-message ✓ / ✓✓ indicators
                           without re-querying per message
```

---

## Component Architecture

### Server Layers

```text
                    ┌─────────────────────────────┐
                    │     Middleware Pipeline      │
                    │                             │
                    │  Helmet ► CORS ► BodyParser │
                    │  ► pino-http ► Session      │
                    │  ► CSRF ► Rate Limit        │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │       Route Handlers         │
                    │                             │
                    │  auth │ projects │ compile  │
                    │  comments │ history │ github│
                    │  bib │ zotero │ chat │ tags │
                    │  admin │ setup │ health     │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │      Core Services           │
                    │                             │
                    │  compiler.js     - TeX Live │
                    │  gitSync.js      - simple-git│
                    │  crypto.js       - AES-256-GCM│
                    │  audit.js        - action log│
                    │  latexDiff.js    - latexdiff│
                    │  docxToLatex.js  - DOCX import│
                    │  trackedChange-                │
                    │    Markup.js   - TC → latexdiff│
                    │  blobStore.js  - per-project   │
                    │                  blob storage  │
                    │  blobGc.js     - orphan +      │
                    │                  reconciliation│
                    │  fileBytes.js  - bytes-for-row │
                    │  quotas.js     - per-user caps │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │      Data Layer (db.js)      │
                    │                             │
                    │  pg.Pool ► get/all/run      │
                    │  transaction support         │
                    └──────────────┬──────────────┘
                                   │
                                   ▼
                              PostgreSQL
```

### Client Component Tree

```text
main.jsx
  └─ ErrorBoundary
       └─ App
            ├─ ProjectContextProvider           ← shared project/file state
            ├─ EditorRefContextProvider         ← imperative handle to CodeMirror
            │
            ├─ AuthPage (when not authenticated)
            │    ├─ Login form
            │    ├─ Register form
            │    └─ MFA challenge
            │
            ├─ ProjectList (when no project selected)
            │    ├─ Tag sidebar
            │    ├─ Project table
            │    └─ Invitation banner
            │
            └─ Project Editor (when project selected)
                 ├─ Toolbar
                 │    ├─ Project name / rename
                 │    ├─ Member avatars
                 │    ├─ Compile button
                 │    └─ Menus (File · Edit · Insert · View · Format · Tools · Help)
                 │
                 ├─ FileTree (resizable)
                 │    ├─ Folder nodes (collapsible)
                 │    └─ File nodes (click to open · context menu: rename / delete /
                 │      pretty-print BibTeX / set as main / download)
                 │
                 ├─ Editor (CodeMirror 6)
                 │    ├─ LaTeX / BibTeX syntax highlighting
                 │    ├─ Autocomplete (commands + environments + cite/ref keys)
                 │    ├─ Lint diagnostics (gutter markers)
                 │    ├─ Spellcheck underlines
                 │    ├─ Comment highlight decorations
                 │    ├─ Remote cursor decorations
                 │    ├─ Tracked-change marks (insert / delete) with hover popups
                 │    ├─ Citation / reference hover tooltips
                 │    ├─ Visual mode (WYSIWYG) — replace decorations + widget badges
                 │    └─ VisualModeToolbar (overlay, shown only in visual mode)
                 │
                 ├─ SyncArrows
                 │    ├─ Forward sync button (editor → PDF)
                 │    └─ Inverse sync button (PDF → editor)
                 │
                 ├─ PdfViewer (resizable)
                 │    ├─ PDF canvas (PDF.js)
                 │    ├─ Zoom controls
                 │    ├─ Error / warning chips (icon + count, click to expand panel)
                 │    ├─ Lint / log panel (toggle)
                 │    └─ Console output (toggle)
                 │
                 ├─ ChatPanel (resizable, toggleable, lazy chunk)
                 │
                 ├─ CommentsSidebar (resizable, lazy chunk)
                 │    ├─ Comment threads
                 │    ├─ Reply forms
                 │    └─ Collapsed-rail: speech-bubble markers at each
                 │       unresolved comment's y-position when the panel
                 │       is closed
                 │
                 ├─ HistoryView (full-pane, when viewing snapshots, lazy chunk)
                 │    ├─ Snapshot list
                 │    ├─ File list (with diff status per file)
                 │    └─ Hunk-based diff viewer (line cap with show-all toggle)
                 │
                 └─ ModalContainer (conditionally rendered)
                      ├─ ShareModal
                      ├─ ProjectSettingsModal (Project · Editor · Compiler · etc.)
                      ├─ HistoryPanel (snapshot list popover)
                      ├─ GitHubSyncModal (lazy)
                      ├─ CompareFilesModal
                      ├─ BibEnrichModal (lazy)
                      ├─ ZoteroModal (lazy)
                      ├─ WordCountModal
                      ├─ MfaSetupModal
                      ├─ Format-warning modal (themed alert replacement)
                      ├─ Shortcuts modal
                      ├─ About modal
                      └─ ConfirmDialog
```

### Bundle splitting

Vite builds the client into multiple chunks so first-paint doesn't drag
in code that only matters once a project is open:

- `react-*.js` — React + react-dom/client.
- `codemirror-*.js` — every `@codemirror/*` package (manual chunk).
- `pdfjs-*.js` — `pdfjs-dist` (manual chunk).
- `Editor-*.js`, `PdfViewer-*.js`, `HistoryView-*.js`, `ChatPanel-*.js`,
  `CommentsSidebar-*.js`, `BinaryPreview-*.js` — `React.lazy()` chunks,
  loaded only after the user opens a project.
- `AdminDashboard-*.js`, `ProjectSettingsModal-*.js`, `ShareModal-*.js`,
  `WordCountModal-*.js`, `BugReportModal-*.js`, `BibEnrichModal-*.js`,
  `ZoteroModal-*.js`, `CompareFilesModal-*.js`, `GitHubSyncModal-*.js`,
  `HistoryPanel-*.js` — modal-level lazy chunks.
- `index-*.js` — the main entry; ~260 KB raw / ~80 KB gzipped after
  the lazy work (down from ~926 KB before).

`App.jsx` fires `import('./components/Editor.jsx')` and
`import('./components/PdfViewer.jsx')` from a `useEffect` keyed on
`user` — once the user is logged in, those chunks pre-warm in the
background so the click-into-a-project transition resolves from the
module cache instead of paying a fresh round-trip.

`getMimeType` lives in `client/src/utils/mimeType.js` rather than in
`BinaryPreview.jsx` so importing the lookup helper doesn't drag
`pdfjs-dist` into whichever module needs it.

### Visual Mode (WYSIWYG)

Visual mode is a togglable rendering layer over the existing CodeMirror editor — not a separate document model. Toggling it ON installs a single `EditorView` extension (via a `Compartment` so it can be reconfigured without a full editor rebuild) that:

1. Watches the viewport via a `ViewPlugin` and parses only visible ranges (+ a small buffer) using the LaTeX AST in `latexParser.js`.
2. Emits a `RangeSet` of decorations: `Decoration.replace` to hide markup (`\textbf{`, closing `}`, preamble, `\begin{itemize}`, `\label{...}`, etc.) and `Decoration.mark` to apply visual styles (`cm-vm-bold`, `cm-vm-italic`, headings, blockquote indentation).
3. Substitutes widget badges for things that read better as objects: cite/ref labels (with hover popups), list bullets, and inline image / PDF previews.
4. Marks all replace ranges as `EditorView.atomicRanges` so the cursor and selection skip over hidden markup, preventing partial deletion of LaTeX commands.

The source document is never modified — every visual effect is a decoration on top of the original text. Toggling visual mode off restores the raw `.tex` view immediately. The cite-hover and ref-hover tooltips suppress CM6's own `hoverTooltip` when the position is inside a visual-mode decoration so only the badge's body-mounted popup fires (avoids two competing tooltip systems).

`VisualModeToolbar` (a sibling component overlaid on the editor when visual mode is on) reads the cursor's surrounding LaTeX context via `getCursorStyle` and exposes block / inline formatting controls (bold, italic, headings, lists, quote, citation insertion, color).

---

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | React 19 | UI framework |
| | CodeMirror 6 | LaTeX editor |
| | PDF.js 5 | PDF rendering |
| | Vite 8 | Build tool & dev server |
| | Typo.js | Spellcheck |
| **Backend** | Express 5 | HTTP server |
| | ws | WebSocket server |
| | pino / pino-http | Structured logging |
| | Helmet | Security headers |
| | express-rate-limit | Rate limiting |
| | bcryptjs | Password hashing |
| | express-session + connect-pg-simple | Session management |
| | nodemailer | SMTP (email verification, password reset, mention digests) |
| | archiver 8 | ZIP downloads (`ZipArchive` named export — v8 dropped the default) |
| **Database** | PostgreSQL 14+ | Primary data store |
| **Caching** | Redis (optional) | WebSocket pub/sub for multi-instance |
| **LaTeX** | TeX Live (latexmk, pdflatex, xelatex, synctex, lacheck, latexdiff) | Compilation toolchain |
| **Git** | simple-git | GitHub integration |
| **Reverse proxy (recommended)** | Caddy | TLS via Let's Encrypt; `www → apex` redirect, optional load-balanced upstream |

---

## Security Architecture

```text
                        Internet
                           │
                    ┌──────▼──────┐
                    │ TLS Termination │  (reverse proxy or NODE_ENV=production redirect)
                    └──────┬──────┘
                           │
              ┌────────────▼────────────┐
              │    Rate Limiting         │
              │  Auth: 20 req/15 min    │
              │  API:  200 req/min      │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │  Helmet Security Headers │
              │  CSP, X-Frame, HSTS     │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │     CORS Allowlist       │
              │  (CORS_ORIGINS env var) │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │  Session Authentication  │
              │  httpOnly, secure,       │
              │  sameSite=lax cookies    │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │  CSRF Double-Submit      │
              │  Token verification on   │
              │  POST/PUT/PATCH/DELETE   │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │  Authorization Checks    │
              │  requireAuth middleware  │
              │  isProjectMember checks  │
              │  Owner-only operations   │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │  Input Validation        │
              │  Path traversal guard    │
              │  SSRF repo validation    │
              │  Password complexity     │
              │  Account lockout         │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │  Encryption at Rest      │
              │  AES-256-GCM for tokens │
              │  bcrypt (12 rounds) for │
              │  passwords               │
              └──────────────────────────┘
```

---

## Session table hygiene

`connect-pg-simple` is configured with `saveUninitialized: false`, so a session row is only persisted when the session object becomes non-empty. The CSRF middleware enforces this by skipping anonymous traffic entirely: a token + cookie pair is only minted for requests that already carry `req.session.userId`. Anonymous state-changing requests are still protected — `CSRF_EXEMPT_PATHS` (login, register, forgot/reset, setup/init, resend-verification) is Origin-validated, and any other anonymous POST / PUT / PATCH / DELETE fails the CSRF check (no `session.csrfToken` to compare against) and would hit `requireAuth` afterwards anyway.

The first-run setup route explicitly mints the CSRF token + cookie after the bootstrap admin is logged in, mirroring the post-login `regenerateSession` flow in `auth.js` — without this the first state-changing request after setup would 403.

Effect: bots / crawlers / uptime probes no longer accumulate orphan session rows. The admin dashboard's active-sessions count now reflects real authenticated users; on a single-digit-user install it should match.

## Route conventions

The REST API uses `PUT` and `PATCH` with distinct semantics on the same resource:

- **`PUT /api/projects/files/:fileId`** replaces the file's *content* (the body of the resource).
- **`PATCH /api/projects/files/:fileId`** performs a partial update — currently used to *rename* the file (modifying its `path` field).

This split is intentional: `PUT` is treated as a full-content replace because LaTeX file bodies can be megabytes in size and the editor sends the entire buffer on save, while `PATCH` carries small metadata changes. When adding new file-level operations, prefer `PATCH` for any partial / metadata update and reserve `PUT` for full-content replacement so client-side helpers (`api.put` vs `api.patch`) stay aligned with these meanings.

---

## Deployment Considerations

### Single Instance

The default setup runs as a single Node.js process. This is suitable for small teams (< 50 concurrent users).

### Horizontal Scaling

For larger deployments:

1. **Set `REDIS_URL`** — enables WebSocket message relay between instances
2. **Use a load balancer** with sticky sessions (or Redis-backed session store handles it)
3. **Shared filesystem** — the `projects/` and `git-repos/` directories must be accessible by all instances (NFS, EFS, or similar)
4. **PostgreSQL** — already shared; consider connection pooling (PgBouncer) at scale

### Recommended Production Stack

```text
                    ┌──────────────┐
                    │   Nginx /    │
                    │   Caddy      │  TLS termination, static file caching
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ Load Balancer│  Round-robin or least-connections
                    └──┬───────┬───┘
                       │       │
              ┌────────▼┐  ┌──▼────────┐
              │ Node #1  │  │ Node #2   │  ... N instances
              └────┬─────┘  └────┬──────┘
                   │             │
              ┌────▼─────────────▼──────┐
              │        Redis            │  WebSocket pub/sub
              └─────────────────────────┘
              ┌─────────────────────────┐
              │      PostgreSQL         │  Shared database
              └─────────────────────────┘
              ┌─────────────────────────┐
              │   Shared Filesystem     │  projects/, git-repos/
              └─────────────────────────┘
```
