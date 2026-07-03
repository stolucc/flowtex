#!/usr/bin/env bash
# FlowTex VPS provisioner — one-shot setup for a fresh Ubuntu server.
#
# Tested target: Contabo Cloud VPS 20 (6 vCPU / 12 GB RAM / 100 GB NVMe),
# Ubuntu 24.04 LTS. Ubuntu 22.04 also works (ships PostgreSQL 14 instead
# of 16 — fine, FlowTex needs 14+).
#
# It installs every dependency (PostgreSQL, TeX Live, Node 22, Caddy, the
# DOCX-import toolchain), clones + builds the app, generates secrets and a
# production .env, wires up a hardened systemd service behind Caddy with
# automatic HTTPS, opens the firewall, and starts everything.
#
# PREREQUISITES
#   - A fresh Ubuntu 22.04/24.04 VPS, run this as root.
#   - DNS: an A/AAAA record for $DOMAIN already pointing at this VPS's IP,
#     so Caddy can obtain a Let's Encrypt certificate on first start.
#
# USAGE (as root on the VPS)
#   DOMAIN=flowtex.example.com ADMIN_EMAIL=you@example.com \
#     bash provision-vps.sh
#
# OPTIONAL ENV
#   REPO_URL     git repo to clone        (default: public FlowTex repo)
#   BRANCH       branch to deploy         (default: main)
#   APP_DIR      install location         (default: /opt/flowtex)
#   APP_USER     service account          (default: flowtex)
#   INSTANCE_COUNT  number of web processes behind Caddy (default: 1).
#                Node is single-threaded, so set this to ~cores minus 1-2
#                (leave headroom for Postgres/Redis/worker/Caddy). > 1
#                auto-enables Redis + cluster mode + the Y.Doc worker and
#                generates flowtex-2..N units + a Caddy upstream list.
#   WITH_REDIS   install + wire Redis     (default: 0 — forced on when
#                INSTANCE_COUNT > 1)
#   WITH_DOCX    install LibreOffice/IM + Microsoft core fonts (default: 1)
#                — image conversion + Arial/Times/Courier for DOCX docs.
#   WITH_DOCKER  install Docker + build the compile-sandbox image (default: 0)
#                — only needed if you plan to set
#                  FLOWTEX_COMPILE_SANDBOX=docker (multi-tenant /
#                  untrusted-user deploys). The host execFile + prlimit
#                  path is the default for trusted-tenant single-VPS
#                  deploys and does not need Docker.
#   COMPILE_IMAGE_TAG  tag for the locally-built sandbox image
#                      (default: flowtex/compile-sandbox:tl-2022)
#
# OPTIONAL ENV — SMTP (email). Supply SMTP_HOST to bake email config into the
# generated .env. Without it the app logs emails instead of sending them, and
# only the first-run admin account can log in (other users can't clear the
# email-verification gate). SMTP can also be set later via Admin Dashboard.
#   SMTP_HOST    SMTP server hostname     (the trigger — unset = email disabled)
#   SMTP_PORT    SMTP port                (default: 587)
#   SMTP_SECURE  true for port 465 TLS    (default: false — STARTTLS on 587)
#   SMTP_USER    SMTP auth username       (e.g. noreply@your-domain)
#   SMTP_PASS    SMTP auth password       (secret — or leave unset and add it
#                                          via Admin Dashboard, stored encrypted)
#   SMTP_FROM    From: address            (default: FlowTex <noreply@$DOMAIN>)
#
# Re-running is safe-ish: existing repo is pulled rather than re-cloned, and
# an existing .env is left untouched (so secrets are never rotated by accident).

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────
REPO_URL="${REPO_URL:-https://github.com/stolucc/flowtex.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/flowtex}"
APP_USER="${APP_USER:-flowtex}"
WITH_REDIS="${WITH_REDIS:-0}"
WITH_DOCX="${WITH_DOCX:-1}"
WITH_DOCKER="${WITH_DOCKER:-0}"
COMPILE_IMAGE_TAG="${COMPILE_IMAGE_TAG:-flowtex/compile-sandbox:tl-2022}"

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ── Preflight ───────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "Run as root (sudo bash provision-vps.sh)."
[ -f /etc/os-release ] && . /etc/os-release
[ "${ID:-}" = "ubuntu" ] || die "This script targets Ubuntu. Detected: ${ID:-unknown}."

# Idempotent re-runs (operator passing WITH_REDIS=1 / WITH_DOCKER=1
# against an already-provisioned box) shouldn't have to re-pass
# DOMAIN and ADMIN_EMAIL -- they're already baked into the generated
# .env. If the env vars aren't set but a previous .env exists, read
# the originals back so the run unblocks cleanly.
__EXISTING_ENV="${APP_DIR}/.env"
if [ -z "${DOMAIN:-}" ] && [ -f "$__EXISTING_ENV" ]; then
  DOMAIN="$(grep -m1 '^APP_URL=' "$__EXISTING_ENV" 2>/dev/null | sed -E 's|^APP_URL=https?://||')"
  [ -n "$DOMAIN" ] && log "Reusing DOMAIN=$DOMAIN from existing $__EXISTING_ENV"
fi
if [ -z "${ADMIN_EMAIL:-}" ] && [ -f "$__EXISTING_ENV" ]; then
  ADMIN_EMAIL="$(grep -m1 '^ADMIN_EMAIL=' "$__EXISTING_ENV" 2>/dev/null | cut -d= -f2-)"
  [ -n "$ADMIN_EMAIL" ] && log "Reusing ADMIN_EMAIL from existing $__EXISTING_ENV"
fi
: "${DOMAIN:?Set DOMAIN=your.domain — Caddy needs it for the TLS cert (or re-run on an existing install which has it baked in)}"
: "${ADMIN_EMAIL:?Set ADMIN_EMAIL=you@example.com — used for the admin account and TLS cert issuance}"

# Optional SMTP config (see header). SMTP_HOST is the trigger; the rest get
# sensible defaults. Defined here, after preflight, so SMTP_FROM can default
# off the validated $DOMAIN.
SMTP_HOST="${SMTP_HOST:-}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_SECURE="${SMTP_SECURE:-false}"
SMTP_USER="${SMTP_USER:-}"
SMTP_PASS="${SMTP_PASS:-}"
SMTP_FROM="${SMTP_FROM:-FlowTex <noreply@${DOMAIN}>}"

# ── Multi-instance load balancing ─────────────────────────────────────
# INSTANCE_COUNT web processes behind Caddy (round-robin). Node is
# single-threaded, so N processes ~= N cores (leave 1-2 for Postgres,
# Redis, the Y.Doc worker, and Caddy). > 1 REQUIRES cluster mode (Redis
# pub/sub fan-out + the Y.Doc worker) or the instances split-brain, so we
# force Redis on here and wire the cluster env + worker below.
INSTANCE_COUNT="${INSTANCE_COUNT:-1}"
case "$INSTANCE_COUNT" in ''|*[!0-9]*) die "INSTANCE_COUNT must be a positive integer (got '$INSTANCE_COUNT')";; esac
[ "$INSTANCE_COUNT" -ge 1 ] || die "INSTANCE_COUNT must be >= 1"
if [ "$INSTANCE_COUNT" -gt 1 ]; then
  WITH_REDIS=1
  log "Multi-instance: $INSTANCE_COUNT web processes -> forcing Redis + cluster mode + Y.Doc worker"
fi

# Idempotently set KEY=VALUE in .env (updates a live or commented line,
# else appends). Used to wire cluster vars on re-runs where the .env
# guard leaves an existing file untouched.
ensure_env_var() {
  local key="$1" val="$2" file="${ENV_FILE:-$APP_DIR/.env}"
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$file"
  elif grep -qE "^# *${key}=" "$file" 2>/dev/null; then
    sed -i "s|^# *${key}=.*|${key}=${val}|" "$file"
  else
    printf '%s=%s\n' "$key" "$val" >> "$file"
  fi
}

log "Provisioning FlowTex on $DOMAIN (Ubuntu $VERSION_ID, user: $APP_USER, dir: $APP_DIR)"

# ── Drop broken apt sources before update ───────────────────────────────
# Earlier provisioner versions and some manual setups added the
# `texlive-backports` PPA to get a newer TL than Jammy/Focal shipped.
# That PPA never published for Noble (24.04), so on Noble it 404s
# every `apt-get update` and the script aborts before any package
# install can happen. Ubuntu 24.04's native texlive packages are
# already TL 2023, which is recent enough that the PPA isn't
# needed -- so unconditionally remove any stale reference.
if compgen -G '/etc/apt/sources.list.d/*texlive-backports*' >/dev/null 2>&1; then
  log "Removing stale texlive-backports PPA (Noble doesn't publish it)"
  rm -f /etc/apt/sources.list.d/*texlive-backports*
fi

# ── System packages ─────────────────────────────────────────────────────
log "Installing system packages (texlive-full is ~7 GB — this is the slow step)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  build-essential python3 git curl ca-certificates \
  postgresql postgresql-contrib \
  texlive-full \
  texlive-fonts-extra \
  fonts-texgyre \
  util-linux \
  ufw
# texlive-fonts-extra is a transitive dep of texlive-full today, but we list
# it explicitly so the install survives a future downgrade to a smaller
# distribution.
# fonts-texgyre is *separate* from the TeX Live Gyre install: TeX Live drops
# the OTFs into /usr/share/texmf-dist/fonts/... which fontconfig does NOT
# scan by default, so xelatex+fontspec cannot resolve \setmainfont{TeX Gyre
# Heros} even though the file is on disk. fonts-texgyre re-installs the
# OTFs to /usr/share/fonts/opentype/texgyre/ where fontconfig sees them.
# Required by the DOCX-import font alias map (Helvetica -> TeX Gyre Heros).
# util-linux provides `prlimit` — without it FlowTex compiles run without
# kernel-level memory/output caps (it warns loudly at startup).

if [ "$WITH_DOCX" = "1" ]; then
  log "Installing DOCX-import toolchain (LibreOffice, ImageMagick, librsvg)"
  apt-get install -y --no-install-recommends librsvg2-bin imagemagick libreoffice

  # Microsoft TrueType core fonts (Arial, Times New Roman, Courier New, …) —
  # DOCX-imported documents typically reference these as the body/heading
  # fonts, and the converter emits \setmainfont{Arial} etc. which fails at
  # xelatex compile time if the actual font isn't installed system-wide.
  # ttf-mscorefonts-installer lives in multiverse (enabled by default on
  # Ubuntu), is EULA-gated (pre-accept via debconf), and downloads the .cab
  # bundles from sourceforge on install — that download can occasionally
  # fail, so treat as best-effort rather than letting it abort the provision.
  log "Installing Microsoft TrueType core fonts (needed for DOCX-imported docs)"
  echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" \
    | debconf-set-selections
  if apt-get install -y ttf-mscorefonts-installer; then
    fc-cache -f
  else
    log "WARN: ttf-mscorefonts-installer failed (probably a flaky font download). DOCX docs that reference Microsoft fonts will fail to compile until you install it manually: sudo apt-get install ttf-mscorefonts-installer && sudo fc-cache -f"
  fi
fi

# ── Node.js 22 ──────────────────────────────────────────────────────────
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  log "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
log "Node $(node -v), npm $(npm -v)"

# ── Caddy (reverse proxy + automatic HTTPS) ────────────────────────────
if ! command -v caddy >/dev/null; then
  log "Installing Caddy"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# ── Redis (optional — only for multi-instance scaling) ─────────────────
if [ "$WITH_REDIS" = "1" ]; then
  log "Installing Redis"
  apt-get install -y redis-server
  systemctl enable --now redis-server
fi

# ── Docker + compile-sandbox image (optional — for multi-tenant deploys) ─
# Default OFF. The host execFile + prlimit compile path is the right
# answer for self-hosted single-VPS deploys where all users are trusted;
# turning this on adds a ~2.5 GB image and an extra service to maintain.
# Operators who plan to flip FLOWTEX_COMPILE_SANDBOX=docker in their
# .env should opt in here.
if [ "$WITH_DOCKER" = "1" ]; then
  log "Installing Docker engine + CLI"
  # Debian-bundled `docker.io` is sufficient for our use (sibling
  # containers, no swarm, no compose v2 features). Operators who need a
  # specific Docker version can swap in upstream docker-ce per
  # https://docs.docker.com/engine/install/debian/.
  apt-get install -y docker.io
  systemctl enable --now docker

  # The FlowTex service account needs to talk to the Docker socket.
  # Group membership only takes effect on next login -- the systemd
  # unit picks it up on next start (handled at the bottom of the
  # script).
  usermod -aG docker "$APP_USER" || true

  log "Building compile-sandbox image ($COMPILE_IMAGE_TAG)"
  # ~5-10 min on first build (TeX Live download). Subsequent runs of
  # this script are no-ops thanks to docker's layer cache.
  if [ -d "$APP_DIR/compile-sandbox" ]; then
    docker build -t "$COMPILE_IMAGE_TAG" "$APP_DIR/compile-sandbox"
  else
    log "WARN: $APP_DIR/compile-sandbox not present yet; skipping image build."
    log "      Build manually after first checkout:"
    log "        docker build -t $COMPILE_IMAGE_TAG $APP_DIR/compile-sandbox"
  fi
fi

# ── Service account ─────────────────────────────────────────────────────
if ! id "$APP_USER" >/dev/null 2>&1; then
  log "Creating service account: $APP_USER"
  useradd --system --create-home --home-dir "/home/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
fi

# ── Clone / update the app ──────────────────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  log "Updating existing checkout at $APP_DIR"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  log "Cloning $REPO_URL ($BRANCH) into $APP_DIR"
  mkdir -p "$APP_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
mkdir -p "$APP_DIR/projects" "$APP_DIR/git-repos" "$APP_DIR/server/logs" "$APP_DIR/server/public"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── PostgreSQL: role + database ─────────────────────────────────────────
systemctl enable --now postgresql
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='flowtex'" | grep -q 1; then
  log "PostgreSQL role 'flowtex' already exists — keeping it"
  PG_PASSWORD=""  # unknown; .env must already carry it (see below)
else
  log "Creating PostgreSQL role + database 'flowtex'"
  PG_PASSWORD="$(openssl rand -hex 24)"
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE flowtex LOGIN PASSWORD '${PG_PASSWORD}';
CREATE DATABASE flowtex OWNER flowtex;
SQL
fi
# FlowTex bootstraps its own schema on first start — no manual migration step.

# ── .env ────────────────────────────────────────────────────────────────
ENV_FILE="$APP_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  log ".env already exists — leaving it untouched (secrets are not rotated)"
else
  log "Generating $ENV_FILE with fresh secrets"
  [ -n "$PG_PASSWORD" ] || die ".env is missing but the 'flowtex' DB role already exists — its password is unknown. Recreate the role or restore the original .env."

  # Build the SMTP section: live values when SMTP_HOST was supplied,
  # otherwise commented-out placeholders (email stays disabled).
  if [ -n "$SMTP_HOST" ]; then
    log "Baking SMTP config into .env (host: $SMTP_HOST, from: $SMTP_FROM)"
    SMTP_ENV_BLOCK="SMTP_HOST=${SMTP_HOST}
SMTP_PORT=${SMTP_PORT}
SMTP_SECURE=${SMTP_SECURE}
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
SMTP_FROM=${SMTP_FROM}"
  else
    SMTP_ENV_BLOCK="# Email is NOT configured — the app logs emails instead of sending them,
# and only the first-run admin can log in (other users can't clear the
# email-verification gate). Fill these in (or use Admin Dashboard > Settings)
# and restart, e.g. SMTP_FROM=FlowTex <noreply@${DOMAIN}>
# SMTP_HOST=
# SMTP_PORT=587
# SMTP_SECURE=false
# SMTP_USER=
# SMTP_PASS=
# SMTP_FROM="
  fi

  cat > "$ENV_FILE" <<ENV
# Generated by provision-vps.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
PGDATABASE=flowtex
PGHOST=localhost
PGPORT=5432
PGUSER=flowtex
PGPASSWORD=${PG_PASSWORD}

NODE_ENV=production
PORT=3001

# Caddy terminates TLS at the edge and proxies plain HTTP to :3001.
# The app's HTTP->HTTPS redirect would otherwise fight the proxy.
DISABLE_TLS_REDIRECT=1

SESSION_SECRET=$(openssl rand -hex 64)
ENCRYPTION_KEY=$(openssl rand -hex 32)

CORS_ORIGINS=https://${DOMAIN}
APP_URL=https://${DOMAIN}
ADMIN_EMAIL=${ADMIN_EMAIL}

LOG_LEVEL=info

# ── Email (SMTP) ──────────────────────────────────────────────────────
${SMTP_ENV_BLOCK}

# ── GitHub OAuth (optional — enables repo sync) ───────────────────────
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
$([ "$WITH_REDIS" = "1" ] && echo "REDIS_URL=redis://localhost:6379" || echo "# REDIS_URL=redis://localhost:6379")

# ── Multi-instance mode (cluster) ─────────────────────────────────────
# Set FLOWTEX_INSTANCE_MODE=cluster only when running multiple web
# instances behind a load balancer. Requires REDIS_URL above. The
# server refuses to boot in cluster mode without it.
# FLOWTEX_INSTANCE_MODE=cluster

# ── Compile sandbox (Docker per-compile) ──────────────────────────────
# Default is the in-process host execFile + prlimit path (right for
# trusted-tenant single-VPS deploys). Flip to docker if you host
# untrusted users.
$([ "$WITH_DOCKER" = "1" ] \
  && echo -e "# FLOWTEX_COMPILE_SANDBOX=docker\n# FLOWTEX_COMPILE_IMAGE=$COMPILE_IMAGE_TAG" \
  || echo -e "# FLOWTEX_COMPILE_SANDBOX=docker\n# FLOWTEX_COMPILE_IMAGE=flowtex/compile-sandbox:tl-2022")

# ── Blob storage backend ──────────────────────────────────────────────
# Default 'fs' (on-disk under server/projects/<id>/_blobs/). Switch to
# 's3' only when you move to multi-instance and need a shared blob
# store. Requires npm install @aws-sdk/client-s3 in server/ and the
# AWS_* env vars below.
# FLOWTEX_BLOB_BACKEND=s3
# FLOWTEX_BLOB_FALLBACK_BACKEND=fs   # during an FS -> S3 migration
# AWS_REGION=auto
# AWS_S3_BUCKET=
# AWS_S3_ENDPOINT=                   # optional, for R2 / MinIO
# AWS_ACCESS_KEY_ID=
# AWS_SECRET_ACCESS_KEY=

# ── Y.js worker tier ──────────────────────────────────────────────────
# Default in-process. Enable when you split the Y.Doc rooms into a
# dedicated worker process (run \`node server/yjsWorker.js\` as its
# own systemd service). Requires REDIS_URL above.
# FLOWTEX_YJS_WORKER=enabled
ENV
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# Multi-instance needs the cluster wiring present regardless of whether
# .env was just generated or reused (the guard above leaves an existing
# file untouched). Idempotent so re-running with a higher INSTANCE_COUNT
# just works.
if [ "$INSTANCE_COUNT" -gt 1 ]; then
  ensure_env_var REDIS_URL "redis://localhost:6379"
  ensure_env_var FLOWTEX_INSTANCE_MODE "cluster"
  ensure_env_var FLOWTEX_YJS_WORKER "enabled"
  log "Wired cluster env into $ENV_FILE (REDIS_URL, FLOWTEX_INSTANCE_MODE=cluster, FLOWTEX_YJS_WORKER=enabled)"
fi

# ── Install deps + build the client ─────────────────────────────────────
log "Installing dependencies and building the client (as $APP_USER)"
sudo -u "$APP_USER" bash -euo pipefail <<BUILD
cd "$APP_DIR"
# Mark this repo as safe for git operations under the service user. Git
# >= 2.35.2 refuses to operate on repos whose working dir is owned by a
# different uid (the "dubious ownership" check) — on a fresh provision the
# chown happens before this step so it would normally be fine, but a re-run
# after a manual root-pull could leave \`.git/\` with mismatched ownership.
# Without this guard, \`git rev-parse --short HEAD\` in the build script
# would silently fail and the About modal would fall back to "dev".
git config --global --add safe.directory "$APP_DIR"
npm install --prefix server --omit=dev
npm install --prefix client
# \`npm run build\` (not \`npx vite build\`) so the package.json build script
# runs — it bakes in VITE_BUILD_SHA (short git SHA) + VITE_BUILD_TIME so the
# About modal can show operators which commit is currently deployed.
( cd client && npm run build )
cp -r client/dist/* server/public/
BUILD

# ── ImageMagick hardening ───────────────────────────────────────────────
# Drop a restrictive policy.xml so user-supplied files (DOCX imports, image
# uploads) cannot trigger ImageMagick coder vulnerabilities. App-side caps
# remain regardless; this is defense in depth at the OS level.
IM_HARDENED=0
if [ "$WITH_DOCX" = "1" ] && [ -f "$APP_DIR/docs/imagemagick-policy.xml" ]; then
  IM_POLICY_DIR="$(find /etc/ImageMagick-* -maxdepth 0 -type d 2>/dev/null | head -1 || true)"
  IM_POLICY_FILE="$IM_POLICY_DIR/policy.xml"
  if [ -z "$IM_POLICY_DIR" ]; then
    log "WARNING: ImageMagick installed but /etc/ImageMagick-* not found — skipping policy hardening"
  elif cmp -s "$APP_DIR/docs/imagemagick-policy.xml" "$IM_POLICY_FILE" 2>/dev/null; then
    log "ImageMagick policy.xml already matches the FlowTex policy — skipping"
    IM_HARDENED=1
  else
    log "Hardening ImageMagick policy.xml ($IM_POLICY_DIR)"
    # Back up the distro policy on first install (idempotent: skip if a
    # backup already exists so re-runs do not clobber the true original).
    if [ -f "$IM_POLICY_FILE" ] && [ ! -f "${IM_POLICY_FILE}.distro" ]; then
      cp -p "$IM_POLICY_FILE" "${IM_POLICY_FILE}.distro"
    fi
    install -m 644 "$APP_DIR/docs/imagemagick-policy.xml" "$IM_POLICY_FILE"
    # Sanity check: our policy denies the PDF coder; confirm that landed.
    if grep -q 'rights="none" pattern="PDF"' "$IM_POLICY_FILE" 2>/dev/null; then
      IM_HARDENED=1
    else
      log "WARNING: policy.xml installed but PDF-deny rule not visible — check $IM_POLICY_FILE"
    fi
  fi
fi

# ── systemd service ─────────────────────────────────────────────────────
log "Installing systemd service: flowtex.service"
cat > /etc/systemd/system/flowtex.service <<UNIT
[Unit]
Description=FlowTex collaborative LaTeX editor
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node $APP_DIR/server/index.js
# NB: no --env-file. systemd's EnvironmentFile= above is the single
# source of truth for env. Node 22's --env-file overrides
# process.env at startup, which silently defeats systemd's
# `Environment=PORT=...` overrides (e.g. flowtex-2 instance trying
# to bind 3001 with PORT=3002 explicitly set on the unit).
Restart=on-failure
RestartSec=5

# Hardening — defence in depth on top of the app's own sandboxing.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP_DIR/projects $APP_DIR/git-repos $APP_DIR/server/logs

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable flowtex

# Extra web instances for load balancing (INSTANCE_COUNT > 1). Each is a
# copy of flowtex.service with a PORT override (3002, 3003, …) so Caddy
# can round-robin across them. They share the same .env (cluster mode +
# Redis fan-out), so the Y.Doc worker owns rooms and no instance holds
# in-process state. update-vps.sh discovers and restarts the whole set.
for i in $(seq 2 "$INSTANCE_COUNT"); do
  port=$((3000 + i))
  log "Installing systemd service: flowtex-$i.service (PORT=$port)"
  cat > /etc/systemd/system/flowtex-$i.service <<UNIT_N
[Unit]
Description=FlowTex collaborative LaTeX editor (instance $i)
After=network.target postgresql.service redis-server.service
Requires=postgresql.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
# Environment= is applied after EnvironmentFile=, so this PORT wins over
# the .env PORT=3001 and each instance binds its own port.
Environment=PORT=$port
ExecStart=/usr/bin/node $APP_DIR/server/index.js
Restart=on-failure
RestartSec=5

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP_DIR/projects $APP_DIR/git-repos $APP_DIR/server/logs

[Install]
WantedBy=multi-user.target
UNIT_N
  systemctl enable "flowtex-$i"
done
# Scale-down: drop orphan instance units above the current count so a
# re-run with a lower INSTANCE_COUNT doesn't leave stray web processes
# (Caddy stops routing to them below, but the processes would linger).
for unit in /etc/systemd/system/flowtex-[0-9]*.service; do
  [ -e "$unit" ] || continue
  n=$(basename "$unit" .service | sed 's/flowtex-//')
  case "$n" in ''|*[!0-9]*) continue;; esac
  if [ "$n" -gt "$INSTANCE_COUNT" ]; then
    log "Removing orphan instance unit flowtex-$n (INSTANCE_COUNT=$INSTANCE_COUNT)"
    systemctl disable --now "flowtex-$n" 2>/dev/null || true
    rm -f "$unit"
  fi
done
systemctl daemon-reload

# ── flowtex-yjs-worker.service (optional, multi-instance only) ─────────
# Runs the dedicated Y.Doc room worker as its own systemd service so
# the web tier can be stateless (rooms live in the worker, web tier
# just queues XADD into Redis Streams). NOT started or enabled by
# default -- a single-VPS deploy with FLOWTEX_YJS_WORKER unset
# doesn't need it. Operators flip FLOWTEX_YJS_WORKER=enabled in .env
# AND `systemctl enable --now flowtex-yjs-worker` together.
#
# Restart policy is aggressive (Restart=always + short RestartSec)
# because while the worker is down, room ownership locks expire and
# clients fall back to the legacy from_pos/to_pos columns -- which
# works, but loses CRDT-aware anchor resolution.
log "Installing systemd service: flowtex-yjs-worker.service (optional, multi-instance)"
cat > /etc/systemd/system/flowtex-yjs-worker.service <<WORKER_UNIT
[Unit]
Description=FlowTex Y.Doc room worker
After=network.target postgresql.service redis-server.service
Requires=postgresql.service
# Soft dep on redis -- the worker will exit(2) at boot if REDIS_URL
# is unreachable, which lets systemd's restart loop wait for redis
# to come up after a reboot.
Wants=redis-server.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node $APP_DIR/server/yjsWorker.js
# NB: no --env-file. Same reason as flowtex.service ExecStart above.
# Worker apply path is purely CPU + Redis + in-memory; on transient
# Redis blips the worker exits, systemd restarts it, it rejoins the
# consumer group and XAUTOCLAIM picks up any orphaned entries.
Restart=always
RestartSec=3
# Give graceful shutdown enough time to release ownership locks and
# snapshot in-progress rooms. SIGTERM handler in yjsWorker.js does
# both within a couple of seconds; 30s is generous.
TimeoutStopSec=30

# Same hardening as the web tier. Worker never writes to disk
# outside its log directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP_DIR/server/logs

[Install]
WantedBy=multi-user.target
WORKER_UNIT
systemctl daemon-reload
# Enabled automatically for multi-instance (cluster mode requires the
# worker or the web tier refuses to boot). Single-instance leaves it
# off -- opt-in. See docs/yjs-worker.md.
if [ "$INSTANCE_COUNT" -gt 1 ]; then
  systemctl enable flowtex-yjs-worker
fi

# ── Caddy ───────────────────────────────────────────────────────────────
# Serve the apex domain and (when DNS allows) redirect the www subdomain
# to it. If DNS for `www.$DOMAIN` doesn't resolve, we omit the www block
# entirely — including a host Caddy can't reach makes ACME burn its
# rate-limit (5 failures/hour) and floods the logs.
if getent hosts "www.$DOMAIN" >/dev/null 2>&1; then
  WWW_BLOCK="

www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}"
  log "Configuring Caddy for $DOMAIN + www.$DOMAIN (automatic HTTPS)"
else
  WWW_BLOCK=""
  log "Configuring Caddy for $DOMAIN only (www.$DOMAIN has no DNS record — add a CNAME/A and re-run to enable the redirect)"
fi
# Caddy upstream list: one localhost:PORT per web instance. least_conn
# spreads new (incl. long-lived WS) connections more evenly than the
# default round-robin. Redis pub/sub fans WS broadcasts across instances,
# so no sticky sessions are needed.
CADDY_UPSTREAMS=""
for i in $(seq 1 "$INSTANCE_COUNT"); do CADDY_UPSTREAMS="$CADDY_UPSTREAMS localhost:$((3000 + i))"; done
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	reverse_proxy$CADDY_UPSTREAMS {
		lb_policy least_conn
	}
	encode zstd gzip
	# TLS policy. Caddy 2 defaults to 1.2+1.3 already; making it
	# explicit here so the policy survives a future Caddy default
	# change and is auditable from the Caddyfile alone (ASVS V9.1.2).
	tls {
		protocols tls1.2 tls1.3
	}
}$WWW_BLOCK
CADDY
systemctl enable caddy

# ── Firewall ────────────────────────────────────────────────────────────
log "Configuring firewall (allow SSH + 80 + 443)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# ── Start ───────────────────────────────────────────────────────────────
log "Starting services ($INSTANCE_COUNT web instance(s))"
# Y.Doc worker first, then every web instance, then Caddy.
[ "$INSTANCE_COUNT" -gt 1 ] && systemctl restart flowtex-yjs-worker
for i in $(seq 1 "$INSTANCE_COUNT"); do
  unit=$([ "$i" -eq 1 ] && echo flowtex || echo "flowtex-$i")
  systemctl restart "$unit"
done
systemctl restart caddy

# Give the app a moment, then health-check it locally.
for i in $(seq 1 30); do
  if curl -fsS "http://localhost:3001/api/health" >/dev/null 2>&1; then
    break
  fi
  [ "$i" -eq 30 ] && die "FlowTex did not come up — check: journalctl -u flowtex -n 50"
  sleep 1
done

if [ -n "$SMTP_HOST" ]; then
  EMAIL_STATUS="Email          configured — sending via $SMTP_HOST as $SMTP_FROM"
  EMAIL_STEP="2. Send a test email from Admin Dashboard > Settings to confirm delivery."
else
  EMAIL_STATUS="Email          NOT configured — emails are logged, not sent. Only the"
  EMAIL_STATUS="$EMAIL_STATUS
                 admin account can log in until SMTP is set (other users can't"
  EMAIL_STATUS="$EMAIL_STATUS
                 clear the email-verification gate)."
  EMAIL_STEP="2. Enable email: add SMTP_* to $APP_DIR/.env or use Admin Dashboard >
     Settings, then: systemctl restart flowtex"
fi

if [ "$WITH_DOCX" != "1" ]; then
  IM_STATUS="ImageMagick    not installed (WITH_DOCX=0)"
elif [ "$IM_HARDENED" = "1" ]; then
  IM_STATUS="ImageMagick    hardened — FlowTex policy.xml installed"
else
  IM_STATUS="ImageMagick    WARNING: installed but policy.xml NOT in place — see logs above"
fi

cat <<DONE

\033[1;32m✓ FlowTex is provisioned and running.\033[0m

  URL            https://$DOMAIN   (Caddy will fetch a cert on first visit)
  App service    systemctl status flowtex   |   journalctl -u flowtex -f
  Proxy          systemctl status caddy
  Config         $APP_DIR/.env   (chmod 600, owned by $APP_USER)
  $IM_STATUS
  $EMAIL_STATUS

Next steps:
  1. Confirm DNS for $DOMAIN points at this VPS, then open the URL — the
     first-run wizard creates the admin account.
  $EMAIL_STEP
  3. Optional: GitHub OAuth for repo sync — set GITHUB_CLIENT_ID/SECRET in .env.
  4. Schedule backups: $APP_DIR/scripts/backup.sh (see docs/installation.html §4.5).

Upgrades later:  re-run this script (it pulls $BRANCH, rebuilds, restarts).
DONE
