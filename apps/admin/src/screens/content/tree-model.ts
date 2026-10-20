// Pure content-tree model (PCMS-ADMIN-UX): tree building, orphan surfacing
// and search filtering. DOM-free and API-free (structural item shape) so the
// node test suite can exercise it without pulling the fetch client.
export interface TreeItem {
  readonly entry_id: string;
  readonly parent_entry_id: string | null;
  readonly title: string | null;
}

export interface TreeNode extends TreeItem {
  readonly children: TreeNode[];
}

export function buildTree(items: readonly TreeItem[]): TreeNode[] {
  const byParent = new Map<string | null, TreeNode[]>();
  const nodes = new Map<string, TreeNode>();
  for (const item of items) {
    nodes.set(item.entry_id, { ...item, children: [] });
  }
  for (const node of nodes.values()) {
    const key = node.parent_entry_id;
    const siblings = byParent.get(key) ?? [];
    siblings.push(node);
    byParent.set(key, siblings);
  }
  const attach = (list: readonly TreeNode[]): TreeNode[] =>
    list.map((node) => ({ ...node, children: attach(byParent.get(node.entry_id) ?? []) }));
  const roots = attach(byParent.get(null) ?? []);
  // Orphans (parent missing from the visible set) surface as roots.
  const seen = new Set<string>();
  const walk = (list: readonly TreeNode[]) => {
    for (const node of list) {
      seen.add(node.entry_id);
      walk(node.children);
    }
  };
  walk(roots);
  const orphans = [...nodes.values()].filter((node) => !seen.has(node.entry_id));
  return [...roots, ...orphans];
}

/** Root-first ancestor chain of `entryId` (empty for roots and unknown ids). */
export function ancestorChain<T extends TreeItem>(
  items: readonly T[],
  entryId: string,
): readonly T[] {
  const byId = new Map(items.map((item) => [item.entry_id, item] as const));
  const chain: T[] = [];
  let current = byId.get(entryId);
  while (current !== undefined && current.parent_entry_id !== null) {
    const parent = byId.get(current.parent_entry_id);
    if (parent === undefined) break;
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}

/** The entry plus every transitive child (for move-dialog exclusion lists). */
export function subtreeIds(items: readonly TreeItem[], entryId: string): ReadonlySet<string> {
  const subtree = new Set<string>([entryId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of items) {
      if (
        item.parent_entry_id !== null &&
        subtree.has(item.parent_entry_id) &&
        !subtree.has(item.entry_id)
      ) {
        subtree.add(item.entry_id);
        grew = true;
      }
    }
  }
  return subtree;
}

/** Whether `newParentId` is a legal parent for `entryId`: any id except the
 * entry itself and its own subtree. Mirrors the server's ENTRY_CYCLE rule —
 * the client check only prevents an impossible drop before it happens. */
export function canMoveTo(
  items: readonly TreeItem[],
  entryId: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) return true;
  if (newParentId === entryId) return false;
  return !subtreeIds(items, entryId).has(newParentId);
}

/** Keep nodes matching the query plus all their ancestors. */
export function filterTreeItems<T extends TreeItem>(
  items: readonly T[],
  query: string,
): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return items;
  const childrenOf = new Map<string | null, T[]>();
  for (const item of items) {
    const list = childrenOf.get(item.parent_entry_id) ?? [];
    list.push(item);
    childrenOf.set(item.parent_entry_id, list);
  }
  const keep = new Set<string>();
  const matches = (item: TreeItem): boolean => (item.title ?? "").toLowerCase().includes(needle);
  const visit = (item: T): boolean => {
    const self = matches(item);
    const kids = childrenOf.get(item.entry_id) ?? [];
    const childMatch = kids.some(visit);
    if (self || childMatch) keep.add(item.entry_id);
    return self || childMatch;
  };
  for (const root of childrenOf.get(null) ?? []) visit(root);
  return items.filter((item) => keep.has(item.entry_id));
}
