# Content compatibility corpus (M02 format)

`cms site validate` checks a theme against this corpus by default
(`--content <file>` overrides). Format:

```json
{
  "contentTypes": [{ "key": "...", "version": 1, "fields": { ... } }],
  "fixtures": [
    {
      "name": "fixture-1",
      "contentType": "page",
      "expect": "ok",
      "level": "1",
      "fields": { "title": "..." }
    }
  ]
}
```

`contentTypes` are the type definitions under test; `fixtures` are sample
entries validated against them and rendered through the theme.
