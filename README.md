# FlowTex

[![CI](https://github.com/stolucc/flowtex/actions/workflows/ci.yml/badge.svg)](https://github.com/stolucc/flowtex/actions/workflows/ci.yml)

A self-hosted, open-source real-time collaborative LaTeX editor. Edit LaTeX documents with live collaboration, compile to PDF, and sync with GitHub.

## Features

- **Real-time collaboration** — multiple users editing simultaneously with live cursors and presence indicators
- **LaTeX compilation** — full TeX Live integration with streaming output, SyncTeX forward/inverse search
- **Visual mode (WYSIWYG)** — togglable preview that hides LaTeX markup and renders bold / italic / headings / lists / quotes inline, with widget badges for citations and references; the source `.tex` is never modified
- **Tracked changes** — Word-style insert / delete marks with per-user attribution, accept / reject review walkthrough, and `latexdiff`-rendered PDF preview
- **PDF viewer** — built-in viewer with zoom, page navigation, click-to-source sync, and an icon-based error / warning chip surfacing compile + lint diagnostics
- **File management** — hierarchical file tree with drag-and-drop ZIP upload, BibTeX pretty-print, and DOCX → LaTeX import with five document-type templates (Book/Thesis, Journal paper, Conference paper, Report, and Generic) emitting clean minimal preambles that compile under either `pdflatex` or `xelatex`
- **Comments & annotations** — inline comments with threads, replies, @mentions, emoji reactions (on both comments and replies), comment assignment (assignee always receives a notification, including on self-assignment), and resolve/unresolve
- **In-app notifications** — a bell in the toolbar shows real-time @-mention notifications; clicking an entry deep-links to the comment (switches project, opens the file, scrolls the editor) so the recipient lands on the exact spot. Offline users still receive a 5-minute email digest
- **Report a bug** — Help → Report a bug opens a modal that emails every admin (rate-limited to 5 reports per hour per user). Tag the report with one or more feature areas; the description and reporter identity are included so admins can follow up
- **Per-project chat** — sidecar chat panel with typing indicators, date separators, and emoji reactions on messages
- **Version history** — automatic file versioning with hunk-based diff viewer (cap with show-all toggle for large diffs) and one-click restore
- **GitHub integration** — link projects to GitHub repos, push/pull with encrypted token storage
- **Citations & bibliography** — Zotero import, BibTeX field enrichment, citation-key autocomplete, and hover tooltips with full author list and venue
- **Project sharing** — invite collaborators by email with role-based access (owner/editor/viewer); the member list refreshes live when anyone joins or is removed
- **Project copy** — duplicate a project including all files, the tracked-changes sidecar, the discussion thread (comments, replies, reactions), and compile settings (`compiler`, `tex_distribution`, `main_file`, `snapshot_interval_sec`). Editors and owners can optionally share the copy with the original's collaborators in one step
- **Two-factor authentication** — TOTP-based MFA with QR code setup
- **Tagging & organization** — color-coded tags for project organization
- **Admin dashboard** — overview stats, most-active projects (with owner column), active-users panel, audit log, SMTP settings, and per-user delete (triple-check confirmation)
- **LaTeX linting** — real-time syntax diagnostics via LaCheck (and ChkTeX server-side)
- **Spellcheck** — integrated spellcheck in the editor with custom dictionary
- **Build identifier** — the About modal surfaces the deployed git short SHA + build time so operators can confirm which version is live
- **Dark theme** — Catppuccin Mocha color scheme throughout
- **One-shot VPS provisioner** — `scripts/provision-vps.sh` deploys to a fresh Ubuntu host (Caddy + Let's Encrypt for `flowtex.example.com` *and* `www.flowtex.example.com`, hardened ImageMagick policy, systemd unit, Postgres role/db, optional SMTP); re-running it doubles as the upgrade path

---

## Prerequisites

| Dependency | Version | Purpose |
|------------|---------|---------|
| **Node.js** | >= 20 | Server & client runtime |
| **PostgreSQL** | >= 14 | Primary database |
| **TeX Live** | 2024+ | LaTeX compilation (`latexmk`, `pdflatex`, `synctex`) |
| **Redis** | (optional) | WebSocket horizontal scaling |

### macOS (Homebrew)

```bash
brew install node postgresql@17 --cask mactex
brew services start postgresql@17
```

### Ubuntu/Debian

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs postgresql texlive-full
sudo systemctl start postgresql
```

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/your-org/flowtex.git
cd flowtex
```

### 2. Create the database

```bash
createdb flowtex
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env — at minimum, review SESSION_SECRET and ENCRYPTION_KEY
```

Key environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PGDATABASE` | `flowtex` | PostgreSQL database name |
| `PGHOST` | `localhost` | PostgreSQL host |
| `PGPORT` | `5432` | PostgreSQL port |
| `SESSION_SECRET` | dev default | **Must change in production** — session signing key |
| `ENCRYPTION_KEY` | dev default | **Must change in production** — AES-256 key for GitHub token encryption |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:3001` | Comma-separated allowed origins |
| `REDIS_URL` | (none) | Redis URL for multi-instance WebSocket scaling |
| `INSTANCE_ID` | (none) | Per-instance log label; set when running multiple instances behind a load balancer |
| `DISABLE_TLS_REDIRECT` | (none) | Set to `1` when a reverse proxy terminates TLS upstream (required for load-balanced deploys) |
| `LOG_LEVEL` | `debug`/`info` | Pino log level (trace/debug/info/warn/error/fatal) |
| `NODE_ENV` | `development` | Set to `production` for TLS enforcement + security checks |
| `SMTP_HOST` | (none) | SMTP server hostname. **Required in production** — without it FlowTex only logs emails. Invitations, email verification, password reset, @-mention digests, and bug-report delivery all depend on this |
| `SMTP_PORT` | `587` | SMTP port (`465` for implicit TLS, `587` for STARTTLS) |
| `SMTP_SECURE` | `false` | Set to `true` when using port 465 (implicit TLS) |
| `SMTP_USER` / `SMTP_PASS` | (none) | SMTP auth credentials. `SMTP_PASS` can be left blank in `.env` and set later from the admin dashboard (it is encrypted at rest using `ENCRYPTION_KEY`) |
| `SMTP_FROM` | (none) | `From:` header. Accepts either a bare address (auto-wrapped as `FlowTex <addr>`) or a full `Display Name <addr>` form |
| `ADMIN_EMAIL` | (none) | Bootstrap admin address. Receives bug-report fallback when no admin user is yet provisioned |

### 4. Install dependencies

```bash
npm install          # root (installs concurrently)
cd client && npm install && cd ..
cd server && npm install && cd ..
```

### 5. Start in development mode

```bash
npm run dev
```

This starts both the backend (port 3001) and the Vite dev server (port 5173) concurrently. Open **http://localhost:5173** in your browser.

### 6. Production build

```bash
cd client && npm run build && cd ..
NODE_ENV=production node --env-file=.env server/index.js
```

The server serves the built client from `client/dist/` and listens on port 3001.

**Always build with `npm run build` (not `npx vite build`).** The client's `build` script wraps Vite with `VITE_BUILD_SHA=$(git rev-parse --short HEAD)` and `VITE_BUILD_TIME=$(date -u +%FT%TZ)`, which Vite inlines via `import.meta.env`. Help → About reads those values back so operators can confirm at a glance which commit is serving traffic. Calling `npx vite build` directly skips the wrapper and the About modal stays stuck on `dev`.

### 6a. SMTP

Configure SMTP before going live — many flows are silently degraded otherwise:

- **Email verification** is required at registration. With SMTP unset, only the first-run admin (created via the setup wizard) can log in; everyone else is stuck at the unverified gate.
- **Invitations**, **@-mention digests** (sent every 5 minutes for offline recipients), **password reset**, and **bug reports** all dispatch through the same transport.

Set `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` in `.env`, or leave them blank and fill them in from **Admin Dashboard → SMTP settings** post-deploy (the dashboard encrypts `smtp_pass` with `ENCRYPTION_KEY`). Once configured, hit **Send test email** on the same panel to verify the transport — it sends a one-line test message to the admin's own address and surfaces the SMTP error directly if it fails.

### 7. One-shot VPS deploy (Ubuntu/Debian)

For a fresh Ubuntu host with a domain pointed at it:

```bash
ssh root@your.host
curl -fsSL https://raw.githubusercontent.com/stolucc/flowtex/main/scripts/provision-vps.sh -o provision-vps.sh
DOMAIN=flowtex.example.com ADMIN_EMAIL=you@example.com \
  SMTP_HOST=smtp.example.com SMTP_USER=noreply@example.com SMTP_PASS='…' \
  bash provision-vps.sh
```

The provisioner installs Node 22, PostgreSQL, TeX Live, Caddy, Redis, the DOCX-import toolchain (LibreOffice, ImageMagick, librsvg), `texlive-fonts-extra`, `fonts-texgyre` (without this `xelatex` cannot resolve `TeX Gyre Heros` etc. by name because TeX Live's font drop is invisible to `fontconfig`), and Microsoft core fonts; creates a service user; generates `.env` with random secrets and (if `SMTP_HOST` was supplied) live SMTP credentials; runs `npm install` + `cd client && npm run build` (so the About modal shows the deployed git short SHA); writes a hardened ImageMagick `policy.xml` (idempotent — backs up the distro file once, verifies the PDF-deny rule landed); configures Caddy for `$DOMAIN` (and `www.$DOMAIN` 301 → apex when a DNS record exists); installs a systemd unit; and opens the firewall.

If `SMTP_HOST` is omitted, the section in `.env` stays commented and the post-install banner warns that email is disabled — fill it in from Admin Dashboard → SMTP settings later.

Re-running the same command pulls the latest commit, rebuilds, and restarts — so it doubles as the upgrade path. The existing `.env` is left untouched. WS clients reconnect within ~5–15 s on a single-instance redeploy; multi-instance behind a load balancer reconnects through Redis without a visible gap.

See [docs/installation.html](docs/installation.html) for full operator documentation including Docker Compose, multi-instance load balancing, backups, and email setup.

---

## Project Structure

```
flowtex/
  client/                   # React frontend (Vite)
    src/
      App.jsx               # Main application component
      api.js                # API client with CSRF handling
      main.jsx              # Entry point + error boundary
      components/
        AuthPage.jsx          # Login/register page
        Editor.jsx            # CodeMirror LaTeX editor
        VisualModeToolbar.jsx # Floating WYSIWYG formatting toolbar
        PdfViewer.jsx         # PDF.js viewer with zoom/nav + diagnostic chips
        FileTree.jsx          # File/folder browser
        ProjectList.jsx       # Dashboard & project management
        ChatPanel.jsx         # Per-project chat
        CommentsSidebar.jsx   # Comment threads & replies
        Toolbar.jsx           # Top navigation bar
        ShareModal.jsx        # Member & invitation management
        HistoryPanel.jsx      # Snapshot list popover
        HistoryView.jsx       # Full snapshot diff browser
        GitHubSyncModal.jsx   # GitHub push/pull UI
        CompareFilesModal.jsx # latexdiff file comparison
        ProjectSettingsModal.jsx # Project settings (Editor / Compiler / etc.)
        BibEnrichModal.jsx    # BibTeX field enrichment
        ZoteroModal.jsx       # Zotero import
        MfaSetupModal.jsx     # TOTP MFA setup
        ModalContainer.jsx    # Aggregates editor-level modals
        Icons.jsx             # SVG icon set (incl. error / warning chips)
        ErrorBoundary.jsx     # Global error fallback
        ...
      contexts/
        ProjectContext.jsx    # Project / files / activeFile / members
        EditorRefContext.jsx  # Imperative handle to CodeMirror
      hooks/                  # useProject, useTrackedChanges, useCompilation,
                              # useWebSocket, useEditorActions, useUIState
      utils/
        latexParser.js        # AST parser used by autocomplete + visual mode
        visualMode.js         # Visual-mode (WYSIWYG) extension + bib lookup
        spellcheck.js         # Hunspell-based client spellcheck
        latexLint.js          # Client-side LaTeX linter
        latexLogParser.js     # Compiler log → diagnostics
        prettyBib.js          # BibTeX formatter
        lineDiff.js           # LCS line diff for snapshot UI
        editorExtensions.js   # CodeMirror extensions
        ...
      styles/
        app.css               # All styles (Catppuccin Mocha theme)
  server/                     # Express backend
    index.js                  # Server entry — Express, WebSocket, Redis, security
    db.js                     # PostgreSQL connection pool + schema
    compiler.js               # LaTeX compilation, SyncTeX, file sync
    logger.js                 # Pino structured logging
    websocket.js              # WS handlers (presence, OT, tracked changes)
    middleware/
      auth.js                 # requireAuth, requireProjectAccess
      errorHandler.js         # Centralized error → JSON formatter
    routes/
      auth.js                 # Registration, login, logout, TOTP, self-delete
      projects.js             # CRUD, files, members, invitations, copy, ZIP upload
      compile.js              # Compile, PDF, SyncTeX, lint, diff
      comments.js             # Comments, replies, @mentions
      notifications.js        # In-app mention inbox (list + mark-seen)
      history.js              # File versions & restore
      github.js               # Token, linking, push/pull
      bib.js / zotero.js      # Bibliography import
      chat.js                 # Per-project chat
      tags.js                 # User tags for projects
      admin.js                # Admin dashboard + per-user delete + SMTP test
      setup.js                # First-run setup
      bugReports.js           # Help → Report a bug → email admins (5/hour/user)
    services/
      authService.js          # Account creation, password & MFA
      projectService.js       # File CRUD + main_file tracking
      githubService.js        # GitHub OAuth + sync
    utils/
      audit.js                # Audit logging helper
      crypto.js               # AES-256-GCM encrypt/decrypt
      gitSync.js              # Git repo management for GitHub sync
      latexDiff.js            # latexdiff wrapper
      docxToLatex.js          # DOCX → LaTeX import
      trackedChangeMarkup.js  # Tracked changes → latexdiff markup
    tests/                    # Vitest test suites
  projects/                 # Compiled project files (gitignored)
  git-repos/                # Git working copies for GitHub sync (gitignored)
  .env.example              # Environment variable template
```

---

## Running Tests

```bash
cd server
npm test              # Single run
npm run test:watch    # Watch mode
```

---

## Health Checks

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/health` | GET | No | Returns `{ status: "ok", uptime: <seconds> }` |
| `/api/ready` | GET | No | Returns `{ status: "ready" }` if DB is reachable, 503 otherwise |

---

## Security

- **CSRF protection** — double-submit token on all state-changing API requests. Only minted for authenticated sessions so anonymous traffic doesn't allocate a session row
- **Helmet** — full Content Security Policy, X-Frame-Options, HSTS
- **Rate limiting** — auth `30/15min`, generic API `1000/15min`, comment-create `60/min/user`, bug-report `5/hour/user`, upload `100/hour`, compile `15/min/project` (and `30/min/user`). See [SECURITY.md](SECURITY.md) for the full table
- **LaTeX sandbox** — `latexmk` runs with `--no-shell-escape`, `openin_any=p`, `openout_any=p`, `prlimit` caps (memory, file size, CPU, pids), and (for `lualatex`) the `--safer` flag that locks down `os.execute` / `io.open` / `os.remove` from `\directlua`
- **Account lockout** — 10 failed login attempts triggers 15-minute lockout
- **Session security** — httpOnly cookies, secure flag in production, session regeneration on login
- **Encryption at rest** — GitHub tokens encrypted with AES-256-GCM
- **Path traversal prevention** — all file operations validated against project directory
- **SSRF protection** — GitHub repo names validated against strict regex
- **Audit logging** — sensitive actions (login, delete, member removal) logged to `audit_log` table
- **TLS enforcement** — automatic HTTPS redirect in production
- **Hardened ImageMagick policy** — the VPS provisioner drops a restrictive `policy.xml` (Ghostscript/PS/EPS/PDF/MVG/MSL/URL coders disabled, resource caps) so user-uploaded media can't trigger coder vulnerabilities
- **Graceful shutdown** — SIGTERM/SIGINT drain HTTP, WebSocket, Redis, and DB connections
- **HIBP password check** — registration / reset / change paths consult the Have-I-Been-Pwned range API (k-anonymity); set `DISABLE_HIBP_CHECK=1` for offline or test environments

---

## License

MIT
