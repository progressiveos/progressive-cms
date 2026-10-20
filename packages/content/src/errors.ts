// Stable content-domain error codes (PCMS-CONT-T003).
// Codes are part of the public application contract: transports (M09) and the
// Admin UI (M10) match on `code`, never on message text (Content spec §73,
// Master Plan stable-error-code requirements).
export class ContentError extends Error {
  /** Machine-stable error code, e.g. "ENTRY_NOT_FOUND". */
  readonly code: string;
  readonly details: readonly unknown[];

  constructor(
    code: string,
    message: string,
    options?: { cause?: unknown; details?: readonly unknown[] },
  ) {
    super(message, options === undefined ? undefined : { cause: options.cause });
    this.name = "ContentError";
    this.code = code;
    this.details = options?.details ?? [];
  }
}
