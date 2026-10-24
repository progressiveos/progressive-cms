# Complete REST API map

This map covers every operation mounted by the application's REST registry, including Admin, agent, public visitor and provider callback operations. The catalogue includes the complete declared input schemas, authentication, permissions, CSRF, idempotency, body limits and response construction. Nothing is omitted because it is absent from the CLI or MCP.

Use the release identified in [release-version.txt](release-version.txt). Start with [First Site](first-site.md) for a working sequence; use this map to select an exact operation and inspect its contract. The [CLI map](cli-map.md) and [MCP map](mcp-map.md) describe their own, different surfaces.

## Connection and request context

All catalogue paths include `/api/v1`. Set `PCMS_API_URL` to the instance origin, without that suffix. A remote service-account request sends `Authorization: Bearer <token>`, `X-PCMS-Site: <site-key>` and `X-PCMS-Environment: <environment>`. The actor's token restrictions still apply; headers do not grant permissions. Keep credentials in environment/secret storage.

```sh
curl --fail-with-body --silent --show-error \
  "$PCMS_API_URL/api/v1/agent/bootstrap" \
  -H "Authorization: Bearer $PCMS_API_TOKEN" \
  -H "X-PCMS-Site: $PCMS_SITE_KEY" \
  -H "X-PCMS-Environment: $PCMS_ENVIRONMENT"
```

Browser sessions use the session cookie (`__Host-pcms_session` on secure deployments). Session mutations require the synchronizer token in `X-PCMS-CSRF` unless the route explicitly opts out. Login itself checks same-origin policy; a bearer token is exempt from session CSRF. Anonymous routes retain their own origin, throttling and provider-signature checks. “Public” does not mean an unverified payment callback is accepted.

Every REST response carries `X-Request-Id`. The common JSON error is:

```json
{
  "error": {
    "code": "API_REQUEST_INVALID",
    "message": "A readable explanation of the rejected request",
    "request_id": "request-correlation-id",
    "details": [],
    "retryable": false
  }
}
```

Status meanings: 400 malformed input; 401 missing/invalid authentication; 403 insufficient permission or forbidden target; 404 missing/not visible; 409 state, route, generation or compatibility conflict; 413 body too large; 422 semantic validation; 429 throttled; 500 unexpected or explicitly reported persistence failure; 502/503 dependency unavailable. Individual operations may return additional statuses. Inspect the domain `code` and `details`; do not retry a CAS conflict with a guessed generation.

## How to read the catalogue

- Each operation has a stable anchor based on its `operationId`. Path parameters are required strings unless their explicit schema says more. Query parameters are independent of the JSON body.
- JSON Schema is copied without truncation from the running-route factories. `required`, `enum`, limits, `oneOf`/`anyOf` and `additionalProperties` are significant. Unknown properties are rejected when `additionalProperties: false`; they are not silently discarded.
- A missing body schema means the registry does not declare one; it does **not** mean the handler accepts arbitrary JSON. Binary/dual-format routes are explained explicitly. A nested generic object is only an envelope schema: its domain validator and discovery descriptor still apply.
- A response construction block is an exact source expression, with `status`, `body` and optional `headers`. It explains wrappers and status selection; function calls denote application results, not a promise that a field-level output schema exists. Local variable bindings needed by that expression are included. It is TypeScript/JavaScript notation, not JSON to copy into a request.
- Some theme operations declare `responseSchema`, reproduced in the catalogue. The current OpenAPI generator does not consume those declarations: its generic success description is not a typed success payload. Other operations still lack explicit response schemas. This map preserves those limitations instead of inventing fields. Concrete payload examples and semantics are in the linked task chapters and runtime discovery.
- The idempotency column reports the registry contract. On annotated mutations, reuse a key only for a retry of the same request and actor/site/environment scope. Independent changes need independent keys. Domain-level keys (for example payments and publication bundles) have their own semantics.

## Choose the operation by task

| Task | Order and reason | Guide |
|---|---|---|
| Connect an agent | Bootstrap → effective actor/capabilities → schema/theme discovery. Learn the actual target before writing. | [Agent workflow](agent-workflow.md) |
| Model editable content | Discover Content Types and block/field types → validate definitions → apply additive changes when authorized → honor `restart_required`. Select `bodyPolicy` from the real type. | [Content model](content-model.md), [content contract](content-contract.md) |
| Create a page | Create entry/draft → edit WORKING revision with generation CAS → validate → preview → seal. A sealed revision is immutable and is not automatically public. | [First Site](first-site.md), [publishing](publishing.md) |
| Publish a new URL | Changeset containing the revision and route operation → preflight → apply. Direct publish rejects an entry without a live route with `PUBLICATION_ROUTE_MISSING`. | [Publishing](publishing.md) |
| Change a URL | Inspect current route/history → change canonical route deliberately → inspect resulting redirect. Availability checks do not reserve a path. | [Navigation](navigation.md) |
| Addressed data action | Owner-selected preview → exact reviewed block/unblock/rectify/erase with token/request identity → receipt → recipient followup or owner exception. privacy.manage, instance Forms scope; not automatic subject discovery or remote/backup deletion. | [Personal-data tools](personal-data-tools.md) |
| Install or update a theme | Validate package → install/activate when authorized; use active-update for a newer package of the same id. Active-update preserves settings and their generation; confirmed revisions are retained with journaled recovery and generation-guarded rollback. Re-read active/history after an ambiguous response. Persistent activation takes precedence during rendering; configuration is not proof of the currently served theme. | [Themes](themes.md) |
| Manage media | Discover presets/providers → import/upload → read asset/version → use managed ids. Check usage before archive; provider candidates become managed assets only after acceptance/import. | [Media](media.md) |
| Set SEO and branding | Read stored/effective SEO and Site Identity → update with the declared generation → preview/validate → publish affected content. Preserve image inheritance and ownership-verification fields. | [SEO](seo.md) |
| Collect forms/quizzes | Discover/version definitions → render public schema → submit or advance a server-driven run → inspect permission-gated interactions/leads. Public clients never compute authoritative quiz scores. | [Forms](forms.md) |
| Operate integrations/payments | Discover providers/connectors → configure instances through secret references/write-only slots → inspect attempts/events → use approved retry/cancel/refund operations. | [Extensions](extensions.md), [payments](payments.md) |
| Install an optional capability | Discover extension state and operation schemas → check compatibility → invoke the discovered operation. Listing an extension is not permission to enable it. | [Extensions](extensions.md) |
| Upgrade the CMS | Inspect registry and update preflight → obtain approval for the intended instance/version → apply through the orchestrator → poll status and verify reported running version. | [Operations](operations.md) |

## Bodies that are not ordinary JSON

| Operation | Accepted input and relevant headers |
|---|---|
| `upload_media` | Nonempty `application/octet-stream`; `X-PCMS-Filename` required (at most 255 characters); optional `X-PCMS-Mime-Type`, `X-PCMS-Folder-Id`. Returns a managed asset/version, not a filesystem path. |
| `replace_media_version` | Nonempty `application/octet-stream`; `X-PCMS-Filename` required. Appends/replaces through the media version contract. |
| `ingest_publication_bundle` | Raw `.pcpub` ZIP with `application/vnd.progressive-cms.pcpub+zip`; use `?mode=validate` for server validation without writes. Apply can return 202 and an ingest id/status URL; poll the ingest. |
| `install_theme` | Raw `application/octet-stream` package, or JSON `{ "download_url": "https://registry.example/theme.pcTheme" }` through the configured registry downloader. |
| `update_active_theme` | Raw `application/octet-stream` package for a newer version of the same active theme id. Both `theme.write` and `theme.activate` are enforced. |
| `install_skill` | Raw `application/octet-stream` `.pcskill` package, or JSON `{ "url": "https://registry.example/skill.pcskill" }`. Community installer policy still applies. |
| `registry_release_upload` | Raw `application/octet-stream` engine release ZIP; validated and handed to the standard update orchestrator. |
| `receive_inbound`, `receive_payment_callback` | Provider-specific verified callback, not a generic authoring operation. Use the method actually registered below, including the payment callback's GET method. |

JSON routes default to 1 MiB. A per-route body limit in the catalogue overrides that limit. The transport also has bounded raw-body parsers; the effective accepted size is constrained by the applicable parser, route and domain validator. Never infer that every endpoint accepts a binary upload from the existence of the raw-body parser.

## Extension operations and other HTTP surfaces

The complete fixed registry follows below. Enabled extensions can additionally contribute application operations with their own input/output schemas. `GET /api/v1/extensions/operations` discovers them; `POST /api/v1/extensions/{extensionId}/operations/{operationId}` invokes them. `GET /api/v1/openapi.json` adds concrete extension paths at request time. The optional shipped operations are listed separately below with their full manifest schemas; an installed instance can expose more or fewer.

HTTP routes outside `/api/v1` are listed after the registry. They include health, signed preview, public files/site rendering, Admin assets and extension dispatch. They are not all REST JSON endpoints. Fastify also supplies HEAD handling for GET routes; this is not a separate application operation.

<!-- interface-map:start -->
## Fixed REST registry: 316 operations

| Area | Operations | Purpose |
|---|---:|---|
| [actor](#rest-actor) | 1 | Inspect the resolved actor and effective permissions before work. |
| [auth](#rest-auth) | 7 | Browser login, MFA and session lifecycle. Service tokens use bearer authentication instead. |
| [bundle](#rest-bundle) | 4 | Validate/ingest coordinated content; async acceptance is not completed publication. |
| [content](#rest-content) | 53 | Manage editable identities, drafts, schema definitions and localization. Read generations before CAS writes. |
| [discovery](#rest-discovery) | 77 | Read effective contracts, rendering defaults and typed capabilities. |
| [extensions](#rest-extensions) | 22 | Discover and manage deployed extension composition, typed operations and updates. |
| [forms](#rest-forms) | 19 | Version definitions and run anonymous server-validated interactions; history can contain personal data. |
| [integrations](#rest-integrations) | 25 | Configure connectors, notifications and delivery reliability; secret slots are write-only. |
| [interactions](#rest-interactions) | 13 | Read/moderate/export submissions, quiz runs and leads with separate scopes. |
| [media](#rest-media) | 33 | Manage assets, folders, providers and acquisition. Import/accept before referencing managed media ids. |
| [payments](#rest-payments) | 16 | Provider discovery, payment lifecycle, refunds and verified callbacks; mutations can move real money. |
| [publication](#rest-publication) | 23 | Coordinate sealed revisions, routes, changesets, plans and public visibility. |
| [search](#rest-search) | 7 | Query public/admin search, inspect index health and explicitly run reindexing. |
| [server](#rest-server) | 3 | Identify the target and diagnose the running instance. |
| [themes](#rest-themes) | 13 | Inspect, validate, install and activate presentation packages/settings. |

<a id="rest-actor"></a>

## actor

Inspect the resolved actor and effective permissions before work.

| Method/path | Operation | Purpose |
|---|---|---|
| `GET /api/v1/actor` | [get_current_actor](#get_current_actor) | Non-secret projection of the resolved ActorContext (spec §53) |

<a id="get_current_actor"></a>

### GET /api/v1/actor

**get_current_actor** — Non-secret projection of the resolved ActorContext (spec §53)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/core.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 200,
  body: {
    actor_type: ctx.actor.type,
    actor_id: ctx.actor.id,
    permissions: [...ctx.actor.permissions].sort(),
    site_key: ctx.actor.siteKey,
    environment: ctx.actor.environment,
    factors: [...ctx.actor.strength.factors],
    authenticated_at: ctx.actor.strength.authenticatedAt.toISOString(),
    transport: ctx.transport
  }
};
```

<a id="rest-auth"></a>

## auth

Browser login, MFA and session lifecycle. Service tokens use bearer authentication instead.

| Method/path | Operation | Purpose |
|---|---|---|
| `POST /api/v1/auth/invite/accept` | [auth_invite_accept](#auth_invite_accept) | Accept a single-use invite: sets the first password (token IS the credential) |
| `POST /api/v1/auth/login` | [auth_login](#auth_login) | Browser login: password (+ MFA stage), issues session cookie + CSRF token |
| `POST /api/v1/auth/logout` | [auth_logout](#auth_logout) | Revoke the current session and clear the cookie |
| `POST /api/v1/auth/mfa` | [auth_mfa_complete](#auth_mfa_complete) | Complete MFA for the pending session with a TOTP code |
| `POST /api/v1/auth/session/rotate` | [auth_rotate_session](#auth_rotate_session) | Rotate the current session (new cookie + CSRF token); lets an already-authenticated Admin tab re-acquire its synchronizer token after a reload (M10) |
| `GET /api/v1/auth/sessions` | [auth_list_sessions](#auth_list_sessions) | List the current user's active sessions |
| `DELETE /api/v1/auth/sessions/{sessionId}` | [auth_revoke_session](#auth_revoke_session) | Revoke one of the current user's sessions |

<a id="auth_invite_accept"></a>

### POST /api/v1/auth/invite/accept

**auth_invite_accept** — Accept a single-use invite: sets the first password (token IS the credential)

| Contract | Value |
|---|---|
| Authentication | public |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/core.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "invite_token",
    "password"
  ],
  "properties": {
    "invite_token": {
      "type": "string",
      "minLength": 10,
      "maxLength": 200
    },
    "password": {
      "type": "string",
      "maxLength": 1024
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
const { createProvisioningService: createProvisioningService2, createRoleService: createRoleService2 } = await import("@pcms/auth");
const provisioning = createProvisioningService2(app.pool, {
  users: app.users,
  passwords: app.passwords,
  policy: app.passwordPolicy,
  roles: createRoleService2(app.pool),
  onPasswordChanged: async (userId) => {
    await app.sessions.revokeAllForUser(userId, "invite accepted");
  }
});
const user = await provisioning.acceptInvite({
  inviteToken: body.invite_token,
  password: body.password
});
return {
  status: 200,
  headers: { "cache-control": "no-store" },
  body: { user_id: user.id }
};
```

<a id="auth_login"></a>

### POST /api/v1/auth/login

**auth_login** — Browser login: password (+ MFA stage), issues session cookie + CSRF token

| Contract | Value |
|---|---|
| Authentication | public |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/core.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "email",
    "password"
  ],
  "properties": {
    "email": {
      "type": "string",
      "maxLength": 320
    },
    "password": {
      "type": "string",
      "maxLength": 1024
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
const result = await app.authentication.login({
  email: body.email,
  password: body.password,
  ip: request.ip,
  transport: "api",
  metadata: { clientClass: "browser" }
});
const headers = {
  "set-cookie": serializeSessionCookie(
    cookieConfig,
    result.session.rawToken,
    maxAgeSeconds()
  ),
  "cache-control": "no-store"
};
return {
  status: 200,
  headers,
  body: {
    stage: result.stage,
    user_id: result.user.id,
    mfa_required: result.mfaRequired,
    csrf_token: result.session.csrfToken
  }
};
```

<a id="auth_logout"></a>

### POST /api/v1/auth/logout

**auth_logout** — Revoke the current session and clear the cookie

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/core.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 200,
  headers: { "set-cookie": serializeClearedSessionCookie(cookieConfig) },
  body: { ok: true }
};
```

<a id="auth_mfa_complete"></a>

### POST /api/v1/auth/mfa

**auth_mfa_complete** — Complete MFA for the pending session with a TOTP code

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/core.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID`, `AUTH_MFA_INVALID_CODE` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "code"
  ],
  "properties": {
    "code": {
      "type": "string",
      "minLength": 6,
      "maxLength": 10
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
return { status: 200, body: { stage: "OK" } };
```

<a id="auth_rotate_session"></a>

### POST /api/v1/auth/session/rotate

**auth_rotate_session** — Rotate the current session (new cookie + CSRF token); lets an already-authenticated Admin tab re-acquire its synchronizer token after a reload (M10)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/core.ts` |
| Handler-local error codes (not the whole domain error set) | `AUTH_SESSION_INVALID` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const rawToken = parseSessionCookie(request.headers.cookie, cookieConfig);
const rotated = await app.sessions.rotateSession(rawToken);
return {
  status: 200,
  headers: {
    "set-cookie": serializeSessionCookie(cookieConfig, rotated.rawToken, maxAgeSeconds()),
    "cache-control": "no-store"
  },
  body: { user_id: rotated.userId, csrf_token: rotated.csrfToken }
};
```

<a id="auth_list_sessions"></a>

### GET /api/v1/auth/sessions

**auth_list_sessions** — List the current user's active sessions

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/core.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const sessionId = requireUserId(ctx);
const sessions = await app.sessions.listActiveSessions(ctx.actor.id);
return {
  status: 200,
  body: {
    items: sessions.map((session) => ({
      session_id: session.id,
      current: session.id === sessionId,
      created_at: session.createdAt.toISOString(),
      last_seen_at: session.lastSeenAt.toISOString(),
      expires_at: session.expiresAt.toISOString()
    }))
  }
};
```

<a id="auth_revoke_session"></a>

### DELETE /api/v1/auth/sessions/{sessionId}

**auth_revoke_session** — Revoke one of the current user's sessions

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/core.ts` |
| Handler-local error codes (not the whole domain error set) | `AUTH_SESSION_INVALID` |

Path parameters: `sessionId`.

Explicit path schema:
```json
{
  "type": "object",
  "required": [
    "sessionId"
  ],
  "properties": {
    "sessionId": {
      "type": "string"
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: { ok: true } };
```

<a id="rest-bundle"></a>

## bundle

Validate/ingest coordinated content; async acceptance is not completed publication.

| Method/path | Operation | Purpose |
|---|---|---|
| `POST /api/v1/bundles` | [submit_publication_bundle](#submit_publication_bundle) | Validate or atomically apply a coordinated content bundle (strict all-or-nothing) |
| `POST /api/v1/bundles/pcpub` | [ingest_publication_bundle](#ingest_publication_bundle) | Ingest a .pcpub bundle (raw ZIP body). ?mode=validate reports issues with zero writes; apply is async (202 + status URL) |
| `GET /api/v1/bundles/pcpub/ingests` | [list_publication_bundle_ingests](#list_publication_bundle_ingests) | Recent ingests, newest first (own ingests unless the caller holds publication.plan). Recovers an ingest id lost with a submit stdout. |
| `GET /api/v1/bundles/pcpub/ingests/{ingestId}` | [get_publication_bundle_ingest](#get_publication_bundle_ingest) | Ingest status: stage, outcome, diagnostics and result links |

<a id="submit_publication_bundle"></a>

### POST /api/v1/bundles

**submit_publication_bundle** — Validate or atomically apply a coordinated content bundle (strict all-or-nothing)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.create` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 5242880 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "required": [
    "bundle_version",
    "external_id",
    "changeset",
    "entries",
    "mode"
  ],
  "properties": {
    "bundle_version": {
      "type": "integer",
      "enum": [
        1
      ]
    },
    "external_id": {
      "type": "string",
      "minLength": 8,
      "maxLength": 200
    },
    "changeset": {
      "type": "object",
      "required": [
        "title"
      ],
      "properties": {
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 300
        }
      }
    },
    "entries": {
      "type": "array",
      "maxItems": 50
    },
    "media": {
      "type": "array",
      "maxItems": 50
    },
    "publication": {
      "type": "object",
      "properties": {
        "mode": {
          "enum": [
            "now",
            "none"
          ]
        }
      }
    },
    "mode": {
      "enum": [
        "validate",
        "apply"
      ]
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body;
const result = await submitBundle(app, ctx, body, body.mode);
return { status: 201, body: result };
return { status: 200, body: result };
```

<a id="ingest_publication_bundle"></a>

### POST /api/v1/bundles/pcpub

**ingest_publication_bundle** — Ingest a .pcpub bundle (raw ZIP body). ?mode=validate reports issues with zero writes; apply is async (202 + status URL)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.create` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 268435456 bytes |
| Source | `packages/api/src/http/routes/bundles-pcpub.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "mode": {
      "enum": [
        "validate",
        "apply"
      ]
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const bytes = bodyBytes(request);
const received = await receivePcpub(app, ctx, bytes);
return { status: 200, body: await validatePcpubBytes(app, bytes, ctx) };
return { status: received.replayed ? 200 : 202, body: received };
```

<a id="list_publication_bundle_ingests"></a>

### GET /api/v1/bundles/pcpub/ingests

**list_publication_bundle_ingests** — Recent ingests, newest first (own ingests unless the caller holds publication.plan). Recovers an ingest id lost with a submit stdout.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/bundles-pcpub.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query ?? {};
const limitRaw = Number(query.limit ?? 20);
const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 20;
return { status: 200, body: await listPcpubIngests(app, ctx, limit) };
```

<a id="get_publication_bundle_ingest"></a>

### GET /api/v1/bundles/pcpub/ingests/{ingestId}

**get_publication_bundle_ingest** — Ingest status: stage, outcome, diagnostics and result links

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/bundles-pcpub.ts` |

Path parameters: `ingestId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "ingestId"
  ],
  "properties": {
    "ingestId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await getPcpubIngestStatus(app, ctx, params.ingestId)
};
```

<a id="rest-content"></a>

## content

Manage editable identities, drafts, schema definitions and localization. Read generations before CAS writes.

| Method/path | Operation | Purpose |
|---|---|---|
| `POST /api/v1/access-tokens/{tokenId}/revoke` | [revoke_access_token](#revoke_access_token) | Revoke an access token (tokens.manage) |
| `POST /api/v1/blocks/validate` | [validate_block_props](#validate_block_props) | Semantic block props validation + calculator preview (PCMS-ADMIN-T006/T007) |
| `GET /api/v1/collections/{key}/items` | [list_collection_items](#list_collection_items) | Public feed of a theme-declared collection (published cards; page/page_size/tag; rate-limited) |
| `POST /api/v1/content/richtext/convert` | [convert_rich_text](#convert_rich_text) | Canonical Markdown<->AST conversion for the Admin rich text editor (PCMS-ADMIN-T005) |
| `POST /api/v1/content/schema/apply` | [apply_content_schema](#apply_content_schema) | Apply additive-only content type changes (new types, new optional fields). Audited; response reports affected entries and restart_required. |
| `GET /api/v1/content/schema/overrides` | [list_content_schema_overrides](#list_content_schema_overrides) | Schema overrides persisted over the deployment typesFile (what a previous apply changed). |
| `POST /api/v1/content/schema/validate` | [validate_content_schema](#validate_content_schema) | Validate content type definitions against the effective set: registration probe + additive-change report, no effects. |
| `POST /api/v1/entries` | [create_draft](#create_draft) | Create entry + first working revision atomically |
| `POST /api/v1/entries/{entryId}/archive` | [archive_entry](#archive_entry) | Archive an entry (idempotent, never a hard delete) |
| `POST /api/v1/entries/{entryId}/draft` | [create_working_draft](#create_working_draft) | Open or create the entry's working draft (Admin spec §24) |
| `POST /api/v1/entries/{entryId}/duplicate` | [duplicate_entry](#duplicate_entry) | Duplicate the latest revision payload into a new sibling draft (spec §5) |
| `POST /api/v1/entries/{entryId}/home` | [set_home_entry](#set_home_entry) | Homepage binding for the site (navigation.edit; Routing home_entry_id) |
| `POST /api/v1/entries/{entryId}/identity-locale` | [reidentify_entry_locale](#reidentify_entry_locale) | Identity repair (owner 2026-10-06): move an entry and ALL its revisions to a policy-allowed identity locale in one transaction. Entry id, routes, publication pointers, payloads and edit generations are untouched. Refuses locales outside the site localization policy and translation-group members. Permission: content.edit |
| `POST /api/v1/entries/{entryId}/move` | [move_entry](#move_entry) | Reparent an entry in the Content Tree (never rewrites routes/navigation) |
| `POST /api/v1/entries/{entryId}/restore` | [restore_entry](#restore_entry) | Clear the archive flag (Admin spec §5) |
| `POST /api/v1/entries/{entryId}/revisions/cleanup` | [cleanup_entry_revisions](#cleanup_entry_revisions) | Delete all SEALED revisions of an entry except the currently published one. The working revision is always kept; refuses entries without a published revision. Permission: content.edit |
| `POST /api/v1/entries/{entryId}/route/change` | [change_entry_route](#change_entry_route) | Explicit canonical route change with a recorded redirect (navigation.edit) |
| `PUT /api/v1/entries/{entryId}/seo` | [update_entry_seo](#update_entry_seo) | Save the entry SEO document (seo.edit; canonical override also needs seo.canonical_override) |
| `PATCH /api/v1/entries/{entryId}/template` | [set_entry_template](#set_entry_template) | Assign the theme template for an entry (null = compatible default; live page changes only at next publish) |
| `GET /api/v1/entries/{entryId}/translations` | [list_entry_translations](#list_entry_translations) | Translation group members of an entry (opt-in multilingual). |
| `POST /api/v1/entries/{entryId}/translations` | [add_entry_translation](#add_entry_translation) | Create the translation of an entry in a target locale (entry + first draft). |
| `DELETE /api/v1/navigation/placements/{placementKey}` | [unbind_navigation_placement](#unbind_navigation_placement) | Unbind a theme placement |
| `PUT /api/v1/navigation/placements/{placementKey}` | [bind_navigation_placement](#bind_navigation_placement) | Bind a navigation set to a theme placement |
| `POST /api/v1/navigation/sets` | [create_navigation_set](#create_navigation_set) | Create a navigation set (optionally derived) |
| `DELETE /api/v1/navigation/sets/{setId}` | [delete_navigation_set](#delete_navigation_set) | Hard-delete an UNBOUND navigation set and its own items, overrides and revisions (navigation.edit). Placement bindings or derived sets block deletion (NAV_SET_BOUND). |
| `POST /api/v1/navigation/sets/{setId}/items` | [insert_navigation_item](#insert_navigation_item) | Insert a navigation item (stable Item ID assigned by the domain) |
| `DELETE /api/v1/navigation/sets/{setId}/items/{itemId}` | [delete_navigation_item](#delete_navigation_item) | Delete a navigation item (subtree) |
| `PATCH /api/v1/navigation/sets/{setId}/items/{itemId}` | [update_navigation_item](#update_navigation_item) | Update an existing menu item (label, type, target) in the working tree |
| `POST /api/v1/navigation/sets/{setId}/items/{itemId}/move` | [move_navigation_item](#move_navigation_item) | Move/reorder a navigation item (stable Item IDs preserved) |
| `POST /api/v1/navigation/sets/{setId}/overrides` | [add_navigation_override](#add_navigation_override) | Add a derived-set override (hide/relabel/reorder/move/insert/replace_target/show) |
| `DELETE /api/v1/navigation/sets/{setId}/overrides/{overrideId}` | [remove_navigation_override](#remove_navigation_override) | Remove a derived-set override |
| `POST /api/v1/navigation/sets/{setId}/seal` | [seal_navigation_set](#seal_navigation_set) | Seal the working tree of a navigation set (navigation.publish) |
| `DELETE /api/v1/revisions/{revisionId}` | [delete_revision](#delete_revision) | Delete a WORKING or SEALED revision (cleanup). The currently published revision is undeletable (409 REVISION_PUBLISHED). Audited. |
| `PATCH /api/v1/revisions/{revisionId}` | [update_draft](#update_draft) | Autosave a working revision (optimistic edit generation) |
| `POST /api/v1/revisions/{revisionId}/seal` | [seal_revision](#seal_revision) | Seal a working revision (publish-level validation) |
| `POST /api/v1/revisions/{revisionId}/validate` | [validate_revision](#validate_revision) | Validate a revision (draft or publish level) |
| `POST /api/v1/roles-admin` | [manage_custom_role](#manage_custom_role) | Create/update/delete a custom role (roles.manage; registry-validated) |
| `POST /api/v1/service-accounts` | [create_service_account](#create_service_account) | Create a service account (tokens.manage) |
| `DELETE /api/v1/service-accounts/{accountId}` | [delete_service_account](#delete_service_account) | Delete a service account and every token it issued, irreversibly (tokens.manage) |
| `POST /api/v1/service-accounts/{accountId}/disable` | [disable_service_account](#disable_service_account) | Disable a service account (tokens.manage) |
| `POST /api/v1/service-accounts/{accountId}/tokens` | [create_access_token](#create_access_token) | Create an access token; the raw secret is returned exactly once (tokens.manage) |
| `PUT /api/v1/settings/site-identity` | [update_site_identity](#update_site_identity) | Save the typed site identity (seo.site_settings) |
| `POST /api/v1/users` | [create_user](#create_user) | Create a user with a role; invite token returned exactly once (users.manage) |
| `DELETE /api/v1/users/{userId}` | [delete_user](#delete_user) | Hard-delete a user with credentials, sessions, MFA and tokens (users.manage). Last active OWNER and self-deletion are refused. |
| `PUT /api/v1/users/{userId}` | [update_user](#update_user) | Edit a user's display name and/or primary email (users.manage). OWNER targets require the actor to hold OWNER. |
| `POST /api/v1/users/{userId}/disable` | [disable_user](#disable_user) | Disable a user (last-OWNER invariant enforced server-side) |
| `POST /api/v1/users/{userId}/enable` | [enable_user](#enable_user) | Re-enable a disabled user |
| `DELETE /api/v1/users/{userId}/mfa` | [reset_user_mfa](#reset_user_mfa) | Reset a user's TOTP enrollment (users.manage) |
| `PUT /api/v1/users/{userId}/password` | [set_user_password](#set_user_password) | Set a user's password after policy validation (users.manage). The user's sessions are revoked; a self change keeps the current session. |
| `POST /api/v1/users/{userId}/roles` | [assign_role](#assign_role) | Assign a role to a user (roles.manage) |
| `DELETE /api/v1/users/{userId}/roles/{roleKey}` | [remove_role](#remove_role) | Remove a role from a user (roles.manage) |
| `POST /api/v1/users/{userId}/sessions/revoke` | [revoke_user_sessions](#revoke_user_sessions) | Revoke all sessions of a user (users.manage) |
| `POST /api/v1/users/direct` | [create_user_with_password](#create_user_with_password) | Create a user with an initial password and role (users.manage) |

<a id="revoke_access_token"></a>

### POST /api/v1/access-tokens/{tokenId}/revoke

**revoke_access_token** — Revoke an access token (tokens.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `tokens.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `tokenId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "reason"
  ],
  "properties": {
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await revokeAccessTokenOp(app, ctx, {
    token_id: params.tokenId,
    reason: String(body.reason)
  })
};
```

<a id="validate_block_props"></a>

### POST /api/v1/blocks/validate

**validate_block_props** — Semantic block props validation + calculator preview (PCMS-ADMIN-T006/T007)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.read` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "type_id",
    "props"
  ],
  "properties": {
    "type_id": {
      "type": "string",
      "maxLength": 64
    },
    "props": {
      "type": "object"
    },
    "sample_values": {
      "type": "object"
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
return {
  status: 200,
  body: await validateBlockProps(app, ctx, {
    type_id: body.type_id,
    props: body.props,
    ...body.sample_values === void 0 || typeof body.sample_values !== "object" ? {} : { sample_values: body.sample_values }
  })
};
```

<a id="list_collection_items"></a>

### GET /api/v1/collections/{key}/items

**list_collection_items** — Public feed of a theme-declared collection (published cards; page/page_size/tag; rate-limited)

| Contract | Value |
|---|---|
| Authentication | public |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/collections.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID`, `COLLECTION_SECTION_INVALID`, `COLLECTION_UNKNOWN` |

Path parameters: `key`.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "page": {
      "type": "string",
      "pattern": "^[0-9]+$"
    },
    "page_size": {
      "type": "string",
      "pattern": "^[0-9]+$"
    },
    "tag": {
      "type": "string",
      "maxLength": 64
    },
    "locale": {
      "type": "string",
      "maxLength": 16
    },
    "section": {
      "type": "string",
      "maxLength": 64
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const binding = app.themeDiscovery?.getManifest().collections?.[params.key];
const query = request.query;
const context = "default";
const sectionEntryId = null;
const { page, pageSize, tag } = parseCollectionFeedQuery(query, {
  pageSize: binding.page_size ?? COLLECTION_DEFAULT_PAGE_SIZE
});
const feed = await queryCollectionFeed(
  {
    pool: app.pool,
    isKnownContentType: (key) => app.contentTypes.getLatestContentType(key) !== null
  },
  {
    context,
    contentTypes: binding.content_types,
    sectionEntryId,
    tagField: binding.tag_field ?? "tags",
    tag,
    page,
    pageSize
  }
);
const items = feed.items.map((row2) => {
  const fields2 = row2.fields ?? {};
  const tags2 = Array.isArray(fields2[binding.tag_field ?? "tags"]) ? fields2[binding.tag_field ?? "tags"].filter(
    (value) => typeof value === "string"
  ) : [];
  return {
    entry_id: row2.entry_id,
    href: localizedRoutePath({ locale: row2.route_locale, path: row2.route_path }),
    title: typeof fields2.title === "string" ? fields2.title : row2.entry_id,
    teaser: cardTeaser(fields2),
    date: row2.published_at,
    tags: tags2,
    // Media REFERENCE only: the route stays derivative-free and
    // read-only; themes resolve the actual image model through the
    // media scope / buildImageModel (Theme Contract §43).
    image_asset_id: firstImageAssetId(fields2, row2.blocks)
  };
});
const fields = row.fields ?? {};
const tags = Array.isArray(fields[binding.tag_field ?? "tags"]) ? fields[binding.tag_field ?? "tags"].filter(
  (value) => typeof value === "string"
) : [];
return {
  status: 200,
  body: {
    collection: params.key,
    total: feed.total,
    page: feed.page,
    page_size: feed.pageSize,
    page_count: feed.pageCount,
    tag,
    tags: feed.tags,
    has_next: feed.page < feed.pageCount,
    has_prev: feed.page > 1,
    items
  }
};
```

<a id="convert_rich_text"></a>

### POST /api/v1/content/richtext/convert

**convert_rich_text** — Canonical Markdown<->AST conversion for the Admin rich text editor (PCMS-ADMIN-T005)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.read` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "direction",
    "value"
  ],
  "properties": {
    "direction": {
      "enum": [
        "markdown_to_ast",
        "ast_to_markdown"
      ]
    },
    "value": {}
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
return {
  status: 200,
  body: await convertRichText(app, ctx, {
    direction: body.direction,
    value: body.value
  })
};
```

<a id="apply_content_schema"></a>

### POST /api/v1/content/schema/apply

**apply_content_schema** — Apply additive-only content type changes (new types, new optional fields). Audited; response reports affected entries and restart_required.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content_schema.apply` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/content-schema.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "definitions"
  ],
  "properties": {
    "definitions": {
      "anyOf": [
        {
          "type": "array",
          "maxItems": 256
        },
        {
          "type": "object",
          "additionalProperties": true,
          "required": [
            "contentTypes"
          ],
          "properties": {
            "contentTypes": {
              "type": "array",
              "maxItems": 256
            }
          }
        }
      ]
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(
  app,
  ctx,
  () => applyContentSchemaOp(app, ctx, { definitions: jsonBody(request).definitions })
);
```

<a id="list_content_schema_overrides"></a>

### GET /api/v1/content/schema/overrides

**list_content_schema_overrides** — Schema overrides persisted over the deployment typesFile (what a previous apply changed).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content_schema.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/content-schema.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, () => listContentTypeOverridesOp(app, ctx));
```

<a id="validate_content_schema"></a>

### POST /api/v1/content/schema/validate

**validate_content_schema** — Validate content type definitions against the effective set: registration probe + additive-change report, no effects.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content_schema.propose` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/content-schema.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "definitions"
  ],
  "properties": {
    "definitions": {
      "anyOf": [
        {
          "type": "array",
          "maxItems": 256
        },
        {
          "type": "object",
          "additionalProperties": true,
          "required": [
            "contentTypes"
          ],
          "properties": {
            "contentTypes": {
              "type": "array",
              "maxItems": 256
            }
          }
        }
      ]
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(
  app,
  ctx,
  () => validateContentSchemaOp(app, ctx, { definitions: jsonBody(request).definitions })
);
```

<a id="create_draft"></a>

### POST /api/v1/entries

**create_draft** — Create entry + first working revision atomically

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.create` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "content_type",
    "payload"
  ],
  "properties": {
    "content_type": {
      "type": "string",
      "maxLength": 64
    },
    "entry_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    },
    "parent_entry_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$",
      "nullable": true
    },
    "template_key": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 64
    },
    "payload": {
      "type": "object"
    },
    "locale": {
      "type": "string",
      "maxLength": 16
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 201,
  body: await createDraft(app, ctx, request.body)
};
```

<a id="archive_entry"></a>

### POST /api/v1/entries/{entryId}/archive

**archive_entry** — Archive an entry (idempotent, never a hard delete)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.archive` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `entryId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return { status: 200, body: await archiveEntry(app, ctx, { entry_id: params.entryId }) };
```

<a id="create_working_draft"></a>

### POST /api/v1/entries/{entryId}/draft

**create_working_draft** — Open or create the entry's working draft (Admin spec §24)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: `entryId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "from_revision_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$",
      "nullable": true
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 201,
  body: await createWorkingDraft(app, ctx, {
    entry_id: params.entryId,
    ...typeof body.from_revision_id === "string" ? { from_revision_id: body.from_revision_id } : {}
  })
};
```

<a id="duplicate_entry"></a>

### POST /api/v1/entries/{entryId}/duplicate

**duplicate_entry** — Duplicate the latest revision payload into a new sibling draft (spec §5)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.create` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: `entryId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "parent_entry_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$",
      "nullable": true
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 201,
  body: await duplicateEntryOp(app, ctx, {
    entry_id: params.entryId,
    ...body.parent_entry_id === void 0 ? {} : { parent_entry_id: body.parent_entry_id }
  })
};
```

<a id="set_home_entry"></a>

### POST /api/v1/entries/{entryId}/home

**set_home_entry** — Homepage binding for the site (navigation.edit; Routing home_entry_id)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `entryId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await setHomeEntryOp(app, ctx, { entry_id: stableId(params.entryId, "entryId") })
};
```

<a id="reidentify_entry_locale"></a>

### POST /api/v1/entries/{entryId}/identity-locale

**reidentify_entry_locale** — Identity repair (owner 2026-10-06): move an entry and ALL its revisions to a policy-allowed identity locale in one transaction. Entry id, routes, publication pointers, payloads and edit generations are untouched. Refuses locales outside the site localization policy and translation-group members. Permission: content.edit

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `entryId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "locale"
  ],
  "properties": {
    "locale": {
      "type": "string",
      "minLength": 2,
      "maxLength": 35
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await reidentifyEntryLocale(app, ctx, {
    entry_id: params.entryId,
    locale: String(body.locale ?? "")
  })
};
```

<a id="move_entry"></a>

### POST /api/v1/entries/{entryId}/move

**move_entry** — Reparent an entry in the Content Tree (never rewrites routes/navigation)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: `entryId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "parent_entry_id"
  ],
  "properties": {
    "parent_entry_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$",
      "nullable": true
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await moveEntryOp(app, ctx, {
    entry_id: params.entryId,
    parent_entry_id: body.parent_entry_id
  })
};
```

<a id="restore_entry"></a>

### POST /api/v1/entries/{entryId}/restore

**restore_entry** — Clear the archive flag (Admin spec §5)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.archive` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `entryId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return { status: 200, body: await restoreEntryOp(app, ctx, { entry_id: params.entryId }) };
```

<a id="cleanup_entry_revisions"></a>

### POST /api/v1/entries/{entryId}/revisions/cleanup

**cleanup_entry_revisions** — Delete all SEALED revisions of an entry except the currently published one. The working revision is always kept; refuses entries without a published revision. Permission: content.edit

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `entryId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await cleanupEntryRevisionsOp(app, ctx, { entry_id: params.entryId })
};
```

<a id="change_entry_route"></a>

### POST /api/v1/entries/{entryId}/route/change

**change_entry_route** — Explicit canonical route change with a recorded redirect (navigation.edit)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: `entryId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "to_path"
  ],
  "properties": {
    "to_path": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "reason": {
      "type": "string",
      "maxLength": 500
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await changeEntryRoute(app, ctx, {
    entry_id: stableId(params.entryId, "entryId"),
    to_path: body.to_path,
    ...typeof body.reason === "string" ? { reason: body.reason } : {}
  })
};
```

<a id="update_entry_seo"></a>

### PUT /api/v1/entries/{entryId}/seo

**update_entry_seo** — Save the entry SEO document (seo.edit; canonical override also needs seo.canonical_override)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `seo.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: `entryId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "document"
  ],
  "properties": {
    "document": {
      "type": [
        "object",
        "null"
      ]
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await updateEntrySeo(app, ctx, {
    entry_id: stableId(params.entryId, "entryId"),
    document: body.document
  })
};
```

<a id="set_entry_template"></a>

### PATCH /api/v1/entries/{entryId}/template

**set_entry_template** — Assign the theme template for an entry (null = compatible default; live page changes only at next publish)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: `entryId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "template_key"
  ],
  "properties": {
    "template_key": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 64
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await setEntryTemplateOp(app, ctx, {
    entry_id: params.entryId,
    template_key: body.template_key
  })
};
```

<a id="list_entry_translations"></a>

### GET /api/v1/entries/{entryId}/translations

**list_entry_translations** — Translation group members of an entry (opt-in multilingual).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `entryId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const entryId = stableId(request.params.entryId, "entryId");
return { status: 200, body: await listTranslationsOp(app, ctx, entryId) };
```

<a id="add_entry_translation"></a>

### POST /api/v1/entries/{entryId}/translations

**add_entry_translation** — Create the translation of an entry in a target locale (entry + first draft).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.create` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/localization.ts` |

Path parameters: `entryId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "locale"
  ],
  "properties": {
    "locale": {
      "type": "string",
      "minLength": 2,
      "maxLength": 35
    },
    "copy_from_source": {
      "type": "boolean"
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
const entryId = typeof params.entryId === "string" ? params.entryId : "";
return handle(
  app,
  ctx,
  () => addTranslationOp(app, ctx, entryId, jsonBody(request))
);
```

<a id="unbind_navigation_placement"></a>

### DELETE /api/v1/navigation/placements/{placementKey}

**unbind_navigation_placement** — Unbind a theme placement

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `placementKey`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await unbindPlacement(app, ctx, { placement_key: params.placementKey })
};
```

<a id="bind_navigation_placement"></a>

### PUT /api/v1/navigation/placements/{placementKey}

**bind_navigation_placement** — Bind a navigation set to a theme placement

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: `placementKey`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "navigation_set_id"
  ],
  "properties": {
    "navigation_set_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await bindPlacement(app, ctx, {
    placement_key: params.placementKey,
    navigation_set_id: body.navigation_set_id
  })
};
```

<a id="create_navigation_set"></a>

### POST /api/v1/navigation/sets

**create_navigation_set** — Create a navigation set (optionally derived)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "key",
    "title"
  ],
  "properties": {
    "key": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9_-]{0,63}$"
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "derived_from_set_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$",
      "nullable": true
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
return {
  status: 201,
  body: await createNavigationSet(app, ctx, {
    key: body.key,
    title: body.title,
    ...typeof body.derived_from_set_id === "string" ? { derived_from_set_id: body.derived_from_set_id } : {}
  })
};
```

<a id="delete_navigation_set"></a>

### DELETE /api/v1/navigation/sets/{setId}

**delete_navigation_set** — Hard-delete an UNBOUND navigation set and its own items, overrides and revisions (navigation.edit). Placement bindings or derived sets block deletion (NAV_SET_BOUND).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `setId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "setId"
  ],
  "properties": {
    "setId": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await deleteNavigationSet(app, ctx, { set_id: params.setId })
};
```

<a id="insert_navigation_item"></a>

### POST /api/v1/navigation/sets/{setId}/items

**insert_navigation_item** — Insert a navigation item (stable Item ID assigned by the domain)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `setId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "type"
  ],
  "properties": {
    "parent_item_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$",
      "nullable": true
    },
    "type": {
      "type": "string",
      "maxLength": 32
    },
    "label": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 200
    },
    "target": {
      "type": [
        "object",
        "null"
      ]
    },
    "ui_intent": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 16
    },
    "at": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 0
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 201,
  body: await insertNavigationItem(app, ctx, {
    set_id: params.setId,
    type: String(body.type),
    ...body.parent_item_id === void 0 || body.parent_item_id === null ? {} : { parent_item_id: body.parent_item_id },
    ...body.label === void 0 || body.label === null ? {} : { label: String(body.label) },
    ...body.target === void 0 || body.target === null ? {} : { target: body.target },
    ...body.ui_intent === void 0 || body.ui_intent === null ? {} : { ui_intent: String(body.ui_intent) },
    ...body.at === void 0 || body.at === null ? {} : { at: Number(body.at) }
  })
};
```

<a id="delete_navigation_item"></a>

### DELETE /api/v1/navigation/sets/{setId}/items/{itemId}

**delete_navigation_item** — Delete a navigation item (subtree)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `setId`, `itemId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await deleteNavigationItem(app, ctx, {
    set_id: params.setId,
    item_id: params.itemId
  })
};
```

<a id="update_navigation_item"></a>

### PATCH /api/v1/navigation/sets/{setId}/items/{itemId}

**update_navigation_item** — Update an existing menu item (label, type, target) in the working tree

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `setId`, `itemId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "type"
  ],
  "properties": {
    "type": {
      "type": "string",
      "maxLength": 32
    },
    "label": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 200
    },
    "target": {
      "type": [
        "object",
        "null"
      ]
    },
    "ui_intent": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 16
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await updateNavigationItem(app, ctx, {
    set_id: params.setId,
    item_id: params.itemId,
    type: String(body.type),
    ...body.label === void 0 || body.label === null ? {} : { label: String(body.label) },
    ...body.target === void 0 || body.target === null ? {} : { target: body.target },
    ...body.ui_intent === void 0 || body.ui_intent === null ? {} : { ui_intent: String(body.ui_intent) }
  })
};
```

<a id="move_navigation_item"></a>

### POST /api/v1/navigation/sets/{setId}/items/{itemId}/move

**move_navigation_item** — Move/reorder a navigation item (stable Item IDs preserved)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: `setId`, `itemId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "parent_item_id"
  ],
  "properties": {
    "parent_item_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$",
      "nullable": true
    },
    "at": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 0
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await moveNavigationItem(app, ctx, {
    set_id: params.setId,
    item_id: params.itemId,
    parent_item_id: body.parent_item_id,
    ...body.at === void 0 || body.at === null ? {} : { at: Number(body.at) }
  })
};
```

<a id="add_navigation_override"></a>

### POST /api/v1/navigation/sets/{setId}/overrides

**add_navigation_override** — Add a derived-set override (hide/relabel/reorder/move/insert/replace_target/show)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `setId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "target_item_id",
    "op"
  ],
  "properties": {
    "target_item_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    },
    "op": {
      "type": "string",
      "maxLength": 32
    },
    "payload": {
      "type": "object"
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 201,
  body: await addNavigationOverride(app, ctx, {
    set_id: params.setId,
    target_item_id: String(body.target_item_id),
    op: String(body.op),
    payload: body.payload
  })
};
```

<a id="remove_navigation_override"></a>

### DELETE /api/v1/navigation/sets/{setId}/overrides/{overrideId}

**remove_navigation_override** — Remove a derived-set override

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `setId`, `overrideId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await removeNavigationOverride(app, ctx, {
    set_id: params.setId,
    override_id: params.overrideId
  })
};
```

<a id="seal_navigation_set"></a>

### POST /api/v1/navigation/sets/{setId}/seal

**seal_navigation_set** — Seal the working tree of a navigation set (navigation.publish)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.publish` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `setId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return { status: 200, body: await sealNavigationSet(app, ctx, { set_id: params.setId }) };
```

<a id="delete_revision"></a>

### DELETE /api/v1/revisions/{revisionId}

**delete_revision** — Delete a WORKING or SEALED revision (cleanup). The currently published revision is undeletable (409 REVISION_PUBLISHED). Audited.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `revisionId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "revisionId"
  ],
  "properties": {
    "revisionId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await deleteRevisionOp(app, ctx, { revision_id: params.revisionId })
};
```

<a id="update_draft"></a>

### PATCH /api/v1/revisions/{revisionId}

**update_draft** — Autosave a working revision (optimistic edit generation)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `revisionId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "payload",
    "expected_edit_generation"
  ],
  "properties": {
    "payload": {
      "type": "object"
    },
    "expected_edit_generation": {
      "type": "integer",
      "minimum": 0
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body;
const revision = await updateDraft(app, ctx, {
  payload: body.payload,
  expected_edit_generation: body.expected_edit_generation,
  revision_id: request.params.revisionId
});
return {
  status: 200,
  body: {
    revision_id: revision.id,
    state: revision.state,
    edit_generation: revision.editGeneration,
    updated_at: revision.updatedAt.toISOString()
  }
};
```

<a id="seal_revision"></a>

### POST /api/v1/revisions/{revisionId}/seal

**seal_revision** — Seal a working revision (publish-level validation)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `revision.seal` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `revisionId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": [
    "object",
    "null"
  ],
  "additionalProperties": false,
  "properties": {
    "expected_edit_generation": {
      "type": "integer",
      "minimum": 0
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const sealed = await sealRevision(app, ctx, {
  revision_id: params.revisionId,
  ...request.body === void 0 ? {} : request.body
});
return {
  status: 200,
  body: {
    revision_id: sealed.id,
    state: sealed.state,
    payload_hash: sealed.payloadHash,
    sealed_at: sealed.sealedAt?.toISOString() ?? null
  }
};
```

<a id="validate_revision"></a>

### POST /api/v1/revisions/{revisionId}/validate

**validate_revision** — Validate a revision (draft or publish level)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `revisionId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await validateRevision(app, ctx, {
    revision_id: params.revisionId,
    ...request.body === void 0 ? {} : request.body
  })
};
```

<a id="manage_custom_role"></a>

### POST /api/v1/roles-admin

**manage_custom_role** — Create/update/delete a custom role (roles.manage; registry-validated)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `roles.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "action"
  ],
  "properties": {
    "action": {
      "enum": [
        "create",
        "update",
        "delete"
      ]
    },
    "role_key": {
      "type": "string",
      "maxLength": 64
    },
    "name": {
      "type": "string",
      "maxLength": 200
    },
    "permissions": {
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 64
      },
      "maxItems": 200
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
return {
  status: 200,
  body: await createUpdateDeleteRoleOp(app, ctx, {
    action: body.action,
    ...body.role_key === void 0 ? {} : { role_key: String(body.role_key) },
    ...body.name === void 0 ? {} : { name: String(body.name) },
    ...body.permissions === void 0 ? {} : { permissions: body.permissions.map(String) }
  })
};
```

<a id="create_service_account"></a>

### POST /api/v1/service-accounts

**create_service_account** — Create a service account (tokens.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `tokens.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name",
    "purpose"
  ],
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "purpose": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "allowed_scopes": {
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 64
      },
      "maxItems": 100
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
return {
  status: 201,
  body: await createServiceAccountOp(app, ctx, {
    name: String(body.name),
    purpose: String(body.purpose),
    ...body.allowed_scopes === void 0 ? {} : { allowed_scopes: body.allowed_scopes.map(String) }
  })
};
```

<a id="delete_service_account"></a>

### DELETE /api/v1/service-accounts/{accountId}

**delete_service_account** — Delete a service account and every token it issued, irreversibly (tokens.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `tokens.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `accountId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "reason"
  ],
  "properties": {
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await deleteServiceAccountOp(app, ctx, {
    account_id: params.accountId,
    reason: String(body.reason)
  })
};
```

<a id="disable_service_account"></a>

### POST /api/v1/service-accounts/{accountId}/disable

**disable_service_account** — Disable a service account (tokens.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `tokens.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `accountId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "reason"
  ],
  "properties": {
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await disableServiceAccountOp(app, ctx, {
    account_id: params.accountId,
    reason: String(body.reason)
  })
};
```

<a id="create_access_token"></a>

### POST /api/v1/service-accounts/{accountId}/tokens

**create_access_token** — Create an access token; the raw secret is returned exactly once (tokens.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `tokens.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `accountId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "scopes"
  ],
  "properties": {
    "scopes": {
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 64
      },
      "minItems": 1,
      "maxItems": 100
    },
    "description": {
      "type": "string",
      "maxLength": 500
    },
    "ttl_hours": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1,
      "maximum": 8760
    },
    "allow_permanent": {
      "type": "boolean"
    },
    "site_key": {
      "type": "string",
      "maxLength": 64
    },
    "environment": {
      "type": "string",
      "maxLength": 32
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 201,
  body: await createAccessTokenOp(app, ctx, {
    account_id: params.accountId,
    scopes: body.scopes.map(String),
    ...body.description === void 0 ? {} : { description: String(body.description) },
    ...body.ttl_hours === void 0 || body.ttl_hours === null ? {} : { ttl_hours: Number(body.ttl_hours) },
    ...body.allow_permanent === void 0 ? {} : { allow_permanent: body.allow_permanent === true },
    ...body.site_key === void 0 ? {} : { site_key: String(body.site_key) },
    ...body.environment === void 0 ? {} : { environment: String(body.environment) }
  })
};
```

<a id="update_site_identity"></a>

### PUT /api/v1/settings/site-identity

**update_site_identity** — Save the typed site identity (seo.site_settings)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `seo.site_settings` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "identity"
  ],
  "properties": {
    "identity": {
      "type": [
        "object",
        "null"
      ]
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
return {
  status: 200,
  body: await updateSiteIdentityOp(app, ctx, { identity: body.identity })
};
```

<a id="create_user"></a>

### POST /api/v1/users

**create_user** — Create a user with a role; invite token returned exactly once (users.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `users.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "display_name",
    "email",
    "role_key"
  ],
  "properties": {
    "display_name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "email": {
      "type": "string",
      "maxLength": 320
    },
    "role_key": {
      "type": "string",
      "maxLength": 64
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
return {
  status: 201,
  body: await createUserOp(app, ctx, {
    display_name: String(body.display_name),
    email: String(body.email),
    role_key: String(body.role_key)
  })
};
```

<a id="delete_user"></a>

### DELETE /api/v1/users/{userId}

**delete_user** — Hard-delete a user with credentials, sessions, MFA and tokens (users.manage). Last active OWNER and self-deletion are refused.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `users.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `userId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return { status: 200, body: await deleteUserOp(app, ctx, { user_id: params.userId }) };
```

<a id="update_user"></a>

### PUT /api/v1/users/{userId}

**update_user** — Edit a user's display name and/or primary email (users.manage). OWNER targets require the actor to hold OWNER.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `users.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `userId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "display_name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "email": {
      "type": "string",
      "maxLength": 320
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await updateUserOp(app, ctx, {
    user_id: params.userId,
    ...typeof body.display_name === "string" ? { display_name: body.display_name } : {},
    ...typeof body.email === "string" ? { email: body.email } : {}
  })
};
```

<a id="disable_user"></a>

### POST /api/v1/users/{userId}/disable

**disable_user** — Disable a user (last-OWNER invariant enforced server-side)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `users.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `userId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await disableEnableUserOp(app, ctx, {
    user_id: params.userId,
    disable: true,
    reason: "disabled via Admin"
  })
};
```

<a id="enable_user"></a>

### POST /api/v1/users/{userId}/enable

**enable_user** — Re-enable a disabled user

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `users.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `userId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await disableEnableUserOp(app, ctx, {
    user_id: params.userId,
    disable: false,
    reason: "enabled via Admin"
  })
};
```

<a id="reset_user_mfa"></a>

### DELETE /api/v1/users/{userId}/mfa

**reset_user_mfa** — Reset a user's TOTP enrollment (users.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `users.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `userId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return { status: 200, body: await resetUserMfaOp(app, ctx, { user_id: params.userId }) };
```

<a id="set_user_password"></a>

### PUT /api/v1/users/{userId}/password

**set_user_password** — Set a user's password after policy validation (users.manage). The user's sessions are revoked; a self change keeps the current session.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `users.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `userId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "new_password"
  ],
  "properties": {
    "new_password": {
      "type": "string",
      "minLength": 1,
      "maxLength": 1024
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await setUserPasswordOp(app, ctx, {
    user_id: params.userId,
    new_password: String(body.new_password)
  })
};
```

<a id="assign_role"></a>

### POST /api/v1/users/{userId}/roles

**assign_role** — Assign a role to a user (roles.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `roles.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `userId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "role_key"
  ],
  "properties": {
    "role_key": {
      "type": "string",
      "maxLength": 64
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await assignRoleOp(app, ctx, {
    user_id: params.userId,
    role_key: String(body.role_key)
  })
};
```

<a id="remove_role"></a>

### DELETE /api/v1/users/{userId}/roles/{roleKey}

**remove_role** — Remove a role from a user (roles.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `roles.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `userId`, `roleKey`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await assignRoleOp(app, ctx, {
    user_id: params.userId,
    role_key: params.roleKey,
    remove: true
  })
};
```

<a id="revoke_user_sessions"></a>

### POST /api/v1/users/{userId}/sessions/revoke

**revoke_user_sessions** — Revoke all sessions of a user (users.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `users.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `userId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await revokeUserSessionsOp(app, ctx, { user_id: params.userId })
};
```

<a id="create_user_with_password"></a>

### POST /api/v1/users/direct

**create_user_with_password** — Create a user with an initial password and role (users.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `users.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "display_name",
    "email",
    "role_key",
    "password"
  ],
  "properties": {
    "display_name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "email": {
      "type": "string",
      "maxLength": 320
    },
    "role_key": {
      "type": "string",
      "maxLength": 64
    },
    "password": {
      "type": "string",
      "minLength": 1,
      "maxLength": 1024
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
return {
  status: 201,
  body: await createUserWithPasswordOp(app, ctx, {
    display_name: String(body.display_name),
    email: String(body.email),
    role_key: String(body.role_key),
    password: String(body.password)
  })
};
```

<a id="rest-discovery"></a>

## discovery

Read effective contracts, rendering defaults and typed capabilities.

| Method/path | Operation | Purpose |
|---|---|---|
| `GET /api/v1/agent/bootstrap` | [get_agent_bootstrap](#get_agent_bootstrap) | Agent bootstrap: site, environment, actor/scopes, contracts, capabilities, installed skills, preview/domain readiness. |
| `POST /api/v1/analytics/doctor` | [analytics_doctor](#analytics_doctor) | Analytics installation diagnostics (config, render plan, slots, CSP) |
| `GET /api/v1/analytics/providers` | [list_analytics_providers](#list_analytics_providers) | Registered analytics tag providers (typed contract; no code surfaces) |
| `GET /api/v1/analytics/settings` | [get_analytics_settings](#get_analytics_settings) | Analytics & tagging settings with CAS generation (analytics.read) |
| `PUT /api/v1/analytics/settings` | [update_analytics_settings](#update_analytics_settings) | Save analytics & tagging settings (CAS; analytics.manage, rules need analytics.network.manage) |
| `GET /api/v1/audit` | [list_audit](#list_audit) | Security/audit events with filters (audit.read) |
| `GET /api/v1/capabilities` | [get_capabilities](#get_capabilities) | Actor-visible subsystem capabilities + contract versions (permission-filtered) |
| `GET /api/v1/discovery/blocks` | [list_block_types](#list_block_types) | Registered block types |
| `GET /api/v1/discovery/blocks/{typeId}` | [get_block_schema](#get_block_schema) | Full block schema (props, children policy, references) |
| `GET /api/v1/discovery/content/collection-capabilities` | [get_collection_capabilities](#get_collection_capabilities) | Collection DSL capabilities (typed allowlist, spec §14) |
| `GET /api/v1/discovery/content/field-types` | [list_field_types](#list_field_types) | Registered field types |
| `GET /api/v1/discovery/content/icons` | [list_icon_catalog](#list_icon_catalog) | Curated icon catalog for `icon` fields (advisory; values are format-validated, membership is not enforced). |
| `GET /api/v1/discovery/content/templates` | [list_compatible_templates](#list_compatible_templates) | Active-theme templates compatible with a content type (query: content_type) |
| `GET /api/v1/discovery/content/tree` | [list_content_tree](#list_content_tree) | Content Tree rows with kind (content&#124;folder), title/working/publication indicators (PCMS-ADMIN-T002) |
| `GET /api/v1/discovery/content/types` | [list_content_types](#list_content_types) | Registered content types (deterministic order) |
| `GET /api/v1/discovery/content/types/{key}` | [get_content_type_schema](#get_content_type_schema) | Full content type schema (round-trippable) |
| `GET /api/v1/discovery/navigation/placements` | [list_placement_bindings](#list_placement_bindings) | Theme-declared placements + current bindings |
| `GET /api/v1/discovery/navigation/sets` | [list_navigation_sets](#list_navigation_sets) | Navigation sets |
| `GET /api/v1/discovery/navigation/trees/{setRef}` | [get_navigation_tree](#get_navigation_tree) | Materialized navigation tree by set id or key |
| `GET /api/v1/discovery/routing/check` | [check_route_available](#check_route_available) | Route availability check (typed issues, no reservation) |
| `GET /api/v1/discovery/routing/policy` | [get_route_policy](#get_route_policy) | Route path policy for a site |
| `GET /api/v1/discovery/routing/resolve-entry` | [resolve_entry_url](#resolve_entry_url) | Canonical absolute URL for an entry (null when unrouted) |
| `GET /api/v1/discovery/seo/metadata/{entryId}` | [resolve_seo_metadata](#resolve_seo_metadata) | Effective SEO metadata (document → field fallback chain) |
| `GET /api/v1/discovery/seo/preview` | [preview_seo](#preview_seo) | SERV preview (title/description/robots/social) for an entry |
| `GET /api/v1/discovery/seo/schema` | [get_seo_schema](#get_seo_schema) | SEO document schema descriptor + diagnostics codes |
| `GET /api/v1/discovery/seo/structured-data` | [preview_structured_data](#preview_structured_data) | Composed JSON-LD preview for an entry |
| `GET /api/v1/discovery/seo/validate` | [validate_seo](#validate_seo) | Publish-level SEO validation report for an entry |
| `GET /api/v1/discovery/theme` | [get_theme_contract](#get_theme_contract) | Active theme contract snapshot (manifest, templates, placements) |
| `GET /api/v1/discovery/theme/templates` | [list_templates](#list_templates) | Theme templates with accepted content types |
| `GET /api/v1/entries/{entryId}/route` | [get_entry_route](#get_entry_route) | Canonical route view: current path, history, proposal (PCMS-ADMIN-T011) |
| `GET /api/v1/entries/{entryId}/seo` | [get_entry_seo](#get_entry_seo) | Stored SEO document for an entry (or null; PCMS-ADMIN-T010) |
| `GET /api/v1/external-identities/{namespace}/{externalId}` | [resolve_external_identity](#resolve_external_identity) | Resolve an external source item to its bound entry, with the human-edit reconciliation verdict (content.read). |
| `PUT /api/v1/external-identities/{namespace}/{externalId}` | [bind_external_identity](#bind_external_identity) | Bind an external source item to an entry and/or refresh the agent sync baseline (content.edit). |
| `GET /api/v1/localization` | [get_site_localization](#get_site_localization) | Site localization state: enabled locales, default, routing strategy. |
| `PUT /api/v1/localization` | [update_site_localization](#update_site_localization) | Enable/disable multilingual and edit the locale list (audited; theme capability validated on enable). |
| `GET /api/v1/maintenance` | [get_maintenance_state](#get_maintenance_state) | Maintenance Mode state and public page settings (site.maintenance). |
| `PUT /api/v1/maintenance` | [update_maintenance_state](#update_maintenance_state) | Toggle maintenance mode or edit its public page settings (audited). |
| `GET /api/v1/navigation/sets/{setId}/overrides` | [list_navigation_overrides](#list_navigation_overrides) | Derived-set overrides + stale ones (PCMS-ADMIN-T013) |
| `GET /api/v1/navigation/validate` | [validate_navigation](#validate_navigation) | Placement binding validation (depth/type/required) — PCMS-ADMIN-T013 |
| `DELETE /api/v1/registry/account-token` | [registry_account_token_clear](#registry_account_token_clear) | Remove the stored registry account token (extensions.manage; audited without the value). |
| `POST /api/v1/registry/account-token` | [registry_account_token_set](#registry_account_token_set) | Store the registry account token (write-only runtime secret; catalog access without rebind; extensions.manage). Never readable back, never logged. |
| `POST /api/v1/registry/apply-update` | [registry_apply_update](#registry_apply_update) | Download an engine release from the repository into incoming/ and apply it through the standard update orchestrator (extensions.manage) |
| `GET /api/v1/registry/index` | [registry_index](#registry_index) | Artifact repository catalog: packages (skills/extensions) and engine releases |
| `POST /api/v1/registry/install` | [registry_install_package](#registry_install_package) | Install an approved repository skill package (bytes stream through the existing fail-closed installer; skills.manage) |
| `GET /api/v1/registry/instance` | [registry_instance_get](#registry_instance_get) | This instance's registry binding identity: the stable instance code (generated on first read, shown in Admin for the account-area claim flow; NOT secret per owner decision). |
| `POST /api/v1/registry/instance/confirm` | [registry_instance_confirm](#registry_instance_confirm) | Registry v2 binding, phase 2: confirm the owner's pending claim and store the issued per-instance token (encrypted, never readable back). Last confirm wins. |
| `GET /api/v1/registry/instance/status` | [registry_instance_status](#registry_instance_status) | Binding status from the repository for this instance's code (unknown / unclaimed / pending / confirmed + account email). Registry unreachable → status unknown. |
| `GET /api/v1/registry/packages/{id}` | [registry_package_card](#registry_package_card) | Package card from the repository (description, versions, check status) |
| `POST /api/v1/registry/publish/{skillId}` | [registry_publish_skill](#registry_publish_skill) | Publish an installed community skill to the repository (upload goes through the account token; review pending) (skills.manage) |
| `POST /api/v1/registry/release-upload` | [registry_release_upload](#registry_release_upload) | Manual engine-release install for unregistered deployments: upload the release zip (application/octet-stream), it is validated (embedded update manifest, strictly newer version), staged into incoming/ with its checksum sidecar and applied through the standard update orchestrator (extensions.manage) |
| `GET /api/v1/registry/update-status` | [registry_update_status](#registry_update_status) | Latest update-orchestrator record plus the running cms version — the arbiter for async apply-update polling |
| `GET /api/v1/roles` | [list_roles](#list_roles) | Roles + permission registry + agent scope presets (roles.read) |
| `POST /api/v1/routing/redirect-imports/apply` | [apply_redirect_import](#apply_redirect_import) | Validate and apply a legacy-URL redirect batch atomically: any row or graph error aborts the whole import (routing.redirects.import) |
| `POST /api/v1/routing/redirect-imports/validate` | [validate_redirect_import](#validate_redirect_import) | Dry-run a legacy-URL redirect batch: per-row report + redirect-graph issues; writes nothing (routing.redirects.import) |
| `GET /api/v1/seo/indexnow` | [get_indexnow_settings](#get_indexnow_settings) | IndexNow settings + CAS generation + derived state (seo.read) |
| `PUT /api/v1/seo/indexnow` | [update_indexnow_settings](#update_indexnow_settings) | Save IndexNow settings (CAS; default disabled; enabling generates the key and queues at most one homepage verification) (seo.site_settings) |
| `POST /api/v1/seo/indexnow/check` | [check_indexnow](#check_indexnow) | Local configuration checks + enqueue the single homepage verification notification (seo.site_settings) |
| `POST /api/v1/seo/indexnow/rotate-key` | [rotate_indexnow_key](#rotate_indexnow_key) | Generate a fresh IndexNow key (pending jobs resolve the key at send time) (seo.site_settings) |
| `GET /api/v1/seo/indexnow/status` | [get_indexnow_status](#get_indexnow_status) | IndexNow delivery status: state, key file URL, pending count, diagnostics (seo.read) |
| `GET /api/v1/service-accounts` | [list_service_accounts](#list_service_accounts) | Service accounts (tokens.manage) |
| `GET /api/v1/service-accounts/{accountId}/tokens` | [list_access_tokens](#list_access_tokens) | Access tokens of a service account (prefix only; tokens.manage) |
| `GET /api/v1/settings/site-identity` | [get_site_identity](#get_site_identity) | Typed site identity (SEO+Theme defaults; seo.read) |
| `GET /api/v1/site` | [get_site_info](#get_site_info) | Baseline site identity, route policy, home binding and domains |
| `GET /api/v1/site/domains` | [list_site_domains](#list_site_domains) | Domain bindings of a site (?site= key, default site). Permission: domains.manage |
| `POST /api/v1/site/domains` | [add_site_domain](#add_site_domain) | Add a domain binding (hostname normalized/validated; first binding of a site becomes primary; atomic single-primary invariant). Permission: domains.manage |
| `DELETE /api/v1/site/domains/{hostname}` | [remove_site_domain](#remove_site_domain) | Remove a binding. The last remaining binding is undeletable (a site without a canonical origin cannot generate absolute URLs); removing the primary promotes the first remaining. Permission: domains.manage |
| `PATCH /api/v1/site/domains/{hostname}` | [patch_site_domain](#patch_site_domain) | Patch a binding: is_primary=true switches the canonical primary atomically. Permission: domains.manage |
| `GET /api/v1/skills` | [list_skills](#list_skills) | Installed skills across both roots with origin/trust/enabled (community management needs skills.manage) |
| `DELETE /api/v1/skills/{id}` | [uninstall_skill](#uninstall_skill) | Uninstall a community skill (skills.manage) |
| `POST /api/v1/skills/{id}/disable` | [disable_skill](#disable_skill) | Hide a community skill from agents without uninstalling (skills.manage) |
| `POST /api/v1/skills/{id}/enable` | [enable_skill](#enable_skill) | Re-enable a disabled community skill (skills.manage) |
| `POST /api/v1/skills/install` | [install_skill](#install_skill) | Install a .pcskill package (skills.manage; community skills must be enabled). Body: JSON {url} to fetch, or the raw package as application/octet-stream (the agent authoring path) |
| `GET /api/v1/skills/sample.zip` | [download_skill_sample](#download_skill_sample) | Skeleton .pcskill package to fork into a community skill |
| `GET /api/v1/system/metrics` | [get_system_metrics](#get_system_metrics) | Recent runtime metric samples (CPU / memory / queue window) |
| `GET /api/v1/system/status` | [get_system_status](#get_system_status) | Doctor-style snapshot: site, migration head, queue, storage, theme (site.validate; no secrets) |
| `GET /api/v1/theme/state` | [get_theme_state](#get_theme_state) | Active theme + working settings + manifest settings (PCMS-ADMIN-T019) |
| `GET /api/v1/users` | [list_users](#list_users) | Admin users with roles and MFA status (users.read) |

<a id="get_agent_bootstrap"></a>

### GET /api/v1/agent/bootstrap

**get_agent_bootstrap** — Agent bootstrap: site, environment, actor/scopes, contracts, capabilities, installed skills, preview/domain readiness.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/agent.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 200,
  body: await getAgentBootstrapOp(app, ctx)
};
```

<a id="analytics_doctor"></a>

### POST /api/v1/analytics/doctor

**analytics_doctor** — Analytics installation diagnostics (config, render plan, slots, CSP)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `analytics.read` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/analytics.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await analyticsDoctorOp(app, ctx) };
```

<a id="list_analytics_providers"></a>

### GET /api/v1/analytics/providers

**list_analytics_providers** — Registered analytics tag providers (typed contract; no code surfaces)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `analytics.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/analytics.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await listAnalyticsProvidersOp(app) };
```

<a id="get_analytics_settings"></a>

### GET /api/v1/analytics/settings

**get_analytics_settings** — Analytics & tagging settings with CAS generation (analytics.read)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `analytics.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/analytics.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await getAnalyticsSettingsOp(app, ctx) };
```

<a id="update_analytics_settings"></a>

### PUT /api/v1/analytics/settings

**update_analytics_settings** — Save analytics & tagging settings (CAS; analytics.manage, rules need analytics.network.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `analytics.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/analytics.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "settings",
    "expected_generation"
  ],
  "properties": {
    "settings": {
      "type": "object"
    },
    "expected_generation": {
      "type": "integer",
      "minimum": 0
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body;
return {
  status: 200,
  body: await saveAnalyticsSettingsOp(app, ctx, {
    settings: body.settings,
    expected_generation: body.expected_generation
  })
};
```

<a id="list_audit"></a>

### GET /api/v1/audit

**list_audit** — Security/audit events with filters (audit.read)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `audit.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "event_type": {
      "type": "string",
      "maxLength": 64
    },
    "actor_type": {
      "type": "string",
      "maxLength": 32
    },
    "actor_id": {
      "type": "string",
      "maxLength": 64
    },
    "transport": {
      "type": "string",
      "maxLength": 16
    },
    "limit": {
      "type": "string",
      "pattern": "^[0-9]+$"
    },
    "offset": {
      "type": "string",
      "pattern": "^[0-9]+$"
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
return {
  status: 200,
  body: await listAuditOp(app, ctx, {
    ...query.event_type === void 0 ? {} : { event_type: query.event_type },
    ...query.actor_type === void 0 ? {} : { actor_type: query.actor_type },
    ...query.actor_id === void 0 ? {} : { actor_id: query.actor_id },
    ...query.transport === void 0 ? {} : { transport: query.transport },
    ...query.limit === void 0 ? {} : { limit: Number(query.limit) },
    ...query.offset === void 0 ? {} : { offset: Number(query.offset) }
  })
};
```

<a id="get_capabilities"></a>

### GET /api/v1/capabilities

**get_capabilities** — Actor-visible subsystem capabilities + contract versions (permission-filtered)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const has = (permission, installed = true) => installed && ctx.actor.permissions.has(permission);
return {
  status: 200,
  body: {
    contract_versions: {
      api: "1.0.0",
      theme: THEME_CONTRACT_VERSION,
      block_document: BLOCK_DOCUMENT_SCHEMA_VERSION,
      bundle: 1,
      pcpub: 1,
      pcmd: 1
    },
    content: {
      installed: true,
      read: has("content.read"),
      create: has("content.create"),
      edit: has("content.edit"),
      archive: has("content.archive"),
      schema_read: has("content_schema.read"),
      rich_text: {
        readable_versions: RICHTEXT_AST_VERSIONS,
        write_version: 2,
        node_types: RICHTEXT_NODE_TYPES
      }
    },
    blocks: {
      installed: true,
      document_limit: MAX_BLOCKS_PER_DOCUMENT,
      read: has("content.read")
    },
    themes: {
      installed: app.themeDiscovery !== null,
      read: has("theme.read"),
      validate: has("theme.validate"),
      preview: has("theme.preview"),
      activate: has("theme.activate"),
      // M10 shipped the active-theme store (migration 1000);
      // activation is available whenever a theme source is configured.
      activation_available: app.themeDiscovery !== null
    },
    navigation: { installed: true, read: has("navigation.read") },
    media: {
      installed: app.mediaStorage !== null,
      read: has("media.read"),
      write: has("media.write"),
      import: has("media.import")
    },
    seo: {
      installed: true,
      scopes: app.seoDiscovery.scopes,
      read: has("seo.read")
    },
    publication: {
      installed: true,
      read: has("publication.read"),
      plan: has("publication.plan"),
      schedule: has("publication.schedule"),
      publish: has("publication.publish")
    },
    // Search is fully shipped (M11): the index, the public query and
    // the authorized Admin search all live behind /search/*. The
    // Admin search screen is gated by search.admin; index operations
    // by search.diagnostics / search.reindex.
    search: {
      installed: true,
      read: has("search.admin"),
      diagnostics: has("search.diagnostics"),
      reindex: has("search.reindex")
    },
    interactions: {
      installed: true,
      forms: { read: has("forms.read_definition"), manage: has("forms.manage_definition") },
      quizzes: {
        read: has("quizzes.read_definition"),
        manage: has("quizzes.manage_definition")
      },
      interactions: {
        read: has("interactions.read"),
        manage: has("interactions.manage"),
        export: has("interactions.export")
      },
      leads: {
        read: has("leads.read"),
        manage: has("leads.manage"),
        export: has("leads.export")
      }
    },
    integrations: { installed: true, read: has("integrations.read") },
    payments: { installed: true, read: has("payments.read") },
    // .pcpub ingest (ADR-0014, API spec §81.2): the physical format
    // versions, the contracts bundles may require, block versions the
    // target accepts and the ingest limits — packers preflight here,
    // the server re-checks authoritatively at ingest.
    pcpub: {
      installed: true,
      read: has("content.read"),
      submit: has("content.create"),
      pcpub_versions: [PCPUB_VERSION, 2],
      external_entries: {
        supported: true,
        pcpub_version: 2,
        required_scope: "content.read"
      },
      pcmd_versions: [PCMD_VERSION],
      bundle_contract: BUNDLE_CONTRACT,
      content_contract: CONTENT_CONTRACT,
      supported_block_versions: app.blocks.listBlockTypeVersions(),
      bundle_limits: pcpubLimitsFrom(app),
      accepted_asset_mime: PCPUB_ACCEPTED_ASSET_MIME
    }
  }
};
```

<a id="list_block_types"></a>

### GET /api/v1/discovery/blocks

**list_block_types** — Registered block types

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: { items: app.blockDiscovery.listBlockTypes() } };
```

<a id="get_block_schema"></a>

### GET /api/v1/discovery/blocks/{typeId}

**get_block_schema** — Full block schema (props, children policy, references)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |
| Handler-local error codes (not the whole domain error set) | `API_NOT_FOUND` |

Path parameters: `typeId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const query = request.query;
const version = typeof query.version === "string" && /^\d+$/.test(query.version) ? Number(query.version) : void 0;
const latestVersion = app.blockDiscovery.listBlockTypes().find((summary) => summary.typeId === params.typeId)?.versions.at(-1);
const effectiveVersion = version ?? latestVersion;
const schema = effectiveVersion === void 0 ? null : app.blockDiscovery.getBlockSchema(params.typeId, effectiveVersion);
return { status: 200, body: schema };
```

<a id="get_collection_capabilities"></a>

### GET /api/v1/discovery/content/collection-capabilities

**get_collection_capabilities** — Collection DSL capabilities (typed allowlist, spec §14)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: app.contentDiscovery.getCollectionCapabilities() };
```

<a id="list_field_types"></a>

### GET /api/v1/discovery/content/field-types

**list_field_types** — Registered field types

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: { items: app.contentDiscovery.listFieldTypes() } };
```

<a id="list_icon_catalog"></a>

### GET /api/v1/discovery/content/icons

**list_icon_catalog** — Curated icon catalog for `icon` fields (advisory; values are format-validated, membership is not enforced).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: { items: ICON_CATALOG_V1 } };
```

<a id="list_compatible_templates"></a>

### GET /api/v1/discovery/content/templates

**list_compatible_templates** — Active-theme templates compatible with a content type (query: content_type)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "content_type"
  ],
  "properties": {
    "content_type": {
      "type": "string",
      "maxLength": 64
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
return {
  status: 200,
  body: await listCompatibleTemplatesOp(
    app,
    ctx,
    typeof query.content_type === "string" ? query.content_type : ""
  )
};
```

<a id="list_content_tree"></a>

### GET /api/v1/discovery/content/tree

**list_content_tree** — Content Tree rows with kind (content|folder), title/working/publication indicators (PCMS-ADMIN-T002)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "include_archived": {
      "type": "string",
      "enum": [
        "true",
        "false"
      ]
    },
    "limit": {
      "type": "string",
      "pattern": "^[0-9]+$"
    },
    "cursor": {
      "type": "string"
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
return {
  status: 200,
  body: await listContentTree(app, ctx, {
    include_archived: query.include_archived === "true",
    ...query.limit === void 0 ? {} : { limit: query.limit },
    ...query.cursor === void 0 ? {} : { cursor: query.cursor }
  })
};
```

<a id="list_content_types"></a>

### GET /api/v1/discovery/content/types

**list_content_types** — Registered content types (deterministic order)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: { items: app.contentDiscovery.listContentTypes() } };
```

<a id="get_content_type_schema"></a>

### GET /api/v1/discovery/content/types/{key}

**get_content_type_schema** — Full content type schema (round-trippable)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |
| Handler-local error codes (not the whole domain error set) | `API_NOT_FOUND` |

Path parameters: `key`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const query = request.query;
const schema = typeof query.version === "string" && /^\d+$/.test(query.version) ? app.contentDiscovery.getContentTypeSchema(params.key, Number(query.version)) : app.contentDiscovery.getLatestContentTypeSchema(params.key);
return { status: 200, body: schema };
```

<a id="list_placement_bindings"></a>

### GET /api/v1/discovery/navigation/placements

**list_placement_bindings** — Theme-declared placements + current bindings

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 200,
  body: {
    placements: app.navigationDiscovery.listPlacements(),
    bindings: await app.navigationDiscovery.getPlacementBindings()
  }
};
```

<a id="list_navigation_sets"></a>

### GET /api/v1/discovery/navigation/sets

**list_navigation_sets** — Navigation sets

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: { items: await app.navigationDiscovery.listNavigationSets() } };
```

<a id="get_navigation_tree"></a>

### GET /api/v1/discovery/navigation/trees/{setRef}

**get_navigation_tree** — Materialized navigation tree by set id or key

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: `setRef`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: { items: await app.navigationDiscovery.getNavigationTree(params.setRef) }
};
```

<a id="check_route_available"></a>

### GET /api/v1/discovery/routing/check

**check_route_available** — Route availability check (typed issues, no reservation)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `site.validate` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
const siteRef = typeof query.site === "string" ? query.site : app.defaultSiteKey;
return {
  status: 200,
  body: await app.routingDiscovery.checkRouteAvailable(query.path, siteRef)
};
```

<a id="get_route_policy"></a>

### GET /api/v1/discovery/routing/policy

**get_route_policy** — Route path policy for a site

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
const siteRef = typeof query.site === "string" ? query.site : app.defaultSiteKey;
return { status: 200, body: await app.routingDiscovery.getRoutePolicy(siteRef) };
```

<a id="resolve_entry_url"></a>

### GET /api/v1/discovery/routing/resolve-entry

**resolve_entry_url** — Canonical absolute URL for an entry (null when unrouted)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
const entryId = stableId(query.entry_id, "entry_id");
return {
  status: 200,
  body: { url: await app.routingDiscovery.resolveEntryUrl(entryId) }
};
```

<a id="resolve_seo_metadata"></a>

### GET /api/v1/discovery/seo/metadata/{entryId}

**resolve_seo_metadata** — Effective SEO metadata (document → field fallback chain)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `seo.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |
| Handler-local error codes (not the whole domain error set) | `API_NOT_FOUND` |

Path parameters: `entryId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const resolved = await app.seoDiscovery.resolveSeoMetadataFor(
  stableId(params.entryId, "entryId")
);
return { status: 200, body: resolved };
```

<a id="preview_seo"></a>

### GET /api/v1/discovery/seo/preview

**preview_seo** — SERV preview (title/description/robots/social) for an entry

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `seo.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |
| Handler-local error codes (not the whole domain error set) | `API_NOT_FOUND` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
const entryId = stableId(query.entry_id, "entry_id");
const preview = await app.seoDiscovery.previewSeoFor(entryId, {
  openGraph: true,
  materializeSocial: true
});
return { status: 200, body: preview };
```

<a id="get_seo_schema"></a>

### GET /api/v1/discovery/seo/schema

**get_seo_schema** — SEO document schema descriptor + diagnostics codes

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `seo.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: app.seoDiscovery.getSeoSchema() };
```

<a id="preview_structured_data"></a>

### GET /api/v1/discovery/seo/structured-data

**preview_structured_data** — Composed JSON-LD preview for an entry

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `seo.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |
| Handler-local error codes (not the whole domain error set) | `API_NOT_FOUND` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
const entryId = stableId(query.entry_id, "entry_id");
const preview = await app.seoDiscovery.previewSeoFor(entryId);
return { status: 200, body: { structured_data: preview.structured_data } };
```

<a id="validate_seo"></a>

### GET /api/v1/discovery/seo/validate

**validate_seo** — Publish-level SEO validation report for an entry

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `seo.validate` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 200,
  body: await validateEntrySeoOp(
    app,
    ctx,
    stableId(request.query.entry_id, "entry_id")
  )
};
```

<a id="get_theme_contract"></a>

### GET /api/v1/discovery/theme

**get_theme_contract** — Active theme contract snapshot (manifest, templates, placements)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `theme.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const theme = requireTheme(app);
return {
  status: 200,
  body: {
    available: true,
    contract_version: theme.getThemeContractVersion(),
    theme_id: theme.getThemeId(),
    manifest_json_schema: THEME_MANIFEST_JSON_SCHEMA,
    ...theme.describeTheme()
  }
};
```

<a id="list_templates"></a>

### GET /api/v1/discovery/theme/templates

**list_templates** — Theme templates with accepted content types

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `theme.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: { items: requireTheme(app).listTemplates() } };
```

<a id="get_entry_route"></a>

### GET /api/v1/entries/{entryId}/route

**get_entry_route** — Canonical route view: current path, history, proposal (PCMS-ADMIN-T011)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: `entryId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await getEntryRoute(app, ctx, { entry_id: stableId(params.entryId, "entryId") })
};
```

<a id="get_entry_seo"></a>

### GET /api/v1/entries/{entryId}/seo

**get_entry_seo** — Stored SEO document for an entry (or null; PCMS-ADMIN-T010)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `seo.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: `entryId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await getEntrySeo(app, ctx, { entry_id: stableId(params.entryId, "entryId") })
};
```

<a id="resolve_external_identity"></a>

### GET /api/v1/external-identities/{namespace}/{externalId}

**resolve_external_identity** — Resolve an external source item to its bound entry, with the human-edit reconciliation verdict (content.read).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/agent.ts` |

Path parameters: `namespace`, `externalId`.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "source_hash": {
      "type": "string",
      "maxLength": 256
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const { namespace, externalId } = pathParams(request);
const query = request.query ?? {};
const body = await resolveExternalIdentityOp(app, ctx, namespace, externalId, {
  ...typeof query.source_hash === "string" ? { sourceHash: query.source_hash } : {}
});
return { status: 200, body };
```

<a id="bind_external_identity"></a>

### PUT /api/v1/external-identities/{namespace}/{externalId}

**bind_external_identity** — Bind an external source item to an entry and/or refresh the agent sync baseline (content.edit).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `content.edit` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/agent.ts` |

Path parameters: `namespace`, `externalId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "entry_id"
  ],
  "properties": {
    "entry_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    },
    "source_hash": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256
    },
    "last_agent_generation": {
      "type": "integer",
      "minimum": 0
    },
    "run_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const { namespace, externalId } = pathParams(request);
const input = jsonBody(request);
const body = await bindExternalIdentityOp(app, ctx, namespace, externalId, input);
return { status: 200, body };
```

<a id="get_site_localization"></a>

### GET /api/v1/localization

**get_site_localization** — Site localization state: enabled locales, default, routing strategy.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `site.configure` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/localization.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, () => getSiteLocalizationOp(app, ctx));
```

<a id="update_site_localization"></a>

### PUT /api/v1/localization

**update_site_localization** — Enable/disable multilingual and edit the locale list (audited; theme capability validated on enable).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `site.configure` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/localization.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "enabled",
    "default_locale",
    "locales"
  ],
  "properties": {
    "enabled": {
      "type": "boolean"
    },
    "default_locale": {
      "type": "string",
      "minLength": 2,
      "maxLength": 35
    },
    "locales": {
      "type": "array",
      "minItems": 1,
      "maxItems": 16,
      "items": {
        "type": "string",
        "minLength": 2,
        "maxLength": 35
      }
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, () => updateSiteLocalizationOp(app, ctx, jsonBody(request)));
```

<a id="get_maintenance_state"></a>

### GET /api/v1/maintenance

**get_maintenance_state** — Maintenance Mode state and public page settings (site.maintenance).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `site.maintenance` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/maintenance.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, () => getMaintenanceStateOp(app, ctx));
```

<a id="update_maintenance_state"></a>

### PUT /api/v1/maintenance

**update_maintenance_state** — Toggle maintenance mode or edit its public page settings (audited).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `site.maintenance` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/maintenance.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "enabled": {
      "type": "boolean"
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "message": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000
    },
    "promoLabel": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "promoUrl": {
      "type": "string",
      "maxLength": 500
    },
    "retryAfterSeconds": {
      "type": "integer",
      "minimum": 60,
      "maximum": 86400
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(
  app,
  ctx,
  () => updateMaintenanceStateOp(
    app,
    ctx,
    jsonBody(request)
  )
);
```

<a id="list_navigation_overrides"></a>

### GET /api/v1/navigation/sets/{setId}/overrides

**list_navigation_overrides** — Derived-set overrides + stale ones (PCMS-ADMIN-T013)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `setId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await listNavigationOverrides(app, ctx, { set_id: params.setId })
};
```

<a id="validate_navigation"></a>

### GET /api/v1/navigation/validate

**validate_navigation** — Placement binding validation (depth/type/required) — PCMS-ADMIN-T013

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `navigation.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await validateNavigationOp(app, ctx) };
```

<a id="registry_account_token_clear"></a>

### DELETE /api/v1/registry/account-token

**registry_account_token_clear** — Remove the stored registry account token (extensions.manage; audited without the value).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/registry.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: { set: false } };
```

<a id="registry_account_token_set"></a>

### POST /api/v1/registry/account-token

**registry_account_token_set** — Store the registry account token (write-only runtime secret; catalog access without rebind; extensions.manage). Never readable back, never logged.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/registry.ts` |
| Handler-local error codes (not the whole domain error set) | `REGISTRY_ACCOUNT_TOKEN_INVALID` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "token"
  ],
  "properties": {
    "token": {
      "type": "string",
      "minLength": 16,
      "maxLength": 512
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body;
return { status: 200, body: { set: true } };
```

<a id="registry_apply_update"></a>

### POST /api/v1/registry/apply-update

**registry_apply_update** — Download an engine release from the repository into incoming/ and apply it through the standard update orchestrator (extensions.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/registry.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "version"
  ],
  "properties": {
    "version": {
      "type": "string",
      "minLength": 1,
      "maxLength": 32
    },
    "wait": {
      "type": "boolean"
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body;
const version = typeof body.version === "string" ? body.version : "";
const wait = body.wait !== false;
return {
  status: 200,
  body: await registryApplyUpdateOp(app, ctx, version, { wait })
};
```

<a id="registry_index"></a>

### GET /api/v1/registry/index

**registry_index** — Artifact repository catalog: packages (skills/extensions) and engine releases

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/registry.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const index = await wrapRegistry(() => registryOf(app).index());
return { status: 200, body: { configured: false, packages: [], releases: [] } };
return { status: 200, body: { configured: true, ...index } };
```

<a id="registry_install_package"></a>

### POST /api/v1/registry/install

**registry_install_package** — Install an approved repository skill package (bytes stream through the existing fail-closed installer; skills.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `skills.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/registry.ts` |
| Handler-local error codes (not the whole domain error set) | `SKILLS_COMMUNITY_DISABLED` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "download_url"
  ],
  "properties": {
    "download_url": {
      "type": "string",
      "minLength": 8,
      "maxLength": 2048
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body;
const url = typeof body.download_url === "string" ? body.download_url : "";
const bytes = await wrapRegistry(() => registryOf(app).download(url));
const result = await installSkillPackage(bytes, {
  communityDir: app.communitySkillsDir,
  firstPartyIds: (await import("@pcms/skills")).loadInstalledSkills(app.skillsDir).skills.map(({ manifest }) => manifest.id),
  isRegisteredPermission: (scope) => PERMISSION_REGISTRY.some((definition) => definition.key === scope),
  source: url
});
return { status: 201, body: { id: result.skill.manifest.id, sha256: result.sha256 } };
```

<a id="registry_instance_get"></a>

### GET /api/v1/registry/instance

**registry_instance_get** — This instance's registry binding identity: the stable instance code (generated on first read, shown in Admin for the account-area claim flow; NOT secret per owner decision).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/registry.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const code = await app.registryInstanceCode.read();
const accountToken = await app.registryAccountTokenRuntime.read();
return {
  status: 200,
  body: {
    instance_code: code,
    report_updates: app.registryReportUpdates === true,
    account_token_set: accountToken !== null || app.registryAccountToken !== null
  }
};
```

<a id="registry_instance_confirm"></a>

### POST /api/v1/registry/instance/confirm

**registry_instance_confirm** — Registry v2 binding, phase 2: confirm the owner's pending claim and store the issued per-instance token (encrypted, never readable back). Last confirm wins.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/registry.ts` |
| Handler-local error codes (not the whole domain error set) | `REGISTRY_CODE_UNKNOWN` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const code = await app.registryInstanceCode.read();
const confirmed = await registryOf(app).confirmInstance(code);
return { status: 200, body: { bound: true, account_email: confirmed.account_email } };
```

<a id="registry_instance_status"></a>

### GET /api/v1/registry/instance/status

**registry_instance_status** — Binding status from the repository for this instance's code (unknown / unclaimed / pending / confirmed + account email). Registry unreachable → status unknown.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/registry.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const code = await app.registryInstanceCode.read();
const status = await registryOf(app).confirmStatus(code);
return { status: 200, body: { status: "unclaimed" } };
return { status: 200, body: { instance_code: code, ...status } };
return { status: 200, body: { instance_code: code, status: "unknown" } };
```

<a id="registry_package_card"></a>

### GET /api/v1/registry/packages/{id}

**registry_package_card** — Package card from the repository (description, versions, check status)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/registry.ts` |

Path parameters: `id`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const card = await wrapRegistry(() => registryOf(app).packageCard(params.id));
return { status: 200, body: card };
```

<a id="registry_publish_skill"></a>

### POST /api/v1/registry/publish/{skillId}

**registry_publish_skill** — Publish an installed community skill to the repository (upload goes through the account token; review pending) (skills.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `skills.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/registry.ts` |
| Handler-local error codes (not the whole domain error set) | `REGISTRY_NOT_CONFIGURED`, `REGISTRY_PUBLISH_FAILED`, `SKILL_ID_FORBIDDEN`, `SKILL_NOT_FOUND` |

Path parameters: `skillId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const skill = loadCommunitySkills(app.communitySkillsDir).skills.find(
  (candidate) => candidate.manifest.id === params.skillId
);
const bytes = await zipSkillDirectory(skill.directory);
const token = await app.registryAccountTokenRuntime.read() ?? app.registryAccountToken;
const base = registryOf(app).baseUrl;
const response = await fetch(`${base}/api/v1/publish`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
  body: new Uint8Array(bytes),
  signal: AbortSignal.timeout(3e4)
});
const result = await response.json();
return { status: 200, body: { published: true, registry: result } };
```

<a id="registry_release_upload"></a>

### POST /api/v1/registry/release-upload

**registry_release_upload** — Manual engine-release install for unregistered deployments: upload the release zip (application/octet-stream), it is validated (embedded update manifest, strictly newer version), staged into incoming/ with its checksum sidecar and applied through the standard update orchestrator (extensions.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 134217728 bytes |
| Source | `packages/api/src/http/routes/registry.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID`, `UPDATE_MANIFEST_INVALID`, `UPDATE_NOT_AN_UPGRADE` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const bytes = request.body;
const sha256 = createHash("sha256").update(bytes).digest("hex");
const manifest = await extractUpdateManifest(bytes);
const targetVersion = String(manifest.version ?? "");
const artifactName = `progressive-cms-registry-${targetVersion}.zip`;
const applied = await applyUpdate(app, ctx, {
  manifest,
  backup_confirmation: targetVersion,
  confirmed_from_registry: true
});
return { status: 200, body: { staged: artifactName, sha256, update: applied } };
```

<a id="registry_update_status"></a>

### GET /api/v1/registry/update-status

**registry_update_status** — Latest update-orchestrator record plus the running cms version — the arbiter for async apply-update polling

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/registry.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const record = await latestUpdateRecord(app.pool);
return {
  status: 200,
  body: {
    current_version: currentCmsVersion(app),
    deployment: {
      running_version: currentCmsVersion(app),
      running_release_id: app.releaseId,
      selected: app.selectedReleaseStatus?.() ?? null
    },
    update: record === null ? null : {
      id: record.id,
      status: record.status,
      from_version: record.fromVersion,
      to_version: record.toVersion,
      failure_code: record.failureCode ?? null,
      backup_warnings: record.validationSummary.backup_warnings ?? [],
      started_at: record.startedAt.toISOString(),
      completed_at: record.completedAt?.toISOString() ?? null
    }
  }
};
```

<a id="list_roles"></a>

### GET /api/v1/roles

**list_roles** — Roles + permission registry + agent scope presets (roles.read)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `roles.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await listRolesOp(app, ctx) };
```

<a id="apply_redirect_import"></a>

### POST /api/v1/routing/redirect-imports/apply

**apply_redirect_import** — Validate and apply a legacy-URL redirect batch atomically: any row or graph error aborts the whole import (routing.redirects.import)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `routing.redirects.import` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/routing.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "rows"
  ],
  "properties": {
    "site": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "rows": {
      "type": "array",
      "minItems": 1,
      "maxItems": 10000,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "source"
        ],
        "properties": {
          "source": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "target": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 500
          },
          "status_code": {
            "type": "integer",
            "enum": [
              301,
              302,
              307,
              308,
              410
            ]
          },
          "reason": {
            "type": "string",
            "maxLength": 200
          }
        }
      }
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 200,
  body: await applyRedirectImportOp(app, ctx, bodyOf(request))
};
```

<a id="validate_redirect_import"></a>

### POST /api/v1/routing/redirect-imports/validate

**validate_redirect_import** — Dry-run a legacy-URL redirect batch: per-row report + redirect-graph issues; writes nothing (routing.redirects.import)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `routing.redirects.import` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/routing.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "rows"
  ],
  "properties": {
    "site": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "rows": {
      "type": "array",
      "minItems": 1,
      "maxItems": 10000,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "source"
        ],
        "properties": {
          "source": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "target": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 500
          },
          "status_code": {
            "type": "integer",
            "enum": [
              301,
              302,
              307,
              308,
              410
            ]
          },
          "reason": {
            "type": "string",
            "maxLength": 200
          }
        }
      }
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 200,
  body: await validateRedirectImportOp(app, ctx, bodyOf(request))
};
```

<a id="get_indexnow_settings"></a>

### GET /api/v1/seo/indexnow

**get_indexnow_settings** — IndexNow settings + CAS generation + derived state (seo.read)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `seo.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/seo-indexnow.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await getIndexNowSettingsOp(app, ctx) };
```

<a id="update_indexnow_settings"></a>

### PUT /api/v1/seo/indexnow

**update_indexnow_settings** — Save IndexNow settings (CAS; default disabled; enabling generates the key and queues at most one homepage verification) (seo.site_settings)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `seo.site_settings` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/seo-indexnow.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "settings",
    "expected_generation"
  ],
  "properties": {
    "settings": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "enabled"
      ],
      "properties": {
        "enabled": {
          "type": "boolean"
        },
        "notifyOnPublish": {
          "type": "boolean"
        },
        "notifyOnUpdate": {
          "type": "boolean"
        },
        "notifyOnUnpublish": {
          "type": "boolean"
        },
        "notifyOnRouteChange": {
          "type": "boolean"
        }
      }
    },
    "expected_generation": {
      "type": "integer",
      "minimum": 0
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body;
const result = await saveIndexNowSettingsOp(app, ctx, {
  settings: {
    enabled: body.settings.enabled,
    ...typeof body.settings.notifyOnPublish === "boolean" ? { notifyOnPublish: body.settings.notifyOnPublish } : {},
    ...typeof body.settings.notifyOnUpdate === "boolean" ? { notifyOnUpdate: body.settings.notifyOnUpdate } : {},
    ...typeof body.settings.notifyOnUnpublish === "boolean" ? { notifyOnUnpublish: body.settings.notifyOnUnpublish } : {},
    ...typeof body.settings.notifyOnRouteChange === "boolean" ? { notifyOnRouteChange: body.settings.notifyOnRouteChange } : {}
  },
  expected_generation: body.expected_generation
});
return { status: 200, body: result };
```

<a id="check_indexnow"></a>

### POST /api/v1/seo/indexnow/check

**check_indexnow** — Local configuration checks + enqueue the single homepage verification notification (seo.site_settings)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `seo.site_settings` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/seo-indexnow.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await checkIndexNowOp(app, ctx) };
```

<a id="rotate_indexnow_key"></a>

### POST /api/v1/seo/indexnow/rotate-key

**rotate_indexnow_key** — Generate a fresh IndexNow key (pending jobs resolve the key at send time) (seo.site_settings)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `seo.site_settings` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/seo-indexnow.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await rotateIndexNowKeyOp(app, ctx) };
```

<a id="get_indexnow_status"></a>

### GET /api/v1/seo/indexnow/status

**get_indexnow_status** — IndexNow delivery status: state, key file URL, pending count, diagnostics (seo.read)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `seo.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/seo-indexnow.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await getIndexNowStatusOp(app) };
```

<a id="list_service_accounts"></a>

### GET /api/v1/service-accounts

**list_service_accounts** — Service accounts (tokens.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `tokens.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await listServiceAccountsOp(app, ctx) };
```

<a id="list_access_tokens"></a>

### GET /api/v1/service-accounts/{accountId}/tokens

**list_access_tokens** — Access tokens of a service account (prefix only; tokens.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `tokens.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `accountId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await listAccessTokensOp(app, ctx, { account_id: params.accountId })
};
```

<a id="get_site_identity"></a>

### GET /api/v1/settings/site-identity

**get_site_identity** — Typed site identity (SEO+Theme defaults; seo.read)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `seo.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await getSiteIdentityOp(app, ctx) };
```

<a id="get_site_info"></a>

### GET /api/v1/site

**get_site_info** — Baseline site identity, route policy, home binding and domains

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |
| Handler-local error codes (not the whole domain error set) | `SITE_NOT_FOUND` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
const siteKey = typeof query.site === "string" && query.site.length > 0 ? query.site : app.defaultSiteKey;
const site = await app.routes.findSiteByKey(siteKey);
const [policy, domains] = await Promise.all([
  app.routes.getPolicy(site.id),
  app.domains.listDomainBindings(site.id)
]);
return {
  status: 200,
  body: {
    site: { id: site.id, key: site.key, title: site.title },
    route_policy: policy,
    domains: domains.map((binding) => ({
      hostname: binding.hostname,
      is_primary: binding.isPrimary,
      locale: binding.locale
    }))
  }
};
```

<a id="list_site_domains"></a>

### GET /api/v1/site/domains

**list_site_domains** — Domain bindings of a site (?site= key, default site). Permission: domains.manage

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `domains.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "site": {
      "type": "string",
      "minLength": 1
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
return {
  status: 200,
  body: await listSiteDomainsOp(app, siteKeyOf(query, app.defaultSiteKey))
};
```

<a id="add_site_domain"></a>

### POST /api/v1/site/domains

**add_site_domain** — Add a domain binding (hostname normalized/validated; first binding of a site becomes primary; atomic single-primary invariant). Permission: domains.manage

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `domains.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "hostname"
  ],
  "properties": {
    "hostname": {
      "type": "string",
      "minLength": 3,
      "maxLength": 253
    },
    "is_primary": {
      "type": "boolean"
    },
    "scheme_policy": {
      "enum": [
        "https",
        "http"
      ]
    },
    "canonical_redirect_policy": {
      "enum": [
        "redirect",
        "serve"
      ]
    },
    "locale": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 16
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
return {
  status: 201,
  body: await addSiteDomainOp(app, siteKeyOf(body, app.defaultSiteKey), {
    hostname: String(body.hostname),
    ...body.is_primary === void 0 ? {} : { is_primary: body.is_primary === true },
    ...typeof body.scheme_policy === "string" ? { scheme_policy: body.scheme_policy } : {},
    ...typeof body.canonical_redirect_policy === "string" ? {
      canonical_redirect_policy: body.canonical_redirect_policy
    } : {},
    ...body.locale === void 0 ? {} : { locale: body.locale }
  })
};
```

<a id="remove_site_domain"></a>

### DELETE /api/v1/site/domains/{hostname}

**remove_site_domain** — Remove a binding. The last remaining binding is undeletable (a site without a canonical origin cannot generate absolute URLs); removing the primary promotes the first remaining. Permission: domains.manage

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `domains.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: `hostname`.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "site": {
      "type": "string",
      "minLength": 1
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
const params = request.params;
return {
  status: 200,
  body: await removeSiteDomainOp(
    app,
    siteKeyOf(query, app.defaultSiteKey),
    String(params.hostname ?? "")
  )
};
```

<a id="patch_site_domain"></a>

### PATCH /api/v1/site/domains/{hostname}

**patch_site_domain** — Patch a binding: is_primary=true switches the canonical primary atomically. Permission: domains.manage

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `domains.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: `hostname`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "is_primary": {
      "type": "boolean"
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await setPrimarySiteDomainOp(
    app,
    siteKeyOf(body, app.defaultSiteKey),
    String(params.hostname ?? "")
  )
};
```

<a id="list_skills"></a>

### GET /api/v1/skills

**list_skills** — Installed skills across both roots with origin/trust/enabled (community management needs skills.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/skills.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const firstParty = loadInstalledSkills(app.skillsDir).skills.map(({ manifest }) => ({
  id: manifest.id,
  version: manifest.version,
  origin: "first-party",
  enabled: true,
  attribution: null
}));
const community = app.communitySkillsEnabled ? loadCommunitySkills(app.communitySkillsDir).skills.map((skill) => ({
  id: skill.manifest.id,
  version: skill.manifest.version,
  origin: "community",
  enabled: !skill.disabled,
  attribution: skill.manifest.attribution ?? null
})) : [];
const isManager = ctx.actor.permissions.has("skills.manage");
return {
  status: 200,
  body: {
    items: [...firstParty, ...community],
    community_enabled: app.communitySkillsEnabled,
    can_manage: isManager
  }
};
```

<a id="uninstall_skill"></a>

### DELETE /api/v1/skills/{id}

**uninstall_skill** — Uninstall a community skill (skills.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `skills.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/skills.ts` |
| Handler-local error codes (not the whole domain error set) | `SKILL_ID_FORBIDDEN` |

Path parameters: `id`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return { status: 200, body: { id: params.id, uninstalled: true } };
```

<a id="disable_skill"></a>

### POST /api/v1/skills/{id}/disable

**disable_skill** — Hide a community skill from agents without uninstalling (skills.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `skills.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/skills.ts` |

Path parameters: `id`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return { status: 200, body: { id: params.id, disabled: true } };
```

<a id="enable_skill"></a>

### POST /api/v1/skills/{id}/enable

**enable_skill** — Re-enable a disabled community skill (skills.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `skills.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/skills.ts` |

Path parameters: `id`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return { status: 200, body: { id: params.id, disabled: false } };
```

<a id="install_skill"></a>

### POST /api/v1/skills/install

**install_skill** — Install a .pcskill package (skills.manage; community skills must be enabled). Body: JSON {url} to fetch, or the raw package as application/octet-stream (the agent authoring path)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `skills.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 2162688 bytes |
| Source | `packages/api/src/http/routes/skills.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID`, `SKILL_PACKAGE_INVALID`, `SKILL_PACKAGE_UNREACHABLE` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const raw = request.body;
const bodyResult2 = await installFromBytes(app, ctx, raw);
const body = raw ?? {};
const response = await fetch(parsed, { redirect: "follow" });
const bytes = Buffer.from(await response.arrayBuffer());
const bodyResult = await installFromBytes(app, ctx, bytes, parsed.toString());
return { status: 201, body: bodyResult2 };
return { status: 201, body: bodyResult };
```

<a id="download_skill_sample"></a>

### GET /api/v1/skills/sample.zip

**download_skill_sample** — Skeleton .pcskill package to fork into a community skill

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/skills.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const zip = await sampleZip();
return {
  status: 200,
  headers: {
    "content-type": "application/zip",
    "content-disposition": 'attachment; filename="community-skill-template.zip"'
  },
  body: zip
};
```

<a id="get_system_metrics"></a>

### GET /api/v1/system/metrics

**get_system_metrics** — Recent runtime metric samples (CPU / memory / queue window)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `site.validate` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "hours": {
      "type": "string",
      "pattern": "^[0-9]+$"
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
return {
  status: 200,
  body: await getSystemMetricsOp(app, ctx, {
    ...query.hours === void 0 ? {} : { hours: Number.parseInt(query.hours, 10) }
  })
};
```

<a id="get_system_status"></a>

### GET /api/v1/system/status

**get_system_status** — Doctor-style snapshot: site, migration head, queue, storage, theme (site.validate; no secrets)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `site.validate` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await getSystemStatusOp(app, ctx) };
```

<a id="get_theme_state"></a>

### GET /api/v1/theme/state

**get_theme_state** — Active theme + working settings + manifest settings (PCMS-ADMIN-T019)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `theme.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await getThemeState(app, ctx) };
```

<a id="list_users"></a>

### GET /api/v1/users

**list_users** — Admin users with roles and MFA status (users.read)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `users.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "limit": {
      "type": "string",
      "pattern": "^[0-9]+$"
    },
    "offset": {
      "type": "string",
      "pattern": "^[0-9]+$"
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
return {
  status: 200,
  body: await listUsersOp(app, ctx, {
    ...query.limit === void 0 ? {} : { limit: Number(query.limit) },
    ...query.offset === void 0 ? {} : { offset: Number(query.offset) }
  })
};
```

<a id="rest-extensions"></a>

## extensions

Discover and manage deployed extension composition, typed operations and updates.

| Method/path | Operation | Purpose |
|---|---|---|
| `GET /api/v1/extensions` | [list_extensions](#list_extensions) | Deployed extensions with lifecycle state, capabilities and compatibility. |
| `GET /api/v1/extensions/{extensionId}/compatibility` | [get_extension_compatibility](#get_extension_compatibility) | Compatibility issues for one extension. |
| `GET /api/v1/extensions/{extensionId}/config` | [get_extension_config](#get_extension_config) | Extension settings view: manifest config schema, public (non-secret) config, declared secret slots with presence only. |
| `PUT /api/v1/extensions/{extensionId}/config` | [update_extension_config](#update_extension_config) | Merge the non-secret extension settings (partial updates preserve sibling keys and stored secret refs); schema-validated, audited. |
| `POST /api/v1/extensions/{extensionId}/disable` | [extension_disable](#extension_disable) | Disable an extension (impact preflight blocks active dependents). |
| `POST /api/v1/extensions/{extensionId}/enable` | [extension_enable](#extension_enable) | Enable an installed extension (preflight gates composition). |
| `POST /api/v1/extensions/{extensionId}/install` | [extension_install](#extension_install) | Activate an already-deployed trusted artifact into the CMS lifecycle (never a download). |
| `GET /api/v1/extensions/{extensionId}/mount` | [extension_mount_get](#extension_mount_get) | The extension's ACTIVE site-level route mount (CORE-SHOP-01; canonical public URLs are mount-based). |
| `PUT /api/v1/extensions/{extensionId}/mount` | [extension_mount_set](#extension_mount_set) | Assign (or move) the extension's site-level route mount. Fail-closed preflight: reserved namespaces, other mounts, active entry routes (extensions.manage, audited). |
| `GET /api/v1/extensions/{extensionId}/operations` | [list_extension_operations](#list_extension_operations) | Typed application operations contributed by an enabled deployed extension (schemas + permissions). |
| `POST /api/v1/extensions/{extensionId}/operations/{operationId}` | [invoke_extension_operation](#invoke_extension_operation) | Invoke a typed extension application operation (permission enforced per operation; same handler as MCP). |
| `DELETE /api/v1/extensions/{extensionId}/secrets/{slot}` | [clear_extension_secret](#clear_extension_secret) | Clear an extension secret slot (audited). |
| `PUT /api/v1/extensions/{extensionId}/secrets/{slot}` | [set_extension_secret](#set_extension_secret) | Write an extension secret slot (write-only; the value is never returned). |
| `POST /api/v1/extensions/{extensionId}/uninstall` | [extension_uninstall](#extension_uninstall) | Remove executable state; destructive data policies require the explicit confirmation. |
| `GET /api/v1/extensions/capabilities` | [get_extension_capabilities](#get_extension_capabilities) | Effective capability provisions (key, version, provider). |
| `GET /api/v1/extensions/compatibility` | [get_compatibility_report](#get_compatibility_report) | Read-only compatibility scan of the actual installation. |
| `GET /api/v1/extensions/contracts` | [get_contract_versions](#get_contract_versions) | Independent contract versions (cms, config, extension, REST, MCP, theme, …). |
| `GET /api/v1/extensions/deprecations` | [list_deprecations](#list_deprecations) | Machine-readable deprecation records with replacement/removal metadata. |
| `GET /api/v1/extensions/operations` | [list_all_extension_operations](#list_all_extension_operations) | Typed application operations across all enabled deployed extensions — the capability-binding discovery (ADR-0017 S4): generic consumers (Admin media studio, CLI) find operations by `capability`, never by extension id. |
| `POST /api/v1/update/apply` | [update_apply](#update_apply) | Update orchestration contract: fails closed without the M15 deployment adapter. |
| `GET /api/v1/update/preflight` | [get_update_preflight](#get_update_preflight) | Read-only preflight against the configured target release manifest (no writes). |
| `POST /api/v1/update/preflight` | [submit_update_preflight](#submit_update_preflight) | Read-only preflight against an operator-supplied target manifest. |

<a id="list_extensions"></a>

### GET /api/v1/extensions

**list_extensions** — Deployed extensions with lifecycle state, capabilities and compatibility.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, () => listExtensions(app, ctx));
```

<a id="get_extension_compatibility"></a>

### GET /api/v1/extensions/{extensionId}/compatibility

**get_extension_compatibility** — Compatibility issues for one extension.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: `extensionId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "extensionId": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9.-]{2,120}$"
    }
  },
  "required": [
    "extensionId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(
  app,
  ctx,
  () => getExtensionCompatibility(app, ctx, {
    extension_id: String(request.params.extensionId)
  })
);
```

<a id="get_extension_config"></a>

### GET /api/v1/extensions/{extensionId}/config

**get_extension_config** — Extension settings view: manifest config schema, public (non-secret) config, declared secret slots with presence only.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: `extensionId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "extensionId": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9.-]{2,120}$"
    }
  },
  "required": [
    "extensionId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(
  app,
  ctx,
  () => getExtensionConfigOp(app, ctx, {
    extension_id: String(request.params.extensionId)
  })
);
```

<a id="update_extension_config"></a>

### PUT /api/v1/extensions/{extensionId}/config

**update_extension_config** — Merge the non-secret extension settings (partial updates preserve sibling keys and stored secret refs); schema-validated, audited.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: `extensionId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "extensionId": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9.-]{2,120}$"
    }
  },
  "required": [
    "extensionId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "config"
  ],
  "properties": {
    "config": {
      "type": "object"
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
const body = jsonBody(request);
return handle(
  app,
  ctx,
  () => updateExtensionConfigOp(app, ctx, {
    extension_id: String(params.extensionId),
    config: body["config"]
  })
);
```

<a id="extension_disable"></a>

### POST /api/v1/extensions/{extensionId}/disable

**extension_disable** — Disable an extension (impact preflight blocks active dependents).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: `extensionId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "extensionId": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9.-]{2,120}$"
    }
  },
  "required": [
    "extensionId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(
  app,
  ctx,
  () => disableExtension(app, ctx, {
    extension_id: String(request.params.extensionId)
  })
);
```

<a id="extension_enable"></a>

### POST /api/v1/extensions/{extensionId}/enable

**extension_enable** — Enable an installed extension (preflight gates composition).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: `extensionId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "extensionId": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9.-]{2,120}$"
    }
  },
  "required": [
    "extensionId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(
  app,
  ctx,
  () => enableExtension(app, ctx, {
    extension_id: String(request.params.extensionId)
  })
);
```

<a id="extension_install"></a>

### POST /api/v1/extensions/{extensionId}/install

**extension_install** — Activate an already-deployed trusted artifact into the CMS lifecycle (never a download).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: `extensionId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "extensionId": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9.-]{2,120}$"
    }
  },
  "required": [
    "extensionId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "config": {
      "type": "object"
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(
  app,
  ctx,
  () => installExtension(app, ctx, {
    extension_id: String(request.params.extensionId),
    ...jsonBody(request).config === void 0 ? {} : { config: jsonBody(request).config }
  })
);
```

<a id="extension_mount_get"></a>

### GET /api/v1/extensions/{extensionId}/mount

**extension_mount_get** — The extension's ACTIVE site-level route mount (CORE-SHOP-01; canonical public URLs are mount-based).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: `extensionId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "extensionId": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9.-]{2,120}$"
    }
  },
  "required": [
    "extensionId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const extensionId = String(request.params.extensionId);
return {
  status: 200,
  body: { extension_id: extensionId, mount_path: mount?.mountPath ?? null }
};
```

<a id="extension_mount_set"></a>

### PUT /api/v1/extensions/{extensionId}/mount

**extension_mount_set** — Assign (or move) the extension's site-level route mount. Fail-closed preflight: reserved namespaces, other mounts, active entry routes (extensions.manage, audited).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: `extensionId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "extensionId": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9.-]{2,120}$"
    }
  },
  "required": [
    "extensionId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "path"
  ],
  "properties": {
    "path": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const extensionId = String(request.params.extensionId);
const path = String(jsonBody(request).path);
const site = await app.routes.ensureSite(app.defaultSiteKey);
const mount = await app.extensionRouteMounts.setMount(site.id, extensionId, path);
return { status: 200, body: { extension_id: extensionId, mount_path: mount.mountPath } };
```

<a id="list_extension_operations"></a>

### GET /api/v1/extensions/{extensionId}/operations

**list_extension_operations** — Typed application operations contributed by an enabled deployed extension (schemas + permissions).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: `extensionId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "extensionId": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9.-]{2,120}$"
    }
  },
  "required": [
    "extensionId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, async () => ({
  items: await app.extensionOperations.list(
    String(request.params.extensionId)
  )
}));
```

<a id="invoke_extension_operation"></a>

### POST /api/v1/extensions/{extensionId}/operations/{operationId}

**invoke_extension_operation** — Invoke a typed extension application operation (permission enforced per operation; same handler as MCP).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: `extensionId`, `operationId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "extensionId",
    "operationId"
  ],
  "properties": {
    "extensionId": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9.-]{2,120}$"
    },
    "operationId": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,62}(\\.[a-z0-9][a-z0-9-]{0,62}){0,9}$"
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": true,
  "maxProperties": 64
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(
  app,
  ctx,
  () => app.extensionOperations.invoke(
    app,
    ctx,
    String(params.extensionId),
    String(params.operationId),
    jsonBody(request)
  )
);
```

<a id="clear_extension_secret"></a>

### DELETE /api/v1/extensions/{extensionId}/secrets/{slot}

**clear_extension_secret** — Clear an extension secret slot (audited).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: `extensionId`, `slot`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "extensionId",
    "slot"
  ],
  "properties": {
    "extensionId": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9.-]{2,120}$"
    },
    "slot": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9_]*(.[a-z][a-z0-9_]*){0,4}$"
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(
  app,
  ctx,
  () => clearExtensionSecretOp(app, ctx, {
    extension_id: String(params.extensionId),
    slot: String(params.slot)
  })
);
```

<a id="set_extension_secret"></a>

### PUT /api/v1/extensions/{extensionId}/secrets/{slot}

**set_extension_secret** — Write an extension secret slot (write-only; the value is never returned).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: `extensionId`, `slot`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "extensionId",
    "slot"
  ],
  "properties": {
    "extensionId": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9.-]{2,120}$"
    },
    "slot": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9_]*(.[a-z][a-z0-9_]*){0,4}$"
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "value"
  ],
  "properties": {
    "value": {
      "type": "string",
      "minLength": 1,
      "maxLength": 8192
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
const body = jsonBody(request);
return handle(
  app,
  ctx,
  () => setExtensionSecretOp(app, ctx, {
    extension_id: String(params.extensionId),
    slot: String(params.slot),
    value: body["value"]
  })
);
```

<a id="extension_uninstall"></a>

### POST /api/v1/extensions/{extensionId}/uninstall

**extension_uninstall** — Remove executable state; destructive data policies require the explicit confirmation.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: `extensionId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "extensionId": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9.-]{2,120}$"
    }
  },
  "required": [
    "extensionId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "confirmation": {
      "type": "string",
      "maxLength": 200
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(
  app,
  ctx,
  () => uninstallExtension(app, ctx, {
    extension_id: String(request.params.extensionId),
    ...jsonBody(request).confirmation === void 0 ? {} : { confirmation: jsonBody(request).confirmation }
  })
);
```

<a id="get_extension_capabilities"></a>

### GET /api/v1/extensions/capabilities

**get_extension_capabilities** — Effective capability provisions (key, version, provider).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, () => getCapabilities(app, ctx));
```

<a id="get_compatibility_report"></a>

### GET /api/v1/extensions/compatibility

**get_compatibility_report** — Read-only compatibility scan of the actual installation.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, () => getCompatibilityReport(app, ctx));
```

<a id="get_contract_versions"></a>

### GET /api/v1/extensions/contracts

**get_contract_versions** — Independent contract versions (cms, config, extension, REST, MCP, theme, …).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, () => getContractVersions(app, ctx));
```

<a id="list_deprecations"></a>

### GET /api/v1/extensions/deprecations

**list_deprecations** — Machine-readable deprecation records with replacement/removal metadata.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, () => listDeprecations(app, ctx));
```

<a id="list_all_extension_operations"></a>

### GET /api/v1/extensions/operations

**list_all_extension_operations** — Typed application operations across all enabled deployed extensions — the capability-binding discovery (ADR-0017 S4): generic consumers (Admin media studio, CLI) find operations by `capability`, never by extension id.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, async () => ({
  items: await app.extensionOperations.list()
}));
```

<a id="update_apply"></a>

### POST /api/v1/update/apply

**update_apply** — Update orchestration contract: fails closed without the M15 deployment adapter.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "manifest"
  ],
  "properties": {
    "manifest": {
      "type": "object"
    },
    "backup_confirmation": {
      "type": "string",
      "maxLength": 64
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const body = jsonBody(request);
return handle(
  app,
  ctx,
  () => applyUpdate(app, ctx, {
    manifest: body.manifest,
    ...body.backup_confirmation === void 0 ? {} : { backup_confirmation: String(body.backup_confirmation) }
  })
);
```

<a id="get_update_preflight"></a>

### GET /api/v1/update/preflight

**get_update_preflight** — Read-only preflight against the configured target release manifest (no writes).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, () => getUpdatePreflight(app, ctx));
```

<a id="submit_update_preflight"></a>

### POST /api/v1/update/preflight

**submit_update_preflight** — Read-only preflight against an operator-supplied target manifest.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `extensions.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/extensions.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "manifest"
  ],
  "properties": {
    "manifest": {
      "type": "object"
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(
  app,
  ctx,
  () => getUpdatePreflight(app, ctx, { manifest: jsonBody(request).manifest })
);
```

<a id="rest-forms"></a>

## forms

Version definitions and run anonymous server-validated interactions; history can contain personal data.

| Method/path | Operation | Purpose |
|---|---|---|
| `GET /api/v1/forms` | [list_forms](#list_forms) | List form definitions (current version each) |
| `POST /api/v1/forms` | [create_form_definition](#create_form_definition) | Create a form definition (version 1; forms.manage_definition) |
| `GET /api/v1/forms/{formId}` | [get_form_definition](#get_form_definition) | One form definition (identity + current immutable version) |
| `PUT /api/v1/forms/{formId}` | [update_form_definition](#update_form_definition) | Append the next immutable form definition version |
| `GET /api/v1/forms/{formId}/stats` | [get_form_stats](#get_form_stats) | Submission and lead counts for a form definition |
| `GET /api/v1/forms/{formId}/usage` | [get_form_usage](#get_form_usage) | Entries whose content references the form definition |
| `GET /api/v1/forms/field-types` | [list_form_field_types](#list_form_field_types) | Builder-facing field type corpus with supported properties |
| `POST /api/v1/public/forms/{formId}/submit` | [submit_public_form](#submit_public_form) | Anonymous form submission: validate → persist → outbox, retry-safe (§3/§23) |
| `GET /api/v1/public/quizzes/{quizId}/schema` | [get_quiz_public_schema](#get_quiz_public_schema) | Sanitized public quiz schema for rendering clients (§36) |
| `POST /api/v1/public/quizzes/{quizId}/start` | [start_public_quiz](#start_public_quiz) | Start an anonymous server-driven quiz run (§11/§16) |
| `POST /api/v1/public/quizzes/runs/{runId}/abandon` | [abandon_public_quiz](#abandon_public_quiz) | Explicit client exit: run becomes ABANDONED (§17) |
| `POST /api/v1/public/quizzes/runs/{runId}/answer` | [answer_public_quiz](#answer_public_quiz) | Record one server-validated answer; branching decides the next step (§12/§13) |
| `POST /api/v1/public/quizzes/runs/{runId}/complete` | [complete_public_quiz](#complete_public_quiz) | Complete a run: server computes score/outcome, may create a lead (§14/§15) |
| `GET /api/v1/quizzes` | [list_quizzes](#list_quizzes) | List quiz definitions (current version each) |
| `POST /api/v1/quizzes` | [create_quiz_definition](#create_quiz_definition) | Create a quiz definition (version 1; quizzes.manage_definition) |
| `GET /api/v1/quizzes/{quizId}` | [get_quiz_definition](#get_quiz_definition) | One quiz definition (steps/branching/scoring/outcomes of the current version) |
| `PUT /api/v1/quizzes/{quizId}` | [update_quiz_definition](#update_quiz_definition) | Append the next immutable quiz definition version |
| `GET /api/v1/quizzes/{quizId}/stats` | [get_quiz_stats](#get_quiz_stats) | Run, completion and lead counts for a quiz definition |
| `GET /api/v1/quizzes/{quizId}/usage` | [get_quiz_usage](#get_quiz_usage) | Entries whose content references the quiz definition |

<a id="list_forms"></a>

### GET /api/v1/forms

**list_forms** — List form definitions (current version each)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `forms.read_definition` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "ACTIVE",
        "ARCHIVED"
      ]
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
const items = await app.formsSource.domain.definitions.listDefinitions(
  query.status === void 0 ? {} : { status: query.status }
);
return { status: 200, body: { items } };
```

<a id="create_form_definition"></a>

### POST /api/v1/forms

**create_form_definition** — Create a form definition (version 1; forms.manage_definition)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `forms.manage_definition` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | supported |
| Body limit | 131072 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "key": {
      "type": "string",
      "maxLength": 64
    },
    "title": {
      "type": "string",
      "maxLength": 300
    },
    "fields": {
      "type": "array"
    },
    "steps": {
      "type": "array"
    },
    "branching_rules": {
      "type": "array"
    },
    "scoring_rules": {
      "type": "array"
    },
    "outcomes": {
      "type": "array"
    },
    "settings": {
      "type": "object"
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
const created = await app.formsSource.domain.definitions.createDefinition({
  key: body.key,
  title: body.title,
  fields: body.fields,
  ...body.settings === void 0 ? {} : { settings: body.settings }
});
return { status: 201, body: created };
```

<a id="get_form_definition"></a>

### GET /api/v1/forms/{formId}

**get_form_definition** — One form definition (identity + current immutable version)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `forms.read_definition` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |

Path parameters: `formId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "formId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "formId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await app.formsSource.domain.definitions.getDefinition(params.formId)
};
```

<a id="update_form_definition"></a>

### PUT /api/v1/forms/{formId}

**update_form_definition** — Append the next immutable form definition version

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `forms.manage_definition` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 131072 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |

Path parameters: `formId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "formId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "formId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "key": {
      "type": "string",
      "maxLength": 64
    },
    "title": {
      "type": "string",
      "maxLength": 300
    },
    "fields": {
      "type": "array"
    },
    "steps": {
      "type": "array"
    },
    "branching_rules": {
      "type": "array"
    },
    "scoring_rules": {
      "type": "array"
    },
    "outcomes": {
      "type": "array"
    },
    "settings": {
      "type": "object"
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
const updated = await app.formsSource.domain.definitions.addVersion({
  form_definition_id: params.formId,
  ...body.title === void 0 ? {} : { title: body.title },
  fields: body.fields,
  ...body.settings === void 0 ? {} : { settings: body.settings }
});
return { status: 200, body: updated };
```

<a id="get_form_stats"></a>

### GET /api/v1/forms/{formId}/stats

**get_form_stats** — Submission and lead counts for a form definition

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `forms.read_definition` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |

Path parameters: `formId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "formId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "formId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await app.formsSource.definitionStats({
    kind: "form",
    definition_id: params.formId
  })
};
```

<a id="get_form_usage"></a>

### GET /api/v1/forms/{formId}/usage

**get_form_usage** — Entries whose content references the form definition

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `forms.read_definition` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |

Path parameters: `formId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "formId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "formId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await app.formsSource.findDefinitionUsage({
    kind: "form",
    definition_id: params.formId
  })
};
```

<a id="list_form_field_types"></a>

### GET /api/v1/forms/field-types

**list_form_field_types** — Builder-facing field type corpus with supported properties

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `forms.read_definition` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: { items: FORM_FIELD_TYPE_INFO_V1 } };
```

<a id="submit_public_form"></a>

### POST /api/v1/public/forms/{formId}/submit

**submit_public_form** — Anonymous form submission: validate → persist → outbox, retry-safe (§3/§23)

| Contract | Value |
|---|---|
| Authentication | public |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 65536 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |
| Handler-specific input headers | `user-agent` |

Path parameters: `formId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "formId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "formId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "values": {
      "type": "object"
    },
    "submission_token": {
      "type": "string",
      "maxLength": 128
    },
    "source_entry_id": {
      "type": "string",
      "maxLength": 64
    },
    "source_url": {
      "type": "string",
      "maxLength": 500
    },
    "attribution": {
      "type": "object"
    }
  },
  "required": [
    "values"
  ]
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
const result = await app.formsSource.publicForm.submit({
  form_definition_id: params.formId,
  values: body.values,
  ...body.submission_token === void 0 ? {} : { submission_token: body.submission_token },
  ...body.source_entry_id === void 0 ? {} : { source_entry_id: body.source_entry_id },
  ...body.source_url === void 0 ? {} : { source_url: body.source_url },
  ...body.attribution === void 0 ? {} : { attribution: body.attribution },
  submitter: {
    ip: clientKey(request) === "local" ? null : clientKey(request),
    user_agent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null
  }
});
return { status: 200, body: result };
```

<a id="get_quiz_public_schema"></a>

### GET /api/v1/public/quizzes/{quizId}/schema

**get_quiz_public_schema** — Sanitized public quiz schema for rendering clients (§36)

| Contract | Value |
|---|---|
| Authentication | public |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |

Path parameters: `quizId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "quizId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "quizId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await app.formsSource.publicQuiz.getPublicSchema(params.quizId)
};
```

<a id="start_public_quiz"></a>

### POST /api/v1/public/quizzes/{quizId}/start

**start_public_quiz** — Start an anonymous server-driven quiz run (§11/§16)

| Contract | Value |
|---|---|
| Authentication | public |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 4096 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |
| Handler-specific input headers | `user-agent` |

Path parameters: `quizId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "quizId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "quizId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "source_entry_id": {
      "type": "string",
      "maxLength": 64
    },
    "attribution": {
      "type": "object"
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
const result = await app.formsSource.publicQuiz.start({
  quiz_definition_id: params.quizId,
  ...body.source_entry_id === void 0 ? {} : { source_entry_id: body.source_entry_id },
  ...body.attribution === void 0 ? {} : { attribution: body.attribution },
  submitter: {
    ip: clientKey(request) === "local" ? null : clientKey(request),
    user_agent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null
  }
});
return { status: 200, body: result };
```

<a id="abandon_public_quiz"></a>

### POST /api/v1/public/quizzes/runs/{runId}/abandon

**abandon_public_quiz** — Explicit client exit: run becomes ABANDONED (§17)

| Contract | Value |
|---|---|
| Authentication | public |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 4096 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |

Path parameters: `runId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "runId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "runId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "resume_token": {
      "type": "string",
      "minLength": 32,
      "maxLength": 128
    }
  },
  "required": [
    "resume_token"
  ]
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
const result = await app.formsSource.publicQuiz.abandon({
  quiz_run_id: params.runId,
  resume_token: body.resume_token
});
return { status: 200, body: result };
```

<a id="answer_public_quiz"></a>

### POST /api/v1/public/quizzes/runs/{runId}/answer

**answer_public_quiz** — Record one server-validated answer; branching decides the next step (§12/§13)

| Contract | Value |
|---|---|
| Authentication | public |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 8192 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |

Path parameters: `runId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "runId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "runId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "resume_token": {
      "type": "string",
      "minLength": 32,
      "maxLength": 128
    },
    "question_id": {
      "type": "string",
      "maxLength": 64
    },
    "value": {}
  },
  "required": [
    "resume_token",
    "question_id"
  ]
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
const result = await app.formsSource.publicQuiz.answer({
  quiz_run_id: params.runId,
  resume_token: body.resume_token,
  question_id: body.question_id,
  value: body.value
});
return { status: 200, body: result };
```

<a id="complete_public_quiz"></a>

### POST /api/v1/public/quizzes/runs/{runId}/complete

**complete_public_quiz** — Complete a run: server computes score/outcome, may create a lead (§14/§15)

| Contract | Value |
|---|---|
| Authentication | public |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 4096 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |

Path parameters: `runId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "runId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "runId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "resume_token": {
      "type": "string",
      "minLength": 32,
      "maxLength": 128
    }
  },
  "required": [
    "resume_token"
  ]
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
const result = await app.formsSource.publicQuiz.complete({
  quiz_run_id: params.runId,
  resume_token: body.resume_token
});
return { status: 200, body: result };
```

<a id="list_quizzes"></a>

### GET /api/v1/quizzes

**list_quizzes** — List quiz definitions (current version each)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `quizzes.read_definition` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "ACTIVE",
        "ARCHIVED"
      ]
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
const items = await app.formsSource.domain.quizzes.listDefinitions(
  query.status === void 0 ? {} : { status: query.status }
);
return { status: 200, body: { items } };
```

<a id="create_quiz_definition"></a>

### POST /api/v1/quizzes

**create_quiz_definition** — Create a quiz definition (version 1; quizzes.manage_definition)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `quizzes.manage_definition` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | supported |
| Body limit | 131072 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "key": {
      "type": "string",
      "maxLength": 64
    },
    "title": {
      "type": "string",
      "maxLength": 300
    },
    "fields": {
      "type": "array"
    },
    "steps": {
      "type": "array"
    },
    "branching_rules": {
      "type": "array"
    },
    "scoring_rules": {
      "type": "array"
    },
    "outcomes": {
      "type": "array"
    },
    "settings": {
      "type": "object"
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
const created = await app.formsSource.domain.quizzes.createDefinition({
  key: body.key,
  title: body.title,
  steps: body.steps,
  ...body.branching_rules === void 0 ? {} : { branching_rules: body.branching_rules },
  ...body.scoring_rules === void 0 ? {} : { scoring_rules: body.scoring_rules },
  ...body.outcomes === void 0 ? {} : { outcomes: body.outcomes },
  ...body.settings === void 0 ? {} : { settings: body.settings }
});
return { status: 201, body: created };
```

<a id="get_quiz_definition"></a>

### GET /api/v1/quizzes/{quizId}

**get_quiz_definition** — One quiz definition (steps/branching/scoring/outcomes of the current version)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `quizzes.read_definition` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |

Path parameters: `quizId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "quizId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "quizId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await app.formsSource.domain.quizzes.getDefinition(params.quizId)
};
```

<a id="update_quiz_definition"></a>

### PUT /api/v1/quizzes/{quizId}

**update_quiz_definition** — Append the next immutable quiz definition version

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `quizzes.manage_definition` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 131072 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |

Path parameters: `quizId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "quizId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "quizId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "key": {
      "type": "string",
      "maxLength": 64
    },
    "title": {
      "type": "string",
      "maxLength": 300
    },
    "fields": {
      "type": "array"
    },
    "steps": {
      "type": "array"
    },
    "branching_rules": {
      "type": "array"
    },
    "scoring_rules": {
      "type": "array"
    },
    "outcomes": {
      "type": "array"
    },
    "settings": {
      "type": "object"
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
const updated = await app.formsSource.domain.quizzes.addVersion({
  quiz_definition_id: params.quizId,
  ...body.title === void 0 ? {} : { title: body.title },
  steps: body.steps,
  ...body.branching_rules === void 0 ? {} : { branching_rules: body.branching_rules },
  ...body.scoring_rules === void 0 ? {} : { scoring_rules: body.scoring_rules },
  ...body.outcomes === void 0 ? {} : { outcomes: body.outcomes },
  ...body.settings === void 0 ? {} : { settings: body.settings }
});
return { status: 200, body: updated };
```

<a id="get_quiz_stats"></a>

### GET /api/v1/quizzes/{quizId}/stats

**get_quiz_stats** — Run, completion and lead counts for a quiz definition

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `quizzes.read_definition` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |

Path parameters: `quizId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "quizId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "quizId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await app.formsSource.definitionStats({
    kind: "quiz",
    definition_id: params.quizId
  })
};
```

<a id="get_quiz_usage"></a>

### GET /api/v1/quizzes/{quizId}/usage

**get_quiz_usage** — Entries whose content references the quiz definition

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `quizzes.read_definition` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/forms.ts` |

Path parameters: `quizId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "quizId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "quizId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await app.formsSource.findDefinitionUsage({
    kind: "quiz",
    definition_id: params.quizId
  })
};
```

<a id="rest-integrations"></a>

## integrations

Configure connectors, notifications and delivery reliability; secret slots are write-only.

| Method/path | Operation | Purpose |
|---|---|---|
| `GET /api/v1/integrations/bindings` | [list_bindings](#list_bindings) | Event→action bindings |
| `POST /api/v1/integrations/bindings` | [create_binding](#create_binding) | Bind an event type to configured actions (bounded conditions) |
| `PATCH /api/v1/integrations/bindings/{bindingId}` | [update_binding](#update_binding) | Update a binding (event type, conditions, actions, policy) |
| `GET /api/v1/integrations/connectors` | [list_connectors](#list_connectors) | Registered connector catalog with typed contracts (spec §6) |
| `GET /api/v1/integrations/connectors/{connectorType}` | [get_connector_schema](#get_connector_schema) | Connector config schema, secret requirements and actions |
| `GET /api/v1/integrations/deliveries` | [list_deliveries](#list_deliveries) | Outbound delivery history with reliability states |
| `GET /api/v1/integrations/deliveries/{deliveryId}` | [get_delivery](#get_delivery) | One delivery with its complete attempt history |
| `POST /api/v1/integrations/deliveries/{deliveryId}/cancel` | [cancel_delivery](#cancel_delivery) | Cancel a pending/failed delivery (audited) |
| `POST /api/v1/integrations/deliveries/{deliveryId}/retry` | [retry_delivery](#retry_delivery) | Manual retry of a failed delivery (audited) |
| `GET /api/v1/integrations/deliveries/stats` | [get_delivery_stats](#get_delivery_stats) | Delivery counters by state (reliability at a glance) |
| `GET /api/v1/integrations/inbound-events` | [list_inbound_events](#list_inbound_events) | Inbound provider events (metadata only — raw payloads protected) |
| `POST /api/v1/integrations/inbound/{instanceId}` | [receive_inbound](#receive_inbound) | Provider callback receiver (anonymous allowlist; auth via the endpoint verifier, dedup via InboundEvent) |
| `GET /api/v1/integrations/instances` | [list_integration_instances](#list_integration_instances) | Configured connections (config + secret-ref NAMES, never values) |
| `POST /api/v1/integrations/instances` | [create_instance](#create_instance) | Configure a connection (secrets via names; integrations.secrets.manage) |
| `PATCH /api/v1/integrations/instances/{instanceId}` | [update_instance](#update_instance) | Update a configured connection |
| `DELETE /api/v1/integrations/instances/{instanceId}/secrets/{key}` | [clear_instance_secret](#clear_instance_secret) | Remove a stored Admin-managed runtime secret (editorial data is kept; the connector falls back to env/file refs). Requires integrations.secrets.manage. |
| `PUT /api/v1/integrations/instances/{instanceId}/secrets/{key}` | [set_instance_secret](#set_instance_secret) | Store an Admin-managed runtime secret VALUE for a connector requirement (write-only, encrypted at rest, never returned). Requires integrations.secrets.manage. |
| `POST /api/v1/integrations/instances/{instanceId}/test` | [test_instance](#test_instance) | Privileged safe connection probe (audited) |
| `GET /api/v1/mail/settings` | [get_mail_settings](#get_mail_settings) | Admin-managed SMTP settings, sanitized (never returns the password — only whether one is stored). |
| `PUT /api/v1/mail/settings` | [update_mail_settings](#update_mail_settings) | Save Admin-managed SMTP settings. Enabling verifies the connection before persisting; the password is write-only (string stores encrypted, null clears, absent keeps). |
| `POST /api/v1/mail/test` | [test_mail_transport](#test_mail_transport) | Probe the mail transport. Without overrides probes the configured transport (with `to`, one test message is delivered); with host/port/mode/username/password probes the values as typed (unsaved settings), falling back to the stored password when none is typed. Never returns or logs credentials. |
| `GET /api/v1/notifications/settings` | [get_notification_settings](#get_notification_settings) | Notification routing: per-category recipient users, per-form overrides, site wordmark — plus candidate users and forms for the picker |
| `PUT /api/v1/notifications/settings` | [update_notification_settings](#update_notification_settings) | Save notification routing (recipients must be existing ACTIVE site users) |
| `GET /api/v1/notifications/subscriptions` | [get_notification_subscriptions](#get_notification_subscriptions) | The signed-in user's notification subscriptions (defaults: all enabled, immediate) |
| `PUT /api/v1/notifications/subscriptions` | [update_notification_subscriptions](#update_notification_subscriptions) | Save the signed-in user's notification subscriptions (category opt-outs + digest interval) |

<a id="list_bindings"></a>

### GET /api/v1/integrations/bindings

**list_bindings** — Event→action bindings

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/integrations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, (a, c) => listIntegrationBindings(a, c));
```

<a id="create_binding"></a>

### POST /api/v1/integrations/bindings

**create_binding** — Bind an event type to configured actions (bounded conditions)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.configure` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/integrations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "event_type": {
      "type": "string",
      "maxLength": 100
    },
    "source_filter": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 100
    },
    "conditions": {
      "type": "array",
      "maxItems": 16
    },
    "actions": {
      "type": "array",
      "maxItems": 8,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "instance_id": {
            "type": "string",
            "pattern": "^[0-9a-f-]{36}$"
          },
          "action_type": {
            "type": "string",
            "maxLength": 60
          },
          "payload_mapping": {
            "type": "object"
          }
        },
        "required": [
          "instance_id",
          "action_type",
          "payload_mapping"
        ]
      }
    },
    "enabled": {
      "type": "boolean"
    },
    "failure_policy": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "max_attempts": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10
        },
        "backoff_base_ms": {
          "type": "integer",
          "minimum": 1000,
          "maximum": 3600000
        }
      }
    }
  },
  "required": [
    "event_type",
    "actions"
  ]
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(
  app,
  ctx,
  (a, c) => createIntegrationBinding(a, c, bindingFromWire(jsonBody(request)))
);
```

<a id="update_binding"></a>

### PATCH /api/v1/integrations/bindings/{bindingId}

**update_binding** — Update a binding (event type, conditions, actions, policy)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.configure` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/integrations.ts` |

Path parameters: `bindingId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "bindingId": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    }
  },
  "required": [
    "bindingId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "event_type": {
      "type": "string",
      "maxLength": 100
    },
    "source_filter": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 100
    },
    "conditions": {
      "type": "array",
      "maxItems": 16
    },
    "actions": {
      "type": "array",
      "maxItems": 8,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "instance_id": {
            "type": "string",
            "pattern": "^[0-9a-f-]{36}$"
          },
          "action_type": {
            "type": "string",
            "maxLength": 60
          },
          "payload_mapping": {
            "type": "object"
          }
        },
        "required": [
          "instance_id",
          "action_type",
          "payload_mapping"
        ]
      }
    },
    "enabled": {
      "type": "boolean"
    },
    "failure_policy": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "max_attempts": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10
        },
        "backoff_base_ms": {
          "type": "integer",
          "minimum": 1000,
          "maximum": 3600000
        }
      }
    }
  },
  "required": [
    "event_type",
    "actions"
  ]
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
const body = jsonBody(request);
return handle(
  app,
  ctx,
  (a, c) => updateIntegrationBinding(a, c, {
    binding_id: params.bindingId,
    patch: bindingFromWire(body)
  })
);
```

<a id="list_connectors"></a>

### GET /api/v1/integrations/connectors

**list_connectors** — Registered connector catalog with typed contracts (spec §6)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/integrations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, (a, c) => listConnectors(a, c));
```

<a id="get_connector_schema"></a>

### GET /api/v1/integrations/connectors/{connectorType}

**get_connector_schema** — Connector config schema, secret requirements and actions

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/integrations.ts` |

Path parameters: `connectorType`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "connectorType": {
      "type": "string",
      "maxLength": 60
    }
  },
  "required": [
    "connectorType"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(
  app,
  ctx,
  (a, c) => getConnectorSchema(a, c, { connector_type: params.connectorType })
);
```

<a id="list_deliveries"></a>

### GET /api/v1/integrations/deliveries

**list_deliveries** — Outbound delivery history with reliability states

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.deliveries.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/integrations.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "status": {
      "type": "string",
      "maxLength": 24
    },
    "limit": {
      "type": "string",
      "pattern": "^[0-9]+$"
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const query = request.query;
return handle(
  app,
  ctx,
  (a, c) => listIntegrationDeliveries(a, c, {
    ...typeof query["status"] === "string" ? { status: query["status"] } : {},
    ...typeof query["limit"] === "string" ? { limit: Number(query["limit"]) } : {}
  })
);
```

<a id="get_delivery"></a>

### GET /api/v1/integrations/deliveries/{deliveryId}

**get_delivery** — One delivery with its complete attempt history

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.deliveries.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/integrations.ts` |

Path parameters: `deliveryId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "deliveryId": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    }
  },
  "required": [
    "deliveryId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(
  app,
  ctx,
  (a, c) => getIntegrationDelivery(a, c, { delivery_id: params.deliveryId })
);
```

<a id="cancel_delivery"></a>

### POST /api/v1/integrations/deliveries/{deliveryId}/cancel

**cancel_delivery** — Cancel a pending/failed delivery (audited)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.retry` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/integrations.ts` |

Path parameters: `deliveryId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "deliveryId": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    }
  },
  "required": [
    "deliveryId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(
  app,
  ctx,
  (a, c) => cancelIntegrationDelivery(a, c, { delivery_id: params.deliveryId })
);
```

<a id="retry_delivery"></a>

### POST /api/v1/integrations/deliveries/{deliveryId}/retry

**retry_delivery** — Manual retry of a failed delivery (audited)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.retry` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/integrations.ts` |

Path parameters: `deliveryId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "deliveryId": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    }
  },
  "required": [
    "deliveryId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(
  app,
  ctx,
  (a, c) => retryIntegrationDelivery(a, c, { delivery_id: params.deliveryId })
);
```

<a id="get_delivery_stats"></a>

### GET /api/v1/integrations/deliveries/stats

**get_delivery_stats** — Delivery counters by state (reliability at a glance)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.deliveries.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/integrations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, (a, c) => integrationDeliveryStats(a, c));
```

<a id="list_inbound_events"></a>

### GET /api/v1/integrations/inbound-events

**list_inbound_events** — Inbound provider events (metadata only — raw payloads protected)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.inbound.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/integrations.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "source_id": {
      "type": "string",
      "maxLength": 64
    },
    "status": {
      "type": "string",
      "maxLength": 16
    },
    "limit": {
      "type": "string",
      "pattern": "^[0-9]+$"
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const query = request.query;
return handle(
  app,
  ctx,
  (a, c) => listInboundEvents(a, c, {
    ...typeof query["source_id"] === "string" ? { source_id: query["source_id"] } : {},
    ...typeof query["status"] === "string" ? { status: query["status"] } : {},
    ...typeof query["limit"] === "string" ? { limit: Number(query["limit"]) } : {}
  })
);
```

<a id="receive_inbound"></a>

### POST /api/v1/integrations/inbound/{instanceId}

**receive_inbound** — Provider callback receiver (anonymous allowlist; auth via the endpoint verifier, dedup via InboundEvent)

| Contract | Value |
|---|---|
| Authentication | public |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 262144 bytes |
| Source | `packages/api/src/http/routes/integrations.ts` |
| Handler-local error codes (not the whole domain error set) | `INTEGRATION_INBOUND_INVALID`, `INTEGRATION_INSTANCE_NOT_FOUND` |

Path parameters: `instanceId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const instance = await app.integrations.instances.get(params.instanceId);
const headers = {};
const rawBody = typeof request.body === "string" ? request.body : Buffer.isBuffer(request.body) ? request.body.toString("utf8") : JSON.stringify(request.body ?? null);
const outcome = await app.integrations.inbound.receive({
  sourceType: "integration_instance",
  sourceId: instance.id,
  contractKey: `integration_instance:${instance.connectorType}`,
  headers,
  rawBody
});
return {
  status: 200,
  body: {
    received: true,
    duplicate: outcome.duplicate,
    event_id: outcome.record.id
  }
};
```

<a id="list_integration_instances"></a>

### GET /api/v1/integrations/instances

**list_integration_instances** — Configured connections (config + secret-ref NAMES, never values)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/integrations.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "connector_type": {
      "type": "string",
      "maxLength": 60
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const query = request.query;
return handle(
  app,
  ctx,
  (a, c) => listIntegrationInstances(
    a,
    c,
    typeof query["connector_type"] === "string" ? { connector_type: query["connector_type"] } : {}
  )
);
```

<a id="create_instance"></a>

### POST /api/v1/integrations/instances

**create_instance** — Configure a connection (secrets via names; integrations.secrets.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.configure` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/integrations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "connector_type": {
      "type": "string",
      "maxLength": 60
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "enabled": {
      "type": "boolean"
    },
    "config": {
      "type": "object"
    },
    "secret_refs": {
      "type": "object"
    },
    "site_key": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 64
    },
    "environment": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 32
    }
  },
  "required": [
    "connector_type",
    "name",
    "config"
  ]
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(
  app,
  ctx,
  (a, c) => createIntegrationInstance(a, c, jsonBody(request))
);
```

<a id="update_instance"></a>

### PATCH /api/v1/integrations/instances/{instanceId}

**update_instance** — Update a configured connection

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.configure` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/integrations.ts` |

Path parameters: `instanceId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "instanceId": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    }
  },
  "required": [
    "instanceId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "enabled": {
      "type": "boolean"
    },
    "config": {
      "type": "object"
    },
    "secret_refs": {
      "type": "object"
    },
    "site_key": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 64
    },
    "environment": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 32
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const body = jsonBody(request);
const params = request.params;
return handle(
  app,
  ctx,
  (a, c) => updateIntegrationInstance(a, c, {
    instance_id: params.instanceId,
    ...body
  })
);
```

<a id="clear_instance_secret"></a>

### DELETE /api/v1/integrations/instances/{instanceId}/secrets/{key}

**clear_instance_secret** — Remove a stored Admin-managed runtime secret (editorial data is kept; the connector falls back to env/file refs). Requires integrations.secrets.manage.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.secrets.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/integrations.ts` |

Path parameters: `instanceId`, `key`.

Explicit path schema:
```json
{
  "type": "object",
  "required": [
    "instanceId",
    "key"
  ],
  "properties": {
    "instanceId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "key": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(
  app,
  ctx,
  (a, c) => clearIntegrationInstanceSecret(a, c, {
    instance_id: params.instanceId,
    key: params.key
  })
);
```

<a id="set_instance_secret"></a>

### PUT /api/v1/integrations/instances/{instanceId}/secrets/{key}

**set_instance_secret** — Store an Admin-managed runtime secret VALUE for a connector requirement (write-only, encrypted at rest, never returned). Requires integrations.secrets.manage.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.secrets.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/integrations.ts` |

Path parameters: `instanceId`, `key`.

Explicit path schema:
```json
{
  "type": "object",
  "required": [
    "instanceId",
    "key"
  ],
  "properties": {
    "instanceId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "key": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "required": [
    "value"
  ],
  "additionalProperties": false,
  "properties": {
    "value": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4096
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
const body = jsonBody(request);
return handle(
  app,
  ctx,
  (a, c) => setIntegrationInstanceSecret(a, c, {
    instance_id: params.instanceId,
    key: params.key,
    value: String(body.value ?? "")
  })
);
```

<a id="test_instance"></a>

### POST /api/v1/integrations/instances/{instanceId}/test

**test_instance** — Privileged safe connection probe (audited)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.test` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/integrations.ts` |

Path parameters: `instanceId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "instanceId": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    }
  },
  "required": [
    "instanceId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(
  app,
  ctx,
  (a, c) => testIntegrationInstance(a, c, { instance_id: params.instanceId })
);
```

<a id="get_mail_settings"></a>

### GET /api/v1/mail/settings

**get_mail_settings** — Admin-managed SMTP settings, sanitized (never returns the password — only whether one is stored).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mail.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await getMailSettingsOp(app, ctx) };
```

<a id="update_mail_settings"></a>

### PUT /api/v1/mail/settings

**update_mail_settings** — Save Admin-managed SMTP settings. Enabling verifies the connection before persisting; the password is write-only (string stores encrypted, null clears, absent keeps).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.configure` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mail.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "required": [
    "enabled",
    "from",
    "host"
  ],
  "additionalProperties": false,
  "properties": {
    "enabled": {
      "type": "boolean"
    },
    "from": {
      "type": "string",
      "minLength": 3,
      "maxLength": 320
    },
    "host": {
      "type": "string",
      "minLength": 1,
      "maxLength": 253
    },
    "port": {
      "type": "integer",
      "minimum": 1,
      "maximum": 65535
    },
    "mode": {
      "enum": [
        "smtps",
        "starttls",
        "plain"
      ]
    },
    "username": {
      "type": "string",
      "maxLength": 320
    },
    "password": {
      "type": [
        "string",
        "null"
      ],
      "minLength": 1,
      "maxLength": 1024
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
return {
  status: 200,
  body: await updateMailSettingsOp(app, ctx, {
    enabled: body.enabled === true,
    from: String(body.from ?? ""),
    host: String(body.host ?? ""),
    ...body.port === void 0 ? {} : { port: Number(body.port) },
    ...body.mode === void 0 ? {} : { mode: body.mode },
    ...body.username === void 0 ? {} : { username: String(body.username) },
    ...body.password === void 0 ? {} : body.password === null ? { password: null } : { password: String(body.password) }
  })
};
```

<a id="test_mail_transport"></a>

### POST /api/v1/mail/test

**test_mail_transport** — Probe the mail transport. Without overrides probes the configured transport (with `to`, one test message is delivered); with host/port/mode/username/password probes the values as typed (unsaved settings), falling back to the stored password when none is typed. Never returns or logs credentials.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.test` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mail.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "to": {
      "type": "string",
      "maxLength": 320
    },
    "host": {
      "type": "string",
      "minLength": 1,
      "maxLength": 253
    },
    "port": {
      "type": "integer",
      "minimum": 1,
      "maximum": 65535
    },
    "mode": {
      "enum": [
        "smtps",
        "starttls",
        "plain"
      ]
    },
    "username": {
      "type": "string",
      "maxLength": 320
    },
    "password": {
      "type": "string",
      "minLength": 1,
      "maxLength": 1024
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
const override = {
  ...typeof body.host === "string" && body.host.length > 0 ? { host: body.host } : {},
  ...typeof body.port === "number" ? { port: body.port } : {},
  ...body.mode === "smtps" || body.mode === "starttls" || body.mode === "plain" ? { mode: body.mode } : {},
  ...typeof body.username === "string" && body.username.length > 0 ? { username: body.username } : {},
  ...typeof body.password === "string" && body.password.length > 0 ? { password: body.password } : {}
};
return {
  status: 200,
  body: await testMailTransport(app, ctx, {
    ...typeof body.to === "string" && body.to.length > 0 ? { to: body.to } : {},
    ...override.host === void 0 ? {} : { override }
  })
};
```

<a id="get_notification_settings"></a>

### GET /api/v1/notifications/settings

**get_notification_settings** — Notification routing: per-category recipient users, per-form overrides, site wordmark — plus candidate users and forms for the picker

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/notifications.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await getNotificationSettingsOp(app, ctx) };
```

<a id="update_notification_settings"></a>

### PUT /api/v1/notifications/settings

**update_notification_settings** — Save notification routing (recipients must be existing ACTIVE site users)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `integrations.configure` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/notifications.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "settings"
  ],
  "properties": {
    "settings": {
      "type": [
        "object",
        "null"
      ]
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body;
return {
  status: 200,
  body: await saveNotificationSettingsOp(app, ctx, { settings: body.settings ?? {} })
};
```

<a id="get_notification_subscriptions"></a>

### GET /api/v1/notifications/subscriptions

**get_notification_subscriptions** — The signed-in user's notification subscriptions (defaults: all enabled, immediate)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/notifications.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await getMyNotificationPrefsOp(app, ctx) };
```

<a id="update_notification_subscriptions"></a>

### PUT /api/v1/notifications/subscriptions

**update_notification_subscriptions** — Save the signed-in user's notification subscriptions (category opt-outs + digest interval)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/notifications.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "disabled": {
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 32
      }
    },
    "digest_minutes": {
      "type": "integer",
      "minimum": 0,
      "maximum": 720
    },
    "locale": {
      "type": "string",
      "enum": [
        "ru",
        "en"
      ]
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body;
return {
  status: 200,
  body: await saveMyNotificationPrefsOp(app, ctx, {
    disabled: body.disabled ?? [],
    digest_minutes: body.digest_minutes ?? 0,
    locale: body.locale
  })
};
```

<a id="rest-interactions"></a>

## interactions

Read/moderate/export submissions, quiz runs and leads with separate scopes.

| Method/path | Operation | Purpose |
|---|---|---|
| `POST /api/v1/interactions/export` | [export_interactions](#export_interactions) | Permission-gated, audited CSV/JSON export of submissions/quiz-runs/leads (§29) |
| `GET /api/v1/interactions/leads` | [list_leads](#list_leads) | Bounded lead list (PII; leads.read) |
| `GET /api/v1/interactions/leads/{leadId}` | [get_lead](#get_lead) | One lead with source provenance (PII; leads.read) |
| `PATCH /api/v1/interactions/leads/{leadId}` | [update_lead_status](#update_lead_status) | Lead lifecycle transition; emits LeadStatusChanged atomically (leads.manage) |
| `POST /api/v1/interactions/privacy/apply` | [apply_interaction_privacy](#apply_interaction_privacy) | Apply an explicit owner-authorized personal-data action using preview token and request ID |
| `GET /api/v1/interactions/privacy/cases/{caseId}` | [get_interaction_privacy_case](#get_interaction_privacy_case) | Read local action receipt and external-copy followups |
| `POST /api/v1/interactions/privacy/cases/{caseId}/deliveries/{deliveryId}/acknowledge` | [acknowledge_interaction_privacy](#acknowledge_interaction_privacy) | Record processor action evidence or explicit owner exception; never pretends to erase remote copies |
| `POST /api/v1/interactions/privacy/preview` | [preview_interaction_privacy](#preview_interaction_privacy) | Preview addressed data operation and controlled/downstream copies; no changes |
| `GET /api/v1/interactions/quiz-runs` | [list_quiz_runs](#list_quiz_runs) | Bounded quiz run history with server-computed results (interactions.read) |
| `GET /api/v1/interactions/quiz-runs/{runId}` | [get_quiz_run](#get_quiz_run) | One quiz run: lifecycle, score/outcome, all recorded answers |
| `GET /api/v1/interactions/submissions` | [list_submissions](#list_submissions) | Bounded, cursor-paginated form submission history (interactions.read) |
| `GET /api/v1/interactions/submissions/{submissionId}` | [get_submission](#get_submission) | One form submission: payload, consent snapshot, bounded spam metadata |
| `PATCH /api/v1/interactions/submissions/{submissionId}` | [update_submission_status](#update_submission_status) | Moderate a submission: ACCEPTED/SPAM/ARCHIVED (interactions.manage) |

<a id="export_interactions"></a>

### POST /api/v1/interactions/export

**export_interactions** — Permission-gated, audited CSV/JSON export of submissions/quiz-runs/leads (§29)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `interactions.export` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | supported |
| Body limit | 8192 bytes |
| Source | `packages/api/src/http/routes/interactions.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "entity": {
      "type": "string",
      "enum": [
        "submissions",
        "quiz_runs",
        "leads"
      ]
    },
    "format": {
      "type": "string",
      "enum": [
        "csv",
        "json"
      ]
    },
    "form_definition_id": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "quiz_definition_id": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "status": {
      "type": "string",
      "maxLength": 32
    },
    "created_after": {
      "type": "string",
      "maxLength": 32
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 10000
    }
  },
  "required": [
    "entity",
    "format"
  ]
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
const result = await app.formsSource.export.export(
  {
    ...body,
    ...typeof request.body.form_definition_id === "string" ? { form_definition_id: request.body.form_definition_id } : {},
    ...typeof request.body.quiz_definition_id === "string" ? { quiz_definition_id: request.body.quiz_definition_id } : {},
    ...typeof request.body.status === "string" ? { status: request.body.status } : {},
    ...typeof request.body.created_after === "string" ? { created_after: request.body.created_after } : {},
    ...typeof request.body.limit === "number" ? { limit: request.body.limit } : {}
  },
  { actor_type: ctx.actor.type, actor_id: ctx.actor.id }
);
return {
  status: 200,
  headers: {
    "content-type": result.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
    "x-pcms-export-rows": String(result.rows),
    "content-disposition": `attachment; filename="pcms-${result.entity}.${result.format}"`
  },
  body: result.content
};
```

<a id="list_leads"></a>

### GET /api/v1/interactions/leads

**list_leads** — Bounded lead list (PII; leads.read)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `leads.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/interactions.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "limit": {
      "type": "string",
      "pattern": "^[0-9]+$"
    },
    "cursor": {
      "type": "string",
      "maxLength": 128
    },
    "form_definition_id": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "quiz_definition_id": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "status": {
      "type": "string",
      "enum": [
        "NEW",
        "VIEWED",
        "PROCESSED",
        "ARCHIVED",
        "SPAM"
      ]
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
const page = parsePageRequest(query);
const statusFilter = optionalString(query.status);
const before = decodeInteractionCursor(page.cursor);
const rows = await app.formsSource.domain.leads.listLeads({
  ...statusFilter === void 0 ? {} : { status: statusFilter },
  ...before === void 0 ? {} : { before: { created_at: before.at, id: before.id } },
  limit: page.limit + 1
});
return {
  status: 200,
  body: pageOf(rows, page.limit, (row) => [row.created_at, row.id])
};
```

<a id="get_lead"></a>

### GET /api/v1/interactions/leads/{leadId}

**get_lead** — One lead with source provenance (PII; leads.read)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `leads.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/interactions.ts` |

Path parameters: `leadId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "leadId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "leadId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const lead = await app.formsSource.domain.leads.getLead(params.leadId);
const deliveries = await leadDeliveryProjection(app.pool, params.leadId);
return { status: 200, body: { ...lead, deliveries } };
```

<a id="update_lead_status"></a>

### PATCH /api/v1/interactions/leads/{leadId}

**update_lead_status** — Lead lifecycle transition; emits LeadStatusChanged atomically (leads.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `leads.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/interactions.ts` |

Path parameters: `leadId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "leadId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "leadId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "NEW",
        "VIEWED",
        "PROCESSED",
        "ARCHIVED",
        "SPAM"
      ]
    }
  },
  "required": [
    "status"
  ]
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await app.formsSource.setLeadStatus({
    lead_id: params.leadId,
    status: body.status
  })
};
```

<a id="apply_interaction_privacy"></a>

### POST /api/v1/interactions/privacy/apply

**apply_interaction_privacy** — Apply an explicit owner-authorized personal-data action using preview token and request ID

Verified behavior: Explicit block/unblock/rectify/erase with reviewed expected_token and canonical request_id. Exact-body retry is idempotent; keep case_id. Validates stored source schema, coordinates local copies and returns separate local/external states. No automatic recipient/export/backup deletion.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `privacy.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/interaction-privacy.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "target": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "entity": {
          "type": "string",
          "enum": [
            "submission",
            "quiz_run",
            "lead"
          ]
        },
        "id": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        }
      },
      "required": [
        "entity",
        "id"
      ]
    },
    "action": {
      "type": "string",
      "enum": [
        "rectify",
        "block",
        "unblock",
        "erase"
      ]
    },
    "correction": {
      "type": "object",
      "additionalProperties": false,
      "minProperties": 1,
      "properties": {
        "submission_payload": {
          "type": "object",
          "maxProperties": 256
        },
        "quiz_answers": {
          "type": "array",
          "maxItems": 256,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "question_id": {
                "type": "string",
                "maxLength": 128
              },
              "value": {}
            },
            "required": [
              "question_id",
              "value"
            ]
          }
        }
      }
    },
    "request_id": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "expected_token": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "request_ref": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300
    }
  },
  "required": [
    "target",
    "action",
    "request_id",
    "expected_token"
  ]
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 200,
  body: await applyInteractionPrivacy(
    app,
    ctx,
    request.body
  )
};
```

<a id="get_interaction_privacy_case"></a>

### GET /api/v1/interactions/privacy/cases/{caseId}

**get_interaction_privacy_case** — Read local action receipt and external-copy followups

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `privacy.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/interaction-privacy.ts` |

Path parameters: `caseId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "caseId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "caseId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 200,
  body: await getInteractionPrivacyCase(
    app,
    ctx,
    request.params.caseId
  )
};
```

<a id="acknowledge_interaction_privacy"></a>

### POST /api/v1/interactions/privacy/cases/{caseId}/deliveries/{deliveryId}/acknowledge

**acknowledge_interaction_privacy** — Record processor action evidence or explicit owner exception; never pretends to erase remote copies

Verified behavior: Records acknowledged or owner_exception for one receipt delivery; no outbound recipient call. Resolved decisions are immutable, actor/time retained and external object ID cleared. Opaque evidence_ref only; an exception is not remote deletion.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `privacy.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/interaction-privacy.ts` |

Path parameters: `caseId`, `deliveryId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "caseId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "deliveryId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "caseId",
    "deliveryId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "decision": {
      "type": "string",
      "enum": [
        "acknowledged",
        "owner_exception"
      ]
    },
    "evidence_ref": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300
    }
  },
  "required": [
    "decision"
  ]
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const { caseId, deliveryId } = request.params;
return {
  status: 200,
  body: await acknowledgeInteractionPrivacy(
    app,
    ctx,
    caseId,
    deliveryId,
    request.body
  )
};
```

<a id="preview_interaction_privacy"></a>

### POST /api/v1/interactions/privacy/preview

**preview_interaction_privacy** — Preview addressed data operation and controlled/downstream copies; no changes

Verified behavior: Optional addressed native-Forms operation, privacy.manage; read-only despite POST, session CSRF required. Returns controlled closure, token and known/possible external copies. Instance scope is unchanged; not subject discovery or per-record tenancy. See personal-data tools.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `privacy.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/interaction-privacy.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "target": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "entity": {
          "type": "string",
          "enum": [
            "submission",
            "quiz_run",
            "lead"
          ]
        },
        "id": {
          "type": "string",
          "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        }
      },
      "required": [
        "entity",
        "id"
      ]
    },
    "action": {
      "type": "string",
      "enum": [
        "rectify",
        "block",
        "unblock",
        "erase"
      ]
    },
    "correction": {
      "type": "object",
      "additionalProperties": false,
      "minProperties": 1,
      "properties": {
        "submission_payload": {
          "type": "object",
          "maxProperties": 256
        },
        "quiz_answers": {
          "type": "array",
          "maxItems": 256,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "question_id": {
                "type": "string",
                "maxLength": 128
              },
              "value": {}
            },
            "required": [
              "question_id",
              "value"
            ]
          }
        }
      }
    }
  },
  "required": [
    "target",
    "action"
  ]
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 200,
  body: await previewInteractionPrivacy(app, ctx, request.body)
};
```

<a id="list_quiz_runs"></a>

### GET /api/v1/interactions/quiz-runs

**list_quiz_runs** — Bounded quiz run history with server-computed results (interactions.read)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `interactions.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/interactions.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "limit": {
      "type": "string",
      "pattern": "^[0-9]+$"
    },
    "cursor": {
      "type": "string",
      "maxLength": 128
    },
    "form_definition_id": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "quiz_definition_id": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "status": {
      "type": "string",
      "enum": [
        "STARTED",
        "COMPLETED",
        "ABANDONED",
        "EXPIRED"
      ]
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
const page = parsePageRequest(query);
const quizFilter = optionalString(query.quiz_definition_id);
const stateFilter = optionalString(query.status);
const before = decodeInteractionCursor(page.cursor);
const rows = await app.formsSource.domain.runs.listRuns({
  ...quizFilter === void 0 ? {} : { quiz_definition_id: quizFilter },
  ...stateFilter === void 0 ? {} : { state: stateFilter },
  ...before === void 0 ? {} : { before: { started_at: before.at, id: before.id } },
  limit: page.limit + 1
});
const titles = await app.formsSource.definitionTitles({
  kind: "quiz",
  ids: rows.map((row) => row.quiz_definition_id)
});
return {
  status: 200,
  body: pageOf(
    rows.map((row) => ({ ...row, quiz_title: titles[row.quiz_definition_id] ?? null })),
    page.limit,
    (row) => [row.started_at, row.id]
  )
};
```

<a id="get_quiz_run"></a>

### GET /api/v1/interactions/quiz-runs/{runId}

**get_quiz_run** — One quiz run: lifecycle, score/outcome, all recorded answers

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `interactions.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/interactions.ts` |

Path parameters: `runId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "runId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "runId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const run = await app.formsSource.domain.runs.getRun(params.runId);
const detail = await app.formsSource.adminQuizRunDetail(params.runId);
return {
  status: 200,
  body: {
    ...run,
    quiz_title: detail.quiz_title,
    outcome_title: detail.outcome_title,
    lead_id: detail.lead_id,
    answers: detail.answers
  }
};
```

<a id="list_submissions"></a>

### GET /api/v1/interactions/submissions

**list_submissions** — Bounded, cursor-paginated form submission history (interactions.read)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `interactions.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/interactions.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "limit": {
      "type": "string",
      "pattern": "^[0-9]+$"
    },
    "cursor": {
      "type": "string",
      "maxLength": 128
    },
    "form_definition_id": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "quiz_definition_id": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "status": {
      "type": "string",
      "enum": [
        "ACCEPTED",
        "SPAM",
        "ARCHIVED"
      ]
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
const page = parsePageRequest(query);
const formFilter = optionalString(query.form_definition_id);
const statusFilter = optionalString(query.status);
const before = decodeInteractionCursor(page.cursor);
const rows = await app.formsSource.domain.submissions.listSubmissions({
  ...formFilter === void 0 ? {} : { form_definition_id: formFilter },
  ...statusFilter === void 0 ? {} : { status: statusFilter },
  ...before === void 0 ? {} : { before: { submitted_at: before.at, id: before.id } },
  limit: page.limit + 1
});
const titles = await app.formsSource.definitionTitles({
  kind: "form",
  ids: rows.map((row) => row.form_definition_id)
});
return {
  status: 200,
  body: pageOf(
    rows.map((row) => ({
      ...row,
      definition_title: titles[row.form_definition_id] ?? null
    })),
    page.limit,
    (row) => [row.submitted_at, row.id]
  )
};
```

<a id="get_submission"></a>

### GET /api/v1/interactions/submissions/{submissionId}

**get_submission** — One form submission: payload, consent snapshot, bounded spam metadata

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `interactions.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/interactions.ts` |

Path parameters: `submissionId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "submissionId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "submissionId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const detail = await app.formsSource.adminSubmissionDetail(params.submissionId);
const deliveries = await submissionDeliveryProjection(app.pool, params.submissionId);
return { status: 200, body: { ...detail, deliveries } };
```

<a id="update_submission_status"></a>

### PATCH /api/v1/interactions/submissions/{submissionId}

**update_submission_status** — Moderate a submission: ACCEPTED/SPAM/ARCHIVED (interactions.manage)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `interactions.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/interactions.ts` |

Path parameters: `submissionId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "submissionId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    }
  },
  "required": [
    "submissionId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "ACCEPTED",
        "SPAM",
        "ARCHIVED"
      ]
    }
  },
  "required": [
    "status"
  ]
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await app.formsSource.setSubmissionStatus({
    submission_id: params.submissionId,
    status: body.status
  })
};
```

<a id="rest-media"></a>

## media

Manage assets, folders, providers and acquisition. Import/accept before referencing managed media ids.

| Method/path | Operation | Purpose |
|---|---|---|
| `GET /api/v1/discovery/media/presets` | [list_media_presets](#list_media_presets) | Registered media presets |
| `GET /api/v1/media` | [search_media](#search_media) | Bounded, paginated media search (typed filters only) |
| `POST /api/v1/media` | [upload_media](#upload_media) | Direct binary upload; accepted assets include per-preset derivative failures when present (application/octet-stream + X-PCMS-Filename). |
| `GET /api/v1/media/{mediaId}` | [get_media](#get_media) | Full media diagnostic view (asset + versions + variants) |
| `PATCH /api/v1/media/{mediaId}` | [update_media_metadata](#update_media_metadata) | Update descriptive metadata and the image focal point |
| `POST /api/v1/media/{mediaId}/archive` | [archive_media](#archive_media) | Archive the asset (usage-aware hard delete is a privileged domain op) |
| `GET /api/v1/media/{mediaId}/file` | [get_media_file](#get_media_file) | Current-version file bytes for Admin previews (media.read; private cache) |
| `PATCH /api/v1/media/{mediaId}/folder` | [move_media_asset](#move_media_asset) | Move an asset into a folder (null = root) — logical only, identity/URLs unchanged |
| `GET /api/v1/media/{mediaId}/usage` | [get_media_usage](#get_media_usage) | Inbound references for the asset |
| `POST /api/v1/media/{mediaId}/variants/regenerate` | [regenerate_media_variants](#regenerate_media_variants) | Generate missing raster image variants for the active theme |
| `PUT /api/v1/media/{mediaId}/version` | [replace_media_version](#replace_media_version) | Replace the current document version (new immutable version) |
| `GET /api/v1/media/by-hash/{sha256}` | [search_media_by_hash](#search_media_by_hash) | Exact-bytes lookup (§45 dedupe): every asset whose current content hash matches — explains library duplicates |
| `GET /api/v1/media/folders` | [list_media_folders](#list_media_folders) | Logical media folders (editorial organization only) |
| `POST /api/v1/media/folders` | [create_media_folder](#create_media_folder) | Create a logical media folder |
| `DELETE /api/v1/media/folders/{folderId}` | [delete_media_folder](#delete_media_folder) | Delete an empty folder (MEDIA_FOLDER_NOT_EMPTY otherwise) |
| `PATCH /api/v1/media/folders/{folderId}` | [update_media_folder](#update_media_folder) | Rename and/or move a folder (cycle-protected) |
| `POST /api/v1/media/generations` | [create_media_generation](#create_media_generation) | Start an image generation run (provider-neutral; does not block on the provider — poll get_media_generation). |
| `GET /api/v1/media/generations/{generationId}` | [get_media_generation](#get_media_generation) | Generation run status and candidates (server-side references only; download URLs never leave the server). Auto-imported candidates may include media_variant_failures. |
| `POST /api/v1/media/generations/{generationId}/candidates/{candidateIndex}/accept` | [accept_generated_media](#accept_generated_media) | Accept a generated candidate: ingests through the canonical pipeline into a MediaAsset; replay returns the original asset and any media_variant_failures. |
| `POST /api/v1/media/generations/estimate` | [estimate_media_generation](#estimate_media_generation) | Approximate generation cost for the given settings before any cost-bearing call (token-priced models return an honest refusal). |
| `POST /api/v1/media/import` | [import_media_url](#import_media_url) | Server-side remote import (SSRF-safe); accepted assets include per-preset derivative failures when present. |
| `GET /api/v1/media/providers` | [list_media_providers](#list_media_providers) | Installed, enabled media acquisition providers (safe metadata, no credentials). |
| `GET /api/v1/media/providers/{providerId}` | [get_media_provider](#get_media_provider) | One media provider: safe state, config schema (secret slots included as schema), non-secret config, secret slot names. |
| `GET /api/v1/media/providers/{providerId}/capabilities` | [get_media_provider_capabilities](#get_media_provider_capabilities) | Runtime capability surface: configured models with size options, tiers, limits and prices (agent-safe; no credentials). |
| `GET /api/v1/media/providers/{providerId}/config` | [get_media_provider_config](#get_media_provider_config) | Provider settings surface: manifest config schema + public config (secret refs stripped) + secret-slot presence. |
| `PUT /api/v1/media/providers/{providerId}/config` | [update_media_provider_config](#update_media_provider_config) | Replace the non-secret provider configuration (secret slots keep their references). |
| `GET /api/v1/media/providers/{providerId}/models` | [list_media_provider_models](#list_media_provider_models) | Search the provider's native model catalog (setup-time discovery; touches the provider API). |
| `GET /api/v1/media/providers/{providerId}/models/{modelId}` | [get_media_provider_model](#get_media_provider_model) | One model's capability contract: stored snapshot with stale flag, or a live re-sync with ?sync=1. |
| `DELETE /api/v1/media/providers/{providerId}/secrets/{slot}` | [clear_media_provider_secret](#clear_media_provider_secret) | Delete a stored provider credential (provider becomes unconfigured). Audited. |
| `PUT /api/v1/media/providers/{providerId}/secrets/{slot}` | [set_media_provider_secret](#set_media_provider_secret) | Store a provider credential VALUE (write-only, encrypted at rest, audited, never returned). Requires media.providers.manage. |
| `POST /api/v1/media/providers/{providerId}/test` | [test_media_provider](#test_media_provider) | Run the provider connection test with the stored credentials (typed safe outcome, no raw provider errors). |
| `POST /api/v1/media/stock/import` | [import_stock_candidate](#import_stock_candidate) | Import a stock candidate through the canonical ingest pipeline; a new import includes optional per-preset media_variant_failures, while duplicate-safe re-import returns the existing asset. |
| `POST /api/v1/media/stock/search` | [search_stock_media](#search_stock_media) | Search enabled stock providers (provider-neutral; tolerates partial provider failure; candidates are opaque signed references). |

<a id="list_media_presets"></a>

### GET /api/v1/discovery/media/presets

**list_media_presets** — Registered media presets

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: { items: app.mediaPresets.listPresets() } };
```

<a id="search_media"></a>

### GET /api/v1/media

**search_media** — Bounded, paginated media search (typed filters only)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "text": {
      "type": "string",
      "maxLength": 200
    },
    "kind": {
      "type": "string"
    },
    "mime_type": {
      "type": "string",
      "maxLength": 100
    },
    "folder_id": {
      "type": "string",
      "maxLength": 64
    },
    "origin": {
      "type": "string",
      "enum": [
        "upload",
        "import",
        "stock",
        "generated"
      ]
    },
    "include_archived": {
      "type": "string",
      "enum": [
        "true",
        "false"
      ]
    },
    "limit": {
      "type": "string",
      "pattern": "^[0-9]+$"
    },
    "cursor": {
      "type": "string"
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 200,
  body: await searchMediaOp(app, ctx, request.query)
};
```

<a id="upload_media"></a>

### POST /api/v1/media

**upload_media** — Direct binary upload; accepted assets include per-preset derivative failures when present (application/octet-stream + X-PCMS-Filename).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.write` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | supported |
| Body limit | 268435456 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |
| Handler-specific input headers | `x-pcms-filename`, `x-pcms-folder-id`, `x-pcms-mime-type` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "media_id",
    "version_no",
    "sha256",
    "size_bytes",
    "mime_type",
    "duplicate_blob"
  ],
  "properties": {
    "media_id": {
      "type": "string"
    },
    "version_no": {
      "type": "integer"
    },
    "sha256": {
      "type": "string"
    },
    "size_bytes": {
      "type": "integer"
    },
    "mime_type": {
      "type": "string"
    },
    "duplicate_blob": {
      "type": "boolean"
    },
    "media_variant_failures": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "media_id",
          "preset",
          "error"
        ],
        "properties": {
          "media_id": {
            "type": "string"
          },
          "preset": {
            "type": "string"
          },
          "error": {
            "type": "string"
          }
        }
      }
    }
  }
}
```

Response construction:
```javascript
const bytes = request.body;
const filename = request.headers["x-pcms-filename"];
const declared = request.headers["x-pcms-mime-type"];
const folderHeader = request.headers["x-pcms-folder-id"];
const accepted = await uploadMediaOp(app, ctx, {
  bytes,
  filename,
  ...typeof declared === "string" ? { declared_mime_type: declared } : {},
  ...typeof folderHeader === "string" && folderHeader !== "" ? { folder_id: folderHeader } : {}
});
return {
  status: 201,
  body: {
    media_id: accepted.asset.id,
    version_no: accepted.version.versionNo,
    sha256: accepted.asset.sha256,
    size_bytes: accepted.asset.sizeBytes,
    mime_type: accepted.asset.mimeType,
    duplicate_blob: accepted.duplicateBlob,
    ...mediaVariantFailureField(accepted.media_variant_failures ?? [])
  }
};
```

<a id="get_media"></a>

### GET /api/v1/media/{mediaId}

**get_media** — Full media diagnostic view (asset + versions + variants)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: `mediaId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const inspected = await app.mediaDiscovery.inspectAsset(
  stableId(params.mediaId, "mediaId")
);
return { status: 200, body: inspected };
```

<a id="update_media_metadata"></a>

### PATCH /api/v1/media/{mediaId}

**update_media_metadata** — Update descriptive metadata and the image focal point

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.write` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `mediaId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "title": {
      "type": "string",
      "maxLength": 300,
      "nullable": true
    },
    "alt_default": {
      "type": "string",
      "maxLength": 300,
      "nullable": true
    },
    "caption_default": {
      "type": "string",
      "maxLength": 500,
      "nullable": true
    },
    "source_name": {
      "type": "string",
      "maxLength": 200,
      "nullable": true
    },
    "focal_x": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "nullable": true
    },
    "focal_y": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "nullable": true
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const asset = await updateMediaMetadataOp(app, ctx, {
  ...request.body,
  media_id: params.mediaId
});
return { status: 200, body: { media_id: asset.id, title: asset.title } };
```

<a id="archive_media"></a>

### POST /api/v1/media/{mediaId}/archive

**archive_media** — Archive the asset (usage-aware hard delete is a privileged domain op)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.archive` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `mediaId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: { ok: true } };
```

<a id="get_media_file"></a>

### GET /api/v1/media/{mediaId}/file

**get_media_file** — Current-version file bytes for Admin previews (media.read; private cache)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |
| Handler-local error codes (not the whole domain error set) | `API_NOT_FOUND`, `API_REQUEST_INVALID`, `MEDIA_STORAGE_UNAVAILABLE` |

Path parameters: `mediaId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const assetId = stableId(params.mediaId, "mediaId");
const asset = await getAsset(app.pool, assetId);
const deps = {
  pool: app.pool,
  storage: app.mediaStorage,
  maxSourceBytes: 128 * 1024 * 1024
};
const key = variantKeyFor({
  sourceSha256: asset.sha256,
  versionNo: asset.currentVersionNo,
  presetId: adminThumbnailPreset.id,
  ...adminThumbnailPreset,
  focalX: asset.focalX,
  focalY: asset.focalY,
  format: "webp"
});
const variant = await getVariant(app.pool, asset.id, asset.currentVersionNo, key) ?? (await generateVariantsForAsset(deps, asset, adminThumbnailRegistry))[0];
const versions = await listVersions(app.pool, assetId);
const current = versions.find((version) => version.versionNo === asset.currentVersionNo) ?? versions[0];
const blob = await getBlobByHash(app.pool, current.sha256);
const stream = await app.mediaStorage.getStream(blob.storageKey);
return {
  status: 200,
  headers: {
    "content-type": "image/webp",
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff"
  },
  body: await readVariantBytes(deps, variant)
};
return {
  status: 200,
  headers: {
    "content-type": current.mimeType,
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
    "content-disposition": `inline; filename="${encodeURIComponent(current.filenameOriginal)}"`
  },
  body: stream
};
```

<a id="move_media_asset"></a>

### PATCH /api/v1/media/{mediaId}/folder

**move_media_asset** — Move an asset into a folder (null = root) — logical only, identity/URLs unchanged

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.write` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: `mediaId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "folder_id"
  ],
  "properties": {
    "folder_id": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 64
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await moveMediaAssetOp(app, ctx, {
    media_id: params.mediaId,
    folder_id: body.folder_id
  })
};
```

<a id="get_media_usage"></a>

### GET /api/v1/media/{mediaId}/usage

**get_media_usage** — Inbound references for the asset

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: `mediaId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 200,
  body: await getMediaUsageOp(
    app,
    ctx,
    stableId(request.params.mediaId, "mediaId")
  )
};
```

<a id="regenerate_media_variants"></a>

### POST /api/v1/media/{mediaId}/variants/regenerate

**regenerate_media_variants** — Generate missing raster image variants for the active theme

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.write` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `mediaId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "media_id",
    "generated",
    "reused"
  ],
  "properties": {
    "media_id": {
      "type": "string"
    },
    "generated": {
      "type": "integer",
      "minimum": 0
    },
    "reused": {
      "type": "integer",
      "minimum": 0
    },
    "media_variant_failures": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "media_id",
          "preset",
          "error"
        ],
        "properties": {
          "media_id": {
            "type": "string"
          },
          "preset": {
            "type": "string"
          },
          "error": {
            "type": "string"
          }
        }
      }
    }
  }
}
```

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await regenerateMediaVariantsOp(app, ctx, { media_id: params.mediaId })
};
```

<a id="replace_media_version"></a>

### PUT /api/v1/media/{mediaId}/version

**replace_media_version** — Replace the current document version (new immutable version)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.replace` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 268435456 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |
| Handler-specific input headers | `x-pcms-filename` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: `mediaId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const bytes = request.body;
const filename = request.headers["x-pcms-filename"];
const result = await replaceMediaVersionOp(app, ctx, {
  media_id: params.mediaId,
  bytes,
  filename
});
return {
  status: 200,
  body: { media_id: params.mediaId, version_no: result?.version?.versionNo ?? null }
};
```

<a id="search_media_by_hash"></a>

### GET /api/v1/media/by-hash/{sha256}

**search_media_by_hash** — Exact-bytes lookup (§45 dedupe): every asset whose current content hash matches — explains library duplicates

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: `sha256`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const sha256 = params.sha256.toLowerCase();
const items = await app.mediaDiscovery.findAssetsByHash(sha256);
return { status: 200, body: { items } };
```

<a id="list_media_folders"></a>

### GET /api/v1/media/folders

**list_media_folders** — Logical media folders (editorial organization only)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await listMediaFoldersOp(app, ctx) };
```

<a id="create_media_folder"></a>

### POST /api/v1/media/folders

**create_media_folder** — Create a logical media folder

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.write` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name"
  ],
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "parent_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$",
      "nullable": true
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
return {
  status: 201,
  body: await createMediaFolderOp(app, ctx, {
    name: body.name,
    ...body.parent_id === void 0 ? {} : { parent_id: body.parent_id }
  })
};
```

<a id="delete_media_folder"></a>

### DELETE /api/v1/media/folders/{folderId}

**delete_media_folder** — Delete an empty folder (MEDIA_FOLDER_NOT_EMPTY otherwise)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.write` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `folderId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await deleteMediaFolderOp(app, ctx, { folder_id: params.folderId })
};
```

<a id="update_media_folder"></a>

### PATCH /api/v1/media/folders/{folderId}

**update_media_folder** — Rename and/or move a folder (cycle-protected)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.write` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `folderId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "parent_id": {
      "type": [
        "string",
        "null"
      ],
      "maxLength": 64
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body ?? {};
return {
  status: 200,
  body: await updateMediaFolderOp(app, ctx, {
    folder_id: params.folderId,
    ...body.name === void 0 ? {} : { name: body.name },
    ...body.parent_id === void 0 ? {} : { parent_id: body.parent_id }
  })
};
```

<a id="create_media_generation"></a>

### POST /api/v1/media/generations

**create_media_generation** — Start an image generation run (provider-neutral; does not block on the provider — poll get_media_generation).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.generate` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | supported |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/media-providers.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "required": [
    "prompt"
  ],
  "additionalProperties": false,
  "properties": {
    "prompt": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "provider_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "negative_prompt": {
      "type": "string",
      "maxLength": 2000
    },
    "aspect": {
      "type": "string",
      "maxLength": 16
    },
    "resolution": {
      "type": "string",
      "enum": [
        "0.5k",
        "1k",
        "2k",
        "4k"
      ]
    },
    "width": {
      "type": "integer",
      "minimum": 16,
      "maximum": 8192
    },
    "height": {
      "type": "integer",
      "minimum": 16,
      "maximum": 8192
    },
    "count": {
      "type": "integer",
      "minimum": 1,
      "maximum": 2
    },
    "model": {
      "type": "string",
      "maxLength": 200
    },
    "seed": {
      "type": "integer",
      "minimum": 0
    },
    "reference_media_ids": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      },
      "maxItems": 16
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const body = jsonBody(request);
return handle(
  app,
  ctx,
  () => createMediaGenerationOp(app, ctx, {
    prompt: String(body.prompt),
    ...body.provider_id === void 0 ? {} : { provider_id: String(body.provider_id) },
    ...body.negative_prompt === void 0 ? {} : { negative_prompt: String(body.negative_prompt) },
    ...body.aspect === void 0 ? {} : { aspect: String(body.aspect) },
    ...body.resolution === void 0 ? {} : { resolution: String(body.resolution) },
    ...body.width === void 0 ? {} : { width: Number(body.width) },
    ...body.height === void 0 ? {} : { height: Number(body.height) },
    ...body.count === void 0 ? {} : { count: Number(body.count) },
    ...body.model === void 0 ? {} : { model: String(body.model) },
    ...body.seed === void 0 ? {} : { seed: Number(body.seed) },
    ...body.reference_media_ids === void 0 ? {} : { reference_media_ids: body.reference_media_ids.map(String) }
  })
);
```

<a id="get_media_generation"></a>

### GET /api/v1/media/generations/{generationId}

**get_media_generation** — Generation run status and candidates (server-side references only; download URLs never leave the server). Auto-imported candidates may include media_variant_failures.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.generate` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/media-providers.ts` |

Path parameters: `generationId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "generationId"
  ],
  "properties": {
    "generationId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema:
```json
{
  "type": "object",
  "properties": {
    "generation_id": {
      "type": "string"
    },
    "provider_id": {
      "type": "string"
    },
    "status": {
      "enum": [
        "pending",
        "running",
        "ready",
        "failed"
      ]
    },
    "prompt": {
      "type": "string"
    },
    "error": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    },
    "cost": {
      "type": [
        "number",
        "null"
      ]
    },
    "candidates": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "index": {
            "type": "integer"
          },
          "preview_url": {
            "type": [
              "string",
              "null"
            ]
          },
          "width": {
            "type": [
              "integer",
              "null"
            ]
          },
          "height": {
            "type": [
              "integer",
              "null"
            ]
          },
          "mime_type": {
            "type": [
              "string",
              "null"
            ]
          },
          "model": {
            "type": [
              "string",
              "null"
            ]
          },
          "seed": {
            "type": [
              "integer",
              "null"
            ]
          },
          "cost": {
            "type": [
              "number",
              "null"
            ]
          },
          "media_id": {
            "type": "string"
          },
          "media_variant_failures": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "media_id",
                "preset",
                "error"
              ],
              "properties": {
                "media_id": {
                  "type": "string"
                },
                "preset": {
                  "type": "string"
                },
                "error": {
                  "type": "string"
                }
              }
            }
          }
        }
      }
    },
    "created_at": {
      "type": "string",
      "format": "date-time"
    }
  }
}
```

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(
  app,
  ctx,
  () => getMediaGenerationOp(app, ctx, {
    generation_id: String(request.params.generationId)
  })
);
```

<a id="accept_generated_media"></a>

### POST /api/v1/media/generations/{generationId}/candidates/{candidateIndex}/accept

**accept_generated_media** — Accept a generated candidate: ingests through the canonical pipeline into a MediaAsset; replay returns the original asset and any media_variant_failures.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.generate` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | supported |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/media-providers.ts` |

Path parameters: `generationId`, `candidateIndex`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "generationId",
    "candidateIndex"
  ],
  "properties": {
    "generationId": {
      "type": "string",
      "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    },
    "candidateIndex": {
      "type": "integer",
      "minimum": 0,
      "maximum": 64
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "media_id",
    "duplicate"
  ],
  "properties": {
    "media_id": {
      "type": "string"
    },
    "duplicate": {
      "type": "boolean"
    },
    "media_variant_failures": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "media_id",
          "preset",
          "error"
        ],
        "properties": {
          "media_id": {
            "type": "string"
          },
          "preset": {
            "type": "string"
          },
          "error": {
            "type": "string"
          }
        }
      }
    }
  }
}
```

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(
  app,
  ctx,
  () => acceptGeneratedMediaOp(app, ctx, {
    generation_id: String(params.generationId),
    candidate_index: Number(params.candidateIndex)
  })
);
```

<a id="estimate_media_generation"></a>

### POST /api/v1/media/generations/estimate

**estimate_media_generation** — Approximate generation cost for the given settings before any cost-bearing call (token-priced models return an honest refusal).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.generate` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/media-providers.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "provider_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "model": {
      "type": "string",
      "maxLength": 200
    },
    "aspect": {
      "type": "string",
      "maxLength": 16
    },
    "resolution": {
      "type": "string",
      "enum": [
        "0.5k",
        "1k",
        "2k",
        "4k"
      ]
    },
    "count": {
      "type": "integer",
      "minimum": 1,
      "maximum": 8
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const body = jsonBody(request);
return handle(
  app,
  ctx,
  () => estimateMediaGenerationOp(app, ctx, {
    ...body.provider_id === void 0 ? {} : { provider_id: String(body.provider_id) },
    ...body.model === void 0 ? {} : { model: String(body.model) },
    ...body.aspect === void 0 ? {} : { aspect: String(body.aspect) },
    ...body.resolution === void 0 ? {} : { resolution: String(body.resolution) },
    ...body.count === void 0 ? {} : { count: Number(body.count) }
  })
);
```

<a id="import_media_url"></a>

### POST /api/v1/media/import

**import_media_url** — Server-side remote import (SSRF-safe); accepted assets include per-preset derivative failures when present.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.import` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | supported |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "url"
  ],
  "properties": {
    "url": {
      "type": "string",
      "maxLength": 2048
    }
  }
}
```

Declared response schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "media_id",
    "version_no",
    "sha256",
    "duplicate_blob"
  ],
  "properties": {
    "media_id": {
      "type": "string"
    },
    "version_no": {
      "type": "integer"
    },
    "sha256": {
      "type": "string"
    },
    "duplicate_blob": {
      "type": "boolean"
    },
    "media_variant_failures": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "media_id",
          "preset",
          "error"
        ],
        "properties": {
          "media_id": {
            "type": "string"
          },
          "preset": {
            "type": "string"
          },
          "error": {
            "type": "string"
          }
        }
      }
    }
  }
}
```

Response construction:
```javascript
const accepted = await importMediaUrl(app, ctx, request.body);
return {
  status: 201,
  body: {
    media_id: accepted.asset.id,
    version_no: accepted.version.versionNo,
    sha256: accepted.asset.sha256,
    duplicate_blob: accepted.duplicateBlob,
    ...mediaVariantFailureField(accepted.media_variant_failures ?? [])
  }
};
```

<a id="list_media_providers"></a>

### GET /api/v1/media/providers

**list_media_providers** — Installed, enabled media acquisition providers (safe metadata, no credentials).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/media-providers.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, () => listMediaProvidersOp(app, ctx));
```

<a id="get_media_provider"></a>

### GET /api/v1/media/providers/{providerId}

**get_media_provider** — One media provider: safe state, config schema (secret slots included as schema), non-secret config, secret slot names.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/media-providers.ts` |

Path parameters: `providerId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "providerId"
  ],
  "properties": {
    "providerId": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,62}(\\.[a-z0-9][a-z0-9-]{0,62}){0,9}$"
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(
  app,
  ctx,
  () => getMediaProviderOp(app, ctx, {
    provider_id: String(request.params.providerId)
  })
);
```

<a id="get_media_provider_capabilities"></a>

### GET /api/v1/media/providers/{providerId}/capabilities

**get_media_provider_capabilities** — Runtime capability surface: configured models with size options, tiers, limits and prices (agent-safe; no credentials).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/media-providers.ts` |

Path parameters: `providerId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "providerId"
  ],
  "properties": {
    "providerId": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,62}(\\.[a-z0-9][a-z0-9-]{0,62}){0,9}$"
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(
  app,
  ctx,
  () => getMediaProviderCapabilitiesV2Op(app, ctx, {
    provider_id: String(request.params.providerId)
  })
);
```

<a id="get_media_provider_config"></a>

### GET /api/v1/media/providers/{providerId}/config

**get_media_provider_config** — Provider settings surface: manifest config schema + public config (secret refs stripped) + secret-slot presence.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.providers.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/media-providers.ts` |

Path parameters: `providerId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "providerId"
  ],
  "properties": {
    "providerId": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,62}(\\.[a-z0-9][a-z0-9-]{0,62}){0,9}$"
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(
  app,
  ctx,
  () => getMediaProviderConfigOp(app, ctx, {
    provider_id: String(request.params.providerId)
  })
);
```

<a id="update_media_provider_config"></a>

### PUT /api/v1/media/providers/{providerId}/config

**update_media_provider_config** — Replace the non-secret provider configuration (secret slots keep their references).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.providers.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/media-providers.ts` |

Path parameters: `providerId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "providerId"
  ],
  "properties": {
    "providerId": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,62}(\\.[a-z0-9][a-z0-9-]{0,62}){0,9}$"
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "required": [
    "config"
  ],
  "additionalProperties": false,
  "properties": {
    "config": {
      "type": "object",
      "additionalProperties": true,
      "maxProperties": 64
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(
  app,
  ctx,
  () => updateMediaProviderConfigOp(app, ctx, {
    provider_id: String(request.params.providerId),
    config: jsonBody(request).config
  })
);
```

<a id="list_media_provider_models"></a>

### GET /api/v1/media/providers/{providerId}/models

**list_media_provider_models** — Search the provider's native model catalog (setup-time discovery; touches the provider API).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.providers.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/media-providers.ts` |

Path parameters: `providerId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "providerId"
  ],
  "properties": {
    "providerId": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,62}(\\.[a-z0-9][a-z0-9-]{0,62}){0,9}$"
    }
  }
}
```

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "search": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
const query = request.query ?? {};
return handle(
  app,
  ctx,
  () => listProviderModelsOp(app, ctx, {
    provider_id: String(params.providerId),
    ...query.search === void 0 ? {} : { search: String(query.search) },
    ...query.limit === void 0 ? {} : { limit: Number(query.limit) }
  })
);
```

<a id="get_media_provider_model"></a>

### GET /api/v1/media/providers/{providerId}/models/{modelId}

**get_media_provider_model** — One model's capability contract: stored snapshot with stale flag, or a live re-sync with ?sync=1.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.providers.manage` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/media-providers.ts` |

Path parameters: `providerId`, `modelId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "providerId",
    "modelId"
  ],
  "properties": {
    "providerId": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,62}(\\.[a-z0-9][a-z0-9-]{0,62}){0,9}$"
    },
    "modelId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    }
  }
}
```

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "sync": {
      "type": "boolean"
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
const query = request.query ?? {};
return handle(
  app,
  ctx,
  () => getProviderModelOp(app, ctx, {
    provider_id: String(params.providerId),
    model_id: String(params.modelId),
    ...query.sync === void 0 ? {} : { sync: query.sync === true || query.sync === "true" }
  })
);
```

<a id="clear_media_provider_secret"></a>

### DELETE /api/v1/media/providers/{providerId}/secrets/{slot}

**clear_media_provider_secret** — Delete a stored provider credential (provider becomes unconfigured). Audited.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.providers.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/media-providers.ts` |

Path parameters: `providerId`, `slot`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "providerId",
    "slot"
  ],
  "properties": {
    "providerId": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,62}(\\.[a-z0-9][a-z0-9-]{0,62}){0,9}$"
    },
    "slot": {
      "type": "string",
      "pattern": "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$"
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(
  app,
  ctx,
  () => clearMediaProviderSecretOp(app, ctx, {
    provider_id: String(params.providerId),
    slot: String(params.slot)
  })
);
```

<a id="set_media_provider_secret"></a>

### PUT /api/v1/media/providers/{providerId}/secrets/{slot}

**set_media_provider_secret** — Store a provider credential VALUE (write-only, encrypted at rest, audited, never returned). Requires media.providers.manage.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.providers.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/media-providers.ts` |

Path parameters: `providerId`, `slot`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "providerId",
    "slot"
  ],
  "properties": {
    "providerId": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,62}(\\.[a-z0-9][a-z0-9-]{0,62}){0,9}$"
    },
    "slot": {
      "type": "string",
      "pattern": "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$"
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "required": [
    "value"
  ],
  "additionalProperties": false,
  "properties": {
    "value": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4096
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(
  app,
  ctx,
  () => setMediaProviderSecretOp(app, ctx, {
    provider_id: String(params.providerId),
    slot: String(params.slot),
    value: String(jsonBody(request).value ?? "")
  })
);
```

<a id="test_media_provider"></a>

### POST /api/v1/media/providers/{providerId}/test

**test_media_provider** — Run the provider connection test with the stored credentials (typed safe outcome, no raw provider errors).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.providers.manage` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/media-providers.ts` |

Path parameters: `providerId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "providerId"
  ],
  "properties": {
    "providerId": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,62}(\\.[a-z0-9][a-z0-9-]{0,62}){0,9}$"
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(
  app,
  ctx,
  () => testMediaProviderOp(app, ctx, {
    provider_id: String(request.params.providerId)
  })
);
```

<a id="import_stock_candidate"></a>

### POST /api/v1/media/stock/import

**import_stock_candidate** — Import a stock candidate through the canonical ingest pipeline; a new import includes optional per-preset media_variant_failures, while duplicate-safe re-import returns the existing asset.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.stock.import` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | supported |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/media-providers.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "required": [
    "candidate_ref"
  ],
  "additionalProperties": false,
  "properties": {
    "candidate_ref": {
      "type": "string",
      "minLength": 16,
      "maxLength": 8192
    },
    "folder_id": {
      "type": "string",
      "maxLength": 64
    }
  }
}
```

Declared response schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "media_id",
    "duplicate"
  ],
  "properties": {
    "media_id": {
      "type": "string"
    },
    "duplicate": {
      "type": "boolean"
    },
    "duplicate_blob": {
      "type": "boolean"
    },
    "media_variant_failures": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "media_id",
          "preset",
          "error"
        ],
        "properties": {
          "media_id": {
            "type": "string"
          },
          "preset": {
            "type": "string"
          },
          "error": {
            "type": "string"
          }
        }
      }
    }
  }
}
```

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const body = jsonBody(request);
return handle(
  app,
  ctx,
  () => importStockCandidateOp(app, ctx, {
    candidate_ref: String(body.candidate_ref),
    ...body.folder_id === void 0 ? {} : { folder_id: String(body.folder_id) }
  })
);
```

<a id="search_stock_media"></a>

### POST /api/v1/media/stock/search

**search_stock_media** — Search enabled stock providers (provider-neutral; tolerates partial provider failure; candidates are opaque signed references).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `media.stock.search` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/media-providers.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "required": [
    "query"
  ],
  "additionalProperties": false,
  "properties": {
    "query": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300
    },
    "provider_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "orientation": {
      "enum": [
        "landscape",
        "portrait",
        "square"
      ]
    },
    "min_width": {
      "type": "integer",
      "minimum": 1,
      "maximum": 20000
    },
    "min_height": {
      "type": "integer",
      "minimum": 1,
      "maximum": 20000
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50
    },
    "cursor": {
      "type": "string",
      "maxLength": 4096
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const body = jsonBody(request);
return handle(
  app,
  ctx,
  () => searchStockMediaOp(app, ctx, {
    query: String(body.query),
    ...body.provider_id === void 0 ? {} : { provider_id: String(body.provider_id) },
    ...body.orientation === void 0 ? {} : { orientation: body.orientation },
    ...body.min_width === void 0 ? {} : { min_width: Number(body.min_width) },
    ...body.min_height === void 0 ? {} : { min_height: Number(body.min_height) },
    ...body.limit === void 0 ? {} : { limit: Number(body.limit) },
    ...body.cursor === void 0 ? {} : { cursor: String(body.cursor) }
  })
);
```

<a id="rest-payments"></a>

## payments

Provider discovery, payment lifecycle, refunds and verified callbacks; mutations can move real money.

| Method/path | Operation | Purpose |
|---|---|---|
| `GET /api/v1/payments` | [list_payments](#list_payments) | Payment list with bounded filters (reliability surface) |
| `POST /api/v1/payments` | [create_payment](#create_payment) | Create a payment (idempotency_key is the retry identity) |
| `GET /api/v1/payments/{paymentId}` | [get_payment](#get_payment) | One payment with normalized/provider status |
| `POST /api/v1/payments/{paymentId}/cancel` | [cancel_payment](#cancel_payment) | Cancel a CREATED/PENDING payment |
| `GET /api/v1/payments/{paymentId}/events` | [list_payment_events](#list_payment_events) | Append-only payment timeline |
| `POST /api/v1/payments/{paymentId}/refund` | [refund_payment](#refund_payment) | Privileged refund (partial or full; audited) |
| `GET /api/v1/payments/{paymentId}/refunds` | [list_payment_refund_intents](#list_payment_refund_intents) | Refund intents of one payment (durable state machine, S7). |
| `GET /api/v1/payments/callback/{providerInstanceId}` | [receive_payment_callback](#receive_payment_callback) | Provider callback receiver (anonymous allowlist; provider verifier + InboundEvent dedup + state machine) |
| `GET /api/v1/payments/inbound-events` | [list_payment_inbound_events](#list_payment_inbound_events) | Inbound provider callbacks with processing state (S6 diagnostics; raw payloads never returned). |
| `GET /api/v1/payments/providers` | [list_payment_providers](#list_payment_providers) | Registered payment provider types with secret requirements |
| `GET /api/v1/payments/providers/{providerType}/capabilities` | [get_payment_provider_capabilities](#get_payment_provider_capabilities) | Provider capability report (cancel/refund/idempotency/sync) |
| `GET /api/v1/payments/providers/instances` | [list_payment_provider_instances](#list_payment_provider_instances) | Configured provider instances (secret-ref NAMES only) |
| `POST /api/v1/payments/providers/instances` | [create_payment_provider_instance](#create_payment_provider_instance) | Configure a provider instance (secret references only — no credential values). |
| `DELETE /api/v1/payments/providers/instances/{instanceId}` | [delete_payment_provider_instance](#delete_payment_provider_instance) | Decommission an instance; refused while payment history references it (disable instead). |
| `PATCH /api/v1/payments/providers/instances/{instanceId}` | [update_payment_provider_instance](#update_payment_provider_instance) | Update name/config/secret refs/enabled. Disabling refuses NEW payments; callbacks for existing payments keep processing. |
| `POST /api/v1/payments/providers/instances/{instanceId}/test` | [test_payment_provider_instance](#test_payment_provider_instance) | Offline configuration check (schema + secret resolvability + composition state); no live provider call. |

<a id="list_payments"></a>

### GET /api/v1/payments

**list_payments** — Payment list with bounded filters (reliability surface)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `payments.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/payments.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "status": {
      "type": "string",
      "maxLength": 24
    },
    "subject_type": {
      "type": "string",
      "maxLength": 60
    },
    "provider_instance_id": {
      "type": "string",
      "maxLength": 64
    },
    "external_id": {
      "type": "string",
      "maxLength": 200
    },
    "search": {
      "type": "string",
      "maxLength": 120
    },
    "created_from": {
      "type": "string",
      "maxLength": 32
    },
    "created_to": {
      "type": "string",
      "maxLength": 32
    },
    "limit": {
      "type": "string",
      "pattern": "^[0-9]+$"
    },
    "offset": {
      "type": "string",
      "pattern": "^[0-9]+$"
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const query = request.query;
const str = (name) => typeof query[name] === "string" ? query[name] : void 0;
const num = (name) => typeof query[name] === "string" ? Number(query[name]) : void 0;
return handle(
  app,
  ctx,
  (a, c) => listPayments(a, c, {
    ...str("status") === void 0 ? {} : { status: str("status") },
    ...str("subject_type") === void 0 ? {} : { subject_type: str("subject_type") },
    ...str("provider_instance_id") === void 0 ? {} : { provider_instance_id: str("provider_instance_id") },
    ...str("external_id") === void 0 ? {} : { external_id: str("external_id") },
    ...str("search") === void 0 ? {} : { search: str("search") },
    ...str("created_from") === void 0 ? {} : { created_from: str("created_from") },
    ...str("created_to") === void 0 ? {} : { created_to: str("created_to") },
    ...num("limit") === void 0 ? {} : { limit: num("limit") },
    ...num("offset") === void 0 ? {} : { offset: num("offset") }
  })
);
```

<a id="create_payment"></a>

### POST /api/v1/payments

**create_payment** — Create a payment (idempotency_key is the retry identity)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `payments.create` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | supported |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/payments.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "provider_instance_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    },
    "subject_type": {
      "type": "string",
      "maxLength": 60
    },
    "subject_id": {
      "type": "string",
      "maxLength": 120
    },
    "amount": {
      "type": "number",
      "exclusiveMinimum": 0
    },
    "currency": {
      "type": "string",
      "pattern": "^[A-Z]{3}$"
    },
    "description": {
      "type": "string",
      "maxLength": 500
    },
    "idempotency_key": {
      "type": "string",
      "minLength": 8,
      "maxLength": 200
    },
    "metadata": {
      "type": "object"
    }
  },
  "required": [
    "provider_instance_id",
    "subject_type",
    "subject_id",
    "amount",
    "currency",
    "idempotency_key"
  ]
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, (a, c) => createPayment(a, c, jsonBody(request)));
```

<a id="get_payment"></a>

### GET /api/v1/payments/{paymentId}

**get_payment** — One payment with normalized/provider status

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `payments.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/payments.ts` |

Path parameters: `paymentId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "paymentId": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    }
  },
  "required": [
    "paymentId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(app, ctx, (a, c) => getPayment(a, c, { payment_id: params.paymentId }));
```

<a id="cancel_payment"></a>

### POST /api/v1/payments/{paymentId}/cancel

**cancel_payment** — Cancel a CREATED/PENDING payment

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `payments.cancel` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/payments.ts` |

Path parameters: `paymentId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "paymentId": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    }
  },
  "required": [
    "paymentId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(app, ctx, (a, c) => cancelPayment(a, c, { payment_id: params.paymentId }));
```

<a id="list_payment_events"></a>

### GET /api/v1/payments/{paymentId}/events

**list_payment_events** — Append-only payment timeline

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `payments.events.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/payments.ts` |

Path parameters: `paymentId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "paymentId": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    }
  },
  "required": [
    "paymentId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(
  app,
  ctx,
  (a, c) => listPaymentEvents(a, c, { payment_id: params.paymentId })
);
```

<a id="refund_payment"></a>

### POST /api/v1/payments/{paymentId}/refund

**refund_payment** — Privileged refund (partial or full; audited)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `payments.refund` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/payments.ts` |

Path parameters: `paymentId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "paymentId": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    }
  },
  "required": [
    "paymentId"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "amount": {
      "type": "number",
      "exclusiveMinimum": 0
    },
    "reason": {
      "type": "string",
      "maxLength": 300
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
const body = typeof request.body === "object" && request.body !== null ? request.body : {};
return handle(
  app,
  ctx,
  (a, c) => refundPayment(a, c, {
    payment_id: params.paymentId,
    ...body["amount"] === void 0 ? {} : { amount: body["amount"] },
    ...body["reason"] === void 0 ? {} : { reason: body["reason"] }
  })
);
```

<a id="list_payment_refund_intents"></a>

### GET /api/v1/payments/{paymentId}/refunds

**list_payment_refund_intents** — Refund intents of one payment (durable state machine, S7).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `payments.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/payments.ts` |

Path parameters: `paymentId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "paymentId"
  ],
  "properties": {
    "paymentId": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(
  app,
  ctx,
  (a, c) => listPaymentRefunds(a, c, { payment_id: params.paymentId })
);
```

<a id="receive_payment_callback"></a>

### GET /api/v1/payments/callback/{providerInstanceId}

**receive_payment_callback** — Provider callback receiver (anonymous allowlist; provider verifier + InboundEvent dedup + state machine)

| Contract | Value |
|---|---|
| Authentication | public |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 262144 bytes |
| Source | `packages/api/src/http/routes/payments.ts` |
| Handler-local error codes (not the whole domain error set) | `PAYMENT_PROVIDER_INSTANCE_NOT_FOUND` |

Path parameters: `providerInstanceId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const instance = await app.payments.instances.get(params.providerInstanceId);
const rawBody = typeof request.body === "string" ? request.body : Buffer.isBuffer(request.body) ? request.body.toString("utf8") : JSON.stringify(request.body ?? null);
const record = await app.integrations.inbound.receiveOrphan({
  sourceType: "payment_provider",
  sourceId: instance.id,
  rawBody,
  reason: `provider type "${instance.providerType}" is not composed (extension disabled or absent)`
});
const parsed = outcome.normalized;
const applied = await app.payments.service.processCallback({
  providerInstanceId: instance.id,
  parsed,
  inboundEventId: outcome.record.id
});
return {
  status: 200,
  body: { received: true, retained: true, applied: false, event_id: record.id }
};
return {
  status: 200,
  body: { received: true, duplicate: true, event_id: outcome.record.id }
};
return {
  status: 200,
  body: { received: true, duplicate: false, applied: false, event_id: outcome.record.id }
};
return {
  status: 200,
  body: {
    received: true,
    duplicate: false,
    applied: applied.applied,
    event_id: outcome.record.id
  }
};
```

<a id="list_payment_inbound_events"></a>

### GET /api/v1/payments/inbound-events

**list_payment_inbound_events** — Inbound provider callbacks with processing state (S6 diagnostics; raw payloads never returned).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `payments.events.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/payments.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "status": {
      "enum": [
        "RECEIVED",
        "PROCESSED",
        "FAILED"
      ]
    },
    "limit": {
      "type": "string",
      "pattern": "^[0-9]+$"
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const query = request.query;
return handle(
  app,
  ctx,
  (a, c) => listPaymentInboundEvents(a, c, {
    ...typeof query["status"] === "string" ? { status: query["status"] } : {},
    ...typeof query["limit"] === "string" ? { limit: Number(query["limit"]) } : {}
  })
);
```

<a id="list_payment_providers"></a>

### GET /api/v1/payments/providers

**list_payment_providers** — Registered payment provider types with secret requirements

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `payments.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/payments.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, (a, c) => listPaymentProviders(a, c));
```

<a id="get_payment_provider_capabilities"></a>

### GET /api/v1/payments/providers/{providerType}/capabilities

**get_payment_provider_capabilities** — Provider capability report (cancel/refund/idempotency/sync)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `payments.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/payments.ts` |

Path parameters: `providerType`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "providerType": {
      "type": "string",
      "maxLength": 60
    }
  },
  "required": [
    "providerType"
  ]
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(
  app,
  ctx,
  (a, c) => getPaymentProviderCapabilities(a, c, { provider_type: params.providerType })
);
```

<a id="list_payment_provider_instances"></a>

### GET /api/v1/payments/providers/instances

**list_payment_provider_instances** — Configured provider instances (secret-ref NAMES only)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `payments.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/payments.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, (a, c) => listPaymentProviderInstances(a, c));
```

<a id="create_payment_provider_instance"></a>

### POST /api/v1/payments/providers/instances

**create_payment_provider_instance** — Configure a provider instance (secret references only — no credential values).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `payments.configure` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/payments.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": true,
  "maxProperties": 32
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
return handle(app, ctx, (a, c) => createProviderInstance(a, c, jsonBody(request)));
```

<a id="delete_payment_provider_instance"></a>

### DELETE /api/v1/payments/providers/instances/{instanceId}

**delete_payment_provider_instance** — Decommission an instance; refused while payment history references it (disable instead).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `payments.configure` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/payments.ts` |

Path parameters: `instanceId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "instanceId"
  ],
  "properties": {
    "instanceId": {
      "type": "string",
      "maxLength": 64
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(
  app,
  ctx,
  (a, c) => deleteProviderInstance(a, c, { instance_id: String(params.instanceId) })
);
```

<a id="update_payment_provider_instance"></a>

### PATCH /api/v1/payments/providers/instances/{instanceId}

**update_payment_provider_instance** — Update name/config/secret refs/enabled. Disabling refuses NEW payments; callbacks for existing payments keep processing.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `payments.configure` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/payments.ts` |

Path parameters: `instanceId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "instanceId"
  ],
  "properties": {
    "instanceId": {
      "type": "string",
      "maxLength": 64
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": true,
  "maxProperties": 32
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(
  app,
  ctx,
  (a, c) => updateProviderInstance(a, c, {
    instance_id: String(params.instanceId),
    ...jsonBody(request)
  })
);
```

<a id="test_payment_provider_instance"></a>

### POST /api/v1/payments/providers/instances/{instanceId}/test

**test_payment_provider_instance** — Offline configuration check (schema + secret resolvability + composition state); no live provider call.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `payments.configure` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/payments.ts` |

Path parameters: `instanceId`.

Explicit path schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "instanceId"
  ],
  "properties": {
    "instanceId": {
      "type": "string",
      "maxLength": 64
    }
  }
}
```

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction (the shared `handle` wrapper returns HTTP 200 with its callback result):
```javascript
const params = request.params;
return handle(
  app,
  ctx,
  (a, c) => testProviderInstance(a, c, { instance_id: String(params.instanceId) })
);
```

<a id="rest-publication"></a>

## publication

Coordinate sealed revisions, routes, changesets, plans and public visibility.

| Method/path | Operation | Purpose |
|---|---|---|
| `GET /api/v1/changesets` | [list_changesets](#list_changesets) | ChangeSets (bounded page, optional state filter) |
| `POST /api/v1/changesets` | [create_changeset](#create_changeset) | Create a ChangeSet (coordinated release container) |
| `GET /api/v1/changesets/{changesetId}` | [get_changeset](#get_changeset) | ChangeSet with items |
| `POST /api/v1/changesets/{changesetId}/apply` | [apply_changeset](#apply_changeset) | Apply the release: every pointer/route move in ONE transaction |
| `POST /api/v1/changesets/{changesetId}/cancel` | [cancel_changeset](#cancel_changeset) | Cancel a ChangeSet |
| `POST /api/v1/changesets/{changesetId}/items` | [add_changeset_item](#add_changeset_item) | Add a candidate (revision/route operation) to a ChangeSet |
| `POST /api/v1/changesets/{changesetId}/preflight` | [preflight_changeset](#preflight_changeset) | Validate the whole release without applying it |
| `GET /api/v1/entries/{entryId}/revisions` | [list_revisions](#list_revisions) | Revision history of an entry (bounded page) |
| `POST /api/v1/plans` | [create_publication_plan](#create_publication_plan) | Create a publication plan for a ready ChangeSet |
| `POST /api/v1/plans/{planId}/items/{itemId}/cancel` | [cancel_publication_item](#cancel_publication_item) | Cancel one scheduled item |
| `POST /api/v1/plans/{planId}/items/{itemId}/publish-now` | [publish_now](#publish_now) | Cancel the pending schedule and publish exactly once |
| `POST /api/v1/plans/{planId}/items/{itemId}/reschedule` | [reschedule_publication_item](#reschedule_publication_item) | Atomic cancel+replace of one pending schedule |
| `POST /api/v1/plans/{planId}/preview` | [preview_publication_plan](#preview_publication_plan) | Dry-run the schedule (nothing persisted) |
| `POST /api/v1/plans/{planId}/schedule` | [schedule_publication_plan](#schedule_publication_plan) | Materialize timestamps and enqueue idempotent jobs |
| `GET /api/v1/publication/calendar` | [list_publication_calendar](#list_publication_calendar) | Publication calendar window (bounded) |
| `GET /api/v1/publication/history` | [list_publication_history](#list_publication_history) | Human publication history (named operations, actors, results) |
| `GET /api/v1/publication/pending` | [list_pending_publications](#list_pending_publications) | Entries with unpublished work (human pending-publication view) |
| `GET /api/v1/publications/{entityType}/{entityId}` | [get_publication](#get_publication) | Current publication pointer for an entity |
| `POST /api/v1/publications/publish` | [publish_revision](#publish_revision) | Direct single-entity publish with generation CAS. Entries WITHOUT a live public route are rejected (409 PUBLICATION_ROUTE_MISSING) — first publish goes through a changeset with a route_operation. |
| `POST /api/v1/publications/rollback` | [rollback_publication](#rollback_publication) | Point the pointer at a previous sealed revision |
| `POST /api/v1/publications/unpublish` | [unpublish_publication](#unpublish_publication) | Remove public visibility (history preserved) |
| `GET /api/v1/revisions/{fromId}/diff/{toId}` | [diff_revisions](#diff_revisions) | Semantic diff between two revisions |
| `GET /api/v1/revisions/{revisionId}` | [get_revision](#get_revision) | Full revision record (payload included) |

<a id="list_changesets"></a>

### GET /api/v1/changesets

**list_changesets** — ChangeSets (bounded page, optional state filter)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "state": {
      "type": "string",
      "enum": [
        "DRAFT",
        "READY",
        "APPLIED",
        "CANCELLED"
      ]
    },
    "limit": {
      "type": "string",
      "pattern": "^[0-9]+$"
    },
    "cursor": {
      "type": "string"
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
const page = parsePageRequest(request.query);
const fetched = await app.changesets.listChangesets({
  limit: page.limit + 1,
  offset: page.cursor === null ? 0 : decodeOffsetCursor(page.cursor),
  ...typeof query.state === "string" ? { state: query.state } : {}
});
const body = pageOf(fetched, page.limit, (changeset) => [changeset.createdAt.getTime()]);
return {
  status: 200,
  body: {
    ...body,
    items: body.items.map((changeset) => ({
      id: changeset.id,
      title: changeset.title,
      state: changeset.state,
      created_at: changeset.createdAt.toISOString()
    }))
  }
};
```

<a id="create_changeset"></a>

### POST /api/v1/changesets

**create_changeset** — Create a ChangeSet (coordinated release container)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.plan` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "title"
  ],
  "properties": {
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 201,
  body: await createChangeset(app, ctx, request.body)
};
```

<a id="get_changeset"></a>

### GET /api/v1/changesets/{changesetId}

**get_changeset** — ChangeSet with items

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: `changesetId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const changeset = await app.changesets.getChangeset(
  stableId(params.changesetId, "changesetId")
);
const items = await app.changesets.listItems(changeset.id);
return { status: 200, body: { changeset, items } };
```

<a id="apply_changeset"></a>

### POST /api/v1/changesets/{changesetId}/apply

**apply_changeset** — Apply the release: every pointer/route move in ONE transaction

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.publish` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `changesetId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await applyChangeset(app, ctx, { changeset_id: params.changesetId })
};
```

<a id="cancel_changeset"></a>

### POST /api/v1/changesets/{changesetId}/cancel

**cancel_changeset** — Cancel a ChangeSet

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.plan` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `changesetId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: { ok: true } };
```

<a id="add_changeset_item"></a>

### POST /api/v1/changesets/{changesetId}/items

**add_changeset_item** — Add a candidate (revision/route operation) to a ChangeSet

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.plan` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `changesetId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "entity_type",
    "entity_id",
    "intent",
    "expected_generation"
  ],
  "properties": {
    "entity_type": {
      "type": "string",
      "enum": [
        "entry"
      ]
    },
    "entity_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    },
    "intent": {
      "enum": [
        "PUBLISH",
        "UNPUBLISH"
      ]
    },
    "target_revision_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    },
    "expected_generation": {
      "type": "integer",
      "minimum": 0
    },
    "context": {
      "type": "string",
      "maxLength": 32
    },
    "route_operation": {
      "type": "object"
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 201,
  body: await addChangesetItem(app, ctx, {
    ...request.body,
    changeset_id: params.changesetId
  })
};
```

<a id="preflight_changeset"></a>

### POST /api/v1/changesets/{changesetId}/preflight

**preflight_changeset** — Validate the whole release without applying it

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.plan` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `changesetId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
return {
  status: 200,
  body: await preflightChangeset(app, ctx, { changeset_id: params.changesetId })
};
```

<a id="list_revisions"></a>

### GET /api/v1/entries/{entryId}/revisions

**list_revisions** — Revision history of an entry (bounded page)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: `entryId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const entryId = stableId(params.entryId, "entryId");
const page = parsePageRequest(request.query);
const fetched = await app.revisions.listRevisions(app.pool, "entry", entryId, {
  limit: page.limit + 1,
  offset: page.cursor === null ? 0 : decodeOffsetCursor(page.cursor)
});
const body = pageOf(fetched, page.limit, (revision) => [revision.revisionNo]);
return {
  status: 200,
  body: {
    ...body,
    items: body.items.map((revision) => ({
      id: revision.id,
      revision_no: revision.revisionNo,
      state: revision.state,
      locale: revision.locale,
      schema_version: revision.schemaVersion,
      edit_generation: revision.editGeneration,
      created_at: revision.createdAt.toISOString(),
      sealed_at: revision.sealedAt?.toISOString() ?? null
    }))
  }
};
```

<a id="create_publication_plan"></a>

### POST /api/v1/plans

**create_publication_plan** — Create a publication plan for a ready ChangeSet

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.plan` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "changeset_id",
    "timezone"
  ],
  "properties": {
    "changeset_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    },
    "timezone": {
      "type": "string",
      "maxLength": 64
    },
    "failure_policy": {
      "enum": [
        "continue",
        "pause_batch",
        "pause_plan"
      ]
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 201,
  body: await createPublicationPlan(
    app,
    ctx,
    request.body
  )
};
```

<a id="cancel_publication_item"></a>

### POST /api/v1/plans/{planId}/items/{itemId}/cancel

**cancel_publication_item** — Cancel one scheduled item

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.schedule` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `planId`, `itemId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: { ok: true } };
```

<a id="publish_now"></a>

### POST /api/v1/plans/{planId}/items/{itemId}/publish-now

**publish_now** — Cancel the pending schedule and publish exactly once

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.publish` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `planId`, `itemId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: { ok: true } };
```

<a id="reschedule_publication_item"></a>

### POST /api/v1/plans/{planId}/items/{itemId}/reschedule

**reschedule_publication_item** — Atomic cancel+replace of one pending schedule

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.schedule` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `planId`, `itemId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "publish_at"
  ],
  "properties": {
    "publish_at": {
      "type": "string",
      "format": "date-time"
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body;
return {
  status: 200,
  body: await reschedulePlanItem(app, ctx, {
    plan_id: params.planId,
    item_id: params.itemId,
    publish_at: body.publish_at
  })
};
```

<a id="preview_publication_plan"></a>

### POST /api/v1/plans/{planId}/preview

**preview_publication_plan** — Dry-run the schedule (nothing persisted)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.plan` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `planId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "required": [
    "spec"
  ],
  "properties": {
    "spec": {
      "type": "object"
    },
    "overrides": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "changeset_item_id": {
            "type": "string",
            "pattern": "^[0-9a-f-]{36}$"
          },
          "changesetItemId": {
            "type": "string",
            "pattern": "^[0-9a-f-]{36}$"
          },
          "publish_at": {
            "type": "string",
            "format": "date-time"
          },
          "publishAt": {
            "type": "string",
            "format": "date-time"
          },
          "unpublish_at": {
            "type": "string",
            "format": "date-time"
          },
          "unpublishAt": {
            "type": "string",
            "format": "date-time"
          }
        },
        "anyOf": [
          {
            "properties": {
              "changeset_item_id": {
                "type": "string",
                "pattern": "^[0-9a-f-]{36}$"
              }
            },
            "required": [
              "changeset_item_id"
            ]
          },
          {
            "properties": {
              "changesetItemId": {
                "type": "string",
                "pattern": "^[0-9a-f-]{36}$"
              }
            },
            "required": [
              "changesetItemId"
            ]
          }
        ],
        "allOf": [
          {
            "anyOf": [
              {
                "properties": {
                  "publish_at": {
                    "type": "string",
                    "format": "date-time"
                  }
                },
                "required": [
                  "publish_at"
                ]
              },
              {
                "properties": {
                  "publishAt": {
                    "type": "string",
                    "format": "date-time"
                  }
                },
                "required": [
                  "publishAt"
                ]
              },
              {
                "properties": {
                  "unpublish_at": {
                    "type": "string",
                    "format": "date-time"
                  }
                },
                "required": [
                  "unpublish_at"
                ]
              },
              {
                "properties": {
                  "unpublishAt": {
                    "type": "string",
                    "format": "date-time"
                  }
                },
                "required": [
                  "unpublishAt"
                ]
              }
            ]
          }
        ]
      }
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body;
return {
  status: 200,
  body: {
    items: await previewPublicationPlan(app, ctx, {
      plan_id: params.planId,
      spec: body.spec,
      ...body.overrides === void 0 ? {} : { overrides: body.overrides }
    })
  }
};
```

<a id="schedule_publication_plan"></a>

### POST /api/v1/plans/{planId}/schedule

**schedule_publication_plan** — Materialize timestamps and enqueue idempotent jobs

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.schedule` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | supported |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: `planId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "required": [
    "spec"
  ],
  "properties": {
    "spec": {
      "type": "object"
    },
    "overrides": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "changeset_item_id": {
            "type": "string",
            "pattern": "^[0-9a-f-]{36}$"
          },
          "changesetItemId": {
            "type": "string",
            "pattern": "^[0-9a-f-]{36}$"
          },
          "publish_at": {
            "type": "string",
            "format": "date-time"
          },
          "publishAt": {
            "type": "string",
            "format": "date-time"
          },
          "unpublish_at": {
            "type": "string",
            "format": "date-time"
          },
          "unpublishAt": {
            "type": "string",
            "format": "date-time"
          }
        },
        "anyOf": [
          {
            "properties": {
              "changeset_item_id": {
                "type": "string",
                "pattern": "^[0-9a-f-]{36}$"
              }
            },
            "required": [
              "changeset_item_id"
            ]
          },
          {
            "properties": {
              "changesetItemId": {
                "type": "string",
                "pattern": "^[0-9a-f-]{36}$"
              }
            },
            "required": [
              "changesetItemId"
            ]
          }
        ],
        "allOf": [
          {
            "anyOf": [
              {
                "properties": {
                  "publish_at": {
                    "type": "string",
                    "format": "date-time"
                  }
                },
                "required": [
                  "publish_at"
                ]
              },
              {
                "properties": {
                  "publishAt": {
                    "type": "string",
                    "format": "date-time"
                  }
                },
                "required": [
                  "publishAt"
                ]
              },
              {
                "properties": {
                  "unpublish_at": {
                    "type": "string",
                    "format": "date-time"
                  }
                },
                "required": [
                  "unpublish_at"
                ]
              },
              {
                "properties": {
                  "unpublishAt": {
                    "type": "string",
                    "format": "date-time"
                  }
                },
                "required": [
                  "unpublishAt"
                ]
              }
            ]
          }
        ]
      }
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const body = request.body;
return {
  status: 200,
  body: {
    items: await schedulePublicationPlan(app, ctx, {
      plan_id: params.planId,
      spec: body.spec,
      ...body.overrides === void 0 ? {} : { overrides: body.overrides }
    })
  }
};
```

<a id="list_publication_calendar"></a>

### GET /api/v1/publication/calendar

**list_publication_calendar** — Publication calendar window (bounded)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "from": {
      "type": "string",
      "format": "date-time"
    },
    "to": {
      "type": "string",
      "format": "date-time"
    },
    "limit": {
      "type": "string",
      "pattern": "^[0-9]+$"
    },
    "cursor": {
      "type": "string"
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
const page = parsePageRequest(request.query);
const calendarEntries = await app.calendar.listCalendar({
  ...typeof query.from === "string" ? { from: new Date(query.from) } : {},
  ...typeof query.to === "string" ? { to: new Date(query.to) } : {},
  limit: page.limit,
  offset: page.cursor === null ? 0 : decodeOffsetCursor(page.cursor)
});
return {
  status: 200,
  body: {
    items: calendarEntries.map((entry) => ({
      ...entry,
      instant: entry.instant === null ? null : entry.instant.toISOString()
    })),
    has_more: calendarEntries.length === page.limit
  }
};
```

<a id="list_publication_history"></a>

### GET /api/v1/publication/history

**list_publication_history** — Human publication history (named operations, actors, results)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "limit": {
      "type": "string",
      "pattern": "^[0-9]+$"
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
return {
  status: 200,
  body: await listPublicationHistoryOp(app, ctx, {
    ...query.limit === void 0 ? {} : { limit: Number.parseInt(query.limit, 10) }
  })
};
```

<a id="list_pending_publications"></a>

### GET /api/v1/publication/pending

**list_pending_publications** — Entries with unpublished work (human pending-publication view)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "limit": {
      "type": "string",
      "pattern": "^[0-9]+$"
    }
  }
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
return {
  status: 200,
  body: await listPendingPublicationsOp(app, ctx, {
    ...query.limit === void 0 ? {} : { limit: Number.parseInt(query.limit, 10) }
  })
};
```

<a id="get_publication"></a>

### GET /api/v1/publications/{entityType}/{entityId}

**get_publication** — Current publication pointer for an entity

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |
| Handler-local error codes (not the whole domain error set) | `PUBLICATION_NOT_FOUND` |

Path parameters: `entityType`, `entityId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const publication = await app.publications.getPublication(
  app.pool,
  params.entityType,
  stableId(params.entityId, "entityId")
);
return {
  status: 200,
  body: {
    entity_type: publication.entityType,
    entity_id: publication.entityId,
    current_revision_id: publication.currentRevisionId,
    generation: publication.generation,
    published_at: publication.publishedAt?.toISOString() ?? null,
    state: publication.state
  }
};
```

<a id="publish_revision"></a>

### POST /api/v1/publications/publish

**publish_revision** — Direct single-entity publish with generation CAS. Entries WITHOUT a live public route are rejected (409 PUBLICATION_ROUTE_MISSING) — first publish goes through a changeset with a route_operation.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.publish` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | supported |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "entity_type",
    "entity_id",
    "target_revision_id",
    "expected_generation"
  ],
  "properties": {
    "entity_type": {
      "type": "string",
      "enum": [
        "entry"
      ]
    },
    "entity_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    },
    "target_revision_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    },
    "expected_generation": {
      "type": "integer",
      "minimum": 0
    },
    "context": {
      "type": "string",
      "maxLength": 32
    },
    "reason": {
      "type": "string",
      "maxLength": 500
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 200,
  body: await publishRevision(app, ctx, request.body)
};
```

<a id="rollback_publication"></a>

### POST /api/v1/publications/rollback

**rollback_publication** — Point the pointer at a previous sealed revision

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.rollback` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "entity_type",
    "entity_id",
    "target_revision_id",
    "expected_generation"
  ],
  "properties": {
    "entity_type": {
      "type": "string",
      "enum": [
        "entry"
      ]
    },
    "entity_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    },
    "target_revision_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    },
    "expected_generation": {
      "type": "integer",
      "minimum": 0
    },
    "context": {
      "type": "string",
      "maxLength": 32
    },
    "reason": {
      "type": "string",
      "maxLength": 500
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 200,
  body: await rollbackPublication(app, ctx, request.body)
};
```

<a id="unpublish_publication"></a>

### POST /api/v1/publications/unpublish

**unpublish_publication** — Remove public visibility (history preserved)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.unpublish` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "entity_type",
    "entity_id",
    "expected_generation"
  ],
  "properties": {
    "entity_type": {
      "type": "string",
      "enum": [
        "entry"
      ]
    },
    "entity_id": {
      "type": "string",
      "pattern": "^[0-9a-f-]{36}$"
    },
    "expected_generation": {
      "type": "integer",
      "minimum": 0
    },
    "context": {
      "type": "string",
      "maxLength": 32
    },
    "reason": {
      "type": "string",
      "maxLength": 500
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 200,
  body: await unpublishPublication(app, ctx, request.body)
};
```

<a id="diff_revisions"></a>

### GET /api/v1/revisions/{fromId}/diff/{toId}

**diff_revisions** — Semantic diff between two revisions

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |
| Handler-local error codes (not the whole domain error set) | `REVISION_NOT_FOUND` |

Path parameters: `fromId`, `toId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const from = await app.revisions.getRevision(
  app.pool,
  stableId(params.fromId, "fromId")
);
const to = await app.revisions.getRevision(
  app.pool,
  stableId(params.toId, "toId")
);
const { diffPayloads } = await import("@pcms/revisions");
return { status: 200, body: { diff: diffPayloads(from.payload, to.payload) } };
```

<a id="get_revision"></a>

### GET /api/v1/revisions/{revisionId}

**get_revision** — Full revision record (payload included)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `publication.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/discovery.ts` |
| Handler-local error codes (not the whole domain error set) | `REVISION_NOT_FOUND` |

Path parameters: `revisionId`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const revision = await app.revisions.getRevision(
  app.pool,
  stableId(params.revisionId, "revisionId")
);
return { status: 200, body: serializeRevision(revision) };
```

<a id="rest-search"></a>

## search

Query public/admin search, inspect index health and explicitly run reindexing.

| Method/path | Operation | Purpose |
|---|---|---|
| `GET /api/v1/search` | [search_query](#search_query) | Bounded public site search (PostgreSQL full-text, spec §23) |
| `GET /api/v1/search/admin` | [search_admin](#search_admin) | Authorized admin search across published, drafts, media, navigation (§24) |
| `GET /api/v1/search/capabilities` | [get_search_capabilities](#get_search_capabilities) | Machine-readable search capabilities (entity types, filters, sorts, limits) |
| `GET /api/v1/search/reindex` | [list_search_reindex_runs](#list_search_reindex_runs) | Reindex run history and progress (§26) |
| `POST /api/v1/search/reindex` | [reindex_search](#reindex_search) | Start or resume a full shadow-epoch reindex (§19/§20) |
| `GET /api/v1/search/status` | [get_search_status](#get_search_status) | Search index health, version and reindex progress (§26/§31) |
| `POST /api/v1/search/validate-document` | [validate_search_document](#validate_search_document) | Re-derive and validate one entity's search document (§31) |

<a id="search_query"></a>

### GET /api/v1/search

**search_query** — Bounded public site search (PostgreSQL full-text, spec §23)

| Contract | Value |
|---|---|
| Authentication | public |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/search.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "q": {
      "type": "string",
      "maxLength": 256
    },
    "site": {
      "type": "string",
      "maxLength": 64
    },
    "locale": {
      "type": "string",
      "maxLength": 16
    },
    "content_type": {
      "type": "string",
      "maxLength": 64
    },
    "date_from": {
      "type": "string",
      "maxLength": 32
    },
    "date_to": {
      "type": "string",
      "maxLength": 32
    },
    "sort": {
      "type": "string",
      "maxLength": 16
    },
    "limit": {
      "type": "string",
      "pattern": "^[0-9]+$"
    },
    "cursor": {
      "type": "string",
      "maxLength": 64
    }
  },
  "required": [
    "q"
  ]
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
return {
  status: 200,
  body: await app.searchQuery({
    q: String(query.q ?? ""),
    locale: String(query.locale ?? "default"),
    ...stringParam(query, "site"),
    ...stringParam(query, "content_type"),
    ...stringParam(query, "date_from"),
    ...stringParam(query, "date_to"),
    ...stringParam(query, "sort"),
    ...numberParam(query, "limit"),
    ...stringParam(query, "cursor")
  })
};
```

<a id="search_admin"></a>

### GET /api/v1/search/admin

**search_admin** — Authorized admin search across published, drafts, media, navigation (§24)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `search.admin` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/search.ts` |

Path parameters: none.

Query schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "q": {
      "type": "string",
      "maxLength": 256
    },
    "site": {
      "type": "string",
      "maxLength": 64
    },
    "locale": {
      "type": "string",
      "maxLength": 16
    },
    "limit": {
      "type": "string",
      "pattern": "^[0-9]+$"
    }
  },
  "required": [
    "q",
    "locale"
  ]
}
```

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const query = request.query;
const result = await app.searchAdmin({
  q: String(query.q ?? ""),
  locale: String(query.locale ?? "default"),
  ...stringParam(query, "site"),
  ...numberParam(query, "limit")
});
return { status: 200, body: result };
```

<a id="get_search_capabilities"></a>

### GET /api/v1/search/capabilities

**get_search_capabilities** — Machine-readable search capabilities (entity types, filters, sorts, limits)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/search.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: searchCapabilities() };
```

<a id="list_search_reindex_runs"></a>

### GET /api/v1/search/reindex

**list_search_reindex_runs** — Reindex run history and progress (§26)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `search.diagnostics` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/search.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: { runs: await app.searchReindex.listRuns() } };
```

<a id="reindex_search"></a>

### POST /api/v1/search/reindex

**reindex_search** — Start or resume a full shadow-epoch reindex (§19/§20)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `search.reindex` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | supported |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/search.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "resume": {
      "type": "boolean"
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
const run = await app.searchReindex.start({ resume: body.resume === true });
return {
  status: 202,
  body: {
    run_id: run.runId,
    epoch: run.epoch,
    total_documents: run.totalDocuments,
    chunks_total: run.chunksTotal,
    resumed: run.resumed
  }
};
```

<a id="get_search_status"></a>

### GET /api/v1/search/status

**get_search_status** — Search index health, version and reindex progress (§26/§31)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `search.diagnostics` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/search.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await searchStatus(app) };
```

<a id="validate_search_document"></a>

### POST /api/v1/search/validate-document

**validate_search_document** — Re-derive and validate one entity's search document (§31)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `search.admin` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/search.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "entity_type": {
      "type": "string",
      "maxLength": 64
    },
    "entity_id": {
      "type": "string",
      "maxLength": 64
    }
  },
  "required": [
    "entity_type",
    "entity_id"
  ]
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
const entityType = typeof body.entity_type === "string" ? body.entity_type : "";
const entityId = typeof body.entity_id === "string" ? body.entity_id : "";
const document = await app.searchSource.buildDocument(entityType, entityId);
const { validateSearchDocument } = await import("@pcms/search");
return {
  status: 200,
  body: { entity_type: entityType, entity_id: entityId, indexable: false, issues: [] }
};
return {
  status: 200,
  body: {
    entity_type: entityType,
    entity_id: entityId,
    indexable: true,
    issues: validateSearchDocument(document)
  }
};
```

<a id="rest-server"></a>

## server

Identify the target and diagnose the running instance.

| Method/path | Operation | Purpose |
|---|---|---|
| `GET /api/v1/diagnostics` | [get_diagnostics](#get_diagnostics) | Remote diagnostics: release version, DB, worker queue/heartbeat + recent job errors, media providers, registry binding, maintenance (site.validate). |
| `GET /api/v1/openapi.json` | [get_openapi_document](#get_openapi_document) | OpenAPI 3.1 contract of this API (deterministic release artifact) |
| `GET /api/v1/server` | [get_server_info](#get_server_info) | Server identity + subsystem contract versions (spec §20) |

<a id="get_diagnostics"></a>

### GET /api/v1/diagnostics

**get_diagnostics** — Remote diagnostics: release version, DB, worker queue/heartbeat + recent job errors, media providers, registry binding, maintenance (site.validate).

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `site.validate` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/core.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await getDiagnosticsOp(app, ctx) };
```

<a id="get_openapi_document"></a>

### GET /api/v1/openapi.json

**get_openapi_document** — OpenAPI 3.1 contract of this API (deterministic release artifact)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/core.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const doc = JSON.parse(cached);
return {
  status: 200,
  headers: { "cache-control": "private, max-age=60" },
  body: doc
};
```

<a id="get_server_info"></a>

### GET /api/v1/server

**get_server_info** — Server identity + subsystem contract versions (spec §20)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/core.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return {
  status: 200,
  body: {
    name: "progressive-cms",
    api_version: "v1",
    contract_versions: {
      api: API_CONTRACT_VERSION,
      theme: THEME_CONTRACT_VERSION,
      block_document: BLOCK_DOCUMENT_SCHEMA_VERSION,
      bundle: 1
    },
    server_time: app.clock.now().toISOString()
  }
};
```

<a id="rest-themes"></a>

## themes

Inspect, validate, install and activate presentation packages/settings.

| Method/path | Operation | Purpose |
|---|---|---|
| `POST /api/v1/previews` | [create_preview](#create_preview) | Create a signed, expiring preview reference (never a public route) |
| `POST /api/v1/theme/activate` | [activate_theme](#activate_theme) | Activate a validated installed theme and switch live rendering (theme.activate) |
| `PUT /api/v1/theme/settings` | [save_theme_settings](#save_theme_settings) | Save the working theme settings (CAS generation; theme.write) |
| `POST /api/v1/theme/settings/seal` | [seal_theme_settings](#seal_theme_settings) | Seal the working settings as a theme_settings revision (theme.write) |
| `GET /api/v1/themes/active` | [get_served_theme](#get_served_theme) | Actual in-memory theme id/version used by the public renderer (theme.read) |
| `POST /api/v1/themes/active/update` | [update_active_theme](#update_active_theme) | Replace the active theme with a newer package of the same id and refresh rendering without restart (theme.write + theme.activate) |
| `POST /api/v1/themes/install` | [install_theme](#install_theme) | Install a .pcTheme package (theme.write). Body: JSON {download_url} (repository artifact) or the raw package as application/octet-stream. The renderDir theme can never be overwritten. |
| `GET /api/v1/themes/installed` | [list_themes_installed](#list_themes_installed) | Installed themes in the themes root (theme.read). active = admin_theme_state row; isRenderTarget = the theme themes.renderDir actually serves. |
| `DELETE /api/v1/themes/installed/{name}` | [uninstall_theme](#uninstall_theme) | Uninstall an installed theme (theme.write). The renderDir theme is refused — switch themes.renderDir first. |
| `GET /api/v1/themes/revisions` | [list_theme_revisions](#list_theme_revisions) | Retained confirmed theme revisions for this site (active plus newest, at most 100) |
| `POST /api/v1/themes/revisions/cleanup` | [cleanup_theme_revisions](#cleanup_theme_revisions) | Preview old snapshots (theme.read) or remove explicit candidates (theme.write); preserves active, last-good, newest five and recovery revisions |
| `POST /api/v1/themes/rollback` | [rollback_theme_revision](#rollback_theme_revision) | Live activation of a retained revision, with lifecycle CAS (theme.write + theme.activate) |
| `POST /api/v1/themes/validate` | [validate_theme](#validate_theme) | Validate the configured theme source against the theme contract |

<a id="create_preview"></a>

### POST /api/v1/previews

**create_preview** — Create a signed, expiring preview reference (never a public route)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `preview.create` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "scope"
  ],
  "properties": {
    "scope": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "kind",
            "entity_type",
            "entity_id",
            "revision_id"
          ],
          "properties": {
            "kind": {
              "enum": [
                "revision"
              ]
            },
            "entity_type": {
              "type": "string",
              "enum": [
                "entry"
              ]
            },
            "entity_id": {
              "type": "string",
              "pattern": "^[0-9a-f-]{36}$"
            },
            "revision_id": {
              "type": "string",
              "pattern": "^[0-9a-f-]{36}$"
            },
            "allow_draft": {
              "type": "boolean"
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "kind",
            "changeset_id"
          ],
          "properties": {
            "kind": {
              "enum": [
                "changeset"
              ]
            },
            "changeset_id": {
              "type": "string",
              "pattern": "^[0-9a-f-]{36}$"
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "kind",
            "template"
          ],
          "properties": {
            "kind": {
              "enum": [
                "service"
              ]
            },
            "template": {
              "enum": [
                "search",
                "error-404"
              ]
            },
            "locale": {
              "type": "string",
              "maxLength": 64
            }
          }
        }
      ]
    },
    "theme": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9_-]{0,63}$"
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const result = await createThemePreview(app, ctx, request.body);
return {
  status: 201,
  body: {
    token: result.token,
    preview_path: `${request.body.scope.kind === "service" ? "/preview/page" : "/preview"}?token=${encodeURIComponent(result.token)}`
  }
};
```

<a id="activate_theme"></a>

### POST /api/v1/theme/activate

**activate_theme** — Activate a validated installed theme and switch live rendering (theme.activate)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `theme.activate` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "theme_key"
  ],
  "properties": {
    "theme_key": {
      "type": "string",
      "maxLength": 64
    },
    "theme_version": {
      "type": "string",
      "maxLength": 32
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
return {
  status: 200,
  body: await activateTheme(app, ctx, {
    theme_key: body.theme_key,
    ...typeof body.theme_version === "string" ? { theme_version: body.theme_version } : {}
  })
};
```

<a id="save_theme_settings"></a>

### PUT /api/v1/theme/settings

**save_theme_settings** — Save the working theme settings (CAS generation; theme.write)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `theme.write` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "values",
    "expected_generation"
  ],
  "properties": {
    "values": {
      "type": "object"
    },
    "expected_generation": {
      "type": "integer",
      "minimum": 0
    }
  }
}
```

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const body = request.body ?? {};
return {
  status: 200,
  body: await saveThemeSettings(app, ctx, {
    values: body.values,
    expected_generation: body.expected_generation
  })
};
```

<a id="seal_theme_settings"></a>

### POST /api/v1/theme/settings/seal

**seal_theme_settings** — Seal the working settings as a theme_settings revision (theme.write)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `theme.write` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await sealThemeSettings(app, ctx) };
```

<a id="get_served_theme"></a>

### GET /api/v1/themes/active

**get_served_theme** — Actual in-memory theme id/version used by the public renderer (theme.read)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `theme.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/themes-manage.ts` |
| Handler-local error codes (not the whole domain error set) | `THEME_RUNTIME_UNAVAILABLE` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema:
```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "version": {
      "type": "string"
    },
    "settings_generation": {
      "type": "integer"
    },
    "revision_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    },
    "theme_generation": {
      "type": "integer"
    }
  }
}
```

Response construction:
```javascript
return { status: 200, body: app.themeRuntime.served() };
```

<a id="update_active_theme"></a>

### POST /api/v1/themes/active/update

**update_active_theme** — Replace the active theme with a newer package of the same id and refresh rendering without restart (theme.write + theme.activate)

Verified behavior: Journaled same-id newer-package update: persists theme identity, preserves settings/settings_generation and retains confirmed immutable revisions. Failed changes restore the prior confirmed renderer/catalog head; recovery fails closed if authority is unavailable. Re-read served state after an ambiguous response; do not repair DB/files manually.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `theme.write` |
| Additional handler checks | `theme.activate` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 67174400 bytes |
| Source | `packages/api/src/http/routes/themes-manage.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID`, `THEME_RUNTIME_UNAVAILABLE` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const result = await changeTheme(app, ctx, {
  kind: "UPDATE",
  packageBytes: request.body
});
const info = result.info;
return { status: 200, body: { ...info, served: app.themeRuntime.served?.() } };
```

<a id="install_theme"></a>

### POST /api/v1/themes/install

**install_theme** — Install a .pcTheme package (theme.write). Body: JSON {download_url} (repository artifact) or the raw package as application/octet-stream. The renderDir theme can never be overwritten.

Verified behavior: Installs a new catalog package; ordinary install protects the currently rendered theme. Persistent activation can override the configured boot/render path. Use active-update for a newer package of the same served id.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `theme.write` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 67174400 bytes |
| Source | `packages/api/src/http/routes/themes-manage.ts` |
| Handler-specific input headers | `content-disposition` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const { root, renderDirId } = themesRootOf(app);
const raw = request.body;
const body = raw ?? {};
const options = {
  themesRoot: root,
  renderDirThemeId: renderDirId,
  cmsVersion: readCmsVersionFromRelease()
};
const info = await installThemePackage(bytes, options);
return { status: 201, body: { id: info.id, version: info.version, sha256: info.sha256 } };
```

<a id="list_themes_installed"></a>

### GET /api/v1/themes/installed

**list_themes_installed** — Installed themes in the themes root (theme.read). active = admin_theme_state row; isRenderTarget = the theme themes.renderDir actually serves.

Verified behavior: Lists catalog packages. `active` compares with persistent theme state; `is_render_target` identifies the current application theme directory after runtime activation. The registry summary still uses legacy renderDir wording. Use `/themes/active` to confirm what the renderer actually serves.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `theme.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/themes-manage.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const { root, renderDirId } = themesRootOf(app);
const active = await activeThemeKey(app);
return {
  status: 200,
  body: {
    themes: listInstalledThemes(root, renderDirId).map((theme) => ({
      id: theme.id,
      name: theme.name,
      version: theme.version,
      is_render_target: theme.isRenderTarget,
      active: theme.id === active,
      installed_at: theme.installedAt,
      source: theme.source,
      broken: theme.broken
    }))
  }
};
```

<a id="uninstall_theme"></a>

### DELETE /api/v1/themes/installed/{name}

**uninstall_theme** — Uninstall an installed theme (theme.write). The renderDir theme is refused — switch themes.renderDir first.

Verified behavior: Removes an installed catalog package while protecting the current render target. Activate another installed theme and verify served state first; changing configuration alone does not prove the runtime target changed.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `theme.write` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/themes-manage.ts` |
| Handler-local error codes (not the whole domain error set) | `API_REQUEST_INVALID` |

Path parameters: `name`.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
const params = request.params;
const name = String(params.name ?? "");
return { status: 200, body: { uninstalled: name } };
```

<a id="list_theme_revisions"></a>

### GET /api/v1/themes/revisions

**list_theme_revisions** — Retained confirmed theme revisions for this site (active plus newest, at most 100)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `theme.read` |
| Session CSRF | Not required by this route; anonymous/provider-origin checks can still apply. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/themes-manage.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema:
```json
{
  "type": "object",
  "properties": {
    "theme_generation": {
      "type": "integer"
    },
    "active_revision_id": {
      "type": [
        "string",
        "null"
      ],
      "format": "uuid"
    },
    "revisions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "revision_id": {
            "type": "string",
            "format": "uuid"
          },
          "theme_id": {
            "type": "string"
          },
          "package_version": {
            "type": "string"
          },
          "sha256": {
            "type": "string"
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "activated_at": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time"
          },
          "active": {
            "type": "boolean"
          }
        }
      }
    }
  }
}
```

Response construction:
```javascript
return { status: 200, body: await listThemeRevisions(app, ctx) };
```

<a id="cleanup_theme_revisions"></a>

### POST /api/v1/themes/revisions/cleanup

**cleanup_theme_revisions** — Preview old snapshots (theme.read) or remove explicit candidates (theme.write); preserves active, last-good, newest five and recovery revisions

Verified behavior: POST preview defaults dry_run=true (theme.read); apply needs theme.write, explicit site-owned revision_ids and observed theme_generation. Cookie CSRF applies even to preview. Protected/stale batches fail before mutation. Irreversible pruning excludes snapshots from history/rollback/assets before physical deletion; HTTP 200 with ok=false/pending requires explicit retry, not success. At most 100; see the theme cleanup chapter for protections and policy limits.

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | No fixed route scope; actor/domain-specific checks can still apply. |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/themes-manage.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "dry_run": {
      "type": "boolean",
      "default": true
    },
    "keep_last": {
      "type": "integer",
      "minimum": 5,
      "maximum": 100,
      "default": 5
    },
    "older_than_days": {
      "type": "integer",
      "minimum": 1,
      "maximum": 36500,
      "default": 1
    },
    "expected_generation": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "revision_ids": {
      "type": "array",
      "maxItems": 100,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "format": "uuid"
      }
    }
  }
}
```

Declared response schema:
```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean"
    },
    "dry_run": {
      "type": "boolean"
    },
    "theme_generation": {
      "type": "integer"
    },
    "keep_last": {
      "type": "integer"
    },
    "older_than_days": {
      "type": "integer"
    },
    "retained_count": {
      "type": "integer"
    },
    "has_more": {
      "type": "boolean"
    },
    "candidates": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "revision_id": {
            "type": "string",
            "format": "uuid"
          },
          "theme_id": {
            "type": "string"
          },
          "package_version": {
            "type": "string"
          },
          "last_used_at": {
            "type": "string",
            "format": "date-time"
          },
          "pending_cleanup": {
            "type": "boolean"
          }
        }
      }
    },
    "removed": {
      "type": "array",
      "items": {
        "type": "string",
        "format": "uuid"
      }
    },
    "pending": {
      "type": "array",
      "items": {
        "type": "string",
        "format": "uuid"
      }
    }
  }
}
```

Response construction:
```javascript
return {
  status: 200,
  body: await cleanupThemeRevisions(app, ctx, request.body)
};
```

<a id="rollback_theme_revision"></a>

### POST /api/v1/themes/rollback

**rollback_theme_revision** — Live activation of a retained revision, with lifecycle CAS (theme.write + theme.activate)

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `theme.write` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/themes-manage.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "revision_id",
    "expected_generation"
  ],
  "properties": {
    "revision_id": {
      "type": "string",
      "format": "uuid"
    },
    "expected_generation": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  }
}
```

Declared response schema:
```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean"
    },
    "served": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "version": {
          "type": "string"
        },
        "settings_generation": {
          "type": "integer"
        },
        "revision_id": {
          "type": [
            "string",
            "null"
          ],
          "format": "uuid"
        },
        "theme_generation": {
          "type": "integer"
        }
      }
    }
  }
}
```

Response construction:
```javascript
return {
  status: 200,
  body: await rollbackTheme(
    app,
    ctx,
    request.body
  )
};
```

<a id="validate_theme"></a>

### POST /api/v1/themes/validate

**validate_theme** — Validate the configured theme source against the theme contract

| Contract | Value |
|---|---|
| Authentication | authenticated |
| Declared permission | `theme.validate` |
| Session CSRF | Required for session-authenticated mutations; bearer exempt. |
| Registry idempotency | Not annotated; do not assume durable header replay. |
| Body limit | 1048576 bytes |
| Source | `packages/api/src/http/routes/mutations.ts` |

Path parameters: none.

Query schema: not declared by the registry; inspect the operation-specific notes and response mapping.

JSON body schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Declared response schema: not declared by the registry; inspect the operation-specific notes and response mapping.

Response construction:
```javascript
return { status: 200, body: await validateThemeOp(app, ctx) };
```

## Optional shipped extension operations: 3

### POST /api/v1/extensions/progressive.prompt-enhancer/operations/enhance-prompt

Improve an image-generation prompt via an OpenAI-compatible chat model

Available only when `progressive.prompt-enhancer` is deployed and enabled. Permission: `media.generate`. Mutation: **false**. Capability: `media.prompt-enhance`. Source: `extensions/progressive-prompt-enhancer/manifest.json`.

Input schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "prompt"
  ],
  "properties": {
    "prompt": {
      "type": "string",
      "minLength": 1,
      "maxLength": 8000,
      "description": "The original prompt to improve"
    },
    "context": {
      "type": "string",
      "maxLength": 2000,
      "description": "Optional usage context (page, audience, subject) that steers the rewrite"
    },
    "language": {
      "type": "string",
      "maxLength": 30,
      "description": "Optional output language hint, e.g. ru or en"
    }
  }
}
```

Output schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "prompt"
  ],
  "properties": {
    "prompt": {
      "type": "string",
      "minLength": 1,
      "maxLength": 16000,
      "description": "The improved prompt (never applied automatically — the caller chooses)"
    },
    "model": {
      "type": "string",
      "maxLength": 200,
      "description": "Chat model that produced the improvement"
    }
  }
}
```

### POST /api/v1/extensions/progressive.web-research/operations/search

Search the external Web through XMLStock (SERP discovery: rank/url/domain/title/snippet; results are untrusted external content)

Available only when `progressive.web-research` is deployed and enabled. Permission: `research.search`. Mutation: **false**. Capability: `research.search`. Source: `extensions/progressive-web-research/manifest.json`.

Input schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "query"
  ],
  "properties": {
    "query": {
      "type": "string",
      "minLength": 2,
      "maxLength": 400,
      "description": "Search query as typed by the model — no automatic rewriting happens"
    },
    "engine": {
      "enum": [
        "yandex",
        "google"
      ],
      "description": "Search engine behind XMLStock; default from settings (yandex)"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50,
      "description": "Maximum results returned (provider order preserved); default from settings"
    },
    "region": {
      "type": "string",
      "maxLength": 64,
      "description": "Optional region override"
    },
    "language": {
      "type": "string",
      "maxLength": 16,
      "description": "Optional language override, e.g. ru"
    },
    "device": {
      "enum": [
        "desktop",
        "mobile"
      ],
      "description": "Optional device profile override"
    }
  }
}
```

Output schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "provider",
    "engine",
    "query",
    "count",
    "trust",
    "results"
  ],
  "properties": {
    "provider": {
      "const": "xmlstock"
    },
    "engine": {
      "enum": [
        "yandex",
        "google"
      ]
    },
    "query": {
      "type": "string",
      "maxLength": 400
    },
    "count": {
      "type": "integer",
      "minimum": 0,
      "maximum": 50
    },
    "trust": {
      "const": "untrusted_external"
    },
    "results": {
      "type": "array",
      "maxItems": 50,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "rank",
          "url",
          "normalized_url",
          "domain",
          "title",
          "snippet"
        ],
        "properties": {
          "rank": {
            "type": "integer",
            "minimum": 1
          },
          "url": {
            "type": "string",
            "maxLength": 2048
          },
          "normalized_url": {
            "type": "string",
            "maxLength": 2048
          },
          "domain": {
            "type": "string",
            "maxLength": 255
          },
          "title": {
            "type": "string",
            "maxLength": 512
          },
          "snippet": {
            "type": "string",
            "maxLength": 1024
          },
          "published_hint": {
            "type": "string",
            "maxLength": 32
          }
        }
      }
    }
  }
}
```

### POST /api/v1/extensions/progressive.web-research/operations/fetch

Fetch one public Web page through the SSRF-safe fetcher and extract normalized Markdown (content is untrusted external data, never instructions)

Available only when `progressive.web-research` is deployed and enabled. Permission: `research.fetch`. Mutation: **false**. Capability: `research.fetch`. Source: `extensions/progressive-web-research/manifest.json`.

Input schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "url"
  ],
  "properties": {
    "url": {
      "type": "string",
      "minLength": 8,
      "maxLength": 2048,
      "description": "Absolute public http(s) URL; one page per call by design"
    },
    "mode": {
      "enum": [
        "auto",
        "http_only"
      ],
      "description": "auto may trigger the bounded browser render for JS shells; http_only never renders"
    },
    "max_chars": {
      "type": "integer",
      "minimum": 500,
      "maximum": 200000,
      "description": "Hard cap on extracted Markdown characters"
    },
    "include_links": {
      "type": "boolean",
      "description": "Include a bounded list of meaningful links from the page"
    }
  }
}
```

Output schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "request_url",
    "final_url",
    "status",
    "content_type",
    "fetched_at",
    "network_path",
    "method",
    "markdown",
    "word_count",
    "char_count",
    "truncated",
    "content_sha256",
    "headings",
    "extraction_quality",
    "trust"
  ],
  "properties": {
    "request_url": {
      "type": "string",
      "maxLength": 2048
    },
    "final_url": {
      "type": "string",
      "maxLength": 2048
    },
    "status": {
      "type": "integer",
      "minimum": 200,
      "maximum": 599
    },
    "content_type": {
      "type": "string",
      "maxLength": 255
    },
    "fetched_at": {
      "type": "string",
      "maxLength": 40
    },
    "network_path": {
      "enum": [
        "direct",
        "socks5",
        "direct_then_socks5"
      ]
    },
    "method": {
      "enum": [
        "http_readability",
        "http_text",
        "browser_render",
        "http_pdf",
        "vision_fallback"
      ]
    },
    "title": {
      "type": "string",
      "maxLength": 512
    },
    "description": {
      "type": "string",
      "maxLength": 1024
    },
    "canonical_url": {
      "type": "string",
      "maxLength": 2048
    },
    "language": {
      "type": "string",
      "maxLength": 32
    },
    "author_hint": {
      "type": "string",
      "maxLength": 255
    },
    "published_at_hint": {
      "type": "string",
      "maxLength": 64
    },
    "markdown": {
      "type": "string",
      "maxLength": 200000
    },
    "word_count": {
      "type": "integer",
      "minimum": 0
    },
    "char_count": {
      "type": "integer",
      "minimum": 0
    },
    "truncated": {
      "type": "boolean"
    },
    "content_sha256": {
      "type": "string",
      "maxLength": 64
    },
    "headings": {
      "type": "array",
      "maxItems": 100,
      "items": {
        "type": "string",
        "maxLength": 512
      }
    },
    "links": {
      "type": "array",
      "maxItems": 50,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "url",
          "text"
        ],
        "properties": {
          "url": {
            "type": "string",
            "maxLength": 2048
          },
          "text": {
            "type": "string",
            "maxLength": 255
          }
        }
      }
    },
    "extraction_quality": {
      "enum": [
        "good",
        "thin",
        "fallback"
      ]
    },
    "trust": {
      "const": "untrusted_external"
    },
    "page_count": {
      "type": "integer",
      "minimum": 1,
      "description": "PDF page count"
    },
    "vision_used": {
      "type": "boolean",
      "description": "true when the vision transcriber produced/recovered the body text (derived evidence)"
    }
  }
}
```

## HTTP surfaces outside the REST registry

| Method | Route/pattern | Purpose and contract | Source |
|---|---|---|---|
| STATIC | `/admin/*` | Static Admin SPA assets, conditional on bundle presence. API authentication remains required; static HTML is not a privileged session. | `apps/web/src/admin.ts` |
| GET | `/admin` | Redirect to /admin/ when an Admin bundle is installed. | `apps/web/src/admin.ts` |
| GET | `/favicon.ico` | Same-origin redirect to Site Identity favicon or 404 if unset; no theme-specific icon configuration needed. | `apps/web/src/favicon.ts` |
| GET | `/health/live` | Anonymous liveness: 200 {status:"live"}; does not test DB. | `apps/web/src/health.ts` |
| GET | `/health/ready` | Anonymous readiness: 200 {status:"ready"} or 503 {status:"not_ready"}; dependency details stay in logs. | `apps/web/src/health.ts` |
| POST | `/mcp` | Bearer-only JSON-RPC transport; see the MCP map. POST only, 1 MiB. | `apps/web/src/main.ts` |
| GET | `/media/a/*` | Public versioned/current managed-media files, variants and document-download paths. Validates path and public access policy; not an upload route. | `apps/web/src/media-files.ts` |
| GET | `/preview` | Signed token query, resolved preview state JSON; expired/invalid references fail, private/no-store/noindex. | `apps/web/src/preview.ts` |
| GET | `/core-assets/richtext-v2.css` | Core RichText fallback CSS; text/css, public cache 3600 seconds. | `apps/web/src/richtext-assets.ts` |
| GET | `/search` | Public rendered search page; query q/locale and bounded filters are passed to search. HTML output, separate from /api/v1/search JSON. | `apps/web/src/search-page.ts` |
| GET | `/search/` | Same public HTML search handler as /search; both paths are registered. Search results carry noindex, follow. | `apps/web/src/search-page.ts` |
| GET | `/robots.txt` | Text robots policy from SEO; public cache 3600 seconds. | `apps/web/src/seo-files.ts` |
| GET | `/sitemap.xml` | XML sitemap from SEO or 404 when unavailable; public cache 3600 seconds. | `apps/web/src/seo-files.ts` |
| GET | `/preview/page` | Signed preview token; renders the selected page/revision/theme in HTML with private/no-store/noindex headers. | `apps/web/src/site.ts` |
| GET | `/*` | GET resolves locale/extension mounts, SEO key files, public search/routes and published pages. Non-GET POST/PUT/DELETE/PATCH dispatches extension HTTP routes only. Unknown paths fail; this is not a generic authoring API. | `apps/web/src/site.ts` |
| POST, PUT, DELETE, PATCH | `/*` | GET resolves locale/extension mounts, SEO key files, public search/routes and published pages. Non-GET POST/PUT/DELETE/PATCH dispatches extension HTTP routes only. Unknown paths fail; this is not a generic authoring API. | `apps/web/src/site.ts` |
| GET | `/themes/*` | Public active asset aliases and immutable <theme-id>/revisions/<uuid>/assets/<path> for confirmed revisions; rejects traversal/private template/manifest reads. HTML assets are revision-pinned; opaque JS/absolute CSS can still reference the active alias. | `apps/web/src/theme-files.ts` |

Extension HTTP routes under `/x/<extension-id>/` and assigned site mounts are installation-dependent; GET and non-GET dispatch use the same deployed extension descriptors. Consult the extension contract, enabled state and mount discovery; these wildcard dispatchers do not promise a fixed list of third-party routes.
<!-- interface-map:end -->

[Documentation index](index.md) · [REST guide](rest-api.md) · [CLI map](cli-map.md) · [MCP map](mcp-map.md)
