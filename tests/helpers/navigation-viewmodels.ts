// Composition helper (PCMS-NAV-T025): turns materialized navigation trees
// into the theme-side NavigationItemViewModel shape, resolving hrefs through
// the Routing subsystem. This wiring lives at the composition layer (tests
// today, apps/web from M07) — L1 packages never import each other.

import type { NavigationItemNode } from "@pcms/navigation";
import type { ActionUrlService } from "@pcms/routing";
import type { NavigationItemViewModel } from "@pcms/themes";

/**
 * Maps one materialized tree into theme View Models. `actions` is the
 * routing action resolver; entry titles fall back to the item label or the
 * injected lookup (render data the theme may not compute itself).
 */
export async function toNavigationItemViewModels(
  nodes: readonly NavigationItemNode[],
  actions: ActionUrlService,
  options?: {
    hostname?: string;
    /** Entry title fallback for items without an explicit label. */
    getEntryTitle?: (entryId: string) => Promise<string | null>;
  },
): Promise<NavigationItemViewModel[]> {
  const results: NavigationItemViewModel[] = [];
  for (const node of nodes) {
    const title = node.label ?? null;
    switch (node.type) {
      case "separator": {
        results.push({ type: "separator" });
        break;
      }
      case "group": {
        results.push({
          type: "group",
          title: title ?? "",
          items: await toNavigationItemViewModels(node.children, actions, options),
        });
        break;
      }
      case "internal_entry": {
        const entryId =
          node.target !== null && "entry_id" in node.target ? node.target.entry_id : null;
        if (entryId === null) break;
        const resolved = await actions.resolveAction(
          { kind: "internal_entry", entry_id: entryId },
          options?.hostname === undefined ? undefined : { hostname: options.hostname },
        );
        if (resolved.kind !== "url") break; // unrouted entries drop out loudly in validation
        const fallbackTitle =
          title ?? (options?.getEntryTitle ? await options.getEntryTitle(entryId) : null) ?? "";
        results.push({
          type: "internal_entry",
          entry_id: entryId,
          title: fallbackTitle,
          href: resolved.href,
          items: await toNavigationItemViewModels(node.children, actions, options),
        });
        break;
      }
      case "external_url": {
        const url = node.target !== null && "url" in node.target ? node.target.url : null;
        if (url === null) break;
        results.push({
          type: "external_url",
          title: title ?? "",
          href: url,
          items: await toNavigationItemViewModels(node.children, actions, options),
        });
        break;
      }
      case "anchor": {
        const anchor = node.target !== null && "anchor" in node.target ? node.target.anchor : null;
        if (anchor === null) break;
        results.push({
          type: "anchor",
          title: title ?? "",
          anchor,
          items: await toNavigationItemViewModels(node.children, actions, options),
        });
        break;
      }
      case "action": {
        // The action payload passes through as provider-independent data
        // (Theme spec §24); forms etc. stay opaque to the theme.
        if (node.target === null || !("kind" in node.target)) break;
        const payload = node.target as Readonly<Record<string, unknown>>;
        let href: string | null = null;
        if (payload.kind === "phone" && typeof payload.phone === "string") {
          href = `tel:${payload.phone.replace(/[\s()-]/g, "")}`;
        } else if (payload.kind === "email" && typeof payload.email === "string") {
          href = `mailto:${payload.email}`;
        } else if (payload.kind === "internal_entry" && typeof payload.entry_id === "string") {
          const resolved = await actions.resolveAction(
            { kind: "internal_entry", entry_id: payload.entry_id },
            options?.hostname === undefined ? undefined : { hostname: options.hostname },
          );
          href = resolved.kind === "url" ? resolved.href : null;
        }
        results.push({
          type: "action",
          title: title ?? "",
          action: href === null ? { ...payload } : { ...payload, href },
        });
        break;
      }
    }
  }
  return results;
}
