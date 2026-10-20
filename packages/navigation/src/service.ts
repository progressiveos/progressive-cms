// Navigation sets, working tree and revision snapshots (PCMS-NAV-T002;
// Navigation spec §3/§4/§13/§56).
//
// The working rows in `navigation_items` are the draft tree; `sealRevision`
// freezes an immutable snapshot into `navigation_revisions` — the
// revision-facing contract M07's publication machinery adopts. Plain SQL on
// the core pool, no ORM (ADR-0002). Tree reads load all items of a set in
// one query and nest in memory — no N+1 per item (spec §67).
import { type DbPool, isStableId, newStableId } from "@pcms/core";
import { NavigationError } from "./errors.js";
import {
  type ActionUiIntent,
  DEFAULT_MAX_TREE_DEPTH,
  MAX_ITEMS_PER_SET,
  NAVIGATION_ITEM_TYPES,
  type NavigationItemNode,
  type NavigationItemTarget,
  type NavigationItemType,
  type NavigationOverrideOp,
  type NavigationOverrideRecord,
  type NavigationRevisionRecord,
  type NavigationSetRecord,
} from "./model.js";
import { applyOverrides } from "./overrides.js";
import { itemPayloadIssues, validateItemInput } from "./validate.js";

const OVERRIDE_OPS: readonly NavigationOverrideOp[] = [
  "hide",
  "show",
  "relabel",
  "reorder",
  "move",
  "insert",
  "replace_target",
];

export interface AddNavigationOverrideInput {
  /** Derived set owning the override (must have derivedFromSetId). */
  readonly setId: string;
  /** Base Item ID the override addresses (spec §18). */
  readonly targetItemId: string;
  readonly op: NavigationOverrideOp;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface CreateNavigationSetInput {
  /** Unique live-set key, e.g. "main" or "footer-legal" (spec §3). */
  readonly key: string;
  readonly title: string;
  /** Derive from an existing set instead of copying its tree (spec §17). */
  readonly derivedFromSetId?: string | null;
}

export interface InsertNavigationItemInput {
  readonly setId: string;
  /** Parent item; null = root of the set. */
  readonly parentItemId?: string | null;
  readonly type: NavigationItemType;
  readonly label?: string | null;
  readonly target?: NavigationItemTarget;
  /** Presentation hint for `action` items (spec §11); null elsewhere. */
  readonly uiIntent?: ActionUiIntent | null;
  /** 0-based sibling position; default appends after existing siblings. */
  readonly at?: number | null;
}

/**
 * Termination bound for every recursive tree walk in this module. A
 * legitimate navigation tree never approaches this depth; hitting the bound
 * means the parent chain is cyclic (corruption) — without it the recursive
 * CTEs would loop forever on such a cycle.
 */
const NAV_TREE_WALK_LIMIT = 64;

const SET_KEY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

interface ItemRow extends Record<string, unknown> {
  id: string;
  set_id: string;
  parent_item_id: string | null;
  sibling_order: number;
  item_type: string;
  label: string | null;
  target: unknown;
  ui_intent: string | null;
}

interface SetRow extends Record<string, unknown> {
  id: string;
  key: string;
  title: string;
  derived_from_set_id: string | null;
  created_at: Date;
  archived_at: Date | null;
}

interface RevisionRow extends Record<string, unknown> {
  id: string;
  set_id: string;
  revision: number;
  payload: unknown;
  created_at: Date;
}

interface OverrideRow extends Record<string, unknown> {
  id: string;
  set_id: string;
  target_item_id: string;
  op: string;
  payload: unknown;
  apply_order: number;
  created_at: Date;
}

function toOverrideRecord(row: OverrideRow | undefined): NavigationOverrideRecord {
  if (row === undefined) {
    throw new NavigationError("NAV_OVERRIDE_NOT_FOUND", `override row missing`);
  }
  return {
    id: row.id,
    setId: row.set_id,
    targetItemId: row.target_item_id,
    op: row.op as NavigationOverrideOp,
    payload: (row.payload ?? {}) as Readonly<Record<string, unknown>>,
    order: row.apply_order,
    createdAt: row.created_at,
  };
}

/**
 * Payload shape validation per override op, applied at authoring time so
 * malformed overrides never enter the ledger. `insert` items get their
 * stable Item ID assigned here (payload item id), `replace_target` is
 * validated against the base item's type.
 */
function validateOverridePayload(
  op: NavigationOverrideOp,
  payload: Readonly<Record<string, unknown>>,
  baseItemType: string,
): Readonly<Record<string, unknown>> {
  switch (op) {
    case "hide":
    case "show":
      return {};
    case "relabel": {
      const label = payload.label;
      if (typeof label !== "string" || label.length === 0 || label.length > 200) {
        throw new NavigationError("NAV_OVERRIDE_INVALID", `relabel payload needs "label" (1..200)`);
      }
      return { label };
    }
    case "reorder": {
      const at = payload.at;
      if (typeof at !== "number" || !Number.isInteger(at) || at < 0) {
        throw new NavigationError(
          "NAV_OVERRIDE_INVALID",
          `reorder payload needs integer "at" >= 0`,
        );
      }
      return { at };
    }
    case "move": {
      const parent = payload.parent_item_id;
      if (parent !== null && parent !== undefined && typeof parent !== "string") {
        throw new NavigationError(
          "NAV_OVERRIDE_INVALID",
          `move payload needs parent_item_id or null`,
        );
      }
      const at = payload.at;
      if (
        at !== undefined &&
        at !== null &&
        (typeof at !== "number" || !Number.isInteger(at) || at < 0)
      ) {
        throw new NavigationError(
          "NAV_OVERRIDE_INVALID",
          `move payload "at" must be an integer >= 0`,
        );
      }
      return { parent_item_id: parent ?? null, at: at ?? null };
    }
    case "insert": {
      const item = payload.item as Record<string, unknown> | undefined;
      if (item === undefined || typeof item !== "object") {
        throw new NavigationError("NAV_OVERRIDE_INVALID", `insert payload needs "item"`);
      }
      const validated = validateItemInput({
        type: item.type as NavigationItemType,
        label: (item.label as string | null) ?? null,
        target: (item.target as NavigationItemTarget) ?? null,
        uiIntent: (item.ui_intent as ActionUiIntent | null) ?? null,
      });
      return {
        item: {
          id: (typeof item.id === "string" && isStableId(item.id)
            ? item.id
            : newStableId()) as string,
          type: validated.type,
          label: validated.label,
          target: validated.target,
          ui_intent: validated.uiIntent,
        },
        parent_item_id:
          payload.parent_item_id === null || payload.parent_item_id === undefined
            ? null
            : payload.parent_item_id,
        at: payload.at ?? null,
      };
    }
    case "replace_target": {
      if (payload.target === undefined || payload.target === null) {
        throw new NavigationError("NAV_OVERRIDE_INVALID", `replace_target payload needs "target"`);
      }
      const issues = itemPayloadIssues(
        baseItemType as NavigationItemType,
        payload.target as NavigationItemTarget,
        null,
        null,
      );
      // Label-bearing types keep their base label; only the target is replaced.
      const relevant = issues.filter((issue) => issue !== "label");
      if (relevant.length > 0) {
        throw new NavigationError(
          "NAV_OVERRIDE_INVALID",
          `replacement target does not fit the item type`,
          {
            details: { issues: relevant },
          },
        );
      }
      return { target: payload.target };
    }
  }
}

function toSetRecord(row: SetRow): NavigationSetRecord {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    derivedFromSetId: row.derived_from_set_id,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

/** Mutable build shape; structurally a NavigationItemNode once returned. */
interface BuildNode {
  id: string;
  type: NavigationItemType;
  label: string | null;
  target: NavigationItemTarget;
  visibility: "always";
  uiIntent: ActionUiIntent | null;
  children: BuildNode[];
}

function toNode(row: ItemRow | undefined): BuildNode {
  if (row === undefined) throw new NavigationError("NAV_ITEM_NOT_FOUND", `item row missing`);
  if (!NAVIGATION_ITEM_TYPES.includes(row.item_type as NavigationItemType)) {
    throw new NavigationError("NAV_ITEM_TYPE_INVALID", `unknown stored item type`, {
      details: { item_id: row.id, item_type: row.item_type },
    });
  }
  return {
    id: row.id,
    type: row.item_type as NavigationItemType,
    label: row.label,
    target: (row.target ?? null) as NavigationItemTarget,
    visibility: "always",
    uiIntent: (row.ui_intent as ActionUiIntent | null) ?? null,
    children: [],
  };
}

function toRevisionRecord(row: RevisionRow | undefined): NavigationRevisionRecord {
  if (row === undefined)
    throw new NavigationError("NAV_REVISION_NOT_FOUND", `revision row missing`);
  return {
    id: row.id,
    setId: row.set_id,
    revision: row.revision,
    payload: row.payload as NavigationRevisionRecord["payload"],
    createdAt: row.created_at,
  };
}

export interface NavigationService {
  createSet(input: CreateNavigationSetInput): Promise<NavigationSetRecord>;
  /** Throws NAV_SET_NOT_FOUND for unknown/invalid IDs. */
  getSet(id: string): Promise<NavigationSetRecord>;
  findSetByKey(key: string): Promise<NavigationSetRecord | null>;
  /** Live (non-archived) sets, deterministic key order. */
  listSets(): Promise<NavigationSetRecord[]>;
  /** Hard-delete an unbound set and its own items/overrides/revision history. */
  deleteSet(id: string): Promise<boolean>;
  archiveSet(id: string): Promise<NavigationSetRecord>;
  /**
   * Inserts an item into the working tree and returns the materialized node.
   * Enforces the system depth cap (spec §12) and per-set item bound.
   */
  insertItem(input: InsertNavigationItemInput): Promise<NavigationItemNode>;
  /**
   * Updates the editable payload of a working-tree item (label, type, target,
   * ui intent). The Item ID, position and parent are preserved; changing the
   * type re-validates the target payload exactly like insert.
   */
  updateItem(input: {
    setId: string;
    itemId: string;
    type: NavigationItemType;
    label?: string | null;
    target?: NavigationItemTarget;
    uiIntent?: ActionUiIntent | null;
  }): Promise<NavigationItemNode>;
  /**
   * Moves an item (with its subtree) under a new parent and/or to a new
   * sibling position. The Item ID is preserved — moves never re-key items
   * (spec §4). Rejects cycles (spec §14) and depth-cap violations atomically.
   */
  moveItem(input: {
    setId: string;
    itemId: string;
    /** New parent; null = root. Same parent = pure reorder. */
    parentItemId: string | null;
    /** 0-based position among the new siblings (position `at` skips itself). */
    at?: number | null;
  }): Promise<void>;
  /** Deletes an item and its whole subtree; Item IDs are never reused. */
  deleteItem(input: { setId: string; itemId: string }): Promise<void>;
  /**
   * Adds an override to a derived set (spec §17). The target must exist in
   * the base set at add time; payload shape is validated per operation.
   */
  addOverride(input: AddNavigationOverrideInput): Promise<NavigationOverrideRecord>;
  listOverrides(setId: string): Promise<NavigationOverrideRecord[]>;
  removeOverride(input: { setId: string; overrideId: string }): Promise<void>;
  /**
   * Working tree for independent sets; base tree + applied overrides for
   * derived sets. Throws NAV_OVERRIDE_STALE when the derivation conflicts
   * (spec §19) — it never silently re-targets or skips.
   */
  materializeTree(setId: string): Promise<NavigationItemNode[]>;
  /**
   * Stale-override conflicts of a derived set (spec §19): overrides whose
   * base Item ID vanished from the base set. Machine-readable, non-throwing.
   */
  listStaleOverrides(
    setId: string,
  ): Promise<{ override_id: string; target_item_id: string; op: NavigationOverrideOp }[]>;
  /** Ordered working tree of the set (children nested, siblings in order). */
  readTree(setId: string): Promise<NavigationItemNode[]>;
  countItems(setId: string): Promise<number>;
  /** Freezes the current working tree as the next immutable revision. */
  sealRevision(setId: string): Promise<NavigationRevisionRecord>;
  listRevisions(setId: string): Promise<NavigationRevisionRecord[]>;
  getRevision(setId: string, revision: number): Promise<NavigationRevisionRecord | null>;
}

export function createNavigationService(
  pool: DbPool,
  options?: { maxTreeDepth?: number },
): NavigationService {
  const maxTreeDepth = options?.maxTreeDepth ?? DEFAULT_MAX_TREE_DEPTH;

  async function getSet(id: string): Promise<NavigationSetRecord> {
    if (!isStableId(id)) throw new NavigationError("NAV_SET_NOT_FOUND", `invalid set id`);
    const result = await pool.query<SetRow>(`SELECT * FROM navigation_sets WHERE id = $1`, [id]);
    const row = result.rows[0];
    if (row === undefined)
      throw new NavigationError("NAV_SET_NOT_FOUND", `set not found`, { details: { set_id: id } });
    return toSetRecord(row);
  }

  /** Depth (1-based levels) the parent chain already occupies, 0 if root. */
  async function parentDepth(
    tx: Parameters<Parameters<DbPool["withTransaction"]>[0]>[0],
    parentItemId: string,
  ): Promise<number> {
    const result = await tx.query<{ depth: number }>(
      `WITH RECURSIVE up AS (
         SELECT id, parent_item_id, 0 AS depth FROM navigation_items WHERE id = $1
         UNION ALL
         SELECT i.id, i.parent_item_id, up.depth + 1
         FROM navigation_items i JOIN up ON i.id = up.parent_item_id
         WHERE up.depth < $2
       )
       SELECT COALESCE(MAX(depth), 0) + 1 AS depth FROM up`,
      [parentItemId, NAV_TREE_WALK_LIMIT],
    );
    return result.rows[0]?.depth ?? 1;
  }

  return {
    async createSet(input) {
      if (!SET_KEY_PATTERN.test(input.key)) {
        throw new NavigationError(
          "NAV_SET_KEY_INVALID",
          `set key must match ^[a-z][a-z0-9-]{0,63}$`,
          { details: { key: input.key } },
        );
      }
      if (input.title.length === 0 || input.title.length > 200) {
        throw new NavigationError("NAV_SET_TITLE_INVALID", `set title must be 1..200 characters`);
      }
      const id = newStableId();
      if (input.derivedFromSetId != null) {
        const base = await getSet(input.derivedFromSetId);
        // Derivations stay single-level: derived-of-derived would silently
        // multiply override conflicts. Compose overrides on one base instead.
        if (base.derivedFromSetId !== null) {
          throw new NavigationError("NAV_SET_BASE_DERIVED", `cannot derive from a derived set`, {
            details: { base_set_id: base.id },
          });
        }
      }
      try {
        await pool.query(
          `INSERT INTO navigation_sets (id, key, title, derived_from_set_id) VALUES ($1, $2, $3, $4)`,
          [id, input.key, input.title, input.derivedFromSetId ?? null],
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new NavigationError("NAV_SET_KEY_TAKEN", `a live set already uses this key`, {
            details: { key: input.key },
          });
        }
        throw err;
      }
      return getSet(id);
    },

    getSet,

    async findSetByKey(key) {
      const result = await pool.query<SetRow>(
        `SELECT * FROM navigation_sets WHERE key = $1 AND archived_at IS NULL`,
        [key],
      );
      const row = result.rows[0];
      return row === undefined ? null : toSetRecord(row);
    },

    async listSets() {
      const result = await pool.query<SetRow>(
        `SELECT * FROM navigation_sets WHERE archived_at IS NULL ORDER BY key`,
      );
      return result.rows.map(toSetRecord);
    },

    async deleteSet(id: string): Promise<boolean> {
      if (!isStableId(id))
        throw new NavigationError("NAV_SET_NOT_FOUND", `navigation set "${id}" not found`);
      try {
        return await pool.withTransaction(async (tx) => {
          // Serialize deletion with new FK references; existing dependencies stay intact.
          const set = await tx.query<{ id: string }>(
            `SELECT id FROM navigation_sets WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
            [id],
          );
          if (!set.rows.length)
            throw new NavigationError("NAV_SET_NOT_FOUND", `navigation set "${id}" not found`);
          const bound = await tx.query<{ placement_key: string }>(
            `SELECT placement_key FROM navigation_placement_bindings WHERE navigation_set_id = $1 LIMIT 1`,
            [id],
          );
          if (bound.rows.length)
            throw new NavigationError(
              "NAV_SET_BOUND",
              `navigation set is bound to placement "${bound.rows[0]!.placement_key}" — unbind it first`,
              { details: { placement: bound.rows[0]!.placement_key } },
            );
          const derived = await tx.query<{ id: string }>(
            `SELECT id FROM navigation_sets WHERE derived_from_set_id = $1 LIMIT 1`,
            [id],
          );
          if (derived.rows.length)
            throw new NavigationError(
              "NAV_SET_BOUND",
              "navigation set has a derived set — delete the derived set first",
              { details: { derivedSetId: derived.rows[0]!.id } },
            );
          await tx.query(`DELETE FROM navigation_overrides WHERE set_id = $1`, [id]);
          await tx.query(`DELETE FROM navigation_revisions WHERE set_id = $1`, [id]);
          await tx.query(`DELETE FROM navigation_items WHERE set_id = $1`, [id]);
          await tx.query(`DELETE FROM navigation_sets WHERE id = $1`, [id]);
          return true;
        });
      } catch (error) {
        // The FK backstop also covers external references added outside the domain API.
        if ((error as { code?: string })?.code === "23503")
          throw new NavigationError(
            "NAV_SET_BOUND",
            "navigation set still has external references; deletion was rolled back",
            { cause: error },
          );
        throw error;
      }
    },

    async archiveSet(id) {
      return pool.withTransaction(async (tx) => {
        const set = await getSet(id);
        const updated = await tx.query<SetRow>(
          `UPDATE navigation_sets SET archived_at = now()
           WHERE id = $1 AND archived_at IS NULL
           RETURNING id, key, title, derived_from_set_id, created_at, archived_at`,
          [id],
        );
        return updated.rows[0] === undefined ? set : toSetRecord(updated.rows[0]);
      });
    },

    async insertItem(input) {
      const validated = validateItemInput(input);
      await getSet(input.setId);
      return pool.withTransaction(async (tx) => {
        // Set-scoped serialization: the per-set item bound plus the sibling
        // reorder must not interleave with a concurrent move/insert on the
        // same set (both mutations take the same transaction-scoped lock).
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [input.setId]);
        const count = await tx.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM navigation_items WHERE set_id = $1`,
          [input.setId],
        );
        if (Number(count.rows[0]?.n ?? "0") >= MAX_ITEMS_PER_SET) {
          throw new NavigationError("NAV_TREE_TOO_LARGE", `set reached the item bound`, {
            details: { set_id: input.setId, max_items: MAX_ITEMS_PER_SET },
          });
        }
        const parentItemId = input.parentItemId ?? null;
        let depth = 1;
        if (parentItemId !== null) {
          if (!isStableId(parentItemId)) {
            throw new NavigationError("NAV_ITEM_NOT_FOUND", `invalid parent item id`);
          }
          const parentType = await tx.query<{ item_type: string }>(
            `SELECT item_type FROM navigation_items WHERE id = $1 AND set_id = $2`,
            [parentItemId, input.setId],
          );
          if (parentType.rows[0]?.item_type === "separator") {
            throw new NavigationError(
              "NAV_ITEM_PARENT_INVALID",
              `separators cannot have children`,
              {
                details: { parent_item_id: parentItemId },
              },
            );
          }
          depth = (await parentDepth(tx, parentItemId)) + 1;
          if (depth > maxTreeDepth) {
            throw new NavigationError(
              "NAV_DEPTH_UNSUPPORTED",
              `tree exceeds the system depth cap`,
              {
                details: { set_id: input.setId, depth, max_depth: maxTreeDepth },
              },
            );
          }
        }
        // Append by default; explicit `at` opens a gap among the siblings.
        const siblings = await tx.query<{ max_order: number | null }>(
          `SELECT MAX(sibling_order) AS max_order FROM navigation_items
           WHERE set_id = $1 AND parent_item_id IS NOT DISTINCT FROM $2`,
          [input.setId, parentItemId],
        );
        const at =
          input.at == null
            ? (siblings.rows[0]?.max_order ?? -1) + 1
            : Math.min(Math.max(input.at, 0), (siblings.rows[0]?.max_order ?? -1) + 1);
        await tx.query(
          `UPDATE navigation_items SET sibling_order = sibling_order + 1
           WHERE set_id = $1 AND parent_item_id IS NOT DISTINCT FROM $2 AND sibling_order >= $3`,
          [input.setId, parentItemId, at],
        );
        const id = newStableId();
        await tx.query(
          `INSERT INTO navigation_items (id, set_id, parent_item_id, sibling_order, item_type, label, target, ui_intent)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            id,
            input.setId,
            parentItemId,
            at,
            validated.type,
            validated.label,
            validated.target === null ? null : JSON.stringify(validated.target),
            validated.uiIntent,
          ],
        );
        const row = await tx.query<ItemRow>(`SELECT * FROM navigation_items WHERE id = $1`, [id]);
        return toNode(row.rows[0]);
      });
    },

    async updateItem({ setId, itemId, type, label, target, uiIntent }) {
      await getSet(setId);
      if (!isStableId(itemId)) {
        throw new NavigationError("NAV_ITEM_NOT_FOUND", `invalid item id`);
      }
      // Same payload validation as insert — editing never bypasses the
      // per-type target contract (spec §5).
      const validated = validateItemInput({
        type,
        label: label ?? null,
        target: target as NavigationItemTarget,
        uiIntent: uiIntent ?? null,
      });
      const updated = await pool.query<ItemRow>(
        `UPDATE navigation_items
         SET item_type = $3, label = $4, target = $5, ui_intent = $6
         WHERE id = $1 AND set_id = $2
         RETURNING *`,
        [
          itemId,
          setId,
          validated.type,
          validated.label,
          validated.target === null ? null : JSON.stringify(validated.target),
          validated.uiIntent,
        ],
      );
      if (updated.rows[0] === undefined) {
        throw new NavigationError("NAV_ITEM_NOT_FOUND", `item not found`, {
          details: { set_id: setId, item_id: itemId },
        });
      }
      return toNode(updated.rows[0]);
    },

    async moveItem({ setId, itemId, parentItemId, at }) {
      await getSet(setId);
      if (!isStableId(itemId)) {
        throw new NavigationError("NAV_ITEM_NOT_FOUND", `invalid item id`);
      }
      if (parentItemId !== null && !isStableId(parentItemId)) {
        throw new NavigationError("NAV_ITEM_NOT_FOUND", `invalid parent item id`);
      }
      await pool.withTransaction(async (tx) => {
        // Set-scoped serialization (spec §14): the FOR UPDATE row lock below
        // only covers the moved item, so two concurrent moves (or a move
        // racing an insert) could each pass the cycle check and interleave
        // parent updates into a cycle A→B→A. The advisory lock serializes
        // tree mutations per set, making each move's check+write atomic.
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [setId]);
        const current = await tx.query<ItemRow>(
          `SELECT * FROM navigation_items WHERE id = $1 AND set_id = $2 FOR UPDATE`,
          [itemId, setId],
        );
        if (current.rows[0] === undefined) {
          throw new NavigationError("NAV_ITEM_NOT_FOUND", `item not found in set`, {
            details: { item_id: itemId, set_id: setId },
          });
        }
        if (parentItemId !== null) {
          const parent = await tx.query<{ item_type: string }>(
            `SELECT item_type FROM navigation_items WHERE id = $1 AND set_id = $2`,
            [parentItemId, setId],
          );
          if (parent.rows[0] === undefined) {
            throw new NavigationError("NAV_ITEM_NOT_FOUND", `parent not found in set`, {
              details: { parent_item_id: parentItemId },
            });
          }
          if (parent.rows[0].item_type === "separator") {
            throw new NavigationError(
              "NAV_ITEM_PARENT_INVALID",
              `separators cannot have children`,
              {
                details: { parent_item_id: parentItemId },
              },
            );
          }
          if (parentItemId === itemId) {
            throw new NavigationError("NAV_MOVE_CYCLE", `an item cannot become its own parent`, {
              details: { item_id: itemId },
            });
          }
          // Cycle protection (spec §14): walking up from the new parent must
          // never reach the moved item, i.e. the parent is not a descendant.
          const ancestry = await tx.query<{ n: string }>(
            `WITH RECURSIVE up AS (
               SELECT id, parent_item_id, 0 AS depth FROM navigation_items WHERE id = $1
               UNION ALL
               SELECT i.id, i.parent_item_id, up.depth + 1
               FROM navigation_items i JOIN up ON i.id = up.parent_item_id
               WHERE up.depth < $3
             )
             SELECT COUNT(*) AS n FROM up WHERE id = $2`,
            [parentItemId, itemId, NAV_TREE_WALK_LIMIT],
          );
          if (Number(ancestry.rows[0]?.n ?? "0") > 0) {
            throw new NavigationError("NAV_MOVE_CYCLE", `move would create a cycle`, {
              details: { item_id: itemId, parent_item_id: parentItemId },
            });
          }
          // Depth cap for the whole moved subtree: height of the subtree plus
          // the depth it gains under the new parent (spec §12).
          const height = await tx.query<{ height: number }>(
            `WITH RECURSIVE down AS (
               SELECT id, 1 AS level FROM navigation_items WHERE id = $1
               UNION ALL
               SELECT c.id, down.level + 1
               FROM navigation_items c JOIN down ON c.parent_item_id = down.id
               WHERE down.level < $2
             )
             SELECT MAX(level) AS height FROM down`,
            [itemId, NAV_TREE_WALK_LIMIT],
          );
          const parentAncestry = await tx.query<{ depth: number }>(
            `WITH RECURSIVE up AS (
               SELECT id, parent_item_id, 0 AS depth FROM navigation_items WHERE id = $1
               UNION ALL
               SELECT i.id, i.parent_item_id, up.depth + 1
               FROM navigation_items i JOIN up ON i.id = up.parent_item_id
               WHERE up.depth < $2
             )
             SELECT COALESCE(MAX(depth), 0) + 1 AS depth FROM up`,
            [parentItemId, NAV_TREE_WALK_LIMIT],
          );
          const newDepth =
            (parentAncestry.rows[0]?.depth ?? 1) + 1 + ((height.rows[0]?.height ?? 1) - 1);
          if (newDepth > maxTreeDepth) {
            throw new NavigationError(
              "NAV_DEPTH_UNSUPPORTED",
              `move exceeds the system depth cap`,
              {
                details: { item_id: itemId, depth: newDepth, max_depth: maxTreeDepth },
              },
            );
          }
        }
        const oldParent = current.rows[0].parent_item_id;
        const oldOrder = current.rows[0].sibling_order;
        {
          // Close the old gap, open the new one, then place the item — all in
          // one transaction so sibling order stays dense and unique (§41).
          // Same-parent moves (including "append to end") go through the same
          // sequence; the deferrable unique constraint tolerates transient
          // intermediate orderings.
          await tx.query(
            `UPDATE navigation_items SET sibling_order = sibling_order - 1
             WHERE set_id = $1 AND parent_item_id IS NOT DISTINCT FROM $2 AND sibling_order > $3`,
            [setId, oldParent, oldOrder],
          );
          const maxOrder = await tx.query<{ max_order: number | null }>(
            `SELECT MAX(sibling_order) AS max_order FROM navigation_items
             WHERE set_id = $1 AND parent_item_id IS NOT DISTINCT FROM $2`,
            [setId, parentItemId],
          );
          const position =
            at == null
              ? (maxOrder.rows[0]?.max_order ?? -1) + 1
              : Math.min(Math.max(at, 0), (maxOrder.rows[0]?.max_order ?? -1) + 1);
          await tx.query(
            `UPDATE navigation_items SET sibling_order = sibling_order + 1
             WHERE set_id = $1 AND parent_item_id IS NOT DISTINCT FROM $2 AND sibling_order >= $3`,
            [setId, parentItemId, position],
          );
          await tx.query(
            `UPDATE navigation_items SET parent_item_id = $2, sibling_order = $3 WHERE id = $1`,
            [itemId, parentItemId, position],
          );
        }
      });
    },

    async deleteItem({ setId, itemId }) {
      await getSet(setId);
      if (!isStableId(itemId)) {
        throw new NavigationError("NAV_ITEM_NOT_FOUND", `invalid item id`);
      }
      await pool.withTransaction(async (tx) => {
        const deleted = await tx.query<{ id: string }>(
          `WITH RECURSIVE down AS (
             SELECT id, 0 AS depth FROM navigation_items WHERE id = $1 AND set_id = $2
             UNION ALL
             SELECT c.id, down.depth + 1
             FROM navigation_items c JOIN down ON c.parent_item_id = down.id
             WHERE down.depth < $3
           )
           DELETE FROM navigation_items WHERE id IN (SELECT id FROM down) RETURNING id`,
          [itemId, setId, NAV_TREE_WALK_LIMIT],
        );
        if (deleted.rows.length === 0) {
          throw new NavigationError("NAV_ITEM_NOT_FOUND", `item not found in set`, {
            details: { item_id: itemId, set_id: setId },
          });
        }
      });
    },

    async readTree(setId) {
      await getSet(setId);
      const result = await pool.query<ItemRow>(
        `SELECT id, set_id, parent_item_id, sibling_order, item_type, label, target, ui_intent
         FROM navigation_items WHERE set_id = $1
         ORDER BY sibling_order`,
        [setId],
      );
      const byId = new Map<string, BuildNode>();
      const roots: BuildNode[] = [];
      for (const row of result.rows) byId.set(row.id, toNode(row));
      for (const row of result.rows) {
        const node = byId.get(row.id);
        if (node === undefined) continue;
        if (row.parent_item_id === null) roots.push(node);
        else byId.get(row.parent_item_id)?.children.push(node);
      }
      return roots;
    },

    async addOverride({ setId, targetItemId, op, payload }) {
      const set = await getSet(setId);
      if (set.derivedFromSetId === null) {
        throw new NavigationError("NAV_SET_NOT_DERIVED", `only derived sets accept overrides`, {
          details: { set_id: setId },
        });
      }
      if (!OVERRIDE_OPS.includes(op)) {
        throw new NavigationError("NAV_OVERRIDE_INVALID", `unknown override op`, {
          details: { op },
        });
      }
      if (!isStableId(targetItemId)) {
        throw new NavigationError("NAV_OVERRIDE_TARGET_MISSING", `invalid target item id`, {
          details: { target_item_id: targetItemId },
        });
      }
      // The target must exist in the base set when the override is authored —
      // later disappearance is the stale-override path (spec §19, T006).
      const base = await getSet(set.derivedFromSetId);
      const baseItem = await pool.query<{ item_type: string }>(
        `SELECT item_type FROM navigation_items WHERE id = $1 AND set_id = $2`,
        [targetItemId, base.id],
      );
      if (baseItem.rows[0] === undefined) {
        throw new NavigationError("NAV_OVERRIDE_TARGET_MISSING", `target item not in base set`, {
          details: { target_item_id: targetItemId, base_set_id: base.id },
        });
      }
      const validated = validateOverridePayload(op, payload, baseItem.rows[0].item_type);
      return pool.withTransaction(async (tx) => {
        const next = await tx.query<{ next: number | null }>(
          `SELECT COALESCE(MAX(apply_order), 0) + 1 AS next FROM navigation_overrides WHERE set_id = $1`,
          [setId],
        );
        const id = newStableId();
        await tx.query(
          `INSERT INTO navigation_overrides (id, set_id, target_item_id, op, payload, apply_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, setId, targetItemId, op, JSON.stringify(validated), next.rows[0]?.next ?? 1],
        );
        const row = await tx.query<OverrideRow>(
          `SELECT * FROM navigation_overrides WHERE id = $1`,
          [id],
        );
        return toOverrideRecord(row.rows[0]);
      });
    },

    async listOverrides(setId) {
      await getSet(setId);
      const result = await pool.query<OverrideRow>(
        `SELECT * FROM navigation_overrides WHERE set_id = $1 ORDER BY apply_order`,
        [setId],
      );
      return result.rows.map(toOverrideRecord);
    },

    async removeOverride({ setId, overrideId }) {
      await getSet(setId);
      await pool.withTransaction(async (tx) => {
        const deleted = await tx.query<{ id: string }>(
          `DELETE FROM navigation_overrides WHERE id = $1 AND set_id = $2 RETURNING id`,
          [overrideId, setId],
        );
        if (deleted.rows.length === 0) {
          throw new NavigationError("NAV_OVERRIDE_NOT_FOUND", `override not found in set`, {
            details: { override_id: overrideId, set_id: setId },
          });
        }
      });
    },

    async materializeTree(setId) {
      const set = await getSet(setId);
      if (set.derivedFromSetId === null) return this.readTree(setId);
      const base = await this.readTree(set.derivedFromSetId);
      const overrides = await this.listOverrides(setId);
      return applyOverrides(base, overrides);
    },

    /**
     * Non-throwing stale-override report (spec §19): every override whose
     * base Item ID no longer exists in the base set, as machine-readable
     * conflicts. Validation/CLI surfaces use this; materialization throws
     * NAV_OVERRIDE_STALE for the same condition.
     */
    async listStaleOverrides(setId) {
      const set = await getSet(setId);
      if (set.derivedFromSetId === null) return [];
      const overrides = await this.listOverrides(setId);
      if (overrides.length === 0) return [];
      const baseItems = await pool.query<{ id: string }>(
        `SELECT id FROM navigation_items WHERE set_id = $1`,
        [set.derivedFromSetId],
      );
      const live = new Set(baseItems.rows.map((row) => row.id));
      return overrides
        .filter((o) => o.op !== "show" && !live.has(o.targetItemId))
        .map((o) => ({ override_id: o.id, target_item_id: o.targetItemId, op: o.op }));
    },

    async countItems(setId) {
      await getSet(setId);
      const result = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM navigation_items WHERE set_id = $1`,
        [setId],
      );
      return Number(result.rows[0]?.n ?? "0");
    },

    async sealRevision(setId) {
      await getSet(setId);
      const tree = await this.readTree(setId);
      return pool.withTransaction(async (tx) => {
        const next = await tx.query<{ next: number | null }>(
          `SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM navigation_revisions WHERE set_id = $1`,
          [setId],
        );
        const revision = next.rows[0]?.next ?? 1;
        const id = newStableId();
        await tx.query(
          `INSERT INTO navigation_revisions (id, set_id, revision, payload) VALUES ($1, $2, $3, $4)`,
          [id, setId, revision, JSON.stringify(tree)],
        );
        const row = await tx.query<RevisionRow>(
          `SELECT * FROM navigation_revisions WHERE id = $1`,
          [id],
        );
        return toRevisionRecord(row.rows[0]);
      });
    },

    async listRevisions(setId) {
      await getSet(setId);
      const result = await pool.query<RevisionRow>(
        `SELECT * FROM navigation_revisions WHERE set_id = $1 ORDER BY revision`,
        [setId],
      );
      return result.rows.map(toRevisionRecord);
    },

    async getRevision(setId, revision) {
      await getSet(setId);
      const result = await pool.query<RevisionRow>(
        `SELECT * FROM navigation_revisions WHERE set_id = $1 AND revision = $2`,
        [setId, revision],
      );
      const row = result.rows[0];
      return row === undefined ? null : toRevisionRecord(row);
    },
  };
}
