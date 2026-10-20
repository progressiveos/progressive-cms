// IndexNow v1 core (Progressive_CMS_IndexNow_v1_Spec.md): typed settings,
// strict validation, key generation, delivery constants. The HTTP client and
// event wiring live in the composition (api/worker); this module owns the
// protocol facts so no other package ever learns the endpoint or key format.

import { randomBytes } from "node:crypto";

export const PACKAGE_INDEXNOW_NAME = "@pcms/seo.indexnow";

/** Single protocol endpoint — compile-time constant, never configurable
 * from Admin/REST/MCP (spec §4/§40: no SSRF surface). */
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
export const INDEXNOW_BATCH_LIMIT = 1000;
/** Cooldown after a successful submission of the same URL (spec §17). */
export const INDEXNOW_COOLDOWN_MS = 10 * 60_000;
/** Requeue delay after HTTP 202 (key awaiting verification) — never a
 * per-minute retry loop (spec §21). */
export const INDEXNOW_VERIFICATION_RETRY_MS = 30 * 60_000;
/** Per-URL attempt cap — bounded retry, then dropped with a diagnostic. */
export const INDEXNOW_MAX_ATTEMPTS = 8;
export const INDEXNOW_KEY_RE = /^[0-9a-f]{64}$/;

export type IndexNowReason =
  | "published"
  | "updated"
  | "unpublished"
  | "route_changed"
  | "rollback"
  | "verification";

export interface IndexNowSettings {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly key: string | null;
  readonly notifyOnPublish: boolean;
  readonly notifyOnUpdate: boolean;
  readonly notifyOnUnpublish: boolean;
  readonly notifyOnRouteChange: boolean;
}

export const DEFAULT_INDEXNOW_SETTINGS: IndexNowSettings = {
  schemaVersion: 1,
  enabled: false,
  key: null,
  notifyOnPublish: true,
  notifyOnUpdate: true,
  notifyOnUnpublish: true,
  notifyOnRouteChange: true,
};

export function generateIndexNowKey(): string {
  return randomBytes(32).toString("hex");
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Strict validation (unknown properties rejected); the absent row is the
 * DEFAULT (disabled) — nothing here can ever turn the feature on by itself. */
export function parseIndexNowSettings(input: unknown): IndexNowSettings {
  if (input === null || input === undefined) return { ...DEFAULT_INDEXNOW_SETTINGS };
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("INDEXNOW_SETTINGS_INVALID");
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (
      ![
        "schemaVersion",
        "enabled",
        "key",
        "notifyOnPublish",
        "notifyOnUpdate",
        "notifyOnUnpublish",
        "notifyOnRouteChange",
      ].includes(key)
    ) {
      throw new Error("INDEXNOW_SETTINGS_INVALID");
    }
  }
  if (record.schemaVersion !== 1) throw new Error("INDEXNOW_SETTINGS_INVALID");
  const key = record.key;
  if (
    key !== null &&
    key !== undefined &&
    (typeof key !== "string" || !INDEXNOW_KEY_RE.test(key))
  ) {
    throw new Error("INDEXNOW_KEY_INVALID");
  }
  return {
    schemaVersion: 1,
    enabled: boolOr(record.enabled, false),
    key: typeof key === "string" ? key : null,
    notifyOnPublish: boolOr(record.notifyOnPublish, true),
    notifyOnUpdate: boolOr(record.notifyOnUpdate, true),
    notifyOnUnpublish: boolOr(record.notifyOnUnpublish, true),
    notifyOnRouteChange: boolOr(record.notifyOnRouteChange, true),
  };
}

export type IndexNowState =
  | "Disabled"
  | "Configured"
  | "Awaiting verification"
  | "Operational"
  | "Rate limited"
  | "Configuration error"
  | "Delivery degraded"
  | "Suppressed by noindex";

/** URL admission (spec §20/§42): absolute https (production posture), no
 * credentials/query/tracking, single host match — malformed entries are
 * dropped by the planner BEFORE any network call. */
export function indexNowUrlIssue(url: string, host: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "INDEXNOW_URL_INVALID";
  }
  if (parsed.protocol !== "https:") return "INDEXNOW_URL_INVALID";
  if (parsed.username !== "" || parsed.password !== "") return "INDEXNOW_URL_INVALID";
  if (parsed.search !== "") return "INDEXNOW_URL_INVALID";
  if (parsed.hostname.toLowerCase() !== host.toLowerCase()) return "INDEXNOW_URL_HOST_MISMATCH";
  return null;
}
