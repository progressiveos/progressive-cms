# Payments

Contract owner: Core payment domain; trusted adapter packages provide the provider connections.

Core defines payment state, provider instances, event handling and provider capabilities. Discover the adapters actually registered on the target with `cms payments providers`; discover configured instances and capabilities separately. The accepted Core composition includes trusted T-Bank and YooKassa adapters, but their presence does not establish merchant onboarding, bank approval, sandbox acceptance, live-money acceptance or production readiness. Progressive CMS remains usable without a payment adapter, merchant account or payment data.

## Configure a provider connection

An operator with `payments.configure` can use Admin → **Payments → Providers** or the settings API. A connection starts disabled. Save its ordinary settings and credentials together, then run **Check settings**. This check validates the local schema, required credential slots, encryption key and adapter state; it makes no request to the bank. Register the callback URL shown on the connection card in the provider's own cabinet, then enable the connection only after the owner has completed the external account setup.

The [settings read operation](rest-api-map.md#get_payment_provider_instance_settings) returns the provider schema, ordinary values, settings generation, credential-slot presence, local readiness and callback URL. It never returns credential values. The [settings write operation](rest-api-map.md#save_payment_provider_instance_settings) requires `payments.configure`; send `expected_generation` from the latest read. A stale generation returns `PAYMENT_SETTINGS_CONFLICT`: reread and reconcile the intended change before saving again. Credentials are write-only: use an explicit `set` to replace a slot or `clear` to remove it; an omitted slot is unchanged. The save commits settings, credentials and audit record together. The response is not cacheable.

Provider credentials are encrypted in the instance store using the deployment runtime-secrets key referenced by `integrations.runtimeSecretsEncryptionKeySecretRef`; see [configuration](configuration-reference.md#payment-provider-credential-encryption). The key and credential values must remain in protected secret channels. Ordinary provider parameters do not contain secrets. A connection's endpoint and merchant identity cannot be changed after payment history exists; use a separate connection for another merchant or environment so refunds cannot be sent to a different account.

Creating a payment may return `payment_url` from the provider. Pass that returned URL through the approved checkout flow; never invent or hardcode a provider URL. The provider, account and site must be confirmed before a public page claims that a payment method is available. Admin's local readiness label and a successful API response are not evidence that a bank accepted a transaction.

## Callbacks and payment state

The callback path is shown in the connection settings and is derived from the configured public origin. Provider callbacks are verified before their contents affect payment state, then stored and deduplicated. T-Bank receives plain-text `OK` only after an accepted callback; accepted duplicates are acknowledged safely. Unverified callbacks are not acknowledged as accepted and do not advance payment state. If the provider adapter is unavailable, do not assume a callback was accepted: check the provider delivery result and the CMS event history before taking action. Keep callback credentials and URLs out of public copy and diagnostic logs.

Use the payment's normalized Core state and event history; provider-specific raw statuses are diagnostic context. `cancel`, `refund` and provider status synchronization are available only when the registered adapter declares the corresponding capability. Amounts use the supported two-decimal currency model and exact minor units; Core rejects unsupported precision instead of rounding.

## Refunds are asynchronous intents

A refund request records a durable intent and schedules provider work. The request response does not mean that money has moved. Read the refund intent and payment event history to confirm the terminal result; the refunded amount changes only after provider confirmation.

Only one active refund intent is allowed per payment. `REQUESTED`, `SUBMITTED` and `NEEDS_REVIEW` block another refund while the outcome is unresolved. For an unknown provider outcome, Core follows the adapter's idempotency and lookup capabilities; do not start a second refund or resend a new key to “retry” it. `NEEDS_REVIEW` requires reconciliation against the provider before an authorized resolution. Refunds require the separate `payments.refund` permission and are audited.

See the [REST operations](rest-api-map.md#rest-payments), [MCP tools](mcp-map.md) and [CLI](cli-map.md) maps for exact request shapes and permissions. Availability varies by installed adapter; this guide does not certify a provider account, bank sandbox or live-money flow.

[Documentation index](index.md)
