// Stable jobs-domain error codes (PCMS-PUB-T018). Append-only registry;
// JOB_ALREADY_COMPLETED is the normative §72 code surfaced here.
export class JobsError extends Error {
  /** Machine-stable error code, e.g. "JOB_ALREADY_COMPLETED". */
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: string,
    message: string,
    options?: {
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    },
  ) {
    super(message, options === undefined ? undefined : { cause: options.cause });
    this.name = "JobsError";
    this.code = code;
    this.details = options?.details;
  }
}

export const JOBS_ERROR_CODES = [
  "JOB_NOT_FOUND",
  "JOB_ALREADY_COMPLETED",
  "JOB_TYPE_UNKNOWN",
  "JOB_STATE_INVALID",
  "JOB_IDEMPOTENCY_CONFLICT",
] as const;

export type JobsErrorCode = (typeof JOBS_ERROR_CODES)[number];
