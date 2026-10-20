#!/usr/bin/env bash
#
# Idempotent. Runs INSIDE the site container as root, the same way as
#
#   incus exec <remote>:<container> -- bash -s < deploy/scripts/install-restart-bridge.sh
#
# Installs the root unit pair that lets the application user restart the CMS
# units by writing the marker /run/progressive-cms/restart-requested:
#
#   progressive-cms-restart.path     watches for the marker
#   progressive-cms-restart.service  restarts web+worker, removes the marker
#
# The bridge is OPTIONAL: without it the update orchestrator's marker write
# is skipped silently and the operator restarts the units manually after
set -euo pipefail

log() { printf '[install-restart-bridge] %s\n' "$*"; }

# Deployment assets: from the installed release by default; an operator may
# point PROVISION_ASSETS_DIR at a staged copy of the repository deploy/.
ASSETS="${PROVISION_ASSETS_DIR:-/opt/progressive-cms/current/deploy}"

# --- marker directory ---------------------------------------------------------
# /run is tmpfs: the app units (re)create /run/progressive-cms at every start
# via RuntimeDirectory=progressive-cms (owned progressive-cms:progressive-cms).
# A bridge installed before the first app boot must create it itself; when it
# already exists (systemd-owned or from provisioning) just re-assert
# ownership so the app user can write the marker.
if ! id -u progressive-cms >/dev/null 2>&1; then
  log "ERROR: the progressive-cms user does not exist; run install-release.sh bootstrap first"
  exit 1
fi
mkdir -p /run/progressive-cms
chown progressive-cms:progressive-cms /run/progressive-cms
chmod 750 /run/progressive-cms

# --- unit pair (root-owned, like the other operational units) ------------------
for unit in progressive-cms-restart.path progressive-cms-restart.service; do
  src="$ASSETS/systemd/$unit"
  if [[ ! -r $src ]]; then
    log "ERROR: required bridge unit is missing: $src"
    exit 1
  fi
  install -o root -g root -m 644 "$src" "/etc/systemd/system/$unit"
  log "installed ${unit}"
done
systemctl daemon-reload

# The service is started only by the path unit — never enabled at boot.
# A marker left over from before the bridge (nobody served the restart
# request) is picked up on enable, which is exactly what was requested.
systemctl enable --now progressive-cms-restart.path >/dev/null
log "restart bridge active (marker: /run/progressive-cms/restart-requested)"
