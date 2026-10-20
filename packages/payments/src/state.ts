// Payment state machine (PCMS-PAY-T001; Payments spec §29/§35).
// Payment is independent DOMAIN state — it exists even when the provider
// is unreachable, and invalid regressions are rejected structurally:
//   SUCCEEDED → PENDING   prohibited
//   REFUNDED  → SUCCEEDED prohibited
// Provider-specific statuses normalize into these states in the adapter;
// the raw provider code travels as diagnostics only (never here).
import { PaymentError } from "./errors.js";

export const PAYMENT_STATUSES = [
  "CREATED",
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Allowed transitions. PARTIALLY_REFUNDED is self-reaching: several partial
 * refunds may accumulate until the remaining amount hits zero.
 */
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  CREATED: ["PENDING", "SUCCEEDED", "FAILED", "CANCELLED"],
  PENDING: ["PENDING", "SUCCEEDED", "FAILED", "CANCELLED"],
  SUCCEEDED: ["PARTIALLY_REFUNDED", "REFUNDED"], // a full refund may happen in one step
  FAILED: [],
  CANCELLED: [],
  PARTIALLY_REFUNDED: ["PARTIALLY_REFUNDED", "REFUNDED"],
  REFUNDED: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw new PaymentError(
      "PAYMENT_INVALID_TRANSITION",
      `transition ${from} → ${to} is not allowed`,
      { details: { from, to } },
    );
  }
}

/** PaymentEvent types (Payments spec §36) — append-only timeline. */
export const PAYMENT_EVENT_TYPES = [
  "CREATED",
  "PROVIDER_PENDING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "REFUND_REQUESTED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "SYNCED",
] as const;

export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

/** Opaque business subjects (Payments spec §30). `order` is a reserved
 * future Shop capability; extensions namespace their own entities. */
export const PAYMENT_SUBJECT_TYPES = ["form_submission", "quiz_run", "lead", "order"] as const;

export function isAllowedSubjectType(subjectType: string): boolean {
  return (
    (PAYMENT_SUBJECT_TYPES as readonly string[]).includes(subjectType) ||
    subjectType.startsWith("extension:")
  );
}

/** Event type a normalized provider outcome maps to. */
export function statusChangeEvent(from: PaymentStatus, to: PaymentStatus): PaymentEventType {
  if (to === "SUCCEEDED" && from !== "SUCCEEDED") return "SUCCEEDED";
  if (to === "FAILED") return "FAILED";
  if (to === "CANCELLED") return "CANCELLED";
  if (to === "PENDING") return "PROVIDER_PENDING";
  if (to === "PARTIALLY_REFUNDED") return "PARTIALLY_REFUNDED";
  if (to === "REFUNDED") return "REFUNDED";
  return "SYNCED";
}
