// Strict settings validation (Analytics spec §4/§7). Unknown properties are
// rejected everywhere (ADR-0004 posture); provider IDs follow strict
// patterns; network rules are a controlled https-origin allowlist.

import {
  ACTIVATION_POLICIES,
  type AnalyticsNetworkRule,
  type AnalyticsSettings,
  DEFAULT_GA4,
  DEFAULT_GTM,
  DEFAULT_METRICA,
  defaultAnalyticsSettings,
  GA4_ID_RE,
  GTM_ID_RE,
  METRICA_ID_RE,
  NETWORK_DIRECTIVES,
} from "./types.js";

export class AnalyticsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Controlled origin validation (spec §7): https only; the wildcard may be
 * exactly one leftmost subdomain label; no credentials, no query, no
 * `javascript:`, no CSP expression tokens, no `blob:`/`data:` from users.
 */
export function validateAnalyticsOrigin(origin: string): string | null {
  if (typeof origin !== "string") return "origin must be a string";
  if (!origin.startsWith("https://")) return "only https:// origins are allowed";
  if (origin.length > 253) return "origin is too long";
  const rest = origin.slice("https://".length);
  if (rest === "" || rest.includes("/") || rest.includes("?") || rest.includes("#")) {
    return "origin must be scheme + host only (no path/query)";
  }
  if (rest.includes("@") || rest.includes(":")) {
    return "credentials and ports are not allowed in network rules";
  }
  const labels = rest.split(".");
  if (labels.some((label) => label === "")) return "empty host label";
  if (rest === "*") return "bare wildcard is not allowed";
  for (const [index, label] of labels.entries()) {
    if (label === "*") {
      if (index !== 0 || labels.length < 3) {
        return "wildcard allowed only as the leftmost subdomain label";
      }
      continue;
    }
    if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) {
      return `invalid host label "${label}"`;
    }
  }
  return null;
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AnalyticsError("ANALYTICS_SETTINGS_INVALID", `${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[], what: string) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new AnalyticsError("ANALYTICS_SETTINGS_INVALID", `${what}: unknown property "${key}"`);
    }
  }
}

function boolOr(value: unknown, fallback: boolean, what: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new AnalyticsError("ANALYTICS_SETTINGS_INVALID", `${what} must be a boolean`);
  }
  return value;
}

function policyOr(value: unknown, what: string): (typeof ACTIVATION_POLICIES)[number] {
  if (value === undefined) return "immediate";
  if (typeof value !== "string" || !ACTIVATION_POLICIES.includes(value as never)) {
    throw new AnalyticsError("ANALYTICS_SETTINGS_INVALID", `${what} has an invalid policy`);
  }
  return value as (typeof ACTIVATION_POLICIES)[number];
}

function stringOrNull(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new AnalyticsError("ANALYTICS_SETTINGS_INVALID", `${what} must be a string`);
  }
  return value;
}

/** Validates and normalizes full settings; throws typed AnalyticsError. */
export function validateAnalyticsSettings(input: unknown): AnalyticsSettings {
  const root = asObject(input, "settings");
  rejectUnknown(root, ["schemaVersion", "providers", "networkRules"], "settings");
  if (root.schemaVersion !== 1) {
    throw new AnalyticsError("ANALYTICS_SETTINGS_INVALID", "schemaVersion must be 1");
  }
  const providers = asObject(root.providers ?? {}, "providers");
  rejectUnknown(
    providers,
    ["yandex_metrica", "google_analytics_4", "google_tag_manager"],
    "providers",
  );

  // Yandex Metrica.
  const metricaRaw = asObject(providers.yandex_metrica ?? {}, "yandex_metrica");
  rejectUnknown(
    metricaRaw,
    [
      "enabled",
      "counterId",
      "webvisor",
      "clickmap",
      "trackLinks",
      "accurateTrackBounce",
      "ecommerce",
      "sendTitle",
      "debugMode",
      "activationPolicy",
    ],
    "yandex_metrica",
  );
  const counterId = stringOrNull(metricaRaw.counterId, "yandex_metrica.counterId");
  if (counterId !== null && !METRICA_ID_RE.test(counterId)) {
    throw new AnalyticsError("YANDEX_COUNTER_ID_INVALID", "counter id must be 6-12 digits");
  }
  const metrica: AnalyticsSettings["providers"]["yandex_metrica"] = {
    enabled: boolOr(metricaRaw.enabled, false, "yandex_metrica.enabled"),
    counterId,
    webvisor: boolOr(metricaRaw.webvisor, DEFAULT_METRICA.webvisor, "yandex_metrica.webvisor"),
    clickmap: boolOr(metricaRaw.clickmap, DEFAULT_METRICA.clickmap, "yandex_metrica.clickmap"),
    trackLinks: boolOr(
      metricaRaw.trackLinks,
      DEFAULT_METRICA.trackLinks,
      "yandex_metrica.trackLinks",
    ),
    accurateTrackBounce: boolOr(
      metricaRaw.accurateTrackBounce,
      DEFAULT_METRICA.accurateTrackBounce,
      "yandex_metrica.accurateTrackBounce",
    ),
    ecommerce: boolOr(metricaRaw.ecommerce, DEFAULT_METRICA.ecommerce, "yandex_metrica.ecommerce"),
    sendTitle: boolOr(metricaRaw.sendTitle, DEFAULT_METRICA.sendTitle, "yandex_metrica.sendTitle"),
    debugMode: boolOr(metricaRaw.debugMode, DEFAULT_METRICA.debugMode, "yandex_metrica.debugMode"),
    activationPolicy: policyOr(metricaRaw.activationPolicy, "yandex_metrica"),
  };
  if (metrica.enabled && counterId === null) {
    throw new AnalyticsError("YANDEX_COUNTER_ID_INVALID", "enabled metrica needs a counter id");
  }

  // GA4.
  const ga4Raw = asObject(providers.google_analytics_4 ?? {}, "google_analytics_4");
  rejectUnknown(ga4Raw, ["enabled", "measurementId", "activationPolicy"], "google_analytics_4");
  const measurementId = stringOrNull(ga4Raw.measurementId, "google_analytics_4.measurementId");
  if (measurementId !== null && !GA4_ID_RE.test(measurementId)) {
    throw new AnalyticsError(
      "GA4_MEASUREMENT_ID_INVALID",
      "measurement id must match G-[A-Z0-9]+ (GTM container ids belong to the GTM provider)",
    );
  }
  const ga4: AnalyticsSettings["providers"]["google_analytics_4"] = {
    enabled: boolOr(ga4Raw.enabled, false, "google_analytics_4.enabled"),
    measurementId,
    activationPolicy: policyOr(ga4Raw.activationPolicy, "google_analytics_4"),
  };
  if (ga4.enabled && measurementId === null) {
    throw new AnalyticsError("GA4_MEASUREMENT_ID_INVALID", "enabled GA4 needs a measurement id");
  }

  // GTM.
  const gtmRaw = asObject(providers.google_tag_manager ?? {}, "google_tag_manager");
  rejectUnknown(
    gtmRaw,
    ["enabled", "containerId", "debugMode", "activationPolicy"],
    "google_tag_manager",
  );
  const containerId = stringOrNull(gtmRaw.containerId, "google_tag_manager.containerId");
  if (containerId !== null && !GTM_ID_RE.test(containerId)) {
    throw new AnalyticsError("GTM_CONTAINER_ID_INVALID", "container id must match GTM-[A-Z0-9]+");
  }
  const gtm: AnalyticsSettings["providers"]["google_tag_manager"] = {
    enabled: boolOr(gtmRaw.enabled, false, "google_tag_manager.enabled"),
    containerId,
    debugMode: boolOr(gtmRaw.debugMode, DEFAULT_GTM.debugMode, "google_tag_manager.debugMode"),
    activationPolicy: policyOr(gtmRaw.activationPolicy, "google_tag_manager"),
  };
  if (gtm.enabled && containerId === null) {
    throw new AnalyticsError("GTM_CONTAINER_ID_INVALID", "enabled GTM needs a container id");
  }

  // Network rules.
  const rulesRaw = root.networkRules;
  if (rulesRaw !== undefined && !Array.isArray(rulesRaw)) {
    throw new AnalyticsError("ANALYTICS_SETTINGS_INVALID", "networkRules must be an array");
  }
  const networkRules: AnalyticsNetworkRule[] = [];
  const seen = new Set<string>();
  for (const raw of rulesRaw ?? []) {
    const rule = asObject(raw, "networkRules[]");
    rejectUnknown(rule, ["id", "label", "origin", "directives"], "networkRules[]");
    const id = rule.id;
    if (typeof id !== "string" || !ID_RE.test(id)) {
      throw new AnalyticsError("ANALYTICS_CSP_ORIGIN_INVALID", "rule id is invalid");
    }
    if (seen.has(id)) {
      throw new AnalyticsError("ANALYTICS_SETTINGS_INVALID", `duplicate network rule "${id}"`);
    }
    seen.add(id);
    const origin = rule.origin;
    if (typeof origin !== "string") {
      throw new AnalyticsError("ANALYTICS_CSP_ORIGIN_INVALID", "rule origin must be a string");
    }
    const originIssue = validateAnalyticsOrigin(origin);
    if (originIssue !== null) {
      throw new AnalyticsError("ANALYTICS_CSP_ORIGIN_INVALID", originIssue);
    }
    const directives = rule.directives;
    if (!Array.isArray(directives) || directives.length === 0) {
      throw new AnalyticsError("ANALYTICS_SETTINGS_INVALID", "rule needs at least one directive");
    }
    for (const directive of directives) {
      if (!NETWORK_DIRECTIVES.includes(directive as never)) {
        throw new AnalyticsError(
          "ANALYTICS_CSP_UNSAFE_SOURCE_REJECTED",
          `directive "${String(directive)}" is not allowed`,
        );
      }
    }
    networkRules.push({
      id,
      ...(typeof rule.label === "string" && rule.label !== "" ? { label: rule.label } : {}),
      origin,
      directives: [...directives] as AnalyticsNetworkRule["directives"],
    });
  }

  return {
    schemaVersion: 1,
    providers: { yandex_metrica: metrica, google_analytics_4: ga4, google_tag_manager: gtm },
    networkRules,
  };
}

export { defaultAnalyticsSettings };
