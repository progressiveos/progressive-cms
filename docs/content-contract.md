# Content Contract: two independent body formats

Contract owner: Core content, blocks, Web rendering and extraction. Adapted from the accepted Content Contract (see [historical provenance](compatibility.md)); the format is determined by the effective Content Type and declared field type, never guessed from JSON.

| Contract | Version | Where it belongs | Rendered output |
|---|---|---|---|
| RichText | AST v2, `schema_version: 2` inside each document | A declared `rich_text` field; optional `payload.body` under `rich_text` policy | `body_html` and declared `<field>_html` |
| Block Document | Envelope v1, `schema_version: 1` | `payload.blocks` under `block_document`; optional `block_document` field | `blocks_html` |

A valid empty Block Document is:

```json
{"blocks":[],"schema_version":1}
```

It is **not RichText v1**. Do not change its version to 2. A RichText document instead starts with:

```json
{"type":"document","schema_version":2,"content":[{"type":"paragraph","content":[{"type":"text","text":"Hello"}]}]}
```

Download the [full RichText table](reference/examples/richtext-v2-table.json), [nonempty typed blocks](reference/examples/block-document-v1.json) and [empty Block Document](reference/examples/block-document-empty.json). The two documents are tested with their respective Core validators. Every nested RichText document needs its own version marker. Table cells contain their allowed blocks; a cell itself is not another document root.

## Content policy and validation

- `none`: no body.
- `rich_text`: content belongs in declared RichText fields, optionally top-level `payload.body`. Nonempty hidden `payload.blocks` on a new WORKING revision fails validate/seal with `RICH_TEXT_BLOCKS_NOT_RENDERED`. Historical SEALED revisions are not retroactively rejected.
- `block_document`: use registered block types, versions, props, variants and child policies. Discover the actual registry before authoring.

A missing/empty optional body renders nothing. The renderer applies strict v2 validation to present RichText; retiring v1 does not retire Block Document v1. Block Document uses its own decoding pipeline; it must not be sent through the strict RichText reader and fail public rendering with `THEME_RICHTEXT_INVALID`.

### Current field-validation limit

Core validates the block tree in `payload.blocks` for `bodyPolicy: block_document`. It does **not** independently revalidate a `block_document`-typed field as a block tree. Do not promise that stricter field validation. Use the declared body pipeline, validate the explicit Block Document and check public/preview rendering. No manual database repair is part of the workflow.

## Model before content

Use [the complete definitions example](reference/examples/content-types.json). It deliberately uses new company-specific keys, leaving existing types alone. `hero_image` is optional on all three types. News/projects use rich text; assembled pages use Block Document. Templates must explicitly accept `company_page@1`, `company_news@1` and `company_project@1` as appropriate. Read [First Site](first-site.md) for the exact `--file` syntax and restart boundary.

[Documentation index](index.md)
