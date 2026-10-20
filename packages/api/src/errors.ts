// Common error/validation/request-id model (PCMS-API-T002; API spec §6–§9).
//
// Every L1 subsystem already carries a stable machine error `code` on its own
// error class (ContentError, RevisionError, PublicationError, MediaError,
// SeoError, RoutingError, NavigationError, JobsError, ThemeError, AuthError).
// The transport model never re-wraps or renames those codes — it maps them,
// centrally and identically for REST/MCP/CLI, onto a status class + the one
// machine envelope from spec §7:
//
//   { "error": { "code", "message", "request_id", "details", "retryable" } }
//
// The stable code is the identity; the HTTP status is a presentation hint.

/** Transport-authored error (bad request shape, idempotency replay, …). */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: readonly unknown[];
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options?: {
      readonly status?: number;
      readonly details?: readonly unknown[];
      readonly retryable?: boolean;
      readonly cause?: unknown;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.code = code;
    this.status = options?.status ?? 400;
    this.details = options?.details ?? [];
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * Central HTTP mapping (spec §8, owner instruction #13). Routes never pick a
 * status individually; unknown internal failures collapse to 500 with a
 * stable code while the server log keeps the full diagnostic (spec §87).
 */
export function httpStatusForError(error: unknown): number {
  if (error instanceof ApiError) return error.status;
  // AuthError carries its own deliberate status hint (M08 enumeration-safe
  // single code paths: 401 vs 403 vs 429).
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status <= 499) return status;
  const code = domainErrorCode(error);
  if (code === null) {
    // Framework errors (Fastify) carry a numeric statusCode; trust it for
    // transport-class failures (body too large, unsupported media type).
    const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode <= 499) {
      return statusCode;
    }
    return 500;
  }
  if (/_NOT_FOUND$|_TARGET_MISSING$/.test(code)) return 404;
  if (
    /_CONFLICT$|_COLLISION$|_STALE$|_TAKEN$|_ALREADY_(EXISTS|WORKING|COMPLETED|REGISTERED)$/.test(
      code,
    )
  ) {
    return 409;
  }
  // A blocked delete/reference conflict is a real conflict, not a malformed
  // request: NAV_SET_BOUND (placement binding / derived set / external FK) and
  // DOMAIN_ALREADY_BOUND. The OpenAPI contract for DELETE /navigation/sets/:id
  // already documents 409 — HTTP 400 here contradicted it and made the two
  // dependency sites indistinguishable from a bad payload.
  if (/_BOUND$/.test(code)) return 409;
  if (/_TOO_LARGE$/.test(code)) return 413;
  if (/_RATE_LIMITED$|_THROTTLED$/.test(code)) return 429;
  // Expired handles (stock candidate references): the reference WAS valid —
  // the client must re-search, not retry the same call (2026-09-29 site
  // developer report: expired and malformed candidates were indistinguishable
  // 400s).
  if (/_EXPIRED$/.test(code)) return 410;
  // Provider-side transient failures (stock search/import 2026-09-29:
  // timeouts/unavailability surfaced as 400 and "looked" like a bad request)
  // are retryable by definition — 503 + retryable:true.
  if (/_TIMEOUT$|_UNAVAILABLE$/.test(code)) return 503;
  if (/_PERSISTENCE_FAILED$|_SECRET_MISSING$|_CONFIGURATION$/.test(code)) return 500;
  if (
    /_INVALID$|_REQUIRED$|_VALIDATION_FAILED$|_UNSUPPORTED$|_MISMATCH$|_MISSING$|_EMPTY$|_DUPLICATE$|_CYCLE$|_LOOP$|_TOO_DEEP$|_TOO_LONG$|_BLOCKED$|_WINDOW_EXCEEDED$|_NOT_ENABLED$/.test(
      code,
    )
  ) {
    return 422;
  }
  if (/_DENIED$/.test(code)) return 403;
  // Recognized domain error with an unmapped code: 400 by default — the code
  // itself stays machine-readable (spec §8 "do not rely solely on status").
  return 400;
}

/**
 * Domain error codes are UPPER_SNAKE with at least one `_` segment separator —
 * the convention every deliberate error class in the system follows. System
 * codes deliberately do not match: PostgreSQL SQLSTATEs start with a digit
 * ("23505", "22P02"), Node system codes are bare acronyms ("ENOENT",
 * "ECONNREFUSED"), and Node programmatic codes are "ERR_"-prefixed.
 */
const DOMAIN_CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9_]+)+$/;

/** System error shapes (PostgreSQL `severity`, Node `errno`/`syscall`). */
function isSystemErrorShape(error: Error): boolean {
  const record = error as { errno?: unknown; syscall?: unknown; severity?: unknown };
  return (
    record.errno !== undefined ||
    typeof record.syscall === "string" ||
    typeof record.severity === "string"
  );
}

/**
 * Extracts the stable domain code, but only from errors that carry one
 * deliberately: `ApiError` as authored by the transport/application, plus any
 * other error whose `code` follows the domain-code convention and whose shape
 * is not a system-level error (audit F-12). Raw PostgreSQL/Node codes — and
 * the internals they would leak — collapse to INTERNAL_ERROR instead.
 */
export function domainErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (error instanceof ApiError) return error.code.length > 0 ? error.code : null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !DOMAIN_CODE_PATTERN.test(code)) return null;
  if (isSystemErrorShape(error)) return null;
  return code;
}

export interface ErrorDetail {
  readonly code: string;
  readonly path?: string;
  readonly message: string;
  readonly severity?: string;
  readonly source?: string;
}

/**
 * Normalizes validation payloads into the spec §7 detail shape
 * (code/path/message/severity/source) without dropping domain specifics.
 */
export function normalizeDetails(error: unknown): readonly unknown[] {
  if (error instanceof ApiError) return error.details;
  const raw = (error as { details?: unknown } | null)?.details;
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    return raw.map((issue) => normalizeIssue(issue));
  }
  if (typeof raw === "object") {
    // Validation reports nest their issue list under `issues` (RevisionError);
    // surface the list directly — the envelope already names the error code.
    const issues = (raw as { issues?: unknown }).issues;
    if (Array.isArray(issues)) return issues.map((issue) => normalizeIssue(issue));
    // Revision CAS style: { expected, current } → client-actionable detail.
    return [{ code: "STATE", ...raw }];
  }
  return [raw];
}

function normalizeIssue(issue: unknown): unknown {
  if (typeof issue !== "object" || issue === null) return issue;
  const record = issue as Record<string, unknown>;
  // RevisionIssue/ValidationIssue/BlockIssue/PreflightIssue all carry
  // code+message; keep their extra fields verbatim (no information loss).
  if (typeof record.code === "string" && typeof record.message === "string") {
    return record;
  }
  return issue;
}

export interface ErrorEnvelopeBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly request_id: string;
    readonly details: readonly unknown[];
    readonly retryable: boolean;
  };
}

/**
 * The single machine error envelope (spec §7). `message` is the domain's own
 * human text; raw internals (SQL, filesystem paths, stack traces) never enter
 * the envelope — subsystem messages are written for operators, and unexpected
 * failures collapse to a fixed INTERNAL_ERROR text.
 */
export function toErrorEnvelope(error: unknown, requestId: string): ErrorEnvelopeBody {
  const status = httpStatusForError(error);
  const rawCode = domainErrorCode(error);
  // Framework error codes are internal exception names — never exposed raw
  // (owner instruction #12); they collapse to the stable transport codes.
  const isFramework = rawCode?.startsWith("FST_ERR_");
  const code =
    rawCode === null ? "INTERNAL_ERROR" : isFramework ? frameworkCode(rawCode, status) : rawCode;
  const unexpected = code === "INTERNAL_ERROR";
  const message = unexpected
    ? "unexpected internal error"
    : isFramework
      ? "request does not satisfy the API contract"
      : error instanceof Error
        ? error.message
        : "request failed";
  const retryable =
    error instanceof ApiError
      ? error.retryable
      : status === 429 ||
        status === 503 ||
        code === "INTERNAL_ERROR" ||
        /_PERSISTENCE_FAILED$|_HANDLER_FAILED$/.test(code);
  return {
    error: {
      code,
      message,
      request_id: requestId,
      // Unexpected non-domain failures expose nothing beyond the fixed text —
      // no raw `details` payload can smuggle internals into the envelope.
      details: isFramework
        ? frameworkDetails(error)
        : error instanceof ApiError || !unexpected
          ? normalizeDetails(error)
          : [],
      retryable,
    },
  };
}

function frameworkCode(code: string, status: number): string {
  if (status === 413) return "API_PAYLOAD_TOO_LARGE";
  if (status === 415) return "API_REQUEST_INVALID";
  return code === "FST_ERR_NOT_FOUND" ? "API_NOT_FOUND" : "API_REQUEST_INVALID";
}

function frameworkDetails(error: unknown): readonly unknown[] {
  const validation = (error as { validation?: unknown } | null)?.validation;
  if (!Array.isArray(validation)) return [];
  return validation.map((issue) => {
    const record = issue as Record<string, unknown>;
    let message = typeof record.message === "string" ? record.message : "schema violation";
    // additionalProperties rejections name the offending key already, but
    // clients repeatedly send the camelCase twin of a snake_case contract
    // (2026-09-29 field report). Name the corrected key the way
    // BLOCK_PROPERTY_UNKNOWN does.
    const params = record.params as Record<string, unknown> | undefined;
    const additional =
      typeof params?.additionalProperty === "string" ? params.additionalProperty : null;
    if (additional !== null && /additional/i.test(message)) {
      const snake = additional.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      if (snake !== additional) message += ` — use "${snake}"`;
    }
    return {
      code: "SCHEMA",
      path: typeof record.instancePath === "string" ? record.instancePath : "",
      message,
    };
  });
}
