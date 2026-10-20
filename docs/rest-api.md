# REST API

For the complete operation catalogue, unabridged declared schemas and HTTP surface inventory, see the [REST API map](rest-api-map.md).

Contract owner: Core route registry.

API contract 1.0.0 is described by OpenAPI 3.1. The [OpenAPI artifact](reference/openapi-v1.json) is a frozen route-registry snapshot verified against the inspected commit; it is not an installed-runtime acceptance record. The [operation reference](api-reference.md) lists every registered path/method and permission.

Use the operation’s declared method, path, security and request schema. Base `/api/v1` routes and public form endpoints have different authorization requirements. Configure API URL, service token, site and environment explicitly for CLI clients. Cursor pagination returns `items`, `has_more` and `next_cursor`; continue until exhausted rather than assuming the first page is complete.

Stable errors carry code, message, request_id, details and retryable. Preserve request ids for diagnosis without logging credentials. OpenAPI cannot replace the semantics of [Publishing](publishing.md), CAS checks or scope boundaries. Verify the served schema at the final candidate.

[Documentation index](index.md)
