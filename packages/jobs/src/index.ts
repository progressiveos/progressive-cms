// Jobs subsystem (M07): generic PostgreSQL-backed queue, claiming, retry
// classification, dead letters and the worker runner loop (Publication spec
// §62–§65). Generic infrastructure only — typed job payloads (publication
// schedules) arrive as structural contracts registered at the composition
// root; this package never imports other L1 packages.
export const PACKAGE_NAME = "@pcms/jobs";

export { JOBS_ERROR_CODES, JobsError, type JobsErrorCode } from "./errors.js";
export { createJobRunner, type JobRunner, type JobRunnerOptions } from "./runner.js";
export {
  createJobsService,
  type EnqueueJobInput,
  type EnqueueRecurringInput,
  type EnqueueRecurringResult,
  type JobErrorKind,
  type JobHandler,
  type JobRecord,
  type JobState,
  type JobsService,
} from "./store.js";
