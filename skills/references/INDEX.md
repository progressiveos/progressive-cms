# Progressive CMS Skills — Master Index (router)

One entry point for the agent: find the task in the table, read only the
relevant file. The base (invariants, transport, safety) is always in
context — it is short:
[`common-operating-rules.md`](common-operating-rules.md); everything else is
loaded on demand to keep the context clean.

Rule: **do not read references speculatively**. Start with your skill's
SKILL.md (it is thin), then one or two files from the table below.

## Base (always read, short)

| File | Contents |
|---|---|
| [`common-operating-rules.md`](common-operating-rules.md) | safety invariants, transport, tokens, reporting |

## Routes: task → file

| Task | Read |
|---|---|
| Is the skill installed, my scopes, contract versions | `cms agent bootstrap --json` (no files) |
| Create/update/publish content | [`progressive-cms-content-agent/references/canonical-workflow.md`](../progressive-cms-content-agent/references/canonical-workflow.md) |
| **RichText v2, GFM subset, Media Library references, v1 migration** | [`progressive-cms-content-agent/references/richtext-v2.md`](../progressive-cms-content-agent/references/richtext-v2.md) |
| **Contracts and API surface: openapi.json is the FIRST source** (`GET /api/v1/openapi.json`, authorized); discovery routes (`/discovery/*`, `/capabilities`) — machine-readable catalogs | — |
| Content schemas: view, add a type/field (additive) | `cms content schema list/show/validate/apply` (API; `POST /content/schema/validate|apply`) |
| Diff two entry revisions | `GET /api/v1/revisions/{fromId}/diff/{toId}` (`cms` — openapi, operationId `diff_revisions`) |
| **Publish a sealed revision — golden path** (changeset→items→preflight→apply; direct publish without a route = 409) | [`progressive-cms-content-agent/references/canonical-workflow.md`](../progressive-cms-content-agent/references/canonical-workflow.md) |
| **Entry identity locale — политика** (однолокальный сайт = только `default`; `422 LOCALIZATION_LOCALE_NOT_ENABLED`; ревизии наследуют локаль записи) | [`progressive-cms-content-agent/references/canonical-workflow.md`](../progressive-cms-content-agent/references/canonical-workflow.md) |
| Canonical path of an entry | `GET /discovery/content/tree` → `route_path` (or `GET /entries/:id/route`) |
| Remote diagnostics (no shell) | `GET /api/v1/diagnostics` (site.validate) |
| **Migrate a site from a legacy engine (MODX/WordPress/Tilda/Bitrix)** | [`progressive-cms-content-agent/references/migration-engines.md`](../progressive-cms-content-agent/references/migration-engines.md) |
| Media: upload, import by URL, variants and retry failed derivatives | [`progressive-cms-content-agent/references/media.md`](../progressive-cms-content-agent/references/media.md) |
| Entry SEO/social meta | [`progressive-cms-content-agent/references/seo.md`](../progressive-cms-content-agent/references/seo.md) |
| **Does a page need an image? hero_image vs page hero vs social_image; the known OG fallback chain (`social_image → hero_image → site default`)** | [`progressive-cms-content-agent/references/canonical-workflow.md`](../progressive-cms-content-agent/references/canonical-workflow.md) (§ Card illustrations) |
| Site payments: what may be written | [`progressive-cms-content-agent/references/payments.md`](../progressive-cms-content-agent/references/payments.md) |
| Routes, path conflicts, address changes | [`progressive-cms-content-agent/references/routes.md`](../progressive-cms-content-agent/references/routes.md) |
| Bulk publication, time-based plans | [`progressive-cms-content-agent/references/bulk-publication.md`](../progressive-cms-content-agent/references/bulk-publication.md) |
| **Site delivery compliance (MANDATORY per site): cookie banner + Terms of use + Security statement** | [`progressive-cms-content-agent/references/site-delivery-compliance.md`](../progressive-cms-content-agent/references/site-delivery-compliance.md) |
| **Collections: named feeds (news/blog) — theme.json `collections`, scope shape, REST, pagination/tags** | [`progressive-cms-theme-developer/references/collections.md`](../progressive-cms-theme-developer/references/collections.md) |
| **Analytics & tags (agency/operator): providers, network rules, dataLayer v1, doctor** | [`docs/analytics-for-agencies.md`](../../docs/analytics-for-agencies.md) |
| **IndexNow (SEO): site-level toggle, key file, delivery status — platform-owned, themes must not implement it** | `cms_get_indexnow_settings` / `cms_update_indexnow_settings` / `cms_get_indexnow_status` (MCP); spec `docs/specs/Progressive_CMS_IndexNow_v1_Spec.md` |
| `.pcpub` mode (local content authoring) | [`progressive-cms-content-agent/references/artifact-mode.md`](../progressive-cms-content-agent/references/artifact-mode.md) |
| Addressed personal-data correction/block/erase and processor followups | [`progressive-cms-operator/references/personal-data-tools.md`](../progressive-cms-operator/references/personal-data-tools.md) |
| Operations: health, config, extensions, maintenance | [`progressive-cms-operator/references/golden-path.md`](../progressive-cms-operator/references/golden-path.md) |
| **Update an instance from the registry** (`cms registry releases` / `apply --version` — Core 1.0.0-rc.1+) | [`progressive-cms-operator/references/golden-path.md`](../progressive-cms-operator/references/golden-path.md) |
| **Figma design → theme tokens and references** | [`progressive-cms-theme-developer/references/figma-to-theme.md`](../progressive-cms-theme-developer/references/figma-to-theme.md) |
| Theme: scaffold, settings, theme deploy | [`progressive-cms-theme-developer/references/`](../progressive-cms-theme-developer/references/) (design-mapping, schema-escalation) |
| **Update the active theme package through CLI without restart** (Core 1.0.0-rc.1+) | [`progressive-cms-theme-developer/references/active-theme-update.md`](../progressive-cms-theme-developer/references/active-theme-update.md) |
| **Liquid: filters and output semantics (autoescaping, SafeHtml, the newline_to_br trap)** | [`progressive-cms-theme-developer/references/liquid-and-output.md`](../progressive-cms-theme-developer/references/liquid-and-output.md) |
| **Candidate theme preview** (an alternative theme over live content without switching the active one; Core 1.0.0-rc.1+) | [`progressive-cms-theme-developer/references/theme-preview.md`](../progressive-cms-theme-developer/references/theme-preview.md) |
| Theme block variants (block_renderers[].variants) — live: content validation accepts them, discovery lists them | theme.json → `GET /discovery/blocks/:typeId?version=N` → `allowedVariants` |
| **Write a community skill (.pcskill) and publish it** | [`progressive-cms-extension-developer/references/writing-community-skills.md`](../progressive-cms-extension-developer/references/writing-community-skills.md) |
| Write an extension | [`progressive-cms-extension-developer/SKILL.md`](../progressive-cms-extension-developer/SKILL.md) |
| Extension Contract 2.0, SDK, jobs, public mutations and locale routes | [`../../docs/specs/PUBLIC-EXTENSION-CONTRACT.md`](../../docs/specs/PUBLIC-EXTENSION-CONTRACT.md) |
| Build Progressive Shop as a separate extension | [`../../docs/specs/SHOP-DEVELOPER-HANDOFF.md`](../../docs/specs/SHOP-DEVELOPER-HANDOFF.md) |
| Agent web research (fact search/fetch) | [`progressive-cms-web-research/SKILL.md`](../progressive-cms-web-research/SKILL.md) |

## Skills (machine entries)

| Skill | Role |
|---|---|
| [`progressive-cms-operator`](../progressive-cms-operator/SKILL.md) | operating a deployed instance |
| [`progressive-cms-content-agent`](../progressive-cms-content-agent/SKILL.md) | content: creation, publication, migrations |
| [`progressive-cms-theme-developer`](../progressive-cms-theme-developer/SKILL.md) | themes |
| [`progressive-cms-extension-developer`](../progressive-cms-extension-developer/SKILL.md) | extensions |
| [`progressive-cms-web-research`](../progressive-cms-web-research/SKILL.md) | web research |
