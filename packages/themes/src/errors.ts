// Stable theme-domain error codes (PCMS-THEME-T001).
// Codes are part of the public application contract: transports match on
// `code`, never on message text (same rule as Content spec §73).
export class ThemeError extends Error {
  /** Machine-stable error code, e.g. "THEME_MANIFEST_INVALID". */
  readonly code: string;
  /** Machine-readable diagnostic context (template/block/entry IDs, paths). */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    options?: {
      cause?: unknown;
      details?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(message, options === undefined ? undefined : { cause: options.cause });
    this.name = "ThemeError";
    this.code = code;
    this.details = options?.details ?? {};
  }
}
