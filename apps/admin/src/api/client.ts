// Same-origin client for /api/v1 (PCMS-ADMIN-T001; M09 transport contract).
//
// The Admin is a cookie session client: the browser attaches the M08 session
// cookie automatically, and every mutating request carries the synchronizer
// token in `X-PCMS-CSRF`. Bearer service tokens never exist in this bundle
// (verified by scripts/scan-admin-bundle.mjs).
import { t } from "../i18n/index.js";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly details: readonly unknown[];
  readonly retryable: boolean;

  constructor(init: {
    readonly code: string;
    readonly status: number;
    readonly message: string;
    readonly requestId?: string | null;
    readonly details?: readonly unknown[];
    readonly retryable?: boolean;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId ?? null;
    this.details = init.details ?? [];
    this.retryable = init.retryable ?? false;
  }
}

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const UNAUTHENTICATED = new Set(["AUTH_UNAUTHENTICATED", "AUTH_SESSION_INVALID"]);

let csrfToken: string | null = null;

/** Stores the current synchronizer token (memory only — never persisted). */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Dispatched when the server says the session is gone (login screen shows). */
export const UNAUTHENTICATED_EVENT = "pcms:unauthenticated";

export interface RequestOptions {
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Raw body (uploads); overrides `body` and disables the JSON header. */
  readonly rawBody?: BodyInit;
  /** Contributions refuse redirects so CSRF headers cannot leave the API origin. */
  readonly redirect?: "error";
}

/** POST that resolves to the raw response body — file downloads (CSV
 * export) that must not go through the JSON envelope parser. */
export async function apiDownload(method: string, path: string, body: unknown): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && method !== "HEAD" && csrfToken !== null) {
    headers["x-pcms-csrf"] = csrfToken;
  }
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: "same-origin",
  });
  if (!response.ok) {
    // Surface the server's error envelope — a bare HTTP status is not
    // actionable for the operator (leads CSV export 400 case).
    const text = await response.text().catch(() => "");
    let serverMessage = response.statusText;
    let serverCode = `HTTP_${String(response.status)}`;
    try {
      const envelope = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (envelope.error?.message !== undefined) serverMessage = envelope.error.message;
      if (envelope.error?.code !== undefined) serverCode = envelope.error.code;
    } catch {
      // not JSON — keep the HTTP fallback
    }
    throw new ApiError({
      code: serverCode,
      status: response.status,
      message: serverMessage,
      retryable: false,
    });
  }
  return response.blob();
}

export async function apiRequest<T>(
  method: string,
  path: string,
  options?: RequestOptions,
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...options?.headers };
  let body: BodyInit | undefined;
  if (options?.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options?.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  if (MUTATING.has(method) && csrfToken !== null) {
    headers["x-pcms-csrf"] = csrfToken;
  }

  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      credentials: "same-origin",
      ...(options?.redirect === undefined ? {} : { redirect: options.redirect }),
    });
  } catch {
    throw new ApiError({
      code: "NETWORK_UNREACHABLE",
      status: 0,
      message: t("core.network_unreachable"),
      retryable: true,
    });
  }

  const requestId = response.headers.get("x-request-id");
  if (response.status === 204) {
    return undefined as T;
  }
  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const envelope = (
      payload as {
        error?: { code?: unknown; message?: unknown; details?: unknown; retryable?: unknown };
      } | null
    )?.error;
    const code = typeof envelope?.code === "string" ? envelope.code : `HTTP_${response.status}`;
    if (UNAUTHENTICATED.has(code)) {
      window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT, { detail: code }));
    }
    throw new ApiError({
      code,
      status: response.status,
      message:
        typeof envelope?.message === "string" && envelope.message.length > 0
          ? envelope.message
          : t("core.request_failed", { code }),
      requestId,
      details: Array.isArray(envelope?.details) ? (envelope.details as readonly unknown[]) : [],
      retryable: envelope?.retryable === true,
    });
  }
  return payload as T;
}

export const apiGet = <T>(path: string): Promise<T> => apiRequest<T>("GET", path);

/** Human-readable failure text: the envelope message PLUS the normalized
 * validation details (code: message lines). The terse top message alone
 * ("failed seal validation with 1 error(s)") sent the owner investigating —
 * the issues were in the envelope all along (privacy-page locale case,
 * 2026-10-06). ORIGIN_EXPECTED additionally carries expected/got origins and
 * the server hint — the external-RP incident (152fz.p-os.ru, 2026-10-09)
 * showed the bare "cross-site origin rejected" sends operators journal-diving;
 * the values are plain React-rendered text (escaped by the framework). */
export function describeApiError(caught: unknown): string {
  if (!(caught instanceof ApiError)) {
    return caught instanceof Error && caught.message !== "" ? caught.message : String(caught);
  }
  const lines = caught.details.flatMap((detail) => {
    const d = detail as {
      readonly code?: unknown;
      readonly message?: unknown;
      readonly expected_origin?: unknown;
      readonly got_origin?: unknown;
      readonly hint?: unknown;
    };
    if (typeof d.message !== "string" || d.message === "") return [];
    const head = typeof d.code === "string" ? `${d.code}: ${d.message}` : d.message;
    if (d.code !== "ORIGIN_EXPECTED") return [head];
    const parts = [
      typeof d.expected_origin === "string" ? `expected origin: ${d.expected_origin}` : null,
      typeof d.got_origin === "string" ? `request origin: ${d.got_origin}` : null,
      typeof d.hint === "string" && d.hint !== "" ? d.hint : null,
    ].filter((part): part is string => part !== null);
    return [head, ...parts];
  });
  return lines.length === 0 ? caught.message : `${caught.message}\n${lines.join("\n")}`;
}

/** Raw octet-stream POST (manual release upload); same envelope handling. */
export const apiPostRaw = <T>(path: string, body: ArrayBuffer): Promise<T> =>
  apiRequest<T>("POST", path, { rawBody: body });
export const apiPost = <T>(path: string, body?: unknown): Promise<T> =>
  apiRequest<T>("POST", path, body === undefined ? {} : { body });
export const apiPatch = <T>(path: string, body: unknown): Promise<T> =>
  apiRequest<T>("PATCH", path, { body });
export const apiPut = <T>(path: string, body?: unknown): Promise<T> =>
  apiRequest<T>("PUT", path, body === undefined ? {} : { body });
export const apiDelete = <T>(path: string, body?: unknown): Promise<T> =>
  apiRequest<T>("DELETE", path, body === undefined ? {} : { body });
