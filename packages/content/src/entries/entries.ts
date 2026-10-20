// `entries` domain + application service (PCMS-CONT-T003; Content spec §5/§7/§82).
//
// `entries` is the durable identity of a content material: id, content type,
// Content Tree parent and archive state. Mutable content lives in revisions
// (Publication spec, M07) and is never duplicated here (Content spec §5).
// Plain SQL over the core pool, no ORM (ADR-0002); the service is the only
// public way for other packages to touch `entries` rows (Content spec §82).
import type { DbClient, DbPool } from "@pcms/core";
import { ContentError } from "../errors.js";
import { type EntryId, isStableId, newEntryId } from "../ids/stable-id.js";

/**
 * Structural role of an entry (single source of truth — never derive it from
 * `content_type_id`): `content` is a publishable material, `folder` is an
 * editorial-tree grouping node only (no route/publication/SEO/search/
 * translation surface; application layer rejects those with
 * ENTRY_KIND_FORBIDDEN).
 */
export type EntryKind = "content" | "folder";
export const ENTRY_KINDS: readonly EntryKind[] = ["content", "folder"];

/** A durable content material identity (Content spec §5). */
export interface EntryRecord {
  readonly id: EntryId;
  readonly contentTypeId: string;
  readonly entryKind: EntryKind;
  /**
   * Theme template assignment (Theme Contract §12): null = compatible default.
   * Validated against the active theme at assignment; the sealed revision
   * sidecar snapshots it for publication safety.
   */
  readonly templateKey: string | null;
  readonly parentEntryId: EntryId | null;
  /** Opaque actor reference (Auth identity arrives with M08). */
  readonly createdBy: string;
  readonly createdAt: Date;
  /** Non-null once archived; archive is never a hard delete (Content spec §7). */
  readonly archivedAt: Date | null;
  /**
   * Locale of this entry ("default" sentinel for single-language content,
   * a BCP-47 code for secondary translations). Validated by callers against
   * the site localization settings; this package only checks the shape.
   */
  readonly locale: string;
  /**
   * Translation group anchor (opt-in multilingual): all language versions of
   * one logical content entity share it. Null = the entry is its own group
   * (COALESCE(translation_group_id, id)).
   */
  readonly translationGroupId: EntryId | null;
}

export interface CreateEntryInput {
  /** Stable ContentType key (e.g. "page"). */
  readonly contentTypeId: string;
  /** Structural role; defaults to "content" (backward-compatible). */
  readonly entryKind?: EntryKind;
  /** Theme template assignment; null/omitted = compatible default. */
  readonly templateKey?: string | null;
  /** Opaque actor reference of the creator. */
  readonly createdBy: string;
  /** Optional Content Tree parent; the new Entry cannot be its own ancestor. */
  readonly parentEntryId?: EntryId | null;
  /**
   * Caller-supplied stable identity for idempotent creation (Content spec §84).
   * Defaults to a freshly generated UUIDv7 (PCMS-CONT-T002).
   */
  readonly id?: EntryId;
  /** Locale tag ("default" sentinel or BCP-47); shape-validated only. */
  readonly locale?: string;
  /** Translation group anchor when creating a translation of another entry. */
  readonly translationGroupId?: EntryId | null;
}

interface EntryRow extends Record<string, unknown> {
  id: string;
  content_type_id: string;
  entry_kind: string;
  template_key: string | null;
  parent_entry_id: string | null;
  created_by: string;
  created_at: Date;
  archived_at: Date | null;
  locale: string;
  translation_group_id: string | null;
}

/** Locale tags: the "default" sentinel or a BCP-47 tag (shape check only). */
const LOCALE_RE = /^(default|[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/;
const ENTRY_COLUMNS =
  "id, content_type_id, entry_kind, template_key, parent_entry_id, created_by, created_at, archived_at, locale, translation_group_id";

function toRecord(row: EntryRow): EntryRecord {
  return {
    id: row.id as EntryId,
    contentTypeId: row.content_type_id,
    entryKind: (row.entry_kind as EntryKind) ?? "content",
    templateKey: row.template_key ?? null,
    parentEntryId: (row.parent_entry_id as EntryId | null) ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    locale: row.locale,
    translationGroupId: (row.translation_group_id as EntryId | null) ?? null,
  };
}

export interface EntriesService {
  /** Creates an Entry and returns the persisted record (stable identity). */
  createEntry(input: CreateEntryInput): Promise<EntryRecord>;
  /**
   * Transaction-scoped creation (PCMS-API-T013/T017): composes with other
   * subsystem writes inside one caller-owned transaction (bundle atomicity,
   * Content spec §84 idempotent identity preserved).
   */
  createEntryWithinTx(executor: DbClient | DbPool, input: CreateEntryInput): Promise<EntryRecord>;
  /** Marks the Entry archived (idempotent); never deletes rows (Content spec §7). */
  archiveEntry(id: EntryId): Promise<EntryRecord>;
  /** Clears the archive flag (PCMS-ADMIN-T003; Admin spec §5 "restore"). */
  restoreEntry(id: EntryId): Promise<EntryRecord>;
  /** Returns the Entry regardless of archive state; throws ENTRY_NOT_FOUND. */
  getEntry(id: EntryId): Promise<EntryRecord>;
  /** Returns the Entry or null; same semantics as getEntry without throwing. */
  findEntry(id: EntryId): Promise<EntryRecord | null>;
  /** Transaction-scoped read (PCMS-API-T017): sees rows created in `executor`. */
  findEntryWithinTx(executor: DbClient | DbPool, id: EntryId): Promise<EntryRecord | null>;
  /**
   * Updates the theme template assignment (callers validate compatibility
   * against the active theme). Null clears back to the compatible default.
   */
  updateTemplateKey(id: EntryId, templateKey: string | null): Promise<EntryRecord>;
  /**
   * Identity repair (owner 2026-10-06, site-agent /privacy/ case): moves the
   * entry and its WORKING revisions to the target identity locale in one
   * transaction. Entry id, routes, publication pointers, payloads and edit
   * generations are untouched. SEALED revisions are immutable (Publication
   * spec §6) and keep their original locale — the seal contract only
   * compares the revision being sealed, and publish does not check locale.
   * Callers validate the target against the site localization policy and
   * audit; throws ENTRY_NOT_FOUND / LOCALE_INVALID.
   */
  reidentifyLocale(
    id: EntryId,
    locale: string,
  ): Promise<{ entry: EntryRecord; revisionsAdopted: number }>;
  /**
   * Translation group members (opt-in multilingual): every entry sharing
   * this entry's group, including the entry itself when its locale matches.
   * Ordered by locale for stable display.
   */
  listTranslations(entryId: EntryId): Promise<
    ReadonlyArray<{
      readonly id: EntryId;
      readonly locale: string;
      readonly archivedAt: Date | null;
    }>
  >;
  /**
   * The translation of `entryId`'s logical entity in `locale` — the entry
   * itself when its locale matches, otherwise the group sibling. Null when
   * that language version does not exist.
   */
  findTranslation(
    entryId: EntryId,
    locale: string,
  ): Promise<{ readonly id: EntryId; readonly locale: string } | null>;
}

export function createEntriesService(pool: DbPool): EntriesService {
  async function findEntryWithinTx(
    executor: DbClient | DbPool,
    id: EntryId,
  ): Promise<EntryRecord | null> {
    if (!isStableId(id)) throw new ContentError("ENTRY_NOT_FOUND", `invalid entry id`);
    const result = await executor.query<EntryRow>(
      `SELECT ${ENTRY_COLUMNS} FROM entries WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async function insertEntry(
    executor: DbClient | DbPool,
    input: CreateEntryInput,
  ): Promise<EntryRecord> {
    if (input.contentTypeId.length === 0) {
      throw new ContentError("CONTENT_TYPE_REQUIRED", "contentTypeId must be a non-empty key");
    }
    if (input.createdBy.length === 0) {
      throw new ContentError(
        "CREATED_BY_REQUIRED",
        "createdBy must be a non-empty actor reference",
      );
    }
    const id = input.id ?? newEntryId();
    if (!isStableId(id)) throw new ContentError("ENTRY_ID_INVALID", "entry id must be a stable ID");
    const parent = input.parentEntryId ?? null;
    if (parent !== null && !isStableId(parent)) {
      throw new ContentError("PARENT_NOT_FOUND", "parent entry id must be a stable ID");
    }
    const locale = input.locale ?? "default";
    if (!LOCALE_RE.test(locale)) {
      throw new ContentError("LOCALE_INVALID", `locale ${locale} is not a valid tag`);
    }
    const group = input.translationGroupId ?? null;
    if (group !== null && !isStableId(group)) {
      throw new ContentError("PARENT_NOT_FOUND", "translation group anchor must be a stable ID");
    }
    const kind = input.entryKind ?? "content";
    if (!ENTRY_KINDS.includes(kind)) {
      throw new ContentError("ENTRY_KIND_INVALID", `entry kind "${kind}" is unknown`);
    }
    const templateKey = input.templateKey ?? null;
    const inserted = await executor.query<EntryRow>(
      `INSERT INTO entries (id, content_type_id, entry_kind, template_key, parent_entry_id, created_by, locale, translation_group_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${ENTRY_COLUMNS}`,
      [id, input.contentTypeId, kind, templateKey, parent, input.createdBy, locale, group],
    );
    return toRecord(inserted.rows[0] as EntryRow);
  }

  return {
    async createEntry(input: CreateEntryInput): Promise<EntryRecord> {
      try {
        return await insertEntry(pool, input);
      } catch (error) {
        throw mapConstraintError(error);
      }
    },

    async createEntryWithinTx(executor, input): Promise<EntryRecord> {
      try {
        return await insertEntry(executor, input);
      } catch (error) {
        throw mapConstraintError(error);
      }
    },

    async archiveEntry(id: EntryId): Promise<EntryRecord> {
      if (!isStableId(id)) throw new ContentError("ENTRY_NOT_FOUND", `invalid entry id`);
      // Idempotent: re-archiving keeps the original archived_at (§7 semantics —
      // "no longer actively edited", not a state machine to re-enter).
      const updated = await pool.query<EntryRow>(
        `UPDATE entries SET archived_at = now()
         WHERE id = $1 AND archived_at IS NULL
         RETURNING ${ENTRY_COLUMNS}`,
        [id],
      );
      const row = updated.rows[0];
      if (row !== undefined) return toRecord(row);
      const existing = await this.findEntry(id);
      if (existing === null) throw new ContentError("ENTRY_NOT_FOUND", `entry ${id} not found`);
      return existing;
    },

    async reidentifyLocale(
      id: EntryId,
      locale: string,
    ): Promise<{ entry: EntryRecord; revisionsAdopted: number }> {
      if (!LOCALE_RE.test(locale)) {
        throw new ContentError("LOCALE_INVALID", `locale ${locale} is not a valid tag`);
      }
      return pool.withTransaction(async (tx) => {
        const current = await tx.query<EntryRow>(
          `SELECT ${ENTRY_COLUMNS} FROM entries WHERE id = $1`,
          [id],
        );
        const entry = current.rows[0];
        if (entry === undefined) {
          throw new ContentError("ENTRY_NOT_FOUND", `entry ${id} does not exist`);
        }
        await tx.query(`UPDATE entries SET locale = $2 WHERE id = $1`, [id, locale]);
        // Adopt the WORKING revisions only: SEALED rows are immutable
        // (0700_revisions trigger, Publication spec §6) and keep their
        // original locale — history stays truthful, the seal contract
        // (revision.locale vs entry.locale) applies to the revision being
        // sealed, and publish does not compare locales.
        const adopted = await tx.query(
          `UPDATE revisions SET locale = $2
           WHERE entity_type = 'entry' AND entity_id = $1
             AND state = 'WORKING' AND locale <> $2`,
          [id, locale],
        );
        const after = await tx.query<EntryRow>(
          `SELECT ${ENTRY_COLUMNS} FROM entries WHERE id = $1`,
          [id],
        );
        return { entry: toRecord(after.rows[0]!), revisionsAdopted: adopted.rowCount ?? 0 };
      });
    },

    async updateTemplateKey(id: EntryId, templateKey: string | null): Promise<EntryRecord> {
      if (!isStableId(id)) throw new ContentError("ENTRY_NOT_FOUND", `invalid entry id`);
      const updated = await pool.query<EntryRow>(
        `UPDATE entries SET template_key = $2 WHERE id = $1 RETURNING ${ENTRY_COLUMNS}`,
        [id, templateKey],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new ContentError("ENTRY_NOT_FOUND", `entry ${id} not found`);
      return toRecord(row);
    },

    async restoreEntry(id: EntryId): Promise<EntryRecord> {
      if (!isStableId(id)) throw new ContentError("ENTRY_NOT_FOUND", `invalid entry id`);
      // Idempotent mirror of archiveEntry: restoring an active entry is a no-op.
      const updated = await pool.query<EntryRow>(
        `UPDATE entries SET archived_at = NULL
         WHERE id = $1 AND archived_at IS NOT NULL
         RETURNING ${ENTRY_COLUMNS}`,
        [id],
      );
      const row = updated.rows[0];
      if (row !== undefined) return toRecord(row);
      return this.getEntry(id);
    },

    findEntryWithinTx,

    async findEntry(id: EntryId): Promise<EntryRecord | null> {
      return findEntryWithinTx(pool, id);
    },

    getEntry(id: EntryId): Promise<EntryRecord> {
      return this.findEntry(id).then((entry) => {
        if (entry === null) throw new ContentError("ENTRY_NOT_FOUND", `entry ${id} not found`);
        return entry;
      });
    },

    async listTranslations(entryId) {
      if (!isStableId(entryId)) throw new ContentError("ENTRY_NOT_FOUND", `invalid entry id`);
      const result = await pool.query<EntryRow>(
        `SELECT ${ENTRY_COLUMNS} FROM entries
         WHERE COALESCE(translation_group_id, id) =
               (SELECT COALESCE(translation_group_id, id) FROM entries WHERE id = $1)
         ORDER BY locale`,
        [entryId],
      );
      return result.rows.map((row) => ({
        id: row.id as EntryId,
        locale: row.locale,
        archivedAt: row.archived_at,
      }));
    },

    async findTranslation(entryId, locale) {
      if (!isStableId(entryId)) throw new ContentError("ENTRY_NOT_FOUND", `invalid entry id`);
      const result = await pool.query<{ id: string }>(
        `SELECT id FROM entries
         WHERE COALESCE(translation_group_id, id) =
               (SELECT COALESCE(translation_group_id, id) FROM entries WHERE id = $1)
           AND locale = $2 AND archived_at IS NULL
         ORDER BY id LIMIT 1`,
        [entryId, locale],
      );
      const row = result.rows[0];
      return row === undefined ? null : { id: row.id as EntryId, locale };
    },
  };
}

/** Maps PostgreSQL constraint violations to stable ContentError codes. */
function mapConstraintError(error: unknown): ContentError {
  if (error instanceof ContentError) return error; // validation errors pass through
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505") {
    return new ContentError("ENTRY_ALREADY_EXISTS", "an entry with this id already exists", {
      cause: error,
    });
  }
  if (code === "23503") {
    return new ContentError("PARENT_NOT_FOUND", "parent entry does not exist", { cause: error });
  }
  return new ContentError("ENTRY_PERSISTENCE_FAILED", "could not persist entry", {
    cause: error,
  });
}
