import type { ApplicationServices } from "@pcms/api";
import type { Logger } from "@pcms/core";
import type { JobHandler, JobsService } from "@pcms/jobs";

export function createPaymentRefundJobHandlers(
  payments: ApplicationServices["payments"],
  logger: Logger,
  jobs: JobsService,
): Record<string, JobHandler> {
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
        await payments.service.executeRefundIntent(intentId);
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
      const intents = await payments.service.claimDueRefundIntents(25);
      for (const intentId of intents) {
        await jobs.enqueue({
          type: "payments.refund.execute",
          payload: { intent_id: intentId },
          idempotencyKey: `refund-intent-${intentId}`,
          preserveTerminalIdempotency: true,
          maxAttempts: 5,
          origin: "worker.payments.reconcile",
        });
      }
    },
  };
}
