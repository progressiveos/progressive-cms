// PCMS-PAY-T005 — provider inbound callback processing: verified callback
// applies the transition, duplicates are harmless, regressing provider
// events are ignored, unknown payments are named errors. Signature
// verification and dedup live in the provider adapter + InboundEvent
// layer (tested there); this file proves the payment-side pipeline.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaymentError } from "@pcms/payments";
import { paymentsFixture } from "./fixture.js";

test("verified callback applies SUCCEEDED once; duplicate callbacks are no-ops", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { payment } = await fx.payments.create({
    ...fx.CREATE,
    idempotency_key: "order-2026-000010",
  });
  assert.equal(payment.status, "PENDING");

  const applied = await fx.payments.processCallback({
    providerInstanceId: fx.instanceId,
    parsed: {
      providerEventId: "provider-evt-1",
      externalPaymentId: payment.externalPaymentId,
      idempotencyKey: null,
      outcome: "SUCCEEDED",
    },
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.payment.status, "SUCCEEDED");
  assert.ok(applied.payment.paidAt !== null);

  // The SAME callback replayed (at-least-once delivery): no change.
  const replay = await fx.payments.processCallback({
    providerInstanceId: fx.instanceId,
    parsed: {
      providerEventId: "provider-evt-1",
      externalPaymentId: payment.externalPaymentId,
      idempotencyKey: null,
      outcome: "SUCCEEDED",
    },
  });
  assert.equal(replay.applied, false);
  assert.equal(replay.payment.status, "SUCCEEDED");

  // A stale PENDING event arriving AFTER success: ignored, no regression.
  const stale = await fx.payments.processCallback({
    providerInstanceId: fx.instanceId,
    parsed: {
      providerEventId: "provider-evt-0",
      externalPaymentId: payment.externalPaymentId,
      idempotencyKey: null,
      outcome: "PENDING",
    },
  });
  assert.equal(stale.applied, false);
  assert.equal(stale.payment.status, "SUCCEEDED");

  // Timeline kept exactly one SUCCEEDED event.
  const events = await fx.payments.listEvents(payment.id);
  const succeeded = events.filter((event) => event.eventType === "SUCCEEDED");
  assert.equal(succeeded.length, 1);
  assert.equal(succeeded[0]?.providerEventId, "provider-evt-1");
});

test("FAILED callback and refund-capable flow locate by idempotency key too", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await fx.payments.create({ ...fx.CREATE, idempotency_key: "order-2026-000011" });
  const applied = await fx.payments.processCallback({
    providerInstanceId: fx.instanceId,
    parsed: {
      providerEventId: "provider-evt-2",
      externalPaymentId: null,
      idempotencyKey: "order-2026-000011",
      outcome: "FAILED",
      providerStatus: "CARD_DECLINED",
    },
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.payment.status, "FAILED");
  const events = await fx.payments.listEvents(applied.payment.id);
  const last = events.at(-1);
  assert.equal((last?.payload as { provider_status?: string })?.provider_status, "CARD_DECLINED");
});

test("callbacks without a payment reference or for unknown payments are errors", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await assert.rejects(
    fx.payments.processCallback({
      providerInstanceId: fx.instanceId,
      parsed: {
        providerEventId: "evt-x",
        externalPaymentId: null,
        idempotencyKey: null,
        outcome: "SUCCEEDED",
      },
    }),
    (error: PaymentError) => error.code === "PAYMENT_INBOUND_INVALID",
  );
  await assert.rejects(
    fx.payments.processCallback({
      providerInstanceId: fx.instanceId,
      parsed: {
        providerEventId: "evt-y",
        externalPaymentId: "fake_nobody",
        idempotencyKey: null,
        outcome: "SUCCEEDED",
      },
    }),
    (error: PaymentError) => error.code === "PAYMENT_NOT_FOUND",
  );
});
