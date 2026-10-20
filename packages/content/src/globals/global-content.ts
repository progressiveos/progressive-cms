// Global Content typed entities (PCMS-CONT-T019; Content spec §62).
//
// Global Content is a versioned structured content entity outside the Page
// Tree (company, contacts, legal, social_links, shared_cta, …). It is not a
// Site Setting and not a Theme Setting. It reuses the ContentType registry's
// schema validation primitives — the payload must validate against the
// registered (content_type_key, schema_version) schema, draft-lenient on
// save, publish-strict on demand.
import type { DbPool } from "@pcms/core";
import type { LoadedContentType } from "../content-types/content-type.js";
import { ContentError } from "../errors.js";
import { newStableId, type StableId } from "../ids/stable-id.js";
import {
  type ContentValidationResult,
  validateContentPayload,
} from "../validation/content-validation.js";

const GLOBAL_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export interface GlobalContentRecord {
  readonly id: StableId;
  readonly key: string;
  readonly contentTypeId: string;
  readonly schemaVersion: number;
  readonly fields: Record<string, unknown>;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt: Date | null;
}

export interface CreateGlobalInput {
  readonly key: string;
  readonly schema: LoadedContentType;
  readonly fields: Record<string, unknown>;
  readonly createdBy: string;
}

interface GlobalRow extends Record<string, unknown> {
  id: string;
  key: string;
  content_type_key: string;
  schema_version: number;
  fields: Record<string, unknown>;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

function toRecord(row: GlobalRow): GlobalContentRecord {
  return {
    id: row.id as StableId,
    key: row.key,
    contentTypeId: row.content_type_key,
    schemaVersion: row.schema_version,
    fields: row.fields,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export interface GlobalContentService {
  /** Creates a global entity; the payload must be draft-valid for its schema. */
  createGlobal(input: CreateGlobalInput): Promise<GlobalContentRecord>;
  /** Updates the fields payload (draft-valid against `schema`) and bumps updated_at. */
  updateGlobal(
    key: string,
    fields: Record<string, unknown>,
    schema: LoadedContentType,
  ): Promise<GlobalContentRecord>;
  getGlobal(key: string): Promise<GlobalContentRecord>;
  findGlobal(key: string): Promise<GlobalContentRecord | null>;
  /** Deterministic discovery order: sorted by key. */
  listGlobals(): Promise<GlobalContentRecord[]>;
  /** Archive is idempotent and never a hard delete. */
  archiveGlobal(key: string): Promise<GlobalContentRecord>;
  /** Runs the schema validation at an explicit level (draft | publish). */
  validate(
    key: string,
    fields: unknown,
    level: "draft" | "publish",
    schema: LoadedContentType,
  ): Promise<ContentValidationResult>;
}

export function createGlobalContentService(pool: DbPool): GlobalContentService {
  async function findGlobal(key: string): Promise<GlobalContentRecord | null> {
    if (!GLOBAL_KEY_RE.test(key)) return null;
    const result = await pool.query<GlobalRow>(
      `SELECT id, key, content_type_key, schema_version, fields, created_by, created_at, updated_at, archived_at
       FROM global_content WHERE key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  return {
    async createGlobal(input): Promise<GlobalContentRecord> {
      const { key, schema, fields, createdBy } = input;
      if (!GLOBAL_KEY_RE.test(key)) {
        throw new ContentError(
          "GLOBAL_KEY_INVALID",
          `global key "${key}" must be lowercase snake_case`,
        );
      }
      if (createdBy.length === 0) {
        throw new ContentError(
          "CREATED_BY_REQUIRED",
          "createdBy must be a non-empty actor reference",
        );
      }
      const validation = validateContentPayload(schema, fields, "draft");
      if (!validation.ok) {
        throw new ContentError(
          "GLOBAL_PAYLOAD_INVALID",
          `payload fails the ${schema.key}@${schema.version} schema: ${validation.errors.map((error) => `${error.path} ${error.code}`).join("; ")}`,
        );
      }
      try {
        const inserted = await pool.query<GlobalRow>(
          `INSERT INTO global_content (id, key, content_type_key, schema_version, fields, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, key, content_type_key, schema_version, fields, created_by, created_at, updated_at, archived_at`,
          [newStableId(), key, schema.key, schema.version, JSON.stringify(fields), createdBy],
        );
        return toRecord(inserted.rows[0] as GlobalRow);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new ContentError("GLOBAL_ALREADY_EXISTS", `global "${key}" already exists`, {
            cause: error,
          });
        }
        throw new ContentError("GLOBAL_PERSISTENCE_FAILED", "could not persist global entity", {
          cause: error,
        });
      }
    },

    async updateGlobal(key, fields, schema): Promise<GlobalContentRecord> {
      const existing = await findGlobal(key);
      if (existing === null) {
        throw new ContentError("GLOBAL_NOT_FOUND", `global "${key}" not found`);
      }
      const validation = validateContentPayload(schema, fields, "draft");
      if (!validation.ok) {
        throw new ContentError(
          "GLOBAL_PAYLOAD_INVALID",
          `payload fails the ${schema.key}@${schema.version} schema`,
        );
      }
      const updated = await pool.query<GlobalRow>(
        `UPDATE global_content SET fields = $2, updated_at = now()
         WHERE key = $1
         RETURNING id, key, content_type_key, schema_version, fields, created_by, created_at, updated_at, archived_at`,
        [key, JSON.stringify(fields)],
      );
      return toRecord(updated.rows[0] as GlobalRow);
    },

    getGlobal(key) {
      return findGlobal(key).then((record) => {
        if (record === null)
          throw new ContentError("GLOBAL_NOT_FOUND", `global "${key}" not found`);
        return record;
      });
    },

    findGlobal,

    async listGlobals(): Promise<GlobalContentRecord[]> {
      const result = await pool.query<GlobalRow>(
        `SELECT id, key, content_type_key, schema_version, fields, created_by, created_at, updated_at, archived_at
         FROM global_content ORDER BY key`,
      );
      return result.rows.map(toRecord);
    },

    async archiveGlobal(key): Promise<GlobalContentRecord> {
      const updated = await pool.query<GlobalRow>(
        `UPDATE global_content SET archived_at = COALESCE(archived_at, now())
         WHERE key = $1
         RETURNING id, key, content_type_key, schema_version, fields, created_by, created_at, updated_at, archived_at`,
        [key],
      );
      const row = updated.rows[0];
      if (row === undefined)
        throw new ContentError("GLOBAL_NOT_FOUND", `global "${key}" not found`);
      return toRecord(row);
    },

    async validate(key, fields, level, schema): Promise<ContentValidationResult> {
      const existing = await findGlobal(key);
      if (existing === null)
        throw new ContentError("GLOBAL_NOT_FOUND", `global "${key}" not found`);
      void existing;
      return validateContentPayload(schema, fields, level);
    },
  };
}
