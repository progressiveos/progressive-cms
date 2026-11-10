import type { ApplicationServices } from "@pcms/api";
import type { Logger } from "@pcms/core";
import type { JobHandler, JobsService } from "@pcms/jobs";

export function createPaymentRefundJobHandlers(
  payments: ApplicationServices["payments"],
  logger: Logger,
  jobs: JobsService,
  options?: {
    /** How long a refund awaiting the provider's final answer stays parked. */
    readonly confirmationDelayMilliseconds?: number;
  },
): Record<string, JobHandler> {
  const confirmationDelay = options?.confirmationDelayMilliseconds ?? 60_000;
  const unavailable = {
    outcome: "parked",
    delayMilliseconds: 60_000,
    reason: "payment provider composition unavailable",
  } as const;
  const compose = async () => {
    try {
      await payments.ensureComposed();
      return true;
    } catch {
      return false;
    }
  };
  return {
    "payments.refund.execute": async (payload) => {
      const intentId =
        typeof (payload as { intent_id?: unknown })?.intent_id === "string"
          ? (payload as { intent_id: string }).intent_id
          : "";
      if (intentId === "") return;
      if (!(await compose())) return unavailable;
      try {
        const outcome = await payments.service.executeRefundIntent(intentId);
        // F1: a non-final answer is not the end of this job. Parking keeps the
        // SAME job (and its idempotency key) alive and re-runs it later, so the
        // existing queue carries the refund to a terminal state; a second
        // worker or a new job is not needed.
        if (outcome.status === "SUBMITTED") {
          return {
            outcome: "parked",
            delayMilliseconds: confirmationDelay,
            reason: "refund submitted; awaiting the provider's final outcome",
          };
        }
        return;
      } catch (error) {
        if ((error as { code?: string })?.code === "PAYMENT_PROVIDER_UNKNOWN") return unavailable;
        throw error;
      }
    },
    "payments.refund.reconcile": async () => {
      if (!(await compose())) return unavailable;
      const stale = await payments.service.reconcileStaleRefundIntents(5);
      if (stale > 0) {
        logger.warn("worker.payments.refund_stale", {
          operation: "worker.payments",
          intents: stale,
        });
      }
      // B1: a pending refund keeps advancing. Rows submitted at least a minute
      // ago are re-queued so the executor can CONFIRM the provider's refund
      // object; a money POST is never re-sent for them.
      const dueBefore = new Date(Date.now() - 60_000);
      const intents = await payments.service.claimDueRefundIntents(25, { dueBefore });
      for (const intentId of intents) {
        const enqueued = await jobs.enqueue({
          type: "payments.refund.execute",
          payload: { intent_id: intentId },
          idempotencyKey: `refund-intent-${intentId}`,
          preserveTerminalIdempotency: true,
          maxAttempts: 5,
          origin: "worker.payments.reconcile",
        });
        // F1: the intent is still active, but its job already finished (a
        // pending answer used to end it). Re-open THAT job instead of creating
        // a second one, which the active-idempotency index forbids anyway.
        if (enqueued.duplicate && enqueued.job.state === "SUCCEEDED") {
          await jobs.reopen(enqueued.job.id);
        }
      }
    },
  };
}
