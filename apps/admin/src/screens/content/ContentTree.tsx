// Content Tree panel (PCMS-ADMIN-T003; redesign concept §12, spec §13):
// hierarchical entry list with chevron/indent hierarchy, Font Awesome type
// icons, compact status chips and a per-row overflow action menu. Keyboard
// model per WAI-ARIA tree: ↑/↓ move, →/← expand/collapse, Home/End, Enter
// selects. Row menu: Shift+F10 / ContextMenu opens it (menu itself is fully
// keyboard-navigable); the toggle and menu buttons are pointer/AT shortcuts,
// not tab stops, per the APG roving-tabindex tree pattern.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContentTreeItemWire } from "../../api/content.js";
import {
  buildTree,
  canMoveTo,
  filterTreeItems,
  type TreeNode as ModelTreeNode,
  type TreeItem,
} from "./tree-model.js";

export interface TreeNode extends ContentTreeItemWire {
  readonly children: TreeNode[];
}

const asTreeItems = (items: readonly ContentTreeItemWire[]): readonly TreeItem[] => items;
const asTreeNodes = (nodes: readonly ModelTreeNode[]): TreeNode[] => nodes as TreeNode[];

import type { AdminIconName } from "../../design/icons.js";
import { Popover } from "../../design/popover.js";
import {
  accentVars,
  Button,
  type DomainAccent,
  EmptyState,
  Icon,
  IconButton,
  Skeleton,
} from "../../design/ui.js";
import { t } from "../../i18n/index.js";

/** Content type → icon + domain accent (concept §12.3); unknown types fall
 * back to the generic content icon, never to color-only differentiation. */
const TYPE_ICONS: Readonly<Record<string, { icon: AdminIconName; accent: DomainAccent }>> = {
  page: { icon: "typePage", accent: "content" },
  service: { icon: "typeService", accent: "interactions" },
  case: { icon: "typeCase", accent: "access" },
  news: { icon: "typeNews", accent: "audit" },
  article: { icon: "typeArticle", accent: "navigation" },
  section: { icon: "typeFolder", accent: "integrations" },
  folder: { icon: "typeFolder", accent: "integrations" },
};
const TYPE_FALLBACK: { icon: AdminIconName; accent: DomainAccent } = {
  icon: "content",
  accent: "content",
};

interface FlatRow {
  readonly node: TreeNode;
  readonly depth: number;
}

/** Drag&drop wiring shared by all rows plus the root drop zone. HTML5 DnD is
 * a pointer shortcut — keyboard users keep Move/To-root in the row menu. */
interface DndState {
  readonly dragId: string | null;
  readonly dropId: string | null;
  readonly onDragStart: (node: TreeNode) => void;
  readonly onDragOverRow: (node: TreeNode) => (event: React.DragEvent) => void;
  readonly onDropRow: (node: TreeNode) => (event: React.DragEvent) => void;
  readonly onDragOverRoot: (event: React.DragEvent) => void;
  readonly onDropRoot: (event: React.DragEvent) => void;
  readonly onDragEnd: () => void;
}

function flattenVisible(tree: readonly TreeNode[], openIds: ReadonlySet<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (nodes: readonly TreeNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.children.length > 0 && openIds.has(node.entry_id)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(tree, 0);
  return rows;
}

const INDENT_STEP = 20;

function Row(props: {
  readonly row: FlatRow;
  readonly selectedId: string | null;
  readonly openIds: ReadonlySet<string>;
  readonly menuOpenId: string | null;
  readonly focusId: string | null;
  readonly dnd: DndState;
  readonly onToggle: (id: string) => void;
  readonly onSelect: (node: TreeNode) => void;
  readonly onMenuToggle: (id: string | null) => void;
  readonly onRowKeyDown: (event: React.KeyboardEvent, row: FlatRow) => void;
  readonly actions: (node: TreeNode, close: () => void) => React.ReactNode;
  readonly registerRef: (id: string, element: HTMLDivElement | null) => void;
}) {
  const { node, depth } = props.row;
  const hasChildren = node.children.length > 0;
  const open = props.openIds.has(node.entry_id);
  const selected = props.selectedId === node.entry_id;
  const type = TYPE_ICONS[node.content_type] ?? TYPE_FALLBACK;
  const title = node.title ?? t("tree_untitled");
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const dragging = props.dnd.dragId === node.entry_id;
  const dropTarget = props.dnd.dropId === node.entry_id;
  return (
    <li role="none">
      <div
        ref={(element) => props.registerRef(node.entry_id, element)}
        className={`pcms-tree__line${dropTarget ? " pcms-tree__line--drop" : ""}${dragging ? " pcms-tree__line--dragging" : ""}`}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={hasChildren ? open : undefined}
        aria-selected={selected}
        data-testid={`tree-row-${node.entry_id}`}
        tabIndex={props.focusId === node.entry_id ? 0 : -1}
        style={{ paddingInlineStart: depth * INDENT_STEP + 8 }}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", node.entry_id);
          props.dnd.onDragStart(node);
        }}
        onDragOver={props.dnd.onDragOverRow(node)}
        onDrop={props.dnd.onDropRow(node)}
        onDragEnd={props.dnd.onDragEnd}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button") === null) {
            props.onSelect(node);
          }
        }}
        onKeyDown={(event) => props.onRowKeyDown(event, props.row)}
      >
        {hasChildren ? (
          <button
            type="button"
            className="pcms-tree__toggle"
            tabIndex={-1}
            aria-label={open ? t("tree_collapse") : t("tree_expand")}
            title={open ? t("tree_collapse") : t("tree_expand")}
            onClick={(event) => {
              event.stopPropagation();
              props.onToggle(node.entry_id);
            }}
          >
            <Icon name={open ? "chevronDown" : "chevronRight"} />
          </button>
        ) : (
          <span className="pcms-tree__toggle pcms-tree__toggle--leaf" aria-hidden="true" />
        )}
        <span className="pcms-tree__type" style={accentVars(type.accent)} aria-hidden="true">
          <Icon name={type.icon} />
        </span>
        <span className="pcms-tree__label" title={title}>
          {title}
        </span>
        <span className="pcms-tree__status">
          {/* Status icons (never color-only): each has an accessible name.
           * Folders have no publication lifecycle → no status icons. */}
          {node.kind === "content" && node.has_publication ? (
            <span
              className="pcms-tree__status-icon pcms-tree__status-icon--published"
              role="img"
              aria-label={t("tree_status_published")}
              title={t("tree_status_published")}
            >
              <Icon name="success" />
            </span>
          ) : null}
          {node.kind === "content" && node.has_working ? (
            <span
              className="pcms-tree__status-icon pcms-tree__status-icon--draft"
              role="img"
              aria-label={t("tree_status_draft")}
              title={t("tree_status_draft")}
            >
              <Icon name="edit" />
            </span>
          ) : null}
          {node.archived_at !== null ? (
            <span
              className="pcms-tree__status-icon"
              role="img"
              aria-label={t("tree_status_archived")}
              title={t("tree_status_archived")}
            >
              <Icon name="archive" />
            </span>
          ) : null}
        </span>
        <IconButton
          ref={menuRef}
          small
          icon="menu"
          label={t("tree_actions")}
          testid="tree-row-menu"
          className="pcms-tree__menu"
          onClick={() =>
            props.onMenuToggle(props.menuOpenId === node.entry_id ? null : node.entry_id)
          }
        />
        {props.menuOpenId === node.entry_id ? (
          <Popover
            open
            onClose={() => props.onMenuToggle(null)}
            anchor={menuRef.current}
            align="start"
          >
            <div role="menu" aria-label={t("tree_actions")}>
              {props.actions(node, () => props.onMenuToggle(null))}
            </div>
          </Popover>
        ) : null}
      </div>
      {hasChildren && open ? (
        // WAI-ARIA tree: children ul carries role="group" (intentional, spec
        // APG pattern; biome flags it as useSemanticElements).
        // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA APG tree pattern
        <ul role="group" className="pcms-tree__children">
          {node.children.map((child) => (
            <Row
              key={child.entry_id}
              row={{ node: child, depth: depth + 1 }}
              selectedId={props.selectedId}
              openIds={props.openIds}
              menuOpenId={props.menuOpenId}
              focusId={props.focusId}
              dnd={props.dnd}
              onToggle={props.onToggle}
              onSelect={props.onSelect}
              onMenuToggle={props.onMenuToggle}
              onRowKeyDown={props.onRowKeyDown}
              actions={props.actions}
              registerRef={props.registerRef}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ContentTree(props: {
  readonly items: readonly ContentTreeItemWire[] | null;
  readonly error: string | null;
  readonly selectedId: string | null;
  readonly includeArchived: boolean;
  readonly onToggleArchived: () => void;
  readonly onSelect: (node: TreeNode) => void;
  readonly onReload: () => void;
  readonly onCreate: (parent: TreeNode | null) => void;
  readonly onMove: (node: TreeNode) => void;
  readonly onMoveTo: (node: TreeNode, newParent: TreeNode) => void;
  readonly onMoveToRoot: (node: TreeNode) => void;
  readonly onArchive: (node: TreeNode) => void;
  readonly onRestore: (node: TreeNode) => void;
  readonly onDuplicate: (node: TreeNode) => void;
}) {
  const [query, setQuery] = useState("");
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  // Mirror of dragId for synchronous reads inside drag handlers — state
  // updates batch, so a dragover fired in the same tick as dragstart would
  // otherwise see the previous render's (null) value.
  const dragRef = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const tree = useMemo(
    () => asTreeNodes(buildTree(filterTreeItems(asTreeItems(props.items ?? []), query))),
    [props.items, query],
  );
  // Collapse state hoisted so keyboard navigation can expand/collapse;
  // nodes start expanded (previous behavior).
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    // Newly loaded items start open (union keeps user-collapsed nodes closed).
    setOpenIds((current) => {
      const next = new Set(current);
      const walk = (nodes: readonly TreeNode[]) => {
        for (const node of nodes) {
          if (node.children.length > 0) next.add(node.entry_id);
          walk(node.children);
        }
      };
      walk(tree);
      return next;
    });
  }, [tree]);

  const rows = useMemo(() => flattenVisible(tree, openIds), [tree, openIds]);

  const toggle = useCallback((id: string) => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const focusRow = useCallback((id: string) => {
    setFocusId(id);
    rowRefs.current.get(id)?.focus();
  }, []);

  const flatItems = useMemo(() => props.items ?? [], [props.items]);
  const nodesById = useMemo(() => {
    const map = new Map<string, TreeNode>();
    const walk = (nodes: readonly TreeNode[]) => {
      for (const node of nodes) {
        map.set(node.entry_id, node);
        walk(node.children);
      }
    };
    walk(tree);
    return map;
  }, [tree]);
  const dragged = dragId === null ? null : (nodesById.get(dragId) ?? null);

  // Reparent via HTML5 drag&drop (pointer shortcut; keyboard users keep the
  // Move/To-root menu items). Validity mirrors the server: never into itself
  // or its own subtree; root drop only for entries that are not already roots.
  const dnd: DndState = {
    dragId,
    dropId,
    onDragStart: (node) => {
      dragRef.current = node.entry_id;
      setDragId(node.entry_id);
      setDropId(null);
    },
    onDragOverRow: (node) => (event) => {
      const source = dragRef.current;
      if (source === null || !canMoveTo(flatItems, source, node.entry_id)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setDropId(node.entry_id);
    },
    onDropRow: (node) => (event) => {
      event.preventDefault();
      event.stopPropagation();
      const sourceId = dragRef.current;
      dragRef.current = null;
      setDragId(null);
      setDropId(null);
      const source = sourceId === null ? null : (nodesById.get(sourceId) ?? null);
      if (source === null || !canMoveTo(flatItems, source.entry_id, node.entry_id)) return;
      props.onMoveTo(source, node);
    },
    onDragOverRoot: (event) => {
      const source = dragRef.current === null ? null : (nodesById.get(dragRef.current) ?? null);
      if (source === null || source.parent_entry_id === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropId("");
    },
    onDropRoot: (event) => {
      event.preventDefault();
      const sourceId = dragRef.current;
      dragRef.current = null;
      setDragId(null);
      setDropId(null);
      const source = sourceId === null ? null : (nodesById.get(sourceId) ?? null);
      if (source === null || source.parent_entry_id === null) return;
      props.onMoveToRoot(source);
    },
    onDragEnd: () => {
      dragRef.current = null;
      setDragId(null);
      setDropId(null);
    },
  };

  const onRowKeyDown = useCallback(
    (event: React.KeyboardEvent, row: FlatRow) => {
      const index = rows.findIndex((candidate) => candidate.node.entry_id === row.node.entry_id);
      const focusAt = (position: number) => {
        const target = rows[position];
        if (target !== undefined) {
          event.preventDefault();
          focusRow(target.node.entry_id);
        }
      };
      switch (event.key) {
        case "ArrowDown":
          focusAt(index + 1);
          break;
        case "ArrowUp":
          focusAt(index - 1);
          break;
        case "Home":
          focusAt(0);
          break;
        case "End":
          focusAt(rows.length - 1);
          break;
        case "ArrowRight":
          if (row.node.children.length > 0 && !openIds.has(row.node.entry_id)) {
            event.preventDefault();
            toggle(row.node.entry_id);
          } else {
            focusAt(index + 1);
          }
          break;
        case "ArrowLeft":
          if (row.node.children.length > 0 && openIds.has(row.node.entry_id)) {
            event.preventDefault();
            toggle(row.node.entry_id);
          } else if (row.node.parent_entry_id !== null) {
            const parentIndex = rows.findIndex(
              (candidate) => candidate.node.entry_id === row.node.parent_entry_id,
            );
            if (parentIndex !== -1) focusAt(parentIndex);
          }
          break;
        case "Enter":
        case " ":
          event.preventDefault();
          props.onSelect(row.node);
          break;
        case "ContextMenu":
          setMenuOpenId(row.node.entry_id);
          break;
        default:
          if (event.key === "F10" && event.shiftKey) {
            event.preventDefault();
            setMenuOpenId(row.node.entry_id);
          }
      }
    },
    [rows, openIds, toggle, focusRow, props.onSelect],
  );

  if (props.error !== null) {
    return (
      <EmptyState
        title={props.error}
        action={<Button onClick={props.onReload}>{t("refresh")}</Button>}
      />
    );
  }
  if (props.items === null) {
    return (
      <div className="pcms-panel pcms-tree-skeleton" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((level) => (
          <div key={level} className="pcms-tree-skeleton__row">
            <Skeleton w={`${100 - level * 8}%`} h="20px" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="pcms-panel pcms-tree-panel">
      <div className="pcms-tree-toolbar">
        <h2 className="pcms-tree-toolbar__title">{t("nav_content")}</h2>
        <div className="pcms-tree-toolbar__controls">
          <input
            type="search"
            className="pcms-input pcms-tree-toolbar__search"
            placeholder={t("tree_search")}
            aria-label={t("tree_search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className="pcms-switch pcms-switch--compact">
            <input
              type="checkbox"
              checked={props.includeArchived}
              onChange={props.onToggleArchived}
              aria-label={t("tree_show_archived")}
            />
            <span>{t("tree_archive")}</span>
          </label>
          <Button size="sm" variant="primary" onClick={() => props.onCreate(null)}>
            {t("tree_create")}
          </Button>
        </div>
      </div>
      {tree.length === 0 ? (
        <EmptyState
          title={t("tree_empty_title")}
          hint={t("tree_empty_hint")}
          action={
            <Button variant="primary" onClick={() => props.onCreate(null)}>
              {t("tree_empty_action")}
            </Button>
          }
        />
      ) : (
        <ul
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: APG tree container
          role="tree"
          className={`pcms-tree${dropId === "" ? " pcms-tree--drop-root" : ""}`}
          aria-label={t("nav_content")}
          data-testid="content-tree"
          onKeyDown={(event) => {
            if (event.key === "Escape") setMenuOpenId(null);
          }}
          onDragOver={dnd.onDragOverRoot}
          onDrop={dnd.onDropRoot}
          onDragEnd={dnd.onDragEnd}
        >
          {tree.map((node) => (
            <Row
              key={node.entry_id}
              row={{ node, depth: 0 }}
              selectedId={props.selectedId}
              openIds={openIds}
              menuOpenId={menuOpenId}
              focusId={focusId}
              dnd={dnd}
              onToggle={toggle}
              onSelect={props.onSelect}
              onMenuToggle={(id) => setMenuOpenId(id)}
              onRowKeyDown={onRowKeyDown}
              registerRef={(id, element) => {
                if (element === null) {
                  rowRefs.current.delete(id);
                } else {
                  rowRefs.current.set(id, element);
                }
              }}
              actions={(target, close) => (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="pcms-menu__item"
                    onClick={() => {
                      close();
                      props.onCreate(target);
                    }}
                  >
                    <Icon name="plus" /> {t("tree_action_child")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="pcms-menu__item"
                    onClick={() => {
                      close();
                      props.onMove(target);
                    }}
                  >
                    <Icon name="move" /> {t("move")}
                  </button>
                  {target.parent_entry_id !== null ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="pcms-menu__item"
                      onClick={() => {
                        close();
                        props.onMoveToRoot(target);
                      }}
                    >
                      <Icon name="history" /> {t("tree_action_to_root")}
                    </button>
                  ) : null}
                  {target.kind === "content" ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="pcms-menu__item"
                      onClick={() => {
                        close();
                        props.onDuplicate(target);
                      }}
                    >
                      <Icon name="duplicate" /> {t("duplicate")}
                    </button>
                  ) : null}
                  {target.archived_at === null ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="pcms-menu__item pcms-menu__item--danger"
                      onClick={() => {
                        close();
                        props.onArchive(target);
                      }}
                    >
                      <Icon name="archive" /> {t("tree_action_archive")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      className="pcms-menu__item"
                      onClick={() => {
                        close();
                        props.onRestore(target);
                      }}
                    >
                      <Icon name="restore" /> {t("restore")}
                    </button>
                  )}
                </>
              )}
            />
          ))}
        </ul>
      )}
      {dragged !== null && dragged.parent_entry_id !== null ? (
        // Doubles as a click fallback for "move to root" while dragging.
        <button
          type="button"
          className={`pcms-tree__root-drop${dropId === "" ? " pcms-tree__root-drop--active" : ""}`}
          data-testid="tree-drop-root"
          onClick={() => props.onMoveToRoot(dragged)}
          onDragOver={dnd.onDragOverRoot}
          onDrop={dnd.onDropRoot}
        >
          <Icon name="history" /> {t("tree_drop_root")}
        </button>
      ) : null}
    </div>
  );
}
