#!/usr/bin/env bash
# FlowTex VPS updater — routine deploy of a new main branch.
#
# Run as the flowtex unix user (or root with --become-flowtex) on a host
# that was previously bootstrapped by provision-vps.sh. Does the safe
# routine deploy: git pull main, npm ci if package-locks changed,
# rebuild the client, run the schema migration on next boot, restart
# the systemd service, then verify the new build is up.
#
# USAGE
#   sudo -iu flowtex bash /opt/flowtex/scripts/update-vps.sh
#
# or, if you keep the script on your laptop and SCP it up:
#   scp scripts/update-vps.sh flowtex.click:/tmp/
#   ssh flowtex.click sudo -iu flowtex bash /tmp/update-vps.sh
#
# ENV
#   APP_DIR      install location (default: /opt/flowtex)
#   SERVICE      systemd service name (default: flowtex)
#   BRANCH       branch to deploy (default: main)
#   SKIP_NPM_CI  set to 1 to skip npm ci even if locks changed (saves time on
#                same-deps deploys when you know nothing is new)
#
# Idempotent — safe to re-run. Prints what it would do, then does it.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/flowtex}"
SERVICE="${SERVICE:-flowtex}"
BRANCH="${BRANCH:-main}"
SKIP_NPM_CI="${SKIP_NPM_CI:-0}"

GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RED=$'\033[31m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

say()  { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s⚠%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

[ -d "$APP_DIR" ] || die "APP_DIR ($APP_DIR) does not exist. Did you run provision-vps.sh first?"
cd "$APP_DIR"

# ── 1. Pull ──────────────────────────────────────────────────────────
say "Fetching latest $BRANCH"
git fetch --quiet origin
INCOMING=$(git log --oneline "..origin/$BRANCH" 2>/dev/null || true)
if [ -z "$INCOMING" ]; then
  ok "Already up to date — nothing to deploy."
  exit 0
fi
echo "Incoming commits:"
echo "$INCOMING" | sed 's/^/  /'
echo

# Record current HEAD so we can show a meaningful diff and so a rollback
# is one git command away.
PREV_HEAD=$(git rev-parse HEAD)
PREV_SHA=$(git rev-parse --short HEAD)

# Check we're not on a dirty working tree (would block ff merge).
if ! git diff-index --quiet HEAD --; then
  die "Working tree is dirty. 'git status' to see what; commit, stash, or reset before deploying."
fi

# ── 2. Detect what changed ──────────────────────────────────────────
say "Checking what's affected"
CHANGED_FILES=$(git diff --name-only "$PREV_HEAD" "origin/$BRANCH")
NEEDS_CLIENT_BUILD=0
NEEDS_SERVER_RESTART=0
NEEDS_NPM_CI_SERVER=0
NEEDS_NPM_CI_CLIENT=0

if echo "$CHANGED_FILES" | grep -q '^client/'; then
  NEEDS_CLIENT_BUILD=1
fi
if echo "$CHANGED_FILES" | grep -qE '^(server/|shared/)'; then
  NEEDS_SERVER_RESTART=1
fi
if echo "$CHANGED_FILES" | grep -q '^server/package-lock\.json$'; then
  NEEDS_NPM_CI_SERVER=1
fi
if echo "$CHANGED_FILES" | grep -q '^client/package-lock\.json$'; then
  NEEDS_NPM_CI_CLIENT=1
fi

echo "  Client rebuild needed:  $( [ $NEEDS_CLIENT_BUILD -eq 1 ]  && echo yes || echo no )"
echo "  Server restart needed:  $( [ $NEEDS_SERVER_RESTART -eq 1 ] && echo yes || echo no )"
echo "  Server npm ci needed:   $( [ $NEEDS_NPM_CI_SERVER -eq 1 ]  && echo yes || echo no )"
echo "  Client npm ci needed:   $( [ $NEEDS_NPM_CI_CLIENT -eq 1 ]  && echo yes || echo no )"
echo

# ── 3. Apply the pull ───────────────────────────────────────────────
say "Pulling $BRANCH"
git pull --ff-only origin "$BRANCH"
NEW_SHA=$(git rev-parse --short HEAD)
ok "HEAD: $PREV_SHA → $NEW_SHA"

# ── 4. npm ci if locks changed ──────────────────────────────────────
if [ "$SKIP_NPM_CI" = "1" ]; then
  warn "SKIP_NPM_CI=1 set — skipping dependency installs even though locks changed."
else
  if [ $NEEDS_NPM_CI_SERVER -eq 1 ]; then
    say "Installing server deps (server/package-lock.json changed)"
    (cd server && npm ci --omit=dev)
    ok "Server deps updated."
  fi
  if [ $NEEDS_NPM_CI_CLIENT -eq 1 ]; then
    say "Installing client deps (client/package-lock.json changed)"
    (cd client && npm ci)
    ok "Client deps updated."
  fi
fi

# ── 5. Build client ─────────────────────────────────────────────────
if [ $NEEDS_CLIENT_BUILD -eq 1 ]; then
  say "Building client"
  (cd client && npm run build)
  BUNDLE=$(grep -oE 'index-[A-Za-z0-9_-]+\.js' client/dist/index.html | head -1 || echo "(unknown)")
  ok "New bundle: $BUNDLE"
else
  warn "No client/ changes — skipping rebuild."
fi

# ── 6. Restart server ───────────────────────────────────────────────
if [ $NEEDS_SERVER_RESTART -eq 1 ]; then
  say "Restarting $SERVICE"
  if command -v systemctl >/dev/null && systemctl list-units --type=service --all | grep -q "^${SERVICE}.service"; then
    sudo systemctl restart "$SERVICE"
    sleep 2
    if systemctl is-active --quiet "$SERVICE"; then
      ok "$SERVICE is running."
    else
      sudo systemctl status "$SERVICE" --no-pager | tail -20
      die "$SERVICE failed to start. Restore with: git reset --hard $PREV_SHA && (cd client && npm run build) && sudo systemctl restart $SERVICE"
    fi
  else
    warn "No systemd unit named '$SERVICE' found. Restart your process manager manually."
  fi
else
  warn "No server/ or shared/ changes — leaving $SERVICE running."
fi

# ── 7. Health check ─────────────────────────────────────────────────
say "Verifying health"
HEALTH_URL="http://127.0.0.1:3001/api/health"
if curl -fsS --max-time 5 "$HEALTH_URL" | grep -q '"ok":true'; then
  ok "Health endpoint reports OK."
else
  warn "Health endpoint did not return ok=true. The service may still be initializing; recheck in a few seconds."
  warn "If it stays unhealthy: git reset --hard $PREV_SHA && (cd client && npm run build) && sudo systemctl restart $SERVICE"
fi

# ── 8. Print rollback recipe for the lazy / panicked future-you ─────
echo
say "Rollback (if you need it):"
echo "  cd $APP_DIR"
echo "  git reset --hard $PREV_SHA"
[ $NEEDS_CLIENT_BUILD -eq 1 ]    && echo "  (cd client && npm run build)"
[ $NEEDS_SERVER_RESTART -eq 1 ]  && echo "  sudo systemctl restart $SERVICE"

echo
ok "Deploy complete: $PREV_SHA → $NEW_SHA"
