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

## Section = the page itself

The feed reads the Content Tree CHILDREN of the rendered entry. Put the
collection template on the section page («Новости») and publish articles as
its children in the tree; a newly published child appears in the feed with
zero theme/index edits. Unpublish or archive — it disappears.

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

Items carry `entry_id, href, title, teaser, date (ISO), tags[], image,
image_alt` — image follows the §81 selection rules; resolve bigger variants
through the normal `media` scope when needed. URLs (`facet.url`,
`tag_clear_url`, `prev_url`, `next_url`) are pre-baked: keep `?tag=` in
pagination links by using them as-is.

## REST (machine/agents)

`GET /api/v1/collections/<key>/items?page=1&page_size=12&tag=<tag>&locale=<locale>&section=<entry_id>`
— anonymous, rate-limited, read-only. Typed errors: `COLLECTION_UNKNOWN`
(404, undeclared key), `COLLECTION_PAGE_INVALID` / `COLLECTION_TAG_INVALID`
/ `COLLECTION_SECTION_INVALID` (400), `COLLECTION_SOURCE_INVALID` (409,
unregistered content type in the declaration).

## related_content blocks

`mode:"collection"` + `collection_key` resolves the same declaration
(self-section); `mode:"hybrid"` = pinned `entry_ids` first, collection fill
after, both honoring `limit`. Manual mode unchanged. Cards now carry
`entry_id` and the entry's real `tags` (plus legacy `tag` = first tag).

## SEO policy

Feed pages are regular routed pages: canonical is the section URL. Tag/page
variations are navigational views — mark them per the site's SEO decision
(simplest safe default: `rel="prev/next"` links + canonical to the section
on filtered pages is NOT automatic; the theme head model exposes
`head.canonical` per its usual rules). Never index empty filter states.
