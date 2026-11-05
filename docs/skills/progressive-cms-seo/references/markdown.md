# Markdown representation and discovery

Use only when the target exposes this optional capability. Published pages can negotiate `text/markdown` through `Accept` or serve an explicit `.md` URL (`/index.md` for the homepage). Query and locale routing follow the existing published page.

- Negotiated Markdown returns `text/markdown`, varies on `Accept`, and preserves the HTML page's effective canonical and robots policy.
- Explicit `.md` returns `Content-Location`, a canonical `Link` to the HTML page and `X-Robots-Tag: noindex`. This does not make the canonical HTML page noindex.
- When Markdown is disabled, explicit `.md` returns 404, Markdown-only negotiation returns 406, and a normal HTML request remains available. If HTML is acceptable, a disabled Markdown preference falls back to HTML.
- `/llms.txt` is a bounded inventory of published sitemap candidates whose routes, locale, switches and Markdown projection pass Core's checks. It can omit a page that renders directly and is not a complete content export.

Check status, `Content-Type`, `Vary`, `Content-Location`, `Link`, `Content-Language` and `X-Robots-Tag` on representative pages. Never change a robots policy or availability setting only to force inclusion in `/llms.txt`.
