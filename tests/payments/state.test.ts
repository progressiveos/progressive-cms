// PCMS-PAY-T001 — Payment state machine: allowed paths succeed, invalid
// regressions are rejected (spec §35 examples), subject types are bounded
// with the future `order`/extension namespace reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertTransition,
  canTransition,
  isAllowedSubjectType,
  type PaymentError,
  statusChangeEvent,
} from "@pcms/payments";

test("happy lifecycle transitions are allowed", () => {
  assert.equal(canTransition("CREATED", "PENDING"), true);
  assert.equal(canTransition("CREATED", "SUCCEEDED"), true); // instant capture
  assert.equal(canTransition("CREATED", "CANCELLED"), true);
  assert.equal(canTransition("PENDING", "SUCCEEDED"), true);
  assert.equal(canTransition("PENDING", "FAILED"), true);
  assert.equal(canTransition("SUCCEEDED", "PARTIALLY_REFUNDED"), true);
  assert.equal(canTransition("PARTIALLY_REFUNDED", "PARTIALLY_REFUNDED"), true); // more partials
  assert.equal(canTransition("PARTIALLY_REFUNDED", "REFUNDED"), true);
});

test("invalid regressions are rejected", () => {
  assert.equal(canTransition("SUCCEEDED", "PENDING"), false);
  assert.equal(canTransition("REFUNDED", "SUCCEEDED"), false);
  assert.equal(canTransition("FAILED", "PENDING"), false);
  assert.equal(canTransition("CANCELLED", "SUCCEEDED"), false);
  assert.equal(canTransition("REFUNDED", "PARTIALLY_REFUNDED"), false);
  assert.throws(
    () => assertTransition("REFUNDED", "SUCCEEDED"),
    (error: PaymentError) => error.code === "PAYMENT_INVALID_TRANSITION",
  );
});

test("subject types: known + extension namespace allowed, junk rejected", () => {
  for (const subject of ["form_submission", "quiz_run", "lead", "order", "extension:crm_quote"]) {
    assert.equal(isAllowedSubjectType(subject), true, subject);
  }
  assert.equal(isAllowedSubjectType("hacker_table"), false);
});

test("status change events map to the append-only timeline", () => {
  assert.equal(statusChangeEvent("CREATED", "PENDING"), "PROVIDER_PENDING");
  assert.equal(statusChangeEvent("PENDING", "SUCCEEDED"), "SUCCEEDED");
  assert.equal(statusChangeEvent("SUCCEEDED", "PARTIALLY_REFUNDED"), "PARTIALLY_REFUNDED");
});
