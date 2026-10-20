# Addressed personal-data tools

Use these tools when the owner chooses to correct, pause or erase a specific Forms
submission, quiz run or its provenance lead. They are optional operator tools;
normal CMS operation does not require a privacy case or a processor receipt.
They are not a legal-compliance certificate.

1. `cms agent bootstrap --json`: confirm the intended site/environment and
   `privacy.manage`. OWNER has this permission; delegate it deliberately to any
   other identity. Existing read scopes are needed to inspect source values.
2. Inspect the record in Admin. Its details link to **Personal data: addressed
   operations** (`#/interactions/privacy`) with the record preselected. Choose
   block, unblock, correct or erase. Correcting a lead corrects its original
   submission/run and linked leads together. Ordinary users need no SQL access.
3. Preview. Check all local source/lead/event/delivery IDs and known external
   deliveries. Preview changes nothing. In-flight delivery or stale state must
   be resolved before applying; do not work around those safety checks.
4. Apply the explicit reviewed action. Retain the returned case ID for later
   inspection. For scripted retries, retain the exact request body/request ID.
5. If there are known external copies, arrange action with the recipient, then
   record an acknowledgement or the owner's exception. The CMS does not call
   the recipient or automatically erase downloaded exports/backups. The owner
   controls those copies and any retention decisions.

## REST / CLI / MCP

All endpoints require `privacy.manage`; session POST requests require CSRF.

| Tool | REST under `/api/v1` | CLI |
| --- | --- | --- |
| `cms_preview_interaction_privacy` | `POST /interactions/privacy/preview` | `cms interactions privacy-preview request.json --json` |
| `cms_apply_interaction_privacy` | `POST /interactions/privacy/apply` | `cms interactions privacy-apply apply.json --environment production --yes --json` |
| `cms_get_interaction_privacy_case` | `GET /interactions/privacy/cases/:caseId` | `cms interactions privacy-get <case_id> --json` |
| `cms_acknowledge_interaction_privacy` | `POST /interactions/privacy/cases/:caseId/deliveries/:deliveryId/acknowledge` | `cms interactions privacy-ack <case_id> <delivery_id> decision.json --environment production --yes --json` |

Request: `target:{entity:"submission"|"quiz_run"|"lead",id}`, and
`action:"block"|"unblock"|"rectify"|"erase"`. Rectification additionally sends one
full replacement: `correction.submission_payload`, or
`correction.quiz_answers:[{question_id,value}]`. Source schema is validated;
associated leads/results are updated by Core. No partial best-effort correction.

Apply additionally requires `expected_token` from preview and a fresh canonical
UUIDv4/v7 `request_id`. Optional `request_ref` is an opaque owner decision reference.
Use the same reviewed body on retries. New operation -> new request ID.

MCP receipt uses `case_id`; followup uses `case_id`, `delivery_id`,
`decision:"acknowledged"|"owner_exception"` and optional `evidence_ref`.
References must be opaque, not personal data/free text. An owner exception never
means that a remote copy was erased. Observe the receipt's separate `local_state`
and `external_state`. Before serving a restored older backup, reconcile subsequent
privacy actions rather than replaying stale personal-data payloads.

The normal updater applies additive migration `0005_interaction_privacy`; no
content, Theme or Content Type migration is required. Update all Workers and
Web before using these tools. Source data keeps the instance's existing scope.
Historical/unknown delivery outcomes are treated conservatively as possible
external copies. A pending followup may retain the recipient object ID; closing
it clears that ID and keeps resolution actor/time and opaque evidence reference.
Retain case IDs for lookup. Each addressed closure is limited to 1000 linked
rows per entity; exceeding the cap fails without a partial operation.

Retention is independent: `retain` deliberately keeps data even when
`after_days` is set. Selected anonymize/delete policies also apply to archived
forms/quizzes. A scheduled source-data sweep is not proof that a recipient,
operator export or historical backup has erased its copy.
