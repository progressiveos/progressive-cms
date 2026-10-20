# Theme Developer — Content schema proposal & escalation (PCMS-SKILL-T009)

When a design needs semantic data that the site's Content Model genuinely
does not carry (e.g. a "delivery date" the case-study template must render),
the data must become REAL content-model data — not a hidden hack.

## Forbidden hiding places

- theme settings (magic undocumented keys),
- `data-*` attribute payloads carrying semantics,
- hardcoded values in templates,
- untyped JSON blobs inside a text field,
- CSS/content hacks that merely look like the data.

## Proposal workflow

1. **Verify the current schema first**: `GET /discovery/content/types/:key`
   — check fields, variants and block props; also check Globals and theme
   settings for an existing home. Most "missing fields" are misplaced data.
2. **Write an explicit proposal** (in the run report, and as a file the task
   can attach): content type/key, field name and type, required/optional,
   which templates/blocks consume it.
3. **State compatibility impact**: which existing entries lack the field,
   what the default is, whether old revisions render unchanged.
4. **Define default/migration** for existing content.
5. **Wait for authority**: applying a schema change requires
   `content_schema.apply` — a human-held scope. With
   `content_schema.propose` you may submit the proposal through the CMS
   surface if one is available in the deployment; otherwise the proposal is
   a report section plus a pending question.

Meanwhile: build the theme so it renders the field when present and a sane
fallback when absent (`theme.json` fixtures must include the missing-field
case). The theme must stay valid both before and after the schema change is
applied.

## When it is NOT a schema gap

- One-off visual treatment → theme CSS/template.
- Operational value (phone, logo, CTA anchor) → typed theme setting.
- Behavior (client-side calculation, external embed logic) → theme JS or a
  Site Extension — never a schema field.

A new **Core** block/field-type is an architecture escalation: propose it in
the report for the human owner; never patch Core packages yourself.
