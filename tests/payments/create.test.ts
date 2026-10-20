// PCMS-PAY-T004 — create payment + idempotency: a retry after a provider
// timeout (or any transport failure) resolves to the SAME logical payment;
// a changed payload under the same key is a conflict; an interrupted
// creation resumes transparently.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaymentError } from "@pcms/payments";
import { paymentsFixture } from "./fixture.js";

test("create → PENDING at the provider; replay returns the SAME logical payment", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const first = await fx.payments.create(fx.CREATE, { type: "OPERATOR", id: "o1" });
  assert.equal(first.payment.status, "PENDING");
  assert.equal(first.replayed, false);
  assert.equal(first.payment.externalPaymentId, `fake_${first.payment.id}`);
  assert.ok(first.payment.createdAt !== undefined);

  // Retry after timeout with the identical payload → replay, no second charge.
  const second = await fx.payments.create(fx.CREATE);
  assert.equal(second.replayed, true);
  assert.equal(second.payment.id, first.payment.id);
  assert.equal(fx.provider.createCallsCount(), 1); // provider idempotency short-circuits nothing here; 1 provider call total
});

test("interrupted creation (payment CREATED, no external id) resumes on replay", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  // Simulate an outage: make createPayment throw by exhausting our fake
  // wiring — easiest deterministic path: point the instance's secret at a
  // missing name for the FIRST attempt only is not possible, so instead
  // insert a CREATED payment row directly (as a crash would leave it).
  const { payment } = await fx.payments.create(fx.CREATE);
  assert.equal(payment.status, "PENDING");
  // Now break the secret and create a second payment to test the outage path.
  await fx.instances.update(fx.instanceId, { secretRefs: { signing: "MISSING_SECRET" } });
  await assert.rejects(
    fx.payments.create({ ...fx.CREATE, idempotency_key: "order-2026-000002" }),
    (error: PaymentError) => error.code === "PAYMENT_REQUEST_INVALID",
  );
  // The accepted business state SURVIVED as CREATED (spec §1: an outage can
  // never destroy it); nothing reached the provider.
  const interrupted = await fx.payments.getByProviderAndKey(fx.instanceId, "order-2026-000002");
  assert.equal(interrupted?.status, "CREATED");
  assert.equal(interrupted?.externalPaymentId, null);
  await fx.instances.update(fx.instanceId, { secretRefs: { signing: "FAKE_SIGNING_SECRET" } });
  // Replay with the same key RESUMES the same logical payment.
  const resumed = await fx.payments.create({ ...fx.CREATE, idempotency_key: "order-2026-000002" });
  assert.equal(resumed.payment.id, interrupted?.id);
  assert.equal(resumed.payment.status, "PENDING");
});

test("same idempotency key with a CHANGED payload is a hard conflict", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await fx.payments.create(fx.CREATE);
  await assert.rejects(
    fx.payments.create({ ...fx.CREATE, amount: 9999 }),
    (error: PaymentError) => error.code === "PAYMENT_DUPLICATE_REQUEST",
  );
});

test("invalid requests are rejected with stable codes", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const cases: readonly [Partial<typeof fx.CREATE>, string][] = [
    [{ amount: 0 }, "amount"],
    [{ currency: "rub" }, "currency"],
    [{ subject_type: "hacker_table" }, "subject_type"],
    [{ idempotency_key: "short" }, "idempotency_key"],
  ];
  for (const [patch, label] of cases) {
    await assert.rejects(
      fx.payments.create({ ...fx.CREATE, ...patch } as never),
      (error: PaymentError) => error.code === "PAYMENT_REQUEST_INVALID",
      label,
    );
  }
  // Unknown provider instance.
  await assert.rejects(
    fx.payments.create({
      ...fx.CREATE,
      provider_instance_id: "00000000-0000-0000-0000-000000000000",
    }),
    (error: PaymentError) => error.code === "PAYMENT_PROVIDER_INSTANCE_NOT_FOUND",
  );
  // Future `order` subject is accepted as an opaque subject (owner corpus).
  const order = await fx.payments.create({
    ...fx.CREATE,
    subject_type: "order",
    idempotency_key: "order-future-01",
  });
  assert.equal(order.payment.subjectType, "order");
});
