# Reference

Contract owner: Core CLI, API and config.

The [CLI chapter](cli.md), [API operation table](api-reference.md), [configuration reference](configuration-reference.md), [error guide](errors.md) and [public schema artifacts](reference/openapi-v1.json) are available in this documentation folder. CLI help alone is not exhaustive. Use the documented payload examples and running-instance discovery; no private implementation lookup is required.

The complete, separate maps are [REST API](rest-api-map.md), [CLI](cli-map.md) and [MCP](mcp-map.md). They include source-checked operation inventories, complete declared schemas/options, purpose, security and actual transport differences. The CLI map explicitly records confirmed parser limitations rather than repeating unreliable help text.

Framework exit codes: 0 success, 1 unexpected failure, 2 usage/configuration, 3 validation, 4 conflict, 5 authorization, 6 not found, 7 transient failure. Older local recovery commands have separately pinned behavior.

The [API schema](reference/openapi-v1.json) is machine-readable. Configuration precedence is `--config` → `PCMS_CONFIG_FILE` → `./config/pcms.json`. API clients use `PCMS_API_URL`, `PCMS_API_TOKEN`, `PCMS_SITE_KEY` and `PCMS_ENVIRONMENT`; set secret values through the secret channel, never paste them into examples.

Glossary: entry = durable content identity; revision = editable/sealed content state; publication = selected public revision; Content Type = field schema; block = registered structured content; theme = presentation; MediaAsset = managed media identity; capability = available operation; scope = actor permission.

[Documentation index](index.md)
