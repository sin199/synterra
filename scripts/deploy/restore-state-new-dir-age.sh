#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

if [[ $# -ne 2 ]]; then
  echo "Usage: restore-state-new-dir-age.sh BACKUP.tar.gz.age NEW_EMPTY_STATE_DIR" >&2
  exit 2
fi
: "${SYNTERRA_STATE_BACKUP_AGE_IDENTITY:?Set the operator-controlled age identity path outside the repository}"
command -v age >/dev/null || { echo "age is required for encrypted state restore." >&2; exit 1; }
archive="$1"
target="$2"
[[ -r "$archive" && -r "$SYNTERRA_STATE_BACKUP_AGE_IDENTITY" ]] || { echo "Backup or age identity is unreadable." >&2; exit 1; }
if [[ -e "$target" ]]; then echo "Refusing to overwrite an existing state directory." >&2; exit 1; fi
mkdir -m 700 -p "$target"
age --decrypt --identity "$SYNTERRA_STATE_BACKUP_AGE_IDENTITY" "$archive" \
  | tar -xzpf - --no-same-owner --no-same-permissions -C "$target"
find "$target" -type d -exec chmod 700 {} +
find "$target" -type f -exec chmod go-rwx {} +
printf 'restored_state_dir=%s\n' "$target"
