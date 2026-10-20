// Stable routing-domain error codes (PCMS-NAV-T001; Navigation spec §66).
// Codes are part of the public application contract: transports match on
// `code`, never on message text. The §66 baseline codes are kept verbatim;
// extensions follow the same <DOMAIN>_<CONDITION> shape.
export class RoutingError extends Error {
  /** Machine-stable error code, e.g. "ROUTE_COLLISION". */
  readonly code: string;
  /** Machine-readable diagnostic context (paths, hosts, route IDs). */
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
    this.name = "RoutingError";
    this.code = code;
    this.details = options?.details ?? {};
  }
}

/**
 * The complete set of routing-side stable codes (PCMS-NAV-T024; spec §66
 * plus documented extensions). Frozen by contract fixture
 * fixtures/navigation/error-code-contract.json — a minor release may only
 * append, never rename or reinterpret.
 */
export const ROUTING_ERROR_CODES = [
  "DOMAIN_ALREADY_BOUND",
  "DOMAIN_NOT_ALLOWED",
  "LOCALE_DEFAULT_NOT_ENABLED",
  "LOCALE_INVALID",
  "LOCALE_LIST_EMPTY",
  "LOCALE_NOT_ENABLED",
  "LOCALE_PREFIX_CONFLICT",
  "REDIRECT_CHAIN_TOO_LONG",
  "REDIRECT_LOOP",
  "REDIRECT_NOT_FOUND",
  "REDIRECT_STATUS_INVALID",
  "ROUTE_COLLISION",
  "ROUTE_INVALID_ENCODING",
  "ROUTE_LOCALE_INVALID",
  "ROUTE_NOT_FOUND",
  "ROUTE_PATH_INVALID",
  "ROUTE_RESERVED",
  "ROUTE_RESERVED_PREFIX_INVALID",
  "ROUTE_TARGET_INVALID",
  "SITE_KEY_INVALID",
  "SITE_NOT_FOUND",
  "SLUG_INVALID",
] as const;
export type RoutingErrorCode = (typeof ROUTING_ERROR_CODES)[number];
