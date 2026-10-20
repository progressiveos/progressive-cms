# Skill: progressive-cms-theme-developer

**Version:** 1.3.0 (active-theme CLI update) (PCMS-SKILL-T007; PCMS-PCPUB E10 transport policy)
**Purpose:** adapt a design (static HTML/CSS, Astro/Tailwind site, Figma
export, legacy template) into a **human-maintainable Progressive CMS Theme**
using the Git working tree, public Theme Contract and machine discovery —
never by patching CMS Core.

**Where things live:** operational prompt = this file; compatibility =
`manifest.json`; shared invariants =
[`../references/common-operating-rules.md`](../references/common-operating-rules.md);
deep instructions = `references/`; short launcher prompt =
`bootstrap-prompt.txt`.


## Routing

Мастер-оглавление всех скиллов и тем (читай только нужное):
[`../references/INDEX.md`](../references/INDEX.md). База:
[`../references/common-operating-rules.md`](../references/common-operating-rules.md).

| Задача | Файл |
|---|---|
| Дизайн из Figma → токены + PNG-референсы темы | [`references/figma-to-theme.md`](references/figma-to-theme.md) |
| Обновить пакет активной темы через CLI без рестарта | [`references/active-theme-update.md`](references/active-theme-update.md) |
| Общая оболочка для Extension views | [`references/extension-view-layout.md`](references/extension-view-layout.md) |

## Entry conditions

1. You have a Git working tree containing the CMS project (themes live under
   `themes/<theme-id>/`) and CLI access (`cms theme validate`, `cms site
   validate`, machine discovery over REST).
2. You have a design reference (static site export, HTML/CSS, screenshots or
   a Figma-derived implementation) and a task.
3. You hold a scoped token with at least the manifest's
   `minimum_capabilities` (`theme.read`, `theme.write`, `site.validate`).
4. Nothing in the task asks you to modify CMS Core packages, apply
   migrations, or touch the database. If it does — stop and report.

## Start every run — discovery first

1. Bootstrap: `GET /api/v1/agent/bootstrap` (`cms agent bootstrap --json`).
   Record site, `safety.environment`, your scopes, contract versions.
2. Theme Contract: check `contracts.theme_contract` against your target —
   the contract version your theme declares (`theme.json.theme_contract`)
   must satisfy it. `incompatible` → **stop before writing any code** and
   report; `warning` → proceed and note it.
3. Discover the semantic model you are dressing — read only what the task
   needs: content types (`GET /discovery/content/types`), block types
   (`GET /discovery/blocks`), navigation placements
   (`GET /discovery/navigation/placements`), media presets
   (`GET /discovery/media/presets`), theme settings schema and active theme
   state (`GET /theme/state`, `GET /discovery/theme`).
4. Read public contract documentation (`docs/specs/
   Progressive_CMS_Theme_Contract_v1_Spec.md`) and — if the task permits — an
   existing reference theme as a contract example. **Do not** reconstruct the
   contract by reading Core implementation files (`packages/*` internals);
   that is contract archaeology and counts as an eval violation.

## Transport policy

**CLI + local Git/files are the default implementation path**: inspect the
reference material locally, implement the theme in the working tree, run
`cms theme validate` / `cms site validate` offline. **MCP** is for live
contract discovery and inspection when a running CMS is available. **REST**
is the canonical remote contract behind both. High-level requests like
"use this reference HTML/site and build a Progressive CMS theme" are valid:
inspect reference → infer design → inspect PCMS contracts (discovery-first)
→ implement → fixtures → validate → preview → visual checks. A generic web
fetcher is NOT part of this skill; ask the user for local reference
material when the target is a remote site.

## Canonical workflow

1. **Inventory the design**: shell, header, footer, page templates, cards,
   content blocks, navigation (incl. mobile state), forms, assets,
   hardcoded content, interactive behavior, responsive states.
2. **Semantic mapping** — follow
   [`references/design-mapping.md`](references/design-mapping.md):
   presentation → Theme; semantic content → Content Model; site-wide
   structured content → Globals; navigation → Navigation model; forms →
   Forms subsystem (View Models only); behavior → Site Extension if truly
   needed. Hardcoded client content does not go into the theme.
3. **Scaffold the theme** in `themes/<theme-id>/`: `theme.json` (id, name,
   `theme_contract`, templates, components, block_renderers,
   navigation_placements, media_presets, settings_schema, assets).
4. **Implement templates/components** with readable names; replace hardcoded
   content with CMS bindings (entry fields, blocks, placements, settings).
5. **Implement every declared block renderer** — a template that can receive
   a block type it cannot render is a defect; add fixtures for each renderer.
6. **Design tokens + typed settings** — colors/typography/spacing/breakpoints
   as tokens; site-operational values (logo, phone, CTA anchors) as typed
   settings with a documented schema. No secrets in theme assets, ever.
7. **Media presets** declared in `theme.json` — never hand-built transform
   URLs.
8. **Fixtures** — create edge-case fixtures: long/short titles, missing
   optional hero, many cards, multiple CTAs, gallery, calculator, map,
   timeline, documents, forms, nested desktop/mobile navigation.
9. **Validate**: `cms theme validate themes/<theme-id> --json` — fix all
   blocking diagnostics; then `cms site validate --json`.
10. **Preview** the candidate theme and run Playwright responsive +
    accessibility checks (mobile/tablet/desktop). Fix and re-run.
11. **Human maintainability gate (T010)**: write/update `THEME.md` —
    theme structure, tokens, header/footer, buttons, page templates, block
    renderers, media presets, settings, fixtures, common changes, build &
    validation. Update `CHANGELOG.md`. Test: can a normal frontend developer
    change the primary color / button radius / header variant using THEME.md
    alone, without Core knowledge? If not, the theme is not done.
12. **Activation** — never activate unless the task explicitly authorizes it
    AND the token holds `theme.activate`. Default outcome is a validated
    candidate + report; activation is a separate human decision
    (`SECURITY_ACTIVATION` level).

## Escalation ladder (never "patch Core")

- Do not use emoji in a theme, interface or content example. Use the local
  icon set for pictograms and suitable image assets for illustrations.

For a site-specific visual need, in order:

1. existing field/block variant;
2. existing Theme component;
3. theme-specific presentation (CSS/template) — including one-off visual
   treatments; do **not** invent a Core block for a one-off;
4. Site Extension if there is real behavior;
5. explicit schema proposal if semantic data is genuinely missing — see
   [`references/schema-escalation.md`](references/schema-escalation.md)
   (`content_schema.apply` stays with humans);
6. new Core contract only after an explicit architecture escalation to the
   human owner.

## Error handling

Classification and responses are in common rules §10. Theme-specific notes:

- `theme validate` failures are VALIDATION — fix the reported contract
  issue; never weaken the theme manifest to pass.
- `site validate` failures — inspect whether it is your theme or a
  pre-existing site problem; fix only your side, report the rest.
- Missing `theme.activate` on an activation task is AUTHORIZATION — the
  candidate remains valid and valuable; report the exact missing permission.

## Completion report

End with a report valid against
[`skills/schemas/agent-run-report-v1.schema.json`](../schemas/agent-run-report-v1.schema.json):
target, actor, task, changed files, schema proposal (if any), validation
gates, preview/test results, activation state (expected: `none` or
`blocked_by_permission`), warnings, remaining human action. No secrets.
