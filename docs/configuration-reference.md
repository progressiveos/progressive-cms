# Configuration parameter reference

Contract owner: Core configuration schema v1. The delivered [complete JSON Schema](reference/config-schema.json) is authoritative for nested object shapes, enums, defaults and required properties. Validate an entire configuration; this index is not a replacement for validation.

Secret values never belong in this document. Configuration selects named env/file sources and runtime secret references. Paths below are generic product installation locations, not a real site's private topology.

| Section | Purpose | Operational rule |
|---|---|---|
| nodeEnv | development/production/test behavior | State explicitly; public deployments keep secure-cookie/TLS posture |
| http | bind address/port, trustedProxies, sourceKeySecretRef, shutdown, API limits/cookie policy | Trust actual proxy peers only; do not widen trust to cure a 403 |
| db | host/port/database/user, TLS mode/CA, migration path and pools | Secret reference for password; explicit TLS decision |
| log | structured logging level | Redact credentials and personal data from diagnostics |
| secrets | named env/file secret sources | Values supplied out of band, permissions restricted |
| media | storage/quarantine and upload/image limits | Persistent writable volumes outside immutable release |
| content | deployment types file plus supported schema settings | Applied additive overrides are effective runtime state, requiring registry reload |
| themes | render directory and theme operation settings | Actual render target matters more than catalogue selection |
| jobs / pcpub | worker/archive bounds and policy | Keep limits restrictive; failures do not authorize disabling validation |
| registry / skills / integrations | optional configured services and trust channels | Follow actual schema/capabilities, keep provider secrets in secret store |

Use [configuration precedence](configuration.md), validate before restart, and rediscover actual state after a permitted change. Always compare this table to the actual Core version returned by the running instance; documentation does not change server compatibility.

## API rate limiting

`http.apiRateLimitPerMinute` is the global per-client-IP limit for `/api/v1/*`, per Web process. It defaults to 1200 requests per minute outside test mode and accepts 0–100000; `0` disables this global API limiter. Its token bucket allows a burst of about ten seconds of the configured rate, then refills at that rate. A rejected request returns 429 `API_RATE_LIMITED` with `Retry-After`. This setting does not disable the separate Search and collection-feed buckets documented in [Search](search.md) and [collections](collections.md).

## Optional extension source key

`http.sourceKeySecretRef` names an entry in `secrets` for the optional server-derived `sourceKey` passed to extension operation and HTTP handlers. Use a cryptographically random 32-byte secret; for example, `openssl rand -hex 32` produces 64 hexadecimal characters. Supply the value through an environment or file secret source, never in this configuration file or Git. Secret names use dots, so `source.key` is valid and `source-key` is not.

```json
{
  "http": { "sourceKeySecretRef": "source.key" },
  "secrets": {
    "source.key": { "env": "PCMS_SECRET_SOURCE_KEY" }
  }
}
```

All Web nodes in one installation must use the same secret. Rotating it changes every derived key and resets anti-abuse windows. Configure only real reverse proxies in `http.trustedProxies`, and only when they safely append or replace `X-Forwarded-For`; an absent or unparseable source has no `sourceKey` and must not become a shared bucket. Without this setting, the field is absent and CMS behavior is unchanged. See [Extensions](extensions.md#handler-context-and-transactions) for the data and identity boundary.

## Optional public security contact

`http.securityTxt` publishes the site owner's vulnerability-reporting contact at `/.well-known/security.txt` and `/security.txt`. It is optional; without it, Core does not register these routes. The contact must be an HTTPS URL or `mailto:` address owned by the site operator. `expires` is a valid future UTC timestamp in `YYYY-MM-DDTHH:mm:ssZ` form; renew it before expiry. `preferredLanguages` is optional and comma-separated.

```json
{
  "http": {
    "securityTxt": {
      "contact": "mailto:security@example.org",
      "expires": "2030-01-01T00:00:00Z",
      "preferredLanguages": "ru, en"
    }
  }
}
```

Core serves the document only when the request is HTTPS and the expiry is still in the future; otherwise a configured route returns 404. The Web process must see the original HTTPS scheme, so configure the exact trusted reverse-proxy peers as described in [Operations](operations.md). The example address is reserved for documentation and is not an operational contact.

[Documentation index](index.md)
