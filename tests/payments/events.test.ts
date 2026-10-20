// PCMS-PAY-T007 — PaymentEvent append-only history: the timeline only ever
// grows, transitions appear in canonical order, and every status change
// emits the M07-envelope Outbox event (PaymentStatusChanged) in the same
// transaction as the state change (Payments spec §34/§36).
import assert from "node:assert/strict";
import { test } from "node:test";
import { paymentsFixture } from "./fixture.js";

test("timeline: CREATED → PROVIDER_PENDING → SUCCEEDED → refund events, in order, immutable", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { payment } = await fx.payments.create({
    ...fx.CREATE,
    amount: 90,
    idempotency_key: "order-2026-000050",
  });
  await fx.payments.processCallback({
    providerInstanceId: fx.instanceId,
    parsed: {
      providerEventId: "evt-h1",
      externalPaymentId: payment.externalPaymentId,
      idempotencyKey: null,
      outcome: "SUCCEEDED",
    },
  });
  const requested = await fx.payments.refund(
    payment.id,
    { amount: 40 },
    { type: "OPERATOR", id: "refund-desk" },
  );
  await fx.payments.executeRefundIntent(requested.intentId);

  const events = await fx.payments.listEvents(payment.id);
  assert.deepEqual(
    events.map((event) => event.eventType),
    ["CREATED", "PROVIDER_PENDING", "SUCCEEDED", "REFUND_REQUESTED", "PARTIALLY_REFUNDED"],
  );
  // Actor/source attribution preserved.
  const refundEvent = events.find((event) => event.eventType === "REFUND_REQUESTED");
  assert.equal(refundEvent?.source, "operator");
  assert.equal(refundEvent?.actorId, "refund-desk");
  const succeedEvent = events.find((event) => event.eventType === "SUCCEEDED");
  assert.equal(succeedEvent?.source, "provider");
  assert.equal(succeedEvent?.providerEventId, "evt-h1");
  // Repeated listing returns the same immutable history (append-only).
  const again = await fx.payments.listEvents(payment.id);
  assert.deepEqual(again, events);
});

test("every status change writes a PaymentStatusChanged outbox event in-envelope", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { payment } = await fx.payments.create({
    ...fx.CREATE,
    idempotency_key: "order-2026-000051",
  });
  await fx.payments.processCallback({
    providerInstanceId: fx.instanceId,
    parsed: {
      providerEventId: "evt-o1",
      externalPaymentId: payment.externalPaymentId,
      idempotencyKey: null,
      outcome: "SUCCEEDED",
    },
  });
  await fx.payments.cancel(payment.id, { type: "OPERATOR", id: "x" }).catch(() => undefined);
  const outbox = await fx.pool.query<{ event_type: string; payload: unknown }>(
    `SELECT event_type, payload FROM publication_outbox
     WHERE aggregate = 'payment' AND aggregate_id = $1 ORDER BY created_at, id`,
    [payment.id],
  );
  // CREATE (→PENDING) + callback (→SUCCEEDED): two state-change events; the
  // cancel attempt on a SUCCEEDED payment was refused and wrote nothing.
  assert.equal(outbox.rows.length, 2);
  assert.equal(outbox.rows[0]?.event_type, "PaymentStatusChanged");
  const second = outbox.rows[1]?.payload as {
    previous_status: string;
    status: string;
    subject_type: string;
  };
  assert.equal(second.previous_status, "PENDING");
  assert.equal(second.status, "SUCCEEDED");
  assert.equal(second.subject_type, "form_submission");
});
