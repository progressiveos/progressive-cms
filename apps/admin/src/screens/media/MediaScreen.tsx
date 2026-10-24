// Media library (PCMS-ADMIN-T014/T015; Admin spec §32/§33): grid/list views,
// upload, search/filter, details drawer with metadata/usage/versions, and
// document version replacement — over the M05 API semantics only.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiRequest } from "../../api/client.js";
import { useAuth } from "../../auth/AuthContext.js";
import { ConfirmDialog, Dialog, Drawer } from "../../design/dialog.js";
import { useToast } from "../../design/toast.js";
import {
  Button,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Input,
  Select,
  Spinner,
  Tabs,
} from "../../design/ui.js";
import { useDebouncedReload } from "../../design/use-debounced-reload.js";
import { formatDateTime, formatFileSize } from "../../i18n/format.js";
import { errorText, t } from "../../i18n/index.js";
import { GeneratePanel, StockPanel, useMediaProviders } from "./acquisition.js";
import { GenerationStudio } from "./GenerationStudio.js";
import { type MediaVariantFailureWire, mediaVariantWarning } from "./variant-warning.js";

interface MediaFolder {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
}

type FolderFilter = "all" | "none" | string;

interface MediaItem {
  readonly id: string;
  readonly kind: string;
  readonly filenameOriginal: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly title: string | null;
  readonly altDefault: string | null;
  readonly captionDefault: string | null;
  readonly sourceName: string | null;
  readonly author: string | null;
  readonly focalX: number | null;
  readonly focalY: number | null;
  readonly archivedAt: string | null;
  readonly folderId: string | null;
}

export function MediaScreen() {
  const auth = useAuth();
  const toast = useToast();
  const { providers: acquisitionProviders } = useMediaProviders();
  const [workspace, setWorkspace] = useState<"library" | "stock" | "generate" | "studio">(
    "library",
  );
  const stockAvailable = (acquisitionProviders ?? []).some(
    (entry) => entry.kind === "stock" && entry.configured,
  );
  const generateAvailable = (acquisitionProviders ?? []).some(
    (entry) => entry.kind === "generation" && entry.configured,
  );
  const [items, setItems] = useState<readonly MediaItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [kind, setKind] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [folders, setFolders] = useState<readonly MediaFolder[]>([]);
  const [folder, setFolder] = useState<FolderFilter>("all");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  const reloadFolders = useCallback(() => {
    apiGet<{ items: readonly MediaFolder[] }>("/media/folders")
      .then((result) => setFolders(result.items))
      .catch(() => setFolders([]));
  }, []);

  useEffect(reloadFolders, [reloadFolders]);

  const reload = useCallback(() => {
    setError(null);
    const params = new URLSearchParams({ limit: "60" });
    if (text !== "") params.set("text", text);
    if (kind !== "") params.set("kind", kind);
    if (folder !== "all") params.set("folder_id", folder);
    apiGet<{ items: readonly MediaItem[] }>(`/media?${params.toString()}`)
      .then((result) => {
        setItems(result.items.filter((item) => item.archivedAt === null));
        setSelected((current) =>
          current === null ? null : (result.items.find((i) => i.id === current.id) ?? null),
        );
      })
      .catch(() => setError(t("media.load_failed")));
  }, [text, kind, folder]);

  useDebouncedReload(reload);

  const upload = async (files: FileList | null) => {
    const file = files?.[0];
    if (file === undefined) return;
    setUploading(true);
    try {
      const bytes = await file.arrayBuffer();
      const result = await apiRequest<{
        readonly media_variant_failures?: readonly MediaVariantFailureWire[];
      }>("POST", "/media", {
        headers: {
          "x-pcms-filename": encodeURIComponent(file.name),
          "x-pcms-mime-type": file.type || "application/octet-stream",
          "content-type": "application/octet-stream",
          ...(folder !== "all" && folder !== "none" ? { "x-pcms-folder-id": folder } : {}),
        },
        rawBody: bytes,
      });
      const warning = mediaVariantWarning(result.media_variant_failures);
      toast(warning ?? t("media.upload_success"), warning === null ? "success" : "warning");
      reload();
    } catch (caught) {
      toast(
        caught instanceof ApiError
          ? (errorText(caught.code) ?? caught.message)
          : t("media.upload_failed"),
        "error",
      );
    } finally {
      setUploading(false);
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="pcms-screen--wide" data-testid="media-screen">
      <h1>{t("media.title")}</h1>
      <Tabs
        label={t("media.acq_tabs_label")}
        active={workspace}
        onSelect={(id) => setWorkspace(id as "library" | "stock" | "generate" | "studio")}
        items={[
          { id: "library", title: t("media.acq_tab_library") },
          ...(stockAvailable ? [{ id: "stock", title: t("media.acq_tab_stock") }] : []),
          ...(generateAvailable ? [{ id: "generate", title: t("media.acq_tab_generate") }] : []),
          ...(generateAvailable ? [{ id: "studio", title: t("media.studio_tab") }] : []),
        ]}
      />
      {workspace === "stock" ? (
        <StockPanel
          onImported={(mediaId, _label, failures) => {
            const warning = mediaVariantWarning(failures);
            toast(warning ?? t("media.acq_imported"), warning === null ? "success" : "warning");
            setWorkspace("library");
            setSelected({ id: mediaId } as MediaItem);
            reload();
          }}
        />
      ) : null}
      {workspace === "generate" ? (
        <GeneratePanel
          onAccepted={(mediaId, _label, failures) => {
            const warning = mediaVariantWarning(failures);
            toast(warning ?? t("media.acq_accepted"), warning === null ? "success" : "warning");
            setWorkspace("library");
            setSelected({ id: mediaId } as MediaItem);
            reload();
          }}
        />
      ) : null}
      {workspace === "studio" ? (
        <GenerationStudio
          onUsed={(mediaId, failures) => {
            const warning = mediaVariantWarning(failures);
            toast(warning ?? t("media.acq_accepted"), warning === null ? "success" : "warning");
            setWorkspace("library");
            setSelected({ id: mediaId } as MediaItem);
            reload();
          }}
        />
      ) : null}
      <div
        className="pcms-media-layout"
        style={workspace === "library" ? undefined : { display: "none" }}
      >
        <MediaFolderPanel
          folders={folders}
          current={folder}
          canWrite={auth.can("media.write")}
          onSelect={setFolder}
          onChanged={() => {
            reloadFolders();
            reload();
          }}
        />
        <div>
          <div className="pcms-toolbar">
            <Input
              style={{ maxWidth: "20rem" }}
              aria-label={t("media.search_aria")}
              placeholder={t("media.search_placeholder")}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <Select
              style={{ width: "auto" }}
              aria-label={t("media.kind_aria")}
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="">{t("media.kind_all")}</option>
              <option value="image">{t("media.kind_image")}</option>
              <option value="video">{t("media.kind_video")}</option>
              <option value="audio">{t("media.kind_audio")}</option>
              <option value="document">{t("media.kind_document")}</option>
              <option value="generic_file">{t("media.kind_other")}</option>
            </Select>
            <Button variant="ghost" onClick={() => setView(view === "grid" ? "list" : "grid")}>
              {view === "grid" ? t("media.view_list") : t("media.view_grid")}
            </Button>
            <span className="pcms-toolbar__spacer" />
            {auth.can("media.write") ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="pcms-visually-hidden"
                  aria-label={t("media.upload_aria")}
                  onChange={(event) => void upload(event.target.files)}
                />
                <Button
                  variant="primary"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploading ? t("media.uploading") : t("media.upload_button")}
                </Button>
              </>
            ) : null}
          </div>

          {error !== null ? (
            <EmptyState
              title={error}
              action={<Button onClick={reload}>{t("media.retry")}</Button>}
            />
          ) : items === null ? (
            <Spinner />
          ) : items.length === 0 ? (
            <EmptyState title={t("media.empty_title")} hint={t("media.empty_hint")} />
          ) : view === "grid" ? (
            <div className="pcms-media-grid" data-testid="media-grid">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="pcms-media-card"
                  onClick={() => setSelected(item)}
                >
                  {item.kind === "image" ? (
                    <img
                      src={`/api/v1/media/${item.id}/file?preview=thumbnail`}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <span className="pcms-media-card__glyph" aria-hidden="true">
                      <Icon
                        name={
                          item.kind === "video" ? "film" : item.kind === "audio" ? "music" : "file"
                        }
                      />
                    </span>
                  )}
                  <span className="pcms-media-card__name">
                    {item.title ?? item.filenameOriginal}
                  </span>
                  <span className="pcms-picker-row__meta">{formatFileSize(item.sizeBytes)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="pcms-table-wrap">
              <table className="pcms-table" data-testid="media-list">
                <thead>
                  <tr>
                    <th>{t("media.th_file")}</th>
                    <th>{t("media.th_type")}</th>
                    <th>{t("media.th_size")}</th>
                    <th>{t("media.th_uploaded")}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr
                      key={item.id}
                      onClick={() => setSelected(item)}
                      style={{ cursor: "pointer" }}
                    >
                      <td>{item.title ?? item.filenameOriginal}</td>
                      <td>{item.mimeType}</td>
                      <td>{formatFileSize(item.sizeBytes)}</td>
                      <td>{item.width === null ? "—" : `${item.width}×${item.height}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {selected !== null ? (
        <MediaDetails
          item={selected}
          folders={folders}
          canWrite={auth.can("media.write")}
          canReplace={auth.can("media.replace")}
          canArchive={auth.can("media.archive")}
          onClose={() => setSelected(null)}
          onChanged={reload}
        />
      ) : null}
    </div>
  );
}

interface UsageWire {
  readonly assetId: string;
  readonly inboundCount: number;
  readonly references: readonly { sourceEntryId: string; sourcePath: string; origin: string }[];
  readonly titles?: Readonly<Record<string, string>>;
}

interface VersionWire {
  readonly versionNo: number;
  readonly filenameOriginal: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly note: string | null;
}

/** Human usage source (owner UX §2): "Entry '...'", theme settings, SEO. */
function usageSourceLabel(
  reference: { readonly sourceEntryId: string; readonly origin: string },
  titles: Readonly<Record<string, string>>,
): string {
  if (reference.origin === "theme_settings") {
    return t("media.usage_source_theme");
  }
  const title = titles[reference.sourceEntryId];
  if (reference.origin === "seo") {
    return title === undefined
      ? t("media.usage_source_seo")
      : t("media.usage_source_seo_entry", { title });
  }
  if (title !== undefined) {
    return t("media.usage_source_entry", { title });
  }
  return t("media.usage_ref", {
    id: reference.sourceEntryId.slice(0, 8),
    origin: reference.origin,
  });
}

/** Folder browser panel: All files / No folder / folder tree / create. */
function MediaFolderPanel(props: {
  readonly folders: readonly MediaFolder[];
  readonly current: FolderFilter;
  readonly canWrite: boolean;
  readonly onSelect: (filter: FolderFilter) => void;
  readonly onChanged: () => void;
}) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<MediaFolder | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<MediaFolder | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const depthOf = (folder: MediaFolder): number => {
    let depth = 0;
    let parentId = folder.parentId;
    while (parentId !== null) {
      const parent = props.folders.find((candidate) => candidate.id === parentId);
      if (parent === undefined) break;
      parentId = parent.parentId;
      depth += 1;
    }
    return depth;
  };

  const create = async () => {
    try {
      await apiPost("/media/folders", { name });
      toast(t("media.folder_created"), "success");
      setCreating(false);
      setName("");
      props.onChanged();
    } catch {
      toast(t("media.folder_create_failed"), "error");
    }
  };

  const rename = async () => {
    if (renaming === null) return;
    try {
      await apiPatch(`/media/folders/${renaming.id}`, { name: renameValue });
      toast(t("media.folder_renamed"), "success");
      setRenaming(null);
      props.onChanged();
    } catch {
      toast(t("media.folder_rename_failed"), "error");
    }
  };

  const remove = async (folder: MediaFolder) => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await apiDelete(`/media/folders/${folder.id}`);
      toast(t("media.folder_deleted"), "success");
      setDeleting(null);
      if (props.current === folder.id) props.onSelect("all");
      props.onChanged();
    } catch (caught) {
      setDeleteError(
        caught instanceof ApiError
          ? (errorText(caught.code) ?? caught.message)
          : t("media.folder_delete_failed"),
      );
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="pcms-panel pcms-media-folders" data-testid="media-folders">
      <h3>{t("media.folders_title")}</h3>
      <ul className="pcms-tree">
        <li>
          <button
            type="button"
            className="pcms-tree__row"
            aria-current={props.current === "all"}
            onClick={() => props.onSelect("all")}
          >
            <span className="pcms-tree__label">{t("media.folder_all")}</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className="pcms-tree__row"
            aria-current={props.current === "none"}
            onClick={() => props.onSelect("none")}
          >
            <span className="pcms-tree__label">{t("media.folder_none")}</span>
          </button>
        </li>
        {props.folders.map((folder) => (
          <li key={folder.id}>
            <div className="pcms-tree__line">
              <button
                type="button"
                className="pcms-tree__row"
                style={{ paddingLeft: `${depthOf(folder) * 0.75}rem` }}
                aria-current={props.current === folder.id}
                onClick={() => props.onSelect(folder.id)}
              >
                <span className="pcms-tree__label">{folder.name}</span>
              </button>
              {props.canWrite ? (
                <div className="pcms-row__actions pcms-tree__menu">
                  <IconButton
                    icon="edit"
                    small
                    label={t("media.folder_rename")}
                    onClick={() => {
                      setRenaming(folder);
                      setRenameValue(folder.name);
                    }}
                  />
                  <IconButton
                    icon="delete"
                    small
                    label={t("media.folder_delete")}
                    onClick={() => {
                      setDeleting(folder);
                      setDeleteError(null);
                    }}
                  />
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {props.canWrite ? (
        <Button size="sm" onClick={() => setCreating(true)}>
          + {t("media.folder_new")}
        </Button>
      ) : null}
      {creating ? (
        <Dialog
          open
          onClose={() => setCreating(false)}
          title={t("media.folder_new_title")}
          footer={
            <>
              <Button onClick={() => setCreating(false)}>{t("media.cancel")}</Button>
              <Button variant="primary" disabled={name.trim() === ""} onClick={() => void create()}>
                {t("media.folder_create")}
              </Button>
            </>
          }
        >
          <Field label={t("media.folder_name")} required>
            <Input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
          </Field>
        </Dialog>
      ) : null}
      {renaming !== null ? (
        <Dialog
          open
          onClose={() => setRenaming(null)}
          title={t("media.folder_rename_title")}
          footer={
            <>
              <Button onClick={() => setRenaming(null)}>{t("media.cancel")}</Button>
              <Button
                variant="primary"
                disabled={renameValue.trim() === ""}
                onClick={() => void rename()}
              >
                {t("media.folder_rename")}
              </Button>
            </>
          }
        >
          <Field label={t("media.folder_name")} required>
            <Input
              value={renameValue}
              maxLength={200}
              onChange={(event) => setRenameValue(event.target.value)}
            />
          </Field>
        </Dialog>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => (deleteBusy ? undefined : setDeleting(null))}
        onConfirm={() => {
          if (deleting !== null) void remove(deleting);
        }}
        title={t("media.folder_delete_title")}
        tone="danger"
        busy={deleteBusy}
        error={deleteError}
        body={t("media.folder_delete_body")}
        details={deleting === null ? [] : [{ label: t("media.folder_name"), value: deleting.name }]}
        confirmLabel={t("media.folder_delete")}
        cancelLabel={t("media.cancel")}
      />
    </div>
  );
}

function MediaDetails(props: {
  readonly item: MediaItem;
  readonly folders?: readonly MediaFolder[];
  readonly canWrite: boolean;
  readonly canReplace: boolean;
  readonly canArchive: boolean;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const toast = useToast();
  const [usage, setUsage] = useState<UsageWire | null>(null);
  const [versions, setVersions] = useState<readonly VersionWire[] | null>(null);
  const [duplicates, setDuplicates] = useState<readonly MediaItem[] | null>(null);
  const [title, setTitle] = useState(props.item.title ?? "");
  const [alt, setAlt] = useState(props.item.altDefault ?? "");
  const [caption, setCaption] = useState(props.item.captionDefault ?? "");
  const [source, setSource] = useState(props.item.sourceName ?? "");
  const [focal, setFocal] = useState<{ x: number | null; y: number | null }>({
    x: props.item.focalX ?? null,
    y: props.item.focalY ?? null,
  });
  // The dirty-check baseline for the focal point: the grid item that opened
  // this card can go stale after an in-card save (a reset-to-center must
  // still PATCH explicit nulls, p-cms.com 0.1.162 acceptance report).
  const [savedFocal, setSavedFocal] = useState<{ x: number | null; y: number | null }>({
    x: props.item.focalX ?? null,
    y: props.item.focalY ?? null,
  });
  const [busy, setBusy] = useState(false);
  const [folderValue] = useState(props.item.folderId ?? "");
  const replaceInputRef = useRef<HTMLInputElement | null>(null);

  const moveAsset = async (folderId: string) => {
    setBusy(true);
    try {
      await apiPatch(`/media/${props.item.id}/folder`, {
        folder_id: folderId === "" ? null : folderId,
      });
      toast(t("media.folder_moved"), "success");
      props.onChanged();
    } catch {
      toast(t("media.folder_move_failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const loadDetails = useCallback(() => {
    void apiGet<UsageWire>(`/media/${props.item.id}/usage`)
      .then(setUsage)
      .catch(() => setUsage(null));
    void apiGet<{ versions: readonly VersionWire[] }>(`/media/${props.item.id}`)
      .then((result) => setVersions(result.versions))
      .catch(() => setVersions(null));
    // Same-bytes siblings: explains why the library shows "duplicates".
    if (props.item.sha256 !== "") {
      void apiGet<{ items: readonly MediaItem[] }>(`/media/by-hash/${props.item.sha256}`)
        .then((result) =>
          setDuplicates(result.items.filter((candidate) => candidate.id !== props.item.id)),
        )
        .catch(() => setDuplicates(null));
    }
  }, [props.item.id, props.item.sha256]);

  useEffect(loadDetails, [loadDetails]);

  const save = async () => {
    setBusy(true);
    try {
      await apiPatch(`/media/${props.item.id}`, {
        ...(title !== "" ? { title } : {}),
        ...(alt !== "" ? { alt_default: alt } : {}),
        ...(caption !== "" ? { caption_default: caption } : {}),
        ...(source !== "" ? { source_name: source } : {}),
        ...(focal.x !== savedFocal.x || focal.y !== savedFocal.y
          ? { focal_x: focal.x ?? null, focal_y: focal.y ?? null }
          : {}),
      });
      setSavedFocal({ x: focal.x ?? null, y: focal.y ?? null });
      toast(t("media.meta_saved"), "success");
      props.onChanged();
    } catch {
      toast(t("media.meta_save_failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const replaceVersion = async (file: File | null) => {
    if (file === null) return;
    setBusy(true);
    try {
      const bytes = await file.arrayBuffer();
      await apiRequest("PUT", `/media/${props.item.id}/version`, {
        headers: {
          "x-pcms-filename": encodeURIComponent(file.name),
          "x-pcms-mime-type": file.type || "application/octet-stream",
          "content-type": "application/octet-stream",
        },
        rawBody: bytes,
      });
      toast(t("media.version_replaced"), "success");
      loadDetails();
      props.onChanged();
    } catch (caught) {
      toast(
        caught instanceof ApiError
          ? (errorText(caught.code) ?? caught.message)
          : t("media.replace_failed"),
        "error",
      );
    } finally {
      setBusy(false);
      if (replaceInputRef.current !== null) replaceInputRef.current.value = "";
    }
  };

  const archive = async () => {
    setBusy(true);
    try {
      await apiRequest("POST", `/media/${props.item.id}/archive`, { body: {} });
      toast(t("media.archived"), "success");
      props.onChanged();
      props.onClose();
    } catch {
      toast(t("media.archive_failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const regenerateVariants = async () => {
    setBusy(true);
    try {
      const result = await apiRequest<{
        readonly generated: number;
        readonly reused: number;
        readonly media_variant_failures?: readonly MediaVariantFailureWire[];
      }>("POST", `/media/${props.item.id}/variants/regenerate`);
      const failures = result.media_variant_failures;
      if (failures !== undefined && failures.length > 0) {
        const presets = [...new Set(failures.map((failure) => failure.preset))].sort().join(", ");
        toast(t("media.variant_regeneration_incomplete", { presets }), "warning");
      } else {
        toast(
          t("media.variant_regeneration_success", {
            generated: result.generated,
            reused: result.reused,
          }),
          "success",
        );
      }
      props.onChanged();
    } catch (caught) {
      toast(
        caught instanceof ApiError
          ? (errorText(caught.code) ?? caught.message)
          : t("media.variant_regeneration_failed"),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open onClose={props.onClose} title={props.item.filenameOriginal}>
      <div data-testid="media-details">
        {props.item.kind === "image" ? (
          <FocalPreview
            item={props.item}
            focal={focal}
            canWrite={props.canWrite}
            onPick={(point) => setFocal(point)}
          />
        ) : props.item.kind === "video" ? (
          // biome-ignore lint/a11y/useMediaCaption: admin preview of a user upload; caption tracks do not exist
          <video
            controls
            preload="metadata"
            src={`/api/v1/media/${props.item.id}/file`}
            style={{ maxWidth: "100%", borderRadius: "var(--pcms-admin-radius-md)" }}
          />
        ) : props.item.kind === "audio" ? (
          // biome-ignore lint/a11y/useMediaCaption: admin preview of a user upload; caption tracks do not exist
          <audio
            controls
            preload="metadata"
            src={`/api/v1/media/${props.item.id}/file`}
            style={{ width: "100%" }}
          />
        ) : null}
        <p className="pcms-picker-row__meta">
          {props.item.mimeType}
          {props.item.width !== null ? ` · ${props.item.width}×${props.item.height}` : ""} ·{" "}
          {formatFileSize(props.item.sizeBytes)}
        </p>
        <p className="pcms-picker-row__meta" data-testid="media-public-path">
          {`${t("media.public_path_label")}: /media/a/${props.item.id}/current/${
            props.item.filenameOriginal
          }`}
        </p>

        {duplicates !== null && duplicates.length > 0 ? (
          <div className="pcms-panel" data-testid="media-duplicates">
            <h3>{t("media.dupes_title")}</h3>
            <p className="pcms-field__hint">{t("media.dupes_hint")}</p>
            <ul>
              {duplicates.map((duplicate) => (
                <li key={duplicate.id}>
                  {duplicate.title ?? duplicate.filenameOriginal}
                  {duplicate.archivedAt !== null ? (
                    <span className="pcms-text-muted"> · {t("media.dupes_archived")}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <fieldset className="pcms-fieldset" disabled={!props.canWrite}>
          <legend>{t("media.meta_legend")}</legend>
          <Field label={t("media.folder_label")} hint={t("media.folder_move_hint")}>
            <select
              className="pcms-select"
              value={folderValue}
              data-testid="media-folder-select"
              aria-label={t("media.folder_label")}
              onChange={(event) => void moveAsset(event.target.value)}
            >
              <option value="">{t("media.folder_none_option")}</option>
              {(props.folders ?? []).map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("media.field_title")}>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label={t("media.field_alt")}>
            <Input value={alt} onChange={(event) => setAlt(event.target.value)} />
          </Field>
          <Field label={t("media.field_caption")}>
            <Input value={caption} onChange={(event) => setCaption(event.target.value)} />
          </Field>
          <Field label={t("media.field_source")}>
            <Input value={source} onChange={(event) => setSource(event.target.value)} />
          </Field>
          {props.item.kind === "image" ? (
            <Field label={t("media.field_focal")} hint={t("media.focal_hint")}>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <span data-testid="media-focal-value" className="pcms-picker-row__meta">
                  {focal.x !== null && focal.y !== null
                    ? `${focal.x} · ${focal.y}`
                    : t("media.focal_center_default")}
                </span>
                {props.canWrite && focal.x !== null ? (
                  <Button disabled={busy} onClick={() => setFocal({ x: null, y: null })}>
                    {t("media.focal_clear")}
                  </Button>
                ) : null}
              </div>
            </Field>
          ) : null}
          {props.canWrite ? (
            <Button disabled={busy} onClick={() => void save()}>
              {t("media.meta_save_button")}
            </Button>
          ) : null}
        </fieldset>

        {props.item.kind === "image" &&
        props.item.mimeType !== "image/svg+xml" &&
        props.canWrite ? (
          <div className="pcms-panel">
            <p className="pcms-field__hint">{t("media.variant_regenerate_hint")}</p>
            <Button disabled={busy} onClick={() => void regenerateVariants()}>
              {t("media.variant_regenerate_button")}
            </Button>
          </div>
        ) : null}

        {props.item.kind === "document" && props.canReplace ? (
          <div className="pcms-panel">
            <h3>{t("media.replace_title")}</h3>
            <p className="pcms-field__hint">{t("media.replace_hint")}</p>
            <input
              ref={replaceInputRef}
              type="file"
              className="pcms-visually-hidden"
              aria-label={t("media.replace_aria")}
              onChange={(event) => void replaceVersion(event.target.files?.[0] ?? null)}
            />
            <Button disabled={busy} onClick={() => replaceInputRef.current?.click()}>
              {t("media.replace_button")}
            </Button>
          </div>
        ) : null}

        <div className="pcms-panel">
          <h3>{t("media.usage_title")}</h3>
          {usage === null ? (
            <Spinner />
          ) : usage.inboundCount === 0 ? (
            <p className="pcms-text-muted" data-testid="media-usage-none">
              {t("media.usage_none")}
            </p>
          ) : (
            <p>
              {t("media.usage_count", { count: usage.inboundCount })}
              <ul>
                {usage.references.slice(0, 10).map((reference) => (
                  <li key={`${reference.sourceEntryId}-${reference.sourcePath}`}>
                    {usageSourceLabel(reference, usage.titles ?? {})}
                  </li>
                ))}
              </ul>
            </p>
          )}
        </div>

        <div className="pcms-panel">
          <h3>{t("media.versions_title")}</h3>
          {versions === null ? (
            <Spinner />
          ) : (
            <ul>
              {versions.map((version) => (
                <li key={version.versionNo}>
                  {t("media.version_prefix", { no: version.versionNo })} ·{" "}
                  {formatFileSize(version.sizeBytes)} · {formatDateTime(version.createdAt)}
                  {version.note === null ? null : ` · ${version.note}`}
                </li>
              ))}
            </ul>
          )}
        </div>

        {props.canArchive ? (
          <Button variant="danger" disabled={busy} onClick={() => void archive()}>
            {t("media.archive_button")}
          </Button>
        ) : null}
      </div>
    </Drawer>
  );
}

/** Image preview with click-to-set focal point (0.1.160 write surface).
 * Interactive (role=button, keyboard-operable) only when the actor can
 * write; pointer coordinates normalize to 0..1 and ride the metadata
 * PATCH — a Save persists them and re-crops og-v1/favicon-v1. */
function FocalPreview(props: {
  readonly item: MediaItem;
  readonly focal: { x: number | null; y: number | null };
  readonly canWrite: boolean;
  readonly onPick: (point: { x: number; y: number }) => void;
}) {
  const marker =
    props.focal.x !== null && props.focal.y !== null ? (
      <span
        data-testid="media-focal-marker"
        aria-hidden="true"
        style={{
          position: "absolute",
          left: `${props.focal.x * 100}%`,
          top: `${props.focal.y * 100}%`,
          width: "14px",
          height: "14px",
          margin: "-7px 0 0 -7px",
          borderRadius: "50%",
          border: "2px solid var(--pcms-admin-accent, #d97706)",
          boxShadow: "0 0 0 1px rgba(0,0,0,0.55)",
          pointerEvents: "none",
        }}
      />
    ) : null;
  if (!props.canWrite) {
    return (
      <div data-testid="media-focal-area" style={{ position: "relative", lineHeight: 0 }}>
        <img
          src={`/api/v1/media/${props.item.id}/file`}
          alt={props.item.altDefault ?? ""}
          style={{ maxWidth: "100%", borderRadius: "var(--pcms-admin-radius-md)" }}
        />
        {marker}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-testid="media-focal-area"
      aria-label={t("media.focal_pick_aria")}
      title={t("media.focal_hint")}
      style={{
        position: "relative",
        lineHeight: 0,
        cursor: "crosshair",
        padding: 0,
        border: "none",
        background: "none",
        display: "block",
      }}
      onClick={(event) =>
        pickFocal(event.clientX, event.clientY, event.currentTarget, props.onPick)
      }
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          const x =
            props.focal.x !== null
              ? bounds.left + bounds.width * props.focal.x
              : bounds.left + bounds.width / 2;
          const y =
            props.focal.y !== null
              ? bounds.top + bounds.height * props.focal.y
              : bounds.top + bounds.height / 2;
          pickFocal(x, y, event.currentTarget, props.onPick);
        }
      }}
    >
      <img
        src={`/api/v1/media/${props.item.id}/file`}
        alt={props.item.altDefault ?? ""}
        style={{ maxWidth: "100%", borderRadius: "var(--pcms-admin-radius-md)" }}
      />
      {marker}
    </button>
  );
}

function pickFocal(
  clientX: number,
  clientY: number,
  target: Element,
  onPick: (point: { x: number; y: number }) => void,
): void {
  const rect = target.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const round = (value: number): number => Math.round(value * 100) / 100;
  onPick({
    x: round(Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1)),
    y: round(Math.min(Math.max((clientY - rect.top) / rect.height, 0), 1)),
  });
}
