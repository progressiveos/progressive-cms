// Pure repeater helpers (PCMS-ADMIN-T004; Admin spec §9, Content spec §25).
// Identity contract: item ids are created at insert and PRESERVED on
// edit/reorder — reorder only moves positions, never regenerates ids.
import { stableId } from "./field-utils.js";

export interface RepeaterItem {
  readonly itemId?: unknown;
  readonly [field: string]: unknown;
}

/** Moves one item to a new position; returns the SAME item objects reordered. */
export function moveRepeaterItem<T>(items: readonly T[], from: number, to: number): readonly T[] {
  if (from === to) return items;
  if (from < 0 || from >= items.length) return items;
  const target = Math.max(0, Math.min(to, items.length - 1));
  const next = [...items];
  const moved = next.splice(from, 1)[0];
  if (moved === undefined) return items;
  next.splice(target, 0, moved);
  return next;
}

/** Semantic copy: same field values, NEW stable item id. */
export function duplicateRepeaterItem(item: RepeaterItem): RepeaterItem {
  const { ...rest } = item;
  return { ...rest, itemId: stableId() };
}

/** Ensures every row carries a stable id (legacy/imported payloads). */
export function withItemIds(items: readonly RepeaterItem[]): readonly RepeaterItem[] {
  return items.map((item) =>
    typeof item.itemId === "string" ? item : { ...item, itemId: stableId() },
  );
}
