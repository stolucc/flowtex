# Deploying local-compile to flowtex.click

Sister doc to `LOCAL_COMPILE_DESIGN.md`. The design doc covers
*what* and *why*; this one is the operator's runbook for *how* to
turn it on in production safely, what changes for end users, and
what's still your responsibility on the deployment side.

## TL;DR

You can leave the feature off in production indefinitely. When you
turn it on:

- **Server side**: a single env-var flip (`FEATURE_LOCAL_COMPILE=1`)
  plus a `git pull` + rebuild + restart. No new dependencies on the
  VPS. No new TLS work. No DNS changes required (the design lists
  `helper.localhost.flowtex.click` as a future cert hostname but the
  current implementation doesn't need it).
- **Client side**: users see a new "Compile" tab in Account
  Settings. Everything they need to install + pair the helper is
  walked through in that tab.
- **Helper side**: each user installs the `flowtex-helper` binary on
  their own machine. Pre-built binaries come from your GitHub
  Releases (CI workflow already wired up — see below). Helper
  listens on `127.0.0.1` only; the FlowTex server is not involved
  in the compile request path.

If you never run the CI workflow that publishes binaries, the
"Download" button in the FlowTex UI 404s; users can still build from
source. So the feature degrades gracefully even with no release
infrastructure.

## What still needs to happen on the VPS to enable this

In order:

### 1. Merge `feat/local-compile-helper` into `main`

The whole feature is on the branch. It is additive — no schema
removals, no behaviour changes for users who don't opt in. Merging
is safe.

```bash
git checkout main
git merge --no-ff feat/local-compile-helper
git push origin main
```

If you want a chance to back out, hold off on merging and instead
deploy from the feature branch directly. The rollback contract
(`git reset --hard v-pre-local-compile`) still holds either way.

### 2. Pull on the VPS

```bash
ssh you@flowtex.click
cd /opt/flowtex   # or wherever the deploy lives
git pull
```

This brings down all four new tables-of-things:
- The shared TC-macros module (server pulls from `shared/`).
- The two new schema columns (`users.compile_location`,
  `projects.compile_location`). They auto-migrate on next server boot
  via the existing `ALTER TABLE … ADD COLUMN IF NOT EXISTS` lines.
- The new client bundle (built next step).
- The Go `helper/` directory (irrelevant to the VPS — that's user-side
  software).

### 3. Rebuild the client

```bash
cd client && npm run build
```

Server picks up the new bundle on next request (no restart needed
for client-only changes).

### 4. Flip the flag and restart

Add to your `.env` (or wherever you set env vars):

```
FEATURE_LOCAL_COMPILE=1
```

Restart the server. The server's CSP `connect-src` widens to include
`http://localhost:9876`, `https://localhost:9876`, the future
`helper.localhost.flowtex.click` hostname, and `blob:` — only when
the flag is on. PATCH `/api/auth/me` and PATCH `/api/projects/:id`
start accepting the `compile_location` field. /api/auth/me starts
reporting `serverFeatures.localCompile: true` to clients.

```bash
# whatever you use to restart — for the systemd unit version:
sudo systemctl restart flowtex
```

### 5. (Optional but recommended) Publish helper binaries

Tag a helper release:

```bash
git tag helper-v0.1.0
git push origin helper-v0.1.0
```

GitHub Actions (`.github/workflows/helper-release.yml`) builds
mac-arm64, mac-amd64, and linux-amd64 binaries, runs the helper's
Go unit tests, generates SHA256SUMS, and attaches everything to a
GitHub Release with the matching tag. Takes ~3 min.

After this lands, the in-app "Download flowtex-helper" button in
the Compile tab works for end users — they don't need Go installed.

If you skip this step, the download button 404s; users can still
build from source per the in-app fallback.

## What changes for end users

### Users who never touch the new settings

Nothing. The `compile_location` columns default to `'server'` and
`NULL`; the resolver returns `{ source: 'server' }` for everyone who
hasn't flipped a switch. Every existing compile path is byte-identical
to pre-feature behaviour.

### Users who opt in

1. Open **Account Settings → Compile** (new tab, visible only when
   `serverFeatures.localCompile === true`).
2. See the helper-status row. Initially red: "Helper not detected."
3. The Compile tab now leads with the **macOS .dmg path** (no terminal
   required): download → drag to Applications → right-click → Open
   the first time. Linux users get the one-liner `install.sh` that
   downloads the binary, verifies the SHA256 against the release's
   signed `SHA256SUMS`, fails closed if the checksum file is
   unreachable, and installs to `/usr/local/bin/flowtex-helper`.
4. macOS users launch the app and see the **fTx** label in the menu
   bar. Click → **Generate pairing code** — a native dialog shows
   the 6-digit code AND auto-copies it to the clipboard. Linux
   users run `flowtex-helper pair`.
5. Paste the code into FlowTex's Pair helper input. Badge flips
   green: "Paired. TeX Live YYYY".
6. Set their default to "My local TeX Live", or override per project
   from **Project Settings → Compiler → Compile location for this
   project**. The TeX-Live-year picker right above it auto-filters
   to whichever side the project will compile on (server-installed
   years when set to server, helper-detected years when set to
   local), so a pick can never reference a year that isn't there.

From the FlowTex page's point of view, the only network traffic
change is the `fetch` to `http://localhost:9876/*` when local compile
is active. Source files and the resulting PDF travel only between
the user's browser and their own helper — never touch your VPS.

## Security review

A bullet-by-bullet of what's actually different in production once
the flag is on.

### CSP

`connect-src` widens (only when flag is on) to include:

- `http://localhost:9876` — helper, default mode
- `https://localhost:9876` — helper, --tls mode
- `https://helper.localhost.flowtex.click:9876` — future hostname
- `blob:` — required for pdfjs to load the locally-compiled PDF
  (blob URLs go through `connect-src`)

Risk: `blob:` in `connect-src` lets any script on the page fetch
any blob URL the page created. The page can already create blob
URLs from any same-origin data; this is just making them
fetchable. No external attacker surface gained.

### Bearer auth on the helper

Each helper has a 256-bit token in `~/.flowtex-helper/config.json`
(file mode 0600). The browser stores it in `localStorage` under
`flowtex.helper.token`. Pairing rotates the token, so previously-
paired browsers are de-authenticated automatically.

Risk: a malicious browser extension can read `localStorage` and
exfiltrate the token, then use it to compile arbitrary `.tex` on
the user's machine. Mitigations:
- Helper compile cage (`--no-shell-escape`, `--safer` for lualatex,
  `openin_any=p`, `openout_any=p`) — even arbitrary `.tex` can't
  break out.
- Same machine as the extension — not a new attack class, the
  extension can already exfiltrate session cookies and impersonate
  the user on flowtex.click directly.

### Origin allowlist on the helper

The helper rejects requests whose `Origin` header isn't in its
config-file allowlist. The shipped default includes
`https://flowtex.click`, `https://localhost:3001`, and the two dev
origins.

If a user self-hosts on a different domain (e.g. `latex.uni.edu`),
they need to add it to `~/.flowtex-helper/config.json`'s
`allowed_origins` array. This is currently a manual edit — the UI
doesn't expose it. Could be a follow-up to add an "Add origin" UI in
the Compile tab.

### Host pin on the helper

The helper also rejects requests whose `Host` header isn't
`127.0.0.1:9876`, `localhost:9876`, or
`helper.localhost.flowtex.click:9876`. Closes DNS-rebinding attacks
where an attacker resolves `evil.example.com` to `127.0.0.1` and
tricks the browser into hitting the helper with the wrong Host.

### TLS

The helper listens on plain HTTP by default. `http://localhost` is a
"potentially trustworthy" origin per W3C Secure Contexts §3.1 — no
mixed-content blocking from an HTTPS-served FlowTex page. No CA
chain to maintain. No certificate to renew.

Users who want TLS-on-loopback can pass `--tls`; the helper
generates a 10-year self-signed cert. The client bridge probes both
schemes and caches the working one. No server-side change needed
either way.

The future `helper.localhost.flowtex.click` + Let's-Encrypt route is
optional — it would replace the self-signed cert if `--tls` users
prefer a trusted cert without manual acceptance. Not necessary for
the default HTTP flow.

### What still leaves the user's machine

When local compile is active, the editor source still travels
through your VPS — collaboration, save-to-Postgres, the OT pipeline
all unchanged. Only the **compile request itself** goes
browser → helper → browser. Mention digests, comments, project
metadata, GitHub sync — all still server-side.

### Audit logging

`compile_location` changes are not currently audit-logged (they're
treated as a user preference, same as the existing `compile` and
`tex_distribution` fields). If you want a paper trail of who turned
local compile on/off, add an `auditLog` call in
`server/services/projectService.js` `updateProject`. Easy follow-up.

## How users SELF-host this

For operators running FlowTex on their own infrastructure (not
flowtex.click), the only additional step is:

- Add their FlowTex base URL to each user's
  `~/.flowtex-helper/config.json` `allowed_origins` array. Without
  this, the helper rejects the browser's requests as cross-origin.

Everything else (DNS, certs) is exactly the same as flowtex.click
since the helper lives on the user's machine.

## Rollback

In every phase of this work the rollback drill is the same:

```bash
git fetch
git reset --hard v-pre-local-compile
cd client && npm run build
# restart the server
```

Tag `v-pre-local-compile` sits at `3effca6` — the last commit on
`main` before any of this work began. The schema additions
(`compile_location` columns) are left in place after rollback; they
hold per-user / per-project preferences and are harmless when no
application code reads them. If you want them gone too:

```sql
ALTER TABLE users    DROP COLUMN compile_location;
ALTER TABLE projects DROP COLUMN compile_location;
```

## Operator-side TeX Live installs

If the deployed server has more than one `/usr/local/texlive/YYYY`
release installed, FlowTex's distribution picker offers each as an
option. To add a second release on the VPS for the picker to surface,
use [`scripts/install-texlive-year.sh`](scripts/install-texlive-year.sh):

```bash
sudo INSTALL_TEXLIVE_SKIP_GPG=0 \
  bash /opt/flowtex/scripts/install-texlive-year.sh 2024
```

The script downloads `install-tl-unx.tar.gz` from TUG over HTTPS,
fetches the matching `.sha512.asc`, **verifies the GPG signature
against TeX Live's release key** before executing any of TUG's Perl,
and then runs `install-tl` with `selected_scheme scheme-basic` (the
minimum that gives you `pdflatex` + a usable LaTeX install — the
operator can override with the 2nd arg to pick `small`, `medium`,
or `full`). Fails closed if `gpg` isn't installed or TUG's key isn't
in the keyring; the error message tells you how to import:

```bash
gpg --keyserver hkps://keyserver.ubuntu.com \
    --recv-keys 0D5E5D9106BAB6BC
```

`INSTALL_TEXLIVE_SKIP_GPG=1` is an explicit opt-out for air-gapped
environments — don't use it casually, since `install-tl` runs as
root and executes arbitrary Perl.

## Open questions / TODOs

These are deliberately not blockers, but worth picking up at some
point:

1. **macOS code signing.** The pre-built mac binaries are
   **ad-hoc signed** in CI (free, fixes "Killed: 9" on Apple Silicon)
   but not notarized — users see a Gatekeeper warning the first time
   and have to right-click → Open. Joining the Apple Developer
   Program ($99/y) and adding notarization to the helper-release
   workflow would remove the warning entirely.
2. **In-UI allowed-origin management.** Self-hosters can already
   use `flowtex-helper allow-origin <url>` from the terminal; a
   "Trust this server" button in the Compile tab that drives the
   same code path would close the last terminal step.
3. **Cert distribution for `helper.localhost.flowtex.click`.** Not
   needed for the HTTP default; only relevant if `--tls` adoption
   suggests we should also drop the self-signed warning for
   paranoid users. Phase 1.5 in the design doc.
4. **Streaming compile logs.** The helper currently returns the
   full log at compile end. The server path streams via SSE.
   Symmetric SSE on the helper is a UX nicety, not a blocker.

These all fall into the "do later, no urgency" bucket. The feature
is shippable without them.
