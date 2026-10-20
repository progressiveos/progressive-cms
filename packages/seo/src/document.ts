// Typed SEO metadata model (PCMS-SEO-T001; SEO spec §3/§11).
//
// The SEO document is the explicit per-entry SEO payload, stored separately
// from semantic Content fields (title/intro/hero are fallback inputs, never
// meta tags). Everything here is typed plain data: raw directive strings are
// rejected by construction — the only way in is through the parsers below.
import { isStableId } from "@pcms/core";
import { SeoError } from "./errors.js";

interface RawIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

function collect(): {
  issues: RawIssue[];
  add: (code: string, path: string, message: string) => void;
} {
  const issues: RawIssue[] = [];
  return { issues, add: (code, path, message) => issues.push({ code, path, message }) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Printable, single-line text — no control characters (CRLF never enters SEO values). */
function isCleanText(value: unknown): value is string {
  return typeof value === "string" && /^[\t\n\r\x20-\x7E\u00A0-\uFFFD]*$/.test(value)
    ? !/[\t\n\r]/.test(value)
    : false;
}

/**
 * Reference to a Media Asset (SEO spec §28; Media spec §6). SEO stores the
 * asset identity — never an arbitrary URL. `version` is the future
 * version-pinning seam: absent means "current at resolution time"; M07
 * publication can persist a pinned version without changing this shape.
 */
export interface SeoMediaRef {
  readonly asset_id: string;
  readonly version?: number;
}

export function parseSeoMediaRef(
  raw: unknown,
  path: string,
  issues: RawIssue[],
): SeoMediaRef | null {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) {
    issues.push({
      code: "SEO_DOCUMENT_INVALID",
      path,
      message: "media reference must be an object",
    });
    return null;
  }
  const before = issues.length;
  const { asset_id, version } = raw;
  if (typeof asset_id !== "string" || !isStableId(asset_id)) {
    issues.push({
      code: "SEO_DOCUMENT_INVALID",
      path,
      message: "asset_id must be a stable media asset id",
    });
  }
  if (
    version !== undefined &&
    (typeof version !== "number" || !Number.isInteger(version) || version < 1)
  ) {
    issues.push({
      code: "SEO_DOCUMENT_INVALID",
      path,
      message: "version must be a positive integer",
    });
  }
  if (issues.length > before) return null;
  return {
    asset_id: asset_id as string,
    ...(version === undefined ? {} : { version: version as number }),
  };
}

/**
 * Typed page-level indexing policy (SEO spec §11). Baseline directives only;
 * engines receive the semantic mapping — raw directive strings are not part
 * of the model, so user input cannot inject arbitrary meta content.
 */
export interface SeoRobotsPolicy {
  readonly index: boolean;
  readonly follow: boolean;
  readonly noarchive?: boolean;
  readonly nosnippet?: boolean;
  readonly max_snippet?: number;
  readonly max_image_preview?: "none" | "standard" | "large";
  readonly max_video_preview?: number;
}

const ROBOTS_KEYS = new Set([
  "index",
  "follow",
  "noarchive",
  "nosnippet",
  "max_snippet",
  "max_image_preview",
  "max_video_preview",
]);

export function parseSeoRobotsPolicy(
  raw: unknown,
  path: string,
  issues: RawIssue[],
): SeoRobotsPolicy | null {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) {
    issues.push({ code: "SEO_ROBOTS_INVALID", path, message: "robots policy must be an object" });
    return null;
  }
  const before = issues.length;
  for (const key of Object.keys(raw)) {
    if (!ROBOTS_KEYS.has(key)) {
      issues.push({
        code: "SEO_ROBOTS_INVALID",
        path,
        message: `unknown robots directive: ${key}`,
      });
    }
  }
  const { index, follow, noarchive, nosnippet, max_snippet, max_image_preview, max_video_preview } =
    raw;
  for (const [name, value] of [
    ["index", index],
    ["follow", follow],
    ["noarchive", noarchive],
    ["nosnippet", nosnippet],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      issues.push({ code: "SEO_ROBOTS_INVALID", path, message: `${name} must be a boolean` });
    }
  }
  let policy: SeoRobotsPolicy | null = null;
  if (issues.length === before) {
    policy = {
      index: index === undefined ? true : (index as boolean),
      follow: follow === undefined ? true : (follow as boolean),
      ...(noarchive === undefined ? {} : { noarchive: noarchive as boolean }),
      ...(nosnippet === undefined ? {} : { nosnippet: nosnippet as boolean }),
    };
    if (max_snippet !== undefined) {
      if (
        typeof max_snippet !== "number" ||
        !Number.isInteger(max_snippet) ||
        max_snippet < 0 ||
        max_snippet > 100_000
      ) {
        issues.push({
          code: "SEO_ROBOTS_INVALID",
          path,
          message: "max_snippet must be an integer in 0..100000",
        });
      } else {
        (policy as { max_snippet?: number }).max_snippet = max_snippet;
      }
    }
    if (max_image_preview !== undefined) {
      if (
        max_image_preview !== "none" &&
        max_image_preview !== "standard" &&
        max_image_preview !== "large"
      ) {
        issues.push({
          code: "SEO_ROBOTS_INVALID",
          path,
          message: 'max_image_preview must be "none" | "standard" | "large"',
        });
      } else {
        (policy as { max_image_preview?: "none" | "standard" | "large" }).max_image_preview =
          max_image_preview;
      }
    }
    if (max_video_preview !== undefined) {
      if (
        typeof max_video_preview !== "number" ||
        !Number.isInteger(max_video_preview) ||
        max_video_preview < -1 ||
        max_video_preview > 100_000
      ) {
        issues.push({
          code: "SEO_ROBOTS_INVALID",
          path,
          message: "max_video_preview must be an integer in -1..100000",
        });
      } else {
        (policy as { max_video_preview?: number }).max_video_preview = max_video_preview;
      }
    }
  }
  return policy;
}

/**
 * Explicit structured-data hint (SEO spec §3/§31). Closed v1 set: the
 * article family selects the Article renderer subtype; extension types are
 * future registry registrations, never free strings.
 */
export const STRUCTURED_DATA_TYPE_HINTS = [
  "web_page",
  "article",
  "news_article",
  "blog_posting",
] as const;
export type StructuredDataTypeHint = (typeof STRUCTURED_DATA_TYPE_HINTS)[number];

const TITLE_BOUND = 1000;
const DESCRIPTION_BOUND = 5000;
const URL_BOUND = 2048;

/** One explicit per-entry SEO payload (SEO spec §3). Field names are normative. */
export interface SeoDocument {
  readonly seo_title: string | null;
  readonly meta_description: string | null;
  readonly canonical_override: string | null;
  readonly robots_policy: SeoRobotsPolicy | null;
  readonly social_title: string | null;
  readonly social_description: string | null;
  readonly social_image: SeoMediaRef | null;
  readonly structured_data_type_hint: StructuredDataTypeHint | null;
}

function cleanOrNull(
  value: unknown,
  bound: number,
  path: string,
  issues: RawIssue[],
): string | null {
  if (value === null || value === undefined) return null;
  if (!isCleanText(value)) {
    issues.push({
      code: "SEO_DOCUMENT_INVALID",
      path,
      message: "must be a single-line string without control characters",
    });
    return null;
  }
  const text = value.trim();
  if (text.length === 0) return null;
  if (text.length > bound) {
    issues.push({ code: "SEO_DOCUMENT_INVALID", path, message: `exceeds ${bound} characters` });
    return null;
  }
  return text;
}

export function parseSeoDocument(raw: unknown): SeoDocument {
  if (!isPlainObject(raw)) {
    throw new SeoError("SEO_DOCUMENT_INVALID", "SEO document must be an object", {
      details: { issues: [{ code: "SEO_DOCUMENT_INVALID", path: "/", message: "not an object" }] },
    });
  }
  const { issues, add } = collect();
  for (const key of Object.keys(raw)) {
    if (!SEO_DOCUMENT_KEYS.has(key))
      add("SEO_DOCUMENT_INVALID", `/${key}`, "unknown SEO document field");
  }
  const {
    seo_title,
    meta_description,
    canonical_override,
    robots_policy,
    social_title,
    social_description,
    social_image,
    structured_data_type_hint,
  } = raw;

  const title = cleanOrNull(seo_title, TITLE_BOUND, "/seo_title", issues);
  const description = cleanOrNull(meta_description, DESCRIPTION_BOUND, "/meta_description", issues);
  let canonical: string | null = null;
  if (canonical_override !== null && canonical_override !== undefined) {
    if (!isCleanText(canonical_override) || /\s/.test(canonical_override as string)) {
      add(
        "SEO_DOCUMENT_INVALID",
        "/canonical_override",
        "must be a URL without whitespace or control characters",
      );
    } else if ((canonical_override as string).length > URL_BOUND) {
      add("SEO_DOCUMENT_INVALID", "/canonical_override", `exceeds ${URL_BOUND} characters`);
    } else {
      canonical = canonical_override as string;
    }
  }
  const robots = parseSeoRobotsPolicy(robots_policy, "/robots_policy", issues);
  const socialTitle = cleanOrNull(social_title, TITLE_BOUND, "/social_title", issues);
  const socialDescription = cleanOrNull(
    social_description,
    DESCRIPTION_BOUND,
    "/social_description",
    issues,
  );
  const image = parseSeoMediaRef(social_image, "/social_image", issues);
  let hint: StructuredDataTypeHint | null = null;
  if (structured_data_type_hint !== null && structured_data_type_hint !== undefined) {
    if (
      typeof structured_data_type_hint === "string" &&
      (STRUCTURED_DATA_TYPE_HINTS as readonly string[]).includes(structured_data_type_hint)
    ) {
      hint = structured_data_type_hint as StructuredDataTypeHint;
    } else {
      add(
        "SEO_DOCUMENT_INVALID",
        "/structured_data_type_hint",
        `must be one of: ${STRUCTURED_DATA_TYPE_HINTS.join(", ")}`,
      );
    }
  }

  if (issues.length > 0) {
    throw new SeoError("SEO_DOCUMENT_INVALID", "SEO document rejected", {
      details: { issues },
    });
  }
  return {
    seo_title: title,
    meta_description: description,
    canonical_override: canonical,
    robots_policy: robots,
    social_title: socialTitle,
    social_description: socialDescription,
    social_image: image,
    structured_data_type_hint: hint,
  };
}

export const SEO_DOCUMENT_KEYS = new Set([
  "seo_title",
  "meta_description",
  "canonical_override",
  "robots_policy",
  "social_title",
  "social_description",
  "social_image",
  "structured_data_type_hint",
]);

/** The empty document: every explicit field absent (all fallbacks apply). */
export function emptySeoDocument(): SeoDocument {
  return {
    seo_title: null,
    meta_description: null,
    canonical_override: null,
    robots_policy: null,
    social_title: null,
    social_description: null,
    social_image: null,
    structured_data_type_hint: null,
  };
}
