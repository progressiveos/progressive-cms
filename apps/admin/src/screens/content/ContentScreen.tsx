// Content screen (PCMS-ADMIN-T003; Admin spec §4): Content Tree + Entry
// workspace. Tree operations never touch URLs/navigation (explicit route
// workflow arrives with the Route tab, T011). Archive is a public-facing
// mutation and gets a ConfirmDialog (redesign spec §3.1).
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiGet } from "../../api/client.js";
import {
  archiveEntry,
  type ContentTreeItemWire,
  type ContentTypeSummary,
  createDraft,
  duplicateEntry,
  fetchContentTree,
  fetchContentTypes,
  moveEntry,
  restoreEntry,
} from "../../api/content.js";
import { ConfirmDialog, Dialog } from "../../design/dialog.js";
import { useToast } from "../../design/toast.js";
import { Button, Field, Input, Select } from "../../design/ui.js";
import { errorText, t } from "../../i18n/index.js";
import { navigate, useRoute } from "../../layout/router.js";
import { ContentTree, type TreeNode } from "./ContentTree.js";
import { EntryWorkspace } from "./EntryWorkspace.js";
import { FolderWorkspace } from "./FolderWorkspace.js";
import { EntryPickerDialog } from "./fields/pickers.js";
import { ancestorChain, subtreeIds } from "./tree-model.js";

/** Minimal anchor the dialogs need (tree nodes and wire items both fit). */
type EntryAnchor = { readonly entry_id: string; readonly title: string | null };

export function ContentScreen() {
  const toast = useToast();
  const route = useRoute();
  const selectedId = route.segments[1] ?? null;

  const [items, setItems] = useState<readonly ContentTreeItemWire[] | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [types, setTypes] = useState<readonly ContentTypeSummary[]>([]);

  const [createFor, setCreateFor] = useState<EntryAnchor | null | undefined>(undefined);
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState("");
  const [templates, setTemplates] = useState<readonly { id: string }[] | null>(null);
  const [newTemplate, setNewTemplate] = useState("");
  const [moveTarget, setMoveTarget] = useState<EntryAnchor | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<EntryAnchor | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    fetchContentTree(includeArchived)
      .then((result) => {
        setItems(result.items);
        setTreeError(null);
      })
      .catch(() => setTreeError(t("tree_load_failed")));
  }, [includeArchived]);

  useEffect(reload, [reload]);
  useEffect(() => {
    void fetchContentTypes().then((result) => {
      setTypes(result.items);
      setNewType((current) => current || result.items[0]?.key || "");
    });
  }, []);

  const selected = items?.find((item) => item.entry_id === selectedId) ?? null;

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      toast(success, "success");
      reload();
    } catch (caught) {
      toast(
        caught instanceof ApiError
          ? (errorText(caught.code) ?? caught.message)
          : t("operation_failed"),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  // Theme Contract §15: the selector lists ONLY templates compatible with the
  // chosen type; a single compatible template is picked automatically.
  // editor_selectable=false marks system templates (home, error pages):
  // render-compatible, but not offered for new entries.
  useEffect(() => {
    if (createFor === undefined || newType === "") return;
    setTemplates(null);
    setNewTemplate("");
    apiGet<{ items: readonly { id: string; editor_selectable?: boolean }[] }>(
      `/discovery/content/templates?content_type=${encodeURIComponent(newType)}`,
    )
      .then((result) => {
        const selectable = result.items.filter((t) => t.editor_selectable !== false);
        setTemplates(selectable);
        setNewTemplate(selectable[0]?.id ?? "");
      })
      .catch(() => setTemplates([]));
  }, [createFor, newType]);

  const submitCreate = async () => {
    if (createFor === undefined || newType === "") return;
    const parent = createFor === null ? null : createFor.entry_id;
    const bodyPolicy = types.find((type) => type.key === newType)?.bodyPolicy;
    setBusy(true);
    try {
      const result = await createDraft({
        content_type: newType,
        ...(parent === null ? {} : { parent_entry_id: parent }),
        ...(newTemplate === "" || (templates ?? []).length <= 1
          ? {}
          : { template_key: newTemplate }),
        payload: {
          fields: newTitle === "" ? {} : { title: newTitle },
          blocks: bodyPolicy === "block_document" ? { schema_version: 1, blocks: [] } : null,
        },
      });
      toast(t("create_entry_done"), "success");
      setCreateFor(undefined);
      setNewTitle("");
      reload();
      navigate(`/content/${result.entry_id}`);
    } catch (caught) {
      toast(
        caught instanceof ApiError
          ? (errorText(caught.code) ?? caught.message)
          : t("create_entry_failed"),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pcms-columns pcms-columns--tree pcms-screen--wide">
      <ContentTree
        items={items}
        error={treeError}
        selectedId={selectedId}
        includeArchived={includeArchived}
        onToggleArchived={() => setIncludeArchived((value) => !value)}
        onSelect={(node) => navigate(`/content/${node.entry_id}`)}
        onReload={reload}
        onCreate={(parent) => setCreateFor(parent)}
        onMove={(node) => setMoveTarget(node)}
        onMoveTo={(node, newParent) =>
          void run(() => moveEntry(node.entry_id, newParent.entry_id), t("move_done"))
        }
        onMoveToRoot={(node) =>
          void run(() => moveEntry(node.entry_id, null), t("move_to_root_done"))
        }
        onDuplicate={(node) => void run(() => duplicateEntry(node.entry_id), t("duplicate_done"))}
        onArchive={(node) => setArchiveTarget(node)}
        onRestore={(node) => void run(() => restoreEntry(node.entry_id), t("restore_done"))}
      />
      {selected === null ? (
        <div className="pcms-panel">
          <p className="pcms-text-muted">{t("entry_pick_placeholder")}</p>
        </div>
      ) : selected.kind === "folder" ? (
        <FolderWorkspace
          key={selected.entry_id}
          entryId={selected.entry_id}
          title={selected.title}
          childCount={
            (items ?? []).filter((item) => item.parent_entry_id === selected.entry_id).length
          }
          {...(items === null ? {} : { location: ancestorChain(items, selected.entry_id) })}
          onOpenLocation={(entryId) => navigate(`/content/${entryId}`)}
          onChanged={reload}
          onCreateChild={() => setCreateFor(selected)}
          onMove={() => setMoveTarget(selected)}
          onArchive={() => setArchiveTarget(selected)}
        />
      ) : (
        <EntryWorkspace
          key={selected.entry_id}
          entryId={selected.entry_id}
          contentTypeKey={selected.content_type}
          onChanged={reload}
          {...(items === null ? {} : { location: ancestorChain(items, selected.entry_id) })}
          onOpenLocation={(entryId) => navigate(`/content/${entryId}`)}
          onMove={() => setMoveTarget(selected)}
          templateKey={selected.template_key}
          onChangedTemplate={reload}
        />
      )}

      <Dialog
        open={createFor !== undefined}
        onClose={() => setCreateFor(undefined)}
        title={
          createFor === null || createFor === undefined
            ? t("create_entry_title")
            : `${t("create_entry_parent_prefix")} «${createFor.title ?? "…"}»`
        }
        footer={
          <>
            <Button onClick={() => setCreateFor(undefined)}>{t("cancel")}</Button>
            <Button
              variant="primary"
              disabled={busy || newType === ""}
              onClick={() => void submitCreate()}
            >
              {t("create_entry_submit")}
            </Button>
          </>
        }
      >
        <Field label={t("create_entry_type")} required>
          <Select value={newType} onChange={(event) => setNewType(event.target.value)}>
            {types.map((type) => (
              <option key={type.key} value={type.key}>
                {type.title}
              </option>
            ))}
          </Select>
        </Field>
        {(templates ?? []).length > 1 ? (
          <Field label={t("create_entry_template")} hint={t("create_entry_template_hint")}>
            <Select value={newTemplate} onChange={(event) => setNewTemplate(event.target.value)}>
              {(templates ?? []).map((template) => (
                <option key={template.id} value={template.id}>
                  {template.id}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label={t("create_entry_heading")} hint={t("create_entry_heading_hint")}>
          <Input
            value={newTitle}
            maxLength={500}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder={t("publication.create_title_placeholder")}
          />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={archiveTarget !== null}
        onClose={() => setArchiveTarget(null)}
        onConfirm={() => {
          const target = archiveTarget;
          setArchiveTarget(null);
          if (target !== null) {
            void run(() => archiveEntry(target.entry_id), t("archive_done"));
          }
        }}
        title={t("tree_archive_confirm_title")}
        body={t("tree_archive_confirm_body")}
        details={
          archiveTarget === null
            ? []
            : [
                {
                  label: t("create_entry_heading"),
                  value: archiveTarget.title ?? archiveTarget.entry_id,
                },
              ]
        }
        confirmLabel={t("tree_archive_confirm_action")}
        tone="danger"
      />

      {moveTarget === null ? null : (
        <EntryPickerDialog
          open
          onClose={() => setMoveTarget(null)}
          title={`${t("tree_move_dialog_prefix")} «${moveTarget.title ?? moveTarget.entry_id}»?`}
          exclude={[...subtreeIds(items ?? [], moveTarget.entry_id)]}
          onPick={(entryId) => {
            const target = moveTarget;
            setMoveTarget(null);
            if (target === null || entryId === target.entry_id) return;
            void run(() => moveEntry(target.entry_id, entryId), t("move_done"));
          }}
        />
      )}
    </div>
  );
}
