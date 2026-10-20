// Breadcrumb derivation strategies (PCMS-NAV-T020; Navigation spec §50–§52).
// Breadcrumbs are an independent render model — never a hidden alias of the
// Content Tree. Three strategies: content-tree ancestors, a navigation trail
// through an EXPLICITLY chosen set, and fully explicit overrides. When an
// entry lives in several navigation sets there is no "first trail" guess —
// the set is part of the strategy (§52). URL resolution is injected as plain
// functions: this package never computes hrefs itself.
import { NavigationError } from "./errors.js";
import type { NavigationItemNode } from "./model.js";

export interface BreadcrumbItem {
  readonly label: string;
  /** Stable Entry ID when the crumb refers to a content material. */
  readonly entryId: string | null;
  /** Resolved href; null for non-link crumbs (e.g. group headings). */
  readonly href: string | null;
  readonly isCurrent: boolean;
}

export type BreadcrumbStrategy =
  | { readonly type: "content-tree" }
  | {
      readonly type: "navigation-trail" /** The explicitly preferred set (§52). */;
      readonly setId: string;
    }
  | {
      readonly type: "explicit";
      readonly items: readonly {
        readonly label: string;
        readonly entryId?: string | null;
        readonly href?: string | null;
      }[];
    };

/** Structural lookups the composition layer wires to Content + Routing. */
export interface BreadcrumbLookups {
  /** Content Tree parent (null for roots); content-tree strategy. */
  getParentEntryId(entryId: string): Promise<string | null>;
  getTitle(entryId: string): Promise<string | null>;
  /** Resolved href for an entry (Routing-owned); null when unrouted. */
  getEntryHref(entryId: string): Promise<string | null>;
  /** Materialized tree of a navigation set; navigation-trail strategy. */
  getNavigationTree(setId: string): Promise<readonly NavigationItemNode[]>;
}

export async function deriveBreadcrumbs(
  strategy: BreadcrumbStrategy,
  current: { readonly entryId: string; readonly label?: string | null },
  lookups: BreadcrumbLookups,
): Promise<readonly BreadcrumbItem[]> {
  switch (strategy.type) {
    case "content-tree": {
      // Walk Content Tree ancestors root → current (spec §50).
      const chain: { entryId: string; title: string | null }[] = [];
      let cursor: string | null = current.entryId;
      for (let hops = 0; cursor !== null && hops < 32; hops += 1) {
        const title = await lookups.getTitle(cursor);
        chain.push({ entryId: cursor, title });
        cursor = await lookups.getParentEntryId(cursor);
      }
      if (cursor !== null) {
        throw new NavigationError(
          "NAV_BREADCRUMB_TOO_DEEP",
          `content tree chain exceeds 32 ancestors`,
        );
      }
      const items: BreadcrumbItem[] = [];
      for (const crumb of chain.reverse()) {
        items.push({
          label: crumb.title ?? current.label ?? crumb.entryId,
          entryId: crumb.entryId,
          href: await lookups.getEntryHref(crumb.entryId),
          isCurrent: crumb.entryId === current.entryId,
        });
      }
      return items;
    }
    case "navigation-trail": {
      const tree = await lookups.getNavigationTree(strategy.setId);
      const path = findTrailPath(tree, current.entryId, []);
      if (path === null) {
        throw new NavigationError(
          "NAV_BREADCRUMB_TRAIL_MISSING",
          `entry is not reachable in the chosen navigation set`,
          { details: { set_id: strategy.setId, entry_id: current.entryId } },
        );
      }
      const items: BreadcrumbItem[] = [];
      for (const node of path) {
        if (node.type === "separator") continue;
        const entryId =
          node.target !== null && "entry_id" in node.target
            ? (node.target.entry_id as string | null)
            : null;
        if (node.type === "internal_entry" && entryId !== null) {
          items.push({
            label: node.label ?? (await lookups.getTitle(entryId)) ?? "",
            entryId,
            href: await lookups.getEntryHref(entryId),
            isCurrent: entryId === current.entryId,
          });
        } else {
          // Groups/headings: real crumbs without a URL (spec §9).
          items.push({ label: node.label ?? "", entryId: null, href: null, isCurrent: false });
        }
      }
      return items;
    }
    case "explicit": {
      const items: BreadcrumbItem[] = strategy.items.map((item) => ({
        label: item.label,
        entryId: item.entryId ?? null,
        href: item.href ?? null,
        isCurrent: false,
      }));
      if (items.length > 0) {
        const last = items[items.length - 1];
        if (last !== undefined) {
          items[items.length - 1] = { ...last, isCurrent: true };
        }
      }
      return items;
    }
  }
}

/** Depth-first search of the item path whose internal entry is entryId. */
function findTrailPath(
  nodes: readonly NavigationItemNode[],
  entryId: string,
  prefix: readonly NavigationItemNode[],
): readonly NavigationItemNode[] | null {
  for (const node of nodes) {
    const path = [...prefix, node];
    const target = node.target;
    if (
      node.type === "internal_entry" &&
      target !== null &&
      "entry_id" in target &&
      target.entry_id === entryId
    ) {
      return path;
    }
    const found = findTrailPath(node.children, entryId, path);
    if (found !== null) return found;
  }
  return null;
}
