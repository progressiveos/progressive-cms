// M12→M13 convergence acceptance (post-merge integration; no parallel
// milestone could prove this seam). Real components only — no fixtures:
//
//   real M12 FormDefinition + public submission
//     → M07 outbox event (same transaction as the persisted submission)
//     → real M13 dispatcher.handleEvent (the worker dispatch-table entry)
//     → logical IntegrationDelivery through a real binding
//     → processDue → DeliveryAttempt → deterministic fake connector runtime
//
// Also proven: the default Forms projection adapter serves $project mappings
// through the M12 FormsSource boundary (allowlisted fields only), the generic
// outbox payload stays PII-free, and replaying the same event creates no
// second logical delivery (at-least-once idempotency, Integrations spec §11).
import assert from "node:assert/strict";
import { test } from "node:test";
import { systemClock } from "@pcms/core";
import { actionSucceeded, type ConnectorRuntime } from "@pcms/integrations";
import { createOutboxService } from "@pcms/publication";
import { createApiFixture } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

test("M12 FormSubmitted → M13 binding → delivery → attempt → fake connector succeeds", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fx = await createApiFixture(t);

  // 1. Real M12 FormDefinition (ACTIVE by default → publicly submittable).
  const definition = await fx.app.formsSource.domain.definitions.createDefinition({
    key: "convergence_contact",
    title: "Convergence contact form",
    fields: [
      { key: "email", type: "email", label: "E", required: true },
      { key: "note", type: "text", label: "N" },
    ],
  });

  // 2. Deterministic fake connector transport under the REAL webhook-http
  // definition: registry schema validation still gates mapped payloads.
  const sent: { readonly actionType: string; readonly payload: unknown }[] = [];
  const fakeRuntime: ConnectorRuntime = {
    async execute(actionType, payload) {
      sent.push({ actionType, payload: structuredClone(payload) });
      return actionSucceeded("crm-lead-1");
    },
    async test() {
      return actionSucceeded();
    },
  };
  fx.app.integrations.runtimes.register("webhook-http", fakeRuntime);

  // 3. Real M13 IntegrationInstance on that connector.
  const instance = await fx.app.integrations.instances.create({
    connectorType: "webhook-http",
    name: "crm-webhook",
    config: { url: "https://crm.example.test/hook", method: "POST" },
  });

  // 4. Real IntegrationBinding on FormSubmitted: payload mapped from the
  // event ($event) AND through the projection boundary ($project).
  const binding = await fx.app.integrations.bindings.create({
    eventType: "FormSubmitted",
    sourceFilter: "form_submission",
    conditions: [{ field: "form_definition_id", op: "eq", value: definition.id }],
    actions: [
      {
        instanceId: instance.id,
        actionType: "request",
        payloadMapping: {
          submission_id: { $event: "submission_id" },
          status: { $project: "status" },
          submitted_at: { $project: "submitted_at" },
        },
      },
    ],
  });

  // 5. Real M12 form submission through the public application service —
  // the FormSubmitted outbox event commits in the same transaction.
  const submitterEmail = "jane.pii@example.com";
  const result = await fx.app.formsSource.publicForm.submit({
    form_definition_id: definition.id,
    values: { email: submitterEmail, note: "please call back" },
  });
  assert.equal(result.status, "ACCEPTED");

  // 6. The FormSubmission is really persisted.
  const stored = await fx.app.formsSource.domain.submissions.getSubmission(result.submission_id);
  assert.equal(stored.status, "ACCEPTED");

  // 7. The real M07 outbox event created by this submission exists and its
  // generic payload carries routing metadata only — never PII. The claim
  // runs on the system clock: available_at is the DB's now(), exactly as
  // the worker's outbox loop sees it.
  const outbox = createOutboxService(fx.pool, { clock: systemClock });
  const claimed = await outbox.claimBatch(100);
  const event = claimed.find(
    (candidate) =>
      candidate.eventType === "FormSubmitted" && candidate.aggregateId === result.submission_id,
  );
  assert.ok(event, "FormSubmitted outbox event was written");
  assert.equal(event.aggregate, "form_submission");
  assert.deepEqual(event.payload, {
    submission_id: result.submission_id,
    form_definition_id: definition.id,
    form_schema_version: 1,
  });
  const payloadText = JSON.stringify(event.payload);
  assert.ok(!payloadText.includes(submitterEmail), "outbox payload leaks submitter email");
  assert.ok(!payloadText.includes("please call back"), "outbox payload leaks form values");

  // 8. Real M13 consumer path (the worker dispatch table entry) materializes
  // exactly one logical delivery for the binding action.
  await fx.app.integrations.dispatcher.handleEvent(event);
  await outbox.complete(event.id);
  let deliveries = await fx.app.integrations.deliveries.list();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.eventType, "FormSubmitted");
  assert.equal(deliveries[0]?.bindingId, binding.id);
  assert.equal(deliveries[0]?.instanceId, instance.id);

  // 9. Due delivery processing runs the real dispatcher execution path.
  const processed = await fx.app.integrations.dispatcher.processDue(10);
  assert.equal(processed, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.actionType, "request");
  // The projection delivered ALLOWLISTED fields only — no PII crosses the
  // composition boundary, and raw submission payload never appears.
  assert.deepEqual(sent[0]?.payload, {
    submission_id: result.submission_id,
    status: "ACCEPTED",
    submitted_at: stored.submitted_at,
  });

  // 10. The attempt is recorded under the delivery; outcome SUCCEEDED.
  const history = await fx.app.integrations.deliveries.get(deliveries[0]!.id);
  assert.ok(history);
  assert.equal(history.delivery.status, "SUCCEEDED");
  assert.equal(history.attempts.length, 1);
  assert.equal(history.attempts[0]?.result, "SUCCEEDED");
  assert.equal(history.attempts[0]?.attemptNo, 1);

  // Replay of the same outbox event (at-least-once delivery) must not create
  // a second logical delivery nor call the connector again.
  await fx.app.integrations.dispatcher.handleEvent(event);
  deliveries = await fx.app.integrations.deliveries.list();
  assert.equal(deliveries.length, 1, "delivery identity dedupes replayed events");
  assert.equal(sent.length, 1);
});
