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
│  │  │  /api/projects/* CRUD, files, ZIP   │  │  Project rooms          │  │   │
│  │  │  /api/compile/*  Compile, PDF, sync │  │  Presence broadcast     │  │   │
│  │  │  /api/comments/* Threads & replies  │  │  Change propagation     │  │   │
│  │  │  /api/history/*  Versions & restore │  │  Cursor sync            │  │   │
│  │  │  /api/github/*   Push/pull/link     │  │  Comment events         │  │   │
│  │  │  /api/tags/*     Tag management     │  │  Heartbeat (ping/pong)  │  │   │
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

With Redis enabled, the server publishes WebSocket messages to a Redis channel, allowing multiple server instances to relay messages to their local clients.

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
                    │  tags │ health              │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │      Core Services           │
                    │                             │
                    │  compiler.js  - TeX Live    │
                    │  gitSync.js   - simple-git  │
                    │  crypto.js    - AES-256-GCM │
                    │  audit.js     - action log  │
                    │  latexDiff.js - latexdiff   │
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
            ├─ AuthPage (when not authenticated)
            │    ├─ Login form
            │    └─ Register form
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
                 │    └─ Menu (share, history, github, compare, clean, MFA)
                 │
                 ├─ FileTree (resizable)
                 │    ├─ Folder nodes (collapsible)
                 │    └─ File nodes (click to open)
                 │
                 ├─ Editor (CodeMirror 6)
                 │    ├─ LaTeX syntax highlighting
                 │    ├─ Autocomplete (commands + environments)
                 │    ├─ Lint diagnostics (gutter markers)
                 │    ├─ Spellcheck underlines
                 │    ├─ Comment highlight decorations
                 │    └─ Remote cursor decorations
                 │
                 ├─ SyncArrows
                 │    ├─ Forward sync button (editor → PDF)
                 │    └─ Inverse sync button (PDF → editor)
                 │
                 ├─ PdfViewer (resizable)
                 │    ├─ PDF canvas (PDF.js)
                 │    ├─ Zoom controls
                 │    ├─ Lint panel (toggle)
                 │    └─ Console output (toggle)
                 │
                 ├─ CommentsSidebar (resizable)
                 │    ├─ Comment threads
                 │    └─ Reply forms
                 │
                 └─ Modals (conditionally rendered)
                      ├─ ShareModal
                      ├─ HistoryPanel
                      ├─ GitHubSyncModal
                      ├─ CompareFilesModal
                      ├─ MfaSetupModal
                      └─ ConfirmDialog
```

---

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | React 18 | UI framework |
| | CodeMirror 6 | LaTeX editor |
| | PDF.js 4.8 | PDF rendering |
| | Vite 5.4 | Build tool & dev server |
| | Typo.js | Spellcheck |
| **Backend** | Express 4.21 | HTTP server |
| | ws | WebSocket server |
| | pino / pino-http | Structured logging |
| | Helmet | Security headers |
| | express-rate-limit | Rate limiting |
| | bcryptjs | Password hashing |
| | express-session + connect-pg-simple | Session management |
| **Database** | PostgreSQL 14+ | Primary data store |
| **Caching** | Redis (optional) | WebSocket pub/sub |
| **LaTeX** | TeX Live (latexmk, pdflatex, synctex, lacheck, latexdiff) | Compilation toolchain |
| **Git** | simple-git | GitHub integration |

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
