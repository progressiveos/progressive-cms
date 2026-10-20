// Stable block-domain error codes (PCMS-CONT-T013).
// Mirrors the Content subsystem error contract: transports match on `code`,
// never on message text (Content spec §66).
export class BlocksError extends Error {
  /** Machine-stable error code, e.g. "BLOCK_TYPE_UNKNOWN". */
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options === undefined ? undefined : { cause: options.cause });
    this.name = "BlocksError";
    this.code = code;
  }
}
