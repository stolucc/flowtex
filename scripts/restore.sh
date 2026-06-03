#!/usr/bin/env bash
# FlowTex restore — counterpart to scripts/backup.sh.
# Restores a database dump AND the projects/git-repos directories from a
# backup archive produced by backup.sh. Handles both plaintext .tar.gz
# and age-encrypted .tar.gz.age archives.
#
# Designed to be safe to run against a FRESH target. Will refuse to
# overwrite an existing projects/ tree unless --force is passed.
#
# Usage:
#   scripts/restore.sh path/to/flowtex-YYYYMMDD_HHMMSS.tar.gz
#   scripts/restore.sh path/to/flowtex-YYYYMMDD_HHMMSS.tar.gz.age \
#       BACKUP_AGE_KEY_FILE=~/.age/flowtex-backup.key
#
# Required env:
#   PGHOST, PGPORT, PGUSER, PGPASSWORD (or .pgpass), PGDATABASE
# Optional env:
#   BACKUP_AGE_KEY_FILE   -- path to age-keygen output (private key).
#                            Only required when the input ends in .age.
#   RESTORE_FORCE=1       -- overwrite existing projects/ directory.
#
# The script does NOT start or stop the FlowTex server. Stop the server
# before restoring, run this, then start the server. The blob-GC
# reconciliation sweep will tidy up any drift on the first sweep.

set -euo pipefail

if [ "${1:-}" = "" ] || [ "${1:-}" = "--help" ]; then
  sed -n '2,/^set -eo/p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

INPUT_PATH="$1"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "$INPUT_PATH" ]; then
  echo "[restore] FATAL: input not found: $INPUT_PATH" >&2
  exit 2
fi

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

# Refuse to clobber an existing projects/ tree unless explicitly told.
# This catches the "I meant to restore to a fresh VPS" / "I meant the
# drill machine, not production" mistake before it destroys data.
if [ -d "$ROOT_DIR/projects" ] && [ "${RESTORE_FORCE:-0}" != "1" ]; then
  EXISTING_COUNT="$(find "$ROOT_DIR/projects" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  if [ "$EXISTING_COUNT" -gt 0 ]; then
    echo "[restore] FATAL: $ROOT_DIR/projects exists and contains $EXISTING_COUNT projects." >&2
    echo "[restore] Refusing to clobber. Re-run with RESTORE_FORCE=1 to overwrite." >&2
    exit 3
  fi
fi

WORK_DIR="$(mktemp -d -t flowtex-restore-XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

# ── Decrypt if needed ────────────────────────────────────────────────
case "$INPUT_PATH" in
  *.age)
    if ! command -v age >/dev/null 2>&1; then
      echo "[restore] FATAL: input is age-encrypted but \`age\` binary not found." >&2
      exit 4
    fi
    : "${BACKUP_AGE_KEY_FILE:?BACKUP_AGE_KEY_FILE must point at the age private-key file for $INPUT_PATH}"
    if [ ! -f "$BACKUP_AGE_KEY_FILE" ]; then
      echo "[restore] FATAL: BACKUP_AGE_KEY_FILE not found: $BACKUP_AGE_KEY_FILE" >&2
      exit 4
    fi
    TAR_PATH="$WORK_DIR/decrypted.tar.gz"
    echo "[restore] decrypting $INPUT_PATH"
    age --decrypt --identity "$BACKUP_AGE_KEY_FILE" --output "$TAR_PATH" "$INPUT_PATH"
    ;;
  *.tar.gz)
    TAR_PATH="$INPUT_PATH"
    ;;
  *)
    echo "[restore] FATAL: input must end in .tar.gz or .tar.gz.age" >&2
    exit 4
    ;;
esac

# ── Extract the outer wrapper ────────────────────────────────────────
echo "[restore] extracting $TAR_PATH"
tar --extract --gzip --file="$TAR_PATH" -C "$WORK_DIR"

INNER_DIR="$(find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d -name 'flowtex-*' | head -1)"
if [ -z "$INNER_DIR" ]; then
  echo "[restore] FATAL: archive does not contain a flowtex-* directory" >&2
  exit 5
fi
echo "[restore] inner directory: $(basename "$INNER_DIR")"

# ── Restore the database FIRST so the schema and refcounts exist ─────
if [ ! -f "$INNER_DIR/db.dump" ]; then
  echo "[restore] FATAL: $INNER_DIR/db.dump missing" >&2
  exit 6
fi
echo "[restore] restoring database $PGDATABASE..."
PGPASSWORD="${PGPASSWORD:-}" pg_restore \
  --host="$PGHOST" \
  --port="$PGPORT" \
  --username="$PGUSER" \
  --dbname="$PGDATABASE" \
  --clean --if-exists \
  --no-owner --no-privileges \
  "$INNER_DIR/db.dump"

# ── Untar projects/ and git-repos/ ───────────────────────────────────
if [ -f "$INNER_DIR/projects.tgz" ]; then
  echo "[restore] extracting projects/ into $ROOT_DIR"
  tar --extract --gzip --file="$INNER_DIR/projects.tgz" -C "$ROOT_DIR"
else
  echo "[restore] note: projects.tgz absent; nothing to restore to projects/"
fi

if [ -f "$INNER_DIR/git-repos.tgz" ]; then
  echo "[restore] extracting git-repos/ into $ROOT_DIR"
  tar --extract --gzip --file="$INNER_DIR/git-repos.tgz" -C "$ROOT_DIR"
fi

echo "[restore] done. Start the FlowTex server; the GC sweep will reconcile any drift."
