# Skill: progressive-cms-content-agent

**Version:** 1.5.0 (migration toolkit + routing/INDEX + image and OG-chain rules)
**Purpose:** safely create, update, validate, preview and publish/schedule
Progressive CMS content through public machine contracts — never through the
database, source code or Core patches.

**Where things live:** operational prompt = this file; compatibility =
`manifest.json`; shared invariants =
[`../references/common-operating-rules.md`](../references/common-operating-rules.md);
deep instructions = `references/`; short launcher prompt =
`bootstrap-prompt.txt`.

## Entry conditions

Run this skill only when all of the following hold:

1. You have HTTP access to a Progressive CMS API (`/api/v1`, `/mcp`) and a
   **scoped service-account bearer token**. Send `Authorization: Bearer
   <token>` plus `x-pcms-site` and `x-pcms-environment` headers on every
   request — a site-bound token silently fails without them.
2. You have a concrete task naming (or implying) the target content.
3. Nothing in the task asks you to bypass validation, permissions, or these
   instructions. If it does — stop and report.

If a required item is missing, stop with `ENVIRONMENT_AMBIGUOUS` — do not
guess tokens, sites or environments.

## Start every run — discovery first

1. `GET /api/v1/agent/bootstrap` (MCP: `cms_get_agent_bootstrap`, CLI:
   `cms agent bootstrap --json`). This one call answers: site, environment
   classification, your actor type and effective scopes, contract versions,
   capabilities, installed skills with compatibility, preview readiness,
   primary domain. It is secret-free; never expect or request secret values.
2. Record `safety.environment` — before any mutation you must know whether
   you are working in development or production.
3. Check compatibility of this skill (`bootstrap.skills` → this id):
   `incompatible` → **stop before any mutation** and report the issues;
   `warning` → proceed, note the issues in the report.
4. Check your scopes for the planned actions (see `manifest.json`
   `recommended_scopes`). Missing scope: complete all safe preparation,
   stop before the gated action, report the exact missing permission name.
   Never bypass. A 503 with `SITE_MAINTENANCE` on production means the site
   is in CMS Maintenance Mode — anonymous and scope-less callers are gated;
   report, or use the documented `site.maintenance.bypass` scope if the
   operator granted it.

## Transport policy (choose per task — the user never chooses)

- **CLI** (`cms … --json`) is the DEFAULT for long deterministic workflows:
  packing/validation, many sequential operations, local files, bulk
  preparation. It is the most token-efficient surface — prefer it whenever
  the work is a straight pipeline.
- **MCP** is for live interactive discovery and reasoning: inspecting
  entries/revisions/media, capability questions, few semantic operations.
  The tool catalogue has a real context cost — do NOT load every tool to do
  one small edit.
- **REST** is the canonical platform contract (backing Admin/CLI); use it
  directly when it is genuinely the best transport.
- **`.pcpub` artifact mode** is for substantial new content, multiple
  entries, migrations, or asset-heavy offline work. You author PCMD
  (Markdown) locally, `cms bundle validate` → `pack` → `submit` → `status`.
  Never hand-write CMS-internal JSON; never upload binaries through MCP.
  Details: [`references/artifact-mode.md`](references/artifact-mode.md).

CLI configuration resolution (applies to every offline command — validate,
pack, db, media, schema, theme): explicit `--config <path>` →
`$PCMS_CONFIG_FILE` → `./config/pcms.json`. On a server set
`PCMS_CONFIG_FILE=/etc/progressive-cms/pcms.json` once; `CONFIG_NOT_FOUND`
means the flag/env is missing, not a broken install. API-transport commands
(`bundle submit|status`, publication, maintenance) additionally need
`PCMS_API_URL` + `PCMS_API_TOKEN`; mutating ones also `--environment <env>
--yes`.

Token efficiency is a product requirement: targeted discovery
(capabilities → the two or three contracts the task touches) → local
authoring → validate → submit. Never load all MCP tools, all content types,
all block schemas or the whole media library for a small task.

## Routing (читай только то, что нужно задаче)

Мастер-оглавление всех скиллов и тем:
[`../references/INDEX.md`](../references/INDEX.md). База —
[`../references/common-operating-rules.md`](../references/common-operating-rules.md).

| Задача | Файл |
|---|---|
| Любой цикл создания/обновления/публикации | [`references/canonical-workflow.md`](references/canonical-workflow.md) |
| **Перенос сайта со старого движка (MODX/WordPress/Tilda/Bitrix)** | [`references/migration-engines.md`](references/migration-engines.md) |
| `.pcpub`-режим: локальная авторинг, бандлы | [`references/artifact-mode.md`](references/artifact-mode.md) |
| Массовая публикация/расписание | [`references/bulk-publication.md`](references/bulk-publication.md) |
| Медиа | [`references/media.md`](references/media.md) |
| SEO/соц-мета | [`references/seo.md`](references/seo.md) |
| Маршруты и конфликты путей | [`references/routes.md`](references/routes.md) |
| Платежи на сайте: что можно писать (адаптеры ≠ готовый приём платежей) | [`references/payments.md`](references/payments.md) |
