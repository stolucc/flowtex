# FlowTex

A self-hosted, real-time collaborative LaTeX editor — an open-source alternative to Overleaf. Edit LaTeX documents with live collaboration, compile to PDF, and sync with GitHub.

## Features

- **Real-time collaboration** — multiple users editing simultaneously with live cursors and presence indicators
- **LaTeX compilation** — full TeX Live integration with streaming output, SyncTeX forward/inverse search
- **PDF viewer** — built-in viewer with zoom, page navigation, and click-to-source sync
- **File management** — hierarchical file tree with drag-and-drop ZIP upload
- **Comments & annotations** — inline comments with threads, replies, and resolve/unresolve
- **Version history** — automatic file versioning with diff viewer and one-click restore
- **GitHub integration** — link projects to GitHub repos, push/pull with encrypted token storage
- **Project sharing** — invite collaborators by email with role-based access (owner/editor/viewer)
- **Two-factor authentication** — TOTP-based MFA with QR code setup
- **Tagging & organization** — color-coded tags for project organization
- **LaTeX linting** — real-time syntax diagnostics via LaCheck
- **Spellcheck** — integrated spellcheck in the editor
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
        AuthPage.jsx        # Login/register page
        Editor.jsx          # CodeMirror LaTeX editor
        PdfViewer.jsx       # PDF.js viewer with zoom/nav
        FileTree.jsx        # File/folder browser
        ProjectList.jsx     # Dashboard & project management
        CommentsSidebar.jsx # Comment threads & replies
        Toolbar.jsx         # Top navigation bar
        ShareModal.jsx      # Member & invitation management
        HistoryPanel.jsx    # Version history & diff
        GitHubSyncModal.jsx # GitHub push/pull UI
        CompareFilesModal.jsx # latexdiff file comparison
        MfaSetupModal.jsx   # TOTP MFA setup
        ErrorBoundary.jsx   # Global error fallback
        ...
      styles/
        app.css             # All styles (Catppuccin Mocha theme)
  server/                   # Express backend
    index.js                # Server entry — Express, WebSocket, Redis, security
    db.js                   # PostgreSQL connection pool + schema
    compiler.js             # LaTeX compilation, SyncTeX, file sync
    logger.js               # Pino structured logging
    middleware/
      auth.js               # requireAuth, requireProjectAccess
    routes/
      auth.js               # Registration, login, logout, TOTP
      projects.js           # CRUD, files, members, invitations, ZIP upload
      compile.js            # Compile, PDF, SyncTeX, lint, diff
      comments.js           # Comments & replies
      history.js            # File versions & restore
      github.js             # Token, linking, push/pull
      tags.js               # User tags for projects
    utils/
      audit.js              # Audit logging helper
      crypto.js             # AES-256-GCM encrypt/decrypt
      gitSync.js            # Git repo management for GitHub sync
      latexDiff.js          # latexdiff wrapper
    tests/                  # Vitest test suites
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
