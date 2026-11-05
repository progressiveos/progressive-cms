# Content Agent — SEO rules

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

## Markdown and discovery (Core 1.0.0-rc.36+)

Markdown uses the published revision, with a paired theme template taking
priority over automatic semantic Core fallback. Keep structured main content
complete; arbitrary unsupported blocks or RichText can produce diagnostic HTTP 406.
Do not remove meaningful content or fabricate summaries merely to get HTTP 200.

Global and individual Markdown settings default on. Read
`GET /api/v1/markdown/settings` and `GET /api/v1/entries/:entryId/markdown`
when troubleshooting; change them only within the authorized task and scopes,
preserving `expected_generation`. Global off hides the individual Admin control
and preserves its saved value. Direct disabled `.md` returns HTTP 404; a canonical
HTML URL accepting only Markdown returns HTTP 406 when disabled, while HTML stays HTTP 200.

Verify both direct `.md` and canonical HTML with `Accept: text/markdown`. The
explicit alternative is noindex; negotiation must preserve HTML canonical robots
policy. Check Vary/Link/canonical, not only body text. `/llms.txt` lists at most
200 proven public documents with titles, optional descriptions, and Markdown links; it
excludes noindex/unpublished/disabled/inactive-locale content. Unsupported Liquid
proof or a bounded dependency failure can exclude an otherwise directly
available document with diagnostics. Never claim discovery completeness from a
single successful request. See [SEO](../../../docs/seo.md) and
[Themes](../../../docs/themes.md).
