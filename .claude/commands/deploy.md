Build the client (if client/ files changed) and report the new bundle hash so the user can verify their browser loaded it.

Run this AFTER every set of edits to `client/**` or `server/**` before claiming a fix is done. Skipping it has burned us multiple times — the user hard-refreshes, sees the old bundle still loaded, and reports "doesn't seem to fix it" when the fix is actually correct.

## Decide what needs building

Inspect what was edited in this session (your own edit history, or `git status` if available):

- **Any `client/src/**` files changed** → client rebuild needed.
- **Any `server/**` files changed (excluding `server/tests/`)** → tell the user "server changes are live only after restarting `node --env-file=.env server/index.js`." You can't restart the server yourself unless explicitly authorized.
- **Only test files / docs / markdown** → no build, just say so and stop.
- **Both** → do the client rebuild AND warn about the server restart.

## Build the client

```bash
cd /Users/alan/flowtex/client && /Users/alan/.nvm/versions/node/v22.21.1/bin/npx vite build 2>&1 | tail -5
```

Verify "✓ built" appears in the output. If it errors, fix the underlying issue — do NOT report success.

## Capture the new bundle hash

```bash
grep -o 'index-[A-Za-z0-9_-]\+\.js' /Users/alan/flowtex/client/dist/index.html | head -1
```

This is the asset filename the SPA shell now references. Express's `static` middleware serves it from `client/dist/`; the SPA shell loader at `server/index.js:350` re-reads `index.html` on every mtime change, so the server picks up the new hash without a restart.

## Report to the user

End with three lines so the user can diagnose at a glance:

1. What was rebuilt (or "no rebuild needed").
2. **New bundle hash: `index-XXXX.js`** — they should see this same name in DevTools → Network when they hard-refresh.
3. **Hard-refresh (Cmd+Shift+R)** instruction, only if the client was rebuilt.

If their browser still shows an older hash after a hard-refresh, the index.html was cached at the CDN/service-worker level — suggest opening DevTools → Network → "Disable cache" while the panel is open, then refresh.

## Why this matters

The dev server at :3001 serves `client/dist/`. Vite content-hashes assets, so old bundles linger on disk but the SPA shell points to the new one. Stale browser caches of `index.html` keep loading the old hash. Without telling the user the expected hash, "did the fix land?" becomes a guess.

## Do NOT

- Run `pkill` on the server process unless the user authorized a restart. The user runs the server manually; killing it interrupts their session.
- Skip this command because "it's just a small change" — content-hash mismatches don't care about edit size.
- Run `npm install` or modify `package.json` as part of deploy — those are explicit user-requested operations.
