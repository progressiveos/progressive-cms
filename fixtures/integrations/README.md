# M12 → M13 event contract fixtures

M12 (Forms/Quizzes/Leads, parallel branch) persists interaction state and
writes these domain events into the M07 transactional outbox
(`publication_outbox`). M13 consumes them through the ordinary outbox
consumer contract (at-least-once; consumers dedupe on `id`).

Semantic payloads (routing-safe metadata ONLY — no PII; contact fields
travel through the M13 `IntegrationProjectionSource` boundary on explicit
allowlisted request):

- `FormSubmitted`: submission_id, form_definition_id, form_schema_version,
  source_entry_id?
- `QuizCompleted`: quiz_run_id, quiz_definition_id, quiz_schema_version,
  outcome_id?, score?
- `QuizStarted` / `QuizAbandoned` (optional v1): quiz_run_id,
  quiz_definition_id, quiz_schema_version
- `LeadCreated`: lead_id, source_type, source_id, classification?
- `LeadStatusChanged`: lead_id, previous_status, status

These files are the acceptance fixtures for the M13-branch contract-side
completion of PCMS-INT-T014. After the M12+M13 merge the integration owner
runs a separate convergence test with real persisted interactions; nothing
here imports or requires `@pcms/forms`.
