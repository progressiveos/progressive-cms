import { parseSeoMediaRef, type SeoMediaRef } from "./document.js";
import { SeoError } from "./errors.js";
import type { SiteSeoDefaults } from "./fallback.js";

export interface SeoAddressFacts {
  readonly street_address?: string;
  readonly locality?: string;
  readonly region?: string;
  readonly postal_code?: string;
  readonly country?: string;
}

/** Verification method (spec §65): meta tag on the homepage (default for
 * records predating the field) or a provider-generated root HTML file. */
export type SeoVerificationMethod = "meta" | "file";

export interface SeoVerificationFile {
  /** Provider-generated root filename, e.g. google1a2b….html. */
  readonly filename: string;
  /** Provider-required file body, preserved exactly as validated. */
  readonly body: string;
}

/** Typed verification providers (spec §65) — no raw <head> textarea. */
export interface SeoVerificationEntry {
  readonly provider: "google" | "yandex" | "other";
  /** Verification token. Meta inputs may paste the provider tag itself —
   * strictly parsed to the token (never stored as HTML). */
  readonly content: string;
  readonly label?: string;
  readonly method?: SeoVerificationMethod;
  readonly file?: SeoVerificationFile;
}

/** Explicit LocalBusiness facts (spec §34): only emitted when declared. */
export interface SeoLocalBusinessFacts {
  readonly subtype?: string;
  readonly telephone?: string;
  readonly opening_hours?: string;
  readonly geo?: { readonly latitude: number; readonly longitude: number };
}

export interface SeoSiteIdentity {
  readonly site_name: string;
  readonly alternate_site_name?: string | null;
  readonly legal_name?: string | null;
  readonly organization_type?: "Organization" | "LocalBusiness" | null;
  readonly logo?: SeoMediaRef | null;
  readonly favicon?: SeoMediaRef | null;
  readonly default_social_image?: SeoMediaRef | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly address?: SeoAddressFacts | null;
  /** sameAs profiles — absolute http(s) URLs only. */
  readonly social_profiles?: readonly string[];
  /** Optional title pattern "{page_title} — {site_name}" (§64). */
  readonly title_pattern?: string | null;
  readonly allow_intro_description_fallback?: boolean;
  readonly article_content_types?: readonly string[];
  readonly local_business?: SeoLocalBusinessFacts | null;
  readonly verification?: readonly SeoVerificationEntry[];
}

interface RawIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

const IDENTITY_KEYS = new Set([
  "site_name",
  "alternate_site_name",
  "legal_name",
  "organization_type",
  "logo",
  "favicon",
  "default_social_image",
  "phone",
  "email",
  "address",
  "social_profiles",
  "title_pattern",
  "allow_intro_description_fallback",
  "article_content_types",
  "local_business",
  "verification",
]);

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** One-line printable string, trimmed and bounded; null when absent/invalid. */
function clean(value: unknown, path: string, issues: RawIssue[], bound = 500): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return invalid(path);
  const text = value.replace(/[\t\n\r]/g, " ").trim();
  if (text === "" || text.length > bound) return invalid(path);
  return text;

  function invalid(p: string): undefined {
    issues.push({ code: "SEO_SETTINGS_INVALID", path: p, message: "invalid or oversized value" });
    return undefined;
  }
}

function optionalMedia(raw: unknown, path: string, issues: RawIssue[]): SeoMediaRef | undefined {
  const ref = parseSeoMediaRef(raw, path, issues);
  return ref === null ? undefined : ref;
}

/** Recognized provider meta tags — a pasted tag is strictly parsed to its
 * token; any other HTML-shaped input is rejected (no arbitrary <head> HTML). */
const PROVIDER_META_TAGS: Readonly<
  Record<Exclude<SeoVerificationEntry["provider"], "other">, readonly [string, RegExp]>
> = {
  google: [
    "google-site-verification",
    /^<meta\s+name\s*=\s*["']google-site-verification["']\s+content\s*=\s*["']([^"']+)["']\s*\/?>$/i,
  ],
  yandex: [
    "yandex-verification",
    /^<meta\s+name\s*=\s*["']yandex-verification["']\s+content\s*=\s*["']([^"']+)["']\s*\/?>$/i,
  ],
};

/** Provider-generated root file contracts (checked against the providers'
 * official verification docs 2026-10-18). The filename/body templates make
 * active content (scripts, event handlers) structurally impossible. */
const PROVIDER_FILES: Readonly<
  Record<
    Exclude<SeoVerificationEntry["provider"], "other">,
    readonly [RegExp, (token: string) => string]
  >
> = {
  // google<16 hex>.html containing exactly "google-site-verification: <token>".
  google: [/^google[0-9a-f]{16}\.html$/, (token) => `google-site-verification: ${token}`],
  // yandex_<16 hex>.html containing exactly the verification code.
  yandex: [/^yandex_[0-9a-f]{16}\.html$/, (token) => token],
};

/** Validates one verification entry; null pushes issues and drops the entry. */
function parseVerificationEntry(raw: unknown, index: number): SeoVerificationEntry | null {
  const issues: RawIssue[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push({
      code: "SEO_SETTINGS_INVALID",
      path: `/verification/${index}`,
      message: "must be an object",
    });
    throwSeoIssues(issues);
  }
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!["provider", "content", "label", "method", "file"].includes(key)) {
      issues.push({
        code: "SEO_SETTINGS_INVALID",
        path: `/verification/${index}/${key}`,
        message: "unknown field",
      });
    }
  }
  const provider =
    entry.provider === "google" || entry.provider === "yandex" || entry.provider === "other"
      ? entry.provider
      : undefined;
  if (provider === undefined) {
    issues.push({
      code: "SEO_SETTINGS_INVALID",
      path: `/verification/${index}/provider`,
      message: "unknown provider",
    });
  }
  const method =
    entry.method === undefined || entry.method === null
      ? "meta"
      : entry.method === "meta" || entry.method === "file"
        ? entry.method
        : undefined;
  if (method === undefined) {
    issues.push({
      code: "SEO_SETTINGS_INVALID",
      path: `/verification/${index}/method`,
      message: 'method must be "meta" or "file"',
    });
  }
  const label = clean(entry.label, `/verification/${index}/label`, issues, 100);

  if (provider !== undefined && method !== undefined) {
    // Content: a token, or one recognized provider meta tag parsed to the
    // token (meta paste convenience; never stored as HTML).
    let content =
      typeof entry.content === "string" ? entry.content.replace(/[\t\n\r]/g, " ").trim() : "";
    if (content.length > 512) {
      issues.push({
        code: "SEO_SETTINGS_INVALID",
        path: `/verification/${index}/content`,
        message: "invalid or oversized value",
      });
      content = "";
    }
    if (content.startsWith("<")) {
      if (provider === "other") {
        issues.push({
          code: "SEO_SETTINGS_INVALID",
          path: `/verification/${index}/content`,
          message: 'markup is not accepted for provider "other"; enter the token',
        });
      } else {
        const [, tagRe] = PROVIDER_META_TAGS[provider];
        const match = tagRe.exec(content);
        const token = match?.[1]?.trim();
        if (token === undefined || token === "") {
          issues.push({
            code: "SEO_SETTINGS_INVALID",
            path: `/verification/${index}/content`,
            message: `not a recognized ${provider} meta tag; enter the verification token`,
          });
        } else {
          content = token;
        }
      }
    }
    if (content === "") {
      issues.push({
        code: "SEO_SETTINGS_INVALID",
        path: `/verification/${index}/content`,
        message: "content required",
      });
    }

    let file: SeoVerificationFile | undefined;
    if (method === "file") {
      if (provider === "other") {
        issues.push({
          code: "SEO_SETTINGS_INVALID",
          path: `/verification/${index}/method`,
          message: 'file verification supports "google" and "yandex" only',
        });
      } else if (typeof entry.file !== "object" || entry.file === null) {
        issues.push({
          code: "SEO_SETTINGS_INVALID",
          path: `/verification/${index}/file`,
          message: "file verification requires filename and body",
        });
      } else {
        const rawFile = entry.file as Record<string, unknown>;
        const filename =
          typeof rawFile.filename === "string" ? rawFile.filename.trim().toLowerCase() : "";
        const body = typeof rawFile.body === "string" ? rawFile.body : "";
        const [filenameRe, expectedBody] = PROVIDER_FILES[provider];
        if (filename === "" || filename.length > 64 || !filenameRe.test(filename)) {
          issues.push({
            code: "SEO_SETTINGS_INVALID",
            path: `/verification/${index}/file/filename`,
            message: `filename must match the ${provider} verification file pattern`,
          });
        }
        if (body.length === 0 || body.length > 2048) {
          issues.push({
            code: "SEO_SETTINGS_INVALID",
            path: `/verification/${index}/file/body`,
            message: "file body must be 1-2048 characters",
          });
        } else if (content !== "" && expectedBody(content) !== body.trim()) {
          // Template consistency ties the stored body to the stored token —
          // scripts/active content cannot pass this equality.
          issues.push({
            code: "SEO_SETTINGS_INVALID",
            path: `/verification/${index}/file/body`,
            message: `file body does not match the ${provider} verification template for this token`,
          });
        }
        if (issues.length === 0) {
          file = { filename, body };
        }
      }
    } else if (entry.file !== undefined && entry.file !== null) {
      issues.push({
        code: "SEO_SETTINGS_INVALID",
        path: `/verification/${index}/file`,
        message: 'file is only valid with method "file"',
      });
    }

    if (issues.length > 0) throwSeoIssues(issues);
    if (provider === undefined || method === undefined || content === "") throwSeoIssues(issues);
    return {
      provider,
      content,
      // "meta" stays implicit: records predating the field keep their shape.
      ...(method === "file" ? { method } : {}),
      ...(file !== undefined ? { file } : {}),
      ...(label !== undefined ? { label } : {}),
    };
  }
  throwSeoIssues(issues);
}

function throwSeoIssues(issues: RawIssue[]): never {
  throw new SeoError("SEO_SETTINGS_INVALID", "site identity rejected", {
    details: { issues },
  });
}

export function parseSeoSiteIdentity(raw: unknown): SeoSiteIdentity {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SeoError("SEO_SETTINGS_INVALID", "site identity must be an object", {
      details: { issues: [{ code: "SEO_SETTINGS_INVALID", path: "/", message: "not an object" }] },
    });
  }
  const record = raw as Record<string, unknown>;
  const issues: RawIssue[] = [];
  for (const key of Object.keys(record)) {
    if (!IDENTITY_KEYS.has(key)) {
      issues.push({ code: "SEO_SETTINGS_INVALID", path: `/${key}`, message: "unknown field" });
    }
  }

  const site_name = clean(record.site_name, "/site_name", issues, 200);
  if (site_name === undefined) {
    issues.push({
      code: "SEO_SETTINGS_INVALID",
      path: "/site_name",
      message: "site_name is required",
    });
  }

  let organization_type: "Organization" | "LocalBusiness" | undefined;
  if (record.organization_type === "Organization" || record.organization_type === "LocalBusiness") {
    organization_type = record.organization_type;
  } else if (record.organization_type != null) {
    issues.push({
      code: "SEO_SETTINGS_INVALID",
      path: "/organization_type",
      message: 'must be "Organization" or "LocalBusiness"',
    });
  }

  let address: SeoAddressFacts | undefined;
  if (record.address != null) {
    if (typeof record.address !== "object" || Array.isArray(record.address)) {
      issues.push({ code: "SEO_SETTINGS_INVALID", path: "/address", message: "must be an object" });
    } else {
      const a = record.address as Record<string, unknown>;
      const parts = {
        street_address: clean(a.street_address, "/address/street_address", issues, 200),
        locality: clean(a.locality, "/address/locality", issues),
        region: clean(a.region, "/address/region", issues),
        postal_code: clean(a.postal_code, "/address/postal_code", issues, 32),
        country: clean(a.country, "/address/country", issues),
      };
      const defined = Object.fromEntries(Object.entries(parts).filter(([, v]) => v !== undefined));
      if (Object.keys(defined).length > 0) address = defined;
    }
  }

  let social_profiles: string[] | undefined;
  if (record.social_profiles != null) {
    if (!Array.isArray(record.social_profiles)) {
      issues.push({
        code: "SEO_SETTINGS_INVALID",
        path: "/social_profiles",
        message: "must be an array",
      });
    } else {
      const profiles: string[] = [];
      for (const [i, p] of record.social_profiles.entries()) {
        const text = clean(p, `/social_profiles/${i}`, issues, 2048);
        if (text !== undefined) {
          if (isHttpUrl(text)) profiles.push(text);
          else {
            issues.push({
              code: "SEO_SETTINGS_INVALID",
              path: `/social_profiles/${i}`,
              message: "must be an absolute http(s) URL",
            });
          }
        }
      }
      if (profiles.length > 0) social_profiles = profiles;
    }
  }

  let article_content_types: string[] | undefined;
  if (record.article_content_types != null) {
    if (!Array.isArray(record.article_content_types)) {
      issues.push({
        code: "SEO_SETTINGS_INVALID",
        path: "/article_content_types",
        message: "must be an array",
      });
    } else {
      const keys = record.article_content_types
        .map((k, i) => clean(k, `/article_content_types/${i}`, issues, 100))
        .filter((k): k is string => k !== undefined);
      if (keys.length > 0) article_content_types = keys;
    }
  }

  let local_business: SeoLocalBusinessFacts | undefined;
  if (record.local_business != null) {
    if (typeof record.local_business !== "object" || Array.isArray(record.local_business)) {
      issues.push({
        code: "SEO_SETTINGS_INVALID",
        path: "/local_business",
        message: "must be an object",
      });
    } else {
      const lb = record.local_business as Record<string, unknown>;
      const subtype = clean(lb.subtype, "/local_business/subtype", issues, 100);
      if (subtype !== undefined && !/^[A-Za-z][A-Za-z0-9]*$/.test(subtype)) {
        issues.push({
          code: "SEO_SETTINGS_INVALID",
          path: "/local_business/subtype",
          message: "must be a schema.org type name",
        });
      }
      let geo: SeoLocalBusinessFacts["geo"];
      if (lb.geo != null) {
        if (typeof lb.geo !== "object") {
          issues.push({
            code: "SEO_SETTINGS_INVALID",
            path: "/local_business/geo",
            message: "must be an object",
          });
        } else {
          const g = lb.geo as Record<string, unknown>;
          if (
            typeof g.latitude === "number" &&
            typeof g.longitude === "number" &&
            Math.abs(g.latitude) <= 90 &&
            Math.abs(g.longitude) <= 180
          ) {
            geo = { latitude: g.latitude, longitude: g.longitude };
          } else {
            issues.push({
              code: "SEO_SETTINGS_INVALID",
              path: "/local_business/geo",
              message: "latitude/longitude out of range",
            });
          }
        }
      }
      const parts = {
        ...(subtype !== undefined && /^[A-Za-z][A-Za-z0-9]*$/.test(subtype) ? { subtype } : {}),
        telephone: clean(lb.telephone, "/local_business/telephone", issues, 32),
        opening_hours: clean(lb.opening_hours, "/local_business/opening_hours", issues, 200),
        ...(geo !== undefined ? { geo } : {}),
      };
      const defined = Object.fromEntries(Object.entries(parts).filter(([, v]) => v !== undefined));
      if (Object.keys(defined).length > 0) local_business = defined;
    }
  }

  let verification: SeoVerificationEntry[] | undefined;
  if (record.verification != null) {
    if (!Array.isArray(record.verification)) {
      issues.push({
        code: "SEO_SETTINGS_INVALID",
        path: "/verification",
        message: "must be an array",
      });
    } else {
      const entries: SeoVerificationEntry[] = [];
      for (const [i, v] of record.verification.entries()) {
        const entry = parseVerificationEntry(v, i);
        if (entry !== null) entries.push(entry);
      }
      // Conflicting or duplicate proofs are rejected: providers verify one
      // proof per property, and a silent replacement could hand ownership
      // evidence to another owner's token.
      for (const [i, entry] of entries.entries()) {
        const clash = entries.find(
          (other, j) =>
            j < i &&
            (other.content === entry.content ||
              (entry.file !== undefined && other.file?.filename === entry.file.filename)),
        );
        if (clash !== undefined && clash.provider === entry.provider) {
          issues.push({
            code: "SEO_SETTINGS_INVALID",
            path: `/verification/${i}`,
            message: `conflicting or duplicate ${entry.provider} proof`,
          });
        }
      }
      if (entries.length > 0) verification = entries;
    }
  }

  const alternate_site_name = clean(
    record.alternate_site_name,
    "/alternate_site_name",
    issues,
    200,
  );
  const legal_name = clean(record.legal_name, "/legal_name", issues);
  const phone = clean(record.phone, "/phone", issues, 32);
  const email = clean(record.email, "/email", issues, 320);
  if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    issues.push({ code: "SEO_SETTINGS_INVALID", path: "/email", message: "invalid email" });
  }
  const title_pattern = clean(record.title_pattern, "/title_pattern", issues, 200);
  const logo = optionalMedia(record.logo, "/logo", issues);
  const favicon = optionalMedia(record.favicon, "/favicon", issues);
  const default_social_image = optionalMedia(
    record.default_social_image,
    "/default_social_image",
    issues,
  );
  if (issues.length > 0) {
    throw new SeoError("SEO_SETTINGS_INVALID", "site identity rejected", { details: { issues } });
  }
  return {
    site_name: site_name as string,
    ...(alternate_site_name !== undefined ? { alternate_site_name } : {}),
    ...(legal_name !== undefined ? { legal_name } : {}),
    ...(organization_type !== undefined ? { organization_type } : {}),
    ...(logo !== undefined ? { logo } : {}),
    ...(favicon !== undefined ? { favicon } : {}),
    ...(default_social_image !== undefined ? { default_social_image } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(address !== undefined ? { address } : {}),
    ...(social_profiles !== undefined ? { social_profiles } : {}),
    ...(title_pattern !== undefined ? { title_pattern } : {}),
    ...(record.allow_intro_description_fallback === false
      ? { allow_intro_description_fallback: false }
      : {}),
    ...(article_content_types !== undefined ? { article_content_types } : {}),
    ...(local_business !== undefined ? { local_business } : {}),
    ...(verification !== undefined ? { verification } : {}),
  };
}

export interface OrganizationSchemaSelection {
  readonly type: "Organization" | "LocalBusiness";
  readonly local_business: SeoLocalBusinessFacts | null;
}

/**
 * LocalBusiness selection policy (spec §34): the type is emitted only when
 * the site explicitly declares organization_type "LocalBusiness" AND
 * supplies local_business facts — never inferred from content or presence.
 */
export function selectOrganizationSchema(identity: SeoSiteIdentity): OrganizationSchemaSelection {
  if (identity.organization_type === "LocalBusiness" && identity.local_business != null) {
    return { type: "LocalBusiness", local_business: identity.local_business };
  }
  return { type: "Organization", local_business: null };
}

/** Maps identity to the fallback resolver's site defaults (§4/§63). */
export function toSiteSeoDefaults(identity: SeoSiteIdentity | null): SiteSeoDefaults {
  return {
    site_name: identity?.site_name ?? null,
    title_pattern: identity?.title_pattern ?? null,
    default_social_image: identity?.default_social_image ?? null,
    allow_intro_description_fallback: identity?.allow_intro_description_fallback !== false,
  };
}
