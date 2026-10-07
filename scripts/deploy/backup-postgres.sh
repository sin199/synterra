#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

: "${SYNTERRA_BACKUP_PGSERVICE:?Set a pg_service.conf service name for the source database}"
: "${SYNTERRA_BACKUP_DIR:?Set an operator-controlled backup directory outside the repository}"

mkdir -p "$SYNTERRA_BACKUP_DIR"
chmod 700 "$SYNTERRA_BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
database="$(psql -X -Atq "service=$SYNTERRA_BACKUP_PGSERVICE" -c 'SELECT current_database()')"
safe_database="$(printf '%s' "$database" | tr -cs 'A-Za-z0-9_-' '_')"
base="$SYNTERRA_BACKUP_DIR/synterra-${safe_database}-${timestamp}"
dump="$base.dump"
manifest="$base.manifest.json"

if [[ -e "$dump" || -e "$manifest" ]]; then
  echo "Refusing to overwrite an existing backup artifact." >&2
  exit 1
fi

pg_dump --format=custom --compress=9 --no-owner --no-privileges \
  --dbname="service=$SYNTERRA_BACKUP_PGSERVICE" --file="$dump"
chmod 600 "$dump"
snapshot="$(psql -X -F '|' -Atq "service=$SYNTERRA_BACKUP_PGSERVICE" -c "
  SELECT w.id::text, r.world_minutes::text,
    (SELECT count(*)::text FROM world_members m WHERE m.world_id=w.id)
  FROM worlds w JOIN world_runtime_state r ON r.world_id=w.id
  WHERE w.open=true ORDER BY w.created_at DESC,w.id LIMIT 1")"
if [[ -z "$snapshot" ]]; then
  echo "No open world with a persisted runtime clock was found; keeping the dump for inspection." >&2
  exit 1
fi
IFS='|' read -r world_id world_minute resident_count <<< "$snapshot"
if command -v sha256sum >/dev/null; then checksum="$(sha256sum "$dump" | awk '{print $1}')"
elif command -v shasum >/dev/null; then checksum="$(shasum -a 256 "$dump" | awk '{print $1}')"
else echo "A SHA-256 utility (sha256sum or shasum) is required." >&2; exit 1; fi
cat > "$manifest" <<EOF
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "format": "pg_dump_custom",
  "database": "$safe_database",
  "worldId": "$world_id",
  "worldMinuteMetadataSample": "$world_minute",
  "residentCountMetadataSample": "$resident_count",
  "sha256": "$checksum",
  "metadataNote": "pg_dump uses a consistent database snapshot; metadata is sampled separately and should be refreshed after stopping the world engine for cutover."
}
EOF
chmod 600 "$manifest"
printf '%s\n' "$dump" "$manifest"
