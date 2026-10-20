# Content Model

Contract owner: Core content registry.

A Content Type has a stable key, positive integer version, title, declared fields and `bodyPolicy`: `none`, `rich_text` or `block_document`. Keys use lowercase snake_case, up to 64 characters. Schemas affecting serialized data are versioned; a template hint is presentation metadata, not a template binding.

Use the [complete definitions](reference/examples/content-types.json) and [body-format contract](content-contract.md). Declare Content Types before creating entries. With `rich_text`, author content in declared RichText fields; nonempty `payload.blocks` is rejected as `RICH_TEXT_BLOCKS_NOT_RENDERED`. With `block_document`, use registered blocks and validate their descriptors and props.

Nested rich text is validated too. A principal image is an optional declared media field when the model needs it, not a mandatory hidden image block. Content Model and Theme Contract must agree on fields, accepted types and renderers. See [RichText](richtext.md), [Typed Blocks](blocks.md) and [Themes](themes.md).

[Documentation index](index.md)
