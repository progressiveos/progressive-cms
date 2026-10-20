# SEO, social image inheritance and IndexNow

Contract owner: Core SEO resolution, Content Tree, publication state and media derivatives.

## Social image resolution

```text
explicit social_image → own hero_image → nearest eligible ancestor section → site default_social_image
```

The ancestor is a **Content Tree parent**, defined by entry parentage, not the navigation menu or URL prefix. Walk from the nearest parent upward. An eligible ancestor must have a published revision in the requested locale. Its explicit SEO `social_image` wins over its published `fields.hero_image`. Skip ancestors with no usable image or no published revision; a draft section must not supply a live image. The walk is bounded and cycle-safe.

The resolver reports provenance `social_image`, `hero_image`, `parent_section_image` or `site_default_social_image`. Inheritance is computed on read; no media field is written into the child and no content migration is needed when a section image changes. Only the social image inherits: parent title, description, canonical, robots and other SEO fields are not copied into the child.

If no source exists, no social image is emitted. `SEO_SOCIAL_IMAGE_MISSING` is a recommendation, not an instruction to invent an image. A text/legal/documentation page can have no principal image. Set a real site default where a consistent social preview is desired.

## Configure and verify

Read `GET /api/v1/settings/site-identity` before updating it; preserve unrelated identity fields. Assign a managed MediaAsset reference as `default_social_image`. Entry overrides use `PUT /api/v1/entries/<entry-id>/seo`, for example:

```json
{"document":{"social_image":{"asset_id":"<uploaded-media-id>"}}}
```

The entry’s optional `hero_image` is a declared media field holding its asset id. A theme banner is a separate presentation composition. Do not hide an `image` block merely to give a prose article an OG image or a card cover.

Core selects/generates `og-v1` (1200×630 JPEG) at semantic assignment/preview/validation/publication points, rather than per crawler request. Inspect derivative availability and the resolved preview; an original URL does not prove social processing succeeded.

Use `GET /api/v1/discovery/seo/preview` and `/discovery/seo/structured-data` with `?entry_id=<entry-id>`, then validate with `GET /api/v1/discovery/seo/validate?entry_id=<entry-id>` (seo.validate permission). Inspect real public HTML after publication: one title/description/canonical, `og:image`, `twitter:image`, robots and appropriate JSON-LD. Confirm `/robots.txt` and `/sitemap.xml` against the published canonical routes. Themes cannot replace protected Core head metadata.

## Search-provider ownership verification

This is separate from a Yandex Metrica counter check. Use a real proof obtained from the site owner's Yandex Webmaster or Google Search Console account; never invent a token. The dedicated Admin tab is **Settings → Site ownership verification** at `/admin/#/settings?tab=verification`; Analytics links directly to it. On targets with this feature, follow these steps:

1. In Webmaster or Search Console, add the site URL and select its meta-tag or HTML-file method. Obtain the actual provider tag or download its verification file.
2. Open the CMS ownership tab, add a proof, choose the provider and method, then paste the complete meta tag or select the downloaded HTML file. Click **Save** below the form.
3. Return to the provider and click **Verify**. The CMS serves the proof; the provider confirms ownership.

The API is `GET /api/v1/settings/site-identity` (`seo.read`) and `PUT /api/v1/settings/site-identity` (`seo.site_settings`); read first, preserve existing identity fields, then save the updated `identity` object. A supplied Google or Yandex meta tag is parsed to its token; arbitrary `<head>` markup is rejected. Provider `other` supports meta verification only. Google Domain properties require DNS, which Core does not manage.

Google and Yandex file proofs accept root filenames `google<16 lowercase hex>.html` and `yandex_<16 lowercase hex>.html`; bodies must match the provider template (`google-site-verification: <token>` for Google, the token alone for Yandex). This is a typed proof, not a general file upload. The exact `/<filename>` is served anonymously with the validated body, without a theme wrapper or redirect. Save is rejected with `VERIFICATION_ROUTE_CONFLICT` (HTTP 422) if that path already belongs to a content/system route or overlaps an active extension mount.

Meta proofs appear only in the public homepage head; file proofs are served at the site root. Stored verification values are omitted from public discovery; manage them through the authorized site-identity Admin/API path, not agent discovery. See [Errors](errors.md) for route-conflict recovery.

## Four independent acceptance cases

| Case | Entry data | Expected source |
|---|---|---|
| Explicit override | social_image plus own/section/default alternatives | social_image |
| Principal image only | own hero_image, no override | hero_image |
| Image-free document | no own image, published parent has image | parent_section_image |
| Site fallback | no own/eligible ancestor image, configured default | site_default_social_image |

Also test no image anywhere, an unpublished parent and a multi-level tree where the nearest parent wins. Verify HTML URLs resolve and derivatives exist; source-level resolver tests alone do not cover this acceptance.

## IndexNow

IndexNow requires an enabled/configured discovery capability and correct public host/key handling. Check the registered provider and operational status before requesting submission. A successful submission is delivery evidence, not a guarantee of indexing. Use [Search](search.md) for the CMS search index; it is a different subsystem.

[Complete Google/Yandex SEO audit and fixes Skill](skills/progressive-cms-seo/SKILL.md) provides a focused agent workflow and acceptance evidence.

[Documentation index](index.md)
