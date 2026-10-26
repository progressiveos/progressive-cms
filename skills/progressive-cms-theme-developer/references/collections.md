# Collections — named published feeds (Theme Contract §43)

A named collection is a declarative published-entry feed (news/blog lists
with server-side pagination and tag filters). The ACTIVE theme declares it;
the engine queries; the theme renders. Ships since CMS 0.1.166.

## Declare in theme.json

```json
{
  "collections": {
    "news": {
      "content_types": ["article"],
      "tag_field": "tags",
      "page_size": 12,
      "templates": ["news_feed"]
    }
  }
}
```

- `content_types` (required) — keys of registered content types; a typo is
  `THEME_COLLECTION_TEMPLATE_UNKNOWN`-style validation or
  `COLLECTION_SOURCE_INVALID` at request time, never a silent empty list.
- `tag_field` — the list<string> field carrying tags (default `tags`).
- `page_size` — feed page size, default 12, hard max 100.
- `templates` — template ids that receive the scope. The theme validator
  rejects unknown template ids (`THEME_COLLECTION_TEMPLATE_UNKNOWN`).
- `section` (optional, CMS ≥ next release) — feed scope: `"self"` (default,
  the rendered page's children), `"subtree"` (every non-archived descendant,
  the page itself excluded; an archived node ends its branch) or `"site"`
  (the whole site in the active locale, no tree filter). A theme that starts
  using it must raise `cms_compatibility`; older themes are unaffected.
- `order` (optional) — `{ "by": "published_at" | "field", "direction": "asc"
  | "desc", "field": "<id>" }`; `field` is required for `by:"field"` and must
  be an INTEGER content field. Default: `published_at` DESC. Both directions
  use NULLS LAST, then `entry_id` as the stable tie-break.

## Section = the page itself (default)

The feed reads the Content Tree CHILDREN of the rendered entry. Put the
collection template on the section page («Новости») and publish articles as
its children in the tree; a newly published child appears in the feed with
zero theme/index edits. Unpublish or archive — it disappears.

`"section": "subtree"` widens that to all descendants (nested sections);
`"section": "site"` drops the tree filter entirely — the usual way to put a
news feed on the home page, which has no article children. Under `site` the
rendered page is NOT excluded automatically; exclude it explicitly where the
block allows it.

## Scope in templates (`collections.<key>`)

```liquid
{% for item in collections.news.items %}
  <a href="{{ item.href }}">{{ item.title }}</a>
  <time datetime="{{ item.date }}">{{ item.date }}</time>
  {% for tag in item.tags %}<a href="{{ request.path }}?tag={{ tag }}">{{ tag }}</a>{% endfor %}
{% endfor %}
{{ collections.news.total }} / {{ collections.news.page }} / {{ collections.news.page_count }}
{% for facet in collections.news.tags %}
  <a href="{{ facet.url }}" {% if facet.active %}aria-current="true"{% endif %}>{{ facet.tag }} ({{ facet.count }})</a>
{% endfor %}
{% if collections.news.tag %}<a href="{{ collections.news.tag_clear_url }}">All</a>{% endif %}
{% if collections.news.prev_url %}<a href="{{ collections.news.prev_url }}" rel="prev">Prev</a>{% endif %}
{% if collections.news.next_url %}<a href="{{ collections.news.next_url }}" rel="next">Next</a>{% endif %}
```

Items carry `entry_id, href, title, description, teaser, date (ISO),
tags[], image, image_alt, fields{}` — image follows the §81 selection rules;
resolve bigger variants through the normal `media` scope when needed.
`description` = teaser → intro → first 200 plain-text body characters;
`teaser` keeps its historical intro-first chain. URLs (`facet.url`,
`tag_clear_url`, `prev_url`, `next_url`) are pre-baked: keep `?tag=` in
pagination links by using them as-is.

## REST (machine/agents)

`GET /api/v1/collections/<key>/items?page=1&page_size=12&tag=<tag>&locale=<locale>&section=<entry_id>`
— anonymous, rate-limited, read-only. Typed errors: `COLLECTION_UNKNOWN`
(404, undeclared key), `COLLECTION_PAGE_INVALID` / `COLLECTION_TAG_INVALID`
/ `COLLECTION_SECTION_INVALID` (400), `COLLECTION_SOURCE_INVALID` (409,
unregistered content type in the declaration).

## related_content blocks

`mode:"collection"` + `collection_key` resolves the same declaration;
`mode:"hybrid"` = pinned `entry_ids` first, collection fill after, both
honoring `limit`. Manual mode unchanged. Cards carry `entry_id`, `tags` and
the legacy `tag` (first tag).

Optional, additive block props (a block that declares none behaves exactly as
before, and old documents stay valid):

| prop | values | meaning |
| --- | --- | --- |
| `scope` | `section` (default) \| `subtree` \| `site` | feed scope relative to the page the block sits on |
| `content_types` | 1–10 keys | overrides the collection's types (collection/hybrid only; manual → `BLOCK_PROPS_INVALID`) |
| `fields` | 1–20 field ids | adds `card.fields.<id>` to the cards (see below) |
| `image_preset` | preset id (default `card`) | which theme preset the card image uses |
| `image_field` | field id (default `hero_image`) | media field for the card image |
| `exclude_entry_ids` | up to 100 ids | removed before limit/paging/facets, pins included |
| `order` | same shape as the binding | collection fill ordering; pinned ids keep their declared order |

Precedence: `props.order` → `binding.order` → `published_at` DESC. The block
INHERITS the binding's order when it declares none, so a related block, the
template collection scope and REST always agree for one declaration. An
explicit `image_field` is never replaced by a random document image; only the
default `hero_image` keeps the legacy block-image/gallery fallback.
`limit` bounds the final card set: pinned ids beyond the limit are dropped,
and pinned ids that are removed, unpublished or excluded never take a slot.

`card.fields` contains only requested fields of the published revision
(declared in the content type) plus four reserved projection aliases: `title`,
`description`, `image` (an image model: `url`/`src`/`srcset`/width/height/
alt/`media_id`, taken from the SAME candidate as the card's `image`, with the
same usage `alt` — an empty `alt_override` stays empty), and `published_at`
(always the ISO Publication instant, identical in collection and pinned
cards, never a content field). `rich_text`
becomes plain text (≤500 chars), `media`/`media_list` become image models in
declared order, nested objects/repeaters/lists are walked with the same rules.
Missing or empty values are omitted; `0` and `false` are values. The aliases
are always requestable and WIN inside `card.fields` when a content type has a
field of the same name — the stored field and the legacy `note`/`teaser`/
`date` surfaces are never changed.

Validate/seal rejects unknown field/preset/image-field/order-field with
`RELATED_FIELD_UNKNOWN`, `RELATED_PRESET_UNKNOWN`,
`RELATED_IMAGE_FIELD_INVALID`, `RELATED_ORDER_FIELD_INVALID` and a JSON
pointer to the offending prop. A removed pinned id never invalidates a block.

## SEO policy

Feed pages are regular routed pages: canonical is the section URL. Tag/page
variations are navigational views — mark them per the site's SEO decision
(simplest safe default: `rel="prev/next"` links + canonical to the section
on filtered pages is NOT automatic; the theme head model exposes
`head.canonical` per its usual rules). Never index empty filter states.
