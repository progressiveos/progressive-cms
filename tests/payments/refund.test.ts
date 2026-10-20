// PCMS-PAY-T006 — cancel/refund application operations: permission gating
// and audit live in the ops layer; the service enforces capability + state
// + amount. Partial refunds accumulate; full exhaustion flips to REFUNDED.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FakePaymentProvider, PaymentError } from "@pcms/payments";
import { ACTOR, paymentsFixture } from "./fixture.js";

test("cancel: allowed while CREATED/PENDING, rejected afterwards", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { payment } = await fx.payments.create({
    ...fx.CREATE,
    idempotency_key: "order-2026-000020",
  });
  const cancelled = await fx.payments.cancel(payment.id, ACTOR);
  assert.equal(cancelled.status, "CANCELLED");
  assert.ok(cancelled.cancelledAt !== null);
  // Idempotent second cancel is fine.
  const again = await fx.payments.cancel(payment.id, ACTOR);
  assert.equal(again.status, "CANCELLED");
  // A SUCCEEDED payment can never be cancelled.
  const { payment: paid } = await fx.payments.create({
    ...fx.CREATE,
    idempotency_key: "order-2026-000021",
  });
  await fx.payments.processCallback({
    providerInstanceId: fx.instanceId,
    parsed: {
      providerEventId: "evt-c1",
      externalPaymentId: paid.externalPaymentId,
      idempotencyKey: null,
      outcome: "SUCCEEDED",
    },
  });
  await assert.rejects(
    fx.payments.cancel(paid.id, ACTOR),
    (error: PaymentError) => error.code === "PAYMENT_INVALID_TRANSITION",
  );
});

test("S7 refund intents: REQUESTED recorded before the provider call; execute applies partial then full", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { payment } = await fx.payments.create({
    ...fx.CREATE,
    amount: 100,
    idempotency_key: "order-2026-000030",
  });
  await fx.payments.processCallback({
    providerInstanceId: fx.instanceId,
    parsed: {
      providerEventId: "evt-r0",
      externalPaymentId: payment.externalPaymentId,
      idempotencyKey: null,
      outcome: "SUCCEEDED",
    },
  });

  // Intent 1: partial 40 — recorded REQUESTED, money NOT moved yet.
  const first = await fx.payments.refund(
    payment.id,
    { amount: 40, reason: "partial claim" },
    ACTOR,
  );
  assert.equal(first.payment.status, "SUCCEEDED"); // untouched until execute
  let intents = await fx.payments.listRefundIntents(payment.id);
  assert.equal(intents[0]?.status, "REQUESTED");
  assert.equal(intents[0]?.amount, 40);

  // Execute: provider confirms → SUCCEEDED intent + payment applied.
  const executed = await fx.payments.executeRefundIntent(first.intentId);
  assert.equal(executed.status, "SUCCEEDED");
  const afterPartial = await fx.payments.get(payment.id);
  assert.equal(afterPartial?.status, "PARTIALLY_REFUNDED");
  assert.equal(afterPartial?.refundedAmount, 40);

  // Intent 2: full remainder 60 → REFUNDED.
  const second = await fx.payments.refund(payment.id, {}, ACTOR);
  await fx.payments.executeRefundIntent(second.intentId);
  const afterFull = await fx.payments.get(payment.id);
  assert.equal(afterFull?.status, "REFUNDED");
  assert.equal(afterFull?.refundedAmount, 100);
  intents = await fx.payments.listRefundIntents(payment.id);
  assert.deepEqual(intents.map((intent) => intent.status).toSorted(), ["SUCCEEDED", "SUCCEEDED"]);

  // Nothing left: the request path refuses before creating an intent.
  await assert.rejects(
    fx.payments.refund(payment.id, { amount: 1 }, ACTOR),
    (error: PaymentError) => error.code === "PAYMENT_INVALID_TRANSITION",
  );
});

test("S7: concurrent refund requests serialize — one active intent per payment", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { payment } = await fx.payments.create({
    ...fx.CREATE,
    amount: 500,
    idempotency_key: "order-2026-000032",
  });
  await fx.payments.processCallback({
    providerInstanceId: fx.instanceId,
    parsed: {
      providerEventId: "evt-r1",
      externalPaymentId: payment.externalPaymentId,
      idempotencyKey: null,
      outcome: "SUCCEEDED",
    },
  });
  // Two concurrent refund requests: exactly one wins (row lock + one-active
  // guard), the loser gets PAYMENT_REFUND_IN_PROGRESS.
  const results = await Promise.allSettled([
    fx.payments.refund(payment.id, { amount: 100 }, ACTOR),
    fx.payments.refund(payment.id, { amount: 200 }, ACTOR),
  ]);
  const fulfilled = results.filter(
    (entry) => entry.status === "fulfilled",
  ) as PromiseFulfilledResult<{
    intentId: string;
  }>[];
  const rejected = results.filter(
    (entry) => entry.status === "rejected",
  ) as PromiseRejectedResult[];
  assert.equal(fulfilled.length, 1, "exactly one intent must win");
  assert.equal(rejected.length, 1);
  const rejectedError = (rejected[0] as { reason: PaymentError }).reason;
  assert.equal(rejectedError.code, "PAYMENT_REFUND_IN_PROGRESS");
  // Double-submission of the SAME intent through the executor is idempotent.
  const firstExecute = await fx.payments.executeRefundIntent(fulfilled[0]!.value.intentId);
  const secondExecute = await fx.payments.executeRefundIntent(fulfilled[0]!.value.intentId);
  assert.equal(firstExecute.status, "SUCCEEDED");
  assert.equal(secondExecute.status, "SUCCEEDED");
  const after = await fx.payments.get(payment.id);
  assert.equal(after?.refundedAmount, 100); // applied exactly once
});

test("S7 regression: 20 concurrent refunds under load — exactly one wins, honest 409 for the rest", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { payment } = await fx.payments.create({
    ...fx.CREATE,
    amount: 500,
    idempotency_key: "order-2026-000034",
  });
  await fx.payments.processCallback({
    providerInstanceId: fx.instanceId,
    parsed: {
      providerEventId: "evt-r10",
      externalPaymentId: payment.externalPaymentId,
      idempotencyKey: null,
      outcome: "SUCCEEDED",
    },
  });
  // Deterministic race amplifier: every caller re-reads the unlocked
  // payment first (as refund() does), then fires refund() in the SAME tick.
  const payments = await Promise.all(Array.from({ length: 20 }, () => fx.payments.get(payment.id)));
  assert.ok(
    payments.every((entry) => entry !== null),
    "payment must exist for all callers",
  );
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => fx.payments.refund(payment.id, { amount: 10 }, ACTOR)),
  );
  const fulfilled = results.filter((entry) => entry.status === "fulfilled");
  const rejected = results.filter((entry) => entry.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one intent must win");
  for (const entry of rejected) {
    assert.equal(
      (entry as PromiseRejectedResult).reason.code,
      "PAYMENT_REFUND_IN_PROGRESS",
      "losers must get the honest 409-class code, never a raw 23505",
    );
  }
  // The winning REQUESTED intent executes honestly (money applied once).
  const winner = (fulfilled[0] as PromiseFulfilledResult<{ intentId: string }>).value;
  const executed = await fx.payments.executeRefundIntent(winner.intentId);
  assert.equal(executed.status, "SUCCEEDED");
  const after = await fx.payments.get(payment.id);
  assert.equal(after?.refundedAmount, 10);
});

test("S7 crash classes: crash before the provider call leaves REQUESTED (re-drivable); refund before success still invalid", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { payment } = await fx.payments.create({
    ...fx.CREATE,
    idempotency_key: "order-2026-000033",
  });
  // Refund before success: invalid transition, no intent row at all.
  await assert.rejects(
    fx.payments.refund(payment.id, {}, ACTOR),
    (error: PaymentError) => error.code === "PAYMENT_INVALID_TRANSITION",
  );
  assert.equal((await fx.payments.listRefundIntents(payment.id)).length, 0);

  // Success, then a REQUESTED intent whose executor never ran (crash
  // before the provider call): the next reconcile re-claims and completes it.
  await fx.payments.processCallback({
    providerInstanceId: fx.instanceId,
    parsed: {
      providerEventId: "evt-r2",
      externalPaymentId: payment.externalPaymentId,
      idempotencyKey: null,
      outcome: "SUCCEEDED",
    },
  });
  const claimed = await fx.payments.refund(payment.id, { amount: 30 }, ACTOR);
  const due = await fx.payments.claimDueRefundIntents(10);
  assert.ok(due.includes(claimed.intentId), "REQUESTED intent is due for execution");
  await fx.payments.executeRefundIntent(claimed.intentId);
  const after = await fx.payments.get(payment.id);
  assert.equal(after?.refundedAmount, 30);
  // After execution the intent is no longer claimed.
  const dueAgain = await fx.payments.claimDueRefundIntents(10);
  assert.equal(dueAgain.includes(claimed.intentId), false);
});

test("capability gates: a no-cancel/no-refund provider is refused structurally", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  // Structural stand-in with limited capabilities (read-only props bypassed
  // via a fresh literal object satisfying the interface).
  const limited = {
    providerType: "fake-limited",
    secretRequirements: fx.provider.secretRequirements,
    configSchema: fx.provider.configSchema,
    capabilities: () => ({
      cancel: false,
      refund: false,
      providerIdempotency: true,
      statusSync: false,
    }),
    createPayment: (input: Parameters<FakePaymentProvider["createPayment"]>[0]) =>
      fx.provider.createPayment(input, { values: {} }),
    verifyCallback: () => {},
    parseCallback: (request: Parameters<FakePaymentProvider["parseCallback"]>[0]) =>
      fx.provider.parseCallback(request),
  };
  fx.registry.register(limited);
  const limitedInstance = await fx.instances.create({
    providerType: "fake-limited",
    name: "limited",
    config: {},
    secretRefs: { signing: "FAKE_SIGNING_SECRET" },
  });
  const { payment } = await fx.payments.create({
    ...fx.CREATE,
    provider_instance_id: limitedInstance.id,
    idempotency_key: "order-2026-000040",
  });
  const paid = await fx.payments.processCallback({
    providerInstanceId: limitedInstance.id,
    parsed: {
      providerEventId: "evt-l1",
      externalPaymentId: payment.externalPaymentId,
      idempotencyKey: null,
      outcome: "SUCCEEDED",
    },
  });
  await assert.rejects(
    fx.payments.refund(paid.payment.id, {}, ACTOR),
    (error: PaymentError) => error.code === "PAYMENT_CAPABILITY_UNSUPPORTED",
  );
});

test("same partial refund intent: concurrent execution and replay apply money once", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { payment } = await fx.payments.create({ ...fx.CREATE, amount: 200 });
  await fx.payments.processCallback({
    providerInstanceId: fx.instanceId,
    parsed: {
      providerEventId: "paid",
      externalPaymentId: payment.externalPaymentId,
      idempotencyKey: null,
      outcome: "SUCCEEDED",
    },
  });
  const recorded = await fx.payments.refund(payment.id, { amount: 40 }, ACTOR);
  // Hold both provider calls in flight: the second delivery sees SUBMITTED.
  let calls = 0;
  let entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  fx.provider.refundPayment = async () => {
    calls++;
    entered();
    if (calls === 2) release();
    await barrier;
    return { providerRefundId: "same-provider-key" };
  };
  const first = fx.payments.executeRefundIntent(recorded.intentId);
  await firstEntered;
  const second = fx.payments.executeRefundIntent(recorded.intentId);
  await Promise.all([first, second]);
  await fx.payments.executeRefundIntent(recorded.intentId);
  assert.equal((await fx.payments.get(payment.id))?.refundedAmount, 40);
  const { rows } = await fx.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM payment_event WHERE payment_id = $1 AND event_type = 'PARTIALLY_REFUNDED'",
    [payment.id],
  );
  assert.equal(rows[0]?.count, "1");
});

test("non-idempotent interrupted refund requires review; sub-minor requests are rejected", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { payment } = await fx.payments.create({ ...fx.CREATE, amount: 200 });
  await fx.payments.processCallback({
    providerInstanceId: fx.instanceId,
    parsed: {
      providerEventId: "paid",
      externalPaymentId: payment.externalPaymentId,
      idempotencyKey: null,
      outcome: "SUCCEEDED",
    },
  });
  await assert.rejects(() => fx.payments.refund(payment.id, { amount: 1.001 }, ACTOR), {
    code: "PAYMENT_REQUEST_INVALID",
  });
  const recorded = await fx.payments.refund(payment.id, { amount: 40 }, ACTOR);
  await fx.pool.query("UPDATE payment_refund SET status = 'SUBMITTED' WHERE id = $1", [
    recorded.intentId,
  ]);
  let calls = 0;
  fx.provider.capabilities = () => ({
    cancel: true,
    refund: true,
    providerIdempotency: false,
    statusSync: true,
  });
  fx.provider.refundPayment = async () => {
    calls++;
    return {};
  };
  assert.deepEqual(await fx.payments.executeRefundIntent(recorded.intentId), {
    status: "NEEDS_REVIEW",
  });
  assert.equal(calls, 0);
  assert.equal((await fx.payments.get(payment.id))?.refundedAmount, 0);
});

test("concurrent REQUESTED refund claims retry the loser instead of completing its job", async (t) => {
  const fx = await paymentsFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { payment } = await fx.payments.create({ ...fx.CREATE, amount: 200 });
  await fx.payments.processCallback({
    providerInstanceId: fx.instanceId,
    parsed: {
      providerEventId: "paid",
      externalPaymentId: payment.externalPaymentId,
      idempotencyKey: null,
      outcome: "SUCCEEDED",
    },
  });
  const recorded = await fx.payments.refund(payment.id, { amount: 40 }, ACTOR);
  const originalQuery = fx.pool.query;
  let readers = 0;
  let releaseReads!: () => void;
  const bothRead = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  fx.pool.query = async (sql, params) => {
    const result = await originalQuery(sql, params);
    if (sql.includes("SELECT id, payment_id, amount::text AS amount")) {
      if (++readers === 2) releaseReads();
      await bothRead;
    }
    return result as never;
  };
  let releaseProvider!: () => void;
  const providerBarrier = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  t.after(() => releaseProvider());
  let calls = 0;
  fx.provider.refundPayment = async () => {
    calls++;
    await providerBarrier;
    return { providerRefundId: "one-call" };
  };
  const execute = () =>
    fx.payments.executeRefundIntent(recorded.intentId).catch((error) => {
      releaseProvider();
      throw error;
    });
  const outcomes = await Promise.allSettled([execute(), execute()]);
  const rejected = outcomes.filter((result) => result.status === "rejected");
  assert.equal(rejected.length, 1);
  assert.equal((rejected[0] as PromiseRejectedResult).reason.code, "PAYMENT_REFUND_IN_PROGRESS");
  assert.equal(calls, 1);
  assert.equal((await fx.payments.get(payment.id))?.refundedAmount, 40);
});
