# Typed Blocks

Contract owner: Core block registry.

A Block Document envelope is version 1, independently of RichText AST version 2. See [empty](reference/examples/block-document-empty.json) and [nonempty](reference/examples/block-document-v1.json) valid documents. Typed blocks belong to a `block_document` Content Type. Discover the actual block catalogue and per-version schema before authoring. Each block descriptor and its props must match a registered version; arbitrary HTML and invented property names are not a substitute for the contract.

Use stable block identities, preserve references during edits and validate the entire document. RichText properties inside blocks still require strict AST v2. A theme needs a declared renderer for each block it presents.

The public Markdown renderer serializes a supported subset of registered blocks and returns 406 when a page cannot be represented. See [Markdown representations](markdown.md) for the current subset and limitations.

## Blocks supplied by extensions

Discover `/discovery/blocks` on the target instance and use the returned descriptor and props schema. Core block ids keep their existing lowercase `snake_case` grammar (`[a-z][a-z0-9_]{0,63}`). Extension ids use a lowercase dotted namespace such as `shop.listing`, only when that id appears in discovery: `[a-z][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9-]{0,62}){0,9}` with a maximum total length of 200 characters. Do not invent a block because an extension name appears in documentation: the extension must be present in the deployed catalogue and the block must appear in discovery.

An extension registers `block_type` and may provide an object JSON Schema from the supported manifest subset in `props_schema`. If omitted, Core uses an object props schema. Extension blocks use schema version 1 and cannot contain child blocks. A theme renderer key uses `<block_type>@1`, for example `shop.listing@1`; implement the matching renderer in the theme's `blocks/` directory. Duplicate registrations, including collisions with Core block ids, fail closed with `BLOCK_TYPE_EXISTS`.

When sealing a new WORKING revision, every extension that owns a referenced block must be enabled. Otherwise validation reports `BLOCK_EXTENSION_UNAVAILABLE` inside `REVISION_VALIDATION_FAILED`. Core does not re-judge already SEALED revisions after an extension is disabled; an existing revision may continue rendering while its extension artifact remains deployed. Enable and deploy the required extension before creating or sealing content that uses its blocks.

Do not hide material content or card-image state in blocks under a `rich_text` type. Use a declared field for prose or media, or deliberately choose a block document. See [Content Model](content-model.md).

[Documentation index](index.md)
