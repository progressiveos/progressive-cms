# Content Agent — Bulk publication workflow (PCMS-SKILL-T005)

Canonical transport for a pool of content items (e.g. "35 articles, batches
of 3, every 12 hours"). The pool's research/writing happens outside the CMS;
this workflow assumes finished drafts.

## 0. Hard rules

- One logical submission = **one stable idempotency key** (`external_id`,
  ≥ 8 chars, derived from the run/task identity — e.g. a hash of the source
  inventory). A retry reuses the SAME key; a rerun of the same task performs
  zero duplicate submissions.
- Scheduling values are **exact timestamps in the report**, never
  "approximately every 12 hours".
- Required scopes: `content.create`/`content.edit` (+ `media.*` if assets),
  `revision.seal`, `publication.plan`; `publication.schedule` for
  scheduling; `publication.publish` only when the task authorizes immediate
  public mutation.

## 1. Assemble the Publication Bundle

`POST /bundles` with `mode: "validate"`:

- one bundle covers the whole pool; intra-bundle references use `ref:<id>`;
- media is inlined by reference; the strict validator runs structural +
  semantic checks over every item (all-or-nothing philosophy);
- `publication.mode: "none"` for drip publication (scheduling comes from the
  plan, not the bundle); `"now"` only for publish-immediately pools and
  requires `publication.publish`.

Fix every issue, re-validate, repeat until green. **Zero writes happen in
validate mode.**

## 2. Submit once

`POST /bundles` with `mode: "apply"` and the SAME `external_id`. The apply is
atomic: media ingest, then one transaction for entries/revisions. The
response carries the created IDs. On TRANSIENT failure: bounded retry with
the same `external_id` — the CMS deduplicates; you will never get a second
copy of the pool.

## 3. Group into a ChangeSet

`POST /changesets` and add the pool's items (`POST /changesets/:id/items`)
with CAS baselines (`expected_generation` = live generation; `route_operation`
for new paths), then `POST /changesets/:id/preflight` — resolve every
blocking issue before planning.

## 4. Build the exact schedule (35/3/12h worked example)

`POST /plans` with `{ "changeset_id": "<id>", "timezone": "Europe/Berlin" }`
→ `POST /plans/:planId/preview` with the batch spec:

```json
{
  "spec": {
    "startLocal": { "date": "2026-10-01", "time": "09:00" },
    "batchSize": 3,
    "interval": { "unit": "hours", "value": 12 }
  }
}
```

**Inspect every compiled entry of the preview response** — the plan item →
changeset item mapping and each exact `publishAt` instant. For 35 items at
3/12h that is 12 batches: batch 1 at start, each next batch +12h; the last
batch is partial (2 items). Verify the count (35 = 11×3 + 2), the timezone
handling, and that no item is missing or duplicated. Timezone semantics:
`hours` shifts exact instants; `days` preserves local wall-clock across DST.

## 5. Schedule

`POST /plans/:planId/schedule` with the SAME spec (plus per-item overrides
only if the task explicitly lists them). Schedule requires
`publication.schedule`; the scheduler materializes timestamps and enqueues
idempotent jobs. Verify with `GET /publication/calendar` and re-read the
plan: report every scheduled timestamp.

## 6. Idempotency proof (self-check)

Re-running your own workflow must be a no-op: the bundle apply deduplicates
by `external_id`, the plan/schedule path enqueues idempotent jobs, and an
inventory diff finds zero new entries. If a rerun would mutate anything,
STOP — that is a defect in your own key discipline, not in the CMS.

## Report

The run report lists each item (created/scheduled + its exact `publishAt`
UTC instant), the bundle/changeset/plan IDs, and the full timeline for human
review before (and after) the first batch goes live.
