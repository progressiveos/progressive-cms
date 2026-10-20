// Revision store (PCMS-PUB-T002/T003/T004): WORKING/SEALED persistence on
// PostgreSQL. Every function takes a DbClient-or-DbPool executor as its first
// parameter (house pattern from auth's recordSecurityEvent) so the publish
// transaction (T007) can compose revision reads inside its own transaction.
//
// SEALED immutability is enforced by DB triggers (0700_revisions.sql); the
// store never relies on application checks alone.
import { type Clock, type DbClient, type DbPool, newStableId, type StableId } from "@pcms/core";
import { hashCanonicalPayload } from "./canonical.js";
import { RevisionError } from "./errors.js";
import type { VersionedEntityRegistry } from "./registry.js";
import type { RevisionActor, RevisionIssue, RevisionRecord, SealContext } from "./types.js";

/** Resolves the current MediaVersion per referenced asset at seal time
 * (spec §52). Implemented at composition over @pcms/media. */
export interface MediaSnapshotPort {
  resolveCurrentVersions(assetIds: readonly string[]): Promise<Readonly<Record<string, number>>>;
}

export interface CreateWorkingRevisionInput {
  readonly entityType: string;
  readonly entityId: StableId;
  readonly payload: unknown;
  readonly schemaVersion: string;
  readonly locale?: string;
  readonly actor: RevisionActor;
  readonly parentRevisionId?: StableId;
}

export interface UpdateWorkingRevisionInput {
  readonly revisionId: StableId;
  readonly payload: unknown;
  /** Optimistic generation captured by the editor (spec §49/§50). */
  readonly expectedEditGeneration: number;
}

export interface SealRevisionInput {
  readonly revisionId: StableId;
  /** Guard against sealing a concurrently autosaved draft (spec §50). */
  readonly expectedEditGeneration?: number;
  /** Entity-scoped sealed snapshots (e.g. the effective SEO document). */
  readonly sidecar?: Readonly<Record<string, unknown>>;
}

interface RevisionRow {
  [column: string]: unknown;
  id: string;
  entity_type: string;
  entity_id: string;
  revision_no: number;
  parent_revision_id: string | null;
  state: string;
  payload: unknown;
  schema_version: string;
  locale: string;
  origin: string;
  created_by_type: string;
  created_by: string;
  source_run_id: string | null;
  bundle_id: string | null;
  created_at: Date;
  updated_at: Date;
  sealed_at: Date | null;
  edit_generation: number;
  payload_hash: string | null;
  media_versions: Record<string, number> | null;
  sidecar: Record<string, unknown> | null;
}

function toRecord(row: RevisionRow): RevisionRecord {
  return {
    id: row.id as StableId,
    entityType: row.entity_type,
    entityId: row.entity_id as StableId,
    revisionNo: row.revision_no,
    parentRevisionId: (row.parent_revision_id as StableId | null) ?? null,
    state: row.state as RevisionRecord["state"],
    payload: row.payload,
    schemaVersion: row.schema_version,
    locale: row.locale,
    origin: row.origin as RevisionRecord["origin"],
    createdByType: row.created_by_type as RevisionRecord["createdByType"],
    createdBy: row.created_by,
    sourceRunId: row.source_run_id,
    bundleId: row.bundle_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sealedAt: row.sealed_at,
    editGeneration: row.edit_generation,
    payloadHash: row.payload_hash,
    mediaVersions: row.media_versions,
    sidecar: row.sidecar,
  };
}

const REVISION_COLUMNS = `id, entity_type, entity_id, revision_no, parent_revision_id, state,
  payload, schema_version, locale, origin, created_by_type, created_by, source_run_id,
  bundle_id, created_at, updated_at, sealed_at, edit_generation, payload_hash,
  media_versions, sidecar`;

/**
 * Unique-violation check scoped to a constraint/index name: pg errors carry
 * the violated constraint in `constraint`. Mapping every 23505 to
 * REVISION_ALREADY_WORKING would misreport unrelated races (e.g. the
 * per-entity revision_no unique index) as "already has a WORKING revision".
 */
function isUniqueViolationOn(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505" &&
    (error as { constraint?: unknown }).constraint === constraint
  );
}

export interface RevisionStore {
  createWorkingRevision(input: CreateWorkingRevisionInput): Promise<RevisionRecord>;
  /**
   * Transaction-scoped creation (PCMS-API-T013/T017): composes entry inserts,
   * seals and changesets inside one caller-owned transaction.
   */
  createWorkingRevisionWithinTx(
    executor: DbClient | DbPool,
    input: CreateWorkingRevisionInput,
  ): Promise<RevisionRecord>;
  getRevision(executor: DbClient | DbPool, revisionId: StableId): Promise<RevisionRecord | null>;
  requireRevision(executor: DbClient | DbPool, revisionId: StableId): Promise<RevisionRecord>;
  findWorkingRevision(
    executor: DbClient | DbPool,
    entityType: string,
    entityId: StableId,
    locale?: string,
  ): Promise<RevisionRecord | null>;
  listRevisions(
    executor: DbClient | DbPool,
    entityType: string,
    entityId: StableId,
    options?: { readonly limit?: number; readonly offset?: number; readonly locale?: string },
  ): Promise<readonly RevisionRecord[]>;
  /** Autosave: replaces the working payload under optimistic generation CAS. */
  updateWorkingRevision(input: UpdateWorkingRevisionInput): Promise<RevisionRecord>;
  sealRevision(input: SealRevisionInput): Promise<RevisionRecord>;
  /** Transaction-scoped seal (PCMS-API-T017): the bundle composes it. */
  sealRevisionWithinTx(tx: DbClient, input: SealRevisionInput): Promise<RevisionRecord>;
  /** Draft policy: only WORKING revisions can be dropped (spec §5/§77). */
  deleteWorkingRevision(revisionId: StableId): Promise<void>;
  deleteWorkingRevisionWithinTx(tx: DbClient, revisionId: StableId): Promise<void>;
  /**
   * Deletes a WORKING or SEALED revision (2026-09-29, owner request: cleanup
   * of garbage sealed revisions from the Admin/API/CLI/MCP). Policy guards —
   * e.g. "not the currently published revision" — live at the operation
   * layer; the store only guarantees the row is gone and that children stop
   * referencing it (parent_revision_id is provenance metadata, nulled out).
   */
  deleteRevision(revisionId: StableId): Promise<void>;
}

export function createRevisionStore(
  pool: DbPool,
  deps: {
    readonly registry: VersionedEntityRegistry;
    readonly clock: Clock;
    readonly mediaSnapshot?: MediaSnapshotPort;
  },
): RevisionStore {
  const { registry, clock } = deps;

  async function loadForUpdate(tx: DbClient, revisionId: StableId): Promise<RevisionRecord> {
    const result = await tx.query<RevisionRow>(
      `SELECT ${REVISION_COLUMNS} FROM revisions WHERE id = $1 FOR UPDATE`,
      [revisionId],
    );
    if (result.rows.length !== 1) {
      throw new RevisionError("REVISION_NOT_FOUND", `revision ${revisionId} does not exist`, {
        details: { revisionId },
      });
    }
    return toRecord(result.rows[0]!);
  }

  async function insertWorkingRevision(
    executor: DbClient | DbPool,
    input: CreateWorkingRevisionInput,
  ): Promise<RevisionRecord> {
    registry.get(input.entityType); // REVISION_ENTITY_UNKNOWN for unregistered types
    const revisionNoRow = await executor.query<{ next: number }>(
      `SELECT COALESCE(MAX(revision_no), 0) + 1 AS next FROM revisions
         WHERE entity_type = $1 AND entity_id = $2`,
      [input.entityType, input.entityId],
    );
    const revisionNo = revisionNoRow.rows[0]?.next;
    const id = newStableId();
    const now = clock.now();
    try {
      const inserted = await executor.query<RevisionRow>(
        `INSERT INTO revisions
             (id, entity_type, entity_id, revision_no, parent_revision_id, state, payload,
              schema_version, locale, origin, created_by_type, created_by, source_run_id,
              bundle_id, created_at, updated_at, edit_generation)
           VALUES ($1, $2, $3, $4, $5, 'WORKING', $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, 0)
           RETURNING ${REVISION_COLUMNS}`,
        [
          id,
          input.entityType,
          input.entityId,
          revisionNo,
          input.parentRevisionId ?? null,
          JSON.stringify(input.payload),
          input.schemaVersion,
          input.locale ?? "default",
          input.actor.origin,
          input.actor.actorClass,
          input.actor.actorId,
          input.actor.sourceRunId ?? null,
          input.actor.bundleId ?? null,
          now,
        ],
      );
      return toRecord(inserted.rows[0]!);
    } catch (error) {
      // 0700_revisions.sql: `revisions_working_per_entity_idx` is the unique
      // index backing "one WORKING revision per entity identity/context".
      // Any other 23505 (primary key, revision_no monotonicity race) is not
      // a working-conflict and propagates unchanged.
      if (isUniqueViolationOn(error, "revisions_working_per_entity_idx")) {
        throw new RevisionError(
          "REVISION_ALREADY_WORKING",
          `entity ${input.entityType}/${input.entityId} already has a WORKING revision`,
          { details: { entityType: input.entityType, entityId: input.entityId }, cause: error },
        );
      }
      throw error;
    }
  }

  async function deleteWorkingWithinTx(tx: DbClient, revisionId: StableId): Promise<void> {
    const record = await loadForUpdate(tx, revisionId);
    if (record.state !== "WORKING")
      throw new RevisionError(
        "REVISION_NOT_WORKING",
        `revision ${revisionId} is ${record.state}; only WORKING revisions can be deleted`,
      );
    await tx.query(`DELETE FROM revisions WHERE id = $1`, [revisionId]);
  }

  return {
    async createWorkingRevision(input) {
      return insertWorkingRevision(pool, input);
    },

    async createWorkingRevisionWithinTx(executor, input) {
      return insertWorkingRevision(executor, input);
    },

    async getRevision(executor, revisionId) {
      const result = await executor.query<RevisionRow>(
        `SELECT ${REVISION_COLUMNS} FROM revisions WHERE id = $1`,
        [revisionId],
      );
      return result.rows.length === 1 ? toRecord(result.rows[0]!) : null;
    },

    async requireRevision(executor, revisionId) {
      const record = await this.getRevision(executor, revisionId);
      if (record === null) {
        throw new RevisionError("REVISION_NOT_FOUND", `revision ${revisionId} does not exist`, {
          details: { revisionId },
        });
      }
      return record;
    },

    async findWorkingRevision(executor, entityType, entityId, locale = "default") {
      const result = await executor.query<RevisionRow>(
        `SELECT ${REVISION_COLUMNS} FROM revisions
         WHERE entity_type = $1 AND entity_id = $2 AND locale = $3 AND state = 'WORKING'`,
        [entityType, entityId, locale],
      );
      return result.rows.length === 1 ? toRecord(result.rows[0]!) : null;
    },

    async listRevisions(executor, entityType, entityId, options) {
      const limit = Math.min(options?.limit ?? 100, 1000);
      const offset = Math.max(options?.offset ?? 0, 0);
      const result = await executor.query<RevisionRow>(
        `SELECT ${REVISION_COLUMNS} FROM revisions
         WHERE entity_type = $1 AND entity_id = $2 AND ($5::text IS NULL OR locale = $5)
         ORDER BY revision_no DESC
         LIMIT $3 OFFSET $4`,
        [entityType, entityId, limit, offset, options?.locale ?? null],
      );
      return result.rows.map(toRecord);
    },

    async updateWorkingRevision(input) {
      const now = clock.now();
      const updated = await pool.query<RevisionRow>(
        `UPDATE revisions
         SET payload = $2, edit_generation = edit_generation + 1, updated_at = $3
         WHERE id = $1 AND state = 'WORKING' AND edit_generation = $4
         RETURNING ${REVISION_COLUMNS}`,
        [input.revisionId, JSON.stringify(input.payload), now, input.expectedEditGeneration],
      );
      if (updated.rows.length === 1) return toRecord(updated.rows[0]!);
      // Distinguish the three failure causes for stable codes.
      const current = await this.getRevision(pool, input.revisionId);
      if (current === null) {
        throw new RevisionError(
          "REVISION_NOT_FOUND",
          `revision ${input.revisionId} does not exist`,
        );
      }
      if (current.state !== "WORKING") {
        throw new RevisionError(
          "REVISION_NOT_WORKING",
          `revision ${input.revisionId} is ${current.state}; only WORKING revisions are editable`,
        );
      }
      throw new RevisionError(
        "REVISION_STALE",
        `edit generation ${input.expectedEditGeneration} is stale (current ${current.editGeneration})`,
        { details: { expected: input.expectedEditGeneration, current: current.editGeneration } },
      );
    },

    async sealRevision(input) {
      const now = clock.now();
      return pool.withTransaction(async (tx) => sealWithinTx(tx, input, now));
    },

    async sealRevisionWithinTx(tx, input) {
      return sealWithinTx(tx, input, clock.now());
    },

    deleteWorkingRevisionWithinTx: deleteWorkingWithinTx,
    deleteWorkingRevision: (revisionId) =>
      pool.withTransaction((tx) => deleteWorkingWithinTx(tx, revisionId)),

    async deleteRevision(revisionId) {
      await pool.withTransaction(async (tx) => {
        const record = await loadForUpdate(tx, revisionId);
        // Opt in past revisions_sealed_delete_guard (migration 1714): this
        // transaction IS the sanctioned cleanup path; the setting is
        // transaction-local and invisible to anything else.
        await tx.query(`SET LOCAL pcms.allow_sealed_delete = 'on'`);
        // Detach children first: parent_revision_id is provenance only, and
        // its FK must not block cleanup of a branched-from sealed revision.
        await tx.query(
          `UPDATE revisions SET parent_revision_id = NULL WHERE parent_revision_id = $1`,
          [revisionId],
        );
        await tx.query(`DELETE FROM revisions WHERE id = $1`, [revisionId]);
      });
    },
  };

  async function sealWithinTx(
    tx: DbClient,
    input: SealRevisionInput,
    now: Date,
  ): Promise<RevisionRecord> {
    {
      const record = await loadForUpdate(tx, input.revisionId);
      if (record.state !== "WORKING") {
        throw new RevisionError(
          "REVISION_NOT_WORKING",
          `revision ${input.revisionId} is ${record.state}; only WORKING revisions can be sealed`,
        );
      }
      if (
        input.expectedEditGeneration !== undefined &&
        input.expectedEditGeneration !== record.editGeneration
      ) {
        throw new RevisionError(
          "REVISION_STALE",
          `edit generation ${input.expectedEditGeneration} is stale (current ${record.editGeneration})`,
          {
            details: {
              expected: input.expectedEditGeneration,
              current: record.editGeneration,
            },
          },
        );
      }

      const adapter = registry.get(record.entityType);
      const context: SealContext = {
        entityType: record.entityType,
        entityId: record.entityId,
        locale: record.locale,
        revisionState: record.state,
        executor: tx,
      };
      const issues: readonly RevisionIssue[] = await adapter.validateForSeal(
        record.payload,
        context,
      );
      const errors = issues.filter((issue) => issue.severity !== "warning");
      if (errors.length > 0) {
        throw new RevisionError(
          "REVISION_VALIDATION_FAILED",
          `revision ${input.revisionId} failed seal validation with ${errors.length} error(s)`,
          { details: { issues } },
        );
      }

      const canonical = adapter.canonicalize
        ? adapter.canonicalize(record.payload)
        : record.payload;
      const payloadHash = hashCanonicalPayload(canonical);

      const assetIds = adapter.extractMediaAssetIds
        ? await adapter.extractMediaAssetIds(canonical, context)
        : [];
      let mediaVersions: Record<string, number> | null = null;
      if (assetIds.length > 0) {
        if (!deps.mediaSnapshot) {
          throw new RevisionError(
            "MEDIA_NOT_READY",
            `entity type "${record.entityType}" references media but no media snapshot port is wired`,
          );
        }
        mediaVersions = { ...(await deps.mediaSnapshot.resolveCurrentVersions(assetIds)) };
        for (const assetId of assetIds) {
          if (mediaVersions[assetId] === undefined) {
            throw new RevisionError(
              "MEDIA_NOT_READY",
              `media asset ${assetId} referenced by revision ${input.revisionId} does not exist`,
              { details: { assetId } },
            );
          }
        }
      }

      if (input.sidecar !== undefined) hashCanonicalPayload(input.sidecar); // serializability guard

      const sealed = await tx.query<RevisionRow>(
        `UPDATE revisions
           SET state = 'SEALED', payload = $2, payload_hash = $3, sealed_at = $4,
               media_versions = $5::jsonb, sidecar = $6::jsonb, updated_at = $4
           WHERE id = $1
           RETURNING ${REVISION_COLUMNS}`,
        [
          input.revisionId,
          JSON.stringify(canonical),
          payloadHash,
          now,
          mediaVersions === null ? null : JSON.stringify(mediaVersions),
          input.sidecar === undefined ? null : JSON.stringify(input.sidecar),
        ],
      );
      return toRecord(sealed.rows[0]!);
    }
  }
}
