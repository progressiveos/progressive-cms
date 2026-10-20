# Skill: progressive-cms-operator

**Version:** 1.0.2
**Purpose:** operate a deployed Progressive CMS — discovery, health, config,
extensions, media providers, maintenance, updates, diagnostics — through the
documented CLI/API surface, deterministically, without reading implementation
source and without touching the database directly.

**Where things live:** operational prompt = this file; compatibility =
`manifest.json`; golden-path command reference =
[`references/golden-path.md`](references/golden-path.md); shared invariants =
[`../references/common-operating-rules.md`](../references/common-operating-rules.md).


## Routing

Мастер-оглавление всех скиллов и тем (читай только нужное):
[`../references/INDEX.md`](../references/INDEX.md). База:
[`../references/common-operating-rules.md`](../references/common-operating-rules.md).

## Non-negotiables

1. **Config is never guessed.** Resolve it in this order: explicit `--config
   <path>` → `$PCMS_CONFIG_FILE` → `./config/pcms.json`. On a server install:
   `export PCMS_CONFIG_FILE=/etc/progressive-cms/pcms.json`. Errors
   `CONFIG_NOT_FOUND`/`CONFIG_INVALID` mean an operator flag is missing — fix
   the flag, do not hunt through source.
2. **Two transports.** Offline commands (db, media, schema, theme, doctor,
   info, capabilities, user/session/token recovery) read config/DB directly.
   Application commands (publication, maintenance, extensions lifecycle,
   forms, integrations, bundle submit/status, update apply) need
   `PCMS_API_URL` + `PCMS_API_TOKEN` in the environment; mutating ones also
   require `--environment <env> --yes`.
3. **Exit codes are the contract** (0 ok, 2 usage/setup, 3 validation,
   4 conflict, 5 auth, 6 not found, 7 transient). A non-zero exit with a typed
   `error.code` is actionable — act on the code.
4. **Never** edit the schema-migrations ledger, hand-apply SQL to "fix" state,
   mutate a release directory, or push application code past the release
   pipeline.
5. Secrets are never printed; provider keys and proxy passwords are entered
   through Admin/secret slots only.

## Golden path (every session)

```bash
cms agent bootstrap --json     # site, environment, contracts, skills
cms doctor                     # runtime/config/DB/paths/secret store
cms capabilities --json        # features, extensions, providers
```

Health surfaces: `GET /system/status` and `GET /system/metrics?hours=24`
(1-minute samples, 72h retention). Anything not fresh → `journalctl -u
progressive-cms-web -u progressive-cms-worker`.

## Extensions and providers

- `cms extensions list --json` — deployed/installed/enabled + compatibility.
- Settings (any extension): `GET /extensions/{id}/config` → schema + public
  config + secret-slot presence; change via `PUT /extensions/{id}/config`
  (non-secret keys; existing secret refs are preserved) and write-only
  `PUT|DELETE /extensions/{id}/secrets/{slot}`.
- Media providers use the same contract under `/media/providers/{id}` and add
  `POST /media/providers/{id}/test`. Network egress (direct / SOCKS5 /
  fallback) is **declared in the manifest config_schema and edited in the
  Network section of the provider settings dialog** — never hardcoded; if a
  provider needs a proxy, set `network.mode=socks5` + host/port + `remote_dns`
  through Admin/API.
- **Public extension routes:** `cms extensions list --json` shows deployed
  trusted-catalog entries and lifecycle/compatibility fields. An installed
  item marked `BLOCKED` with `COMPAT_EXTENSION_FINGERPRINT_MISMATCH` has no
  deployed artifact. The API does not expose a `trusted` boolean or runtime
  digest; deployed catalog membership is the trust boundary. On an isolated
  test instance, install an artifact already in that catalog with
  `POST /api/v1/extensions/{id}/install` and enable it with
  `POST /api/v1/extensions/{id}/enable`; both require `extensions.manage`,
  and never download an artifact. Session calls additionally send the
  `pcms_session` cookie, `X-PCMS-CSRF` from the `csrf_token` returned by
  `POST /api/v1/auth/login` with JSON `{"email":"...","password":"..."}`,
  and same-origin `Origin`. Bearer-token calls use the approved curl config
  and service-token permission. The equivalent CLI commands are
  `cms extensions install <id>` and `cms extensions enable <id>`. Inspect the site-level mount with
  `GET /api/v1/extensions/{id}/mount` (requires
  `extensions.manage`); assign or move it using `PUT
  /api/v1/extensions/{id}/mount` and `{"path":"/shop"}`. The write is
  audited; invalid paths return `EXTENSION_MOUNT_PATH_INVALID`, and reserved
  namespaces or collisions with other mounts/active Entry routes return
  `EXTENSION_MOUNT_COLLISION` (409). Session writes need `X-PCMS-CSRF` from
  `csrf_token` returned by `/api/v1/auth/login` or `/api/v1/auth/session/rotate`
  plus a same-origin `Origin`; the Admin client does this automatically.
  Confirm with GET. Public URLs are the extension's registered route paths
  under the mount, plus a locale prefix for non-default locales. There is no
  `DELETE`/unmount endpoint or CLI/MCP equivalent; `mount_path: null` is only
  a read result.
- **Public extension mutations:** use the method, path and JSON body declared
  by the extension's public route, with `Content-Type: application/json`
  (missing media type returns 415). A first successful mutation creates a
  site-bound HttpOnly `pcms_guest` cookie and performs the requested operation;
  there is no separate guest-cookie bootstrap endpoint. The client-supplied
  `x-pcms-guest-id` header is ignored. Supply an `Idempotency-Key` to make a
  public write replay-safe; this header is optional, and without it every
  request can invoke the handler. A same-key request with a different body
  returns `409 IDEMPOTENCY_KEY_CONFLICT`; an identical in-flight request
  returns `409 IDEMPOTENCY_IN_PROGRESS`. Origin mismatch, or a
  cookie-authenticated mutation without Origin/Referer, returns
  `403 EXTENSION_MUTATION_ORIGIN`; rate gates return 429. The first request
  is a real mutation, so use only an operation you intend to run. See the
  curl cookie-jar example and ownership/transaction boundary in
  `references/golden-path.md`. Core does not publish request schemas or a
  generic HTTP-route discovery endpoint; each extension must document its own
  path and body. The fixture example in the reference is test-only and is not
  guaranteed to exist on a deployed site. In that isolated fixture, replay the
  same mutation with its cookie jar and idempotency key, compare `note_id`,
  then verify `subject_type=extension_entity`, matching `subject_id` and
  `actor_type=GUEST` through `/api/v1/audit` with `audit.read`.
- **Web Research** (`progressive.web-research`): configure
  `xmlstock.user_id` + write-only `xmlstock.api_key`, engine, fetch limits and
  the shared `network` block through the same extension settings contract.
  Verify with `cms research status --json`; live checks: `cms research search
  "test query" --json` (**may consume XMLStock balance**) and `cms research
  fetch https://example.com --out /tmp/test.md --json`. Browser render
  fallback is optional: without a Playwright browser at the host, HTTP fetch
  stays fully functional and only the JS-shell fallback degrades
  (`RESEARCH_FETCH_BROWSER_UNAVAILABLE`).
- Typed provider failures: `PROVIDER_NOT_CONFIGURED` (credentials),
  `PROVIDER_UNAUTHORIZED` (rejected), `PROVIDER_NETWORK_UNREACHABLE` /
  timeout (egress/proxy), `PROVIDER_RATE_LIMITED`, `PROVIDER_INVALID_REQUEST`,
  `PROVIDER_UNAVAILABLE` (upstream down). Report the code and its section, not
  a generic "unavailable".

## Maintenance

`GET /maintenance` (read), `PUT /maintenance {"enabled":bool}` (toggle).
CLI: `cms maintenance status|enable|disable --environment <env> --yes` with
scope `site.maintenance`. Admin UI location: **System** screen. Bypass-actors
hold `site.maintenance.bypass`; every toggle is audited.

## Updates

Prefer the Registry CLI: inspect `cms registry status` and
`cms registry releases --json`, choose an explicit published version, and run
`cms registry apply --version <version> --environment <env> --yes --json`.
`cms registry status` reports binding/configuration, not the update run. If
apply is still running or the connection drops, poll authenticated
`GET /api/v1/registry/update-status` for `current_version` and the latest
`update.status` (`RUNNING`, `SUCCEEDED`, `FAILED`) and `failure_code`; confirm
`to_version` and `current_version` against the requested version, then confirm
the served release with `cms agent bootstrap --json`. The endpoint returns the
latest record, not a per-request lookup; there is no `registry update-status`
CLI subcommand. Do not infer a compatible version from “latest” alone. For an
artifact already staged in `incoming/`, use `cms update check/apply --manifest`;
the configured target is read at web boot, so restart web after re-staging.
`rollback_policy: restore_required` means symlink rollback alone is forbidden;
restore the BackupGate dump.

## Diagnostics discipline

Typed code first → docs/RUNBOOK second → journalctl third → source code last
(and never as a substitute for the documented flag). Unknown failure: capture
`request_id`, the typed envelope and the unit journal excerpt into the report.
