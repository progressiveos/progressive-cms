# Search

Contract owner: Core search and Worker.

Public search indexes the current published projection. Publication events are invalidation hints: the handler reads the current publication pointer instead of trusting content carried by an old event. Redelivery and out-of-order events must not regress the index. Unpublish and rollback update the projection too.

Indexing is asynchronous through the outbox/Worker; a successful publish does not prove indexing has completed. Check `cms search status`, run a representative `cms search query` and investigate retries/dead letters if content is missing. Reindex requires explicit environment and confirmation.

Homepage binding changes require both the previous and new home projection to refresh. Verify final canonical URLs as well as result counts. This is the CMS public search, separate from any editor-side search.

Extension search results are composed from enabled extensions and their current mounts. A disabled/uninstalled extension or moved mount stops stale projections from exposing an old URL immediately, including when a late indexing write arrives. Extension sources provide relative paths and decide whether the entity is available or `noindex`; Core supplies the active-mount route metadata. See [Extensions](extensions.md) for the source contract.

## Public rate limit

Nonempty public search queries through `/search` and anonymous `GET /api/v1/search` each use a per-client-IP, per-Web-process token bucket: capacity 10, replenished at 2 requests per second. The two surfaces keep separate buckets. Successful responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; Reset is a Unix timestamp for a full bucket. A limited response is HTTP 429 with the bucket headers and `Retry-After` in seconds until another request token is available; the API response uses `SEARCH_RATE_LIMITED`. Each process has its own bucket, so a multi-process or multi-node deployment does not share one aggregate quota. Trust only the actual reverse proxy peers so the resolved client IP is meaningful. API requests also pass through the global `http.apiRateLimitPerMinute` limit.

## Acceptance after publish

Check the actual public Search API/route and status rather than only an internal index row count. Search queries must find distinctive published text and link to its current canonical route. Check unpublish, rollback and homepage binding changes too. If missing, inspect Worker health and outbox retry/dead-letter status before requesting reindex. Reindex requires the authorized environment and confirmation; it is not part of every edit.



[Documentation index](index.md)
