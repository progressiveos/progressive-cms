// Structural subset of the jobs subsystem used by the plan scheduler.
// @pcms/publication cannot import @pcms/jobs (L1 boundary), so the contract
// is structural; the worker composition passes its @pcms/jobs service (which
// satisfies this shape) into createPublicationPlanService.
import type { StableId } from "@pcms/core";

export interface StructuralJobsService {
  enqueue(input: {
    readonly type: string;
    readonly payload: unknown;
    readonly runAt?: Date;
    readonly idempotencyKey?: string;
    readonly maxAttempts?: number;
    readonly origin?: string;
  }): Promise<{ readonly job: { readonly id: StableId }; readonly duplicate: boolean }>;
  cancelPendingJob(jobId: StableId): Promise<boolean>;
}
