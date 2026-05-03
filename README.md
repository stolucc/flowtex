# FlowTex

[![CI](https://github.com/stolucc/flowtex/actions/workflows/ci.yml/badge.svg)](https://github.com/stolucc/flowtex/actions/workflows/ci.yml)

A self-hosted, real-time collaborative LaTeX editor — an open-source alternative to Overleaf. Edit LaTeX documents with live collaboration, compile to PDF, and sync with GitHub.

## Features

- **Real-time collaboration** — multiple users editing simultaneously with live cursors and presence indicators
- **LaTeX compilation** — full TeX Live integration with streaming output, SyncTeX forward/inverse search
- **Visual mode (WYSIWYG)** — togglable preview that hides LaTeX markup and renders bold / italic / headings / lists / quotes inline, with widget badges for citations and references; the source `.tex` is never modified
- **Tracked changes** — Word-style insert / delete marks with per-user attribution, accept / reject review walkthrough, and `latexdiff`-rendered PDF preview
- **PDF viewer** — built-in viewer with zoom, page navigation, click-to-source sync, and an icon-based error / warning chip surfacing compile + lint diagnostics
- **File management** — hierarchical file tree with drag-and-drop ZIP upload, BibTeX pretty-print, and DOCX → LaTeX import
- **Comments & annotations** — inline comments with threads, replies, @mentions, and resolve/unresolve
- **Version history** — automatic file versioning with hunk-based diff viewer (cap with show-all toggle for large diffs) and one-click restore
- **GitHub integration** — link projects to GitHub repos, push/pull with encrypted token storage
- **Citations & bibliography** — Zotero import, BibTeX field enrichment, citation-key autocomplete, and hover tooltips with full author list and venue
- **Project sharing** — invite collaborators by email with role-based access (owner/editor/viewer)
- **Two-factor authentication** — TOTP-based MFA with QR code setup
- **Tagging & organization** — color-coded tags for project organization
- **LaTeX linting** — real-time syntax diagnostics via LaCheck (and ChkTeX server-side)
- **Spellcheck** — integrated spellcheck in the editor with custom dictionary
- **Dark theme** — Catppuccin Mocha color scheme throughout

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
| `LOG_LEVEL` | `debug`/`info` | Pino log level (trace/debug/info/warn/error/fatal) |
| `NODE_ENV` | `development` | Set to `production` for TLS enforcement + security checks |

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
NODE_ENV=production node server/index.js
```

The server serves the built client from `client/dist/` and listens on port 3001.

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
      auth.js                 # Registration, login, logout, TOTP
      projects.js             # CRUD, files, members, invitations, ZIP upload
      compile.js              # Compile, PDF, SyncTeX, lint, diff
      comments.js             # Comments & replies
      history.js              # File versions & restore
      github.js               # Token, linking, push/pull
      bib.js / zotero.js      # Bibliography import
      chat.js                 # Per-project chat
      tags.js                 # User tags for projects
      admin.js                # Admin activity panel
      setup.js                # First-run setup
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

- **CSRF protection** — double-submit token on all state-changing API requests
- **Helmet** — full Content Security Policy, X-Frame-Options, HSTS
- **Rate limiting** — 20 req/15 min on auth endpoints, 200 req/min on API
- **Account lockout** — 10 failed login attempts triggers 15-minute lockout
- **Session security** — httpOnly cookies, secure flag in production, session regeneration on login
- **Encryption at rest** — GitHub tokens encrypted with AES-256-GCM
- **Path traversal prevention** — all file operations validated against project directory
- **SSRF protection** — GitHub repo names validated against strict regex
- **Audit logging** — sensitive actions (login, delete, member removal) logged to `audit_log` table
- **TLS enforcement** — automatic HTTPS redirect in production
- **Graceful shutdown** — SIGTERM/SIGINT drain HTTP, WebSocket, Redis, and DB connections

---

## License

MIT
