# Extensions

Contract owner: Core trusted composition.

The public Extension Contract is 2.0. Manifests are declarative validated data: the trusted deployment catalogue binds ids to deployed modules. Manifests do not supply arbitrary entrypoint paths, shell commands or SQL. Packages are version-pinned through the trusted composition/lock.

Lifecycle operations must check compatibility, capabilities and permissions. Extensions register supported contribution points; they cannot invent platform permissions. Package-owned migrations and versioned jobs must preserve their declared compatibility boundaries.

Do not describe installation as uploading arbitrary executable code from Admin. Inspect the trusted catalogue and actual install/enable/disable/uninstall contract. Providers such as payment adapters remain separate from the Core payment domain. See [Payments](payments.md).

## Trust and lifecycle checklist

Discover installed extension ids/versions and registered capabilities. Verify the approved pinned package/catalogue before install; a manifest alone cannot deploy executable code. Confirm requires/provides, platform permission registration, config/secret slots, migration compatibility and job payload versions. Enable/disable/uninstall only within the task and permission boundary. Uninstall can be blocked by dependent state; report the stable conflict instead of deleting package files or tables.

The manifest is declarative; its named handlers resolve from trusted composition. Public Core does not promise a Shop domain simply because extensions can add views/fields/providers. Read [Payments](payments.md) for the separate adapter boundary.

## Scheduled jobs and lifecycle obligations

Extension Contract 2.0 adds optional `interval_seconds` to `registrations.jobs[]`; it is an integer from `1` to `3600000`. The `ExtensionJobRegistration` and `ExtensionObligationRegistration` types are exported from the root `@pcms/extensions` SDK. A declared interval makes the existing Worker schedule that named job through the shared M07 queue. Only enabled extensions are scheduled. The scheduler skips a task while any run of that logical job is active, regardless of interval window, and a completed window is not enqueued twice. This is not an exactly-once guarantee: job handlers must be idempotent. Omit `interval_seconds` for on-demand-only jobs.

```json
{
  "registrations": {
    "jobs": [
      {
        "job_id": "expiry-sweep",
        "handler": "runExpirySweep",
        "payload_version": 1,
        "interval_seconds": 300
      }
    ]
  }
}
```

`registrations.obligations[]` is also optional. Each registration contains a locally unique `obligation_id`, a named module-export `count_handler` with signature `(tx: ExtensionTransactionContext) => Promise<number>`, and an integer PostgreSQL advisory transaction `lock_key` from `1` to `2147483647`. The handler must return a non-negative integer; a count above zero blocks disable and uninstall. A missing or failing handler, invalid count, or unavailable lock fails closed. Core checks obligations and changes lifecycle state in the same transaction; there is no force-disable/uninstall bypass.

Any business transaction that creates an outstanding obligation must use `ExtensionTransactionContext.query` to take the same transaction-scoped advisory lock and re-read the current lifecycle state inside that transaction. Proceed only while the extension is still `ENABLED`; a `platform.db.query` or check made before the transaction is not sufficient. This serializes obligation creation against disable/uninstall and prevents a race from creating new work after the lifecycle transition.

## Handler context and transactions

HTTP handlers can import `ExtensionHttpCallContext` from the root `@pcms/extensions` package. It extends `ExtensionCallContext` with HTTP request facts, `guestId`, `idempotencyKey`, and nullable `canonicalPath`/`canonicalUrl`. Core derives the path from the active mount and resolved locale; it derives the absolute URL only from the site's configured canonical domain binding, never from the request `Host`. With no active mount both canonical fields are `null`; with a mount but no canonical domain only `canonicalUrl` is `null`. The handler and rendered view receive the same canonical result. Use `canonicalUrl` for Product/Category JSON-LD instead of constructing an origin.

Inside `platform.transaction()`, `tx.audit()` and `tx.outbox.append()` remain `void` calls. Core drains their writes before commit, so SQL, audit and outbox either commit together or roll back together, including when a writer fails asynchronously or before its SQL write. `platform.jobs.enqueue()` and network calls are outside this transaction; enqueue or call them after commit when they depend on committed data.

## Search and sitemap sources

Source handlers return mount-relative paths and real BCP-47 locales. Core builds the public path from the active mount: the default locale has no locale prefix, while enabled secondary locales keep theirs. For Search, only an active mount and the first matching declared public `GET` view make a source path eligible. The source remains responsible for entity availability and `noindex`; enabled sources receive the resolved extension config and actual locale. Search visibility and canonical paths follow current extension state and mount immediately, even if an older projection is written later. Extension authors do not provide `extension_path`; Core maintains that projection field.

## Public mutation replay

Idempotency for public extension mutations is opt-in through `Idempotency-Key`. A replay is scoped to the site, extension and Core-issued `pcms_guest` cookie, with the route, path, locale and body bound to the request. Client IP is not part of replay identity: the same guest cookie retains its replay scope after an IP change, while different guests behind one NAT remain separate. Existing Origin/CSRF checks and per-IP rate limits still apply. Transport response caching is not atomic with an extension's domain transaction and does not promise exactly-once execution; irreversible operations need an owner-bound receipt stored with the domain change.

## Trusted Admin HTTP client

Admin contributions receive `AdminContributionApi` from the root `@pcms/extensions` SDK. Its `request` method uses the host's existing HTTP client and the current Admin session and CSRF handling; it does not expose authentication state or secrets.

```ts
interface AdminRequestOptions {
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly rawBody?: NonNullable<RequestInit["body"]>;
}
```

Both `AdminContributionApi` and `AdminRequestOptions` are exported from
`@pcms/extensions`. The request signature is
`request<T>(method: string, path: string, options?: AdminRequestOptions): Promise<T>`.

Pass a normalized path relative to `/api/v1`; do not include that prefix. Replace the placeholder with the operation's actual registered path:

```ts
const saved = await api.request<Product>(
  "POST",
  "/extensions/progressive.shop/operations/<registered-id>",
  { body: input },
);
```

JSON `GET`, `POST`, `PATCH` and `DELETE` requests use the host's normal `ApiError` behavior. For existing upload routes, pass `FormData`, `Blob` or `ArrayBuffer` through `rawBody`; it takes precedence over `body`, and the host/browser sets the multipart boundary. This adds no endpoint.

The path must start with `/` and stay within the normalized API path. External and protocol-relative URLs, dot-segment normalization, malformed escapes, encoded path separators, fragments, whitespace, controls and backslashes are rejected. `/auth` lifecycle paths and case-insensitive `Cookie`, `Authorization` or `X-PCMS-CSRF` header overrides are also rejected. Redirect responses fail rather than forwarding the host's CSRF state to another origin. Invalid input rejects with `API_REQUEST_INVALID` and status `0`.

Server permissions remain authoritative; this client adds no login flow or grants. Installing Shop does not grant permissions to the logged-in actor, and a CMS installation without Shop needs no changes. Use this API only when the target Core exposes the method; its introduction is recorded in [compatibility history](compatibility.md).

## Admin contribution screen continuity

Keep an `AdminRoute.load` function stable while its registered screen is unchanged. The Admin host preserves the component identity for an unchanged loader, so locale changes, query-only updates and extension-registry rerenders do not by themselves remount an already loaded screen, clear its local React state or restart lazy loading. A replacement loader loads as a new screen. Authentication and route-permission checks continue to apply, and disabling an extension removes its registered contribution through the normal lifecycle refresh.

[Documentation index](index.md)
