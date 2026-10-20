// Stable revisions-domain error codes (PCMS-PUB-T001).
// Codes are part of the public application contract: transports (M09) and the
// Admin UI (M10) match on `code`, never on message text. The registry is
// append-only: minor releases may append, never rename or reinterpret.
export class RevisionError extends Error {
  /** Machine-stable error code, e.g. "REVISION_NOT_WORKING". */
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
    this.name = "RevisionError";
    this.code = code;
    this.details = options?.details;
  }
}

/**
 * Frozen at M07. Normative baseline from Publication spec §72:
 * REVISION_NOT_WORKING, REVISION_NOT_SEALED, REVISION_STALE (+ MEDIA_NOT_READY)
 * — the remaining §72 codes live in the publication-domain registries.
 */
export const REVISION_ERROR_CODES = [
  "REVISION_PAYLOAD_NOT_SERIALIZABLE",
  "REVISION_ENTITY_UNKNOWN",
  "REVISION_ENTITY_CONFLICT",
  "REVISION_NOT_FOUND",
  "REVISION_NOT_WORKING",
  "REVISION_NOT_SEALED",
  "REVISION_STALE",
  "REVISION_ENTITY_MISMATCH",
  "REVISION_ALREADY_WORKING",
  "REVISION_VALIDATION_FAILED",
  "MEDIA_NOT_READY",
  "REVISION_DIFF_ADAPTER_MISSING",
] as const;

export type RevisionErrorCode = (typeof REVISION_ERROR_CODES)[number];
