# FlowTex

Self-hosted collaborative LaTeX editor.

## Stack

- **Frontend**: React (JSX, no TypeScript), Vite, CodeMirror 6
- **Backend**: Express.js (ES modules), PostgreSQL, WebSocket (ws)
- **Compilation**: Local TeX Live installation (pdflatex/latexmk)
- **Optional**: Redis for WebSocket horizontal scaling

## Project Structure

```text
client/src/
  App.jsx          — Main app, routing, state, WebSocket connection
  components/
    Editor.jsx     — CodeMirror editor, search panel, table builder, symbol picker,
                     right-click LLM menu (lazy-loads LlmActionDialog)
    Toolbar.jsx    — Menu bar (File, Edit, Insert, View, Format, Tools, Help)
    PdfViewer.jsx  — PDF preview with SyncTeX support
    FileTree.jsx   — Project file browser
    AuthPage.jsx   — Login/register/2FA
    ChatPanel.jsx  — Real-time chat
    LlmActionDialog.jsx  — Per-task LLM dialog (write-to-length / paraphrase /
                           itemize / write-it-out / custom) + preamble stripper
    HelperGuideModal.jsx — In-app helper setup + LLM troubleshooting
                           (Help → Helper setup guide)
  utils/
    latexParser.js — LaTeX AST parser (tables, environments)
    spellcheck.js  — Client-side spellcheck with Hunspell dictionaries
    latexLint.js   — LaTeX linting
    llmTasks.js    — Catalog of right-click LLM tasks (label/hint/needsTargetWords)
    helperBridge.js — Browser ↔ helper HTTP/SSE client (compile, /llm/status,
                      streamLlmComplete, pair)
  styles/app.css   — All styles (CSS custom properties for theming)

server/
  index.js         — Express server, WebSocket handler, session auth
  db.js            — PostgreSQL connection pool
  paths.js         — PROJECTS_DIR constant (imported by blobStore, compiler, etc.)
  routes/          — auth, projects, compile, github, bib, zotero, chat, comments, ...
  services/        — projectService, authService, blobStore, blobGc, fileBytes,
                     quotas, ... (all DB + business logic. Routes are thin.)
  utils/           — crypto, email, gitSync, latexDiff, blobSweep (cron driver),
                     softDeletePurge

helper/            — Go companion app for opt-in local LaTeX compile + local LLM.
                     macOS .dmg (.app menu-bar), Windows .exe (system tray,
                     -H=windowsgui), Linux headless binary. Key files:
                     server.go         — HTTP routes + rate limiters
                     auth.go           — bearer + Origin + Host pin middleware
                     compile.go        — latexmk invocation + cage flags
                     llm.go            — Ollama proxy + task allowlist + SSE
                     config.go         — JSON config + ACL hardening (Windows)
                     config_windows.go — icacls DACL lockdown (Windows-only)
                     tray.go           — system-tray UI (darwin + windows)
                     trayicon_tray.go  — programmatic 16x16 .ico
                     See helper/README.md for the user-facing install guide.

scripts/
  provision-vps.sh         — one-shot VPS provisioner/upgrader
  update-vps.sh            — in-place pull → build → restart
  install-texlive-year.sh  — install a TUG TeX Live release into
                             /usr/local/texlive/YYYY (GPG-verified)
```

## Key Patterns

- Editor exposes methods via `useImperativeHandle` (ref) — App.jsx calls `editorRef.current?.method()`
- WebSocket auth: session cookie is verified by parsing it directly from the upgrade request and looking up the session in PostgreSQL (bypasses Express middleware)
- Session secret must be consistent between Express middleware and WS auth — both read `SESSION_SECRET` from a single const
- File contents are stored in PostgreSQL `files` table and loaded into client memory on project open. Text rows hold UTF-8 in `files.content`; binary rows (`is_binary = TRUE`) reference a per-project content-addressed blob store at `server/projects/<projectId>/_blobs/<sha256[0:2]>/<sha256>` via `files.binary_sha256`. Refcount lives in `project_blobs`. Every binary write must go through `writeBinaryFileInTx` in `services/projectService.js`; every byte read goes through `loadFileBytes` in `services/fileBytes.js`. Background GC: `utils/blobSweep.js`.
- Global search runs client-side against in-memory file array (no server round-trip)
- CSS uses custom properties defined in `:root` — use `var(--bg-primary)`, `var(--bg-surface)`, `var(--accent)`, etc.
- Per-user resource caps (`services/quotas.js`): projects-per-user, files-per-project, blob-bytes-per-user. Caps are admin-tunable via Settings tab; runtime resolves the live value on every assertion. Caller pattern: pass `tx` into the assertion so the per-user / per-project advisory lock holds for the whole check + insert.
- `PROJECTS_DIR` constant lives in `server/paths.js` (NOT `compiler.js`) to avoid a circular import via `blobStore.js`. Other modules import from `paths.js` directly; `compiler.js` re-exports it for back-compat.

## Building & Running

```bash
# Build client (from project root). ALWAYS use the npm script — it sets
# VITE_BUILD_SHA / VITE_BUILD_TIME from git so the About modal shows
# which commit is live. `npx vite build` skips the wrapper and stamps
# the bundle with `dev`.
cd client && npm run build

# Start server (loads .env automatically)
node --env-file=.env server/index.js

# Or use npm scripts
npm run dev          # concurrent dev server + vite
npm run build        # production client build (sets VITE_BUILD_SHA)
```

Build output goes to `client/dist/` and is served by the Node server.

## Database

- PostgreSQL database name: `flowtex` (configured via `PGDATABASE` in `.env`)
- Encryption key derivation in `server/utils/crypto.js` uses `flowtex-salt` — changing it requires re-encrypting all tokens
- Sessions stored in PostgreSQL via `connect-pg-simple`

## Important Gotchas

- The `server/utils/crypto.js` salt and dev fallback key must not be changed without running `server/migrate-salt.js` first
- `server/db.js` fallback database name must match `.env` PGDATABASE
- localStorage keys use `flowtex-` prefix (font-size, editor-inverted, pdf-inverted, spell-language, custom-dictionary)
- When adding new CSS, use existing variables from `:root` — check `app.css` for available `--bg-*`, `--text-*`, `--accent`, `--border`, `--radius`
- Vite production builds have content-hashed filenames — users need hard refresh (Cmd+Shift+R) after deploys

# Project Instructions

## Web Research & Fetching

When you need information from the internet, follow these strategies in order. Many websites block direct fetching, return JavaScript-only pages, or have bot protection. Plan accordingly.

### Strategy 1: Use web_search first (preferred)

Always start with `web_search` to find information. The search snippets alone often contain enough to answer the question. Extract what you need from the snippets without fetching full pages.

```python
# Good: short, specific queries
web_search("python asyncio gather timeout")
web_search("nginx reverse proxy websocket config")

# Bad: long natural language queries
web_search("how do I configure nginx as a reverse proxy for websocket connections in my application")
```

### Strategy 2: Fetch with fallback expectations

If you need full page content, use `web_fetch` but expect failures. Many sites will block you or return useless content.

**Sites that typically work well:**

- Raw GitHub files (raw.githubusercontent.com)
- GitHub READMEs and file views
- Official documentation sites (docs.python.org, developer.mozilla.org, etc.)
- Package registries (pypi.org, npmjs.com)
- Plain text / markdown URLs
- API documentation

**Sites that typically fail or return garbage:**

- News sites (paywalls, JS rendering)
- Social media (Twitter/X, Reddit, LinkedIn)
- Sites behind Cloudflare or similar bot protection
- Single-page applications (React/Vue/Angular apps)
- Sites requiring authentication or cookies
- Medium, Substack, and similar blogging platforms (sometimes work, often don't)

### Strategy 3: When a page fetch fails

If `web_fetch` returns an error, empty content, or garbage HTML:

1. **Don't retry the same URL** — it won't work the second time either.
2. **Try alternative sources** — search for the same information on a different site. For example, if a blog post fails, look for the same topic on a documentation site or GitHub.
3. **Try raw/plain text versions** where available:
   - GitHub: use `raw.githubusercontent.com` instead of `github.com`
   - Documentation: some sites offer plain text or markdown versions
4. **Use search snippets** — if you found the URL via `web_search`, the search results probably already contained the key information you need. Go back and use that.
5. **Be honest** — if you cannot retrieve the information, say so. Don't hallucinate content you didn't actually read.

### Strategy 4: For code examples and documentation

When looking for code examples, library usage, or API docs:

- Prefer official documentation sites over blog posts or tutorials
- GitHub repositories (especially READMEs and example files) are reliable sources
- Package registry pages (PyPI, npm) usually work and contain useful metadata
- Man pages and specification documents are usually plain text and fetch well

### General Rules

- **Never pretend you read a page you couldn't fetch.** If the fetch failed, say so and offer alternatives.
- **Don't fetch pages unnecessarily.** If the search snippet answers the question, use it directly.
- **Batch your research.** Do multiple `web_search` calls to gather information from snippets before attempting any `web_fetch`.
- **Keep search queries short** — 2-6 words get the best results.
- **Include the year** in searches when recency matters (e.g., "rust async patterns 2025").
- **If a user gives you a specific URL**, try to fetch it, but let them know if it fails and suggest alternatives.
