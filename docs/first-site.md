# First Site: executable authoring route

Contract owners: content schema, theme lifecycle, public API and publication. This route connects to an already installed authorized QA instance. [Installation](installation.md) is a separate privileged workflow; do not give a content agent unrestricted root or DB access.

## 1. Establish the target

The operator supplies `PCMS_API_URL` (the origin, such as `https://cms.example.com`, without `/api/v1`; CLI adds that prefix), a scoped `PCMS_API_TOKEN`, `PCMS_SITE_KEY` and `PCMS_ENVIRONMENT` through the approved secret channel. Never put the token into a committed script or transcript.

```sh
cms agent bootstrap --json
cms capabilities --json
cms theme active --json
```

`cms capabilities` is a local compiled permission/contract catalogue. Use bootstrap (or authenticated REST `GET /api/v1/capabilities`) for the connected actor’s effective capabilities; do not confuse the two reports.

For a remote agent, check `/health/live` and `/health/ready` on the supplied origin and request scoped `GET /api/v1/system/status` where permitted. `cms doctor` is a local installed-operator diagnostic, not an API-only client command; arrange a secret-free, build-pinned doctor result or bounded local invocation rather than giving the authoring agent DB credentials.

Check target identity, permissions, actual version, publication/preview readiness and [public Skills delivery](agent-skills.md). Discovery responses are the current server contract, not a licence to guess missing shapes.

## 2. Declare Content Types

Download [content-types.json](reference/examples/content-types.json) to the agent workspace. These definitions create `company_page`, `company_news` and `company_project`; discover existing types first to avoid conflicting definitions.

```sh
cms content schema validate --file content-types.json --json
cms content schema apply --file content-types.json --environment qa --yes --json
```

Replace `qa` with the explicitly authorized environment. `--file` is required; a bare positional file is not accepted here. Apply needs `content_schema.apply`, validate needs `content_schema.propose`. Apply persists additive overrides and returns `restart_required`. If true, the operator must perform the bounded Web+Worker restart before continuing. This is an explicit setup dependency, not a secret SQL step. Rediscover effective types after restart.

## 3. Install and activate the theme

Use [Themes](themes.md) and its delivered Liquid/manifest examples. Declare accepted type keys and templates before creating entries. Copy the starter into a writable `company-starter/` workspace. Package `theme.json` at the archive root, validate against `server.cms_version`, and install with the scoped CLI:

```sh
cms theme validate ./company-starter --cms-version "$PCMS_CORE_VERSION" --json
(cd company-starter && zip -X -r ../company-starter.pcTheme theme.json templates components blocks assets tokens fixtures README.md)
cms theme install ./company-starter.pcTheme --environment "$PCMS_ENVIRONMENT" --yes --json
```

Activate the installed theme through Admin or the documented REST operation:

```sh
curl --fail-with-body "$PCMS_API_URL/api/v1/theme/activate" \
  -H "Authorization: Bearer $PCMS_API_TOKEN" \
  -H "X-PCMS-Site: $PCMS_SITE_KEY" \
  -H "X-PCMS-Environment: $PCMS_ENVIRONMENT" \
  -H 'Content-Type: application/json' \
  --data '{"theme_key":"company-starter","theme_version":"1.0.0"}'
cms theme active --json
```

Activation needs `theme.activate`; installation needs `theme.write`. The persistent active theme overrides `themes.renderDir`, which supplies the catalog/boot seed. Do not change that setting to switch themes; ordinary activation does not require a Web restart. If the Content Type change above returned `restart_required`, complete that bounded Web/Worker reload before authoring.

Set page sections and parentage deliberately. Use `company_page` for assembled sections; use `company_news`/`company_project` for editor-authored prose. Keep images optional. [Content Contract](content-contract.md) provides valid v2 RichText and v1 Block Document examples.

If the site needs news/project lists, declare and scope them as theme collections rather than hard-coding URLs or queries. Follow [Published feeds and related-content cards](collections.md); keep feed templates limited to the pages intended to show those cards.

Create the contact form first using [the complete example](reference/examples/contact-form.json), then insert the returned form definition id into a discovered form block. Build your design, header/footer, desktop/mobile menus and page banner with ordinary theme composition.

## 4. Create and publish

Save [create-news.json](reference/examples/create-news.json) and [create-page.json](reference/examples/create-page.json), adjusting template keys only to accepted templates in your active theme.

```sh
cms content create --file create-news.json --json
```

Record the returned entry and revision ids. Continue with [Publishing](publishing.md): validate, preview, seal, publish and verify. For edits, use the fresh draft and CAS generation workflow; never patch a SEALED revision.

Create the homepage, services and child pages, two news items, projects and a child project, image-free documentation and contacts. Parent links supply breadcrumbs/SEO inheritance; menu placement bindings supply navigation. Assign homepage through `POST /api/v1/entries/<home-entry-id>/home` and set Site Identity through its API.

## 5. Handoff to an editor

After the first publish, check `cms search status`. If `reindex_required:true` or the index version differs from the expected version, have an authorized operator with `search.reindex` run `cms search reindex --environment "$PCMS_ENVIRONMENT" --yes`; wait for reindex completion, then verify a distinctive query and rerun `cms doctor`. Do not add this heavy permission to the content-authoring token or reindex after ordinary edits. See [Search](search.md).

Check public HTML, all routes, search, media derivatives, forms, four SEO cases, three viewport sizes and the [Admin editor journey](admin.md). The editor must save, preview, seal and publish a new revision without special scripts or database access. Keep the URL list and validation results, with no tokens or personal submission data.

[Documentation index](index.md)
