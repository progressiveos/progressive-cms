# Content Agent — SEO rules (PCMS-SKILL-T004)

## Discover, don't assume

- Read the site's SEO schema and defaults first: `GET /discovery/seo/schema`
  (MCP: `cms_get_seo_schema`). Field availability, fallbacks and defaults are
  site configuration — never assume a title/description field exists.
- Set explicit metadata where it adds value: `PUT /entries/:entryId/seo`
  (meta title/description, social image by Media ID, canonical only when the
  task explicitly calls for it — `seo.canonical_override` is a separate
  scope).

## Facts only

- Never invent organization, author, review, rating, price, availability or
  business facts — not in visible content, not in metadata, not in
  structured data. If structured data needs a fact the task doesn't provide,
  leave the field out and name the gap in the report.
- Publication pacing is editorial behavior; it does not transform low-value
  content into good content. No SEO-evasion techniques.

## Preview and validate

- Preview the RESOLVED metadata (after site defaults/fallbacks):
  `GET /discovery/seo/preview` — what you preview must be what will render.
- Validate structured data: `GET /discovery/seo/structured-data` and
  `POST /discovery/seo/validate`; JSON-LD must pass validation before the
  revision is sealed. Broken JSON-LD is a blocking issue, not a warning.
- The social/OG image must be a factual, relevant Media ID — never a
  placeholder, never a fabricated URL.
