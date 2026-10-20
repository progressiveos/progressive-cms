// Lead domain (PCMS-FORM-T009; Forms spec §18/§19). Lightweight provenance
// records pointing at the originating interaction — the interaction history
// itself stays in forms_submissions / forms_quiz_runs and is never copied.
// Lead creation is idempotent per (source_type, source_id): retries and event
// replays cannot spawn duplicate business records.
import type { DbPool } from "@pcms/core";
import { newStableId } from "@pcms/core";
import type { AttributionSnapshot } from "./attribution.js";
import { FormsError } from "./errors.js";
import type { FormsExecutor } from "./submissions.js";
import { boundedText, oneOf, optionalText } from "./validate.js";

export type LeadSourceType = "FORM_SUBMISSION" | "QUIZ_RUN";
export type LeadStatus = "NEW" | "VIEWED" | "PROCESSED" | "ARCHIVED" | "SPAM";

export const LEAD_STATUSES: readonly LeadStatus[] = [
  "NEW",
  "VIEWED",
  "PROCESSED",
  "ARCHIVED",
  "SPAM",
];

export interface LeadRecord {
  readonly id: string;
  readonly source_type: LeadSourceType;
  readonly source_id: string;
  readonly status: LeadStatus;
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly summary: string;
  /** Immutable readable submission representation (PCMS→HQ initial_message). */
  readonly presentation: string;
  /** Immutable MKT-010 attribution snapshot (client-declared, server-validated). */
  readonly attribution: AttributionSnapshot | null;
  readonly classification: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateLeadInput {
  readonly presentation?: string;
  readonly attribution?: AttributionSnapshot | null;
  readonly source_type: LeadSourceType;
  readonly source_id: string;
  readonly name?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly summary?: string;
  readonly classification?: string | null;
}

export interface LeadListFilter {
  readonly status?: LeadStatus;
  readonly source_type?: LeadSourceType;
  readonly before?: { readonly created_at: string; readonly id: string };
  readonly limit?: number;
}

const MAX_LIST_LIMIT = 200;
const MAX_SUMMARY_LENGTH = 2000;
/**
 * Readable submission representation (PCMS→HQ): built once at lead creation,
 * immutable afterwards, sent to HQ as initial_message. Bounded well below the
 * HQ 100k limit; overflow truncates with an explicit marker (never silently).
 */
const MAX_PRESENTATION_LENGTH = 20_000;

interface LeadRow {
  readonly [column: string]: unknown;
  readonly id: string;
  readonly source_type: string;
  readonly source_id: string;
  readonly status: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly summary: string;
  readonly presentation: string;
  readonly attribution: unknown;
  readonly classification: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function rowToLead(row: LeadRow): LeadRecord {
  return {
    id: row.id,
    source_type: row.source_type as LeadSourceType,
    source_id: row.source_id,
    status: row.status as LeadStatus,
    name: row.name,
    email: row.email,
    phone: row.phone,
    summary: row.summary,
    presentation: row.presentation,
    attribution: (row.attribution ?? null) as AttributionSnapshot | null,
    classification: row.classification,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export interface LeadService {
  /** Creates a lead for an interaction; returns the existing lead (created:
   * false) when this interaction already produced one. */
  createLead(
    input: CreateLeadInput,
    options?: { readonly executor?: FormsExecutor },
  ): Promise<{ readonly lead: LeadRecord; readonly created: boolean }>;
  getLead(id: string): Promise<LeadRecord>;
  findBySource(source_type: LeadSourceType, source_id: string): Promise<LeadRecord | null>;
  setStatus(
    id: string,
    status: LeadStatus,
    options?: { readonly executor?: FormsExecutor },
  ): Promise<LeadRecord>;
  listLeads(filter?: LeadListFilter): Promise<readonly LeadRecord[]>;
}

export function createLeadService(pool: DbPool): LeadService {
  return {
    async createLead(input, options) {
      const executor = options?.executor ?? pool;
      const summary =
        input.summary === undefined
          ? ""
          : boundedText(input.summary, "LEAD_STATUS_INVALID", "summary", MAX_SUMMARY_LENGTH, {
              min: 0,
            });
      const record = {
        name: optionalText(input.name, "LEAD_STATUS_INVALID", "name", 300) ?? null,
        email: optionalText(input.email, "LEAD_STATUS_INVALID", "email", 320) ?? null,
        phone: optionalText(input.phone, "LEAD_STATUS_INVALID", "phone", 40) ?? null,
        classification:
          optionalText(input.classification, "LEAD_STATUS_INVALID", "classification", 100) ?? null,
      };
      const inserted = await executor.query<LeadRow>(
        `INSERT INTO forms_leads (id, source_type, source_id, name, email, phone, summary, classification, presentation, attribution)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (source_type, source_id) DO NOTHING
         RETURNING *`,
        [
          newStableId(),
          input.source_type,
          input.source_id,
          record.name,
          record.email,
          record.phone,
          summary,
          record.classification,
          boundedText(
            input.presentation ?? "",
            "LEAD_STATUS_INVALID",
            "presentation",
            MAX_PRESENTATION_LENGTH,
            {
              min: 0,
            },
          ),
          input.attribution === null || input.attribution === undefined
            ? null
            : JSON.stringify(input.attribution),
        ],
      );
      if (inserted.rows.length === 1) {
        return { lead: rowToLead(inserted.rows[0]!), created: true };
      }
      const existing = await this.findBySource(input.source_type, input.source_id);
      if (!existing) {
        throw new FormsError("LEAD_NOT_FOUND", "lead conflict but source lead missing");
      }
      return { lead: existing, created: false };
    },

    async getLead(id) {
      const result = await pool.query<LeadRow>(`SELECT * FROM forms_leads WHERE id = $1`, [id]);
      if (result.rows.length !== 1) {
        throw new FormsError("LEAD_NOT_FOUND", `lead ${id} not found`);
      }
      return rowToLead(result.rows[0]!);
    },

    async findBySource(source_type, source_id) {
      const result = await pool.query<LeadRow>(
        `SELECT * FROM forms_leads WHERE source_type = $1 AND source_id = $2`,
        [source_type, source_id],
      );
      return result.rows.length === 1 ? rowToLead(result.rows[0]!) : null;
    },

    async setStatus(id, status, options) {
      oneOf(status, LEAD_STATUSES, "LEAD_STATUS_INVALID", "status");
      const executor = options?.executor ?? pool;
      const result = await executor.query<LeadRow>(
        `UPDATE forms_leads SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, status],
      );
      if (result.rows.length !== 1) {
        throw new FormsError("LEAD_NOT_FOUND", `lead ${id} not found`);
      }
      return rowToLead(result.rows[0]!);
    },

    async listLeads(filter = {}) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (filter.status !== undefined) {
        params.push(filter.status);
        conditions.push(`status = $${params.length}`);
      }
      if (filter.source_type !== undefined) {
        params.push(filter.source_type);
        conditions.push(`source_type = $${params.length}`);
      }
      if (filter.before !== undefined) {
        params.push(new Date(filter.before.created_at), filter.before.id);
        conditions.push(
          `(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
      const limit = Math.min(Math.max(filter.limit ?? 50, 1), MAX_LIST_LIMIT);
      const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
      const result = await pool.query<LeadRow>(
        `SELECT * FROM forms_leads${where} ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
        params,
      );
      return result.rows.map(rowToLead);
    },
  };
}
