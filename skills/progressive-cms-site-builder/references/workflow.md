# First site workflow

All references are inside this Skill. Work in a new site-authoring workspace, not in its installed folder. Read only the stage needed now; [operation schemas](api-operations.json) provide the request/security contract for each selected REST route. API paths below are relative to `/api/v1`.

## Connect and plan

The operator supplies `PCMS_API_URL` as the origin without `/api/v1`, plus `PCMS_API_TOKEN`, `PCMS_SITE_KEY` and `PCMS_ENVIRONMENT`. Do not print the token. If `cms` is available:

```sh
cms agent bootstrap --json
cms capabilities --json
cms theme active --json
```

`cms capabilities` is a local compiled permission/contract catalogue. Use bootstrap (or authenticated REST `GET /api/v1/capabilities`) for the connected actor’s effective capabilities; do not confuse the two reports.

Without CLI, use an authorized HTTP client for the same entrypoint:

```sh
curl --fail-with-body "$PCMS_API_URL/api/v1/agent/bootstrap" \
  -H "Authorization: Bearer $PCMS_API_TOKEN" \
  -H "X-PCMS-Site: $PCMS_SITE_KEY" \
  -H "X-PCMS-Environment: $PCMS_ENVIRONMENT"
```

Read `server.cms_version` as `PCMS_CORE_VERSION` for compatibility/validation. Inspect permissions, preview readiness and primary domain. If MCP is configured, list its tools first and use discovered equivalents; REST is the fallback. The actual target version is independent of the Skill version.

Translate the brief into pages, editable types, language, parents, menus and required form delivery. Check `/discovery/content/types`, `/discovery/blocks` and `/discovery/theme` before choosing keys. Use only the page inventory the brief calls for.

## Declare model, then theme

Copy [Content Types](../assets/examples/content-types.json) into the workspace and adapt them without conflicting with existing definitions. Use [content and theme](content-and-theme.md) to choose body formats.

```sh
cms content schema validate --file content-types.json --json
cms content schema apply --file content-types.json --environment "$PCMS_ENVIRONMENT" --yes --json
```

Validate needs `content_schema.propose`, apply needs `content_schema.apply`. Apply is for an authorized schema change and may return `restart_required`; let the operator perform the bounded Web/Worker reload, then rediscover types. Do not continue with stale schemas or use SQL.

Copy the complete [theme starter](../assets/theme-starter/README.md) to a new `theme/` directory. Adapt typography, responsive layout and page composition. Align accepted types/templates with the model. Set `PCMS_CORE_VERSION` from bootstrap, not a development package file.

Local authoring validation needs the release's CMS CLI. In HTTP/MCP-only mode, arrange a validated theme package through the operator; do not skip the theme check or obtain private Core/DB access to bypass that prerequisite.

```sh
cms theme validate ./theme --cms-version "$PCMS_CORE_VERSION" --json
(cd theme && zip -X -r ../company-starter.pcTheme theme.json templates components blocks assets tokens fixtures README.md)
```

Keep `theme.json` at the `.pcTheme` archive root. Install raw bytes with `POST /themes/install`, `Content-Type: application/octet-stream`, and the same authorization/site/environment headers. Installation adds a catalog package. Activate a new id through `POST /theme/activate` with `{"theme_key":"<installed-id>","theme_version":"<installed-version>"}` and `theme.activate`. Confirm `cms theme active --json`; persisted activation overrides the `themes.renderDir` catalog/boot seed. Do not ask the operator to change `themes.renderDir` to activate a theme; ordinary activation does not require a Web restart.

A newer package of an already active same id uses:

```sh
cms theme update-active ./company-starter.pcTheme --environment "$PCMS_ENVIRONMENT" --yes --json
cms theme active --json
```

This needs `theme.write` and `theme.activate`, preserving settings/generation while recording package identity.

Core retains confirmed immutable theme revisions. Read `GET /api/v1/themes/revisions` (`theme.read`) or `cms theme revisions --json`: `theme_generation`, `active_revision_id` and up to 100 active/newest records with revision id, theme id/version, hash and timestamps; no filesystem paths. `GET /themes/active` also exposes `revision_id` (nullable before a baseline exists) and `theme_generation`.

An authorized rollback uses `POST /api/v1/themes/rollback` with `{"revision_id":"<confirmed-site-revision>","expected_generation":0}`; replace 0 with the freshly read **theme_generation**, not settings_generation. CLI: `cms theme rollback <revision-id> --expected-generation <N> --environment <env> --yes --json`. It requires `theme.write` and `theme.activate`, restores snapshot settings and advances lifecycle/settings generations. Stale generation returns 409 `THEME_REVISION_STALE`; absent/unconfirmed/other-site snapshot returns 404; incompatible retained theme returns 422. No reinstall, database restore or Web restart is needed. A newer retained revision may be selected again. Update-active still requires a version newer than the **installed package head**, even after rollback.

The lifecycle prepares immutable files/renderer before a durable PREPARED intent; active pointer, settings and audit confirmation commit together. A failed change restores the prior confirmed renderer/catalog head. Startup/request recovery resolves interrupted operations; an ambiguous COMMIT response is decided from durable state. `THEME_CHANGE_BUSY` is 409 for mutations (503 at the public recovery gate); `THEME_CHANGE_FAILED`/`THEME_RECOVERY_UNAVAILABLE` identify phase/operation without private paths. Re-read served state after a network failure; unavailable authority fails closed. Do not manually edit pointers/files to recover. The former partial state-write failure is superseded by this journaled lifecycle.

Confirmed snapshots remain until an explicitly authorized history cleanup; monitor disk growth. Package uninstall does not prune revisions. Core pins normal rendered HTML asset URLs to `/themes/<id>/revisions/<uuid>/assets/...`; CSS-relative references inherit that base, but opaque JS/absolute CSS can still use active aliases. Check CSS/JS/images, SRI/CSP and open older pages after update/rollback; an old tab is not a fully frozen site snapshot.

History/rollback availability must be checked on the actual installed instance; a baseline compatibility minimum alone does not guarantee subsequent lifecycle additions.
## Clean old theme history

Admin **Theme → Theme history cleanup** (`/admin/#/theme`) previews candidates, lets an authorized operator select individual revisions and requires confirmation before deletion. Read-only access permits preview only. There is also MCP history listing (`cms_list_theme_revisions`) and cleanup (`cms_cleanup_theme_revisions`); MCP rollback is still absent. Installed-package uninstall is a separate operation and does not prune history. There is no automatic pruning of confirmed history.

**Pruning is irreversible:** removed snapshots cannot be rolled back to, and their old revision asset URLs stop working, including in long-open browser tabs. Do not run cleanup as a routine site-building, privacy or SEO step; obtain explicit authorization for this destructive operation and review the candidates. The active renderer/settings, installed catalog, content and routes are preserved.

```sh
cms theme cleanup --dry-run --json
cms theme cleanup --apply --environment <env> --yes --json
cms theme cleanup --apply --keep-last 10 --older-than-days 7 --environment <env> --yes --json
```

The same API token/site/environment context is required. Default is preview. The CLI previews first and sends exactly that preview's candidate IDs and theme_generation; it does not silently retry a stale generation. `--keep-last` is 5–100 (default 5), `--older-than-days` is 1–36500 (default 1). At most 100 candidates are processed; `has_more:true` requires another reviewed batch, not an unlimited deletion loop.

REST `POST /api/v1/themes/revisions/cleanup`, preview (`theme.read`):

```json
{"dry_run":true,"keep_last":5,"older_than_days":1}
```

Apply (`theme.write`), using selected IDs and the actual generation from preview:

```json
{"dry_run":false,"expected_generation":0,"revision_ids":["<selected-revision-uuid>"],"keep_last":5,"older_than_days":1}
```

Zero above is a placeholder for the observed theme_generation, not a guessed settings_generation. Cookie requests require CSRF, including this POST preview. MCP takes the same fields; `dry_run` defaults true and conditional permission changes to theme.write only for `dry_run:false`. Its mutation annotation remains true even for preview; inspect the actual mode and result.

Active, previous-good, newest keep_last confirmed snapshots, those used within the chosen age (at least one day), and PREPARED recovery references are protected. All requested IDs must belong to this site; paths are never accepted. Protected/stale requests fail before the batch starts: 409 THEME_REVISION_PROTECTED / THEME_REVISION_STALE; missing/foreign IDs return 404; invalid input returns 400. Retention settings can only make protection more conservative.

Response fields: `ok`, `dry_run`, `theme_generation`, `keep_last`, `older_than_days`, `retained_count` **before** this request, `candidates` with revision_id/theme_id/package_version/last_used_at/pending_cleanup, `removed`, `pending`, `has_more`. A 200 alone is not deletion success: physical removal failure returns `ok:false`, pending IDs, and CLI exit 7. Re-preview or retry those same explicit IDs with the current valid generation; completed retries do not duplicate audit events.

The common lifecycle lock serializes cleanup and theme changes. A DB marker/audit retires the selected revisions before file deletion; rollback/history/assets already exclude pruned snapshots even when removal is pending. Small journal/FK metadata remains. Additive migration `0004_theme_revision_cleanup` runs through the normal Core update process; it requires no theme/content/config migration. Do not manually remove files or alter DB markers. Feature-detect the installed contract; a baseline Skill compatibility minimum does not guarantee every later lifecycle addition.

## Create content and forms

Read `/forms/field-types`, adapt [contact-form.json](../assets/examples/contact-form.json), then `POST /forms` with `forms.manage_definition`. Store its stable id in the registered form block's `form_definition_id`. Keep consent boolean and preserve honeypot/field types. Do not request lead/submission read/export access.

Adapt [create-page.json](../assets/examples/create-page.json) for assembled sections and [create-news.json](../assets/examples/create-news.json) for editable prose. Set `parent_entry_id` independently from menus. Replace form placeholders before publication. Upload authorized bytes through `POST /media` with `X-PCMS-Filename`; use returned asset identities and inspect optional `media_variant_failures`. A listed preset failed even though the asset was accepted; don't treat its derivative as ready. For a supported raster image, recover missing active-theme variants with `POST /media/<media-id>/variants/regenerate` or MCP `cms_regenerate_media_variants({media_id})`, then check `generated`, `reused` and any remaining failures. This is idempotent and preserves asset identity and source bytes; it requires `media.write`. Set accessible `alt_default` through `PATCH /media/<media-id>` and discover `/discovery/media/presets` before using derivative URLs; never invent a media URL. The generated [API operation snapshot](api-operations.json) has the affected response schemas.

```sh
cms content create --file create-news.json --json
```

Keep returned `entry_id` and `revision_id`. For updates, use the actual WORKING revision's `edit_generation` (draft may reuse an existing WORKING revision):

```sh
cms content draft --entry <entry-id> --json
cms content patch --revision <working-revision-id> --file patch-news.json --expected-generation <generation> --json
```

The [patch example](../assets/examples/patch-news.json) is a shape, not permission to overwrite unrelated content. Reread/reconcile after a generation conflict.

## Preview, seal and publish

`POST /revisions/<revision-id>/validate` with `{}`, fix blockers and inspect the exact revision and SEO preview. Then:

```sh
cms content preview --entity-id <entry-id> --revision <revision-id> --allow-draft --json
cms content seal --revision <revision-id> --expected-generation <generation> --environment "$PCMS_ENVIRONMENT" --yes --json
```

Keep signed preview URLs private. Sealing is immutable and does not publish. For authorized publication with an existing live route, read `GET /publications/entry/<entry-id>` and use its actual generation with:

```http
POST /publications/publish
{"entity_type":"entry","entity_id":"<entry-id>","target_revision_id":"<sealed-revision-id>","expected_generation":0}
```

Zero is only for a never-published entry. Without a live route, direct publish fails PUBLICATION_ROUTE_MISSING. First create `POST /changesets` with `{title:"Publish approved page"}`, add `POST /changesets/<id>/items` with entity_type/entry id, intent PUBLISH, sealed target_revision_id, observed expected_generation and route_operation `{kind:"set",site_id:"<actual-site-id>",path:"/approved-path/"}`. Use actual locale/context where applicable. Preflight the ChangeSet, inspect ok/issues, then authorized apply; create/items/preflight require publication.plan, apply publication.publish. Selected API schemas include all four operations. Resolve public URLs through `/entries/<entry-id>/route`, not slug concatenation. Bind the intended homepage with `POST /entries/<entry-id>/home`.

The REST preview equivalent is `POST /previews` with `{"scope":{"kind":"revision","entity_type":"entry","entity_id":"<entry-id>","revision_id":"<revision-id>","allow_draft":true}}`; other REST lifecycle fields are in the selected operation schema. A generic object schema is not permission to guess missing domain fields.

## Bind navigation and identity

Discover `/discovery/navigation/placements`. Create/seal a set, then bind each required placement:

```http
POST /navigation/sets
{"key":"main","title":"Main navigation"}

POST /navigation/sets/<set-id>/items
{"type":"internal_entry","label":"Services","target":{"entry_id":"<entry-id>"},"at":0}

POST /navigation/sets/<set-id>/seal
{}

PUT /navigation/placements/header.primary
{"navigation_set_id":"<set-id>"}
```

Read current `/settings/site-identity` before updating, preserving unrelated fields. PUT wraps the full updated object as `{"identity":{...}}`; minimal identity needs `site_name`, and optional `default_social_image` is `{"asset_id":"<managed-media-id>"}`. Entry SEO PUT at `/entries/<entry-id>/seo` wraps its fields as `{"document":{"social_image":{"asset_id":"<managed-media-id>"}}}`. Inspect `/discovery/seo/preview?entry_id=<entry-id>`. Breadcrumbs come from published parentage. Social images resolve explicit override → own hero → nearest eligible published ancestor section → site default → absent.

Finish [site and editor checks](checks.md). Provider proof is optional owner-supplied configuration; never invent it or enable maintenance to test analytics.
