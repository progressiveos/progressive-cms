// Stable navigation-domain error codes (PCMS-NAV-T001).
// Codes are part of the public application contract: transports match on
// `code`, never on message text (Navigation spec §66; same rule as the
// Theme/Content error contracts).
export class NavigationError extends Error {
  /** Machine-stable error code, e.g. "NAV_OVERRIDE_STALE". */
  readonly code: string;
  /** Machine-readable diagnostic context (set/item IDs, paths, overrides). */
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
    this.name = "NavigationError";
    this.code = code;
    this.details = options?.details ?? {};
  }
}

/**
 * The complete set of navigation-side stable codes (PCMS-NAV-T024; spec §66
 * plus documented extensions). Frozen by contract fixture
 * fixtures/navigation/error-code-contract.json — a minor release may only
 * append, never rename or reinterpret.
 */
export const NAVIGATION_ERROR_CODES = [
  "NAV_BREADCRUMB_TOO_DEEP",
  "NAV_BREADCRUMB_TRAIL_MISSING",
  "NAV_DEPTH_UNSUPPORTED",
  "NAV_ITEM_NOT_FOUND",
  "NAV_ITEM_PARENT_INVALID",
  "NAV_ITEM_PAYLOAD_INVALID",
  "NAV_ITEM_REL_TOKEN_INVALID",
  "NAV_ITEM_TYPE_INVALID",
  "NAV_ITEM_TYPE_UNSUPPORTED",
  "NAV_MOVE_CYCLE",
  "NAV_OVERRIDE_INVALID",
  "NAV_OVERRIDE_NOT_FOUND",
  "NAV_OVERRIDE_STALE",
  "NAV_OVERRIDE_TARGET_MISSING",
  "NAV_PLACEMENT_KEY_INVALID",
  "NAV_PLACEMENT_REQUIRED_MISSING",
  "NAV_PLACEMENT_UNKNOWN",
  "NAV_REVISION_NOT_FOUND",
  "NAV_SET_BASE_DERIVED",
  "NAV_SET_BOUND",
  "NAV_SET_KEY_INVALID",
  "NAV_SET_KEY_TAKEN",
  "NAV_SET_NOT_DERIVED",
  "NAV_SET_NOT_FOUND",
  "NAV_SET_TITLE_INVALID",
  "NAV_TARGET_MISSING",
  "NAV_TREE_TOO_LARGE",
] as const;
export type NavigationErrorCode = (typeof NAVIGATION_ERROR_CODES)[number];
