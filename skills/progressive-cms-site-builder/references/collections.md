# Build a published content feed

Use this reference when a site needs news, projects, related articles or another published-card list. Feeds use current published revisions and canonical routes for the active site/locale; drafts, archived, unrouted and other-locale entries are absent.

## Declare a theme collection

Add a binding in `theme.json` and restrict it to templates that should receive it:

```json
{
  "collections": {
    "news": {
      "content_types": ["company_news"],
      "page_size": 12,
      "section": "subtree",
      "tag_field": "tags",
      "order": { "by": "published_at", "direction": "desc" },
      "templates": ["home"]
    }
  }
}
```

The binding needs 1–10 registered type keys; page size is 1–100 (default 12), with `tags` as the default tag field. `section` defaults to `self` (direct children of the rendered page); `subtree` includes descendants but not the page itself; `site` spans the site/locale. `order.by` may be `published_at` or a declared integer field. Without `templates`, no template receives `collections.news`; use a dedicated landing template if only the home page should show the feed.

Within a declared template, each feed item has Core-resolved `href`, `title`, `description`, `teaser`, `date`, `tags`, `image` and `image_alt`. Collection bindings do not project arbitrary content fields. Use returned routes and image values; do not construct URLs or guess media paths. A missing `card` derivative gives a null image.

## Related-content blocks

`related_content@1` supports `manual` (`entry_ids`), `collection` (`collection_key`) and `hybrid` (both) modes. Hybrid keeps valid pinned ids first, then fills from the collection without duplicates. `limit` caps output at 100; collection mode defaults to binding `page_size`/12, manual mode returns valid pins up to 100. Only published and routed entries appear.

Optional props are `scope` (`section`, `subtree`, `site`; default `section`), `content_types` (collection/hybrid override), `order`, `exclude_entry_ids`, `fields`, `image_field` (declared media field; default `hero_image`) and `image_preset` (theme preset; default `card`). Field ordering must use an integer field. Order resolves block → binding → publication date descending. `fields` projects only declared values and the aliases `title`, `description`, `image`, `published_at`; it never exposes raw AST/HTML or storage keys. Validate/seal the revision and resolve collection, field, type and preset errors before publishing.

The anonymous REST feed is `GET /api/v1/collections/{key}/items` with optional `page`, `page_size`, `tag`, `locale` and `section`. REST `section` means direct children; omitting it means whole site, independently of the theme template's `section` setting. Tag values are 1–64 characters and cannot contain `%`, `_` or `\`. The endpoint returns `image_asset_id`, not a derivative URL, and performs no writes or image generation.

For complete query and response details, keep reading this Skill only as needed; the site-wide source is not required. Use the matching selected API operation in [api-operations.json](api-operations.json).
