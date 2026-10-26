// Remote CLI client for application operations (PCMS-API-T023/T024).
//
// Spec §17: "Remote/application CLI: service token". Mutating application
// commands run against a running CMS API over /api/v1 — one application
// layer, zero semantic divergence (API/MCP/CLI spec §0). The token arrives
// via the environment (PCMS_API_TOKEN), never argv (owner instruction #57);
// stable error codes map onto the §57 exit codes.
import {
  type CliCommandResult,
  exitCodeForError,
  failureResult,
  type GlobalOptions,
  jsonPayload,
} from "./framework.js";

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly json?: boolean;
  /** Site/environment binding for site-bound tokens (PCMS-OPS-T114). */
  readonly siteKey: string;
  readonly environment: string;
}

export function resolveApiClient(
  options: GlobalOptions,
  env: NodeJS.ProcessEnv,
): ApiClientOptions | string {
  const baseUrl = env["PCMS_API_URL"];
  const token = env["PCMS_API_TOKEN"];
  if (baseUrl === undefined || baseUrl.length === 0 || token === undefined || token.length === 0) {
    return "this command runs against a CMS API: set PCMS_API_URL and PCMS_API_TOKEN (token via environment, never argv)";
  }
  const siteKey = options.site ?? env["PCMS_SITE_KEY"];
  const environment = options.environment ?? env["PCMS_ENVIRONMENT"];
  if (!siteKey?.trim() || !environment?.trim()) {
    return "API requests require explicit context: set --site or PCMS_SITE_KEY and --environment or PCMS_ENVIRONMENT";
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    token,
    json: options.json,
    siteKey,
    environment,
  };
}

interface ApiEnvelope {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: unknown;
  };
}

/** Performs one API call and converts failures into CLI results. */
export async function apiCall(
  client: ApiClientOptions,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  requestOptions?: { readonly idempotencyKey: string },
): Promise<{ ok: true; status: number; body: unknown } | { ok: false; result: CliCommandResult }> {
  let response: Response;
  const binary = Buffer.isBuffer(body);
  try {
    response = await fetch(`${client.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${client.token}`,
        ...(requestOptions ? { "idempotency-key": requestOptions.idempotencyKey } : {}),
        "x-pcms-site": client.siteKey,
        "x-pcms-environment": client.environment,
        ...(body === undefined
          ? {}
          : { "content-type": binary ? "application/octet-stream" : "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: binary ? Uint8Array.from(body) : JSON.stringify(body) }),
    });
  } catch (error) {
    return {
      ok: false,
      result: {
        exitCode: 7,
        stdout: client.json
          ? jsonPayload({
              ok: false,
              error: { code: "API_UNAVAILABLE", message: "API unreachable" },
            })
          : "",
        stderr: `error: API unreachable: ${error instanceof Error ? error.message : String(error)}\n`,
      },
    };
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return {
      ok: false,
      result: failureResult(
        Object.assign(new Error("API response interrupted"), { code: "API_UNAVAILABLE" }),
        { json: client.json === true, yes: false },
      ),
    };
  }
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const envelope = (parsed ?? {}) as ApiEnvelope;
    const code = envelope.error?.code ?? "API_ERROR";
    const message = envelope.error?.message ?? `HTTP ${response.status}`;
    const synthetic = Object.assign(new Error(message), { code });
    return {
      ok: false,
      result: {
        exitCode:
          response.status === 401 || response.status === 403 ? 5 : exitCodeForError(synthetic),
        stdout: client.json
          ? jsonPayload({ ok: false, error: envelope.error ?? { code, message } })
          : "",
        stderr: `error: [${code}] ${message}\n`,
      },
    };
  }
  return { ok: true, status: response.status, body: parsed };
}

/**
 * One binary GET (theme export). Same credential/site/environment handling and
 * the same typed error surface as apiCall — the JSON path stays the default.
 */
export async function apiBinary(
  client: ApiClientOptions,
  path: string,
): Promise<
  | { ok: true; status: number; bytes: Buffer; headers: Headers }
  | { ok: false; result: CliCommandResult }
> {
  let response: Response;
  try {
    response = await fetch(`${client.baseUrl}/api/v1${path}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${client.token}`,
        "x-pcms-site": client.siteKey,
        "x-pcms-environment": client.environment,
      },
    });
  } catch (error) {
    return {
      ok: false,
      result: {
        exitCode: 7,
        stdout: client.json
          ? jsonPayload({
              ok: false,
              error: { code: "API_UNAVAILABLE", message: "API unreachable" },
            })
          : "",
        stderr: `error: API unreachable: ${error instanceof Error ? error.message : String(error)}\n`,
      },
    };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let envelope: ApiEnvelope = {};
    try {
      envelope = JSON.parse(text) as ApiEnvelope;
    } catch {
      envelope = {};
    }
    const code = envelope.error?.code ?? "API_ERROR";
    const message = envelope.error?.message ?? `HTTP ${response.status}`;
    return {
      ok: false,
      result: {
        exitCode: response.status === 401 || response.status === 403 ? 5 : 7,
        stdout: client.json
          ? jsonPayload({ ok: false, error: envelope.error ?? { code, message } })
          : "",
        stderr: `error: [${code}] ${message}\n`,
      },
    };
  }
  return {
    ok: true,
    status: response.status,
    bytes: Buffer.from(await response.arrayBuffer()),
    headers: response.headers,
  };
}

export function machineResult(payload: unknown, exitCode = 0): CliCommandResult {
  return { exitCode, stdout: jsonPayload(payload), stderr: "" };
}

export function humanResult(lines: readonly string[]): CliCommandResult {
  return { exitCode: 0, stdout: `${[...lines, ""].join("\n")}`, stderr: "" };
}

/** Aggregate bounded pages; a failed continuation always reports partial data. */
export async function collectPages(
  fetchPage: (limit: number, cursor: string | null) => ReturnType<typeof apiCall>,
  limit: number,
  cursor: string | null = null,
) {
  const items: Record<string, unknown>[] = [];
  const ids = new Set<unknown>();
  const cursors = new Set<string>();
  for (;;) {
    const response = await fetchPage(Math.min(100, limit - items.length), cursor);
    if (!response.ok)
      return { ok: false as const, result: response.result, items, next_cursor: cursor };
    const page = response.body as {
      items?: Record<string, unknown>[];
      next_cursor?: string | null;
      has_more?: boolean;
      total?: number;
    };
    if (!Array.isArray(page?.items) || (page.has_more === true && !page.next_cursor)) {
      return {
        ok: false as const,
        result: failureResult(
          Object.assign(new Error("invalid pagination response"), { code: "API_RESPONSE_INVALID" }),
          { json: true, yes: false },
        ),
        items,
        next_cursor: cursor,
      };
    }
    for (const item of page.items) {
      const id = item["id"] ?? item["entry_id"];
      if (!ids.has(id)) {
        ids.add(id);
        items.push(item);
      }
    }
    cursor = page.next_cursor ?? null;
    if (cursor === null || items.length >= limit) {
      return {
        ok: true as const,
        items,
        count: items.length,
        next_cursor: cursor,
        has_more: cursor !== null,
        complete: cursor === null,
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    }
    if (cursors.has(cursor) || page.items.length === 0) {
      const result = {
        exitCode: 7,
        stdout: jsonPayload({
          ok: false,
          error: { code: "API_PAGINATION_STALLED", message: "pagination did not advance" },
        }),
        stderr: "error: [API_PAGINATION_STALLED] pagination did not advance\n",
      };
      return { ok: false as const, result, items, next_cursor: cursor };
    }
    cursors.add(cursor);
  }
}

export function partialPageResult(page: {
  result: CliCommandResult;
  items: unknown[];
  next_cursor: string | null;
}): CliCommandResult {
  return {
    ...page.result,
    stdout: jsonPayload({
      ...(page.result.stdout ? JSON.parse(page.result.stdout) : { ok: false }),
      items: page.items,
      count: page.items.length,
      next_cursor: page.next_cursor,
      complete: false,
      partial: true,
    }),
  };
}
