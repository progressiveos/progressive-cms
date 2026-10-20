// Machine-readable error projection shared by tool results (spec §52).
// Structural: every L1 error class carries a stable `code` string; details
// normalize into the same shape the REST envelope uses (spec §7), so agents
// see one validation-detail vocabulary across transports.
export function domainCodeOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "INTERNAL_ERROR";
}

export interface McpErrorProjection {
  readonly code: string;
  readonly message: string;
  readonly details: readonly unknown[];
  readonly retryable: boolean;
}

export function projectError(error: unknown): McpErrorProjection {
  const code = domainCodeOf(error);
  const raw = (error as { details?: unknown }).details;
  let details: readonly unknown[] = [];
  if (Array.isArray(raw)) {
    details = raw;
  } else if (raw !== null && typeof raw === "object") {
    const issues = (raw as { issues?: unknown }).issues;
    if (Array.isArray(issues)) details = issues;
    else details = [{ code: "STATE", ...(raw as Record<string, unknown>) }];
  }
  return {
    code,
    message: error instanceof Error ? error.message : "operation failed",
    details,
    retryable:
      code === "INTERNAL_ERROR" ||
      /_PERSISTENCE_FAILED$|_HANDLER_FAILED$|_THROTTLED$|_RATE_LIMITED$/.test(code),
  };
}
