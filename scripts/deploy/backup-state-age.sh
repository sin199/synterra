#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

: "${SYNTERRA_STATE_DIR:?Set the exact persistent SYNTERRA_STATE_DIR to back up}"
: "${SYNTERRA_STATE_BACKUP_DIR:?Set an encrypted backup directory outside the repository}"
: "${SYNTERRA_STATE_BACKUP_AGE_RECIPIENT:?Set an operator-controlled age recipient; do not create or guess a key here}"
command -v age >/dev/null || { echo "age is required for encrypted state backup." >&2; exit 1; }
[[ -d "$SYNTERRA_STATE_DIR" ]] || { echo "State directory does not exist." >&2; exit 1; }
mkdir -p "$SYNTERRA_STATE_BACKUP_DIR"
chmod 700 "$SYNTERRA_STATE_BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$SYNTERRA_STATE_BACKUP_DIR/synterra-state-${timestamp}.tar.gz.age"
if [[ -e "$archive" ]]; then echo "Refusing to overwrite an existing state backup." >&2; exit 1; fi
tar -czpf - -C "$SYNTERRA_STATE_DIR" . \
  | age --encrypt --recipient "$SYNTERRA_STATE_BACKUP_AGE_RECIPIENT" --output "$archive"
chmod 600 "$archive"
printf '%s\n' "$archive"
