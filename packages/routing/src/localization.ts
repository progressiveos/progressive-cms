// Opt-in site localization state (multilingual capability, OFF by default).
//
// The singleton row (migration 1701) is SITE state operators flip from the
// Admin, exactly like maintenance/mail settings. While disabled every
// surface keeps its legacy sentinel behavior: 'default' on
// revisions/publications/search documents and 'x-default' on routes/sites
// means "the site default locale", and no locale UI exists anywhere.
//
// When enabled, secondary locales are real BCP-47 codes ("en-US") that ride
// the existing per-locale axes: revisions.locale, publications.context,
// routes.locale. Secondary locales get one path prefix each (the lowercase
// primary subtag: "en-US" → /en/...); the default locale keeps unprefixed
// URLs. Domain-per-locale is a documented extension seam
// (domain_bindings.locale) — not implemented here.
import type { DbPool } from "@pcms/core";
import { RoutingError } from "./errors.js";

const DEFAULT_LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export interface SiteLocalizationRecord {
  readonly enabled: boolean;
  /** BCP-47 code of the default locale; served without a path prefix. */
  readonly defaultLocale: string;
  /** Enabled locales including the default, in display order. */
  readonly locales: readonly string[];
  readonly routingStrategy: "path_prefix";
  readonly updatedAt: Date;
  readonly updatedBy: string;
}

export interface UpdateSiteLocalizationInput {
  readonly enabled: boolean;
  readonly defaultLocale: string;
  readonly locales: readonly string[];
  readonly updatedBy: string;
}

/** Locale scope derived from a request path (secondary locales only). */
export interface PeeledPrefix {
  readonly locale: string;
  /** Path with the prefix removed, always starting with "/". */
  readonly path: string;
  /** The prefix itself, e.g. "/en". */
  readonly prefix: string;
}

export interface SiteLocalizationService {
  get(): Promise<SiteLocalizationRecord>;
  update(input: UpdateSiteLocalizationInput): Promise<SiteLocalizationRecord>;
  /**
   * Splits a locale path prefix off `path` when multilingual is enabled and
   * the prefix names an enabled secondary locale. Null when the path is a
   * default-locale path (which keeps unprefixed URLs) or multilingual is off.
   */
  peelPrefix(path: string): Promise<PeeledPrefix | null>;
  /** Prefix for a locale: "" for the default, "/en" style otherwise. */
  prefixFor(locale: string): string;
  /**
   * Publication/search context for a request locale: legacy "default"
   * sentinel for the default locale, the BCP-47 code for secondaries.
   */
  contextFor(requestLocale: string | null): Promise<string>;
}

interface LocalizationRow extends Record<string, unknown> {
  enabled: boolean;
  default_locale: string;
  locales: unknown;
  routing_strategy: string;
  updated_at: Date;
  updated_by: string;
}

function toRecord(row: LocalizationRow): SiteLocalizationRecord {
  const locales = Array.isArray(row.locales) ? (row.locales as unknown[]).map(String) : [];
  return {
    enabled: row.enabled === true,
    defaultLocale: row.default_locale,
    locales,
    routingStrategy: "path_prefix",
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function validate(input: {
  enabled: boolean;
  defaultLocale: string;
  locales: readonly string[];
}): void {
  const locales = input.locales;
  if (locales.length === 0) {
    throw new RoutingError("LOCALE_LIST_EMPTY", "at least one locale must be enabled");
  }
  if (!locales.includes(input.defaultLocale)) {
    throw new RoutingError(
      "LOCALE_DEFAULT_NOT_ENABLED",
      `default locale ${input.defaultLocale} is not in the enabled locales`,
    );
  }
  const prefixes = new Map<string, string>();
  for (const locale of locales) {
    if (!DEFAULT_LOCALE_RE.test(locale)) {
      throw new RoutingError("LOCALE_INVALID", `locale ${locale} is not a BCP-47 tag`, {
        details: { locale },
      });
    }
    const prefix = locale
      .slice(0, locale.indexOf("-") === -1 ? locale.length : locale.indexOf("-"))
      .toLowerCase();
    const previous = prefixes.get(prefix);
    if (previous !== undefined) {
      throw new RoutingError(
        "LOCALE_PREFIX_CONFLICT",
        `locales ${previous} and ${locale} share the path prefix "${prefix}"`,
        { details: { prefix } },
      );
    }
    prefixes.set(prefix, locale);
  }
}

export function createSiteLocalizationService(pool: DbPool): SiteLocalizationService {
  async function get(): Promise<SiteLocalizationRecord> {
    const result = await pool.query<LocalizationRow>(
      `SELECT * FROM pcms_site_localization WHERE id = 1`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new RoutingError("SITE_NOT_FOUND", "localization state row is missing");
    }
    return toRecord(row);
  }

  return {
    get,

    async update(input) {
      validate(input);
      const result = await pool.query<LocalizationRow>(
        `UPDATE pcms_site_localization
         SET enabled = $1, default_locale = $2, locales = $3::jsonb,
             updated_at = now(), updated_by = $4
         WHERE id = 1
         RETURNING *`,
        [input.enabled, input.defaultLocale, JSON.stringify([...input.locales]), input.updatedBy],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new RoutingError("SITE_NOT_FOUND", "localization state row is missing");
      }
      return toRecord(row);
    },

    async peelPrefix(path) {
      const record = await get();
      if (!record.enabled) return null;
      for (const locale of record.locales) {
        if (locale === record.defaultLocale) continue;
        const prefix = this.prefixFor(locale);
        if (path === prefix || path.startsWith(`${prefix}/`)) {
          const rest = path.slice(prefix.length);
          return { locale, path: rest.length === 0 ? "/" : rest, prefix };
        }
      }
      return null;
    },

    prefixFor(locale) {
      const dash = locale.indexOf("-");
      const subtag = dash === -1 ? locale : locale.slice(0, dash);
      return `/${subtag.toLowerCase()}`;
    },

    async contextFor(requestLocale) {
      const record = await get();
      if (requestLocale === null || requestLocale === record.defaultLocale) return "default";
      if (!record.enabled || !record.locales.includes(requestLocale)) {
        throw new RoutingError("LOCALE_NOT_ENABLED", `locale ${requestLocale} is not enabled`, {
          details: { locale: requestLocale },
        });
      }
      return requestLocale;
    },
  };
}
