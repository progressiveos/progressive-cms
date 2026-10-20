# Update the active theme through CLI (Core 1.0.0-rc.1+)

Use this flow when the owner authorizes updating the theme that already
renders the site. It uses the running CMS API; no Incus, direct server file
writes, config changes or web restart are required.

1. Bootstrap and check the target and permissions. Set `PCMS_API_URL` and
   `PCMS_API_TOKEN` through the existing secret channel, never put the token
   in command arguments. Preserve the site's `PCMS_SITE_KEY` and
   `PCMS_ENVIRONMENT` bindings where required.
2. Inspect the renderer, not just the installed package catalog:
   `cms theme active --json`. This returns the id and version of the
   in-memory stack that actually serves HTML.
3. Build a `.pcTheme` ZIP containing `theme.json` at its root and the theme's
   contract directories. Keep the active id and increase its version.
   Validate locally with `cms theme validate <theme-dir> --json`.
4. With explicit owner authorization, upload through the CLI:

   ```sh
   cms theme update-active ./pcms-site-v2-2.10.5.pcTheme \
     --environment production --yes --json
   ```

   Required scopes: **theme.write + theme.activate**. Ordinary
   `cms theme install` / `POST /themes/install` continue to reject overwriting
   the active render target. `update-active` cannot switch to another id or
   install an older/equal version.
5. Recheck `cms theme active --json`, the public HTML, CSS/JS URLs and the
   intended behavior in the browser. The successful update response includes
   package SHA-256 and the served id/version. Site acceptance belongs to the
   site agent; package validation alone does not prove visual acceptance.

The canonical REST operations behind these commands are `GET /api/v1/themes/active`
and `POST /api/v1/themes/active/update` (raw ZIP, `application/octet-stream`).

The server validates archive paths, sizes, the Theme Contract, declared Core
compatibility, fixtures and the new stack with the current theme settings
before replacing files. Templates and assets switch from a complete staged
copy; an invalid package, wrong id/version or incompatible settings leaves
the previous theme serving. Existing settings, content, routes and
publication pointers are not rewritten.

## Retained revisions and live rollback

The installed package catalog and the active revision are separate. After
rollback the catalog can contain A2 while A1 is serving. `update-active` still
requires a version newer than the installed head A2. Rollback does not install
an older package and does not require a restart or database restore.

```sh
cms theme active --json
cms theme revisions --json
cms theme rollback <revision-id> --expected-generation <theme_generation> \
  --environment production --yes --json
```

`active` adds `revision_id` (null before the first mutation) and
`theme_generation`. The list returns `theme_generation`, `active_revision_id`
and `revisions`: `revision_id`, `theme_id`, `package_version`, `sha256`,
`created_at`, `activated_at` and `active`. It includes the active revision and
newest retained revisions, at most 100. No storage paths are exposed.

REST: `GET /api/v1/themes/revisions` requires `theme.read`;
`POST /api/v1/themes/rollback` requires `theme.write` + `theme.activate` and
`{"revision_id":"<uuid>","expected_generation":N}`. Cookie clients also need
CSRF. A stale lifecycle generation returns `409 THEME_REVISION_STALE`;
a missing, unconfirmed or other-site revision returns not found. This CAS is
separate from `settings_generation`. Rollback restores the revision's settings
and advances both generations; it can also reselect a newer retained revision.

Existing themes are registered lazily before their first mutation; no package,
manifest, Liquid, configuration or content-model change is required. Confirmed
revisions are immutable and at least five remain available. Automatic cleanup
removes only unpublished snapshots without pointer/journal references. Use the
explicit history cleanup below to reclaim old confirmed files; cleanup failure
does not turn a committed theme change into an error.

Core pins ordinary active-theme HTML URL attributes to immutable asset URLs
under `/themes/<id>/revisions/<revision-id>/assets/`. Existing legacy asset URLs
remain valid and revalidate against the confirmed active revision. CSS-relative
imports/images/fonts inherit the revision URL base. CSS/JS and inline code bytes
are unchanged, preserving SRI and CSP; opaque URLs constructed by scripts or
absolute URLs inside CSS continue through the legacy active alias. An already
open page can therefore load current active assets through those legacy URLs.
Check the actual HTML and assets after rollback, as for an ordinary update.

## Failure recovery

Updates, activation, settings and rollback share a site-scoped lock and durable
operation journal. Complete immutable files and render snapshots are prepared
before the PREPARED intent. The active pointer, settings and audit are confirmed
in one database transaction. Unconfirmed targets are not served by new requests.

Validation/preparation failures keep the confirmed theme. A later failure
restores the prior renderer and, for updates, the previous installed catalog
head. Startup and subsequent requests recover an interrupted intent idempotently.
If a COMMIT reply is lost, durable database state decides whether to keep the
new revision or restore the old one. An unavailable authoritative state fails
closed; do not manually copy files or edit theme pointers.

`THEME_CHANGE_BUSY` means another mutation/recovery holds the lock (409 for a
mutation, retryable 503 while gating public requests). `THEME_CHANGE_FAILED`
and `THEME_RECOVERY_UNAVAILABLE` include the failed `phase` and, where allocated,
`operation_id`; no private paths/settings are returned. Inspect `active` before
retrying after an interrupted response. `THEME_RUNTIME_UNAVAILABLE` means the
API has no public renderer. Wrong package identity/version and incompatible
settings remain rejected through the existing typed validation errors.

## Install, activate and live settings

For another theme ID, first `POST /api/v1/themes/install` with a validated
.pcTheme ZIP (`theme.write`), then `POST /api/v1/theme/activate` with
`{"theme_key":"<installed-id>"}` (`theme.activate`). No config edit or Web
restart is required. Only a direct directory in the native installed catalog
with an installation receipt is accepted; the operator-configured bootstrap
theme is also trusted. Paths, symlink targets, missing/untrusted packages,
incompatible contracts and mismatched requested versions are rejected.
The complete render snapshot is prepared before persisting activation;
`ok=true` means subsequent requests in this Web process serve that theme.
Other Web processes check the persisted generation before rendering; restart
also resumes the persisted installed theme. An API-only context without a
renderer returns `THEME_RUNTIME_UNAVAILABLE`, not successful activation.

A switch carries matching setting keys and resolves defaults for the new
schema. Keys absent from the new schema are not carried into its active bag;
export the prior settings if you need to switch back with the same custom bag.
Invalid matching values reject activation and preserve the previous state.

`GET /api/v1/theme/state` stores the CAS baseline at `settings.generation`.
`PUT /api/v1/theme/settings` takes `{"expected_generation":N,"values":{...}}`;
a stale generation returns `409 THEME_SETTINGS_STALE`. The response includes
`generation` and `applied`. Settings are validated and the entire render
snapshot prepared before the durable intent; the journal confirms files, renderer and CAS state together.
Form/media setting references and token CSS use this same snapshot.
Without a Web renderer, the write is persisted with `applied=false`; Web reads
the new generation on its next request. `settings.applied_generation` is the
local renderer's generation, or null without a renderer. `runtime` describes
the actually served theme; `active` describes persisted activation. A failed
refresh is recovered from the confirmed revision. A small generation/pending-intent
probe runs per request; the stack is rebuilt only when the confirmed state changes.

## Installed package catalog

`cms theme install ./candidate.pcTheme --environment production --yes --json`
uploads a candidate through `POST /api/v1/themes/install` (raw ZIP).
`cms theme uninstall <theme-id> --environment production --yes --json` uses
`DELETE /api/v1/themes/installed/:name`. Both require the same explicit API
URL, token, site/environment context and `theme.write` permission. The server
protects the active theme; uninstall removes only an inactive installed package,
not retained revision history. Use rollback for retained revisions.
`cms theme list` remains an offline catalog of the configured theme root;
use `cms theme active` to inspect the actual renderer.

## Clean old theme history

Admin: **Theme → Theme history cleanup** (`/admin/#/theme`). Check the candidates,
then confirm deletion. Installed-package uninstall and history cleanup are
separate operations. Removing old snapshots is irreversible: rollback and old
revision asset URLs stop working for those snapshots. The current renderer,
settings, installed catalog, content and routes are not changed.

```bash
cms theme cleanup --dry-run --json
cms theme cleanup --apply --environment production --yes --json
# More conservative retention:
cms theme cleanup --apply --keep-last 10 --older-than-days 7 --environment production --yes --json
```

The CLI uses the usual API token/site/environment context. It previews first,
then submits exactly those revision IDs with the preview's `theme_generation`.
There is no silent retry after a stale generation. Default is preview only.
At most 100 candidates are handled per call; repeat when `has_more=true`.

REST: `POST /api/v1/themes/revisions/cleanup` (cookie CSRF required).
Preview requires `theme.read`, apply requires `theme.write`:

```json
{"dry_run":true,"keep_last":5,"older_than_days":1}
```

Apply uses `{"dry_run":false,"expected_generation":N,"revision_ids":["<uuid>"],
"keep_last":5,"older_than_days":1}` with IDs from preview. `keep_last` is 5–100;
`older_than_days` is 1–36500. The active revision, previous good revision, newest
`keep_last` confirmed revisions, recently used files and PREPARED recovery
references are protected regardless of the requested IDs.

MCP: `cms_list_theme_revisions` and `cms_cleanup_theme_revisions` use the same
site-scoped operations and fields. Cleanup defaults to `dry_run=true`; apply
requires explicit IDs/generation, never arbitrary file paths.

The result includes `theme_generation`, policy, `retained_count` (before this
call), candidates with ID/theme/version/last-use time, `removed`, `pending` and
`has_more`. No storage paths or historical settings are disclosed. Protected
IDs return `409 THEME_REVISION_PROTECTED`; stale generation returns
`409 THEME_REVISION_STALE`; missing/other-site IDs return 404.

The lifecycle lock serializes cleanup with activation/settings/update/rollback.
An atomic DB marker and audit retire the snapshots before any file deletion;
the small journal metadata remains for audit and foreign-key integrity. Failed
file removals return `ok=false` and `pending` IDs (CLI exit 7); preview lists them
again, or retry the same IDs/generation. A completed request can be repeated
without duplicate audit events. Pruned revisions disappear from history and
cannot be reactivated, including when physical cleanup still awaits retry.
Schema migration `0004_theme_revision_cleanup` applies normally during Core
updates; no theme, content model or site-config migration is required.
