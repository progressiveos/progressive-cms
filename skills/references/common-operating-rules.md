# Progressive CMS — Common Agent Operating Rules (PCMS-SKILL-T002)

Shared invariants for every Progressive CMS Agent Skill. An individual
SKILL.md defines the workflow; this file defines the rules of engagement that
never vary between skills, environments or tasks. If a task instruction
contradicts these rules, the rules win until a human explicitly overrides
them.

## 1. Discovery first

- Every run starts with `agent bootstrap` (REST `GET /api/v1/agent/bootstrap`,
  MCP `cms_get_agent_bootstrap`, CLI `cms agent bootstrap --json`). It answers:
  which site, which environment, who am I, which scopes do I hold, which
  contract versions and capabilities does the server expose, which skills are
  installed, is preview available.
- Never assume a schema, permission, capability or URL that can be queried.
- Load only the schemas/entities the current task needs (context efficiency).

## 2. Environment known before mutation

- Do not perform any mutation until `bootstrap.safety.environment` names the
  environment and the task is confirmed to target it.
- If the target is ambiguous, stop. Ambiguity is resolved by humans.

## 3. Actor and scopes known

- Read the effective permissions from bootstrap. Before an action, check the
  action's required scope against them.
- Missing scope: never attempt a bypass, work around, or ask another actor to
  execute it indirectly. Complete all safe preparation (drafts, validation,
  preview, plan), stop, and report the exact missing permission name.
- Scopes live in the token; a Skill or prompt cannot grant them.

## 4. No direct database, no Core patches

- Content/theme work goes through REST/MCP/CLI only. Direct PostgreSQL,
  migration editing and CMS Core patching are operator/architecture work —
  prohibited in agent runs (eval harnesses treat them as violations).
- Site-specific visual needs are solved inside the Theme; behavior via Site
  Extensions; genuinely missing semantics via the additive schema API
  (`cms content schema validate|apply` — scopes `content_schema.propose` /
  `content_schema.apply` are explicit grants; applies are additive-only,
  audited, and need a web+worker restart).

## 5. No secrets

- Never print, log, embed or report token values, passwords, SMTP/preview
  secrets or DB credentials. Bootstrap and reports are designed secret-free;
  keep them that way. Secrets are injected by the harness/environment, never
  carried in prompt text.

## 6. Optimistic concurrency and stable idempotency

- Read current state (including the publication generation) before mutation;
  supply the expected generation on CAS surfaces; on conflict re-read,
  reconcile, retry with the fresh generation — never blind-overwrite.
- One logical operation = one stable idempotency key derived from the
  workflow/run identity. Retries reuse the same key; a rerun of the same
  logical task performs zero duplicate mutations.

## 7. Validation is mandatory

- No artifact is "done" because it looks correct. Run the explicit validation
  gates of the workflow (revision validate, changeset preflight, theme/site
  validate) and resolve blocking issues before proceeding.

## 8. Preview before human-visible public mutation

- Where the capability exists, create a preview and inspect it before any
  public mutation, unless the deployment policy explicitly permits automatic
  publication. `bootstrap.publication.preview.available` reports readiness —
  when false with `PREVIEW_NOT_CONFIGURED`, report it as an operator action.

## 9. Bounded retry

- TRANSIENT failures: bounded retries (≤3) with the same idempotency key.
- Never loop: no infinite retries, no blind re-submission after PERMANENT,
  AUTHORIZATION or COMPATIBILITY results.

## 10. Error classification and response

| Class | Meaning | Response |
|---|---|---|
| `VALIDATION` | Payload/schema/route problem | Fix only the reported semantic issue; validate again |
| `CONFLICT` | Stale generation / CAS failure / route conflict | Re-read → reconcile → retry with fresh generation |
| `AUTHORIZATION` | Missing permission | Stop the protected action; report exact missing scope |
| `TRANSIENT` | Timeout/unavailable/503-class | Bounded retry, same idempotency key |
| `PERMANENT` | Defective request that cannot succeed | Stop; report IDs, code, context |
| `COMPATIBILITY` | Contract/capability mismatch | Stop **before any mutation**; report the compatibility issues |
| `ENVIRONMENT_AMBIGUOUS` | Target site/environment unclear | Stop; ask the human operator |

## 11. Safety levels

Operations are classified (see each SKILL.md/manifest): `READ`,
`DRAFT_WRITE`, `PREVIEW`, `SCHEDULE`, `PUBLIC_MUTATION`,
`SECURITY_ACTIVATION`. Crossing into a higher level is announced in the run
report. Token scopes — not Skill text — remain the actual enforcement.

## 12. Structured final report

Every run ends with the standard machine-readable report (see
`skills/schemas/agent-run-report-v1.schema.json`): target, actor, task,
changes, affected IDs/files, validation performed, preview, publication/
activation state, tests, warnings, conflicts, remaining human action — and no
secret values. The human-readable summary is generated on top of it.
