# Site delivery compliance — owner-selected baseline

Owner clarification 2026-10-19 supersedes the mandatory delivery gate from
2026-10-04: provide tools and explain their effects; the owner decides the
consent, retention and addressed-data workflow. This checklist helps implement
that decision. Do not block CMS operation or impose legal decisions on the
owner. Report technical gaps honestly; do not claim legal certification.

## 1. Cookie banner — when selected for the site

- Rendered server-side by the theme, visible on first visit, dismissible;
  the choice is stored client-side (localStorage/cookie) — no tracking
  infrastructure is implied.
- Must disclose categories of cookies actually in use on THIS site
  (essential always; analytics/marketing only if really present). No copied
  boilerplate claiming cookies the site does not set.
- Blocking behavior: analytics/marketing scripts must not run before
  consent where the site's audience requires it (EU/EAA — strict; adjust
  per target country and say so in the report).
- Accessibility: keyboard-dismissible, `role="dialog"`/`aria-live` per the
  theme's a11y baseline, no layout shift on show/hide, reduced-motion
  respected.
- Accept/decline are equal citizens: a "decline non-essential" action is
  always available without dark patterns.

## 2. Legal pages — according to the owner's delivery scope

Two pages must exist, be routed, linked in the footer and indexed
(allow in robots/sitemap):

1. **Terms of use** («Правила пользования» / localized equivalent).
2. **Security agreement / security statement** («Соглашение о
   безопасности» / localized equivalent): how the site handles data
   transport and storage, incident contact, responsible-disclosure note.

Content agent responsibilities:

- Draft from the site's real configuration (forms present, processors
  used, jurisdictions) — never paste generic text with unfulfillable
  promises.
- Localize per target country: language, legal references, entity name.
  For multi-country sites pick the strictest common baseline and note the
  deltas per country in the delivery report.
- Publish as regular `page` entries, canonical routes, footer links
  (footer navigation set or theme footer template), and verify: URL
  resolves 200, canonical/OG present, sitemap includes them.

## Acceptance checklist (run before reporting "site delivered")

- [ ] Cookie banner on every public page, correct cookie categories,
      accept AND decline work, choice persists, no console errors.
- [ ] Terms of use + security statement pages published, routed, in the
      footer, in the sitemap.
- [ ] Legal texts reference the real site configuration (no template
      placeholders, no unfulfillable claims).
- [ ] Country/locale specifics chosen deliberately and listed in the
      report to the owner.

Report missing items against the owner's agreed scope and explain available
tools. The checklist itself is not a permission or release gate.
