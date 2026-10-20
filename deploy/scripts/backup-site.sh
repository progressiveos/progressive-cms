#!/usr/bin/env bash
#
# Produces one self-describing backup set under
#   /var/backups/progressive-cms/<UTC stamp>/
# containing: PostgreSQL custom-format dump, media archive, configuration
# metadata (secret-free by construction), release metadata and a manifest
# with per-file SHA-256 checksums. Secrets are NEVER included: credentials
# live in /etc/progressive-cms/secrets/* and only file-backed secret *refs*
# appear in pcms.json.
#
# Usage (root on the site container):
#   backup-site.sh [--retention N]     # N most recent sets kept, default 7
# Requires: psql/pg_dump client, the release's build-metadata.json.
set -euo pipefail

RETENTION=7
[ "${1:-}" = "--retention" ] && { RETENTION=$2; shift 2; }

BACKUP_ROOT=/var/backups/progressive-cms
RELEASE_ROOT=/opt/progressive-cms/current
CONF_DIR=/etc/progressive-cms
MEDIA_DIR=/var/lib/progressive-cms/media
# DB host comes from the site config (pcms.json .db.host) so a local-Postgres
# install (127.0.0.1) never reaches for a foreign pg_hba; PCMS_DB_HOST still
# overrides for split-DB topologies.
DB_HOST=${PCMS_DB_HOST:-$(jq -r '.db.host // empty' "$CONF_DIR/pcms.json" 2>/dev/null)}
[ -n "$DB_HOST" ] || { echo "missing database host in pcms.json or PCMS_DB_HOST" >&2; exit 2; }

umask 027
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DIR="$BACKUP_ROOT/$STAMP"
mkdir -p "$DIR"

# --- database dump and recorded engine/schema version ----------------------
# Password travels via PGPASSFILE (0600, private tmpfile), not the process
# environment: PGPASSWORD is readable from /proc/<pid>/environ by anything
# running as the same user.
DBPASS=$(cat "$CONF_DIR/secrets/db.password")
PGPASSFILE=$(mktemp)
chmod 0600 "$PGPASSFILE"
printf '*:*:*:%s:%s\n' "$(jq -r .db.user "$CONF_DIR/pcms.json")" "$DBPASS" > "$PGPASSFILE"
export PGPASSFILE
DB_NAME=$(jq -r .db.database "$CONF_DIR/pcms.json")
DB_USER=$(jq -r .db.user "$CONF_DIR/pcms.json")
SITE_HOST=$(psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT hostname FROM domain_bindings WHERE is_primary ORDER BY hostname LIMIT 1" | head -1)
pg_dump -Fc -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -f "$DIR/db.dump"
pg_dump --version > "$DIR/pg_dump_version.txt"
psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT name || '|' || checksum FROM pcms_schema_migrations ORDER BY name;" \
  > "$DIR/db_migration_ledger.txt"
rm -f "$PGPASSFILE"
unset PGPASSFILE

tar -C "$(dirname "$MEDIA_DIR")" -czf "$DIR/media.tar.gz" --numeric-owner "$(basename "$MEDIA_DIR")"

# --- configuration metadata (secret-free) ----------------------------------
cp "$CONF_DIR/pcms.json" "$DIR/pcms.json"
cp "$CONF_DIR/content-types.json" "$DIR/content-types.json" 2>/dev/null || true

# --- release metadata -------------------------------------------------------
cp "$RELEASE_ROOT/build-metadata.json" "$DIR/build-metadata.json"
cp "$RELEASE_ROOT/update-manifest.json" "$DIR/update-manifest.json" 2>/dev/null || true
readlink -f "$RELEASE_ROOT" > "$DIR/release_path.txt"
systemctl show progressive-cms-web.service progressive-cms-worker.service \
  -p Id -p ActiveState -p MainPID > "$DIR/services.txt"

# --- manifest + checksums ---------------------------------------------------
MIGRATION_HEAD=$(tail -1 "$DIR/db_migration_ledger.txt" | cut -d'|' -f1)
jq -n \
  --arg schema "pcms-backup-manifest/1" \
  --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg site_host "${SITE_HOST:-$(hostname)}" \
  --arg release_id "$(jq -r .releaseId "$DIR/build-metadata.json")" \
  --arg release_commit "$(jq -r .gitCommit "$DIR/build-metadata.json")" \
  --arg db_migration_head "$MIGRATION_HEAD" \
  --arg db_engine "$(tail -1 "$DIR/pg_dump_version.txt")" \
  '{schema: $schema, created_at: $created_at, site_host: $site_host,
    release: {id: $release_id, commit: $release_commit},
    db: {migration_head: $db_migration_head, dump_engine: $db_engine, format: "pg_dump custom"},
    components: {database: "db.dump", media: "media.tar.gz",
                 config: "pcms.json", content_types: "content-types.json",
                 release_metadata: "build-metadata.json",
                 update_manifest: "update-manifest.json"},
    secrets_included: false}' > "$DIR/manifest.json"
( cd "$DIR" && sha256sum db.dump media.tar.gz manifest.json > checksums.sha256 )

chmod -R g-rwx,o-rwx "$DIR"
chmod 0640 "$DIR"/*

# --- retention --------------------------------------------------------------
# Keep at most $RETENTION sets, but never drop a set younger than
# $RETENTION_MIN_AGE_DAYS: at multi-deploy-per-day cadence a pure count-based
# retention shrinks the recovery window to hours.
RETENTION_MIN_AGE_DAYS=3
CUTOFF=$(date -u -d "-${RETENTION_MIN_AGE_DAYS} days" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -v-${RETENTION_MIN_AGE_DAYS}d +%Y%m%dT%H%M%SZ)
ls -1d "$BACKUP_ROOT"/2* 2>/dev/null | sort | head -n -"$RETENTION" | while read -r old; do
  stamp=$(basename "$old")
  if [ "$stamp" \> "$CUTOFF" ]; then
    continue  # inside the minimum-age window — keep regardless of count
  fi
  rm -rf "$old"
done

echo "backup set: $DIR"
