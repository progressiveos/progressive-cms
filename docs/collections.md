# Published feeds and related-content cards

Progressive CMS exposes published content to themes through named collections and the `related_content@1` Block Document block. Both use the same bounded feed source: current published revisions with a canonical route for the requested site and locale. Drafts, archived entries, unrouted entries and other locales are excluded. The feed is read-only; rendering does not generate media derivatives.

## Declare a collection in the theme

Add named bindings to `theme.json`. A binding selects content types and may set the page size, Content Tree scope, tag field, ordering and the templates that receive it:

```json
{
  "collections": {
    "latest_news": {
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

There can be at most 20 bindings; each requires 1–10 registered content type keys. `page_size` is 1–100 and defaults to 12. The tag field defaults to `tags`. `order.by` is `published_at` or `field`; a field order needs a declared integer field. The default is newest publication first, with a stable entry-id tie-break. The optional `templates` list contains theme template ids; without it, no template receives this collection scope. A typo in a template id fails theme validation.

The binding's `section` has these meanings:

- `self` (default): direct Content Tree children of the page being rendered.
- `subtree`: all non-archived descendants of that page; the page itself is excluded.
- `site`: the whole site in the current locale.

Use a dedicated landing-page template when only the home page should show a feed. A binding on a generic page template appears on every page using that template.

In an allowed template, `collections.latest_news` contains `items`, `total`, `page`, `page_size`, `page_count`, `tag`, `tags`, `tag_clear_url`, `prev_url`, `next_url`, `has_next` and `has_prev`. Each item includes `entry_id`, a Core-resolved `href`, `title`, `description`, `teaser`, publication `date`, `tags`, `image` and `image_alt`. The image is the configured `card` derivative when ready; otherwise it is null. Collection bindings do not select arbitrary fields; use `related_content` when a card needs declared field projections. Do not construct routes or image URLs from ids.

```liquid
{% for item in collections.latest_news.items %}
  <article>
    {% if item.image %}<img src="{{ item.image }}" alt="{{ item.image_alt }}">{% endif %}
    <h2><a href="{{ item.href }}">{{ item.title }}</a></h2>
    {% if item.teaser %}<p>{{ item.teaser }}</p>{% endif %}
  </article>
{% endfor %}
```

The template feed uses the rendered page as the section root for `self` and `subtree`. HTML requests treat invalid page/tag query values leniently (page defaults to 1, tag is bounded); the REST feed below validates them strictly.

## Use the related-content block

`related_content@1` supports three modes:

- `manual`: `entry_ids` in the order the cards should appear.
- `collection`: fill cards from a declared `collection_key`.
- `hybrid`: render valid pinned `entry_ids` first, then fill remaining slots from the collection, skipping duplicates.

The mode requires its corresponding inputs: manual/hybrid require `entry_ids`; collection/hybrid require `collection_key`. A block `limit` is 1–100 and caps the final output; without it, collection mode uses the binding page size (default 12), manual mode returns its valid pinned ids (up to 100), and hybrid mode caps output at 100. Pinned ids keep their declared order. Only published, routed, non-archived cards for the current site/locale are returned.

Optional block props control the feed:

| Prop | Meaning |
|---|---|
| `scope` | `section` (default, direct children of the current page), `subtree` (descendants, excluding the page), or `site`. |
| `content_types` | 1–10 registered keys for collection/hybrid mode; overrides the binding's type list. Not allowed for manual mode. |
| `order` | `published_at` or an integer content `field`; block order overrides binding order, then the default is `published_at` descending. |
| `exclude_entry_ids` | Up to 100 stable entry ids excluded before the feed is read. |
| `fields` | Up to 20 declared fields projected to `card.fields`; reserved aliases are `title`, `description`, `image`, `published_at` and take precedence there. |
| `image_field` | A declared media field; defaults to `hero_image`. |
| `image_preset` | A theme-declared preset; defaults to `card`. Missing derivatives yield no image, never the original file or an on-read transform. |

The theme receives normalized card fields, not raw revision payloads, RichText ASTs, HTML or storage keys. RichText projections become plain text; declared media fields become public media view models. Seal-time validation checks explicit feed options against the active theme, registered content types, fields and presets. Resolve validation issues rather than relying on a runtime-empty feed.

Example Block Document node (replace the id with a canonical UUIDv7 and the keys with those declared by the site):

```json
{
  "id": "01980000-0000-7000-8000-000000000001",
  "type": "related_content",
  "schema_version": 1,
  "variant": null,
  "props": {
    "mode": "hybrid",
    "entry_ids": ["01980000-0000-7000-8000-000000000002"],
    "collection_key": "latest_news",
    "limit": 6,
    "scope": "site",
    "fields": ["teaser", "published_at"],
    "image_field": "hero_image",
    "image_preset": "card"
  },
  "children": []
}
```

## Read the public REST feed

`GET /api/v1/collections/{key}/items` is an anonymous, rate-limited read for a key declared by the active theme. It returns the same published/canonical/site/locale boundary and does not require an authoring token.

```sh
: "${SECTION_ENTRY_ID:?set a real section entry id}"
curl --fail-with-body \
  "$PCMS_API_URL/api/v1/collections/latest_news/items?page=1&page_size=12&locale=ru&section=$SECTION_ENTRY_ID"
```

Query parameters are `page` (positive integer, default 1), `page_size` (1–100, default from the binding), `tag` (1–64 characters; `%`, `_` and `\` are rejected), `locale` (enabled locale or `default`) and `section` (stable entry id). For REST, no `section` means the whole site; with `section`, only its direct children are selected. Omit `section` intentionally for a site-wide feed. The theme binding's `self`/`subtree` setting controls template rendering, not this REST query behavior.

The response includes `collection`, `total`, `page`, `page_size`, `page_count`, `tag`, `tags` (tag/count facets over the unfiltered collection), `has_next`, `has_prev` and `items`. Each REST item includes `entry_id`, resolved `href`, `title`, `teaser`, `date`, `tags` and `image_asset_id`. The REST route returns the media identity, not a derivative URL; resolve media through the normal public media contract. It never creates derivatives.

Unknown collection keys return 404 `COLLECTION_UNKNOWN`; malformed page, page size, tag, locale or section values return 400. An invalid binding/content type is reported as a conflict rather than silently widening the feed.

See [Themes](themes.md) for theme authoring and the [complete REST map](rest-api-map.md#list_collection_items) for the registered request/security contract.
