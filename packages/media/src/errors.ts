// Stable media-domain error codes (PCMS-MEDIA-*; Media spec §60).
// Codes are part of the public application contract: transports (M09) and the
// Admin UI (M10) match on `code`, never on message text.
export class MediaError extends Error {
  /** Machine-stable error code, e.g. "MEDIA_TOO_LARGE". */
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options === undefined ? undefined : { cause: options.cause });
    this.name = "MediaError";
    this.code = code;
  }
}
