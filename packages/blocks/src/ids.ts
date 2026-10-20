// Block instance identity (PCMS-CONT-T013; Content spec §30).
// Stable across edit/reorder; changes only when a new logical block is created.
// The generic kernel lives in @pcms/core (Baseline §7).
import { newStableId, type StableId } from "@pcms/core";

declare const blockIdBrand: unique symbol;
/** Identity of a Block instance inside a BlockDocument (Content spec §30). */
export type BlockId = string & StableId & { readonly [blockIdBrand]: "pcms.block-id" };

/** Fresh Block instance identity. */
export const newBlockId = (): BlockId => newStableId() as BlockId;
