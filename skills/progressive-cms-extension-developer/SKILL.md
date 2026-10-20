# Skill: progressive-cms-extension-developer

**Version:** 2.0.0 · **Core:** `>=1.0.0-rc.1 <2.0.0` · **Extension Contract:** `2.0`

Build trusted Progressive CMS extensions against the supported public SDK.
Read [`PUBLIC-EXTENSION-CONTRACT.md`](../../docs/specs/PUBLIC-EXTENSION-CONTRACT.md)
and the relevant topic in [`references/INDEX.md`](../references/INDEX.md) first.

## Manifest and SDK

- `extension_contract` is exactly `"2.0"`; `cms_compatibility` is required
  and must include the supported Core version range.
- Declare permissions and registrations in `manifest.json`; reject unknown
  keys and fail the build when named handlers or declared schemas are invalid.
- Extension code imports author-facing symbols from `@pcms/extensions` only.
  `@pcms/extensions/internal` is Core implementation and is unsupported.
- Packages are trusted code included by the immutable build-time catalog. They
  are not downloaded or evaluated from an Admin request.

## Runtime surfaces

- `operations[]` is the shared REST/MCP handler surface. Validate its input
  and output schemas and call `platform.authorize()` for protected actions.
- `platform.transaction()` is the write boundary for extension-owned SQL,
  audit and outbox in one transaction. Core tables remain Core-owned.
- Public handlers receive a server-issued guest principal only when the
  `HttpOnly` `pcms_guest` cookie validates. The client-controlled
  `x-pcms-guest-id` header is ignored. Guest principals have no platform
  permissions; extensions still enforce ownership of their own objects.
- Cookie-authenticated public mutations require a matching Origin or Referer.
  Send JSON as `Content-Type: application/json` and use a high-entropy
  `Idempotency-Key` for retryable writes.
- A disabled extension parks queued jobs without burning attempts. Temporary
  handler failures use the Core retry policy; permanent refusal is dead-lettered.
  Payload versions not listed in `accepts_payload_versions` are permanent
  failures; deploy an explicit compatible handler before retrying such rows.
- Public routes are mount-relative. Return typed view models, not HTML; Core
  builds canonical paths and renders package/theme fragments inside the active
  theme layout. Search and sitemap sources use bounded cursors and locale-aware
  paths.
- Admin extensions import `AdminContributionApi`, navigation, route and
  contribution types from the `@pcms/extensions` SDK root; never import
  `apps/admin` source files.

## Data and packaging

- Keep extension-owned schema changes in numbered `migrations/` files. Migrations
  are forward-only and tracked in the extension migration ledger.
- `data_policy: retain` preserves extension data on uninstall; destructive drop
  requires explicit operator confirmation.
- Add the immutable package pin to `extensions/first-party.lock.json`, run
  `node scripts/compose-first-party.mjs check`, then run the focused tests and
  `npm run check`. Use the built release candidate for independent runtime and
  browser acceptance.
- Store secrets through the manifest `config_schema` secret-ref slots. Route
  outbound requests through `createExtensionFetchClientFromConfig`; do not
  hardcode credentials, proxy addresses or allowlists.

## Examples

See `extensions/progressive-media-unsplash`, `progressive-media-runware`,
`progressive-prompt-enhancer` and the independent fixture under
`extensions/progressive-platform-fixture`.
