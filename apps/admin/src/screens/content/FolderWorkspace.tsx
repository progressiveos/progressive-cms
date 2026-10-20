// Structural folder workspace (entry_kind = "folder"): editorial metadata
// only — name, tree location, child count. No content editor, no
// SEO/route/revisions/publication tabs (folders have no public lifecycle;
// the backend rejects those with ENTRY_KIND_FORBIDDEN).
import { useState } from "react";
import { ApiError } from "../../api/client.js";
import { createWorkingDraft, getRevision, updateDraft } from "../../api/content.js";
import { Dialog } from "../../design/dialog.js";
import { useToast } from "../../design/toast.js";
import { Button, Field, Icon, Input } from "../../design/ui.js";
import { errorText, t } from "../../i18n/index.js";
import { type LocationCrumb, LocationStrip } from "./EntryWorkspace.js";

export function FolderWorkspace(props: {
  readonly entryId: string;
  readonly title: string | null;
  readonly childCount: number;
  readonly location?: readonly LocationCrumb[];
  readonly onOpenLocation?: (entryId: string) => void;
  readonly onChanged: () => void;
  readonly onCreateChild: () => void;
  readonly onMove: () => void;
  readonly onArchive: () => void;
}) {
  const toast = useToast();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  // Rename rides the normal draft machinery (a folder keeps one working
  // revision whose title the tree displays; nothing to seal or publish).
  const submitRename = async () => {
    setBusy(true);
    try {
      const draft = await createWorkingDraft(props.entryId);
      const revision = await getRevision(draft.revision_id);
      await updateDraft(
        draft.revision_id,
        { fields: { ...(revision.payload.fields ?? {}), title: name } },
        draft.edit_generation,
      );
      toast(t("folder_rename_done"), "success");
      setRenaming(false);
      props.onChanged();
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

  return (
    <div className="pcms-panel pcms-editor" data-testid="folder-workspace">
      <div className="pcms-editor__header">
        <div className="pcms-editor__heading">
          <h2 className="pcms-editor__title" data-testid="folder-title">
            <Icon name="typeFolder" /> {props.title ?? t("tree_untitled")}
          </h2>
          <span className="pcms-editor__meta">{t("folder_kind_label")}</span>
        </div>
      </div>
      <div className="pcms-editor__location" data-testid="folder-location">
        <span className="pcms-editor__location-label">{t("editor_location_label")}</span>
        <LocationStrip
          {...(props.location === undefined ? {} : { location: props.location })}
          {...(props.onOpenLocation === undefined ? {} : { onOpenLocation: props.onOpenLocation })}
        />
      </div>
      <p className="pcms-text-muted" data-testid="folder-child-count">
        {t("folder_children_label")}: {props.childCount}
      </p>
      <div className="pcms-folder-actions">
        <Button variant="primary" onClick={props.onCreateChild}>
          <Icon name="plus" /> {t("tree_action_child")}
        </Button>
        <Button
          onClick={() => {
            setName(props.title ?? "");
            setRenaming(true);
          }}
        >
          <Icon name="edit" /> {t("folder_rename")}
        </Button>
        <Button onClick={props.onMove}>
          <Icon name="move" /> {t("move")}
        </Button>
        <Button variant="danger" onClick={props.onArchive}>
          <Icon name="archive" /> {t("folder_archive")}
        </Button>
      </div>
      <p className="pcms-field__hint">{t("folder_hint")}</p>
      <Dialog
        open={renaming}
        onClose={() => setRenaming(false)}
        title={t("folder_rename_title")}
        footer={
          <>
            <Button onClick={() => setRenaming(false)}>{t("cancel")}</Button>
            <Button
              variant="primary"
              disabled={busy || name === ""}
              onClick={() => void submitRename()}
            >
              {t("save")}
            </Button>
          </>
        }
      >
        <Field label={t("folder_name")} required>
          <Input value={name} maxLength={500} onChange={(event) => setName(event.target.value)} />
        </Field>
      </Dialog>
    </div>
  );
}
