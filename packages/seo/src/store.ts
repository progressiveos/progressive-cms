// SEO persistence service (PCMS-SEO-T001; ADR-0002: plain SQL via pg,
// forward-only migrations). The store persists validated documents only —
// invalid payloads never reach a row (fail-secure, same rule as Media
// ingest). JSONB payloads are the working-copy seam M07 publication seals.
import { type DbClient, type DbPool, isStableId } from "@pcms/core";
import { validateCanonicalOverride } from "./canonical.js";
import { parseSeoDocument, type SeoDocument } from "./document.js";
import { SeoError } from "./errors.js";
import { parseSeoSiteIdentity, type SeoSiteIdentity } from "./site-identity.js";

export interface SeoDocumentRecord {
  readonly entryId: string;
  readonly document: SeoDocument;
  readonly updatedAt: Date;
}

export interface SeoStore {
  getDocument(entryId: string): Promise<SeoDocument | null>;
  /** Validates and upserts; rejects SEO_DOCUMENT_INVALID / SEO_ID_INVALID. */
  saveDocument(entryId: string, document: SeoDocument): Promise<void>;
  /** Transaction-scoped upsert (PCMS-API-T017): the Publication Bundle
   * persists SEO documents on the same transaction as the drafts. */
  saveDocumentWithinTx(
    executor: DbClient | DbPool,
    entryId: string,
    document: SeoDocument,
  ): Promise<void>;
  deleteDocument(entryId: string): Promise<void>;
  /** All documents, deterministic by entry id (site-wide validation input). */
  listDocuments(): Promise<readonly SeoDocumentRecord[]>;
  getSiteSettings(siteId: string): Promise<SeoSiteIdentity | null>;
  /** Validates and upserts; rejects SEO_SETTINGS_INVALID / SEO_ID_INVALID. */
  saveSiteSettings(siteId: string, identity: SeoSiteIdentity): Promise<void>;
}

function assertEntryId(entryId: string): void {
  if (typeof entryId !== "string" || !isStableId(entryId)) {
    throw new SeoError("SEO_ID_INVALID", "entry id must be a stable id", {
      details: { entryId },
    });
  }
}

function assertSiteId(siteId: string): void {
  if (
    typeof siteId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(siteId)
  ) {
    throw new SeoError("SEO_ID_INVALID", "site id must be a uuid", { details: { siteId } });
  }
}

/**
 * Write-path enforcement (SEO spec §9, F-28): a persisted canonical_override
 * must pass the same validator the render/validation paths use — a bad
 * override (non-http(s) scheme such as `javascript:`, protocol-relative
 * host change, query/fragment) is rejected with the package domain error
 * instead of only being diagnosed downstream. The store has no route
 * context, so the host comparison runs without a route URL here; the
 * external-host rule needs the routing-resolved URL and is additionally
 * enforced where that URL is known (validate/head-model; API save path via
 * `validateCanonicalOverride(override, { routeUrl })`).
 */
function assertCanonicalOverrideAdmissible(document: SeoDocument): void {
  const override = document.canonical_override;
  if (override == null) return;
  const errors = validateCanonicalOverride(override, { routeUrl: null }).filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (errors.length > 0) {
    throw new SeoError("SEO_DOCUMENT_INVALID", "canonical override rejected", {
      details: {
        issues: errors.map((diagnostic) => ({
          code: diagnostic.code,
          path: diagnostic.path,
          message: diagnostic.message,
        })),
      },
    });
  }
}

interface SettingsRow extends Record<string, unknown> {
  readonly site_id: string;
  readonly payload: unknown;
  readonly updated_at: Date;
}

interface DocumentRow extends Record<string, unknown> {
  readonly entry_id: string;
  readonly payload: unknown;
  readonly updated_at: Date;
}

export function createSeoStore(pool: DbPool): SeoStore {
  return {
    async getDocument(entryId) {
      assertEntryId(entryId);
      const { rows } = await pool.query<DocumentRow>(
        "SELECT entry_id, payload, updated_at FROM seo_documents WHERE entry_id = $1",
        [entryId],
      );
      const row = rows[0];
      if (!row) return null;
      return parseSeoDocument(row.payload);
    },

    async saveDocument(entryId, document) {
      assertEntryId(entryId);
      await this.saveDocumentWithinTx(pool, entryId, document);
    },

    async saveDocumentWithinTx(executor, entryId, document) {
      assertEntryId(entryId);
      // Re-validate the typed document through the parser: the store is the
      // single admission point, so an invalid payload can never be persisted.
      const validated = parseSeoDocument(document);
      assertCanonicalOverrideAdmissible(validated);
      await executor.query(
        `INSERT INTO seo_documents (entry_id, payload, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (entry_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
        [entryId, JSON.stringify(validated)],
      );
    },

    async deleteDocument(entryId) {
      assertEntryId(entryId);
      await pool.withTransaction(async (tx) => {
        await tx.query("DELETE FROM seo_documents WHERE entry_id = $1", [entryId]);
      });
    },

    async listDocuments() {
      const { rows } = await pool.query<DocumentRow>(
        "SELECT entry_id, payload, updated_at FROM seo_documents ORDER BY entry_id",
      );
      return rows.map((row) => ({
        entryId: row.entry_id,
        document: parseSeoDocument(row.payload),
        updatedAt: row.updated_at,
      }));
    },

    async getSiteSettings(siteId) {
      assertSiteId(siteId);
      const { rows } = await pool.query<SettingsRow>(
        "SELECT site_id, payload, updated_at FROM seo_site_settings WHERE site_id = $1",
        [siteId],
      );
      const row = rows[0];
      return row ? parseSeoSiteIdentity(row.payload) : null;
    },

    async saveSiteSettings(siteId, identity) {
      assertSiteId(siteId);
      // Single admission point: invalid identity payloads never persist.
      const validated = parseSeoSiteIdentity(identity);
      await pool.withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO seo_site_settings (site_id, payload, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (site_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
          [siteId, JSON.stringify(validated)],
        );
      });
    },
  };
}
