# flowtex-helper

Local LaTeX compile companion for FlowTex. Runs on your own machine,
talks to a FlowTex browser tab over a paired bridge, compiles using
whatever TeX Live you already have installed. Source files and PDFs
never leave your machine.

Status: **Phase 2, v0.2.0-dev.** Single binary, mac + linux. On macOS
the binary is shipped inside a `FlowTex Helper.app` bundle and runs as
a menu-bar app; on Linux it runs headless (no portable tray story).
Windows build is deferred. See `LOCAL_COMPILE_DESIGN.md` at the repo
root for the full architecture and security model.

## macOS: menu-bar app (recommended)

Double-click `FlowTex Helper.dmg`, drag the app to **Applications**,
launch it. The first launch needs **right-click → Open** so Gatekeeper
asks once instead of refusing outright (the binary is ad-hoc signed but
not notarised). After that, look for the **fTx** label in the menu bar
— click it to:

- Check pairing status (●  Paired  /  ○  Awaiting pairing).
- **Generate pairing code** — opens a 60-second window; the 6-digit
  code is displayed as a disabled menu item beneath.
- **Open FlowTex pairing page** — launches the browser at
  `https://flowtex.click`.
- **Quit** — stops the helper.

No terminal required.

## Prerequisites

- **Go 1.22+** to build (just for the build — the binary itself has no
  runtime Go dependency). On macOS: `brew install go`.
- **TeX Live** installed and on your PATH. `latexmk`, plus at least
  one of `pdflatex` / `xelatex` / `lualatex`. Optional: `biber`.
- **No root.** The helper writes only under your home directory and
  binds only to 127.0.0.1.

## Build

From this directory:

```bash
make build
```

Produces `./flowtex-helper` for your host. Cross-compile for the
three supported targets:

```bash
make dist
ls dist/
# flowtex-helper-darwin-arm64
# flowtex-helper-darwin-amd64
# flowtex-helper-linux-amd64
```

To produce the macOS `.app` bundle + `.dmg` (host-arch only — needs
to run on a Mac because of `codesign` and `hdiutil`):

```bash
make dmg-mac-arm64    # or dmg-mac-amd64
ls dist/
# FlowTex Helper.app
# FlowTex Helper-arm64.dmg
```

## First-run install (CLI / Linux)

```bash
./flowtex-helper
```

On macOS the menu-bar app does this for you. To force the headless
path even on macOS (useful for systemd-style services or debugging):

```bash
./flowtex-helper --no-tray
```

On first run the helper creates `~/.flowtex-helper/`:

```
~/.flowtex-helper/
  config.json       # bearer token, port (9876), allowed origins
  certs/            # only populated if you ran with --tls
```

The helper binds to **`http://127.0.0.1:9876`** by default. Modern
browsers treat `http://localhost` as a "potentially trustworthy"
origin (W3C Secure Contexts §3.1), so a FlowTex tab on HTTPS can
fetch against the helper directly with no mixed-content blocking and
no certificate-acceptance step. **You do not need to visit the
helper URL in a browser before using it.**

If you specifically want TLS (encryption + integrity on loopback —
moot in most threat models, but available for paranoia mode), pass
`--tls`:

```bash
./flowtex-helper --tls
```

The helper then generates a self-signed cert under `~/.flowtex-helper/certs/`
(valid 10 years) and serves HTTPS on the same port. Your browser will
need to accept the cert exception once via
**https://localhost:9876/health**. The FlowTex client probes both
schemes automatically, so you can switch between modes without
re-pairing.

## Pair with FlowTex

The helper has a 256-bit bearer token in its config. Don't copy-paste it
— FlowTex uses a 6-digit pairing handshake instead. With the helper
running:

```bash
./flowtex-helper pair
```

The CLI prints a 6-digit code and the helper opens a 60-second pairing
window. In FlowTex:

1. **Account Settings → Compile → Pair helper** (tab visible only when
   the server has `FEATURE_LOCAL_COMPILE=1`).
2. Paste the 6-digit code.

On success the browser stores the bearer token in `localStorage` and
the helper rotates its token (so any previously-paired browser is
de-authenticated automatically — pairing a new browser invalidates the
old one).

## Run as a background service

### macOS — LaunchAgent

`~/Library/LaunchAgents/click.flowtex.helper.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>click.flowtex.helper</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/flowtex-helper</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>
  <string>/tmp/flowtex-helper.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/flowtex-helper.log</string>
</dict>
</plist>
```

Then:

```bash
launchctl load ~/Library/LaunchAgents/click.flowtex.helper.plist
```

### Linux — systemd user unit

`~/.config/systemd/user/flowtex-helper.service`:

```ini
[Unit]
Description=FlowTex local compile helper

[Service]
ExecStart=/usr/local/bin/flowtex-helper
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Then:

```bash
systemctl --user enable --now flowtex-helper.service
```

## Subcommands

| Command | What it does |
| --- | --- |
| `flowtex-helper`                    | Run the helper (foreground). |
| `flowtex-helper pair`               | Print a 6-digit code, open a 60-second pairing window. |
| `flowtex-helper rotate`             | Rotate the bearer token. Invalidates every previously-paired browser. |
| `flowtex-helper allow-origin <url>` | Add a FlowTex origin to the trust list (for self-hosters on a non-default domain). |
| `flowtex-helper deny-origin <url>`  | Remove an origin from the trust list. |
| `flowtex-helper info`               | Print config path, port, trusted origins, cert fingerprint. |
| `flowtex-helper version`            | Print the binary version. |
| `flowtex-helper help`               | Brief usage info. |

### Trusting a non-default FlowTex origin

The helper trusts these origins out of the box:

- `https://flowtex.click`
- `https://localhost:3001`, `http://localhost:3001`, `http://localhost:5173`

If your FlowTex server lives anywhere else (e.g. `https://latex.example.edu`),
add it with `allow-origin`:

```bash
flowtex-helper allow-origin https://latex.example.edu
# then restart the running helper for the change to take effect
```

Origins are normalized to `scheme://host[:non-default-port]`; case and
trailing-slash differences are collapsed. Origins are stored in
`~/.flowtex-helper/config.json` and persist across restarts.

## HTTP API surface

All endpoints listen on `https://127.0.0.1:9876` (configurable). Bearer
auth + origin allowlist + Host pin enforced on everything except
`/health` and `/pair` (see `auth.go`).

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| GET    | /health         | none   | Liveness probe. Returns `{"ok":true}`. |
| GET    | /version        | bearer | TeX Live year, engines available, biber. |
| POST   | /pair?code=…    | code   | Single-use 6-digit handshake → fresh bearer token. |
| POST   | /compile        | bearer | Run a compile. Body: `compileRequest`. Returns `{success, log, pdf}` (PDF is base64). |
| POST   | /cancel/:jobId  | bearer | Abort a running compile. |

`compileRequest` shape:

```json
{
  "jobId": "<uuid>",
  "mainFile": "main.tex",
  "compiler": "pdflatex",          // | "xelatex" | "lualatex"
  "showTrackedChanges": false,
  "files": [
    { "path": "main.tex", "content": "\\documentclass…", "isBinary": false },
    { "path": "fig/diagram.pdf", "content": "<base64>", "isBinary": true }
  ]
}
```

## Compile cage

The helper invokes `latexmk` with the same hardening flags as the
FlowTex server:

- `--no-shell-escape` on every engine.
- For `lualatex`: `-e '$lualatex = q(lualatex --safer %O %S)'` so
  `\directlua{}` can't escape to the filesystem.
- `openin_any=p` + `openout_any=p` env vars: TeX file I/O restricted
  to the per-job temp dir.
- Per-job temp dir under `os.TempDir()`, mode 0700, deleted on
  return / cancel / panic.
- 90-second compile timeout via `context.WithTimeout`. Cancellable via
  `/cancel/:jobId`.

A malicious project shared by a collaborator cannot execute arbitrary
code on your machine through these guardrails — exactly the same
posture as the server.

## Rollback / uninstall

```bash
# Stop the running helper.
killall flowtex-helper

# Remove the binary + config dir.
rm -f /usr/local/bin/flowtex-helper
rm -rf ~/.flowtex-helper

# In the FlowTex browser tab:
# Account Settings → Compile → switch back to "Server".
```

Removing the helper makes the FlowTex client fall back to server
compile automatically — no user-visible breakage.

## License

Same license as the FlowTex repo.
