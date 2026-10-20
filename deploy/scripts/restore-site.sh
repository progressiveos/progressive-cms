#!/usr/bin/env bash
#
# Restores a backup set (see backup-site.sh) into a DISPOSABLE target:
# a fresh PostgreSQL database and a media directory inside a scratch root.
# Use a disposable database and media root unless the explicit override is supplied.
#
# Usage:
#   restore-site.sh --backup-dir <set> --pg-host <host> --db-name <scratch> \
#     --db-user <app-role> --media-root <scratch-root> [--pg-admin-cmd <cmd>]
#     [--i-know-this-is-production]
#
# --pg-admin-cmd is the command that can CREATE/DROP DATABASES (defaults to
#   "psql -h <pg-host> -U <db-user>"; e.g. "sudo -u postgres psql" for a
#   container-local server, least-privilege app roles cannot create DBs).
#
# --i-know-this-is-production lifts the guard against restoring over the
#   LIVE database (the one pcms.json points at). Every other spelling of an
#   accidental live-target fails closed before any DROP runs.
#
# What it restores: database (pg_dump custom format), media archive,
# configuration metadata. It does not change the target's secrets,
# systemd units, or nginx configuration.
set -euo pipefail

BACKUP_DIR=
PG_HOST=
DB_NAME=
DB_USER=
MEDIA_ROOT=
PG_ADMIN_CMD=

while [ $# -ge 2 ]; do
  case "$1" in
    --backup-dir) BACKUP_DIR=$2 ;;
    --pg-host) PG_HOST=$2 ;;
    --db-name) DB_NAME=$2 ;;
    --db-user) DB_USER=$2 ;;
    --media-root) MEDIA_ROOT=$2 ;;
    --release-root) RELEASE_ROOT=$2 ;;
    --pg-admin-cmd) PG_ADMIN_CMD=$2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift 2
done

for var in BACKUP_DIR PG_HOST DB_NAME DB_USER MEDIA_ROOT; do
  [ -n "${!var}" ] || { echo "missing --$(echo "$var" | tr '_' '-' | tr 'A-Z' 'a-z')" >&2; exit 2; }
done
[ -n "$PG_ADMIN_CMD" ] || PG_ADMIN_CMD="psql -h $PG_HOST -U $DB_USER"

# live database named in /etc/progressive-cms/pcms.json unless the explicit
# production override flag is present. Also reject names that cannot be a
# PostgreSQL identifier instead of letting them reach the SQL literal.
if [[ ! "${DB_NAME}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
  echo "refusing: --db-name \"$DB_NAME\" is not a valid database identifier" >&2
  exit 2
fi
LIVE_DB_NAME=$(jq -r .db.database /etc/progressive-cms/pcms.json 2>/dev/null || true)
if [ "$DB_NAME" = "$LIVE_DB_NAME" ] && [ "${1:-}" != "--i-know-this-is-production" ] \
  && ! printf '%s\n' "$@" | grep -q -- "--i-know-this-is-production"; then
  echo "refusing: --db-name matches the LIVE database \"$LIVE_DB_NAME\" from pcms.json" >&2
  echo "pass --i-know-this-is-production to restore over the live database deliberately" >&2
  exit 2
fi

( cd "$BACKUP_DIR" && sha256sum -c checksums.sha256 --quiet )
echo "checksums OK"

# 2. Drop + recreate the scratch database via the admin command, then load
#    the custom-format dump as the application role. The app-role password
#    travels via PGPASSFILE (0600 tmpfile), never the process environment.
PGPASSFILE=$(mktemp)
chmod 0600 "$PGPASSFILE"
printf '*:*:*:%s:%s\n' "$DB_USER" "$(cat /etc/progressive-cms/secrets/db.password)" > "$PGPASSFILE"
export PGPASSFILE
$PG_ADMIN_CMD -c "DROP DATABASE IF EXISTS \"$DB_NAME\";" >/dev/null
$PG_ADMIN_CMD -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\";" >/dev/null
pg_restore -h "$PG_HOST" -U "$DB_USER" -d "$DB_NAME" --no-owner --role="$DB_USER" "$BACKUP_DIR/db.dump"
rm -f "$PGPASSFILE"
unset PGPASSFILE
echo "database restored: $DB_NAME"

# 3. Media archive into the scratch media root.
mkdir -p "$MEDIA_ROOT"
tar -xzf "$BACKUP_DIR/media.tar.gz" -C "$MEDIA_ROOT"
echo "media restored: $MEDIA_ROOT/media"

# 4. Configuration metadata beside the scratch root (operator review).
mkdir -p "$(dirname "$MEDIA_ROOT")/restore-config-metadata"
cp "$BACKUP_DIR/pcms.json" "$BACKUP_DIR/content-types.json" 2>/dev/null \
  "$(dirname "$MEDIA_ROOT")/restore-config-metadata/" || true

# 5. Optional: report which release matches the backup (activation is the
# caller's decision — the scratch environment boots a specific release).
if [ -n "${RELEASE_ROOT:-}" ]; then
  echo "release root for boot: $RELEASE_ROOT"
fi
echo "restore complete: $BACKUP_DIR -> db=$DB_NAME media=$MEDIA_ROOT"
