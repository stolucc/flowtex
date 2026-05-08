#!/usr/bin/env bash
# FlowTex backup — dumps the Postgres database AND the projects/git-repos
# directories to a single timestamped archive. Exits non-zero on any failure
# so cron / systemd timers can alert on it.
#
# Usage:
#   scripts/backup.sh                                 # writes to ./backups/
#   BACKUP_DIR=/var/backups/flowtex scripts/backup.sh # explicit dir
#   AWS_S3_BUCKET=my-bucket scripts/backup.sh         # also upload to S3
#
# Required env: PGHOST, PGPORT, PGUSER, PGPASSWORD (or .pgpass), PGDATABASE.
# Reads .env from the repo root if present.
#
# Recommended cron (UTC nightly at 03:30):
#   30 3 * * * cd /opt/flowtex && BACKUP_DIR=/var/backups/flowtex scripts/backup.sh >>/var/log/flowtex-backup.log 2>&1
#
# Restore: pg_restore + tar -xzf to projects/.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

# Pull DB env from .env if not already exported.
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ROOT_DIR/.env"
  set +a
fi

: "${PGDATABASE:?PGDATABASE must be set (in env or .env)}"
: "${PGHOST:?PGHOST must be set}"
: "${PGPORT:?PGPORT must be set}"
: "${PGUSER:?PGUSER must be set}"

mkdir -p "$BACKUP_DIR"
TS="$(date -u +%Y%m%d_%H%M%S)"
TARGET="$BACKUP_DIR/flowtex-$TS"
mkdir -p "$TARGET"

echo "[backup] starting at $TS UTC, target=$TARGET"

# ── Database dump (custom format = compressed + restore-friendly) ────
echo "[backup] dumping database $PGDATABASE..."
PGPASSWORD="${PGPASSWORD:-}" pg_dump \
  --host="$PGHOST" \
  --port="$PGPORT" \
  --username="$PGUSER" \
  --dbname="$PGDATABASE" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="$TARGET/db.dump"

# ── Project files (compiled PDFs + uploaded binaries on disk) ────────
if [ -d "$ROOT_DIR/projects" ]; then
  echo "[backup] archiving projects/..."
  tar --create --gzip --file="$TARGET/projects.tgz" -C "$ROOT_DIR" projects
fi

# ── GitHub-synced checkouts (have HEAD that matches DB state) ────────
if [ -d "$ROOT_DIR/git-repos" ]; then
  echo "[backup] archiving git-repos/..."
  tar --create --gzip --file="$TARGET/git-repos.tgz" -C "$ROOT_DIR" git-repos
fi

# ── Single archive of everything ─────────────────────────────────────
ARCHIVE="$BACKUP_DIR/flowtex-$TS.tar.gz"
tar --create --gzip --file="$ARCHIVE" -C "$BACKUP_DIR" "flowtex-$TS"
rm -rf "$TARGET"
echo "[backup] wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

# ── Optional S3 upload ───────────────────────────────────────────────
if [ -n "${AWS_S3_BUCKET:-}" ]; then
  echo "[backup] uploading to s3://$AWS_S3_BUCKET/"
  aws s3 cp "$ARCHIVE" "s3://$AWS_S3_BUCKET/flowtex-$TS.tar.gz"
fi

# ── Retention: prune local backups older than RETENTION_DAYS ─────────
if [ "$RETENTION_DAYS" -gt 0 ]; then
  echo "[backup] pruning local backups older than $RETENTION_DAYS days"
  find "$BACKUP_DIR" -maxdepth 1 -name 'flowtex-*.tar.gz' -mtime "+$RETENTION_DAYS" -delete
fi

echo "[backup] done"
