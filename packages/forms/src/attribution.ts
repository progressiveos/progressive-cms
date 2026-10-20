// MKT-010 attribution snapshot (owner task): an immutable, allowlisted
// capture of WHERE an interaction came from. Client-declared, server-
// validated — never treated as proof of the advertising source. Rules:
//   - allowlisted keys only; unknown keys are ignored, values are never
//     echoed back into the snapshot;
//   - trim → empty becomes null → over-limit values are DROPPED (not
//     silently truncated, not turned into PII, never fatal to the contact);
//   - landing_path is a path only (/…, no query/fragment); referrer_host is
//     a bare host (no path/query/credentials);
//   - interaction_kind and form_key are server-set (the interaction kind and
//     the STABLE definition id — never a submission/run/lead id) and are not
//     affected by definition edits afterwards.

export const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

export type UtmKey = (typeof UTM_KEYS)[number];

export interface AttributionSnapshot {
  readonly interaction_kind: "form" | "quiz";
  readonly form_key: string;
  readonly utm_source: string | null;
  readonly utm_medium: string | null;
  readonly utm_campaign: string | null;
  readonly utm_content: string | null;
  readonly utm_term: string | null;
  readonly landing_path: string | null;
  readonly referrer_host: string | null;
}

const MAX_UTM_LENGTH = 120;
const MAX_LANDING_PATH_LENGTH = 500;
const MAX_REFERRER_HOST_LENGTH = 255;

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // HQ validates control characters on the RAW value before its own strip —
  // mirror that exactly, or a trimmed "clean-looking" value would still 422.
  if (/\p{Cc}/u.test(value)) return null;
  const text = value.trim();
  if (text === "" || text.length > max) return null;
  return text;
}

function landingPath(value: unknown): string | null {
  const path = boundedText(value, MAX_LANDING_PATH_LENGTH);
  // Path-only: must start with a single / and carry no query or fragment
  // (a leading // is a protocol-relative URL, not a path — HQ rejects it).
  if (
    path === null ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    return null;
  }
  return path;
}

function referrerHost(value: unknown): string | null {
  const host = boundedText(value, MAX_REFERRER_HOST_LENGTH);
  // Bare host: separators of path/query/fragment, credentials and ports are
  // all rejected rather than cleaned.
  if (host === null || /[/@?#:]/.test(host) || !/^[A-Za-z0-9._-]+$/.test(host)) {
    return null;
  }
  return host;
}

export function parseAttribution(
  raw: unknown,
  interactionKind: "form" | "quiz",
  definitionKey: string,
): AttributionSnapshot {
  const record: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const utm = {} as Record<UtmKey, string | null>;
  for (const key of UTM_KEYS) {
    utm[key] = boundedText(record[key], MAX_UTM_LENGTH);
  }
  return {
    interaction_kind: interactionKind,
    form_key: definitionKey,
    ...utm,
    landing_path: landingPath(record["landing_path"]),
    referrer_host: referrerHost(record["referrer_host"]),
  };
}
