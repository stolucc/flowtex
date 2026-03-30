# FlowTex

Self-hosted collaborative LaTeX editor.

## Stack

- **Frontend**: React (JSX, no TypeScript), Vite, CodeMirror 6
- **Backend**: Express.js (ES modules), PostgreSQL, WebSocket (ws)
- **Compilation**: Local TeX Live installation (pdflatex/latexmk)
- **Optional**: Redis for WebSocket horizontal scaling

## Project Structure

```
client/src/
  App.jsx          — Main app, routing, state, WebSocket connection
  components/
    Editor.jsx     — CodeMirror editor, search panel, table builder, symbol picker
    Toolbar.jsx    — Menu bar (File, Edit, Insert, View, Format, Tools, Help)
    PdfViewer.jsx  — PDF preview with SyncTeX support
    FileTree.jsx   — Project file browser
    AuthPage.jsx   — Login/register/2FA
    ChatPanel.jsx  — Real-time chat
  utils/
    latexParser.js — LaTeX AST parser (tables, environments)
    spellcheck.js  — Client-side spellcheck with Hunspell dictionaries
    latexLint.js   — LaTeX linting
  styles/app.css   — All styles (CSS custom properties for theming)

server/
  index.js         — Express server, WebSocket handler, session auth
  db.js            — PostgreSQL connection pool
  routes/          — auth, projects, compile, github, bib, zotero
  utils/           — crypto, email, gitSync, latexDiff
```

## Key Patterns

- Editor exposes methods via `useImperativeHandle` (ref) — App.jsx calls `editorRef.current?.method()`
- WebSocket auth: session cookie is verified by parsing it directly from the upgrade request and looking up the session in PostgreSQL (bypasses Express middleware)
- Session secret must be consistent between Express middleware and WS auth — both read `SESSION_SECRET` from a single const
- File contents are stored in PostgreSQL `files` table and loaded into client memory on project open
- Global search runs client-side against in-memory file array (no server round-trip)
- CSS uses custom properties defined in `:root` — use `var(--bg-primary)`, `var(--bg-surface)`, `var(--accent)`, etc.

## Building & Running

```bash
# Build client (from project root)
cd client && npx vite build

# Start server (loads .env automatically)
node --env-file=.env server/index.js

# Or use npm scripts
npm run dev          # concurrent dev server + vite
npm run build        # production client build
```

Build output goes to `client/dist/` which is copied to `server/public/` by the build.

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
