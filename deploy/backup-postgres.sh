#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups/postgres}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/avclpr-$STAMP.dump"
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > "$OUT"
sha256sum "$OUT" > "$OUT.sha256"
echo "Created $OUT"
