# FlowTex Architecture

## System Overview

FlowTex is a full-stack web application with a React single-page application frontend, an Express.js backend, PostgreSQL for persistence, and optional Redis for horizontal scaling. LaTeX compilation is delegated to a local TeX Live installation.

---

## Architecture Diagram

```
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

```
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

```
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

**File-identity invariant.** Both the OT change broadcaster and the tracked-change pipeline carry an explicit `fileId` end-to-end (capture-time on the editor side, payload field on the wire, `change.fileId` in the server-bound POST). Receivers — `applyRemoteChanges`, `applyRemoteTcDelete`, `useTrackedChanges.doHandleTrackChange`, and the WebSocket `tracked-change` handler — drop or shunt-aside any message whose `fileId` doesn't match the file currently being shown / edited. The same pattern protects the local debounced autosave: `handleSave` accepts an explicit `fileId`, and the editor's tcDelBuffer / tcInsertBuffer carry the file id captured at edit time so a buffer flush after a file switch can never write into the wrong file.

### 3. Compilation Flow

```
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

```
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

```
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
                   │   │ content          │       │ project_id (FK)  │
                   │   │ is_binary        │       │ file_path        │
                   │   │ created_at       │       │ content          │
                   │   │ updated_at       │       │ author_id        │
                   │   └──────────────────┘       │ author_name      │
                   │          │                   │ created_at       │
                   │          ▼                   └──────────────────┘
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
```

---

## Component Architecture

### Server Layers

```
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

```
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
                 ├─ ChatPanel (resizable, toggleable)
                 │
                 ├─ CommentsSidebar (resizable)
                 │    ├─ Comment threads
                 │    └─ Reply forms
                 │
                 ├─ HistoryView (full-pane, when viewing snapshots)
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

```
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

```
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
