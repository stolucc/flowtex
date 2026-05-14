#!/usr/bin/env bash
# Rotate the deploy-time log files (node, caddy, backup).
#
# Each log file is renamed to <name>.<YYYYMMDD-HHMMSS>.log and gzipped,
# then the live file is truncated in place. Truncation (rather than
# delete+recreate) means the long-running node/caddy processes keep
# writing to the same file descriptor — no SIGHUP needed.
#
# Old rotated logs beyond RETENTION_DAYS (default 14) are removed.
#
# Usage:
#   scripts/rotate-logs.sh                       # rotate the standard set
#   scripts/rotate-logs.sh /path/to/x.log        # rotate explicit files

set -euo pipefail

RETENTION_DAYS="${LOG_RETENTION_DAYS:-14}"
TS="$(date -u +%Y%m%d-%H%M%S)"

if [ "$#" -gt 0 ]; then
  FILES=("$@")
else
  ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  FILES=(
    "$ROOT_DIR/deploy/node.log"
    "$ROOT_DIR/deploy/caddy.log"
    "$ROOT_DIR/deploy/caddy-stdout.log"
    "$ROOT_DIR/deploy/backup.log"
  )
fi

for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue
  # Skip empty files — no point churning a rotation for them.
  [ -s "$f" ] || continue

  dir="$(dirname "$f")"
  base="$(basename "$f" .log)"
  rotated="$dir/$base.$TS.log"

  cp "$f" "$rotated"
  : > "$f"
  gzip -f "$rotated"

  # Prune anything older than RETENTION_DAYS that matches this base.
  find "$dir" -maxdepth 1 -name "$base.*.log.gz" -type f -mtime "+$RETENTION_DAYS" -delete
done
