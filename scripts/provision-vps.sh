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
#   WITH_REDIS   install + wire Redis     (default: 0 — only for multi-instance)
#   WITH_DOCX    install LibreOffice/IM + Microsoft core fonts (default: 1)
#                — image conversion + Arial/Times/Courier for DOCX docs.
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

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ── Preflight ───────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "Run as root (sudo bash provision-vps.sh)."
[ -f /etc/os-release ] && . /etc/os-release
[ "${ID:-}" = "ubuntu" ] || die "This script targets Ubuntu. Detected: ${ID:-unknown}."
: "${DOMAIN:?Set DOMAIN=your.domain — Caddy needs it for the TLS cert}"
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

log "Provisioning FlowTex on $DOMAIN (Ubuntu $VERSION_ID, user: $APP_USER, dir: $APP_DIR)"

# ── System packages ─────────────────────────────────────────────────────
log "Installing system packages (texlive-full is ~7 GB — this is the slow step)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  build-essential python3 git curl ca-certificates \
  postgresql postgresql-contrib \
  texlive-full \
  util-linux \
  ufw
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
ENV
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# ── Install deps + build the client ─────────────────────────────────────
log "Installing dependencies and building the client (as $APP_USER)"
sudo -u "$APP_USER" bash -euo pipefail <<BUILD
cd "$APP_DIR"
npm install --prefix server --omit=dev
npm install --prefix client
( cd client && npx vite build )
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
ExecStart=/usr/bin/node --env-file=$APP_DIR/.env $APP_DIR/server/index.js
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

# ── Caddy ───────────────────────────────────────────────────────────────
log "Configuring Caddy for $DOMAIN (automatic HTTPS via Let's Encrypt)"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	reverse_proxy localhost:3001
	encode zstd gzip
}
CADDY
systemctl enable caddy

# ── Firewall ────────────────────────────────────────────────────────────
log "Configuring firewall (allow SSH + 80 + 443)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# ── Start ───────────────────────────────────────────────────────────────
log "Starting services"
systemctl restart flowtex
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
