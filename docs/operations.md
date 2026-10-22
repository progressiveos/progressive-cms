# Operations

Contract owner: Core operations and deployment scripts.

Check `cms doctor`, `cms info` and service logs before changing configuration in an authorized installed-operator context. Remote clients can check `/health/live` (process liveness), `/health/ready` (dependency readiness: 200 ready or 503 not_ready) and scoped `/api/v1/system/status`; public health bodies intentionally contain no secret/configuration diagnostics. Distinguish Web, Worker, database, proxy, outbox and provider failures. Keep secrets and access tokens out of diagnostic exports.

The standard deployment includes backup and restore scripts. A backup set contains a database dump, media and configuration/release metadata with checksums; secret values are a separate recovery responsibility. Private backup sets and manifests are never public documentation assets. Restore rehearsals use disposable targets and must verify database/media consistency.

Upgrade through the supported update workflow and approved artifact. Preflight, backup, migration, service restart and doctor are distinct gates. A database-incompatible rollback may require restoring the corresponding backup; switching a symlink alone is not sufficient.

Troubleshooting: check proxy trust for `API_ORIGIN_MISMATCH`, actor scopes for authorization failures, generation conflicts for stale edits, and Worker/index status for missing search results. Candidate install/backup/restore acceptance remains pending.

## Backup, restore and upgrade procedure boundaries

The standard install supplies backup-site.sh and restore-site.sh as operator tools. The backup contains database/media and secret-free configuration/release metadata with per-file checksums; retain actual secret material through the separately protected recovery process. Backup sets and manifests are private operator data and never belong in the public documentation folder.

Rehearse restore into a fresh disposable database and scratch media root using the restore script's explicit backup/host/db/user/media options. Verify checksums, migration ledger compatibility, restored media, service configuration and a usable application. Restoring a dump is not production acceptance; do not target the live database as a documentation test.

For upgrades, use approved release metadata through the supported updater: preflight → backup → install/migrate → restart → doctor → public/Admin verification. Read rollback policy: rollback_safe can permit switching to a prior immutable release, while restore_required needs the corresponding database recovery plan. A content revision rollback is unrelated. Keep Web/Worker logs and request ids without credentials.

Release ZIPs use explicit Unix modes: regular files `0644`, executables `0755`, and directories `0755`. The final ZIP gate rejects incomplete permission inventories and noncanonical modes; do not chmod or repack a rejected artifact. The installer normalizes the installed immutable tree to `root:<service-user>` with directories/executables `0750` and regular files `0640`, then checks required runtime files and the full tree as the actual service user before switching `current`. If this access check fails, the new release is not activated and `current` stays unchanged.

If deployment verification fails after activation but before database migrations, the existing privileged recovery path can restore the previous release only after its root-owned receipt matches the request and `current` still points to the failed target. A mismatch fails closed. This bounded recovery does not reverse database migrations and is not a general binary rollback: after migrations begin, follow the release's `rollback_safe`/`restore_required` policy and the corresponding database/media backup plan. Do not switch `current` manually.

## Runtime version ordering

Registry updates (`POST /api/v1/registry/apply-update`) and manual release ZIP uploads (`POST /api/v1/registry/release-upload`) compare the candidate's full SemVer against the running runtime, including prerelease precedence. Only a strictly newer version is accepted; the same or an older version returns `UPDATE_NOT_AN_UPGRADE` with HTTP 409. A prerelease may update to a higher prerelease of the same version tuple; stable `1.0.0` cannot be downgraded to any `1.0.0-rc.N`.

Core reads the runtime version from its active composition; it does not infer it from a release id. If that identity is unavailable, invalid or the placeholder `0.0.0`, update requests and `GET /api/v1/registry/update-status` fail with `UPDATE_RUNTIME_VERSION_INVALID` and HTTP 409. A valid status response reports `current_version` and the latest update record, or `null` if none exists; a record includes status and from/to versions. When an asynchronous apply returns `RUNNING`, poll this endpoint for its recorded outcome.

For explicitly authorized theme-history cleanup, preview before deletion and inspect protection, generation and pending retries. Pruning breaks old revision asset URLs and cannot be undone; see [theme cleanup](themes.md).

For [addressed personal-data tools](personal-data-tools.md), update Web and all Workers before use; migration 0005_interaction_privacy is additive and needs no Theme/content schema migration. Retain case IDs and reconcile later actions before serving a restored old backup. Recipient/export/backup handling stays with the owner; receipts do not certify remote deletion.

[Documentation index](index.md)
