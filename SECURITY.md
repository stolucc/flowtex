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
  Copy it to `/etc/ImageMagick-7/policy.xml` (or `/etc/ImageMagick-6/...`
  on older systems), then verify with `convert -list policy`. The policy
  disables `PS`, `EPS`, `PDF`, `XPS`, `MVG`, `MSL`, `URL`, `HTTPS`, `HTTP`,
  `FTP`, `TEXT`, `SHOW`, `LABEL`, `CAPTION`, `EPHEMERAL`, `WIN`, `PLT`,
  the Ghostscript delegate, `@`-prefixed file reads, and the PS/PDF/XPS
  modules. Resource caps mirror our in-process limits.
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

- General API limiter: `1000/15min` per IP.
- Auth endpoints: `30/15min`.
- File uploads: `100/hour`.
- Compile per project: `15/min`. Per user across all projects: `30/min`.
- `DISABLE_RATE_LIMIT=1` is honored only when `NODE_ENV !== 'production'`.

## TLS

The server falls back to HTTP if `server/certs/cert.pem` and
`server/certs/key.pem` aren't present. Always provision certs in production —
the WebSocket and session cookie depend on `secure`/`SameSite` semantics that
need TLS to function correctly.
