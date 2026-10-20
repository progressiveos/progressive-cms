// Relation/reference graph + inbound usage query (PCMS-CONT-T018;
// Content spec §60/§61).
//
// All typed Entry relations and Media references are discoverable: the system
// must answer "who references Entry X?" and "where is Media Y used?". The
// graph drives safe archive/delete impact analysis, diagnostics, validation
// and migrations. Rows are derived from a revision payload against the
// ContentType schema and replaced atomically per source entry — the table is
// a projection, never an independent source of truth.
import type { DbPool } from "@pcms/core";
import type { LoadedContentType } from "../content-types/content-type.js";
import { ContentError } from "../errors.js";
import type { FieldSchema } from "../fields/structured-schemas.js";
import { type EntryId, isStableId, type StableId } from "../ids/stable-id.js";

export type ReferenceTargetKind = "entry" | "media";

export interface ExtractedReference {
  /** JSON-pointer path inside the fields payload, e.g. "/related/0". */
  readonly path: string;
  readonly kind: ReferenceTargetKind;
  readonly targetId: StableId;
}

interface ReferenceRow extends Record<string, unknown> {
  source_entry_id: string;
  source_path: string;
  target_kind: ReferenceTargetKind;
  target_id: string;
}

function collectFromSchema(
  schema: FieldSchema,
  value: unknown,
  path: string,
  out: ExtractedReference[],
): void {
  if (value === undefined || value === null) return;
  if (schema.type === "relation" || schema.type === "media") {
    if (isStableId(value)) {
      out.push({ path, kind: schema.type === "relation" ? "entry" : "media", targetId: value });
    }
    return;
  }
  if (schema.type === "relation_list" || schema.type === "media_list") {
    if (Array.isArray(value)) {
      const kind = schema.type === "relation_list" ? "entry" : "media";
      value.forEach((item, index) => {
        if (isStableId(item)) {
          out.push({ path: `${path}/${index}`, kind, targetId: item });
        }
      });
    }
    return;
  }
  if ("fields" in schema && typeof schema.fields === "object" && schema.fields !== null) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(schema.fields)) {
      collectFromSchema(child, record[key], `${path}/${key}`, out);
    }
    return;
  }
  if ("item" in schema && typeof schema.item === "object" && schema.item !== null) {
    const item = schema.item as { fields?: Record<string, FieldSchema> } & FieldSchema;
    if (!Array.isArray(value)) return;
    if (item.fields !== undefined) {
      value.forEach((entry, index) => {
        if (typeof entry !== "object" || entry === null) return;
        const record = entry as Record<string, unknown>;
        for (const [key, child] of Object.entries(item.fields ?? {})) {
          collectFromSchema(child, record[key], `${path}/${index}/${key}`, out);
        }
      });
    } else {
      value.forEach((entry, index) => {
        collectFromSchema(item as unknown as FieldSchema, entry, `${path}/${index}`, out);
      });
    }
  }
}

/**
 * Extracts every relation/media reference from a fields payload according to
 * the ContentType schema. Malformed reference shapes are skipped — payload
 * validation reports them; the graph only records well-formed references.
 */
export function extractReferences(
  contentType: LoadedContentType,
  fields: unknown,
): ExtractedReference[] {
  const out: ExtractedReference[] = [];
  if (typeof fields !== "object" || fields === null) return out;
  for (const [key, child] of Object.entries(contentType.fieldSchema.fields)) {
    collectFromSchema(child, (fields as Record<string, unknown>)[key], `/${key}`, out);
  }
  return out;
}

export interface InboundReference {
  readonly sourceEntryId: EntryId;
  readonly sourcePath: string;
  readonly kind: ReferenceTargetKind;
}

export interface DeleteImpactResult {
  readonly kind: ReferenceTargetKind;
  readonly targetId: StableId;
  /** Total number of inbound references across distinct source entries. */
  readonly inboundCount: number;
  /** Distinct source entries referencing the target. */
  readonly referencingEntries: EntryId[];
  readonly references: InboundReference[];
}

export interface ReferenceGraphService {
  /**
   * Replaces the stored reference set of one source entry with the set
   * derived from its current fields payload (atomic, Content spec §83).
   * `extraReferences` (M05 integration): additional references extracted
   * outside the fields payload — e.g. body BlockDocument media IDs,
   * collected by the composition layer from the Block Registry
   * declarations — merged into the same atomic projection.
   */
  syncReferences(
    sourceEntryId: EntryId,
    contentType: LoadedContentType,
    fields: unknown,
    extraReferences?: readonly ExtractedReference[],
  ): Promise<void>;
  /** Removes all references originating from a source entry (e.g. on archive workflows). */
  clearReferences(sourceEntryId: EntryId): Promise<void>;
  /** "Who references Entry X?" / "Where is Media Y used?" (Content spec §60). */
  listInboundReferences(kind: ReferenceTargetKind, targetId: StableId): Promise<InboundReference[]>;
  listOutboundReferences(sourceEntryId: EntryId): Promise<ExtractedReference[]>;
  /**
   * Impact result for deleting a referenced target (Content spec §61): the
   * caller decides policy; hard delete never happens silently.
   */
  checkDeleteImpact(kind: ReferenceTargetKind, targetId: StableId): Promise<DeleteImpactResult>;
}

export function createReferenceGraphService(pool: DbPool): ReferenceGraphService {
  return {
    async syncReferences(sourceEntryId, contentType, fields, extraReferences): Promise<void> {
      if (!isStableId(sourceEntryId)) {
        throw new ContentError("ENTRY_NOT_FOUND", "invalid source entry id");
      }
      const extracted = extractReferences(contentType, fields);
      const deduped = new Map<string, ExtractedReference>();
      for (const reference of [...extracted, ...(extraReferences ?? [])]) {
        deduped.set(`${reference.path}|${reference.kind}|${reference.targetId}`, reference);
      }
      await pool.withTransaction(async (tx) => {
        await tx.query("DELETE FROM content_references WHERE source_entry_id = $1", [
          sourceEntryId,
        ]);
        const rows = [...deduped.values()];
        for (const reference of rows) {
          await tx.query(
            `INSERT INTO content_references (source_entry_id, source_path, target_kind, target_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING`,
            [sourceEntryId, reference.path, reference.kind, reference.targetId],
          );
        }
      });
    },

    async clearReferences(sourceEntryId): Promise<void> {
      if (!isStableId(sourceEntryId)) {
        throw new ContentError("ENTRY_NOT_FOUND", "invalid source entry id");
      }
      await pool.query("DELETE FROM content_references WHERE source_entry_id = $1", [
        sourceEntryId,
      ]);
    },

    async listInboundReferences(kind, targetId): Promise<InboundReference[]> {
      const result = await pool.query<ReferenceRow>(
        `SELECT source_entry_id, source_path, target_kind, target_id
         FROM content_references
         WHERE target_kind = $1 AND target_id = $2
         ORDER BY source_entry_id, source_path`,
        [kind, targetId],
      );
      return result.rows.map((row) => ({
        sourceEntryId: row.source_entry_id as EntryId,
        sourcePath: row.source_path,
        kind: row.target_kind,
      }));
    },

    async listOutboundReferences(sourceEntryId): Promise<ExtractedReference[]> {
      if (!isStableId(sourceEntryId)) {
        throw new ContentError("ENTRY_NOT_FOUND", "invalid source entry id");
      }
      const result = await pool.query<ReferenceRow>(
        `SELECT source_entry_id, source_path, target_kind, target_id
         FROM content_references
         WHERE source_entry_id = $1
         ORDER BY source_path, target_kind, target_id`,
        [sourceEntryId],
      );
      return result.rows.map((row) => ({
        path: row.source_path,
        kind: row.target_kind,
        targetId: row.target_id as StableId,
      }));
    },

    async checkDeleteImpact(kind, targetId): Promise<DeleteImpactResult> {
      const references = await this.listInboundReferences(kind, targetId);
      const referencingEntries = [
        ...new Set(references.map((reference) => reference.sourceEntryId)),
      ];
      return {
        kind,
        targetId,
        inboundCount: references.length,
        referencingEntries,
        references,
      };
    },
  };
}
