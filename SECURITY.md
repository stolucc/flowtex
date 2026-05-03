# FlowTex Operator Security Guide

This document covers production-deployment security guidance — items that can't
be fixed in code alone.

## DOCX import sandboxing (recommended)

When users import a `.docx`, FlowTex extracts embedded media and converts
`SVG → PDF` via `rsvg-convert` and `GIF/TIFF/BMP → PNG` via ImageMagick
`convert`. Both binaries have a long history of CVEs (Ghostscript delegate,
MSL coder, heap corruption). The bytes they process come from any
authenticated user, so an unpatched host is a chained-exploit risk.

### In-process mitigation (already enabled)

- `convert` is invoked with `-limit memory 256MiB -limit map 512MiB -limit
  disk 256MiB -limit thread 1`.
- All conversions run with a 30-second `timeout` and capped `maxBuffer`.
- Set `DISABLE_IMAGE_CONVERSION=1` in `.env` to skip image conversion entirely;
  affected images appear as `<unconvertible>` placeholders in the output.

### Recommended deployment-level mitigation

- Run the FlowTex server under a sandbox (`bwrap`, `firejail`, or a Docker
  container with `--read-only`, `--cap-drop=ALL`, `--no-new-privileges`,
  `--memory`, `--pids-limit`, and a per-job tmpfs).
- Replace the system `policy.xml` with one that denies dangerous coders:

  ```xml
  <!-- /etc/ImageMagick-7/policy.xml -->
  <policymap>
    <policy domain="coder" rights="none" pattern="MSL" />
    <policy domain="coder" rights="none" pattern="URL" />
    <policy domain="coder" rights="none" pattern="EPHEMERAL" />
    <policy domain="coder" rights="none" pattern="HTTPS" />
    <policy domain="coder" rights="none" pattern="HTTP" />
    <policy domain="coder" rights="none" pattern="SHOW" />
    <policy domain="coder" rights="none" pattern="WIN" />
    <policy domain="coder" rights="none" pattern="PLT" />
    <policy domain="coder" rights="none" pattern="PS" />
    <policy domain="coder" rights="none" pattern="PS2" />
    <policy domain="coder" rights="none" pattern="PS3" />
    <policy domain="coder" rights="none" pattern="EPS" />
    <policy domain="coder" rights="none" pattern="PDF" />
    <policy domain="coder" rights="none" pattern="XPS" />
    <policy domain="resource" name="memory" value="256MiB"/>
    <policy domain="resource" name="map" value="512MiB"/>
    <policy domain="resource" name="thread" value="1"/>
    <policy domain="resource" name="time" value="30"/>
  </policymap>
  ```
- Keep ImageMagick and librsvg at the latest patched versions.

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
