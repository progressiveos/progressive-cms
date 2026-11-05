# Markdown representations for agents

Contract owner: Core Web rendering, published content projections, theme Liquid and SEO discovery. Markdown is a second public representation of an existing published page. It does not create another revision, change the content model or store a generated copy.

## Request a representation

The normal page route serves HTML. It also negotiates `Accept: text/markdown` when Markdown is preferred over `text/html` and `application/xhtml+xml`; equal quality values choose HTML. A missing or empty `Accept` also chooses HTML. If the request accepts neither HTML/XHTML nor Markdown, the route returns 406. The query string and locale continue through the existing route and publication resolver.

Append `.md` to a page route to request Markdown directly. The root page uses `/index.md`. For example, `/news/update/` is available as `/news/update.md` and `/index.md` as the root representation.

Existing route aliases and redirect rules still apply. An explicit `.md` request that follows an internal content redirect is redirected to the target's Markdown URL; the root target is `/index.md`.

| Request | Result |
|---|---|
| HTML is the selected acceptable representation | HTML, with `Vary: Accept` and an alternate Markdown `Link` when Markdown is enabled |
| `Accept: text/markdown` wins and Markdown renders | `text/markdown`, `Vary: Accept`, the effective content language and a canonical `Link` to the HTML URL |
| Explicit `.md` renders | `text/markdown`, `Content-Location` for the `.md` URL, a canonical `Link` to the HTML URL and `X-Robots-Tag: noindex` |
| Explicit `.md` route is missing, unpublished or disabled | 404 |
| Markdown is requested but content or the selected Markdown template cannot be represented | 406 |
| An unexpected Markdown rendering failure occurs | 503 |

The global and per-entry switches are on by default. If either switch is off, an explicit `.md` request returns 404, a Markdown-only `Accept` request returns 406, and a normal HTML request remains HTML. If the client also accepts HTML, a disabled Markdown preference falls back to HTML. An explicit `.md` noindex response does not change the canonical HTML page's own robots policy.

Negotiated Markdown preserves the HTML page's effective canonical and robots metadata. Explicit `.md` keeps the HTML canonical and adds `noindex`, retaining other robots directives. The HTML response advertises the Markdown alternate only while it is enabled. Use `Vary`, `Content-Location`, `Link`, `Content-Type` and `Content-Language` when checking a response; a 200 alone does not show that the intended representation or canonical policy was used.

## Theme templates and projections

Without a paired Markdown template, Core renders a fallback from the selected published page: its heading, supported semantic fields, intro, Block Document body and RichText body. Existing themes need no Markdown template to keep serving HTML or the fallback representation. New themes should pair a Markdown template with each HTML entry template they intend to expose.

Add `markdown_file` to a theme manifest template. It names a `.liquid` file under `templates/` and is selected together with that HTML template. When present, it defines the Markdown output for that template and takes precedence over the fallback. The template receives the existing published page model and Markdown projections; it does not receive scraped HTML.

For a paired template, RichText fields also have `<field>_markdown` projections. The renderer supplies `intro_markdown`, `body_markdown`, `blocks_markdown` and `fallback_markdown` as applicable. `fallback_markdown` is useful when a theme wants Core's complete semantic fallback. For a custom layout, use the relevant projections directly. A Block Document page uses `blocks_markdown`; a RichText body uses `body_markdown`.

Example manifest fragment and paired template:

```json
{
  "id": "company-news",
  "file": "templates/article.liquid",
  "markdown_file": "templates/article-markdown.liquid",
  "markdown_contract": {
    "version": 1,
    "dependencies": [
      "entry.title",
      "entry.fields.intro_markdown",
      "body_markdown"
    ]
  }
}
```

```liquid
# {{ entry.title }}

{% if entry.fields.intro_markdown %}
{{ entry.fields.intro_markdown }}
{% endif %}

{{ body_markdown }}
```

`markdown_contract` is optional. When declared, it must be version `1`; its unique `dependencies` must cover every actual source path used by the template and its partials, and each declaration must be used. These dotted paths document inputs such as `entry.title`, `entry.fields.intro_markdown`, `body_markdown`, `collections.news.items.*.title` and `media.*.download.href`. The declaration is checked against source; it is not an availability switch. Declaring a contract requires `markdown_file`.

The static discovery analyzer recognizes these public scope roots: `entry`, `body_markdown`, `blocks_markdown`, `fallback_markdown`, `media`, `related_cards`, `collections`, `request`, `site` and `i18n`. It accepts scalar and SafeMarkdown outputs, arrays of scalars only when passed through `join`, comments, top-level immutable `assign` aliases, simple scalar `if`/`unless` conditions (including `nil`, `empty` and `blank` guards), bounded array loops, and static `include` partials. Static `render` partials are supported with explicit isolated named bindings. Loop `limit` and `offset` must be numeric constants from 0 to 1000; `reversed` is also supported. Dynamic partial names and partial `with`/`for` forms are not.

The recognized Liquid filters are `default`, `strip`, `lstrip`, `rstrip`, `strip_newlines`, `upcase`, `downcase`, `capitalize`, `append`, `prepend`, `date`, `join`, `size`, `replace`, `replace_first`, `replace_last`, `remove`, `remove_first` and `remove_last`. Filter arguments must be scalar. Argument counts exclude the input value: `default`, `strip`, `lstrip`, `rstrip` and `join` accept 0–1 arguments; `date` accepts 0–2; `strip_newlines`, case filters and `size` accept none; `append`, `prepend` and `remove*` accept one; and `replace*` accepts two. A filter may be renderable without preserving the text needed to prove substantive content. Keep projected Markdown unchanged when using it as a content witness; title, H1, slug and arbitrary literal text alone do not prove page content.

Analysis is deliberately bounded: 512 template nodes, 4,096 assessment operations, 65,536 total template/partial source bytes, at most 8 active template/partial files, at most 1,000 loop items and a 262,144-byte output estimate that includes intermediate filter expansion. Discovery rejects unsupported scopes, filters, tags or lookups, unsafe or unbounded constructs, missing/cyclic partials, inconsistent dependencies and empty or unproven projections. A custom template can still serve a direct `.md` request if its actual Markdown rendering succeeds, even when static proof declines to include it in `/llms.txt`.

The semantic block renderer supports `text`, `heading`, `image`, `gallery`, `video_gallery`, `quote`, `callout`, `list`, `table`, `code`, `faq`, `cta`, `video`, `audio`, `calculator`, `quiz`, `map`, `timeline`, `documents` and `related_content`. `form` has no Markdown output. Nested blocks and content that cannot be represented without loss are not emitted as successful partial pages; the Markdown response reports unsupported content with 406. Check the installed Core version and theme validator because the Skill's compatibility minimum does not guarantee this optional feature exists.

The public [theme manifest schema](reference/theme-manifest-v2.schema.json), [theme starter](reference/theme-starter/README.md) and [theme guide](themes.md) show the package shape. The REST map includes the switch operations. This feature has no separate CLI or MCP settings command.

## Availability controls

Admin exposes a site-wide switch under **Settings** and an entry switch in the entry's **SEO** tab. The per-entry switch is hidden while the site-wide switch is off; its saved value is preserved. Both default to enabled, with generation `0` before the first saved setting.

| Operation | Permission | Result |
|---|---|---|
| `GET /api/v1/markdown/settings` | `seo.read` | `{ "enabled": true, "generation": 0 }` by default |
| `PUT /api/v1/markdown/settings` | `seo.site_settings` | Set the site-wide switch |
| `GET /api/v1/entries/{entryId}/markdown` | `content.read` | Entry state plus `globalEnabled` and `globalGeneration` |
| `PUT /api/v1/entries/{entryId}/markdown` | `content.edit` | Set one entry's switch |

Both `PUT` requests require `{ "enabled": boolean, "expected_generation": number }`. A stale generation returns 409 `AGENT_MARKDOWN_SETTINGS_STALE`; writes advance the generation and are audited. Cookie/session mutations require the normal CSRF and origin protections. See the [REST map](rest-api-map.md) for full schemas and response behavior.

## `/llms.txt` discovery

`GET /llms.txt` lists eligible published CMS entry pages with title, optional description and `.md` link, followed by the XML sitemap link. It starts from canonical entry sitemap candidates, so unpublished, non-public and noindex pages are excluded; extension sitemap contributions are not included. It also checks the active immutable theme revision, publication and locale, both availability switches, route clarity, valid content and whether the selected Markdown output can be proven to contain substantive content.

Discovery is intentionally bounded:

- At most 200 links and 1,000 candidate checks.
- At most 128 KiB of serialized published payload per page and 2 MiB across the candidate batch.
- At most 32 distinct collection requests, 1,000 pinned related-card IDs per locale, 1,000 internal action IDs per locale and 500 quiz IDs.
- At most 256 base media references per page, 1,000 base media IDs per request and 1,500 total media IDs including card media.
- Related-card and collection results are bounded to 128 KiB per result and 2 MiB total.

When a dependency budget is exceeded or a dependency cannot be verified, only pages that depend on it are omitted; unrelated pages remain eligible. The plain-text response has no checked or omitted count. When the discovery process records skipped candidates, Core logs `markdown.discovery_unconfirmed` with an aggregate `checked` count and skip counts by reason. Some candidates are filtered earlier by publication, locale, noindex or route policy and are not included in those diagnostics. The inventory is a bounded index, not a complete content export or an indexing guarantee. When global Markdown is disabled or sitemap discovery is unavailable, `/llms.txt` returns 404.

## Verify

On an authorized target, request the same published route as HTML, with `Accept: text/markdown`, and with an explicit `.md` suffix. Compare status, content type, locale, canonical link and robots behavior. Check that the explicit `.md` response is noindex while negotiated Markdown keeps the HTML page's effective robots policy. Inspect `/llms.txt` and verify each advertised URL resolves to the expected Markdown page.

If a page is absent from `/llms.txt`, that does not by itself mean its direct `.md` response is broken: discovery requires a conservative static proof. If a direct Markdown request returns 406, inspect the selected template, projections and representability of its published fields/blocks. Do not change a robots policy, publication or availability switch just to make a URL appear in the inventory.

[Documentation index](index.md)
