// Navigation domain model (PCMS-NAV-T001; Navigation spec §3–§14/§17–§21).
//
// The Navigation Tree is an independent first-class model — it is NOT the
// Content Tree and NOT the URL Tree (spec §2 invariant). Internal items
// reference entries by opaque stable Entry ID; URLs are resolved later by
// the Routing subsystem at render/resolution time (spec §6) and never stored
// as link identity. This package deliberately imports nothing from
// @pcms/content or @pcms/routing — cross-subsystem wiring happens at the
// composition layer through the plain resolver interfaces in resolvers.ts.

/** The six v1 item types every consumer must support (spec §5). */
export const NAVIGATION_ITEM_TYPES = [
  "internal_entry",
  "external_url",
  "anchor",
  "group",
  "separator",
  "action",
] as const;
export type NavigationItemType = (typeof NAVIGATION_ITEM_TYPES)[number];

/** `rel` tokens allowed on external links (security baseline, spec §7). */
export const EXTERNAL_REL_TOKENS = ["noopener", "noreferrer", "nofollow", "sponsored"] as const;
export type ExternalRelToken = (typeof EXTERNAL_REL_TOKENS)[number];
export type ExternalLinkTarget = "_self" | "_blank";

/** `internal_entry` — stable Entry ID only, never a URL (spec §6). */
export interface InternalEntryTarget {
  readonly entry_id: string;
}

/** `external_url` — typed http(s) link with target/rel policy (spec §7). */
export interface ExternalUrlTarget {
  readonly url: string;
  readonly target: ExternalLinkTarget;
  readonly rel: readonly ExternalRelToken[];
}

/** `anchor` — current-page anchor or Entry + anchor (spec §8). */
export interface AnchorTarget {
  /** Bounded anchor name (validated, spec §8). */
  readonly anchor: string;
  /** null = anchor on the current page; set = anchor on that Entry. */
  readonly entry_id: string | null;
}

/**
 * `action` — structural mirror of the Content spec §47 typed Action model
 * (Navigation spec §11). Navigation never invents new target kinds; `form`,
 * `media_download`, etc. carry stable Definition/Asset IDs and their URL or
 * handler semantics belong to their owning subsystems.
 */
export type ActionTarget =
  | { readonly kind: "internal_entry"; readonly entry_id: string }
  | {
      readonly kind: "external_url";
      readonly url: string;
      readonly target: ExternalLinkTarget;
      readonly rel: readonly ExternalRelToken[];
    }
  | { readonly kind: "anchor"; readonly anchor: string; readonly entry_id: string | null }
  | { readonly kind: "form"; readonly form_definition_id: string }
  | { readonly kind: "phone"; readonly phone: string }
  | { readonly kind: "email"; readonly email: string }
  | { readonly kind: "media_download"; readonly media_asset_id: string }
  | { readonly kind: "none" };

/** Optional presentation intent for actions — never a new target type (§11). */
export type ActionUiIntent = "cta" | "button" | "plain";

/**
 * Visibility policy (spec §21). v1 public-site baseline is `always` only;
 * authenticated/date-range/locale policies are future work and must not
 * turn Navigation into a rules engine.
 */
export type ItemVisibilityPolicy = "always";

/** Type-specific target payload carried by an item. */
export type NavigationItemTarget =
  | InternalEntryTarget
  | ExternalUrlTarget
  | AnchorTarget
  | ActionTarget
  | null;

/** A materialized navigation item (ordered tree shape, spec §4). */
export interface NavigationItemNode {
  /** Stable Item ID — survives reorder/move; overrides address it (§4/§18). */
  readonly id: string;
  readonly type: NavigationItemType;
  /** Display label; null lets the render layer fall back to the entry title. */
  readonly label: string | null;
  readonly target: NavigationItemTarget;
  readonly visibility: ItemVisibilityPolicy;
  /** Presentation hint for action items; null elsewhere. */
  readonly uiIntent: ActionUiIntent | null;
  readonly children: readonly NavigationItemNode[];
}

/** A named, versionable navigation tree (spec §3). */
export interface NavigationSetRecord {
  readonly id: string;
  /** Unique key, e.g. "main", "footer-legal" (spec §3). */
  readonly key: string;
  readonly title: string;
  /**
   * Set this set is derived from (spec §17). null = independent set;
   * a derived set stores ordered overrides, not a tree copy.
   */
  readonly derivedFromSetId: string | null;
  readonly createdAt: Date;
  /** Soft-archive timestamp; sets are never hard-deleted. */
  readonly archivedAt: Date | null;
}

/**
 * One override of a derived set (spec §17/§18). Operations address base
 * items by stable Item ID — never by label, position or URL.
 */
export type NavigationOverrideOp =
  | "hide"
  | "show"
  | "relabel"
  | "reorder"
  | "move"
  | "insert"
  | "replace_target";

export interface NavigationOverrideRecord {
  readonly id: string;
  /** Derived set owning the override. */
  readonly setId: string;
  /** Target base Item ID (spec §18); `insert` inserts relative to it. */
  readonly targetItemId: string;
  readonly op: NavigationOverrideOp;
  /** Operation payload (new label, new parent, inserted subtree, …). */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Overrides apply in explicit order. */
  readonly order: number;
  readonly createdAt: Date;
}

/**
 * A sealed revision snapshot of a set's working tree (spec §17/§56).
 * M04 ships the versionable model and the revision-facing contract;
 * the publication state machine itself is M07 and must not be duplicated
 * here.
 */
export interface NavigationRevisionRecord {
  readonly id: string;
  readonly setId: string;
  /** Monotonically increasing per set. */
  readonly revision: number;
  /** Sealed working-tree snapshot (ordered NavigationItemNode forest). */
  readonly payload: readonly NavigationItemNode[];
  readonly createdAt: Date;
}

/** Binding of a theme placement key to a navigation set (spec §15). */
export interface NavigationPlacementBinding {
  readonly placementKey: string;
  readonly navigationSetId: string;
  readonly createdAt: Date;
}

/** System hard limit for tree depth (spec §12: default 10, configurable). */
export const DEFAULT_MAX_TREE_DEPTH = 10;

/** Upper bound for the number of items in one set (abuse/accident guard). */
export const MAX_ITEMS_PER_SET = 1000;

/** Upper bound for anchor names (mirrors the theme-side contract). */
export const MAX_ANCHOR_LENGTH = 128;
