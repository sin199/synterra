#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

if [[ $# -ne 2 ]]; then
  echo "Usage: restore-postgres-new-db.sh BACKUP.dump BACKUP.manifest.json" >&2
  exit 2
fi
: "${SYNTERRA_RESTORE_PGSERVICE:?Set a pg_service.conf service for the target PostgreSQL cluster}"
: "${SYNTERRA_RESTORE_DATABASE:?Set a new target database name that does not already exist}"
: "${SYNTERRA_RESTORE_EXPECTED_WORLD_ID:?Set the previously verified world ID}"

dump="$1"
manifest="$2"
if [[ ! -r "$dump" || ! -r "$manifest" ]]; then echo "Backup or manifest is unreadable." >&2; exit 1; fi
if [[ ! "$SYNTERRA_RESTORE_DATABASE" =~ ^[a-z][a-z0-9_]{0,62}$ ]]; then
  echo "Target database name must be a lowercase PostgreSQL identifier." >&2
  exit 1
fi
manifest_world="$(node -e "const fs=require('node:fs');process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).worldId||'')" "$manifest")"
manifest_hash="$(node -e "const fs=require('node:fs');process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).sha256||'')" "$manifest")"
if command -v sha256sum >/dev/null; then expected_hash="$(sha256sum "$dump" | awk '{print $1}')"
elif command -v shasum >/dev/null; then expected_hash="$(shasum -a 256 "$dump" | awk '{print $1}')"
else echo "A SHA-256 utility (sha256sum or shasum) is required." >&2; exit 1; fi
if [[ "$manifest_world" != "$SYNTERRA_RESTORE_EXPECTED_WORLD_ID" ]]; then
  echo "Backup world ID does not match the explicitly expected world ID." >&2
  exit 1
fi
if [[ ! "$manifest_hash" =~ ^[0-9a-f]{64}$ || "$manifest_hash" != "$expected_hash" ]]; then
  echo "Backup checksum verification failed." >&2
  exit 1
fi

# createdb refuses to replace an existing database; this script never drops one.
createdb --maintenance-db="service=$SYNTERRA_RESTORE_PGSERVICE dbname=postgres" "$SYNTERRA_RESTORE_DATABASE"
pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname="service=$SYNTERRA_RESTORE_PGSERVICE dbname=$SYNTERRA_RESTORE_DATABASE" "$dump"
restored_world="$(psql -X -Atq "service=$SYNTERRA_RESTORE_PGSERVICE dbname=$SYNTERRA_RESTORE_DATABASE" \
  -c "SELECT id::text FROM worlds WHERE open=true ORDER BY created_at DESC,id LIMIT 1")"
if [[ "$restored_world" != "$SYNTERRA_RESTORE_EXPECTED_WORLD_ID" ]]; then
  echo "Restored database world ID mismatch; target database was preserved for inspection." >&2
  exit 1
fi
printf 'restored_world_id=%s\ntarget_database=%s\n' "$restored_world" "$SYNTERRA_RESTORE_DATABASE"
