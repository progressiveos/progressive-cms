// Media and entry pickers (PCMS-ADMIN-T002; Admin spec §28; redesign spec
// §20): media-first selection — thumbnails before filenames. Pickers store
// StableIds only — never slugs, URLs or paths.
import { useEffect, useState } from "react";
import { apiGet } from "../../../api/client.js";
import {
  type ContentTreeItemWire,
  type ContentTypeSummary,
  fetchContentTree,
  fetchContentTypes,
} from "../../../api/content.js";
import { Dialog } from "../../../design/dialog.js";
import { useToast } from "../../../design/toast.js";
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Select,
  Spinner,
} from "../../../design/ui.js";
import { t } from "../../../i18n/index.js";
import { GeneratePanel, StockPanel, useMediaProviders } from "../../media/acquisition.js";
import { mediaVariantWarning } from "../../media/variant-warning.js";

export interface MediaSummaryWire {
  readonly id: string;
  readonly kind: string;
  readonly filenameOriginal: string;
  readonly mimeType: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly archivedAt: string | null;
  readonly title?: string | null;
}

interface MediaSearchResult {
  readonly items: readonly MediaSummaryWire[];
}

interface MediaInspectWire {
  readonly asset: MediaSummaryWire;
}

/** Media metadata by id (editor field cards). Single-asset fetch; failures
 * surface as missing-state in the caller. */
export async function loadMediaMeta(mediaId: string): Promise<MediaSummaryWire> {
  const inspected = await apiGet<MediaInspectWire>(`/media/${mediaId}`);
  return inspected.asset;
}

/** Entry id → title lookup for relation chips, cached briefly per session. */
let entryTitlesCache: {
  readonly at: number;
  readonly map: ReadonlyMap<string, string>;
} | null = null;

export async function loadEntryTitles(): Promise<ReadonlyMap<string, string>> {
  if (entryTitlesCache !== null && Date.now() - entryTitlesCache.at < 30_000) {
    return entryTitlesCache.map;
  }
  const tree = await fetchContentTree(false);
  const map = new Map<string, string>();
  for (const item of tree.items) {
    map.set(item.entry_id, item.title ?? item.entry_id);
  }
  entryTitlesCache = { at: Date.now(), map };
  return map;
}

type MediaKindFilter = "all" | "image" | "video" | "audio" | "document";

export function MediaPickerDialog(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onPick: (mediaId: string, label: string) => void;
  readonly title: string;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [kind, setKind] = useState<MediaKindFilter>("all");
  const [items, setItems] = useState<readonly MediaSummaryWire[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [folders, setFolders] = useState<readonly { id: string; name: string }[]>([]);
  const [folder, setFolder] = useState<"all" | "none" | string>("all");
  // ADR-0013 §70.3: capability-driven Stock/Generate modes (shared panels
  // with the Media workspace; the picked asset lands in the field directly).
  const { providers } = useMediaProviders();
  const stockAvailable = (providers ?? []).some(
    (entry) => entry.kind === "stock" && entry.configured,
  );
  const generateAvailable = (providers ?? []).some(
    (entry) => entry.kind === "generation" && entry.configured,
  );
  const [mode, setMode] = useState<"library" | "stock" | "generate">("library");
  useEffect(() => {
    if (!props.open) setMode("library");
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    apiGet<{ items: readonly { id: string; name: string }[] }>("/media/folders")
      .then((result) => setFolders(result.items))
      .catch(() => setFolders([]));
  }, [props.open]);

  useEffect(() => {
    if (!props.open) {
      setSelectedId(null);
      setText("");
      setKind("all");
      setFolder("all");
      return;
    }
    const timer = setTimeout(() => {
      setItems(null);
      setError(null);
      const kindParam = kind === "all" ? "" : `&kind=${kind}`;
      const folderParam = folder === "all" ? "" : `&folder_id=${folder}`;
      apiGet<MediaSearchResult>(
        `/media?limit=24${kindParam}${folderParam}${text === "" ? "" : `&text=${encodeURIComponent(text)}`}`,
      )
        .then((result) => setItems(result.items.filter((item) => item.archivedAt === null)))
        .catch(() => setError(t("media_library_failed")));
    }, 250);
    return () => clearTimeout(timer);
  }, [props.open, text, kind, folder]);

  const selected = items?.find((item) => item.id === selectedId) ?? null;

  const confirm = () => {
    if (selected === null) return;
    props.onPick(selected.id, selected.title ?? selected.filenameOriginal);
    props.onClose();
  };

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      wide
      footer={
        <>
          <span className="pcms-field__hint pcms-mediapicker__hint">
            {selected === null
              ? t("media_pick_none")
              : `${selected.title ?? selected.filenameOriginal}${
                  selected.width !== null && selected.height !== null
                    ? ` · ${selected.width}×${selected.height}`
                    : ""
                }`}
          </span>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={props.onClose}>
            {t("cancel")}
          </Button>
          <Button variant="primary" disabled={selected === null} onClick={confirm}>
            {t("media_pick_confirm")}
          </Button>
        </>
      }
    >
      {stockAvailable || generateAvailable ? (
        <div
          className="pcms-mediapicker__toolbar"
          role="tablist"
          aria-label={t("media.acq_tabs_label")}
        >
          {(
            [
              ["library", t("media.acq_tab_library")],
              ...(stockAvailable ? [["stock", t("media.acq_tab_stock")]] : []),
              ...(generateAvailable ? [["generate", t("media.acq_tab_generate")]] : []),
            ] as const
          ).map(([id, label]) => (
            <Button
              key={id}
              size="sm"
              variant={mode === id ? "secondary" : "ghost"}
              role="tab"
              aria-selected={mode === id}
              onClick={() => setMode(id as "library" | "stock" | "generate")}
            >
              {label}
            </Button>
          ))}
        </div>
      ) : null}
      {mode === "stock" ? (
        <StockPanel
          onImported={(mediaId, label, failures) => {
            props.onPick(mediaId, label);
            const warning = mediaVariantWarning(failures);
            if (warning !== null) toast(warning, "warning");
            props.onClose();
          }}
        />
      ) : null}
      {mode === "generate" ? (
        <GeneratePanel
          onAccepted={(mediaId, label, failures) => {
            props.onPick(mediaId, label);
            const warning = mediaVariantWarning(failures);
            if (warning !== null) toast(warning, "warning");
            props.onClose();
          }}
        />
      ) : null}
      {mode === "library" ? (
        <div className="pcms-mediapicker__toolbar">
          <Input
            placeholder={t("media_search")}
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-label={t("media_search")}
          />
          <Select
            value={kind}
            onChange={(event) => setKind(event.target.value as MediaKindFilter)}
            aria-label={t("media_kind_filter")}
          >
            <option value="all">{t("media_kind_all")}</option>
            <option value="image">{t("media_kind_images")}</option>
            <option value="video">{t("media_kind_videos")}</option>
            <option value="audio">{t("media_kind_audio")}</option>
            <option value="document">{t("media_kind_documents")}</option>
          </Select>
          <Select
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
            aria-label={t("media_folder_filter")}
            data-testid="media-picker-folders"
          >
            <option value="all">{t("media_folder_all")}</option>
            <option value="none">{t("media_folder_none")}</option>
            {folders.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      {mode === "library" ? (
        <div className="pcms-mediagrid" role="listbox" aria-label={props.title}>
          {error !== null ? (
            <p>{error}</p>
          ) : items === null ? (
            <Spinner />
          ) : items.length === 0 ? (
            <EmptyState title={t("media_empty_title")} hint={t("media_empty_hint")} />
          ) : (
            items.map((item) => {
              const isSelected = item.id === selectedId;
              const isImage = item.kind === "image";
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={
                    isSelected
                      ? "pcms-mediagrid__card pcms-mediagrid__card--selected"
                      : "pcms-mediagrid__card"
                  }
                  onClick={() => setSelectedId(item.id)}
                  onDoubleClick={confirm}
                >
                  <span className="pcms-mediagrid__thumb">
                    {isImage ? (
                      <img
                        src={`/api/v1/media/${item.id}/file?preview=thumbnail`}
                        alt=""
                        loading="lazy"
                      />
                    ) : (
                      <Icon
                        name={
                          item.kind === "video" ? "film" : item.kind === "audio" ? "music" : "file"
                        }
                      />
                    )}
                    {isSelected ? (
                      <span className="pcms-mediagrid__check">
                        <Icon name="check" />
                      </span>
                    ) : null}
                  </span>
                  <span className="pcms-mediagrid__name">{item.filenameOriginal}</span>
                  <span className="pcms-mediagrid__meta">
                    {item.width !== null && item.height !== null
                      ? `${item.width}×${item.height}`
                      : item.kind}
                  </span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

export function EntryPickerDialog(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onPick: (entryId: string, label: string) => void;
  readonly accepts?: readonly string[];
  /** Entry ids hidden from the list (move dialog: the moved subtree — the
   * server would reject picking one with ENTRY_CYCLE). */
  readonly exclude?: readonly string[];
  readonly title: string;
}) {
  const [items, setItems] = useState<readonly ContentTreeItemWire[] | null>(null);
  const [types, setTypes] = useState<Readonly<Record<string, string>> | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    Promise.all([fetchContentTree(false), fetchContentTypes()])
      .then(([tree, typeList]) => {
        setItems(tree.items);
        const titles: Record<string, string> = {};
        for (const summary of typeList.items as readonly ContentTypeSummary[]) {
          titles[summary.key] = summary.title;
        }
        setTypes(titles);
      })
      .catch(() => setError(t("entries_load_failed")));
  }, [props.open]);

  const excluded = new Set(props.exclude ?? []);
  const visible = (items ?? []).filter((item) => {
    if (excluded.has(item.entry_id)) return false;
    if (props.accepts !== undefined && !props.accepts.includes(item.content_type)) return false;
    if (filter !== "" && !(item.title ?? "").toLowerCase().includes(filter.toLowerCase()))
      return false;
    return true;
  });

  return (
    <Dialog open={props.open} onClose={props.onClose} title={props.title} wide>
      <Input
        placeholder={t("entries_search")}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        aria-label={t("entries_search")}
      />
      <div className="pcms-picker-list" role="listbox" aria-label={props.title}>
        {error !== null ? (
          <p>{error}</p>
        ) : items === null || types === null ? (
          <Spinner />
        ) : visible.length === 0 ? (
          <p>{t("not_found")}</p>
        ) : (
          visible.map((item) => (
            <button
              key={item.entry_id}
              type="button"
              role="option"
              aria-selected={false}
              className="pcms-picker-row"
              onClick={() => {
                props.onPick(item.entry_id, item.title ?? item.entry_id);
                props.onClose();
              }}
            >
              <span className="pcms-picker-row__title">{item.title ?? t("tree_untitled")}</span>
              <span className="pcms-picker-row__meta">
                {types[item.content_type] ?? item.content_type}
              </span>
            </button>
          ))
        )}
      </div>
    </Dialog>
  );
}

/** Chosen-reference chip with a clear button; shared by single/list controls. */
export function ReferenceChip(props: {
  readonly label: string;
  readonly meta?: string | undefined;
  readonly title?: string | undefined;
  readonly onClear?: (() => void) | undefined;
  readonly onOpen?: (() => void) | undefined;
  readonly disabled?: boolean | undefined;
}) {
  return (
    <span className="pcms-chip">
      <button
        type="button"
        className="pcms-chip__label"
        onClick={props.onOpen}
        disabled={props.disabled}
        title={props.title}
      >
        {props.label}
      </button>
      {props.meta === undefined ? null : (
        <span className="pcms-picker-row__meta">{props.meta}</span>
      )}
      {props.onClear === undefined ? null : (
        <IconButton
          small
          icon="close"
          label={t("media_unlink")}
          disabled={props.disabled}
          onClick={props.onClear}
        />
      )}
    </span>
  );
}
