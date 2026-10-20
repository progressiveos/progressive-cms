// Navigation workspace (PCMS-ADMIN-T012/T013; Admin spec §29-§31): sets,
// nested tree editor with all v1 item types, placements with theme depth
// validation, derived-set overrides with stale warnings. Separate from the
// Content Tree by design — nothing links the two models.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPut } from "../../api/client.js";
import { useAuth } from "../../auth/AuthContext.js";
import { ConfirmDialog, Dialog } from "../../design/dialog.js";
import { useToast } from "../../design/toast.js";
import {
  type AdminIconName,
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Input,
  Select,
  Spinner,
} from "../../design/ui.js";
import { errorText, t } from "../../i18n/index.js";
import { EntryPickerDialog } from "../content/fields/pickers.js";

interface NavSet {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly derivedFromSetId: string | null;
}

interface NavNode {
  readonly id: string;
  readonly type: string;
  readonly label: string | null;
  readonly target: Record<string, unknown> | null;
  readonly uiIntent: string | null;
  readonly children: readonly NavNode[];
}

interface PlacementBinding {
  readonly placementKey: string;
  readonly navigationSetId: string;
}

interface PlacementDescriptorWire {
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly required: boolean;
  readonly maxDepth: number;
  readonly supportedItemTypes: readonly string[];
  readonly fallback: string | null;
}

const TYPE_TITLE_KEYS: Readonly<Record<string, string>> = {
  internal_entry: "navigation.type_internal_entry",
  external_url: "navigation.type_external_url",
  anchor: "navigation.type_anchor",
  group: "navigation.type_group",
  separator: "navigation.type_separator",
  action: "navigation.type_action",
};

// Dense rows carry the type as a semantic icon + tooltip, never as a text
// chip that competes with the item label (owner rule: statuses/types must not
// crowd titles in dense lists).
const TYPE_ICONS: Readonly<Record<string, AdminIconName>> = {
  internal_entry: "typeArticle",
  external_url: "typeExternal",
  anchor: "typeAnchor",
  group: "typeFolder",
  separator: "typeSeparator",
  action: "typePhone",
};

function typeTitle(type: string): string {
  const key = TYPE_TITLE_KEYS[type];
  return key === undefined ? type : t(key);
}

function typeIcon(type: string): AdminIconName {
  return TYPE_ICONS[type] ?? "dot";
}

interface OverrideInfo {
  readonly id: string;
  readonly target_item_id: string;
  readonly op: string;
}

export function NavigationScreen() {
  const auth = useAuth();
  const toast = useToast();
  const [sets, setSets] = useState<readonly NavSet[] | null>(null);
  const [activeSetId, setActiveSetId] = useState<string | null>(null);
  const [tree, setTree] = useState<readonly NavNode[] | null>(null);
  const [overrides, setOverrides] = useState<readonly OverrideInfo[]>([]);
  const [stale, setStale] = useState<readonly { override_id: string; op: string }[]>([]);
  const [placements, setPlacements] = useState<readonly PlacementBinding[]>([]);
  const [placementKeys, setPlacementKeys] = useState<readonly PlacementDescriptorWire[]>([]);
  const [validation, setValidation] = useState<{
    ok: boolean;
    issues: readonly { code: string; message: string }[];
  } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [itemEdit, setItemEdit] = useState<{
    parentId: string | null;
    afterId: string | null;
  } | null>(null);
  const [editNode, setEditNode] = useState<NavNode | null>(null);
  const [renameNode, setRenameNode] = useState<NavNode | null>(null);
  const [renameLabel, setRenameLabel] = useState("");
  const [deleteNode, setDeleteNode] = useState<NavNode | null>(null);
  const [busy, setBusy] = useState(false);

  const activeSet = sets?.find((set) => set.id === activeSetId) ?? null;
  const overrideTargets = useMemo(
    () => new Set(overrides.map((override) => override.target_item_id)),
    [overrides],
  );

  const reloadSets = useCallback(() => {
    apiGet<{ items: readonly NavSet[] }>("/discovery/navigation/sets")
      .then((result) => {
        setSets(result.items);
        setActiveSetId((current) => current ?? result.items[0]?.id ?? null);
      })
      .catch(() => toast(t("navigation.load_sets_failed"), "error"));
  }, [toast]);

  const reloadTree = useCallback(() => {
    if (activeSetId === null) return;
    void apiGet<{ items: readonly NavNode[] }>(`/discovery/navigation/trees/${activeSetId}`).then(
      (result) => setTree(result.items),
    );
    void apiGet<{
      overrides: readonly OverrideInfo[];
      stale: readonly { override_id: string; op: string }[];
    }>(`/navigation/sets/${activeSetId}/overrides`).then((result) => {
      setOverrides(result.overrides);
      setStale(result.stale);
    });
  }, [activeSetId]);

  const reloadPlacements = useCallback(() => {
    void apiGet<{
      placements: readonly PlacementDescriptorWire[];
      bindings: readonly PlacementBinding[];
    }>("/discovery/navigation/placements").then((result) => {
      setPlacementKeys(result.placements);
      setPlacements(result.bindings);
    });
    void apiGet<{ ok: boolean; issues: readonly { code: string; message: string }[] }>(
      "/navigation/validate",
    ).then(setValidation);
  }, []);

  useEffect(reloadSets, [reloadSets]);
  useEffect(reloadTree, [reloadTree]);
  useEffect(reloadPlacements, [reloadPlacements]);

  const run = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await action();
      if (success !== undefined) toast(success, "success");
      reloadTree();
      reloadPlacements();
    } catch (caught) {
      toast(
        caught instanceof ApiError
          ? (errorText(caught.code) ?? caught.message)
          : t("navigation.operation_failed"),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  if (sets === null) return <Spinner />;

  return (
    <div className="pcms-screen--wide" data-testid="navigation-workspace">
      <h1>{t("navigation.title")}</h1>
      <div className="pcms-toolbar">
        <strong>{t("navigation.title")}</strong>
        <span className="pcms-toolbar__spacer" />
        {auth.can("navigation.edit") ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            {t("navigation.new_set")}
          </Button>
        ) : null}
        {activeSetId !== null && auth.can("navigation.publish") ? (
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            title={t("navigation.seal_hint")}
            onClick={() =>
              void run(
                () => apiPost(`/navigation/sets/${activeSetId}/seal`, {}),
                t("navigation.sealed_toast"),
              )
            }
          >
            {t("navigation.seal")}
          </Button>
        ) : null}
      </div>

      <div className="pcms-columns pcms-columns--tree">
        <div>
          <div className="pcms-panel">
            <h3>{t("navigation.sets")}</h3>
            {sets.length === 0 ? (
              <EmptyState title={t("navigation.sets_empty")} />
            ) : (
              <ul className="pcms-tree">
                {sets.map((set) => (
                  <li key={set.id}>
                    <button
                      type="button"
                      className="pcms-tree__row"
                      aria-current={set.id === activeSetId}
                      onClick={() => setActiveSetId(set.id)}
                    >
                      <span className="pcms-tree__label">
                        {set.derivedFromSetId !== null
                          ? t("navigation.set_derived", { title: set.title })
                          : set.title}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="pcms-nav-workspace">
          <div className="pcms-panel">
            {activeSet === null ? (
              <EmptyState title={t("navigation.select_set")} />
            ) : (
              <>
                <div className="pcms-toolbar">
                  <h3>{activeSet.title}</h3>
                  {stale.length > 0 ? (
                    <Badge tone="danger" data-testid="stale-overrides">
                      {t("navigation.stale_count", { count: stale.length })}
                    </Badge>
                  ) : null}
                  <span className="pcms-toolbar__spacer" />
                  {auth.can("navigation.edit") ? (
                    <Button
                      size="sm"
                      onClick={() => setItemEdit({ parentId: null, afterId: null })}
                    >
                      {t("navigation.add_item")}
                    </Button>
                  ) : null}
                </div>
                {tree === null ? (
                  <Spinner />
                ) : tree.length === 0 ? (
                  <EmptyState
                    title={t("navigation.tree_empty")}
                    hint={t("navigation.tree_empty_hint")}
                  />
                ) : (
                  <NavTreeEditor
                    nodes={tree}
                    depth={0}
                    busy={busy}
                    editable={auth.can("navigation.edit")}
                    derived={activeSet.derivedFromSetId !== null}
                    overrideTargets={overrideTargets}
                    onEdit={(node) => setEditNode(node)}
                    onAddChild={(parentId) => setItemEdit({ parentId, afterId: null })}
                    onAddAfter={(node) => setItemEdit({ parentId: null, afterId: node.id })}
                    onMove={(node, direction) => {
                      const flat = flatten(tree);
                      const index = flat.findIndex((entry) => entry.node.id === node.id);
                      const entry = flat[index];
                      if (entry === undefined) return;
                      const siblings = entry.parent === null ? tree : entry.parent.children;
                      const siblingIndex = siblings.findIndex(
                        (candidate) => candidate.id === node.id,
                      );
                      const target = siblingIndex + direction;
                      if (target < 0 || target >= siblings.length) return;
                      void run(() =>
                        apiPost(`/navigation/sets/${activeSet.id}/items/${node.id}/move`, {
                          parent_item_id: entry.parent?.id ?? null,
                          at: target,
                        }),
                      );
                    }}
                    onDelete={(node) => setDeleteNode(node)}
                    onOverride={(node, op, payload) =>
                      void run(() =>
                        apiPost(`/navigation/sets/${activeSet.id}/overrides`, {
                          target_item_id: node.id,
                          op,
                          payload,
                        }),
                      )
                    }
                    onRename={(node) => {
                      setRenameLabel(node.label ?? "");
                      setRenameNode(node);
                    }}
                  />
                )}
              </>
            )}
          </div>

          <div className="pcms-panel" data-testid="placements-panel">
            <h3>{t("navigation.placements_human")}</h3>
            {placementKeys.length === 0 ? (
              <p className="pcms-field__hint">{t("navigation.placements_none")}</p>
            ) : (
              <div className="pcms-placement-list">
                {placementKeys.map((placement) => {
                  const binding = placements.find(
                    (candidate) => candidate.placementKey === placement.id,
                  );
                  const boundSet = sets.find((set) => set.id === binding?.navigationSetId);
                  return (
                    <div key={placement.id} className="pcms-placement-row">
                      <Icon
                        name={binding === undefined ? "dot" : "check"}
                        label={
                          binding === undefined ? t("navigation.not_used") : t("navigation.used")
                        }
                        title={
                          binding === undefined ? t("navigation.not_used") : t("navigation.used")
                        }
                        className={
                          binding === undefined
                            ? "pcms-placement-row__mark pcms-placement-row__mark--off"
                            : "pcms-placement-row__mark"
                        }
                      />
                      <div className="pcms-placement-row__body">
                        <strong>{placement.label}</strong>
                        <div className="pcms-picker-row__meta">
                          {placement.description !== null ? `${placement.description} · ` : ""}
                          {t("navigation.depth_max", { depth: placement.maxDepth })}
                          {placement.required ? t("navigation.required_suffix") : ""}
                        </div>
                      </div>
                      {auth.can("navigation.edit") ? (
                        <select
                          className="pcms-select pcms-placement-row__binding"
                          aria-label={t("navigation.set_for_placement", {
                            placement: placement.label,
                          })}
                          value={binding?.navigationSetId ?? ""}
                          onChange={(event) => {
                            const setId = event.target.value;
                            if (setId === "") {
                              void run(() => apiDelete(`/navigation/placements/${placement.id}`));
                            } else {
                              void run(() =>
                                apiPut(`/navigation/placements/${placement.id}`, {
                                  navigation_set_id: setId,
                                }),
                              );
                            }
                          }}
                        >
                          <option value="">{t("navigation.unbound_option")}</option>
                          {sets.map((set) => (
                            <option key={set.id} value={set.id}>
                              {set.title}
                            </option>
                          ))}
                        </select>
                      ) : binding === undefined ? (
                        <span className="pcms-field__hint pcms-placement-row__binding">
                          {t("navigation.not_used")}
                        </span>
                      ) : (
                        <Badge tone="success">{boundSet?.title ?? t("navigation.bound")}</Badge>
                      )}
                      <code
                        className="pcms-placement-row__key"
                        title={t("navigation.placement_key_hint")}
                      >
                        {placement.id}
                      </code>
                    </div>
                  );
                })}
              </div>
            )}
            {validation === null ? null : validation.ok ? (
              <Badge tone="success">{t("navigation.bindings_valid")}</Badge>
            ) : (
              <div className="pcms-field__error" role="alert">
                {validation.issues.map((issue) => (
                  <div key={`${issue.code}-${issue.message}`}>{issue.message}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {deleteNode !== null && activeSet !== null ? (
        <ConfirmDialog
          open
          onClose={() => setDeleteNode(null)}
          title={t("navigation.delete_item")}
          body={t(
            deleteNode.children.length > 0
              ? "navigation.delete_confirm_body_children"
              : "navigation.delete_confirm_body",
            { label: deleteNode.label ?? t("navigation.unnamed") },
          )}
          confirmLabel={t("navigation.delete")}
          tone="danger"
          busy={busy}
          onConfirm={() => {
            const node = deleteNode;
            setDeleteNode(null);
            void run(() => apiDelete(`/navigation/sets/${activeSet.id}/items/${node.id}`));
          }}
        />
      ) : null}

      {renameNode !== null && activeSet !== null ? (
        <Dialog
          open
          onClose={() => setRenameNode(null)}
          title={t("navigation.rename_title")}
          footer={
            <>
              <Button onClick={() => setRenameNode(null)}>{t("navigation.cancel")}</Button>
              <Button
                variant="primary"
                disabled={renameLabel.trim() === "" || busy}
                onClick={() => {
                  const node = renameNode;
                  const label = renameLabel.trim();
                  setRenameNode(null);
                  if (node !== null && label !== "")
                    void run(() =>
                      apiPost(`/navigation/sets/${activeSet.id}/overrides`, {
                        target_item_id: node.id,
                        op: "relabel",
                        payload: { label },
                      }),
                    );
                }}
              >
                {t("navigation.rename")}
              </Button>
            </>
          }
        >
          <Field label={t("navigation.rename_label")} required>
            <Input
              value={renameLabel}
              maxLength={200}
              autoFocus
              onChange={(event) => setRenameLabel(event.target.value)}
            />
          </Field>
        </Dialog>
      ) : null}
      {createOpen ? (
        <CreateSetDialog
          sets={sets}
          onClose={() => setCreateOpen(false)}
          onCreate={(payload) => {
            setCreateOpen(false);
            void run(async () => {
              const result = await apiPost<{ set_id: string }>("/navigation/sets", payload);
              reloadSets();
              setActiveSetId(result.set_id);
            }, t("navigation.set_created"));
          }}
        />
      ) : null}
      {editNode !== null && activeSet !== null ? (
        <ItemEditDialog
          node={editNode}
          onClose={() => setEditNode(null)}
          onUpdate={(payload) => {
            const node = editNode;
            setEditNode(null);
            void run(
              () => apiPatch(`/navigation/sets/${activeSet.id}/items/${node.id}`, payload),
              t("navigation.item_saved"),
            );
          }}
        />
      ) : null}
      {itemEdit !== null && activeSet !== null ? (
        <ItemEditDialog
          onClose={() => setItemEdit(null)}
          onCreate={(payload) => {
            setItemEdit(null);
            void run(async () => {
              await apiPost(`/navigation/sets/${activeSet.id}/items`, {
                parent_item_id: itemEdit.parentId,
                ...payload,
                ...(itemEdit.afterId === null
                  ? {}
                  : {
                      at:
                        (
                          flatten(tree ?? []).find((entry) => entry.node.id === itemEdit.afterId)
                            ?.siblings ?? []
                        ).length + 1,
                    }),
              });
            }, t("navigation.item_added"));
          }}
        />
      ) : null}
    </div>
  );
}

interface FlatEntry {
  readonly node: NavNode;
  readonly parent: NavNode | null;
  readonly siblings: readonly NavNode[];
}

function flatten(nodes: readonly NavNode[], parent: NavNode | null = null): FlatEntry[] {
  return nodes.flatMap((node) => [
    { node, parent, siblings: nodes },
    ...flatten(node.children, node),
  ]);
}

function NavTreeEditor(props: {
  readonly nodes: readonly NavNode[];
  readonly depth: number;
  readonly busy: boolean;
  readonly editable: boolean;
  readonly derived: boolean;
  readonly overrideTargets: ReadonlySet<string>;
  readonly onAddChild: (parentId: string) => void;
  readonly onAddAfter: (node: NavNode) => void;
  readonly onMove: (node: NavNode, direction: 1 | -1) => void;
  readonly onDelete: (node: NavNode) => void;
  readonly onOverride: (node: NavNode, op: string, payload: Record<string, unknown>) => void;
  readonly onRename: (node: NavNode) => void;
  readonly onEdit: (node: NavNode) => void;
}) {
  return (
    <ul className="pcms-tree">
      {props.nodes.map((node) => (
        <li key={node.id}>
          <div className="pcms-tree__line">
            <button
              type="button"
              className="pcms-tree__row"
              style={{ paddingLeft: `${props.depth * 0.75}rem` }}
              data-testid={`nav-item-${node.id}`}
              title={t("navigation.edit_item_hint")}
              onClick={() => props.onEdit(node)}
            >
              <Icon
                name={typeIcon(node.type)}
                label={typeTitle(node.type)}
                title={typeTitle(node.type)}
                className="pcms-nav-type-icon"
              />
              <span className="pcms-tree__label">
                {node.label ?? <em className="pcms-text-muted">{t("navigation.unnamed")}</em>}
              </span>
              {props.overrideTargets.has(node.id) ? (
                <Icon
                  name="edit"
                  label={t("navigation.overridden")}
                  title={t("navigation.overridden")}
                  className="pcms-nav-type-icon pcms-nav-type-icon--accent"
                />
              ) : null}
            </button>
            {props.editable ? (
              <div className="pcms-row__actions">
                {node.type === "group" ? (
                  <IconButton
                    icon="addInside"
                    label={t("navigation.add_inside")}
                    small
                    disabled={props.busy}
                    onClick={() => props.onAddChild(node.id)}
                  />
                ) : null}
                <IconButton
                  icon="plus"
                  label={t("navigation.add_after")}
                  small
                  disabled={props.busy}
                  onClick={() => props.onAddAfter(node)}
                />
                <IconButton
                  icon="arrowUp"
                  label={t("navigation.move_up")}
                  small
                  disabled={props.busy}
                  onClick={() => props.onMove(node, -1)}
                />
                <IconButton
                  icon="arrowDown"
                  label={t("navigation.move_down")}
                  small
                  disabled={props.busy}
                  onClick={() => props.onMove(node, 1)}
                />
                {props.derived ? (
                  <>
                    <IconButton
                      icon="edit"
                      label={t("navigation.rename")}
                      small
                      disabled={props.busy}
                      onClick={() => props.onRename(node)}
                    />
                    <IconButton
                      icon="hide"
                      label={t("navigation.hide")}
                      small
                      disabled={props.busy}
                      onClick={() => props.onOverride(node, "hide", {})}
                    />
                  </>
                ) : null}
                <IconButton
                  icon="delete"
                  label={t("navigation.delete_item")}
                  small
                  variant="danger"
                  disabled={props.busy}
                  testid={`nav-item-delete-${node.id}`}
                  onClick={() => props.onDelete(node)}
                />
              </div>
            ) : null}
          </div>
          {node.children.length > 0 ? (
            <ul className="pcms-tree__children">
              <NavTreeEditor {...props} nodes={node.children} depth={props.depth + 1} />
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function CreateSetDialog(props: {
  readonly sets: readonly NavSet[];
  readonly onClose: () => void;
  readonly onCreate: (payload: {
    key: string;
    title: string;
    derived_from_set_id?: string;
  }) => void;
}) {
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [derivedFrom, setDerivedFrom] = useState("");
  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t("navigation.create_set_title")}
      footer={
        <>
          <Button onClick={props.onClose}>{t("navigation.cancel")}</Button>
          <Button
            variant="primary"
            disabled={key === "" || title === ""}
            onClick={() =>
              props.onCreate({
                key,
                title,
                ...(derivedFrom === "" ? {} : { derived_from_set_id: derivedFrom }),
              })
            }
          >
            {t("navigation.create")}
          </Button>
        </>
      }
    >
      <Field label={t("navigation.field_key")} required hint={t("navigation.field_key_hint")}>
        <Input value={key} maxLength={64} onChange={(event) => setKey(event.target.value)} />
      </Field>
      <Field label={t("navigation.field_title")} required>
        <Input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field label={t("navigation.field_derived_from")} hint={t("navigation.field_derived_hint")}>
        <Select value={derivedFrom} onChange={(event) => setDerivedFrom(event.target.value)}>
          <option value="">{t("navigation.standalone_option")}</option>
          {props.sets.map((set) => (
            <option key={set.id} value={set.id}>
              {set.title}
            </option>
          ))}
        </Select>
      </Field>
    </Dialog>
  );
}

/** One typed item editor for BOTH create and edit modes (spec §5): same
 * fields, same validation, per-type target inputs over the six v1 types. */
function ItemEditDialog(props: {
  readonly node?: NavNode;
  readonly onClose: () => void;
  readonly onCreate?: (payload: {
    type: string;
    label?: string;
    target?: Record<string, unknown>;
    ui_intent?: string;
  }) => void;
  readonly onUpdate?: (payload: {
    type: string;
    label?: string;
    target?: Record<string, unknown>;
    ui_intent?: string;
  }) => void;
}) {
  const editing = props.node !== undefined;
  const [type, setType] = useState(props.node?.type ?? "internal_entry");
  const [label, setLabel] = useState(props.node?.label ?? "");
  const [entryId, setEntryId] = useState<string | null>(
    typeof props.node?.target?.entry_id === "string" ? props.node.target.entry_id : null,
  );
  const [entryLabel, setEntryLabel] = useState("");
  const [url, setUrl] = useState(
    typeof props.node?.target?.url === "string" ? props.node.target.url : "",
  );
  const [anchor, setAnchor] = useState(
    typeof props.node?.target?.anchor === "string" ? props.node.target.anchor : "",
  );
  const [phone, setPhone] = useState(
    typeof props.node?.target?.phone === "string" ? props.node.target.phone : "",
  );
  const [picking, setPicking] = useState(false);

  const build = (): {
    type: string;
    label?: string;
    target?: Record<string, unknown>;
    ui_intent?: string;
  } => {
    const payload: {
      type: string;
      label?: string;
      target?: Record<string, unknown>;
      ui_intent?: string;
    } = {
      type,
    };
    if (label !== "") payload.label = label;
    if (type === "internal_entry" && entryId !== null) payload.target = { entry_id: entryId };
    if (type === "external_url") payload.target = { url, target: "_self", rel: ["noopener"] };
    if (type === "anchor") payload.target = { anchor, entry_id: null };
    if (type === "action") {
      payload.target = { kind: "phone", phone };
      payload.ui_intent = "button";
    }
    return payload;
  };

  const submitValid = type !== "internal_entry" || entryId !== null;

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t(editing ? "navigation.edit_item_title" : "navigation.create_item_title")}
      footer={
        <>
          <Button onClick={props.onClose}>{t("navigation.cancel")}</Button>
          <Button
            variant="primary"
            disabled={!submitValid}
            onClick={() => {
              const payload = build();
              if (!submitValid) return;
              if (editing) props.onUpdate?.(payload);
              else props.onCreate?.(payload);
            }}
          >
            {t(editing ? "navigation.save" : "navigation.add")}
          </Button>
        </>
      }
    >
      <Field label={t("navigation.field_type")} required>
        <Select value={type} onChange={(event) => setType(event.target.value)}>
          {Object.entries(TYPE_TITLE_KEYS).map(([value, key]) => (
            <option key={value} value={value}>
              {t(key)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("navigation.field_label")} hint={t("navigation.field_label_hint")}>
        <Input value={label} maxLength={200} onChange={(event) => setLabel(event.target.value)} />
      </Field>
      {type === "internal_entry" ? (
        <Field label={t("navigation.field_entry")} required>
          <div className="pcms-ref">
            <span className="pcms-picker-row__meta">
              {entryLabel !== "" ? entryLabel : (entryId ?? t("navigation.entry_none"))}
            </span>
            <Button size="sm" onClick={() => setPicking(true)}>
              {t("navigation.pick")}
            </Button>
          </div>
        </Field>
      ) : null}
      {type === "external_url" ? (
        <Field label={t("navigation.field_url")} required hint={t("navigation.field_url_hint")}>
          <Input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://"
          />
        </Field>
      ) : null}
      {type === "anchor" ? (
        <Field label={t("navigation.field_anchor")} required>
          <Input
            value={anchor}
            maxLength={128}
            onChange={(event) => setAnchor(event.target.value)}
          />
        </Field>
      ) : null}
      {type === "action" ? (
        <Field label={t("navigation.field_phone")} required>
          <Input
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="+7…"
          />
        </Field>
      ) : null}
      {picking ? (
        <EntryPickerDialog
          open
          onClose={() => setPicking(false)}
          title={t("navigation.pick_entry_title")}
          onPick={(picked, pickedLabel) => {
            setPicking(false);
            setEntryId(picked);
            setEntryLabel(pickedLabel);
          }}
        />
      ) : null}
    </Dialog>
  );
}
