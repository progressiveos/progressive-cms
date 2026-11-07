# Choose editable content and theme composition

Discover Content Types, registered blocks and accepted theme templates first. Reuse a fitting existing type. For extension blocks, take the id and props schema from `/discovery/blocks`; use the namespaced id's `@1` renderer only when that trusted extension is deployed and enabled. If the block is absent, ask the operator for the approved signed compiled package; this Skill does not build or upload extension source. For a new model, start from [content-types.json](../assets/examples/content-types.json):

| Content | Example type | bodyPolicy | Rendering |
|---|---|---|---|
| Assembled landing/service page | `company_page` | `block_document` | Registered blocks through `blocks_html` |
| Editor-authored news | `company_news` | `rich_text` | Declared RichText body through `body_html` |
| Project/story | `company_project` | `rich_text` | Declared RichText body through `body_html` |

Use `none` when a type needs no body. Keep optional images optional; do not add invisible blocks to obtain a cover or SEO image.

RichText is AST v2: each independent/nested document needs `{"type":"document","schema_version":2,"content":[...]}`. The [full table](../assets/examples/richtext-v2-table.json) preserves headers/caption and is editable in Admin. Block Document is a separate envelope v1 with registered types/props/children: see [block example](../assets/examples/block-document-v1.json). Every block `id` must be a canonical lowercase UUIDv7; keep it stable when editing that block. Never stamp version 2 on Block Document. Under `rich_text`, hidden non-empty `payload.blocks` fails validate/seal with `RICH_TEXT_BLOCKS_NOT_RENDERED`.

The [starter theme](../assets/theme-starter/README.md) supplies templates, blocks, header/footer/breadcrumb components, CSS, form JS and synthetic validation fixtures. Adapt it in a separate workspace; it is not the user's finished design. If changing its id, change its asset paths too. Cover every published type with an accepting template; keep `company_page@1`, `company_news@1` and `company_project@1` aligned with the schema.

Use `entry.title`, `entry.fields`, Core-rendered `body_html`/`blocks_html`, discovered `nav` placements, `breadcrumbs` and managed `media` presets. `head_html` preserves authoritative title/canonical/robots/social metadata. Guard absent media/presets. Breadcrumbs reflect Content Tree parents with published localized ancestors; unavailable links render as text. Compose banners from H1, optional media and breadcrumbs; no special Page Hero entity is needed.

The starter puts news/project feeds on its generic page template. Condition them or declare separate templates for the intended landing pages; do not leave both feeds on contacts or every service page. Use the [collections reference](collections.md) for feed scope, ordering, card projection and `related_content` options. Forms use the returned definition id and supported scalar/consent schema. Revisit renderer conversion when changing field types.

Core validates `payload.blocks` under `block_document`; a `block_document`-typed field has no independent full block-tree revalidation pass. Validate the explicit document and inspect preview/public rendering. Write acceptance alone is not render acceptance.

## Markdown output for published pages

Markdown is a second representation of the selected published revision. Core supplies a fallback if a template has no paired Markdown file; new themes should add `markdown_file` to the HTML template manifest entry. A paired file can use `entry.title`, `entry.fields.<field>_markdown`, `body_markdown`, `blocks_markdown` and `fallback_markdown`; use `blocks_markdown` for Block Document content and `body_markdown` for RichText bodies.

The optional `markdown_contract` uses `version: 1` and unique `dependencies` with the dotted paths actually read by the Liquid template and its partials. This declaration is statically checked; it does not turn availability on. Keep the paired template within the analyzer's bounded Liquid subset and preserve Markdown projections when they are meant to prove substantive content. A title or H1 alone is not content. The starter contains a page and article example.
