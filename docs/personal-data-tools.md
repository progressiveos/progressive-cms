# Addressed personal-data tools

These optional tools correct, pause or erase one native Forms submission, quiz run or its provenance lead and controlled local copies. The owner chooses the action, consent policy and retention. Ordinary site operation, publishing and release do not require a privacy case, mandatory provider consent or recipient acknowledgement. The tools do not certify legal compliance.

## Prerequisites and scope

Update **Web and every Worker** before use. Normal Core update applies additive migration `0005_interaction_privacy`; no Content Type, Theme, content or site-config migration is required. Feature-detect the actual installed operations and `privacy.manage`; a baseline Skill version range does not promise these later tools.

All four operations require `privacy.manage`. OWNER receives registered permissions through its existing rule; ADMIN and stored custom roles require explicit delegation. Inspecting source values for correction also needs the existing `interactions.read` or `leads.read` permission. This is not a reason to grant a site-building agent access to production submissions. Previews/receipts may contain sensitive IDs; do not copy them into public reports or agent prompts unnecessarily.

Use the configured instance and authenticated site/environment context. Core checks the actor's site binding; native Forms records retain their **instance scope**, without new per-record multi-site tenancy. This is an addressed operation, not subject discovery, a bulk erasure endpoint or deletion of accounts/arbitrary CMS content. Each linked entity group is capped at 1000 rows; exceeding it fails before writing. Keep case IDs for later lookup.

## Entry points

Admin `/admin/#/interactions/privacy`: **Personal data: addressed operations**, also linked from submission, quiz-run and lead details. Choose the source/action, preview exact affected IDs, then explicitly apply. Lead targeting resolves to the original submission/run and its associated provenance leads. It cannot select an unrelated lead. Complex values use the advanced JSON control and must satisfy the stored source schema.

All REST paths are relative to `/api/v1`, using the normal Bearer/site/environment headers. Cookie POST requests require CSRF, including preview. MCP uses the connected instance's discovered schemas and trusted permission gate.

| Purpose | REST | MCP | CLI |
|---|---|---|---|
| Read-only preview | `POST /interactions/privacy/preview` | `cms_preview_interaction_privacy` | `cms interactions privacy-preview request.json --json` |
| Apply reviewed action | `POST /interactions/privacy/apply` | `cms_apply_interaction_privacy` | `cms interactions privacy-apply apply.json --environment <env> --yes --json` |
| Read receipt | `GET /interactions/privacy/cases/{caseId}` | `cms_get_interaction_privacy_case` | `cms interactions privacy-get <case-id> --json` |
| Record recipient outcome | `POST /interactions/privacy/cases/{caseId}/deliveries/{deliveryId}/acknowledge` | `cms_acknowledge_interaction_privacy` | `cms interactions privacy-ack <case-id> <delivery-id> decision.json --environment <env> --yes --json` |

CLI uses `PCMS_API_URL`, `PCMS_API_TOKEN` and explicit site/environment context. Apply/ack require explicit environment and `--yes`; preview does not automatically apply. MCP receipt arguments are `case_id`; acknowledgement additionally uses `delivery_id`, `decision` and optional `evidence_ref`. Actor identity is supplied only by authentication, never by client JSON.

## Preview and apply

Actions: `block`, `unblock`, `rectify`, `erase`. Target entity: `submission`, `quiz_run`, `lead`. IDs use canonical lowercase UUIDv4/v7. Examples contain synthetic identities and must be replaced with the authorized actual IDs.

`request.json` for preview:

```json
{"target":{"entity":"submission","id":"01900000-0000-7000-8000-000000000001"},"action":"block"}
```

Preview changes nothing. It returns `source`, `lead_ids`, `outbox_ids`, `delivery_ids`, `in_flight`, `blocked`, `erased`, `expected_token`, `external_copies` and `limitations`. External-copy items contain `delivery_id`, `instance_id`, `status` and recorded `external_id` when known; these IDs can themselves be sensitive.

Review the exact closure before applying. `apply.json` repeats that operation and adds a fresh canonical UUIDv4/v7 `request_id`, the **actual expected_token from preview**, and optional opaque `request_ref`:

```json
{"target":{"entity":"submission","id":"01900000-0000-7000-8000-000000000001"},"action":"block","request_id":"01900000-0000-7000-8000-000000000002","expected_token":"<token-from-reviewed-preview>","request_ref":"ticket:case-123"}
```

For an interrupted response retain and retry the **same complete apply body and request ID**. A new operation requires a new request ID. `case_id` equals request_id, allowing receipt lookup after an ambiguous response. Reusing that ID with a different operation/token is a conflict, not an update. A stale preview or in-flight/claimed delivery requires waiting/review and a new preview; do not bypass the conflict or blindly resubmit a different erase request. Erased payloads cannot be revived by unblock or ordinary delivery retry.

## What each action does

| Action | Local behavior and limits |
|---|---|
| `block` | Stops further controlled delivery/quiz processing. Authorized operator inspection remains available. This is not an access revocation or deletion. |
| `unblock` | Resumes eligible work; retired old payloads after rectification/erasure do not return. |
| `rectify` | Validates a full source replacement against the **stored definition/version**, updates derived provenance leads and recomputes applicable quiz results. Old pending payload copies are retired. It is not a partial best-effort patch. |
| `erase` | Removes selected source/provenance personal data and scrubs controlled outbox, delivery and attempt copies in a transaction. Executing delivery must settle first. No remote provider call occurs inside that transaction. Case/audit metadata remains. |

For rectify, send exactly one correction. Submission example, only if this is the complete valid payload for its stored schema:

```json
{"target":{"entity":"submission","id":"01900000-0000-7000-8000-000000000001"},"action":"rectify","correction":{"submission_payload":{"email":"corrected@example.invalid"}}}
```

Read/merge all required source values first; do not submit this one-field example over a richer form. Quiz replacement uses `correction.quiz_answers`, a full array of `{question_id,value}` consistent with branching/required visited questions. REST bounds the array to 256 answers, submission payload to 256 properties and question keys to 128 characters. Unknown/duplicate/invalid answers fail validation. A correction cannot fabricate/withdraw the required lead consent: use block or erase for withdrawal. `correction` is forbidden for other actions.

## Receipt and recipient followups

Receipt: `case_id`, `target`, `source`, `action`, `local_state`, `created_at`, authenticated `actor`, `request_ref`, `followups`, `external_state`.

- `local_state`: `blocked`, `unblocked`, `rectified`, `erased`.
- `external_state`: `none_known`, `pending`, `acknowledged_or_excepted`. None known does not mean no exports/backups exist; the last value does not mean every remote copy was erased.
- Followup: delivery/instance ID, `state` (`pending`, `acknowledged`, `owner_exception`), optional evidence/external IDs and resolution actor/time. A pending followup may retain an external object ID; closing it clears that ID and records `resolved_actor_type`, `resolved_by`, `resolved_at`.

After the owner arranges action with the actual recipient, `decision.json` records either:

```json
{"decision":"acknowledged","evidence_ref":"ticket:processor-123"}
```

or the owner's explicit exception:

```json
{"decision":"owner_exception","evidence_ref":"decision:retain-copy"}
```

`request_ref`/`evidence_ref` are optional opaque references of at most 300 characters from `[A-Za-z0-9:/_.#-]`, not names, emails, personal-data payloads or free text. Acknowledgement only records an outcome; it does not contact/delete at the recipient. Resolved decisions are immutable: repeating the same decision is safe, changing it conflicts. Do not invent acknowledgements to obtain a successful-looking receipt.

Unknown/interrupted outbound outcomes and historical deliveries are conservatively treated as **possible** external copies; that does not assert a historical pending job actually sent data. Downloaded exports, onward copies and historical backups are not discoverable/erasable by this tool. The owner decides followup and retention exceptions. Before reopening a restored older backup, reconcile subsequent privacy actions so retired data is not sent again.

## Conflicts and acceptance

`PRIVACY_STALE_CONFLICT` means re-preview changed records; `PRIVACY_BUSY_CONFLICT` means an outbound delivery is executing/claimed. `PRIVACY_REQUEST_CONFLICT` means the request ID was reused with different input. `PRIVACY_ERASED_CONFLICT` prevents changing erased data; `PRIVACY_FOLLOWUP_CONFLICT` prevents rewriting a closed decision. `PRIVACY_SCOPE_TOO_LARGE` requires a supported operator/Core plan, not arbitrary batch splitting around the cap. Invalid action/correction/reference and missing target/case/followup have their own typed codes. Inspect the domain error body; do not infer full completion from HTTP success.

Only if authorized, use synthetic records to check preview/no change, reviewed apply, exact retry, stale/in-flight refusal, schema validation, local propagation and receipt lookup. Distinguish local state from owner-handled recipient evidence. Normal operation need not run this workflow; a receipt does not establish legal certification or vendor/backup deletion.
