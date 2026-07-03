#!/usr/bin/env bash
# FlowTex VPS updater — routine deploy of a new main branch.
#
# Designed to run AS ROOT (sudo). The flowtex service account doesnt
# have an interactive shell (provision-vps.sh sets it to /usr/sbin/nologin
# for security), so `sudo -iu flowtex` returns "This account is currently
# not available." Instead, run this script as root and it will drop to
# the flowtex user via `sudo -u flowtex` for the file-ownership-sensitive
# operations (git pull, npm ci, npm run build) and run systemctl
# directly for the service restart.
#
# USAGE (run on the VPS)
#   sudo bash /opt/flowtex/scripts/update-vps.sh
#
# Or from your laptop with SSH:
#   ssh flowtex.click sudo bash /opt/flowtex/scripts/update-vps.sh
#
# ENV
#   APP_DIR      install location (default: /opt/flowtex)
#   APP_USER     unix user that owns the app (default: flowtex)
#   SERVICE      systemd service name (default: flowtex)
#   BRANCH       branch to deploy (default: main)
#   SKIP_NPM_CI  set to 1 to skip npm ci even if locks changed (saves time on
#                same-deps deploys when you know nothing is new)
#
# Idempotent — safe to re-run. Prints what it would do, then does it.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/flowtex}"
APP_USER="${APP_USER:-flowtex}"
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

# Must be root so we can both `sudo -u $APP_USER` AND `systemctl restart`.
if [ "$EUID" -ne 0 ]; then
  die "This script must be run as root (sudo bash $0). It drops to $APP_USER internally for file ops."
fi

# Wrapper that runs the given command as APP_USER. Uses `sudo -u` (not
# `sudo -iu`) so we dont need APP_USER to have a login shell — works
# with /usr/sbin/nologin which provision-vps.sh sets by default.
# `-H` keeps HOME pointed at APP_USERs home so npm puts its cache in
# the right place; `-E` lets us pass through PATH-affecting env vars.
as_app_user() {
  sudo -u "$APP_USER" -H bash -c "cd $APP_DIR && $*"
}

[ -d "$APP_DIR" ] || die "APP_DIR ($APP_DIR) does not exist. Did you run provision-vps.sh first?"
if ! id "$APP_USER" >/dev/null 2>&1; then
  die "User '$APP_USER' does not exist. Set APP_USER=<name> or check provision-vps.sh ran."
fi
cd "$APP_DIR"

# Allow root to read $APP_DIR's git repo even though it's owned by
# $APP_USER. Without this, `git rev-parse` from root in a repo owned
# by flowtex would fail with "dubious ownership".
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

# ── 1. Pull ──────────────────────────────────────────────────────────
say "Fetching latest $BRANCH"
as_app_user "git fetch --quiet origin"
INCOMING=$(as_app_user "git log --oneline ..origin/$BRANCH 2>/dev/null || true")
if [ -z "$INCOMING" ]; then
  ok "Repo is up to date with origin/$BRANCH."
  # BUT: the running build may still be behind HEAD (e.g. someone
  # pulled but never rebuilt, or a previous deploy stopped halfway).
  # Compare the SHA baked into the live client bundle against
  # current HEAD; if they differ, fall through to rebuild + restart.
  HEAD_SHA=$(as_app_user "git rev-parse --short HEAD")
  BUNDLE_SHA=""
  if [ -f "$APP_DIR/client/dist/index.html" ]; then
    # The build script injects VITE_BUILD_SHA into the bundle; we
    # grep for it in the bundled JS. Conservative: if we cant find
    # it, treat as stale and rebuild.
    BUNDLE_HASH=$(grep -oE 'index-[A-Za-z0-9_-]+\.js' "$APP_DIR/client/dist/index.html" | head -1 || true)
    if [ -n "$BUNDLE_HASH" ] && [ -f "$APP_DIR/client/dist/assets/$BUNDLE_HASH" ]; then
      BUNDLE_SHA=$(grep -oE "\"$HEAD_SHA\"" "$APP_DIR/client/dist/assets/$BUNDLE_HASH" | head -1 | tr -d '"' || true)
    fi
  fi
  if [ -n "$BUNDLE_SHA" ] && [ "$BUNDLE_SHA" = "$HEAD_SHA" ]; then
    ok "Live build SHA ($BUNDLE_SHA) matches HEAD — nothing to do."
    exit 0
  fi
  warn "Live build is stale (HEAD=$HEAD_SHA, bundle SHA=$BUNDLE_SHA). Rebuilding."
  FORCE_REBUILD=1
else
  echo "Incoming commits:"
  echo "$INCOMING" | sed 's/^/  /'
  echo
  FORCE_REBUILD=0
fi

# Record current HEAD so we can show a meaningful diff and so a rollback
# is one git command away.
PREV_HEAD=$(as_app_user "git rev-parse HEAD")
PREV_SHA=$(as_app_user "git rev-parse --short HEAD")

# Check we're not on a dirty working tree (tracked modifications would
# block the fast-forward merge / reset). Use `git status --porcelain`,
# NOT `git diff-index --quiet HEAD`: diff-index compares against a stale
# stat cache, so `npm ci` and the client build — which touch file mtimes
# without changing content — make it report a false "dirty" while
# `git status` (which refreshes the cache) shows the tree clean. That
# mismatch was blocking every deploy. --untracked-files=no ignores
# gitignored build output; we only care about tracked changes here.
if [ -n "$(as_app_user "git status --porcelain --untracked-files=no")" ]; then
  die "Working tree has tracked local changes. As $APP_USER: cd $APP_DIR && git status — commit, stash, or reset before deploying."
fi

# ── 2. Detect what changed ──────────────────────────────────────────
say "Checking what's affected"
CHANGED_FILES=$(as_app_user "git diff --name-only $PREV_HEAD origin/$BRANCH")
NEEDS_CLIENT_BUILD=0
NEEDS_SERVER_RESTART=0
NEEDS_NPM_CI_SERVER=0
NEEDS_NPM_CI_CLIENT=0
NEEDS_SANDBOX_REBUILD=0

# Rebuild on every HEAD move — not just `client/` changes. The build
# bakes VITE_BUILD_SHA = `git rev-parse --short HEAD` into the bundle,
# so a commit that touches only server/ or scripts/ still changes the
# value the About modal will display. Skipping the rebuild leaves the
# bundle pointing at the previous SHA, which looks like a broken
# deploy to anyone reading the About modal. The build is ~10-30s on
# the VPS — cheap enough to run unconditionally for any update.
if [ -n "$CHANGED_FILES" ] || [ "$FORCE_REBUILD" = "1" ]; then
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
# Rebuild the compile-sandbox image only when its inputs changed AND
# the operator actually runs the Docker compile path (skip the
# rebuild for self-hosted in-process deploys -- they don't have
# Docker installed). Probe both: do we have docker, and is the
# image already present locally?
if echo "$CHANGED_FILES" | grep -qE '^compile-sandbox/'; then
  if command -v docker >/dev/null 2>&1 && docker image inspect flowtex/compile-sandbox:tl-2022 >/dev/null 2>&1; then
    NEEDS_SANDBOX_REBUILD=1
  fi
fi

echo "  Client rebuild needed:  $( [ $NEEDS_CLIENT_BUILD -eq 1 ]  && echo yes || echo no )"
echo "  Server restart needed:  $( [ $NEEDS_SERVER_RESTART -eq 1 ] && echo yes || echo no )"
echo "  Server npm ci needed:   $( [ $NEEDS_NPM_CI_SERVER -eq 1 ]  && echo yes || echo no )"
echo "  Client npm ci needed:   $( [ $NEEDS_NPM_CI_CLIENT -eq 1 ]  && echo yes || echo no )"
echo "  Sandbox image rebuild:  $( [ $NEEDS_SANDBOX_REBUILD -eq 1 ] && echo yes || echo no )"
echo

# ── 3. Apply the pull ───────────────────────────────────────────────
say "Pulling $BRANCH"
as_app_user "git pull --ff-only origin $BRANCH"
NEW_SHA=$(as_app_user "git rev-parse --short HEAD")
ok "HEAD: $PREV_SHA → $NEW_SHA"

# ── 4. npm ci if locks changed ──────────────────────────────────────
if [ "$SKIP_NPM_CI" = "1" ]; then
  warn "SKIP_NPM_CI=1 set — skipping dependency installs even though locks changed."
else
  if [ $NEEDS_NPM_CI_SERVER -eq 1 ]; then
    say "Installing server deps (server/package-lock.json changed)"
    as_app_user "cd server && npm ci --omit=dev"
    ok "Server deps updated."
  fi
  if [ $NEEDS_NPM_CI_CLIENT -eq 1 ]; then
    say "Installing client deps (client/package-lock.json changed)"
    as_app_user "cd client && npm ci"
    ok "Client deps updated."
  fi
fi

# ── 5. Build client ─────────────────────────────────────────────────
if [ $NEEDS_CLIENT_BUILD -eq 1 ]; then
  say "Building client"
  as_app_user "cd client && npm run build"
  BUNDLE=$(grep -oE 'index-[A-Za-z0-9_-]+\.js' "$APP_DIR/client/dist/index.html" | head -1 || echo "(unknown)")
  ok "New bundle: $BUNDLE"
else
  warn "Nothing to build — skipping rebuild."
fi

# ── 5.5. Rebuild compile-sandbox image (if compile-sandbox/ changed) ──
if [ $NEEDS_SANDBOX_REBUILD -eq 1 ]; then
  say "Rebuilding compile-sandbox image (compile-sandbox/ changed)"
  # Layer cache means this is usually fast unless the Dockerfile's
  # apt step itself changed; tag matches whatever the operator picks
  # in .env (default flowtex/compile-sandbox:tl-2022).
  TAG="$(grep -oE '^FLOWTEX_COMPILE_IMAGE=[^[:space:]]+' "$APP_DIR/server/.env" 2>/dev/null | cut -d= -f2 || true)"
  TAG="${TAG:-flowtex/compile-sandbox:tl-2022}"
  docker build -t "$TAG" "$APP_DIR/compile-sandbox"
  ok "Rebuilt $TAG"
else
  : # silent when nothing to do (avoid noisy logs)
fi

# ── 6. Restart server ───────────────────────────────────────────────
if [ $NEEDS_SERVER_RESTART -eq 1 ]; then
  # Discover ALL flowtex web units up-front so we can restart the
  # entire set. The main $SERVICE plus any numbered cluster
  # instances (flowtex-2, flowtex-3, ...). Without this, Caddy
  # keeps load-balancing requests onto the still-old code on
  # whichever instance wasn't restarted -- a real incident
  # 2026-06-09: one instance was on cf14485, another on a commit
  # before SAML existed; "Continue with SSO" hit JSON 404 about
  # half the time.
  #
  # The regex matches `flowtex-<digits>.service` only. The
  # trailing -[0-9]+ excludes flowtex-yjs-worker (a worker tier,
  # restarted in its own block below).
  CLUSTER_INSTANCES=$(systemctl list-units --type=service --no-pager --no-legend --state=loaded 2>/dev/null \
    | awk '{print $1}' \
    | grep -E '^flowtex-[0-9]+\.service$' \
    || true)

  ALL_WEB_UNITS="$SERVICE"
  [ -n "$CLUSTER_INSTANCES" ] && ALL_WEB_UNITS="$SERVICE $CLUSTER_INSTANCES"

  say "Restarting web tier: $(echo $ALL_WEB_UNITS | tr '\n' ' ')"

  for unit in $ALL_WEB_UNITS; do
    # `systemctl cat` is the cheapest "does this unit exist?" probe
    # with clean exit-code semantics. We previously grepped the
    # output of `systemctl list-units`, but that output has leading
    # whitespace on every row -- the `^${SERVICE}` anchor never
    # matched, the script silently skipped the restart, and the
    # health check then failed because the old code was still
    # running. systemctl cat fails cleanly when a unit doesn't exist.
    if ! systemctl cat "$unit" >/dev/null 2>&1; then
      warn "No systemd unit named '$unit' found — skipping."
      continue
    fi
    systemctl restart "$unit"
    sleep 2
    if systemctl is-active --quiet "$unit"; then
      ok "$unit is running."
    else
      systemctl status "$unit" --no-pager | tail -20
      die "$unit failed to start. Restore: cd $APP_DIR && sudo -u $APP_USER git reset --hard $PREV_SHA && sudo -u $APP_USER bash -c 'cd client && npm run build' && for u in $ALL_WEB_UNITS; do systemctl restart \$u; done"
    fi
  done

  # If the operator has enabled the Y.Doc worker tier, restart it
  # alongside the web tier. Skip silently when the unit doesn't
  # exist (single-VPS deploys) or isn't enabled (multi-instance
  # deploys that haven't flipped FLOWTEX_YJS_WORKER yet).
  if command -v systemctl >/dev/null && systemctl is-enabled --quiet flowtex-yjs-worker 2>/dev/null; then
    say "Restarting flowtex-yjs-worker"
    systemctl restart flowtex-yjs-worker
    sleep 2
    if systemctl is-active --quiet flowtex-yjs-worker; then
      ok "flowtex-yjs-worker is running."
    else
      systemctl status flowtex-yjs-worker --no-pager | tail -10
      warn "flowtex-yjs-worker failed to start. Inspect with: journalctl -u flowtex-yjs-worker -n 50"
    fi
  fi
else
  warn "No server/ or shared/ changes — leaving web tier running."
fi

# ── 7. Health check ─────────────────────────────────────────────────
say "Verifying health"
HEALTH_URL="http://127.0.0.1:3001/api/health"
# The endpoint returns {"status":"ok"} — match THAT, not "ok":true,
# which was the old shape and never matched the current handler.
if curl -fsS --max-time 5 "$HEALTH_URL" | grep -q '"status":"ok"'; then
  ok "Health endpoint reports OK."
else
  warn "Health endpoint did not return status=ok. The service may still be initializing; recheck in a few seconds."
  warn "If it stays unhealthy: git reset --hard $PREV_SHA && (cd client && npm run build) && sudo systemctl restart $SERVICE"
fi

# ── 8. Print rollback recipe for the lazy / panicked future-you ─────
echo
say "Rollback (if you need it):"
echo "  sudo -u $APP_USER bash -c 'cd $APP_DIR && git reset --hard $PREV_SHA'"
[ $NEEDS_CLIENT_BUILD -eq 1 ]    && echo "  sudo -u $APP_USER bash -c 'cd $APP_DIR/client && npm run build'"
[ $NEEDS_SANDBOX_REBUILD -eq 1 ] && echo "  docker build -t flowtex/compile-sandbox:tl-2022 $APP_DIR/compile-sandbox"
[ $NEEDS_SERVER_RESTART -eq 1 ]  && echo "  systemctl restart $SERVICE"

echo
ok "Deploy complete: $PREV_SHA → $NEW_SHA"
