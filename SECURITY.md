# FlowTex Operator Security Guide

This document covers production-deployment security guidance — items that can't
be fixed in code alone.

## DOCX import sandboxing (recommended)

When users import a `.docx`, FlowTex extracts embedded media and converts
`SVG → PDF` via `rsvg-convert`, `GIF/TIFF/BMP → PNG` via ImageMagick
`convert`, and `WMF/EMF → PDF` via LibreOffice headless. All three have
CVE histories (Ghostscript delegate, MSL coder, MVG injection in
ImageMagick; UNO/Java component bugs in LibreOffice). The bytes they
process come from any authenticated user, so an unpatched host is a
chained-exploit risk.

### In-process mitigation (already enabled)

- `convert` is invoked with `-limit memory 256MiB -limit map 512MiB -limit
  disk 256MiB -limit thread 1`.
- LibreOffice runs with `--safe-mode` and a per-invocation
  `UserInstallation` directory under `/tmp` so a compromised run can't
  persist into the service user's profile.
- All conversions have a 30-second `timeout` and capped `maxBuffer`.
- Server logs a startup warning in production if `convert -list policy`
  shows the dangerous coders still enabled.
- Set `DISABLE_IMAGE_CONVERSION=1` in `.env` to skip image conversion entirely
  (covers SVG, GIF/TIFF/BMP, **and** WMF/EMF). Affected images appear as
  `<unconvertible>` placeholders in the output; the rest of the DOCX import
  still works.
- `SOFFICE_BIN=/path/to/soffice` if your LibreOffice install isn't auto-detected.

### Recommended deployment-level mitigation

- **Install the hardened ImageMagick policy.** A ready-to-use template is
  shipped at [`docs/imagemagick-policy.xml`](docs/imagemagick-policy.xml).
  The policy disables `PS`, `EPS`, `PDF`, `XPS`, `MVG`, `MSL`, `URL`,
  `HTTPS`, `HTTP`, `FTP`, `TEXT`, `SHOW`, `LABEL`, `CAPTION`, `EPHEMERAL`,
  `WIN`, `PLT`, the Ghostscript delegate, `@`-prefixed file reads, and the
  PS/PDF/XPS modules. Resource caps mirror our in-process limits.

  > **If you use `scripts/provision-vps.sh`, this is already done.** The
  > provisioner detects `/etc/ImageMagick-*`, backs up the distro
  > `policy.xml` on first install, drops our hardened policy in place,
  > verifies the PDF-deny rule landed, and reports the status in the
  > completion banner. Re-runs are idempotent (skipped when the file
  > already matches). The manual steps below are for non-provisioner
  > deployments.

  Manual install:

  ```bash
  # Back up, install, verify
  sudo cp /etc/ImageMagick-7/policy.xml /etc/ImageMagick-7/policy.xml.bak
  sudo cp /path/to/flowtex/docs/imagemagick-policy.xml /etc/ImageMagick-7/policy.xml
  convert -list policy   # rights=none for PS/EPS/PDF/MVG/...

  # Smoke test — should fail with "not authorized" / "security policy"
  printf '%%!PS\n%%%%EOF\n' | convert ps:- /tmp/out.png ; echo exit=$?
  ```

  Paths differ by distro: IM6 uses `/etc/ImageMagick-6/policy.xml`;
  macOS Homebrew uses `/opt/homebrew/etc/ImageMagick-7/policy.xml`. The
  same XML works in all locations. Once installed, the boot-time warning
  in [`server/index.js`](server/index.js) goes silent.
- Run the FlowTex server under a sandbox (`bwrap`, `firejail`, or a Docker
  container with `--read-only`, `--cap-drop=ALL`, `--no-new-privileges`,
  `--memory`, `--pids-limit`, and a per-job tmpfs).
- Keep ImageMagick, librsvg, and LibreOffice at the latest patched versions.

## NODE_ENV

Several security defaults gate on `process.env.NODE_ENV`. **Always set
`NODE_ENV=production` on production hosts.** When unset, the server still
defaults to strict origin/CSWSH protection on the WebSocket and ignores
`DISABLE_RATE_LIMIT`, but other middleware (HSTS headers, secure cookies)
won't activate.

## Secrets & rotation

FlowTex has three independent server-side secrets. They protect different
things, so the rotation cost (and the user-visible impact) is different for
each. Always rotate on suspected compromise. Always take a Postgres backup
before rotating anything that touches stored ciphertext.

| Secret | Stored where | Protects | Cost to rotate |
| --- | --- | --- | --- |
| `SESSION_SECRET` | `.env` | Session-cookie HMAC | All users logged out |
| `ENCRYPTION_KEY` | `.env` | TOTP secrets, GitHub/Zotero tokens, SMTP password | Re-encrypt every row, or wipe and re-enroll |
| `encryption_salt` | `settings` table | Same as above (paired with `ENCRYPTION_KEY` via scrypt) | Run `migrate-salt.js`, or the same wipe |

The server refuses to start in production with an empty or known-sample
`SESSION_SECRET` (`server/index.js` blocklists the README/example values),
and warns if `SESSION_SECRET` or `ENCRYPTION_KEY` is shorter than 32 chars.

### 1. Rotating `SESSION_SECRET`

Used by `express-session` and the WebSocket session-cookie verifier
(`signCookie` / parser in `server/utils/session.js`). Both read the same
`process.env.SESSION_SECRET` at boot, so they cannot drift apart at
runtime.

**Impact:** every existing signed cookie becomes invalid the moment the
new secret loads. All users are logged out and any open WebSockets close
on the next reconnect. No data is lost.

**Procedure:**

1. Generate: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`
2. Update `SESSION_SECRET` in the production `.env`.
3. Restart the server (graceful or hard — both work; sessions are
   already going to be invalidated).
4. Optional: clear the `session` table to drop the now-orphaned rows
   (`DELETE FROM session WHERE expire < NOW() + INTERVAL '1 day'` is
   enough; `connect-pg-simple`'s pruner will catch the rest).

No data migration. No re-encryption. Forced logout is the entire blast
radius.

### 2. Rotating `ENCRYPTION_KEY`

Used by `server/utils/crypto.js` (`encrypt` / `decrypt`, AES-256-GCM)
through scrypt-derived keys. Anything stored encrypted will become
unreadable under the new key. As of this commit:

- `users.totp_secret` (TOTP enrollment)
- `github_tokens.token` (per-user OAuth token)
- `zotero_tokens.api_key` (per-user Zotero API key)
- `settings.smtp_pass` (admin-configured SMTP password)

Pick **one** of these two paths.

**Path A — re-encrypt in place (preserves user data):**

1. Stop the server.
2. Take a Postgres backup (`pg_dump`).
3. Write a one-shot migration script modeled on `server/migrate-salt.js`
   that:
   - takes both keys (`OLD_ENCRYPTION_KEY` and `NEW_ENCRYPTION_KEY`) as
     env vars,
   - uses the existing `encryption_salt` from the `settings` table for both,
   - decrypts each row's ciphertext with the old key, re-encrypts with the new,
   - writes back in a transaction per table.
4. Run the script with **both** keys in env (`OLD_ENCRYPTION_KEY=… NEW_ENCRYPTION_KEY=… node …`).
5. Update `ENCRYPTION_KEY` in `.env` to the new value.
6. Restart the server. Verify TOTP login works for one test user, plus
   one GitHub-connected and one Zotero-connected user.

There is no built-in script for this — `migrate-salt.js` is for
salt rotation, not key rotation. If the operator hits this and there is
no script yet, the safest answer is Path B until a script lands.

**Path B — wipe and re-enroll (no script needed, lossy):**

1. Stop the server.
2. Backup, then clear the affected columns in Postgres:

   ```sql
   UPDATE users SET totp_secret = NULL, totp_enabled = FALSE;
   DELETE FROM github_tokens;
   DELETE FROM zotero_tokens;
   UPDATE settings SET value = '' WHERE key = 'smtp_pass';
   ```

3. Update `ENCRYPTION_KEY` in `.env`.
4. Restart. Notify users: TOTP must be re-enrolled, GitHub and Zotero
   re-linked, and the admin must re-enter the SMTP password in the
   admin panel. Existing sessions stay valid (Path B doesn't touch
   `SESSION_SECRET`).

In both paths, **never** rotate the salt and the key in the same step
without a combined re-encrypt script — `scrypt(key, salt)` derives the
actual AES key from both, so changing either alone breaks decryption.

### 3. Rotating `encryption_salt`

The salt is per-installation, generated on first boot, and stored in
`settings.encryption_salt`. The shipped `server/migrate-salt.js` script
exists specifically for one historical event — migrating off the
hardcoded `'flowtex-salt'` to the per-install salt. It is **not** a
general-purpose salt rotator: it hardcodes the old value. To rotate to
a fresh random salt:

1. Stop the server. Backup.
2. Manually fork `migrate-salt.js`, replacing `OLD_HARDCODED_SALT` with
   the *current* salt from the `settings` table, and replacing
   `newSalt` with a new `crypto.randomBytes(32).toString('hex')`.
3. Run the forked script. It re-encrypts `github_tokens` and
   `zotero_tokens`. **Note:** the shipped script does NOT cover
   `users.totp_secret` or `settings.smtp_pass` — extend it before running
   if those tables have data.
4. Update the salt in the `settings` table:
   `UPDATE settings SET value = '<new-salt>' WHERE key = 'encryption_salt';`
5. Restart. Verify a TOTP login and one GitHub-connected user.

If you don't need to preserve the encrypted columns, Path B from the
`ENCRYPTION_KEY` section also works for salt rotation — wipe, change
salt in `settings`, restart, re-enroll.

### When to rotate

- **`SESSION_SECRET`** — leak of `.env`, suspected session hijacking,
  any operator turnover with `.env` access. Cheap; rotate liberally.
- **`ENCRYPTION_KEY`** — leak of `.env`, suspected DB exfiltration where
  ciphertext was exposed but the key was not. Required if the key was
  the dev fallback (server logs `[SECURITY]` warning at boot when this
  happens) — every encrypted token in that DB is currently protected by
  a known constant.
- **`encryption_salt`** — only if the salt itself leaked separately
  from the key. Salt alone doesn't compromise ciphertext, so this is
  the rarest rotation; the historical case was the hardcoded-salt
  migration, which is one-shot.

### Test-only escape hatches

- `_setSaltForTesting` (in `crypto.js`) and the `_testing` exports
  elsewhere are gated to `NODE_ENV=test` and throw if reached at
  runtime in any other environment.
- `e2e/_seed.js` throws at import time if `NODE_ENV=production`. The
  e2e suite seeds users directly via SQL with bcrypt-hashed passwords —
  loading this in prod would create a backdoor admin.

## Rate limits

| Bucket | Limit | Keyed by | Why |
| --- | --- | --- | --- |
| General API | `1000/15min` | IP | Catch-all DoS floor for everything not listed below |
| Auth (login, register, forgot/reset, resend-verification) | `30/15min` | IP | Brute-force + spray defence; account-lockout fires separately (see "Login lockout" below) |
| File uploads (`from-zip`, `upload-zip`, `upload-file`) | `100/hour` | IP | ZIP bombs / disk-fill defence |
| Compile (per project) | `15/min` | project | Per-project burst protection |
| Compile (per user) | `30/min` | session.userId | Cross-project compile spam from one account |
| Comment create (`POST /api/comments/:fileId`) | `60/min` | session.userId (IP fallback via `ipKeyGenerator`) | Each create can fan out @-mention rows, an assignee row, a WS push to every collaborator, and a slot in the next 5-minute digest email — the generic limiter would let one author spray 200/min of bell rows at a victim |
| Bug report (`POST /api/bug-reports`) | `5/hour` | session.userId (IP fallback) | Authenticated user could otherwise spray every admin inbox via the Help → Report a bug modal |

All buckets honour `DISABLE_RATE_LIMIT=1` only when `NODE_ENV !== 'production'`. The IPv6 fallback uses `express-rate-limit`'s `ipKeyGenerator` helper so two callers behind the same `/64` don't share a bucket (otherwise one tenant could silence a neighbour). The comment-create and bug-report limiters key by `session.userId` first and only fall back to IP for the rare unauthenticated edge case.

The `POST /api/comments/:fileId` limiter is mounted **method-specifically** so resolve / edit / delete / reply on existing comments stay under the generic `apiLimiter` — only fresh comment creation triggers the fan-out the cap is defending against.

## Login lockout

Two independent counters, both over a 15-minute sliding window:

| Counter | Threshold | Scope | What it catches |
| --- | --- | --- | --- |
| `failed(email, ip)` | 10 | one (account, source IP) pair | Targeted brute-force against one account from one machine. Locks that pair only — the legitimate user from a different network is unaffected, closing the silent-DoS path where any attacker who knew a victim's email could lock the victim out from anywhere |
| `failed(ip)` | 30 | one source IP across any account | Credential-stuffing / spraying — one IP hammering many accounts |

Both reset on a successful login for the same `email`. Both require `req.ip` to be the real client IP, which depends on `app.set('trust proxy', 1)` (already in place) plus Caddy being the only public-facing entry. If you ever expose port 3001 directly, `X-Forwarded-For` becomes attacker-controlled and the lockout becomes spoofable — keep the FlowTex Node process bound behind the proxy.

## Email change notification

`POST /api/auth/change-email` requires the user's current password (a session cookie alone is not enough). On successful change, the **old** address receives a notice ("your account email was changed to X — if not you, contact us"), in addition to the verification link sent to the new address. Closes the silent-account-move attack chain: even if an attacker phishes the password, the victim sees the change happen.

## Collaborator-email privacy

`GET /api/projects/:id/members` strips the `email` field unless the requester is the project owner. Editors and viewers see `id`, `name`, and `role` only. Closes the email-harvesting vector where any user added to any project could scrape every other collaborator's address.

## Global error handler

Server-side 5xx errors return `{"error":"Internal server error"}` to avoid leaking stack-shaped strings. 4xx errors with explicit `status` (deliberately surfaced by route handlers and body-parser failures) return a clean message — `Payload too large`, `Invalid JSON`, `Body verification failed`, or `err.message` capped at 200 chars. Lets clients see what's actually wrong on 4xx without exposing internals on 5xx.

## LaTeX compile sandbox

`server/compiler.js` invokes `latexmk` with:

- `--no-shell-escape` — blocks `\write18` and `os.execute` (via `\directlua`).
- TeX-level `openin_any=p` / `openout_any=p` (set via environment) — restricts file IO to paths under the compile workspace.
- On Linux, `prlimit` wraps the invocation with caps on address space, file size, CPU time (slightly above the JS timeout so the kernel never beats the in-process abort), and process count.

LuaLaTeX gets an extra wrap: `$lualatex` is overridden so the engine is invoked with `--safer`. This is necessary because `--no-shell-escape` does not gate `io.open` / `os.remove` / `os.rename` — they bypass `openin_any` / `openout_any` (which are TeX-level, not Lua-level). `--safer` sandboxes the Lua `os` and `io` libraries to a safe read-only subset. `pdflatex` and `xelatex` have no embedded scripting language and are already sealed by `--no-shell-escape`.

Project members can change `compiler`, `tex_distribution`, and `main_file` without owner permission (PATCH `/api/projects/:id`). This is intentional — they are shared compile choices, not administrative settings — and is not a `\directlua` escape channel because LuaLaTeX is itself sandboxed as above.

## Email layout helper

All transactional emails (invitations, email verification, account deletion, password change, mention digests, password reset, admin bug report) render through a shared `renderEmailLayout(...)` helper in `server/utils/email.js`. The helper:

- Composes a Google-Docs-style card layout (white card, soft grey page, small uppercase FlowTex wordmark, optional heading, body, single blue CTA button, divider + footnote, tiny footer below the card). Table-based layout with inline styles only — `flex`/`grid` and `<style>` blocks are unreliable across Outlook and Apple Mail. Width capped at 520 px for mobile.
- **Auto-escapes the `preheader` parameter** before injecting it into the hidden inbox-preview div. Two callers (invitation, bug report) pass user-controllable strings — inviter name, project name, reporter name — and a project named like a tag that closes the div and injects an `<img>` could otherwise leak markup into the inbox preview or rendered body on clients that ignore `display:none`. Other parameters (`heading`, `bodyHtml`, `footnoteHtml`) still rely on caller-side escape because they intentionally accept HTML; `preheader` is plain-text-by-semantic, so the helper enforces it.

`SMTP_FROM` accepts either a bare address (auto-wrapped as `FlowTex <addr>` for inbox display) or a full `Display Name <addr>` form (passed through unchanged).

## Session hygiene

The CSRF middleware **only** mints a token + cookie for sessions that already carry a `userId`. Anonymous traffic — bots, crawlers, uptime probes, every drive-by page load — does not allocate a session row, so `connect-pg-simple` respects `saveUninitialized: false` and nothing is persisted. This also fixes a long-standing accuracy bug in the admin dashboard's "active sessions" count, which used to inflate to hundreds even on single-digit-user installs.

Anonymous state-changing requests stay protected: the existing `CSRF_EXEMPT_PATHS` list (login, register, forgot/reset password, setup init, resend-verification) is Origin-validated, and any other anonymous POST / PUT / PATCH / DELETE fails the CSRF check (no `session.csrfToken` to compare against) and would have been rejected at `requireAuth` anyway.

The first-run setup flow explicitly mints the CSRF token + cookie after the bootstrap admin is logged in, mirroring `regenerateSession` in `auth.js` — without this the first state-changing request after setup would 403.

## Bug-report endpoint

`POST /api/bug-reports` (Help → Report a bug) is gated by `requireAuth` and the dedicated `bugReportLimiter` (above). Admin recipients are resolved from `users WHERE is_admin = TRUE`; if that set is empty, `ADMIN_EMAIL` is used as the bootstrap fallback. The audit log row stores `targetId = "count:N"` (recipient count) rather than the raw admin email list — keeps admin PII out of `audit_log` and stops the column from overflowing on deployments with many admins. The recipient count and the user-selected feature tags live in the JSON `detail` payload for forensic value.

## Copy-project sharing

`POST /api/projects/:id/copy` accepts `{ includeMembers: bool }`. With `includeMembers = true`, every non-caller member of the source is added to the new project at their original role. **This path requires editor or owner of the source** — a viewer can still clone the project for themselves but cannot rebroadcast it. Every member-addition through copy is audit-logged as `project_member_added_via_copy` so an admin can trace who pulled which user into which clone.

## TLS

The server falls back to HTTP if `server/certs/cert.pem` and
`server/certs/key.pem` aren't present. Always provision certs in production —
the WebSocket and session cookie depend on `secure`/`SameSite` semantics that
need TLS to function correctly.

## Local-LLM bridge

The helper proxies the editor's right-click LLM actions
(`write-to-length`, `paraphrase`, `itemize`, `write-it-out`, `custom`) to
a locally-installed Ollama runtime. Security boundaries:

- **Loopback-only target.** `llm_base_url` must resolve to `127.0.0.1`,
  `::1`, or `localhost`. Validated on config load AND on every request,
  so a hand-edited config can't silently exfiltrate selected text to a
  remote inference service.
- **Redirects refused.** The helper's outbound `http.Client` sets
  `CheckRedirect: ErrUseLastResponse`. Without this a process posing
  as Ollama could 302 → an external endpoint and the helper would POST
  the user's selected text body before the status check fired.
- **Closed task allowlist.** `validTasks` in `helper/llm.go` is the only
  set of tasks the helper will run. The browser submits a `task` name +
  parameters; the helper builds the system prompt from a hardcoded
  template — there is no path for the page to push an arbitrary system
  prompt to the model.
- **Hardened "custom" prompt.** For the user-supplied free-form task,
  the system prompt explicitly limits the model to textual
  transformations, lists forbidden categories (shell commands, file
  deletion, exfiltration URLs, `\write18` / `\directlua{os.execute}` /
  `\input{/etc/...}`), and provides a refusal sentinel. Determined
  prompt injection still works, but the LLM has no execution
  capability and any malicious LaTeX output is stopped by the existing
  compile cage.
- **Model name validation.** Browser-supplied `model` must match
  `^[A-Za-z0-9_.:/\-]{1,128}$` — covers every legit Ollama tag and
  rejects whitespace, control chars, and pathological strings.
- **Caps.** Input ≤ 20 000 chars, output ≤ 50 000 chars (enforced
  mid-chunk so a runaway model can't blow past it), 5-min wall-clock,
  1 in-flight LLM call, 60/min with burst 5.

The path is `browser → helper (loopback) → Ollama (loopback) → helper
→ browser`. The FlowTex server is never in the LLM path — it neither
proxies nor sees the selected text.

## Helper (Windows-specific hardening)

The Go standard library's `os.Chmod(path, 0o600)` is a partial no-op
on Windows — it sets the read-only bit but leaves the NTFS DACL alone.
Without further work the bearer token in `~/.flowtex-helper/config.json`
would inherit `%USERPROFILE%`'s default ACL, which on shared / family /
corporate machines can grant other local accounts read access.

The helper now invokes `icacls.exe` after creating the config file +
directory to strip inherited ACEs and grant only the current user
FullControl. Best-effort: if `icacls` fails the helper still runs (just
less hardened against other local accounts). Implementation lives in
`helper/config_windows.go`; the equivalent file on Unix
(`helper/config_other.go`) ships no-op stubs because the existing
0600 / 0700 modes are correct at the inode level there.

A startup warning fires if `%USERPROFILE%` resolves to a UNC share
(typical of AD roaming profiles) — the bearer token would otherwise
traverse SMB on every read.
