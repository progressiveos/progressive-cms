# Changelog

## 1.2.3 — 2026-10-12

* Extension views render their content through the reference theme's shared
  layout, including the site's header, footer, navigation, SEO head and assets.

## 1.2.2 — 2026-10-03

* The `head.icons` loop is removed from `page-default`, where the
  core-protected `head_html` already renders the resolved favicon icons
  (§38) — the loop emitted every icon twice. On `search` and `error-404`
  (entry-less surfaces that assemble their head without `head_html`) the
  loop remains the native icon channel.

## 1.2.1 — 2026-10-03

* Favicon is Site Identity media rendered by the core (§38): the hardcoded
  `<link rel="icon">` (logo.svg) in `page-default`, `search` and `error-404`
  is replaced by the `head.icons` loop. Surfaces without an entry (search
  results, 404) now carry the native favicon-v1 derivative.

## 1.2.0 — 2026-10-01

* `video@1` presentation modes: `modal` (lightbox overlay, player created on
  open) and `background` (muted ambient loop, upload provider only);
  `inline` unchanged (default). Vimeo facade added.

## 1.1.0 — 2026-10-01

* New block renderers: `video_gallery@1` (grid/slider of uploaded video
  assets), `audio@1` (uploaded audio with custom simple/rich player; rich =
  animated equalizer). `video@1` learned `provider: "upload"` — native
  uploaded clips with optional poster and `#t=` start.
  `video@1` provider `vimeo` (player.vimeo.com facade, dnt for privacy).
* Public media delivery supports HTTP Range (video/audio seek) and the new
  video/audio content types.

## 1.0.0 — 2026-09-18

* Initial release: Theme Contract v1, 17 mandatory block renderers,
  6 navigation placements, 5 media presets, typed settings with token
  overrides, fixtures and THEME.md.
