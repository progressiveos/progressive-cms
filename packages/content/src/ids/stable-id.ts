// Entity-branded stable IDs of the Content subsystem (PCMS-CONT-T002).
//
// The generic identity kernel (StableId, isStableId, newStableId) lives in
// @pcms/core (Baseline §7 — core owns identity); this module adds the
// Content-owned entity brands so, e.g., a repeater item ID cannot be stored
// into an Entry reference slot at compile time. All share the same canonical
// UUIDv7 text form at runtime.
import { isStableId, newStableId, type StableId } from "@pcms/core";

export { isStableId, newStableId, type StableId };

declare const entryIdBrand: unique symbol;
/** Identity of a Content `Entry` (Content spec §5). */
export type EntryId = string & StableId & { readonly [entryIdBrand]: "pcms.entry-id" };

declare const repeaterItemIdBrand: unique symbol;
/** Identity of a Repeater item, stable across reorder/diff (Content spec §25). */
export type RepeaterItemId = string &
  StableId & { readonly [repeaterItemIdBrand]: "pcms.repeater-item-id" };

const asEntryId = (id: StableId): EntryId => id as EntryId;
const asRepeaterItemId = (id: StableId): RepeaterItemId => id as RepeaterItemId;

/** Fresh Entry identity. */
export const newEntryId = (): EntryId => asEntryId(newStableId());
/** Fresh Repeater item identity. */
export const newRepeaterItemId = (): RepeaterItemId => asRepeaterItemId(newStableId());

/**
 * Validates and narrows an unknown value to a branded ID type. Distinct brands
 * keep cross-references type-safe; at runtime all share the canonical UUIDv7
 * text form.
 */
export function stableIdAs<T extends StableId>(
  value: unknown,
  brand: (id: StableId) => T,
): T | null {
  return isStableId(value) ? brand(value) : null;
}
