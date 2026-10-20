# Typed Blocks

Contract owner: Core block registry.

A Block Document envelope is version 1, independently of RichText AST version 2. See [empty](reference/examples/block-document-empty.json) and [nonempty](reference/examples/block-document-v1.json) valid documents. Typed blocks belong to a `block_document` Content Type. Discover the actual block catalogue and per-version schema before authoring. Each block descriptor and its props must match a registered version; arbitrary HTML and invented property names are not a substitute for the contract.

Use stable block identities, preserve references during edits and validate the entire document. RichText properties inside blocks still require strict AST v2. A theme needs a declared renderer for each block it presents.

Do not hide material content or card-image state in blocks under a `rich_text` type. Use a declared field for prose or media, or deliberately choose a block document. See [Content Model](content-model.md).

[Documentation index](index.md)
