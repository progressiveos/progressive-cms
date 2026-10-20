import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type DbClient, type DbPool, fixedClock, newStableId } from "@pcms/core";
import {
  ConnectorRuntimeRegistry,
  createConnectorRegistry,
  createDeliveryService,
  createIntegrationBindingService,
  createIntegrationDispatcher,
  createIntegrationInstanceService,
} from "@pcms/integrations";
import { createOutboxService, writeOutboxEvent } from "@pcms/publication";
import {
  createInteractionPrivacyService,
  type PrivacyOperation,
} from "../../packages/api/src/interaction-privacy.js";
import { rollbackApiFixture } from "../helpers/rollback-api-fixture.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const clock = fixedClock(new Date("2026-10-19T12:00:00Z"));
const actor = { type: "USER", id: "privacy-owner" };
const code = (expected: string) => (error: unknown) =>
  (error as { code?: string }).code === expected;
async function setup(t: { after: (fn: () => Promise<void>) => void }, committed = false) {
  const { app, pool } = await rollbackApiFixture(
    t,
    { clock },
    committed ? { transactionMode: "committed" } : undefined,
  );
  const privacy = createInteractionPrivacyService(pool, { clock });
  const definition = await app.formsSource.domain.definitions.createDefinition({
    key: "privacy_source",
    title: "Contact",
    fields: [{ key: "email", type: "email", label: "Email", required: true }],
    settings: { lead_policy: { create_lead: true, email_from: "email" } },
  });
  const first = await app.formsSource.publicForm.submit({
    form_definition_id: definition.id,
    values: { email: "original@example.com" },
  });
  const unrelated = await app.formsSource.publicForm.submit({
    form_definition_id: definition.id,
    values: { email: "other@example.com" },
  });
  const event = (
    await pool.query(
      "SELECT id FROM publication_outbox WHERE aggregate='form_submission' AND aggregate_id=$1",
      [first.submission_id],
    )
  ).rows[0]!;
  const instanceId = newStableId(),
    bindingId = newStableId();
  await pool.query(
    "INSERT INTO integration_instance(id,connector_type,name) VALUES($1,'stub','Stub')",
    [instanceId],
  );
  await pool.query(
    "INSERT INTO integration_binding(id,event_type,actions,failure_policy) VALUES($1,'FormSubmitted','[]'::jsonb,'{\"maxAttempts\":3,\"backoffBaseMs\":1000}'::jsonb)",
    [bindingId],
  );
  const deliveries = createDeliveryService({ pool, clock, privacyGuard: privacy.deliveryBlocked });
  const materialize = (eventId = String(event.id), index = 0) =>
    deliveries.materialize({
      identity: { outboxEventId: eventId, bindingId, actionIndex: index },
      eventType: "FormSubmitted",
      instanceId,
      actionType: "send",
      payload: { email: "original@example.com" },
      maxAttempts: 3,
    });
  const { delivery } = await materialize();
  const target = { entity: "submission" as const, id: first.submission_id };
  const apply = async (input: PrivacyOperation) => {
    const preview = await privacy.preview(input);
    return privacy.apply({
      ...input,
      request_id: randomUUID(),
      expected_token: preview.expected_token,
      actor,
    });
  };
  return {
    app,
    pool,
    privacy,
    first,
    unrelated,
    target,
    delivery,
    deliveries,
    materialize,
    apply,
    instanceId,
    bindingId,
  };
}

test("privacy preview/rectification validate stored schema, rebuild lead, retire queued copies and enforce idempotency", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const f = await setup(t);
  const input = {
    target: f.target,
    action: "rectify" as const,
    correction: { submission_payload: { email: "corrected@example.com" } },
  };
  await f.pool.query("UPDATE forms_submissions SET source_url_snapshot='/contact/' WHERE id=$1", [
    f.first.submission_id,
  ]);
  const preview = await f.privacy.preview(input);
  assert.equal(preview.delivery_ids.length, 1);
  assert.equal(
    (await f.app.formsSource.domain.submissions.getSubmission(f.first.submission_id)).payload.email,
    "original@example.com",
  );
  const request = {
    ...input,
    request_id: randomUUID(),
    expected_token: preview.expected_token,
    actor,
  };
  const receipt = await f.privacy.apply(request);
  assert.equal(receipt.local_state, "rectified");
  assert.deepEqual(await f.privacy.apply(request), receipt);
  await assert.rejects(
    () =>
      f.privacy.apply({
        ...request,
        correction: { submission_payload: { email: "different@example.com" } },
      }),
    code("PRIVACY_REQUEST_CONFLICT"),
  );
  assert.equal(
    (await f.app.formsSource.domain.submissions.getSubmission(f.first.submission_id)).payload.email,
    "corrected@example.com",
  );
  const correctedLead = await f.app.formsSource.domain.leads.getLead(f.first.lead_id!);
  assert.equal(correctedLead.email, "corrected@example.com");
  assert.match(correctedLead.presentation, /Source: \/contact\//);
  const changed = await f.deliveries.get(f.delivery.id);
  assert.deepEqual(changed?.delivery.payload, {});
  assert.equal(changed?.delivery.status, "CANCELLED");
  await assert.rejects(() => f.deliveries.retry(f.delivery.id));
  assert.equal(
    (await f.app.formsSource.domain.submissions.getSubmission(f.unrelated.submission_id)).payload
      .email,
    "other@example.com",
  );
  const cases = await f.pool.query("SELECT * FROM interaction_privacy_cases");
  assert.ok(!JSON.stringify(cases.rows).includes("corrected@example.com"));
  await assert.rejects(() =>
    f.privacy.preview({ ...input, correction: { submission_payload: { unknown: "x" } } }),
  );
  await assert.rejects(
    () => f.privacy.preview({ ...input, correction: null as never }),
    code("PRIVACY_CORRECTION_INVALID"),
  );
});

test("block pauses existing and late deliveries; unblock resumes without replaying retired copies", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const f = await setup(t);
  await f.apply({ target: f.target, action: "block" });
  assert.equal((await f.deliveries.claimDue(10)).length, 0);
  const outbox = createOutboxService(f.pool, { clock });
  const claimed = await outbox.claimBatch(100);
  assert.ok(
    claimed.every(
      (event) =>
        event.aggregateId !== f.first.submission_id && event.aggregateId !== f.first.lead_id,
    ),
  );
  await writeOutboxEvent(f.pool, {
    aggregate: "lead",
    aggregateId: f.first.lead_id!,
    eventType: "LeadStatusChanged",
    payload: { lead_id: f.first.lead_id },
  });
  const late = (
    await f.pool.query(
      "SELECT id FROM publication_outbox WHERE aggregate='lead' AND aggregate_id=$1 AND event_type='LeadStatusChanged'",
      [f.first.lead_id],
    )
  ).rows[0]!;
  const extra = await f.materialize(String(late.id), 1);
  await assert.rejects(() => f.deliveries.retry(extra.delivery.id));
  assert.equal((await f.deliveries.claimDue(10)).length, 0);
  await f.apply({ target: { entity: "lead", id: f.first.lead_id! }, action: "unblock" });
  assert.equal((await f.deliveries.claimDue(10)).length, 2);
});

test("erase source, provenance and queue PII atomically; attempted failed copies remain explicit processor followups", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const f = await setup(t);
  await f.deliveries.recordAttempt(f.delivery, {
    ok: false,
    retryable: true,
    backoffBaseMs: 1,
    externalId: "external-object-42",
    errorMessage: "private-response@example.com",
  });
  const result = await f.apply({
    target: { entity: "lead", id: f.first.lead_id! },
    action: "erase",
  });
  assert.equal(result.local_state, "erased");
  assert.equal(result.external_state, "pending");
  assert.equal(result.followups[0]?.external_id, "external-object-42");
  await assert.rejects(() =>
    f.app.formsSource.domain.submissions.getSubmission(f.first.submission_id),
  );
  await assert.rejects(() => f.app.formsSource.domain.leads.getLead(f.first.lead_id!));
  const stored = await f.deliveries.get(f.delivery.id);
  assert.deepEqual(stored?.delivery.payload, {});
  assert.equal(stored?.delivery.externalId, null);
  assert.equal(stored?.attempts[0]?.errorSummary, null);
  const ack = { decision: "owner_exception" as const, evidence_ref: "owner-case:42", actor };
  const acknowledged = await f.privacy.acknowledge(result.case_id, f.delivery.id, ack);
  assert.equal(acknowledged.external_state, "acknowledged_or_excepted");
  assert.equal(acknowledged.followups[0]?.external_id, null);
  assert.equal(acknowledged.followups[0]?.resolved_by, actor.id);
  assert.equal(acknowledged.followups[0]?.resolved_actor_type, actor.type);
  assert.equal(acknowledged.followups[0]?.resolved_at, clock.now().toISOString());
  assert.deepEqual(acknowledged.actor, actor);
  assert.deepEqual(await f.privacy.acknowledge(result.case_id, f.delivery.id, ack), acknowledged);
  await assert.rejects(
    () => f.privacy.acknowledge(result.case_id, f.delivery.id, { ...ack, evidence_ref: "changed" }),
    code("PRIVACY_FOLLOWUP_CONFLICT"),
  );
  assert.equal(
    (await f.app.formsSource.domain.submissions.getSubmission(f.unrelated.submission_id)).payload
      .email,
    "other@example.com",
  );
});

test("quiz block rejects resume mutations; correction validates original version and recomputes score/outcome/lead", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const f = await setup(t);
  const definition = await f.app.formsSource.domain.quizzes.createDefinition({
    key: "privacy_quiz",
    title: "Quiz",
    steps: [
      { id: "first", questions: [{ id: "q", type: "text", label: "Answer", required: true }] },
    ],
    scoring_rules: [
      { question_id: "q", operator: "eq", value: "old", points: 1 },
      { question_id: "q", operator: "eq", value: "new", points: 2 },
    ],
    outcomes: [
      { id: "old", title: "Old", min_score: 1, max_score: 1, lead_classification: "old" },
      { id: "new", title: "New", min_score: 2, max_score: 2 },
    ],
    settings: { lead_policy: { create_lead: true, summary_from_answer: "q" } },
  });
  const started = await f.app.formsSource.publicQuiz.start({ quiz_definition_id: definition.id });
  const token = { quiz_run_id: started.quiz_run_id, resume_token: started.resume_token };
  const target = { entity: "quiz_run" as const, id: started.quiz_run_id };
  await f.apply({ target, action: "block" });
  await assert.rejects(
    () => f.app.formsSource.publicQuiz.answer({ ...token, question_id: "q", value: "old" }),
    code("PRIVACY_BLOCKED_CONFLICT"),
  );
  await f.apply({ target, action: "unblock" });
  await f.app.formsSource.publicQuiz.answer({ ...token, question_id: "q", value: "old" });
  const completed = await f.app.formsSource.publicQuiz.complete(token);
  await f.apply({
    target,
    action: "rectify",
    correction: { quiz_answers: [{ question_id: "q", value: "new" }] },
  });
  const run = await f.app.formsSource.domain.runs.getRun(started.quiz_run_id);
  assert.equal(run.score, 2);
  assert.equal(run.outcome_id, "new");
  const lead = await f.app.formsSource.domain.leads.getLead(completed.lead_id!);
  assert.equal(lead.classification, null);
  assert.match(lead.presentation, /outcome: New/);
  await assert.rejects(
    () => f.privacy.preview({ target, action: "rectify", correction: { quiz_answers: [] } }),
    code("PRIVACY_CORRECTION_INVALID"),
  );
  await f.apply({ target, action: "erase" });
  assert.equal(
    (await f.pool.query("SELECT * FROM forms_quiz_answers WHERE run_id=$1", [started.quiz_run_id]))
      .rows.length,
    0,
  );
});

test("processing and stale previews refuse; failed receipt persistence rolls back source and local copies", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const f = await setup(t);
  const operation = { target: f.target, action: "erase" as const };
  const preview = await f.privacy.preview(operation);
  await f.pool.query("UPDATE integration_delivery SET status='PROCESSING' WHERE id=$1", [
    f.delivery.id,
  ]);
  await assert.rejects(
    () =>
      f.privacy.apply({
        ...operation,
        request_id: randomUUID(),
        expected_token: preview.expected_token,
        actor,
      }),
    code("PRIVACY_BUSY_CONFLICT"),
  );
  await f.pool.query("UPDATE integration_delivery SET status='PENDING' WHERE id=$1", [
    f.delivery.id,
  ]);
  await f.pool.query("UPDATE forms_submissions SET payload=$2 WHERE id=$1", [
    f.first.submission_id,
    JSON.stringify({ email: "changed@example.com" }),
  ]);
  await assert.rejects(
    () =>
      f.privacy.apply({
        ...operation,
        request_id: randomUUID(),
        expected_token: preview.expected_token,
        actor,
      }),
    code("PRIVACY_STALE_CONFLICT"),
  );
  const broken: DbPool = {
    ...f.pool,
    withTransaction: async (work) =>
      f.pool.withTransaction(async (tx) => {
        const connection: DbClient = {
          query: async (sql, params) => {
            if (sql.startsWith("INSERT INTO interaction_privacy_cases"))
              throw new Error("synthetic receipt failure");
            return tx.query(sql, params);
          },
        };
        return work(connection);
      }),
  };
  const service = createInteractionPrivacyService(broken, { clock });
  const fresh = await service.preview(operation);
  await assert.rejects(
    () =>
      service.apply({
        ...operation,
        request_id: randomUUID(),
        expected_token: fresh.expected_token,
        actor,
      }),
    /synthetic receipt failure/,
  );
  assert.equal(
    (await f.app.formsSource.domain.submissions.getSubmission(f.first.submission_id)).payload.email,
    "changed@example.com",
  );
  assert.deepEqual((await f.deliveries.get(f.delivery.id))?.delivery.payload, {
    email: "original@example.com",
  });
});

test("live outbound session survives expired lease without rearm; privacy refuses until result is persisted", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const f = await setup(t, true);
  const [claimed] = await f.deliveries.claimDue(1);
  assert.ok(claimed);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executing = f.deliveries.withExecution(claimed, async (executor) => {
    entered();
    await finish;
    await f.deliveries.recordAttempt(
      claimed,
      { ok: true, retryable: false, backoffBaseMs: 1, externalId: "live-remote" },
      executor,
    );
  });
  await started;
  try {
    await f.pool.query("UPDATE integration_delivery SET next_attempt_at=$2 WHERE id=$1", [
      claimed.id,
      new Date("2026-01-01"),
    ]);
    assert.equal(
      (await f.deliveries.claimDue(1)).length,
      0,
      "active HTTP must not be recovered/reclaimed",
    );
    const input = { target: f.target, action: "erase" as const };
    const preview = await f.privacy.preview(input);
    await assert.rejects(
      () =>
        f.privacy.apply({
          ...input,
          request_id: randomUUID(),
          expected_token: preview.expected_token,
          actor,
        }),
      code("PRIVACY_BUSY_CONFLICT"),
    );
  } finally {
    release();
    await executing;
  }
  const receipt = await f.apply({ target: f.target, action: "erase" });
  assert.equal(receipt.followups.length, 1);
  assert.equal(receipt.followups[0]?.external_id, "live-remote");
});

test("dispatcher keeps preparation outside the leased session; failed unlock discards without resending a successful call", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const f = await setup(t, true);
  let leased = false;
  let discarded = false;
  let sends = 0;
  const pool: DbPool = {
    ...f.pool,
    async query(sql, params) {
      assert.equal(leased, false, "pool=1 cannot acquire a second connection during dispatch");
      return f.pool.query(sql, params);
    },
    async withClient(work) {
      return f.pool.withClient(async (client) => {
        leased = true;
        try {
          return await work({
            async query(sql, params) {
              if (sql.startsWith("SELECT pg_advisory_unlock"))
                throw new Error("synthetic disconnect on unlock");
              return client.query(sql, params);
            },
            discard(error) {
              discarded = true;
              client.discard?.(error);
            },
          });
        } finally {
          leased = false;
        }
      });
    },
  };
  const registry = createConnectorRegistry();
  registry.register({
    connectorType: "stub",
    title: "Stub",
    description: "test",
    configSchema: { type: "object", properties: {}, additionalProperties: false },
    secrets: [],
    testable: true,
    actions: [
      {
        actionType: "send",
        description: "test",
        payloadSchema: {
          type: "object",
          properties: { email: { type: "string" } },
          required: ["email"],
        },
      },
    ],
  });
  const instances = createIntegrationInstanceService({ pool, clock, registry });
  const bindings = createIntegrationBindingService({ pool, clock, registry, instances });
  const deliveries = createDeliveryService({ pool, clock });
  const runtimes = new ConnectorRuntimeRegistry();
  runtimes.register("stub", {
    async execute() {
      sends++;
      return { ok: true, retryable: false, externalId: "remote-id" };
    },
    async test() {
      return { ok: true, retryable: false };
    },
  });
  const dispatcher = createIntegrationDispatcher({
    clock,
    registry,
    instances,
    bindings,
    deliveries,
    runtimes,
    secretResolver: () => undefined,
  });
  assert.equal(await dispatcher.processDue(1), 1);
  assert.equal(sends, 1);
  assert.equal(discarded, true);
  const result = await deliveries.get(f.delivery.id);
  assert.equal(result?.delivery.status, "SUCCEEDED");
  assert.equal(result?.delivery.attemptCount, 1);
  assert.equal(result?.attempts.length, 1);
});

test("interrupted dispatch outcome remains a possible external copy after lease recovery", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const f = await setup(t, true);
  const [delivery] = await f.deliveries.claimDue(1);
  assert.ok(delivery);
  await assert.rejects(
    () =>
      f.deliveries.withExecution(delivery, async () => {
        throw new Error("synthetic interruption before outcome persistence");
      }),
    /synthetic interruption/,
  );
  await f.pool.query("UPDATE integration_delivery SET status='PENDING' WHERE id=$1", [delivery.id]);
  const result = await f.apply({ target: f.target, action: "erase" });
  assert.equal(result.external_state, "pending");
  assert.equal(result.followups.length, 1);
  assert.equal(result.followups[0]?.delivery_id, delivery.id);
  assert.equal(result.followups[0]?.external_id, null);
});

test("owner-configured required intake consent rejects missing consent without storing a submission or lead", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const f = await setup(t);
  const definition = await f.app.formsSource.domain.definitions.createDefinition({
    key: "owner_selected_consent",
    title: "Consent selected by owner",
    fields: [
      {
        key: "privacy",
        type: "consent",
        label: "Consent",
        required: true,
        consent_key: "privacy",
        consent_text: "Synthetic owner-selected consent",
      },
    ],
    settings: { lead_policy: { create_lead: true } },
  });
  const before = await f.pool.query(
    "SELECT (SELECT count(*) FROM forms_submissions) AS submissions, (SELECT count(*) FROM forms_leads) AS leads",
  );
  await assert.rejects(
    () =>
      f.app.formsSource.publicForm.submit({
        form_definition_id: definition.id,
        values: {},
      }),
    code("FORM_VALUES_INVALID"),
  );
  const after = await f.pool.query(
    "SELECT (SELECT count(*) FROM forms_submissions) AS submissions, (SELECT count(*) FROM forms_leads) AS leads",
  );
  assert.deepEqual(after.rows, before.rows);
});

test("privacy migration preserves old data and flags historical deliveries conservatively; new queued deliveries start unattempted", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const f = await setup(t);
  await f.pool.query(`DROP TABLE interaction_privacy_followups, interaction_privacy_cases, interaction_privacy_subjects;
    ALTER TABLE publication_outbox DROP COLUMN privacy_blocked, DROP COLUMN privacy_retired;
    ALTER TABLE integration_delivery DROP COLUMN privacy_blocked, DROP COLUMN privacy_retired, DROP COLUMN external_copy_possible;`);
  await f.pool.query(readFileSync("db/migrations/0005_interaction_privacy.sql", "utf8"));
  const old = await f.pool.query(
    "SELECT external_copy_possible, payload, status FROM integration_delivery WHERE id=$1",
    [f.delivery.id],
  );
  assert.equal(old.rows[0]?.external_copy_possible, true);
  assert.equal(old.rows[0]?.status, "PENDING");
  assert.deepEqual(old.rows[0]?.payload, { email: "original@example.com" });
  const fresh = await f.materialize(undefined, 1);
  const created = await f.pool.query(
    "SELECT external_copy_possible FROM integration_delivery WHERE id=$1",
    [fresh.delivery.id],
  );
  assert.equal(created.rows[0]?.external_copy_possible, false);
  const preview = await f.privacy.preview({ target: f.target, action: "erase" });
  assert.deepEqual(
    preview.external_copies.map((copy) => copy.delivery_id),
    [f.delivery.id],
  );
});
