# Configuration parameter reference

Contract owner: Core configuration schema v1. The delivered [complete JSON Schema](reference/config-schema.json) is authoritative for nested object shapes, enums, defaults and required properties. Validate an entire configuration; this index is not a replacement for validation.

Secret values never belong in this document. Configuration selects named env/file sources and runtime secret references. Paths below are generic product installation locations, not a real site's private topology.

| Section | Purpose | Operational rule |
|---|---|---|
| nodeEnv | development/production/test behavior | State explicitly; public deployments keep secure-cookie/TLS posture |
| http | bind address/port, trustedProxies, shutdown, API limits/cookie policy | Trust actual proxy peers only; do not widen trust to cure a 403 |
| db | host/port/database/user, TLS mode/CA, migration path and pools | Secret reference for password; explicit TLS decision |
| log | structured logging level | Redact credentials and personal data from diagnostics |
| secrets | named env/file secret sources | Values supplied out of band, permissions restricted |
| media | storage/quarantine and upload/image limits | Persistent writable volumes outside immutable release |
| content | deployment types file plus supported schema settings | Applied additive overrides are effective runtime state, requiring registry reload |
| themes | render directory and theme operation settings | Actual render target matters more than catalogue selection |
| jobs / pcpub | worker/archive bounds and policy | Keep limits restrictive; failures do not authorize disabling validation |
| registry / skills / integrations | optional configured services and trust channels | Follow actual schema/capabilities, keep provider secrets in secret store |

Use [configuration precedence](configuration.md), validate before restart, and rediscover actual state after a permitted change. Always compare this table to the actual Core version returned by the running instance; documentation does not change server compatibility.

[Documentation index](index.md)
