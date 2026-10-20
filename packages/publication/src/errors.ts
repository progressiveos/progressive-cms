// Stable publication-domain error codes (PCMS-PUB-T005+). Normative §72
// baseline codes live here (PUBLICATION_CONFLICT, CHANGESET_*, SCHEDULE_*,
// ROUTE_CONFLICT, THEME_INCOMPATIBLE, JOB_ALREADY_COMPLETED surface through
// this subsystem); append-only registry, frozen by fixture contract test.
export class PublicationError extends Error {
  /** Machine-stable error code, e.g. "PUBLICATION_CONFLICT". */
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
    this.name = "PublicationError";
    this.code = code;
    this.details = options?.details;
  }
}

export const PUBLICATION_ERROR_CODES = [
  "PUBLICATION_CONFLICT",
  "PUBLICATION_NOT_FOUND",
  "PUBLICATION_NOT_PUBLISHED",
  "REVISION_NOT_SEALED",
  "CHANGESET_INVALID",
  "CHANGESET_STALE",
  "CHANGESET_NOT_FOUND",
  "CHANGESET_EMPTY",
  "CHANGESET_ITEM_DUPLICATE",
  "CHANGESET_ITEM_INVALID",
  "CHANGESET_ITEM_NOT_FOUND",
  "PUBLICATION_VALIDATION_FAILED",
  "ROUTE_CONFLICT",
  "MEDIA_NOT_READY",
  "THEME_INCOMPATIBLE",
  "SCHEDULE_CONFLICT",
  "SCHEDULE_IN_PAST",
  "PLAN_INVALID",
  "PLAN_NOT_FOUND",
  "PLAN_NOT_ACTIVE",
  "JOB_ALREADY_COMPLETED",
  "PREVIEW_TOKEN_INVALID",
  "PREVIEW_TOKEN_EXPIRED",
  "PREVIEW_SECRET_MISSING",
  "OUTBOX_HANDLER_FAILED",
] as const;

export type PublicationErrorCode = (typeof PUBLICATION_ERROR_CODES)[number];
