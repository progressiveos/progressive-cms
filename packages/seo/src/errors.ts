// Stable SEO error codes (PCMS-SEO-T001; SEO spec §70/§77-T022).
// Codes are part of the public application contract: transports match on
// `code`, never on message text. Extensions follow the SEO_<CONDITION> shape
// and may only append — the frozen contract fixture
// fixtures/seo/error-code-contract.json pins the registry.
export class SeoError extends Error {
  /** Machine-stable error code, e.g. "SEO_DOCUMENT_INVALID". */
  readonly code: string;
  /** Machine-readable diagnostic context (paths, ids, issues). */
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
    this.name = "SeoError";
    this.code = code;
    this.details = options?.details ?? {};
  }
}

/**
 * The complete set of SEO stable codes. A minor release may only append,
 * never rename or reinterpret (SEO spec §74 compatibility rule).
 */
export const SEO_ERROR_CODES = [
  "SEO_DOCUMENT_INVALID",
  "SEO_ROBOTS_INVALID",
  "SEO_ID_INVALID",
  "SEO_SETTINGS_INVALID",
  "SEO_STRUCTURED_DATA_INVALID",
  "SEO_ROBOTS_TXT_INVALID",
  "SEO_SITEMAP_INPUT_INVALID",
] as const;
export type SeoErrorCode = (typeof SEO_ERROR_CODES)[number];
