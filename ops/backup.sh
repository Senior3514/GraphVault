#!/usr/bin/env bash
# GraphVault nightly backup: Postgres dump + the blob volume + the at-rest
# encryption key. All three are required for a real restore - a DB dump alone
# cannot decrypt blob bytes if GRAPHVAULT_ENCRYPTION_KEY is lost, which is why
# the key is captured here rather than left to be remembered.
set -euo pipefail

REPO="/home/pikachu/graphvault"
DEST="${GRAPHVAULT_BACKUP_DIR:-/home/pikachu/graphvault-backups}"
KEEP_DAYS="${GRAPHVAULT_BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/$STAMP"

mkdir -p "$OUT"
cd "$REPO"

# Postgres logical dump, streamed straight out of the container.
sg docker -c "docker compose exec -T db pg_dump -U graphvault -d graphvault" \
  | gzip > "$OUT/db.sql.gz"

# Blob bytes live on a named volume; tar it from a throwaway container.
sg docker -c "docker run --rm -v graphvault_blob-data:/data:ro -v '$OUT':/backup alpine \
  tar czf /backup/blobs.tar.gz -C /data ." >/dev/null

# The at-rest key - without it the blobs above are unrecoverable.
grep '^GRAPHVAULT_ENCRYPTION_KEY=' .env > "$OUT/encryption-key.env"
chmod 600 "$OUT/encryption-key.env"

# Prune old backups.
find "$DEST" -maxdepth 1 -type d -name '20*Z' -mtime "+$KEEP_DAYS" -exec rm -rf {} + 2>/dev/null || true

echo "backup complete: $OUT"
du -sh "$OUT"
