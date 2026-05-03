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

- `SESSION_SECRET`, `AUTH_SECRET`, and the encryption salt are sourced from
  `.env`. Rotate on suspected compromise; note that rotating the encryption
  salt requires running `server/migrate-salt.js` or all stored
  GitHub/Zotero/SMTP credentials become un-decryptable.
- `_setSaltForTesting` and `_testing` exports are gated to `NODE_ENV=test`.

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
