# Canonical workflow and supplied references

1. Read the exact entry and effective type/schema. Use `cms content revision current <entry-id> --json` to get the publication pointer and complete current revision; use `cms content revision show <revision-id> --json` for a specific historical revision. These reads require `publication.read`. `parent_revision_id` is nullable provenance on the full revision, not a live publication pointer.
2. Open a WORKING draft from the chosen published revision with `cms content draft --entry <entry-id> --from-revision <revision-id> --json` when appropriate. The mutation requires `content.edit`; inspect `created` and `base_revision_id`. If a WORKING revision already exists, Core returns it unchanged rather than rebasing it. Patch with its actual `edit_generation`, and reread/reconcile on a CAS conflict.
3. Validate all declared fields/blocks and nested documents. Inspect the exact preview and resolved SEO.
4. Seal only a valid revision. Read the publication generation, then publish/plan only within task authorization.
5. Verify public body/metadata/media/Search. Preserve the published revision during cleanup and check the human editing lifecycle.

Read these files from the installed `docs/` folder; no private Core workspace is needed.

- [publishing](../../../publishing.md)
- [content-contract](../../../content-contract.md)
- [richtext](../../../richtext.md)
- [blocks](../../../blocks.md)
- [media](../../../media.md)
- [seo](../../../seo.md)
- [search](../../../search.md)
- [admin](../../../admin.md)

Examples: [Content Type definitions](../../../reference/examples/content-types.json), [RichText table](../../../reference/examples/richtext-v2-table.json), [Block Document](../../../reference/examples/block-document-v1.json), [create news](../../../reference/examples/create-news.json), [contact form](../../../reference/examples/contact-form.json).
