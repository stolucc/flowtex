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
# Encryption (strongly recommended for any off-host backup):
#   BACKUP_AGE_RECIPIENT=age1abc... scripts/backup.sh
# Pipes the final tarball through `age` (filippo.io/age) before writing.
# The matching private key (age-keygen output) MUST live off this server
# — typical pattern: keep it in a password manager and on a USB. Server
# never holds the decryption key, so a server-compromise does not give
# the attacker access to the encrypted off-host backups.
#
# Required env: PGHOST, PGPORT, PGUSER, PGPASSWORD (or .pgpass), PGDATABASE.
# Reads .env from the repo root if present.
#
# Recommended cron (UTC nightly at 03:30):
#   30 3 * * * cd /opt/flowtex && BACKUP_DIR=/var/backups/flowtex \
#     BACKUP_AGE_RECIPIENT=age1... scripts/backup.sh >>/var/log/flowtex-backup.log 2>&1
#
# Restore: scripts/restore.sh path/to/flowtex-YYYYMMDD_HHMMSS.tar.gz[.age]

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

# ── Optional age encryption (off-host transfer hardening) ────────────
# Pipe the tarball through `age -r <recipient>` to produce a public-key-
# encrypted .age file. Recipient is an age public key (age1...); the
# matching private key lives off this server. Once encryption succeeds
# we replace the plaintext tarball so it never reaches S3 / remote
# storage / older backup hosts. A server-compromise therefore exposes
# at most one in-flight backup, not the historical set.
FINAL_ARCHIVE="$ARCHIVE"
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  if ! command -v age >/dev/null 2>&1; then
    echo "[backup] FATAL: BACKUP_AGE_RECIPIENT set but \`age\` binary not found." >&2
    echo "[backup] Install with: apt install age   /   brew install age" >&2
    exit 1
  fi
  FINAL_ARCHIVE="$ARCHIVE.age"
  echo "[backup] encrypting to $FINAL_ARCHIVE"
  age --recipient "$BACKUP_AGE_RECIPIENT" --output "$FINAL_ARCHIVE" "$ARCHIVE"
  rm -f "$ARCHIVE"
  echo "[backup] encrypted $FINAL_ARCHIVE ($(du -h "$FINAL_ARCHIVE" | cut -f1))"
else
  echo "[backup] WARNING: BACKUP_AGE_RECIPIENT not set; this archive is unencrypted." >&2
  echo "[backup]          Encrypt before shipping off-host: see SECURITY.md \"Backups\"." >&2
fi

# ── Optional S3 upload ───────────────────────────────────────────────
if [ -n "${AWS_S3_BUCKET:-}" ]; then
  S3_NAME="$(basename "$FINAL_ARCHIVE")"
  echo "[backup] uploading to s3://$AWS_S3_BUCKET/$S3_NAME"
  aws s3 cp "$FINAL_ARCHIVE" "s3://$AWS_S3_BUCKET/$S3_NAME"
fi

# ── Retention: prune local backups older than RETENTION_DAYS ─────────
if [ "$RETENTION_DAYS" -gt 0 ]; then
  echo "[backup] pruning local backups older than $RETENTION_DAYS days"
  find "$BACKUP_DIR" -maxdepth 1 \( -name 'flowtex-*.tar.gz' -o -name 'flowtex-*.tar.gz.age' \) -mtime "+$RETENTION_DAYS" -delete
fi

echo "[backup] done"
