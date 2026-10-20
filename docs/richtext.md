# RichText AST v2

Contract owner: Core content and trusted renderer.

Every document requires `type: document`, `schema_version: 2` and a content array. This applies independently to documents nested in fields, repeaters and block properties.

```json
{"type":"document","schema_version":2,"content":[{"type":"paragraph","content":[{"type":"text","text":"Hello","marks":[]}]}]}
```

The node vocabulary is document, paragraph, heading, bullet_list, ordered_list, list_item, blockquote, image, text, hard_break, link, table, table_row, table_cell, code_block and horizontal_rule. Marks are strong, emphasis and code. Validation rejects unknown properties and unsafe link schemes. Limits are 10,000 nodes and depth 32.

Images reference MediaAsset identity with `media_id` and mandatory `alt`. Tables use explicit cell/header structure, not inferred first-row semantics; ragged rows and unsupported spans fail validation. Core renders tables and supplies the rich-text presentation assets; themes do not need a table template.

Markdown is an exchange subset, not canonical storage. Lossy export fails with `MARKDOWN_UNREPRESENTABLE`. Historical RichText v1 conversion is an offline tool, outside the runtime release. Block Document v1 is a separate, current contract and must not be converted merely because its envelope says version 1. See [the complete body-format contract](content-contract.md) and [the table example](reference/examples/richtext-v2-table.json).

[Documentation index](index.md)
