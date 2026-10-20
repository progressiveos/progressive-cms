# Payments

Contract owner: Core payment domain; adapter-owned providers.

Core defines payment state, provider instances, event handling and provider capabilities. Concrete payment services are adapters registered through the trusted provider composition; their availability must be discovered on the actual instance.

Capabilities explicitly gate cancel, refund, provider idempotency and status synchronization. Provider callbacks must be verified before their payload is trusted. Use stable idempotency keys and the domain’s retry rules; an unknown outcome is not evidence that it is safe to charge or refund again.

`cms payments providers`, `instances` and `capabilities` expose what is available. This documentation does not promise a shop, checkout product model, tax engine or any named external provider. Those need their own accepted contract and installed adapter.

## Provider-specific behavior

Discover the registered provider types, installed instances and reported capabilities. A concrete adapter supplies configuration schema, secret requirements, callback verification and normalized status mapping. Configure real credentials only in the secret store. Do not name an external provider as production-ready merely because its interface or a test adapter exists.

For real payment operations, preserve amount/currency semantics and idempotency keys; respect whether an adapter supports cancel/refund/statusSync. Retry/refund after an unknown provider outcome follows domain policy, not a generic HTTP retry loop. This documentation authoring/Journey task authorizes no live financial transaction.

Refund amounts must be exact minor units for the supported two-decimal model. A sub-minor amount is rejected with `PAYMENT_REQUEST_INVALID`; Core does not round it. The local refund intent is applied to payment state once. If concurrent workers race to claim one intent, the losing claim returns retryable `PAYMENT_REFUND_IN_PROGRESS`. An interrupted submission to a provider without idempotency moves to `NEEDS_REVIEW` for manual reconciliation and is not automatically retried. These contracts do not certify checkout or any provider for production use.

[Documentation index](index.md)
