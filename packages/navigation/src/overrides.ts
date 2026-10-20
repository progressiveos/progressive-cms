// Derived navigation override application (PCMS-NAV-T005; Navigation spec
// §17–§19). Pure tree algebra: a base tree plus ordered overrides yields the
// derived tree. Overrides address base items by stable Item ID — never by
// label, position or URL (§18). A missing base item is a stale override and
// becomes an explicit conflict (§19): materialization throws
// NAV_OVERRIDE_STALE, it never silently skips or re-targets.
import { NavigationError } from "./errors.js";
import type { NavigationItemNode, NavigationOverrideOp } from "./model.js";

/** An override ready for application (persisted row shape, payload decoded). */
export interface ApplicableOverride {
  readonly id: string;
  readonly targetItemId: string;
  readonly op: NavigationOverrideOp;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface MutableNode {
  id: string;
  type: NavigationItemNode["type"];
  label: string | null;
  target: NavigationItemNode["target"];
  visibility: NavigationItemNode["visibility"];
  uiIntent: NavigationItemNode["uiIntent"];
  children: MutableNode[];
}

function toMutable(node: NavigationItemNode): MutableNode {
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    target: node.target,
    visibility: node.visibility,
    uiIntent: node.uiIntent,
    children: node.children.map(toMutable),
  };
}

function toReadonly(node: MutableNode): NavigationItemNode {
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    target: node.target,
    visibility: node.visibility,
    uiIntent: node.uiIntent,
    children: node.children.map(toReadonly),
  };
}

function findNode(roots: readonly MutableNode[], id: string): MutableNode | null {
  for (const node of roots) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found !== null) return found;
  }
  return null;
}

function detach(roots: MutableNode[], id: string): MutableNode | null {
  for (let index = 0; index < roots.length; index += 1) {
    const node = roots[index];
    if (node === undefined) continue;
    if (node.id === id) return roots.splice(index, 1)[0] ?? null;
    const detached = detach(node.children, id);
    if (detached !== null) return detached;
  }
  return null;
}

function insertAtPosition(
  roots: MutableNode[],
  parentItemId: string | null,
  at: number | null,
  node: MutableNode,
): void {
  if (parentItemId === null) {
    roots.splice(Math.max(0, Math.min(at ?? roots.length, roots.length)), 0, node);
    return;
  }
  const parent = findNode(roots, parentItemId);
  if (parent === null) {
    throw new NavigationError("NAV_OVERRIDE_STALE", `override parent item is missing`, {
      details: { parent_item_id: parentItemId },
    });
  }
  parent.children.splice(
    Math.max(0, Math.min(at ?? parent.children.length, parent.children.length)),
    0,
    node,
  );
}

function payloadNumber(payload: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Applies ordered overrides to a copy of the base tree. Throws
 * NAV_OVERRIDE_STALE when an override references a base item that no longer
 * exists — never silently applies it elsewhere (spec §19).
 */
export function applyOverrides(
  base: readonly NavigationItemNode[],
  overrides: readonly ApplicableOverride[],
): NavigationItemNode[] {
  const roots = base.map(toMutable);
  const hidden = new Set<string>();
  for (const override of overrides) {
    if (override.op === "show") {
      // `show` cancels a prior hide; it may reference items that were never
      // hidden — it is the one override allowed to miss its target.
      hidden.delete(override.targetItemId);
      continue;
    }
    const target = findNode(roots, override.targetItemId);
    if (target === null) {
      throw new NavigationError("NAV_OVERRIDE_STALE", `override targets a missing base item`, {
        details: {
          override_id: override.id,
          target_item_id: override.targetItemId,
          op: override.op,
        },
      });
    }
    switch (override.op) {
      case "hide": {
        hidden.add(override.targetItemId);
        break;
      }
      case "relabel": {
        const label = override.payload.label;
        if (typeof label !== "string" || label.length === 0 || label.length > 200) {
          throw new NavigationError("NAV_OVERRIDE_INVALID", `relabel payload needs a label`, {
            details: { override_id: override.id },
          });
        }
        target.label = label;
        break;
      }
      case "reorder": {
        const at = payloadNumber(override.payload, "at");
        if (at === null) {
          throw new NavigationError("NAV_OVERRIDE_INVALID", `reorder payload needs "at"`, {
            details: { override_id: override.id },
          });
        }
        const siblings = findSiblingList(roots, override.targetItemId);
        if (siblings === null) continue;
        const from = siblings.findIndex((n) => n.id === override.targetItemId);
        if (from === -1) continue;
        siblings.splice(from, 1);
        siblings.splice(Math.min(at, siblings.length), 0, target);
        break;
      }
      case "move": {
        const parentItemId =
          override.payload.parent_item_id === null
            ? null
            : (override.payload.parent_item_id as string);
        if (parentItemId !== null && typeof parentItemId !== "string") {
          throw new NavigationError("NAV_OVERRIDE_INVALID", `move payload needs parent_item_id`, {
            details: { override_id: override.id },
          });
        }
        if (parentItemId !== null && findNode([target], parentItemId) !== null) {
          throw new NavigationError("NAV_OVERRIDE_INVALID", `move would create a cycle`, {
            details: { override_id: override.id, parent_item_id: parentItemId },
          });
        }
        detach(roots, override.targetItemId);
        insertAtPosition(roots, parentItemId, payloadNumber(override.payload, "at"), target);
        break;
      }
      case "insert": {
        const item = override.payload.item as NavigationItemNode | undefined;
        if (
          item === undefined ||
          typeof item !== "object" ||
          typeof item.id !== "string" ||
          typeof item.type !== "string"
        ) {
          throw new NavigationError("NAV_OVERRIDE_INVALID", `insert payload needs an item`, {
            details: { override_id: override.id },
          });
        }
        const parentItemId =
          override.payload.parent_item_id === null
            ? null
            : (override.payload.parent_item_id as string);
        if (parentItemId !== null && findNode(roots, parentItemId) === null) {
          throw new NavigationError("NAV_OVERRIDE_STALE", `insert parent item is missing`, {
            details: { override_id: override.id, parent_item_id: parentItemId },
          });
        }
        insertAtPosition(roots, parentItemId, payloadNumber(override.payload, "at"), {
          id: item.id,
          type: item.type as MutableNode["type"],
          label: item.label ?? null,
          target: item.target ?? null,
          visibility: "always",
          uiIntent: item.uiIntent ?? null,
          children: (item.children ?? []).map(toMutable),
        });
        break;
      }
      case "replace_target": {
        const newTarget = override.payload.target;
        if (newTarget === undefined || newTarget === null || typeof newTarget !== "object") {
          throw new NavigationError(
            "NAV_OVERRIDE_INVALID",
            `replace_target payload needs a target`,
            {
              details: { override_id: override.id },
            },
          );
        }
        target.target = newTarget as MutableNode["target"];
        break;
      }
    }
  }
  // Hidden items (and their subtrees) drop out of the final tree.
  const result = roots.filter((node) => !hidden.has(node.id));
  return pruneHidden(result, hidden).map(toReadonly);
}

function pruneHidden(roots: MutableNode[], hidden: Set<string>): MutableNode[] {
  for (const node of roots) {
    node.children = pruneHidden(node.children, hidden);
  }
  return roots.filter((node) => !hidden.has(node.id));
}

function findSiblingList(roots: MutableNode[], itemId: string): MutableNode[] | null {
  if (roots.some((node) => node.id === itemId)) return roots;
  for (const node of roots) {
    const found = findSiblingList(node.children, itemId);
    if (found !== null) return found;
  }
  return null;
}
