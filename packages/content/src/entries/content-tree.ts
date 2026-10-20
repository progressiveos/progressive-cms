// Content Tree parent model + cycle protection (PCMS-CONT-T004; Content spec §6).
//
// `parent_entry_id` forms the Content Tree — the information hierarchy of
// materials. It is an independent model: moving an Entry here never rewrites
// Navigation Items or URLs (those are Navigation/Routing concerns, M04).
// Cycle protection is mandatory: a parent cycle would break breadcrumbs,
// subtree queries and every tree walk, so `moveEntry` verifies the new parent
// chain inside the update transaction.
import type { DbPool } from "@pcms/core";
import { ContentError } from "../errors.js";
import { type EntryId, isStableId } from "../ids/stable-id.js";

/**
 * Termination bound for ancestor walks. A legitimate Content Tree never
 * approaches this depth; hitting it during a move means the chain is cyclic
 * (corruption) and is reported as a cycle.
 */
export const TREE_WALK_LIMIT = 256;

export interface ContentTreeService {
  /**
   * Returns the ancestor chain of `id`, root first, excluding the entry
   * itself. Throws ENTRY_NOT_FOUND when the entry does not exist.
   */
  getAncestors(id: EntryId): Promise<EntryId[]>;
  /**
   * Reparents `id` under `newParentId` (null = root). Rejects self-parenting
   * and any move that would place the entry inside its own subtree.
   */
  moveEntry(id: EntryId, newParentId: EntryId | null): Promise<void>;
}

export function createContentTreeService(pool: DbPool): ContentTreeService {
  async function getAncestors(id: EntryId): Promise<EntryId[]> {
    if (!isStableId(id)) throw new ContentError("ENTRY_NOT_FOUND", `invalid entry id`);
    // Bounded recursive walk; the entry sits at depth 0 and each ancestor one
    // level up, so the root has the highest depth — order DESC for root-first.
    const result = await pool.query<{ id: string; depth: number }>(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_entry_id, 0 AS depth
         FROM entries WHERE id = $1
         UNION ALL
         SELECT e.id, e.parent_entry_id, c.depth + 1
         FROM entries e
         JOIN chain c ON e.id = c.parent_entry_id
         WHERE c.depth < $2
       )
       SELECT id, depth FROM chain WHERE id <> $1 ORDER BY depth DESC`,
      [id, TREE_WALK_LIMIT],
    );
    return result.rows.map((row) => row.id as EntryId);
  }

  return {
    getAncestors,

    async moveEntry(id: EntryId, newParentId: EntryId | null): Promise<void> {
      if (!isStableId(id)) throw new ContentError("ENTRY_NOT_FOUND", `invalid entry id`);
      if (newParentId !== null && !isStableId(newParentId)) {
        throw new ContentError("PARENT_NOT_FOUND", "parent entry id must be a stable ID");
      }
      if (newParentId === id) {
        throw new ContentError("ENTRY_CYCLE", "an entry cannot be its own parent");
      }
      // Check + update in one transaction so a concurrent reparent of the new
      // parent chain cannot slip a cycle between check and write.
      await pool.withTransaction(async (tx) => {
        const self = await tx.query<{ id: string }>("SELECT id FROM entries WHERE id = $1", [id]);
        if (self.rows.length === 0)
          throw new ContentError("ENTRY_NOT_FOUND", `entry ${id} not found`);

        if (newParentId !== null) {
          const parent = await tx.query<{ id: string }>("SELECT id FROM entries WHERE id = $1", [
            newParentId,
          ]);
          if (parent.rows.length === 0) {
            throw new ContentError("PARENT_NOT_FOUND", `parent entry ${newParentId} not found`);
          }
          // Walk from the new parent upwards; meeting the moved entry means
          // the entry would become an ancestor of itself.
          const result = await tx.query<{ id: string; depth: number }>(
            `WITH RECURSIVE chain AS (
               SELECT id, parent_entry_id, 0 AS depth
               FROM entries WHERE id = $2
               UNION ALL
               SELECT e.id, e.parent_entry_id, c.depth + 1
               FROM entries e
               JOIN chain c ON e.id = c.parent_entry_id
               WHERE c.depth < $3
             )
             SELECT id, depth FROM chain WHERE id = $1`,
            [id, newParentId, TREE_WALK_LIMIT],
          );
          if (result.rows.length > 0) {
            throw new ContentError(
              "ENTRY_CYCLE",
              `cannot move entry ${id} under its own descendant ${newParentId}`,
            );
          }
        }

        await tx.query("UPDATE entries SET parent_entry_id = $2 WHERE id = $1", [id, newParentId]);
      });
    },
  };
}
