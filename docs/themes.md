# Themes, Liquid, layouts and components

Contract owner: Core Theme Contract 1.0, theme manifest v2 and public rendering scope. A theme supplies presentation over declared Content Types; it does not define secret content storage or alter Core.

## Complete minimal authoring example

The delivered [company starter](reference/theme-starter/README.md) includes [theme.json](reference/theme-starter/theme.json), two templates, header/footer/breadcrumb components, heading/text/form renderers, CSS, a contact-form script, tokens and synthetic theme-validation data. It matches the Content Types in [First Site](first-site.md). It is an authoring baseline, not a finished bespoke design or a runtime-accepted website.

```sh
cms theme validate ./theme-starter --cms-version "$PCMS_CORE_VERSION" --json
(cd theme-starter && zip -X -r ../company-starter.pcTheme theme.json templates components blocks assets tokens fixtures README.md)
```

Set `PCMS_CORE_VERSION` to `server.cms_version` from `cms agent bootstrap --json`. Use that real installed version in compatibility decisions. The explicit validator version above exercises the target manifest; it cannot make an old server compatible. theme.json must be at the archive root, not inside an extra folder.

## Public scope and rendering

- `entry.title` and `entry.fields` represent the declared content. `body_html` is Core-rendered RichText; `blocks_html` is the block pipeline. The [Content Contract](content-contract.md) decides which one supplies a body.
- `nav['header.primary'].items` and other declared placements contain resolved navigation items. Do not compute internal URLs from slugs.
- `breadcrumbs` is the Content Tree trail described in [Navigation](navigation.md).
- `media[asset_id]` supplies discovered preset derivatives; guard missing assets/presets. A principal image is optional.
- `collections.<key>` exposes only declared, published feeds on their permitted templates. The sample manifest declares `news`/`projects`; their items supply Core-resolved hrefs and titles.
- `head_html`/Core head composition protects authoritative SEO. Do not replace canonical, robots or OG metadata in a template. A default component layout for Extension views is separate from an entry template.

A banner is ordinary markup/CSS over available H1, background media and breadcrumb data. It has no special Page Hero subsystem or required content entity. RichText tables render through Core and require no theme-specific table renderer.

## Installation and activation boundaries

`POST /api/v1/themes/install` accepts the raw validated package as `application/octet-stream` with `theme.write`. For a scoped service-account token, use the configured origin (without `/api/v1`) and authorized site/environment:

```sh
curl --fail-with-body "$PCMS_API_URL/api/v1/themes/install" \
  -H "Authorization: Bearer $PCMS_API_TOKEN" \
  -H "X-PCMS-Site: $PCMS_SITE_KEY" \
  -H "X-PCMS-Environment: $PCMS_ENVIRONMENT" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @company-starter.pcTheme
```

The route also accepts JSON `{"download_url":"<authorized-artifact-url>"}` for a repository artifact. The CLI equivalent is `cms theme install <file.pcTheme> --environment <env> --yes --json` with API/site/environment context and `theme.write`; `cms theme uninstall <id> --environment <env> --yes --json` removes only an inactive catalog package, preserving history. Installation only adds the package to the theme catalog. `themes.renderDir` is the configured catalog/boot seed; it is not the persistent active-theme selector. Once `admin_theme_state.theme_key` is set, that persisted activation chooses the theme served by the renderer and takes precedence over the configured path. To activate a newly installed id, call `POST /api/v1/theme/activate` with `{"theme_key":"<installed-id>","theme_version":"<installed-version>"}` and the `theme.activate` permission. Confirm the result with `cms theme active --json`; this activation does not require changing `themes.renderDir` or restarting Web.

The starter places news/project feeds on its generic page template. For the brief, place or condition those includes on the intended landing pages, or declare separate accepting templates and collections in `theme.json`; do not leave both feeds on every service/documentation/contact page. Validate that final composition, not just the unmodified starter.

For an active same-id theme, prepare a newer package and use:

```sh
cms theme active --json
cms theme update-active ./company-starter.pcTheme --environment qa --yes --json
cms theme active --json
```

The task needs `theme.write` and `theme.activate`. On success, Core records the installed `theme_key` and `theme_version` in `admin_theme_state`; when updating the existing row, it leaves `settings` and `settings_generation` unchanged. Wrong id, non-newer version or incompatible settings fail without replacing the served theme. Do not overwrite an active directory via `cms theme install`.

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

## Acceptance

Cover every published type with an accepting template. Validate the theme, then validate the real site and editor workflow. Check desktop/mobile placements, deeper breadcrumbs, no-image prose, the table example, published feeds, card covers with confirmed media sources and a synthetic contact submission. Source-level validation is not installed or browser acceptance.

[Documentation index](index.md)
