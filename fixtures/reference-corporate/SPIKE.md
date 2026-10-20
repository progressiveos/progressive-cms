# T029 — first real-site adaptation spike

Corporate design (Acme) adapted onto **Theme Contract v1** with **zero Core
patches**. What changed versus the reference theme — purely theme-level:

- `theme.json` (new id `acme-corporate-v1`): corporate templates, its own
  placement set (`header.utility` = topbar phone), corporate media presets
  (`hero-wide`, `card-small`), corporate settings (`topbar_phone`, copper accent).
- `tokens/base.json` — serif/graphite/copper design language.
- `components/header.liquid` — corporate topbar + uppercase nav.
- `assets/css/theme.css` — corporate look; block markup classes unchanged
  (shared block renderers per spec §46 — copied at build/creation time).

Proof: `tests/themes/corporate-spike.test.ts` validates the theme, checks
site/content compatibility against corporate Content Types and renders all
corporate fixtures. If a real design had required contract changes, that would
be an ADR (reconciliation protocol) — none was needed.
