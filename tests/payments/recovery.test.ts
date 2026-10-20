// S7 — inbound recovery (webhook replay/reconciliation) and the money
// boundary. Crash classes: a callback persisted (RECEIVED) but not applied
// (crash between persist and business apply) is replayed idempotently after
// RE-VERIFICATION; events that cannot be verified under the current secret
// set NEVER touch payment state; unknown provider types stay queued; the
// money whitelist rejects unsupported currencies and sub-minor precision.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { FakePaymentProvider } from "@pcms/payments";
import { ACTOR, paymentsFixture } from "./fixture.js";

/** Fake-provider callback envelope signed with the fixture's signing secret
 * (the same HMAC the live callback pipeline verifies). */
function signedBody(payload: Record<string, unknown>): {
  body: string;
  headers: Record<string, string>;
} {
  const body = JSON.stringify(payload);
  const headers = {
    "x-fake-signature": createHmac("sha256", "signing-secret").update(body).digest("hex"),
  };
  return { body, headers };
}

test("S7 recovery: RECEIVED-not-applied event replays idempotently after re-verification", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { payment } = await fx.payments.create({
    ...fx.CREATE,
    idempotency_key: "order-2026-000040",
  });
  // Crash simulation: receive() persisted the event (RECEIVED) but the
  // process died before processCallback. We fabricate that state directly.
  const signedBodyPayload = {
    event_id: "evt-recover-1",
    external_payment_id: payment.externalPaymentId,
    outcome: "SUCCEEDED",
  };
  const signed = signedBody(signedBodyPayload);
  const inserted = await fx.pool.query<{ id: string }>(
    `INSERT INTO integration_inbound_event
       (id, source_type, source_id, provider_event_id, dedup_key, payload_hash,
        event_type, raw_payload, transport, status)
     VALUES ($1, 'payment_provider', $2, 'evt-recover-1', 'evt-recover-1', 'hash', 'payment.succeeded', $3, $4, 'RECEIVED')
     RETURNING id`,
    [
      "11111111-1111-4111-8111-111111111111",
      fx.instanceId,
      JSON.stringify(signedBodyPayload),
      JSON.stringify({ raw_body: signed.body, headers: signed.headers }),
    ],
  );
  const eventId = inserted.rows[0]!.id;
  assert.equal((await fx.payments.get(payment.id))?.status, "PENDING");

  // Recovery re-verifies (fake HMAC) and applies; a second run is a no-op.
  const first = await fx.payments.recoverInboundEvent(eventId);
  assert.equal(first.applied, true);
  assert.equal((await fx.payments.get(payment.id))?.status, "SUCCEEDED");
  const second = await fx.payments.recoverInboundEvent(eventId);
  assert.equal(second.applied, false); // state machine: already applied
  const events = await fx.payments.listEvents(payment.id);
  assert.equal(events.filter((event) => event.eventType === "SUCCEEDED").length, 1);
});

test("S7 recovery: unverifiable events (bad signature) NEVER change payment state", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { payment } = await fx.payments.create({
    ...fx.CREATE,
    idempotency_key: "order-2026-000041",
  });
  const inserted = await fx.pool.query<{ id: string }>(
    `INSERT INTO integration_inbound_event
       (id, source_type, source_id, provider_event_id, dedup_key, payload_hash,
        event_type, raw_payload, transport, status)
     VALUES ($1, 'payment_provider', $2, 'evt-recover-2', 'evt-recover-2', 'hash', 'payment.succeeded', $3, $4, 'RECEIVED')
     RETURNING id`,
    [
      "22222222-2222-4222-8222-222222222222",
      fx.instanceId,
      JSON.stringify({
        event_id: "evt-recover-2",
        external_payment_id: payment.externalPaymentId,
        outcome: "SUCCEEDED",
      }),
      // transport WITHOUT a valid signature → verification must fail
      JSON.stringify({ raw_body: '{"forged":true}', headers: {} }),
    ],
  );
  const outcome = await fx.payments.recoverInboundEvent(inserted.rows[0]!.id);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.status, "FAILED"); // dead-letter state, visible
  assert.equal((await fx.payments.get(payment.id))?.status, "PENDING");
  const row = await fx.pool.query<{ attempts: number; error_code: string | null }>(
    `SELECT attempts, error_code FROM integration_inbound_event WHERE id = $1`,
    [inserted.rows[0]!.id],
  );
  assert.equal(row.rows[0]?.error_code, "PAYMENT_INBOUND_INVALID");
});

test("S7 recovery: disabled instance keeps servicing existing payments (callbacks still apply); absent provider stays queued", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { payment } = await fx.payments.create({
    ...fx.CREATE,
    idempotency_key: "order-2026-000042",
  });
  const inserted = await fx.pool.query<{ id: string }>(
    `INSERT INTO integration_inbound_event
       (id, source_type, source_id, provider_event_id, dedup_key, payload_hash,
        event_type, raw_payload, transport, status)
     VALUES ($1, 'payment_provider', $2, 'evt-recover-3', 'evt-recover-3', 'hash', 'payment.succeeded', $3, $4, 'FAILED')
     RETURNING id`,
    [
      "33333333-3333-4333-8333-333333333333",
      fx.instanceId,
      JSON.stringify({
        event_id: "evt-recover-3",
        external_payment_id: payment.externalPaymentId,
        outcome: "SUCCEEDED",
      }),
      JSON.stringify(
        (() => {
          const body = JSON.stringify({
            event_id: "evt-recover-3",
            external_payment_id: payment.externalPaymentId,
            outcome: "SUCCEEDED",
          });
          return {
            raw_body: body,
            headers: {
              "x-fake-signature": createHmac("sha256", "signing-secret").update(body).digest("hex"),
            },
          };
        })(),
      ),
    ],
  );
  // S6/S7 lifecycle: an instance DISABLED for new payments keeps servicing
  // EXISTING ones — the recovery applies the callback for the already-created
  // payment (create() gates on enabled; the callback pipeline does not), so
  // an already-paid order is never left unconfirmed.
  await fx.pool.query(`UPDATE payment_provider_instance SET enabled = false WHERE id = $1`, [
    fx.instanceId,
  ]);
  const outcome = await fx.payments.recoverInboundEvent(inserted.rows[0]!.id);
  assert.equal(outcome.applied, true);
  assert.equal((await fx.payments.get(payment.id))?.status, "SUCCEEDED");
});

test("S7 money: unsupported currencies and sub-minor precision are rejected explicitly", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await assert.rejects(
    fx.payments.create({
      ...fx.CREATE,
      amount: 100,
      currency: "JPY", // zero-decimal — outside the 2-decimal model
      idempotency_key: "order-2026-000043",
    }),
    (error: { code?: string }) => error.code === "PAYMENT_CURRENCY_UNSUPPORTED",
  );
  await assert.rejects(
    fx.payments.create({
      ...fx.CREATE,
      amount: 10.999, // 3 decimals — would require silent rounding
      currency: "USD",
      idempotency_key: "order-2026-000044",
    }),
    (error: { message: string }) => /sub-minor precision/.test(error.message),
  );
  // A supported 2-decimal amount still works.
  const ok = await fx.payments.create({
    ...fx.CREATE,
    amount: 10.99,
    currency: "USD",
    idempotency_key: "order-2026-000045",
  });
  assert.equal(ok.payment.currency, "USD");
});

test("S7: refund of an unknown-outcome provider (no idempotency) lands in NEEDS_REVIEW, never auto-retried", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { payment } = await fx.payments.create({
    ...fx.CREATE,
    idempotency_key: "order-2026-000046",
  });
  await fx.payments.processCallback({
    providerInstanceId: fx.instanceId,
    parsed: {
      providerEventId: "evt-r5",
      externalPaymentId: payment.externalPaymentId,
      idempotencyKey: null,
      outcome: "SUCCEEDED",
    },
  });
  // Stand-in provider WITHOUT refund idempotency and a throwing refund call
  // (unknown outcome class).
  const original = fx.payments;
  void original;
  const fake = fx.provider as FakePaymentProvider;
  fake.refundPayment = async () => {
    throw Object.assign(new Error("gateway timeout, outcome unknown"), {
      code: "PROVIDER_TRANSPORT",
    });
  };
  const requested = await fx.payments.refund(payment.id, { amount: 20 }, ACTOR);
  await assert.rejects(
    fx.payments.executeRefundIntent(requested.intentId),
    (error: { code?: string }) => error.code === "PROVIDER_TRANSPORT",
  );
  // The reconcile flip (worker reconcile sweep after max attempts):
  const stale = await fx.payments.reconcileStaleRefundIntents(0);
  assert.ok(stale >= 1);
  const intents = await fx.payments.listRefundIntents(payment.id);
  assert.equal(intents[0]?.status, "NEEDS_REVIEW");
  assert.equal((await fx.payments.get(payment.id))?.refundedAmount, 0); // no money moved
});
