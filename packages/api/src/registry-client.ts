// Registry client (Community Registry v1 plan §4): talks to the artifact
// repository (skills/extensions/engine releases). SSRF-guarded fetch with a
// short timeout; the account token arrives through the resolved secrets map
// (secret slot "registry.token"), never through config.

import type { ResolvedSecrets } from "@pcms/core";

export interface RegistryPackageSummary {
  readonly id: string;
  readonly kind: "skill" | "extension" | "theme";
  readonly version: string;
  readonly summary: string;
  readonly author: string;
  readonly price: string | null;
  readonly check: "pending" | "approved" | "rejected";
  readonly updated: string;
  readonly download_url: string | null;
}

export interface RegistryRelease {
  readonly version: string;
  readonly artifact: string;
  readonly sha256: string;
  readonly notes: string;
}

export interface RegistryIndex {
  readonly packages: readonly RegistryPackageSummary[];
  readonly releases: readonly RegistryRelease[];
}

export class RegistryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "RegistryError";
  }
}

export interface RegistryClient {
  readonly baseUrl: string | null;
  readonly configured: boolean;
  index(): Promise<RegistryIndex>;
  packageCard(id: string): Promise<Record<string, unknown>>;
  /** Raw bytes of an approved package (the install path streams them into
   * the existing fail-closed installer unchanged). */
  download(downloadUrl: string): Promise<Buffer>;
  /** Engine release artifact bytes (sha256-verified by the caller). */
  downloadRelease(release: RegistryRelease): Promise<Buffer>;
  /**
   * Instance identity (2026-09-29, owner design): PCMS generates an
   * unguessable instance code, the operator binds it to his registry
   * account once (Admin modal, credentials used transiently and never
   * stored), and updates report per-instance download notices.
   */
  /** Registry v2 binding (two-phase claim): confirm the owner's pending
   * claim; returns the per-instance token to store. Last confirm wins. */
  confirmInstance(instanceCode: string): Promise<{ token: string; account_email: string }>;
  confirmStatus(instanceCode: string): Promise<{ status: string; account_email?: string }>;
  /** Best-effort delivery contract: failures are the caller's concern. */
  report(instanceCode: string, markdown: string): Promise<void>;
  /** Best-effort per-instance update telemetry (no-op unless registered). */
  noticeDownload(instanceCode: string, version: string): Promise<void>;
}

const TIMEOUT_MS = 15_000;
// The signal covers headers AND body; a release download of the full 128 MiB
// budget must still complete on a modest link.
const DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_BYTES = 48 * 1024 * 1024;
// The registry publish cap (my-pcms) is 128 MB — the download and manual
// upload caps must track it, or every artifact the registry accepts fails
// the instance-side update with REGISTRY_PACKAGE_TOO_LARGE (releases grew
// to ~85 MiB with the materialized first-party extension payload;
// 152fz incident 2026-10-10). Exported so the REST route bodyLimit uses the
// same number.
export const RELEASE_ARTIFACT_MAX_BYTES = 128 * 1024 * 1024;

export function createRegistryClient(options: {
  readonly baseUrl?: string;
  readonly secrets?: ResolvedSecrets;
  /** Instance-bound token (registry v2 binding). Preferred over the account
   * token; resolved per request so a fresh binding works without a restart. */
  readonly resolveInstanceToken?: () => Promise<string | null>;
  /** Account token resolved PER REQUEST (Admin-managed runtime secret or the
   * boot-time file/env secret "registry.token"). The registry catalog only
   * accepts account principals — without this slot the catalog 401s forever,
   * even with a healthy instance binding. */
  readonly resolveAccountToken?: () => Promise<string | null>;
}): RegistryClient {
  const baseUrl = options.baseUrl ?? null;
  const fileToken = options.secrets?.get("registry.token") ?? null;

  const requireBaseUrl = (): string => {
    if (baseUrl === null || baseUrl.length === 0) {
      throw new RegistryError("REGISTRY_NOT_CONFIGURED", "registry.baseUrl is not configured");
    }
    return baseUrl;
  };

  async function guardedRead<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (cause) {
      throw new RegistryError(
        "REGISTRY_UNREACHABLE",
        `registry unreachable: ${(cause as Error).message}`,
      );
    }
  }

  async function guardedFetch(
    url: string,
    init?: RequestInit,
    timeoutMs = TIMEOUT_MS,
  ): Promise<Response> {
    // Operator-pinned URL; refuse redirects. The signal covers headers AND body.
    const response = await guardedRead(() =>
      fetch(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
    if (response.status >= 300 && response.status < 400) {
      throw new RegistryError(
        "REGISTRY_REDIRECT_REFUSED",
        "registry redirected — pinned URL required",
      );
    }
    return response;
  }

  /** Instance token first, then the per-request account token, then the
   * boot-time file/env secret. Some endpoints (catalog index) reject
   * instance tokens by design — `authWithFallback` retries downward. */
  async function resolveToken(): Promise<string | null> {
    const instance = (await options.resolveInstanceToken?.()) ?? null;
    if (instance !== null) return instance;
    return (await options.resolveAccountToken?.()) ?? fileToken;
  }

  /** Which credential class answered last — 401 diagnostics must NAME it
   * (2026-10-05 incident: "HTTP 401" with no hint sent the owner chasing
   * the wrong token). NOTE: the catalog endpoints reject instance tokens BY
   * DESIGN (account principals only) — a catalog 401 is always about the
   * ACCOUNT credential, never a rebind; "rebind" is the remedy for
   * instance-token-required endpoints (report) handled at their call sites. */
  let lastTokenClass: "instance" | "account" | "none" = "none";

  async function authWithFallback(
    path: string,
  ): Promise<{ token: string | null; response: Response }> {
    const instance = (await options.resolveInstanceToken?.()) ?? null;
    lastTokenClass = instance === null ? "none" : "instance";
    const first = await guardedFetch(`${baseUrl}${path}`, {
      headers: {
        accept: "application/json",
        ...(instance === null ? {} : { authorization: `Bearer ${instance}` }),
      },
    });
    if (first.status !== 401) {
      return { token: instance, response: first };
    }
    const account = (await options.resolveAccountToken?.()) ?? fileToken;
    if (account === null || account === instance) {
      // No account credential to retry with — the account token IS the
      // missing piece; naming the instance attempt here sent the owner into
      // a pointless rebind loop (2026-10-05 follow-up).
      lastTokenClass = "none";
      return { token: instance, response: first };
    }
    // Instance token rejected (or lacks this surface) → account token retry.
    lastTokenClass = "account";
    const second = await guardedFetch(`${baseUrl}${path}`, {
      headers: { accept: "application/json", authorization: `Bearer ${account}` },
    });
    return { token: account, response: second };
  }

  function unauthorizedMessage(path: string): string {
    const why =
      lastTokenClass === "account"
        ? "account token rejected — set a fresh registry account token (Admin → Skills → Registry → Токен аккаунта реестра; the token comes from the my.p-cms.ru account area)"
        : "no registry account token — paste one in Admin → Skills → Registry → Токен аккаунта реестра (the account area issues it; the instance binding alone does not open the catalog)";
    return `registry ${path} HTTP 401: ${why}`;
  }

  async function fetchJson(path: string): Promise<Record<string, unknown>> {
    if (baseUrl === null)
      throw new RegistryError("REGISTRY_NOT_CONFIGURED", "registry.baseUrl is not set");
    const { response } = await authWithFallback(path);
    if (!response.ok) {
      throw new RegistryError(
        response.status === 401 ? "REGISTRY_UNAUTHORIZED" : "REGISTRY_UNREACHABLE",
        response.status === 401
          ? unauthorizedMessage(path)
          : `registry ${path} HTTP ${response.status}`,
      );
    }
    return (await guardedRead(() => response.json())) as Record<string, unknown>;
  }

  async function fetchBytes(url: string, cap = MAX_BYTES, timeoutMs = TIMEOUT_MS): Promise<Buffer> {
    const token = await resolveToken();
    const response = await guardedFetch(
      url,
      { headers: token === null ? {} : { authorization: `Bearer ${token}` } },
      timeoutMs,
    );
    if (!response.ok) {
      throw new RegistryError("REGISTRY_UNREACHABLE", `registry download HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > cap) {
      throw new RegistryError("REGISTRY_PACKAGE_TOO_LARGE", `download over ${cap} bytes`);
    }
    const bytes = Buffer.from(await guardedRead(() => response.arrayBuffer()));
    if (bytes.byteLength > cap) {
      throw new RegistryError("REGISTRY_PACKAGE_TOO_LARGE", `download over ${cap} bytes`);
    }
    return bytes;
  }

  return {
    baseUrl,
    configured: baseUrl !== null,
    async index() {
      const body = await fetchJson("/api/v1/index.json");
      return {
        packages: Array.isArray(body.packages) ? (body.packages as RegistryPackageSummary[]) : [],
        releases: Array.isArray(body.releases) ? (body.releases as RegistryRelease[]) : [],
      };
    },
    async packageCard(id) {
      return fetchJson(`/api/v1/packages/${encodeURIComponent(id)}`);
    },
    async download(downloadUrl) {
      return fetchBytes(downloadUrl, 2 * 1024 * 1024);
    },
    async downloadRelease(release) {
      const artifactUrl = release.artifact.startsWith("http")
        ? release.artifact
        : baseUrl === null
          ? release.artifact
          : `${baseUrl}${release.artifact}`;
      return fetchBytes(artifactUrl, RELEASE_ARTIFACT_MAX_BYTES, DOWNLOAD_TIMEOUT_MS);
    },
    /** Registry v2 binding, phase 2: the instance confirms the pending claim
     * created by the owner in the registry account area (public endpoint, rate-limited there).
     * Last confirm wins — the previous token is revoked server-side. */
    async confirmInstance(instanceCode: string): Promise<{ token: string; account_email: string }> {
      const base = requireBaseUrl();
      const response = await guardedFetch(`${base}/api/v1/instances/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance_code: instanceCode }),
      });
      if (response.status === 404) {
        throw new RegistryError(
          "REGISTRY_CODE_UNKNOWN",
          "registry does not know this instance code",
        );
      }
      if (response.status === 409) {
        throw new RegistryError("REGISTRY_NOT_PENDING", "no pending claim for this instance code");
      }
      if (!response.ok) {
        throw new RegistryError(
          "REGISTRY_REQUEST_FAILED",
          `instance confirm failed (HTTP ${response.status})`,
        );
      }
      const body = (await guardedRead(() => response.json())) as {
        token?: string;
        account_email?: string;
      };
      if (typeof body.token !== "string" || body.token.length === 0) {
        throw new RegistryError("REGISTRY_REQUEST_FAILED", "confirm returned no token");
      }
      return { token: body.token, account_email: body.account_email ?? "" };
    },
    async confirmStatus(instanceCode: string): Promise<{ status: string; account_email?: string }> {
      const base = requireBaseUrl();
      const response = await guardedFetch(
        `${base}/api/v1/instances/confirm-status?instance_code=${encodeURIComponent(instanceCode)}`,
      );
      if (!response.ok) return { status: "unknown" };
      const body = (await guardedRead(() => response.json())) as {
        status?: string;
        account_email?: string;
      };
      return {
        status: typeof body.status === "string" ? body.status : "unknown",
        ...(typeof body.account_email === "string" ? { account_email: body.account_email } : {}),
      };
    },
    /** Post-update agent report (markdown), consent-gated by the caller.
     * Best-effort at the call site; 401 means the instance token was
     * revoked — the Admin shows the rebind hint. */
    async report(_instanceCode: string, markdown: string): Promise<void> {
      const base = requireBaseUrl();
      const token = await resolveToken();
      if (token === null) {
        throw new RegistryError("REGISTRY_NOT_CONFIGURED", "no registry token to report with");
      }
      // Contract path (REGISTRY-INSTANCES-V2 §4): the instance is identified
      // by the Bearer instance token — no code in the URL.
      const response = await guardedFetch(`${base}/api/v1/instances/report`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "text/markdown; charset=utf-8",
        },
        body: markdown,
      });
      if (response.status === 401) {
        throw new RegistryError(
          "REGISTRY_UNAUTHORIZED",
          unauthorizedMessage("/api/v1/instances/report"),
        );
      }
      if (!response.ok && response.status !== 404) {
        throw new RegistryError(
          "REGISTRY_REQUEST_FAILED",
          `report upload failed (HTTP ${response.status})`,
        );
      }
    },
    async noticeDownload(instanceCode, version) {
      const base = requireBaseUrl();
      const token = await resolveToken();
      if (token === null) return; // telemetry is best-effort, never required
      const response = await guardedFetch(
        `${base}/api/v1/instances/${encodeURIComponent(instanceCode)}/download-notice`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ version }),
        },
      );
      if (!response.ok && response.status !== 404) {
        throw new RegistryError(
          "REGISTRY_REQUEST_FAILED",
          `download notice failed (HTTP ${response.status})`,
        );
      }
    },
  };
}
