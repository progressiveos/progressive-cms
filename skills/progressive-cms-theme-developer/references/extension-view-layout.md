# Extension view layout

Declare the theme component that wraps extension views in `theme.json`:

```json
"layout": { "default": "site-layout" }
```

The value must name a component in `components[]`. Core renders either a theme
template that accepts the view or the extension package's versioned base
template as content, then renders the selected component around it. The layout
receives the normal page scope and `content_html` as trusted rendered HTML;
print it once inside the page's main content area. The theme owns the document
shell, `head_html`, navigation, footer and theme assets. Extension base
templates and theme overrides must therefore contain page content only.

If a theme has no `layout.default`, Core uses a minimal document shell with
`head_html` and a `<main>` element. Prefer declaring a layout for sites that
need their normal header, footer, navigation and assets on extension pages.

The reference implementation is `themes/reference-theme-v1`, component
`extension-layout`.
