# Theme Developer — Static design → CMS semantic mapping (PCMS-SKILL-T008)

Methodology for adapting a static/derived design (plain HTML/CSS, Astro,
Tailwind site, Figma export, legacy template) into a Progressive CMS theme.
The runtime stack of the design (bundlers, JS frameworks, icon fonts, hotlink
assets) is NOT ported — the design language is re-expressed through the
Theme Contract.

## Phase 1 — Inventory (before writing any theme code)

Walk the reference and list:

- **shell**: head/meta patterns, body structure, theme toggle/dark mode;
- **header**: logo, navigation, phone/CTA, mobile collapse behavior;
- **footer**: columns, legal links, contact blocks;
- **page templates**: home, listing, detail, legal/text, error/404;
- **cards**: service/project/article card anatomy (image, chips, metrics,
  price, CTA);
- **content blocks**: every repeating section type (hero, advantages grid,
  timeline, FAQ accordion, calculator, gallery, map, form, rich text);
- **navigation**: placements and their items, desktop vs mobile variants;
- **forms**: field lists, consent semantics, submit behavior;
- **assets**: photography, logos, fonts, icons (glyph semantics, not the
  icon font itself);
- **hardcoded content**: every real sentence/price/address/phone in the
  design — these are CONTENT, not presentation;
- **interactive behavior**: carousels, accordions, counters, toggles;
- **responsive states**: breakpoints, collapse patterns, type scale steps.

## Phase 2 — Semantic mapping

| Design element | Progressive CMS home |
|---|---|
| Page shell/head/meta | theme templates + Core head model (SEO subsystem fills title/meta/canonical) |
| Header/footer markup | `components/header` / `components/footer` + navigation placements + theme settings |
| Hero, sections, grids, timeline, FAQ, calculator, gallery, map, form shell | block renderers (heading/text/list/related_content/timeline/faq/calculator/gallery/map/form …) — discover the site's actual block types, don't assume this list |
| Service/project/article cards | `related_content`-style collection renderers over real entries |
| Semantic content (titles, texts, prices, dates, addresses, phone) | Content Model fields / entries / Globals — never hardcoded in templates |
| Navigation items | Navigation model via placements (depth from the design, declared in `theme.json`) |
| Forms | Forms subsystem blocks + Form View Models; **no custom POST handlers in the theme**, theme never sees PII |
| Colors/typography/spacing/breakpoints/shadows | design tokens (CSS custom properties); operational values (logo, phone, CTA target) as typed settings |
| Interactive behavior (menu toggle, carousel, lightbox, to-top) | small theme JS/CSS under CSP `self`; no external scripts |
| Icon glyphs | inline SVG theme assets, same semantics — no icon font |
| Photography | CMS Media with declared media presets; logos/favicon as theme assets; **no hotlinking** |

## Phase 3 — Implementation order

1. `theme.json` skeleton (contract version, templates, placements, presets,
   settings schema).
2. Tokens CSS, then shell (header/footer), then templates, then block
   renderers, then fixtures.
3. Replace each hardcoded piece of content with its binding as you go —
   finishing a template with hardcoded content in it is not "done".
4. Validate → preview → responsive/a11y checks → THEME.md/CHANGELOG.

## Anti-patterns (each is a defect)

- A theme that renders client copy it hardcoded "temporarily".
- Hand-built media transformation URLs instead of declared presets.
- A Core package edit to make a design fit (use the escalation ladder).
- An opaque generated-only bundle as the only source.
- Secrets (API keys, passwords) in theme assets or settings values.
- Treating every one-off visual treatment as a new Core block.
