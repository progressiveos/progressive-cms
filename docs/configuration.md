# Configuration

Contract owner: Core config and Site Identity.

Configuration precedence is explicit `--config`, then `PCMS_CONFIG_FILE`, then `./config/pcms.json`. The standard installation stores configuration at `/etc/progressive-cms/pcms.json`. The config schema rejects unknown properties. Explicitly configure `nodeEnv` and `db.sslMode`; do not depend on an implicit security default.

Configuration stores named secret references; values belong in the secret store. Restrict secret files and keep values out of Git, command arguments, content and themes. Trust only the reverse proxies that actually connect to Web through `http.trustedProxies`.

Site Identity is separate from process configuration. It supplies site naming, title policy and `default_social_image`. Discover the settings contract on the instance before changing it. See [SEO](seo.md) and [Reference](reference.md).

## Complete schema and safe changes

Use the [parameter reference](configuration-reference.md) and delivered [JSON Schema](reference/config-schema.json) for exact nested shapes. Read Site Identity with `GET /api/v1/settings/site-identity` before updating it. Site Identity is domain data: it does not replace server config, proxy trust, secret sources or service account provisioning. An image default takes a real managed asset reference, not an arbitrary external URL.

On an empty synthetic QA site, the minimum identity requires `site_name`. The following `PUT` body also sets an optional default image using a real uploaded MediaAsset id:

```http
PUT /api/v1/settings/site-identity
{"identity":{"site_name":"Example Technology","default_social_image":{"asset_id":"<uploaded-media-id>"}}}
```

Omit `default_social_image` when no image is intended. For an existing identity, merge the desired fields into the identity returned by GET and send the full result under `identity`; this is not a patch and the minimal example would discard other settings. The operation requires `seo.site_settings`. Read back and inspect SEO preview after updating; the process configuration schema does not validate this separate domain object.

A schema-apply response may require a bounded Web/Worker reload. Public theme update-active has a separate runtime refresh contract. Do not restart services as a generic response to every API error.

[Documentation index](index.md)
