# Choose editable content and theme composition

Discover Content Types, registered blocks and accepted theme templates first. Reuse a fitting existing type. For a new model, start from [content-types.json](../assets/examples/content-types.json):

| Content | Example type | bodyPolicy | Rendering |
|---|---|---|---|
| Assembled landing/service page | `company_page` | `block_document` | Registered blocks through `blocks_html` |
| Editor-authored news | `company_news` | `rich_text` | Declared RichText body through `body_html` |
| Project/story | `company_project` | `rich_text` | Declared RichText body through `body_html` |

Use `none` when a type needs no body. Keep optional images optional; do not add invisible blocks to obtain a cover or SEO image.

RichText is AST v2: each independent/nested document needs `{"type":"document","schema_version":2,"content":[...]}`. The [full table](../assets/examples/richtext-v2-table.json) preserves headers/caption and is editable in Admin. Block Document is a separate envelope v1 with registered types/props/children: see [block example](../assets/examples/block-document-v1.json). Never stamp version 2 on Block Document. Under `rich_text`, hidden non-empty `payload.blocks` fails validate/seal with `RICH_TEXT_BLOCKS_NOT_RENDERED`.

The [starter theme](../assets/theme-starter/README.md) supplies templates, blocks, header/footer/breadcrumb components, CSS, form JS and synthetic validation fixtures. Adapt it in a separate workspace; it is not the user's finished design. If changing its id, change its asset paths too. Cover every published type with an accepting template; keep `company_page@1`, `company_news@1` and `company_project@1` aligned with the schema.

Use `entry.title`, `entry.fields`, Core-rendered `body_html`/`blocks_html`, discovered `nav` placements, `breadcrumbs` and managed `media` presets. `head_html` preserves authoritative title/canonical/robots/social metadata. Guard absent media/presets. Breadcrumbs reflect Content Tree parents with published localized ancestors; unavailable links render as text. Compose banners from H1, optional media and breadcrumbs; no special Page Hero entity is needed.

The starter puts news/project feeds on its generic page template. Condition them or declare separate templates for the intended landing pages; do not leave both feeds on contacts or every service page. Forms use the returned definition id and supported scalar/consent schema. Revisit renderer conversion when changing field types.

Core validates `payload.blocks` under `block_document`; a `block_document`-typed field has no independent full block-tree revalidation pass. Validate the explicit document and inspect preview/public rendering. Write acceptance alone is not render acceptance.
