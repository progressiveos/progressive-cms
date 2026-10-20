// robots.txt generation (PCMS-SEO-T020; SEO spec §14).
// Crawling policy only — a Disallow here is not a noindex and never a
// security boundary (spec §12/§30 semantics are kept apart). The policy is
// typed: admins cannot inject arbitrary syntax; generated output is
// deterministic with the Sitemap directive derived from the sitemap URL.
import { SeoError } from "./errors.js";

export interface RobotsTxtRule {
  readonly user_agent: string;
  readonly allow: readonly string[];
  readonly disallow: readonly string[];
}

export interface RobotsTxtPolicy {
  readonly rules: readonly RobotsTxtRule[];
  /** Absolute sitemap.xml URL when the site generates a sitemap (§14). */
  readonly sitemap_url: string | null;
}

/** Baseline reserved paths (§14): admin/API/private namespaces stay unscanned. */
export const RESERVED_ROBOTS_PATHS = ["/admin/", "/api/", "/mcp/"] as const;

const UA_BOUND = 64;
const PATH_BOUND = 2048;

function assertPath(value: string, field: string): string {
  if (
    value.length === 0 ||
    value.length > PATH_BOUND ||
    !value.startsWith("/") ||
    /\s/.test(value) ||
    /[\p{Cc}<>"]/u.test(value)
  ) {
    throw new SeoError("SEO_ROBOTS_TXT_INVALID", `invalid robots.txt ${field}`, {
      details: { path: value },
    });
  }
  return value;
}

/** Validates untrusted input into the typed policy or throws. */
export function parseRobotsTxtPolicy(raw: unknown): RobotsTxtPolicy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SeoError("SEO_ROBOTS_TXT_INVALID", "robots.txt policy must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.rules)) {
    throw new SeoError("SEO_ROBOTS_TXT_INVALID", "rules must be an array");
  }
  const rules: RobotsTxtRule[] = [];
  for (const rawRule of record.rules) {
    if (typeof rawRule !== "object" || rawRule === null) {
      throw new SeoError("SEO_ROBOTS_TXT_INVALID", "rule must be an object");
    }
    const r = rawRule as Record<string, unknown>;
    const userAgent = r.user_agent;
    if (
      typeof userAgent !== "string" ||
      userAgent.length === 0 ||
      userAgent.length > UA_BOUND ||
      /\s/.test(userAgent)
    ) {
      throw new SeoError("SEO_ROBOTS_TXT_INVALID", "invalid user_agent", {
        details: { userAgent },
      });
    }
    const list = (value: unknown, field: string): string[] => {
      if (value === undefined || value === null) return [];
      if (!Array.isArray(value)) {
        throw new SeoError("SEO_ROBOTS_TXT_INVALID", `${field} must be an array of paths`);
      }
      return value.map((p) => {
        if (typeof p !== "string")
          throw new SeoError("SEO_ROBOTS_TXT_INVALID", `${field} entries must be strings`);
        return assertPath(p, field);
      });
    };
    const allow = list(r.allow, "allow");
    const disallow = list(r.disallow, "disallow");
    if (allow.length === 0 && disallow.length === 0) {
      throw new SeoError(
        "SEO_ROBOTS_TXT_INVALID",
        "rule needs at least one allow/disallow directive",
      );
    }
    rules.push({ user_agent: userAgent, allow, disallow });
  }
  let sitemap_url: string | null = null;
  if (record.sitemap_url != null) {
    if (typeof record.sitemap_url !== "string" || !/^https?:\/\//i.test(record.sitemap_url)) {
      throw new SeoError("SEO_ROBOTS_TXT_INVALID", "sitemap_url must be an absolute http(s) URL");
    }
    sitemap_url = record.sitemap_url;
  }
  return { rules, sitemap_url };
}

/** Baseline policy for a site: reserved namespaces + the generated sitemap. */
export function defaultRobotsTxtPolicy(input: {
  readonly sitemapUrl: string | null;
  readonly includeReservedPaths?: boolean;
}): RobotsTxtPolicy {
  const includeReserved = input.includeReservedPaths !== false;
  return {
    rules: includeReserved
      ? [{ user_agent: "*", allow: [], disallow: [...RESERVED_ROBOTS_PATHS] }]
      : [],
    sitemap_url: input.sitemapUrl,
  };
}

/** Deterministic robots.txt rendering; ends with a newline. */
export function renderRobotsTxt(policy: RobotsTxtPolicy): string {
  const lines: string[] = [];
  for (const rule of policy.rules) {
    lines.push(`User-agent: ${rule.user_agent}`);
    for (const path of rule.allow) lines.push(`Allow: ${path}`);
    for (const path of rule.disallow) lines.push(`Disallow: ${path}`);
    lines.push("");
  }
  if (policy.sitemap_url != null) lines.push(`Sitemap: ${policy.sitemap_url}`);
  return `${lines.join("\n")}\n`;
}
