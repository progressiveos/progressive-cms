# Common errors and recovery

Contract owner: Core typed errors, permissions and operations. Preserve `request_id` and stable error `code`; do not copy tokens, cookies or private payloads into reports. HTTP status alone is not a complete diagnosis.

| Symptom/code | Meaning | Next documented action |
|---|---|---|
| `API_RATE_LIMITED`, HTTP 429 | The per-IP `/api/v1/*` request bucket is empty | Wait at least the `Retry-After` duration; review `http.apiRateLimitPerMinute` and any edge limits without disabling protection by default |
| `SEARCH_RATE_LIMITED`, HTTP 429 | The Search or public collection-feed bucket is empty | Wait for `Retry-After`; use the response rate-limit headers and reduce polling/scraping frequency |
| `AUTH_THROTTLED`, HTTP 429 | Authentication attempt throttling is active | Wait at least the `Retry-After` duration before retrying; do not rotate IPs or accounts to evade the limit |
| `BLOCK_EXTENSION_UNAVAILABLE` in `REVISION_VALIDATION_FAILED` | A new Block Document revision uses a block whose extension is not enabled | Enable the deployed owner extension, then reread, validate and seal the current WORKING revision |
| `NAV_SET_BOUND`, HTTP 409 | Navigation set is still attached to a placement | Inspect/rebind/unbind the affected placement within task scope, then decide whether deletion is still intended |
| `API_ORIGIN_MISMATCH`, HTTP 403 | Request origin/proxy context does not match | Inspect expected origin and trusted reverse proxy configuration; preserve TLS/cookie/CSRF protections |
| `PAYMENT_SETTINGS_CONFLICT`, HTTP 409 | Another editor saved the provider connection at a newer settings generation | Read settings again, reconcile the intended changes and save with the returned generation; do not blindly replay credential writes |
| `PAYMENT_CREDENTIALS_INCOMPLETE` | A required provider credential is unavailable or a legacy credential import is unresolved | Restore the named secret or save the credential through Admin, run `cms payments credentials status --json`, then retry the idempotent import if needed; verify local readiness |
| `PAYMENT_REFUND_IN_PROGRESS`, HTTP 409 | A payment already has a refund intent with an unresolved outcome | Read the refund intent and provider history; do not create a second refund while the first is active |
| Permission/authorization failure | The actor lacks required permission or constraints | Compare bootstrap actor/scopes and API operation permission; ask operator for the specific access, never use SQL |
| `PRIVACY_STALE_CONFLICT` / `PRIVACY_BUSY_CONFLICT` | Source/copies changed or delivery is live/claimed | Wait/review and preview again; preserve exact body/request ID when recovering an ambiguous apply |
| `PRIVACY_REQUEST_CONFLICT` / `PRIVACY_FOLLOWUP_CONFLICT` | Request identity reused with changed input, or a resolved recipient decision changed | Retrieve the case; use a new ID for a new reviewed action, preserve immutable outcomes |
| `PRIVACY_SCOPE_TOO_LARGE` | Addressed closure exceeds 1000 rows in a linked entity group | Obtain a supported operator plan; no arbitrary splitting to bypass the cap |
| CAS/generation conflict, HTTP 409 | Another edit/publication advanced state | Reread current revision/publication and reconcile; do not hardcode a generation |
| `RICH_TEXT_BLOCKS_NOT_RENDERED` | A WORKING rich_text revision hides nonempty payload.blocks | Move content into declared RichText fields or deliberately use a block_document Content Type |
| `RICHTEXT_VERSION_REQUIRED` | A document, including a nested one, lacks v2 marker | Validate each declared RichText document independently; do not stamp version 2 on Block Document |
| `THEME_RICHTEXT_INVALID` | Strict renderer received invalid RichText | Check declared field/policy and actual document; Core separates Block Document decoding; never reintroduce a v1 read workaround |
| `MARKDOWN_UNREPRESENTABLE` | GFM cannot carry the full AST semantics during RichText/AST conversion | Use the REST/MCP document contract for lossless operations; public page rendering reports unsupported Markdown with HTTP 406 (see [Markdown](markdown.md)) |
| Markdown route HTTP 406 / 503 | No acceptable or representable Markdown response, or an unexpected rendering failure | Check the `Accept` value, selected theme template and published fields/blocks; see [Markdown](markdown.md) |
| Explicit `.md` HTTP 404 | The page/locale is unavailable or Markdown is disabled for it | Check the published route and site/entry switches; a normal HTML request remains available |
| `THEME_INSTALL_RENDER_TARGET` | Ordinary installation cannot replace the currently rendered theme | Use update-active for a newer package of the same id; install a different id, then activate it with `POST /api/v1/theme/activate` |
| `THEME_CHANGE_BUSY`, 409/503; `THEME_CHANGE_FAILED`; `THEME_RECOVERY_UNAVAILABLE` | Journaled theme change/recovery is busy, failed or cannot confirm durable authority | Reread active/history after recovery; do not edit files/DB pointers. Mutation busy is 409; public recovery gate busy is 503 |
| `THEME_REVISION_PROTECTED`, 409 | Cleanup requested an active, last-good, latest/recent or recovery snapshot | Re-preview eligible candidates; never bypass protection. Missing/foreign revision is 404; partial physical cleanup is HTTP 200 with ok=false/pending (CLI exit 7) |
| `THEME_REVISION_STALE`, 409 | Theme lifecycle generation advanced | Reread theme_generation from history; reconcile the intended rollback, not settings_generation |
| `VERIFICATION_ROUTE_CONFLICT`, HTTP 422 | A provider verification file would shadow a content/system route or overlap an extension mount | Resolve the route or mount conflict, then save the owner-supplied verification proof again |
| `EXTENSION_OBLIGATIONS_OUTSTANDING` | A lifecycle count reports outstanding work, so disable or uninstall is blocked | Fulfil or cancel the obligations through the extension's normal business workflow |
| `EXTENSION_OBLIGATION_CHECK_UNAVAILABLE` / `EXTENSION_OBLIGATION_CHECK_FAILED` / `EXTENSION_OBLIGATION_CHECK_INVALID` / `EXTENSION_HANDLER_UNRESOLVED` | Core cannot prove the obligation count is trustworthy; the lifecycle change fails closed | Resolve lock contention or fix the declared/exported handler and its count, then retry; do not bypass the guard |
| `UPDATE_NOT_AN_UPGRADE`, HTTP 409 | Candidate release is the same as or older than the full running SemVer | Verify the candidate and runtime versions; use only a strictly newer release |
| `UPDATE_RUNTIME_VERSION_INVALID`, HTTP 409 | Core cannot trust the running runtime version for update ordering | Have the authorized operator restore a valid runtime identity; do not infer it from the release id |
| `CONFIG_NOT_FOUND` / `CONFIG_INVALID` | Config resolution or validation failed | Check explicit --config / PCMS_CONFIG_FILE and supplied schema; do not guess private paths |
| `FORM_RATE_LIMITED`, HTTP 429 | Public abuse budget exceeded | Back off and inspect controlled test frequency; do not disable protections |
| Published page absent from CMS Search | Projection may still be queued | Inspect Search status and Worker/outbox; reindex only with explicit environment/authorization |

The API reference retains per-operation response/security schemas. A code not covered here should be reported with the operation and sanitized request id, not invented into an automatic recovery procedure.

[Documentation index](index.md)
