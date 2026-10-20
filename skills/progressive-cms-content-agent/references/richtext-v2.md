# RichText v2 contract

New documents and explicit editor saves use the canonical AST v2. The editor's
Tiptap JSON is private and must never be sent as a CMS payload. Read the
Content Type first and keep `bodyPolicy: rich_text`; tables and images do not
require a different Content Type or Theme.

```json
{
  "type": "document",
  "schema_version": 2,
  "content": [
    { "type": "paragraph", "content": [{ "type": "text", "text": "Intro" }] },
    {
      "type": "table",
      "content": [
        {
          "type": "table_row",
          "content": [
            { "type": "table_cell", "header": "column", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Name", "marks": ["strong"] }] }] },
            { "type": "table_cell", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Value" }] }] }
          ]
        }
      ]
    },
    { "type": "image", "media_id": "01900000-0000-7000-8000-000000000001", "alt": "Alt text", "caption": [{ "type": "text", "text": "Caption" }] },
    { "type": "bullet_list", "content": [{ "type": "list_item", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Item" }] }] }] }
  ]
}
```

Supported document nodes are paragraphs, headings, bullet/ordered lists,
blockquotes, tables, Media Library images, code blocks and horizontal rules.
Inline content supports text, strong/emphasis/code marks, safe links and hard
breaks. Tables must be rectangular (1–50 columns, at most 2,000 rows and
10,000 cells); empty cells are allowed. Only explicit `header: "column"` or
`header: "row"` produces `<th>`. The first row is ordinary data unless its
cells explicitly declare headers. There are no merged/nested cells or
spreadsheet formulas.

An image uses a logical `media_id`, not a derivative URL, and requires an
explicit `alt`; empty alt is allowed only for a deliberate decorative image.
The referenced asset must be an available raster image: the public Media
contract does not expose original image blobs, and SVG has no public RichText
derivative. Captions and table text stay in document order and are searchable.
Core generates safe HTML and responsive table/image fallback. Do not add a
theme renderer or raw HTML.

REST and MCP carry the same canonical object in revision payloads. Markdown is
an exchange format for the supported GFM subset only. Import is all-or-error;
export returns `MARKDOWN_UNREPRESENTABLE` with a JSON path when GFM cannot
preserve a caption, MediaAsset identity, header semantics, or cell structure.
Use the canonical AST through REST/MCP for full round-trip.

## Controlled v1 migration

Core 1.0 is v2-only: every RichText document must declare `schema_version: 2`,
and there is no v1 read path in the running CMS. Migration is therefore an
**offline operator step** performed against the site database before the site is
updated, using `tools/migrations/richtext-v1-to-v2/` (not shipped in any
release). The API endpoint and `cms content richtext migrate` command were
removed by the owner decision `CORE-RICHTEXT-V2-ONLY`.

```sh
node tools/migrations/richtext-v1-to-v2/migrate.mjs --report ./site.json --dry-run
node tools/migrations/richtext-v1-to-v2/migrate.mjs --report ./site.json --apply
node tools/migrations/richtext-v1-to-v2/migrate.mjs --report ./site.json --verify
node tools/migrations/richtext-v1-to-v2/migrate.mjs --report ./site.json --rollback
```

The converter preserves v1 text, order, marks, links, lists and URL images; it
does not invent MediaAsset IDs or mutate sealed revisions. It records a
before-state report (mode-0600, the rollback source), preserves
routes/SEO/publication dates, and never writes a partial entry. Back up the
database first; after apply, run `--verify` and confirm no v1 remains, reindex
Search, compare rendered DOM with the before-state, and keep the report until
acceptance closes the rollback window.

The format migration preserves the revision's `blocks` payload. For a
`bodyPolicy: rich_text` entry, nonempty hidden blocks make the replacement
revision fail validate/seal with `RICH_TEXT_BLOCKS_NOT_RENDERED`; resolve that
content explicitly and save without hidden blocks before applying. Never clear
the block payload merely to make migration pass.

Full contract: `docs/specs/RICHTEXT-V2-MIGRATION.md`.

