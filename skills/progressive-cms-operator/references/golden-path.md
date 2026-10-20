# Golden path — command reference (operator skill)

All commands assume the config resolution order from SKILL.md and no secrets
in argv. `--json` always yields the stable envelope; stdout = result, stderr =
diagnostics.

## Discovery / health

```bash
cms agent bootstrap --json
cms doctor
cms capabilities --json
cms info
curl -sS "$PCMS_API_URL/api/v1/system/status" -H "Authorization: Bearer $PCMS_API_TOKEN"
curl -sS "$PCMS_API_URL/api/v1/system/metrics?hours=24" -H "Authorization: Bearer $PCMS_API_TOKEN"
```

## Config

```bash
cms config validate --config /etc/progressive-cms/pcms.json --json
# offline commands (db/media/schema/...) honour the same resolution:
export PCMS_CONFIG_FILE=/etc/progressive-cms/pcms.json
cms db migrate --check --json      # pending/drift without applying
```

**HTTPS за reverse-proxy → `http.trustedProxies` обязателен.** Без адреса
прокси сайт выглядит живым, но любая авторизованная мутация падает
403 `API_ORIGIN_MISMATCH` («cross-site origin rejected»). Симптом в логе
web — разовый `http.untrusted_proxy_headers` с готовой подсказкой. Чинится
внесением адреса прокси (например `192.0.2.10` или `127.0.0.1`) в
`http.trustedProxies` и рестартом web+worker.

## Migrations

```bash
cms db migrate --check --json      # plan only
cms db migrate --json              # apply pending (advisory-locked, ledgered)
# never: manual INSERT/UPDATE on the migrations ledger; never skip checksums
```

## Extensions lifecycle + settings

```bash
cms extensions list --json
cms extensions install progressive.prompt-enhancer --json
cms extensions enable  progressive.prompt-enhancer --json
# settings (extensions.manage):
curl -sS -H "Authorization: Bearer $T" "$API/api/v1/extensions/progressive.prompt-enhancer/config"
curl -sS -X PUT -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"config":{"base_url":"https://openrouter.ai/api/v1","model":"…","reasoning_level":"off"}}' \
  "$API/api/v1/extensions/progressive.prompt-enhancer/config"
curl -sS -X PUT -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"value":"<secret>"}' "$API/api/v1/extensions/progressive.prompt-enhancer/secrets/api_key"
```

## Media providers

```bash
curl -sS -H "Authorization: Bearer $T" "$API/api/v1/media/providers"
# network + credentials through the SAME config contract; then:
curl -sS -X POST -H "Authorization: Bearer $T" "$API/api/v1/media/providers/pexels/test"
curl -sS -X POST -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"query":"warehouse","limit":5}' "$API/api/v1/media/stock/search"
```

Generation defaults: model `runware:z-image@turbo`, exactly 1 image per run
unless the operator raises the count; model-specific request fields come from
the published model schema (`runware.ai/docs/models/<slug>/schema.json`),
operator passthrough via the `model_params` config key.

## Maintenance

```bash
cms maintenance status
cms maintenance enable  --environment production --yes
cms maintenance disable --environment production --yes
# fail-secure: a failed update leaves maintenance ON; bypass actors use
# site.maintenance.bypass and keep working while the public sees the 503.
```

## Updates

Two paths. **Registry-driven (canonical, no SSH):** the instance pulls the
release from the registry itself — the LOCAL manifest is irrelevant here
(`cms update check` compares against it and says UPDATE_NOT_AN_UPGRADE even
when the registry has a newer release; that is not an error).

```bash
# Current Core 1.x line: use the registry-aware CLI, which runs the standard
# backup → install → migrate → restart → doctor sequence.
cms registry status                       # binding + registry configured
cms registry releases --json              # what the registry serves (latest first)
cms registry apply --version <published-version> --environment <env> --yes --json
# choose an explicit version from releases; do not infer compatibility from "latest"
# if apply is still running or the connection drops, check the latest run:
curl --config "$PCMS_CURL_AUTH" -sS "$PCMS_API_URL/api/v1/registry/update-status"
cms agent bootstrap --json                 # confirm served version/release
# registry status reports binding/configuration; it is not update-run status
# there is no cms registry update-status subcommand
```

**Manifest-driven (fallback):** artifacts already staged in `incoming/`:

```bash
cms update check  --manifest /opt/progressive-cms/incoming/update-manifest.json --json
cms update apply  --manifest /opt/progressive-cms/incoming/update-manifest.json --environment production --yes --json
# after re-staging artifacts: restart web first (target manifest is read at boot)
```

`GET /api/v1/registry/update-status` is authenticated and requires
`extensions.manage`. It returns `current_version` and the latest update record
(`id`, `status`, `from_version`, `to_version`, `failure_code`,
`started_at`, `completed_at`). `status` is `RUNNING`, `SUCCEEDED` or `FAILED`.
Treat apply as complete only when the record is `SUCCEEDED`, its
`to_version` equals the explicitly requested version, `current_version` matches
that version, and `cms agent bootstrap --json` reports the expected served
release. If it is `RUNNING`, keep polling; if `FAILED`, record `failure_code`
and follow the declared rollback policy. The endpoint reports the latest
record, not a per-request lookup, so verify `to_version` before attributing it
to the apply attempt. Keep bearer credentials in the approved curl config
(`$PCMS_CURL_AUTH`), not in command arguments.

## Extension mounts and guest mutations

An extension's public route must exist in its trusted deployed manifest and be
enabled. On an isolated acceptance instance, install and enable an artifact
already in the trusted catalog with:

```bash
curl --config "$PCMS_CURL_AUTH" -sS -X POST -H 'Content-Type: application/json' \
  --data '{}' "$PCMS_API_URL/api/v1/extensions/<extension-id>/install"
curl --config "$PCMS_CURL_AUTH" -sS -X POST \
  "$PCMS_API_URL/api/v1/extensions/<extension-id>/enable"
```

Both operations require `extensions.manage`, are audited, and do not download
or add artifacts. Session login is `POST /api/v1/auth/login` with JSON
`{"email":"...","password":"..."}`; it sets `pcms_session` and returns
`csrf_token`. For session authentication, send that cookie, same-origin
`Origin` and `X-PCMS-CSRF`; bearer-token calls use the approved curl config
and service-token permission. The CLI equivalents are
`cms extensions install <id>` and `cms extensions enable <id>`. The route path
in `registrations.http_routes[]` is relative to its site-level mount. Check
the catalog/lifecycle view with:

```bash
cms extensions list --json
curl --config "$PCMS_CURL_AUTH" -sS \
  "$PCMS_API_URL/api/v1/extensions/<extension-id>/mount"
curl --config "$PCMS_CURL_AUTH" -sS -X PUT \
  -H 'Content-Type: application/json' \
  --data '{"path":"/shop"}' \
  "$PCMS_API_URL/api/v1/extensions/<extension-id>/mount"
```

The write requires `extensions.manage`, is audited, and must not cross a
reserved namespace, another extension mount or an active Entry route. Session
authentication additionally needs `X-PCMS-CSRF` from `/auth/login` or
`/auth/session/rotate` and a same-origin `Origin`; the Admin client handles
these. Confirm with GET. There is no unmount operation; `mount_path: null` is
read-only. The API does not expose a `trusted` boolean or runtime artifact
digest: deployed-catalog membership is the trust boundary, while build
provenance is a release input.

Public mutation routes require their exact registered path and JSON schema.
A missing `Content-Type: application/json` is rejected with 415. The first
successful valid guest mutation also returns a server-issued, site-bound,
HttpOnly `pcms_guest` cookie; it performs the requested operation, so there is
no separate cookie bootstrap call. For replay-safe calls, supply an optional
`Idempotency-Key` (8–200 characters from `[A-Za-z0-9._:-]`). With no key each
request can invoke the handler again. `x-pcms-guest-id` is ignored; only the
Core-issued cookie resumes that guest. Choose an intended mutation and valid
body before using this example; repeated calls with the same key/body replay
the stored response without calling the handler again:

```bash
curl -i -c /tmp/pcms-guest-cookie.txt \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://cms.example' \
  -H 'Idempotency-Key: guest-operation-20261012-001' \
  --data @request.json \
  'https://cms.example/shop/<registered-path>'

curl -i -b /tmp/pcms-guest-cookie.txt \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://cms.example' \
  -H 'Idempotency-Key: guest-operation-20261012-001' \
  --data @request.json \
  'https://cms.example/shop/<registered-path>'
```

Origin/Referer mismatch, or a cookie-authenticated write without either
header, returns `403 EXTENSION_MUTATION_ORIGIN`; public mutation and guest
cookie rate limits return `429`. Extensions enforce ownership in their own
data and provide any domain-specific undo/compensation; Core does not provide
a generic reverse operation.

The HTTP-route manifest has no request-schema field and Core does not expose a
generic extension-route discovery/OpenAPI endpoint. Use the extension's own
operator/API documentation for its concrete body and path. For example, only
in an isolated acceptance composition where the test-only
`progressive.platform-fixture` is installed and mounted at `/shop`, its
`POST /widgets/:slug/notes` route accepts `{"body":"fixture note"}` and
returns `note_id`, `slug` and `guest`. It returns 422 when `body` is empty or
longer than 500 characters. The fixture is not part of standard composition
and must not be assumed to exist on a deployed site. Repeat the exact request
with the same cookie jar and idempotency key; compare the returned `note_id`.
An operator with `audit.read` can independently verify the committed
transaction with `GET /api/v1/audit?event_type=PLATFORM_FIXTURE_NOTE_CREATED&limit=50`
and match `subject_type=extension_entity`, `subject_id=<note_id>` and
`actor_type=GUEST`. The fixture writes the audit event atomically with the
note. It has no guest note read route, so the audit verifies a committed
creation event but does not return the saved body.

## Publication (agent-relevant subset)

```bash
cms publication changesets --json
cms publication preflight --environment production --json …
cms bundle validate <dir> --config "$PCMS_CONFIG_FILE" --json
cms bundle pack <dir> --out bundle.pcpub
cms bundle submit bundle.pcpub --json      # → ingest id
cms bundle status <ingest-id> --wait --json
```

## Small transport contracts

- `GET /api/v1/media` and `/api/v1/discovery/content/tree` accept integer
  `limit=1..100`. Follow `next_cursor` until null; do not infer a complete
  inventory from the first page.
- MCP is JSON-RPC at `/mcp`. It is a separate transport and need not appear
  in the REST OpenAPI document.
- Service-account disable (`POST /service-accounts/:id/disable`), delete
  (`DELETE /service-accounts/:id`) and access-token revoke
  (`POST /access-tokens/:id/revoke`) require `tokens.manage` and a JSON body
  `{"reason":"<1..500 characters>"}`. Include Content-Type even for DELETE;
  an empty body is not a valid reason.
- Theme Settings CAS is `GET /theme/state` → `settings.generation`, then
  `PUT /theme/settings` with `expected_generation` and `values`. The write
  response distinguishes persisted generation from `applied`; state exposes
  `settings.applied_generation` for the local renderer.
- Public Search returns HTTP 429 when throttled (default per-client burst 10,
  refill 2/s). Keep bulk comparisons sequential and at most 2 requests/s;
  cache repeated queries. On 429 honor Retry-After when supplied, otherwise
  use bounded exponential backoff with jitter (1, 2, 4… up to 30 seconds).
