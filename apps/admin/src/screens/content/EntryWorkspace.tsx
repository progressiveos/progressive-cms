// Entry workspace (PCMS-ADMIN-T003): selected-entry editor with the baseline
// tabs (Admin spec §6). SEO/Route/Revisions/Publication land in T008–T011.
//
// CORE-ADMIN-EDITOR-UX-01 keeps three invariants here:
//  1. Reading is never writing. Opening a published entry (or its published
//     revision) issues GETs only — no draft fork, no seal, no generation bump.
//     The UI therefore has TWO separate actions: "view published" (LIVE) and
//     "preview changes" (WORKING), plus independent LIVE/WORKING status.
//  2. One save pipeline. Autosave, the manual button and the publish button
//     all enqueue onto the same promise chain, so two PATCHes can never race
//     and the publish flow always seals the finally saved generation.
//  3. Optimistic locking stays on. A REVISION_STALE / PUBLICATION_CONFLICT is
//     a real conflict with another actor: it is surfaced (never retried with a
//     guessed generation) and the user chooses how to reconcile.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiGet, apiPost, describeApiError } from "../../api/client.js";
import {
  type ContentTypeSchemaWire,
  createWorkingDraft,
  fetchContentTypeSchema,
  getRevision,
  listRevisions,
  type RevisionWire,
  setEntryTemplate,
  updateDraft,
} from "../../api/content.js";
import { useAuth } from "../../auth/AuthContext.js";
import { Dialog } from "../../design/dialog.js";
import { useToast } from "../../design/toast.js";
import {
  Button,
  EmptyState,
  ErrorPanel,
  Icon,
  Spinner,
  StatusBadge,
  TabPanel,
  Tabs,
} from "../../design/ui.js";
import { errorText, t } from "../../i18n/index.js";
import { BlockDocumentEditor } from "./blocks/BlockDocumentEditor.js";
import { SchemaForm } from "./SchemaForm.js";
import { TranslationsStrip } from "./TranslationsStrip.js";
import { PublicationTab } from "./tabs/PublicationTab.js";
import { RevisionsTab } from "./tabs/RevisionsTab.js";
import { RouteTab } from "./tabs/RouteTab.js";
import { SeoTab } from "./tabs/SeoTab.js";

type SaveState = "idle" | "saving" | "saved" | "error";

/** What the workspace currently shows. `live` is a pure read of the published
 * (or latest sealed) revision; `edit` is the WORKING draft. */
type ViewMode = "edit" | "live" | "empty";

interface PublicationWire {
  readonly state: "PUBLISHED" | "UNPUBLISHED";
  readonly current_revision_id: string | null;
  readonly generation: number;
  readonly published_at: string | null;
}

/** Ancestor chain (root first) for the explicit location line. */
export interface LocationCrumb {
  readonly entry_id: string;
  readonly title: string | null;
}

/** Explicit Content Tree location line ("Location: Root / …") shared by
 * the content editor and the folder workspace. */
export function LocationStrip(props: {
  readonly location?: readonly LocationCrumb[];
  readonly onOpenLocation?: (entryId: string) => void;
}) {
  return (
    <span className="pcms-editor__location-path">
      <span
        className={`pcms-editor__location-root${(props.location?.length ?? 0) === 0 ? " pcms-editor__location-root--current" : ""}`}
      >
        {t("editor_location_root")}
      </span>
      {(props.location ?? []).map((crumb) => (
        <span key={crumb.entry_id} className="pcms-editor__location-seg">
          <span aria-hidden="true" className="pcms-editor__location-sep">
            /
          </span>
          <button
            type="button"
            className="pcms-editor__location-crumb"
            onClick={() => props.onOpenLocation?.(crumb.entry_id)}
            title={crumb.title ?? t("tree_untitled")}
          >
            {crumb.title ?? t("tree_untitled")}
          </button>
        </span>
      ))}
    </span>
  );
}

/** Tab titles resolve per render so a locale switch re-localizes them. */
function baseTabs() {
  return [
    { id: "content", title: t("tab_content") },
    { id: "seo", title: t("publication.tab_seo") },
    { id: "relations", title: t("tab_relations") },
    { id: "route", title: t("tab_route") },
    { id: "revisions", title: t("tab_revisions") },
    { id: "publication", title: t("tab_publication") },
  ];
}

/**
 * Independent LIVE / WORKING state (CORE-ADMIN-EDITOR-UX-01 §1.4–1.6).
 * The two lines are never merged into one badge: the published version and the
 * unpublished changes have separate lifecycles, and a reader must be able to
 * tell "published, nothing pending" from "published, changes pending" — the
 * old single wording ("published without a draft") conflated both.
 */
function EntryStatus(props: {
  readonly publication: PublicationWire | null;
  /** A WORKING draft exists on the server (independent of the current view). */
  readonly hasWorking: boolean;
  /** The editor's unsaved state: what the status is about right now. */
  readonly dirty: boolean;
}) {
  const live =
    props.publication?.state === "PUBLISHED" && props.publication.current_revision_id !== null;
  // "Unpublished changes" = a draft exists OR the editor holds unsaved edits;
  // local edits are changes waiting for publication just the same.
  const changes = props.hasWorking || props.dirty;
  const summary = !live
    ? changes
      ? t("publication.summary_unpublished_changes")
      : t("publication.summary_unpublished_clean")
    : changes
      ? t("publication.summary_published_changes")
      : t("publication.summary_published_clean");
  return (
    <div className="pcms-editor__status" data-testid="editor-status">
      <span className="pcms-editor__status-row">
        <StatusBadge tone={live ? "success" : "neutral"} icon={live ? "success" : "dot"}>
          {live ? t("publication.status_live_published") : t("publication.status_live_never")}
        </StatusBadge>
        <StatusBadge tone={changes ? "info" : "neutral"} icon={changes ? "edit" : "check"}>
          {changes
            ? t("publication.status_working_changes")
            : t("publication.status_working_clean")}
        </StatusBadge>
      </span>
      <span className="pcms-editor__status-summary" data-testid="editor-status-summary">
        {summary}
      </span>
    </div>
  );
}

export function EntryWorkspace(props: {
  readonly entryId: string;
  readonly contentTypeKey: string;
  readonly onChanged: () => void;
  /** Content Tree ancestors of this entry, root first (path display). */
  readonly location?: readonly LocationCrumb[];
  readonly onOpenLocation?: (entryId: string) => void;
  readonly onMove?: () => void;
  /** Current theme template assignment (null = compatible default). */
  readonly templateKey?: string | null;
  readonly onChangedTemplate?: () => void;
}) {
  const toast = useToast();
  const auth = useAuth();
  const canPublish = auth.can("revision.seal") && auth.can("publication.publish");
  const canEdit = auth.can("content.edit");

  const [schema, setSchema] = useState<ContentTypeSchemaWire | null>(null);
  const [revision, setRevision] = useState<RevisionWire | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [blocks, setBlocks] = useState<unknown>(null);
  const [generation, setGeneration] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [openingDraft, setOpeningDraft] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode | "loading">("loading");
  const [publication, setPublication] = useState<PublicationWire | null>(null);
  const [hasWorking, setHasWorking] = useState(false);
  const [legacyBaseConfirmation, setLegacyBaseConfirmation] = useState<{
    revisionId: string;
    currentRevisionId: string | null;
    generation: number;
    reason: "unknown" | "changed";
  } | null>(null);
  const [conflict, setConflict] = useState<number | null>(null);
  const [tab, setTab] = useState("content");
  const [dirty, setDirty] = useState(false);
  const [templates, setTemplates] = useState<readonly { id: string }[] | null>(null);
  const [templateValue, setTemplateValue] = useState<string>(props.templateKey ?? "");

  // --- Save pipeline refs -------------------------------------------------
  // Refs mirror render state for the async chain: a debounce timer that fires
  // after a re-render must still see the LATEST values and the generation the
  // SERVER confirmed, never a stale closure.
  const schemaRef = useRef<ContentTypeSchemaWire | null>(null);
  const revisionRef = useRef<RevisionWire | null>(null);
  const valuesRef = useRef<Record<string, unknown>>({});
  const blocksRef = useRef<unknown>(null);
  const generationRef = useRef(0);
  const dirtyRef = useRef(false);
  const publishingRef = useRef(false);
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());

  schemaRef.current = schema;
  revisionRef.current = revision;
  generationRef.current = generation;

  // Stable helpers: every async continuation (autosave, publish, reload)
  // writes through these, so a closure from an older render still lands in the
  // refs the save pipeline reads.
  const applyValues = useCallback((next: Record<string, unknown>) => {
    valuesRef.current = next;
    setValues(next);
  }, []);
  const applyBlocks = useCallback((next: unknown) => {
    blocksRef.current = next;
    setBlocks(next);
  }, []);
  const markDirty = useCallback((next: boolean) => {
    dirtyRef.current = next;
    setDirty(next);
  }, []);

  const readPublication = useCallback(async (): Promise<PublicationWire | null> => {
    try {
      return await apiGet<PublicationWire>(
        `/publications/entry/${encodeURIComponent(props.entryId)}`,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }, [props.entryId]);

  const loadRevisionIntoEditor = useCallback(
    (loaded: RevisionWire) => {
      revisionRef.current = loaded;
      setRevision(loaded);
      applyValues((loaded.payload.fields ?? {}) as Record<string, unknown>);
      applyBlocks(loaded.payload.blocks ?? null);
      generationRef.current = loaded.edit_generation;
      setGeneration(loaded.edit_generation);
      markDirty(false);
      setSaveState("idle");
    },
    [applyValues, applyBlocks, markDirty],
  );

  /**
   * Server truth → UI. Reads revisions + publication (GETs only) and shows the
   * WORKING draft when one exists, otherwise the published revision read-only.
   * Never creates a draft: `create_working_draft` is a separate, explicit act.
   */
  const loadWorkspace = useCallback(async () => {
    const [revisions, live] = await Promise.all([listRevisions(props.entryId), readPublication()]);
    if (revisions.items.length === 0) {
      setLoadError(t("entry_no_revisions"));
      setView("empty");
      return;
    }
    setPublication(live);
    const working = revisions.items.find((item) => item.state === "WORKING") ?? null;
    setHasWorking(working !== null);
    if (working !== null) {
      const loaded = await getRevision(working.id);
      // Unsaved edits stay in the editor; only the server-side facts
      // (state, generation) are refreshed. Otherwise a refused reload — or
      // an autosave triggered by the server state itself — would wipe the
      // operator's text.
      if (dirtyRef.current) {
        revisionRef.current = loaded;
        setRevision(loaded);
        generationRef.current = loaded.edit_generation;
        setGeneration(loaded.edit_generation);
        setView("edit");
        return;
      }
      loadRevisionIntoEditor(loaded);
      setView("edit");
      return;
    }
    // No WORKING revision. When the revision on screen still exists on the
    // server it stays in the editor with its NEW state — this is the
    // seal → publish sequence on the Publication tab: sealing must not throw
    // the operator out to the read-only view and hide "Опубликовать".
    const current = revisionRef.current;
    if (current !== null && revisions.items.some((item) => item.id === current.id)) {
      const refreshed = await getRevision(current.id);
      revisionRef.current = refreshed;
      setRevision(refreshed);
      generationRef.current = refreshed.edit_generation;
      setGeneration(refreshed.edit_generation);
      setView("edit");
      return;
    }
    // Published (or merely sealed) material opens as a read-only view of the
    // live revision — GETs only, so looking at it never produces a revision.
    const sealed = revisions.items.find((item) => item.state === "SEALED");
    const target =
      live?.state === "PUBLISHED" && live.current_revision_id !== null
        ? live.current_revision_id
        : (sealed?.id ?? null);
    if (target === null) {
      setRevision(null);
      setView("empty");
      return;
    }
    const published = await getRevision(target);
    if (published.entity_id !== props.entryId) throw new Error("publication revision mismatch");
    revisionRef.current = published;
    setRevision(published);
    applyValues((published.payload.fields ?? {}) as Record<string, unknown>);
    applyBlocks(published.payload.blocks ?? null);
    generationRef.current = published.edit_generation;
    setGeneration(published.edit_generation);
    markDirty(false);
    setView("live");
  }, [props.entryId, readPublication, loadRevisionIntoEditor, applyValues, applyBlocks, markDirty]);

  useEffect(() => {
    let cancelled = false;
    setSchema(null);
    setRevision(null);
    setLoadError(null);
    setHasWorking(false);
    setPublication(null);
    setLegacyBaseConfirmation(null);
    setTab("content");
    markDirty(false);
    setSaveState("idle");
    setView("loading");
    const run = async () => {
      try {
        const loaded = await fetchContentTypeSchema(props.contentTypeKey);
        if (cancelled) return;
        schemaRef.current = loaded;
        setSchema(loaded);
        await loadWorkspace();
      } catch (caught) {
        if (cancelled) return;
        setLoadError(
          caught instanceof ApiError
            ? (errorText(caught.code) ?? caught.message)
            : t("entry_open_failed"),
        );
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [props.contentTypeKey, loadWorkspace, markDirty]);

  /** Explicit "Create draft" — the ONLY place that creates a WORKING revision. */
  const createDraftFromPublished = useCallback(async () => {
    setOpeningDraft(true);
    setLoadError(null);
    try {
      if (!hasWorking) {
        // Guard: the published revision we offer to branch from must still be
        // the live one, or the editor would fork stale content.
        const live = await readPublication();
        const current = revisionRef.current;
        if (
          live !== null &&
          live.state === "PUBLISHED" &&
          current !== null &&
          current.state === "SEALED" &&
          live.current_revision_id !== current.id
        ) {
          toast(t("published_content_changed"), "warning");
          props.onChanged();
          return;
        }
      }
      const draft = await createWorkingDraft(
        props.entryId,
        hasWorking ? undefined : (revisionRef.current?.id ?? undefined),
      );
      const loaded = await getRevision(draft.revision_id);
      loadRevisionIntoEditor(loaded);
      setHasWorking(true);
      setView("edit");
      toast(t("draft_created"), "success");
      props.onChanged();
    } catch (caught) {
      setLoadError(
        caught instanceof ApiError
          ? (errorText(caught.code) ?? caught.message)
          : t("draft_open_failed"),
      );
    } finally {
      setOpeningDraft(false);
    }
  }, [hasWorking, props, readPublication, loadRevisionIntoEditor, toast]);

  /** Refuses to switch views while edits are unsaved: reading must never
   * discard them, and a sealed revision must not be turned into a draft
   * without the operator asking. */
  const requireSavedBeforeLeaving = useCallback(async (): Promise<boolean> => {
    const current = revisionRef.current;
    if (current !== null && current.state !== "WORKING" && dirtyRef.current) {
      toast(t("published_content_sealed_dirty"), "warning");
      return false;
    }
    if (dirtyRef.current) {
      toast(t("save_dirty"), "warning");
      return false;
    }
    return true;
  }, [toast]);

  /** Read-only view of the published revision (a pure GET). */
  const showPublished = useCallback(async () => {
    try {
      if (!(await requireSavedBeforeLeaving())) return;
      const live = await readPublication();
      setPublication(live);
      if (live === null || live.state !== "PUBLISHED" || live.current_revision_id === null) {
        toast(t("published_content_missing"), "warning");
        return;
      }
      const published = await getRevision(live.current_revision_id);
      if (published.entity_id !== props.entryId) throw new Error("publication revision mismatch");
      revisionRef.current = published;
      setRevision(published);
      applyValues((published.payload.fields ?? {}) as Record<string, unknown>);
      applyBlocks(published.payload.blocks ?? null);
      generationRef.current = published.edit_generation;
      setGeneration(published.edit_generation);
      markDirty(false);
      setView("live");
    } catch (error) {
      toast(
        error instanceof ApiError
          ? (errorText(error.code) ?? error.message)
          : t("entry_open_failed"),
        "error",
      );
    }
  }, [
    props.entryId,
    readPublication,
    requireSavedBeforeLeaving,
    applyValues,
    applyBlocks,
    markDirty,
    toast,
  ]);

  /** Back from the LIVE read-only view to the WORKING draft (no server write). */
  const backToDraft = useCallback(async () => {
    setOpeningDraft(true);
    try {
      const revisions = await listRevisions(props.entryId);
      const working = revisions.items.find((item) => item.state === "WORKING") ?? null;
      if (working === null) {
        await createDraftFromPublished();
        return;
      }
      const loaded = await getRevision(working.id);
      loadRevisionIntoEditor(loaded);
      setHasWorking(true);
      setView("edit");
    } catch (caught) {
      toast(
        caught instanceof ApiError
          ? (errorText(caught.code) ?? caught.message)
          : t("draft_open_failed"),
        "error",
      );
    } finally {
      setOpeningDraft(false);
    }
  }, [props.entryId, createDraftFromPublished, loadRevisionIntoEditor, toast]);

  /** Draft preview of the CURRENT unpublished changes (signed token, read-only). */
  const previewChanges = useCallback(async () => {
    const current = revisionRef.current;
    if (current === null) return;
    try {
      const result = await apiPost<{ token: string }>("/previews", {
        scope: {
          kind: "revision",
          entity_type: "entry",
          entity_id: props.entryId,
          revision_id: current.id,
          allow_draft: true,
        },
      });
      window.open(`/preview/page?token=${encodeURIComponent(result.token)}`, "_blank", "noopener");
    } catch {
      toast(t("preview_failed"), "error");
    }
  }, [props.entryId, toast]);

  /**
   * One PATCH attempt against the server-confirmed generation. Called only
   * through `enqueueSave`, i.e. never concurrently with another attempt.
   */
  const runSaveAttempt = useCallback(async (): Promise<number | null> => {
    const current = revisionRef.current;
    const currentSchema = schemaRef.current;
    if (current === null || currentSchema === null) return null;
    if (current.state !== "WORKING") return generationRef.current;
    if (!dirtyRef.current) return generationRef.current;
    const snapshotValues = valuesRef.current;
    const snapshotBlocks = blocksRef.current;
    setSaveState("saving");
    try {
      const result = await updateDraft(
        current.id,
        {
          fields: snapshotValues,
          ...(currentSchema.bodyPolicy === "block_document"
            ? { blocks: snapshotBlocks ?? { schema_version: 1, blocks: [] } }
            : {}),
        },
        generationRef.current,
      );
      generationRef.current = result.edit_generation;
      setGeneration(result.edit_generation);
      // Edits that arrived while the request was in flight stay dirty: the
      // response only covers the snapshot it sent.
      if (valuesRef.current === snapshotValues && blocksRef.current === snapshotBlocks) {
        markDirty(false);
        setSaveState("saved");
      } else {
        setSaveState("saving");
      }
      props.onChanged();
      return result.edit_generation;
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "REVISION_STALE") {
        const detail = caught.details[0] as { current?: number } | undefined;
        setConflict(typeof detail?.current === "number" ? detail.current : generationRef.current);
        setSaveState("idle");
        return null;
      }
      setSaveState("error");
      toast(errorText(caught instanceof ApiError ? caught.code : "") ?? t("save_failed"), "error");
      return null;
    }
  }, [props, toast, markDirty]);

  /** Serialises every write: autosave, manual save and publish share a queue. */
  const enqueueSave = useCallback((): Promise<number | null> => {
    const next = saveChain.current.then(() => runSaveAttempt());
    saveChain.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }, [runSaveAttempt]);

  /**
   * Awaits the queue and repeats until no local change is left unsaved —
   * the contract the publish button needs ("save everything, then seal").
   */
  const flushSaves = useCallback(async (): Promise<number | null> => {
    let confirmed: number | null = generationRef.current;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const result = await enqueueSave();
      if (result === null) return null;
      confirmed = result;
      if (!dirtyRef.current) return confirmed;
    }
    // Still dirty after a bounded number of attempts: something keeps
    // changing under us — refuse to publish rather than ship a partial state.
    setSaveState("error");
    toast(t("save_failed"), "error");
    return null;
  }, [enqueueSave, toast]);

  const save = useCallback(async () => {
    await flushSaves();
  }, [flushSaves]);

  // Autosave (PCMS-ADMIN-T008; Admin spec §20): debounced, explicit state.
  // It goes through the SAME queue as the publish flow, so a publish can never
  // interleave a PATCH between its save and its seal.
  useEffect(() => {
    if (!dirty || conflict !== null || openingDraft || view !== "edit") return;
    const timer = setTimeout(() => {
      if (publishingRef.current) return;
      void flushSaves();
    }, 1500);
    return () => clearTimeout(timer);
  }, [dirty, conflict, openingDraft, view, flushSaves]);

  // Compatible templates of the active theme (Theme Contract §16): >1 → the
  // editor shows an explicit selector; a single one renders as read-only.
  // editor_selectable=false hides system templates from the picker.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ items: readonly { id: string; editor_selectable?: boolean }[] }>(
      `/discovery/content/templates?content_type=${encodeURIComponent(props.contentTypeKey)}`,
    )
      .then((result) => {
        if (!cancelled) {
          setTemplates(result.items.filter((t) => t.editor_selectable !== false));
        }
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [props.contentTypeKey]);
  useEffect(() => setTemplateValue(props.templateKey ?? ""), [props.templateKey]);

  const changeTemplate = async (key: string) => {
    setTemplateValue(key);
    try {
      await setEntryTemplate(props.entryId, key === "" ? null : key);
      toast(t("template_changed"), "success");
      props.onChangedTemplate?.();
    } catch {
      toast(t("template_change_failed"), "error");
    }
  };

  // Unsaved-changes guard (Admin spec §54).
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /**
   * Publish from the editor (CORE-ADMIN-EDITOR-UX-01 §2): wait for every local
   * save, seal the finally saved revision with its server-confirmed
   * generation, then publish with a freshly read publication generation.
   */
  const publishNow = useCallback(
    async (approvedLegacy?: {
      revisionId: string;
      currentRevisionId: string | null;
      generation: number;
      reason: "unknown" | "changed";
    }) => {
      const current = revisionRef.current;
      if (current === null || publishingRef.current) return;
      publishingRef.current = true;
      setPublishing(true);
      let sealed = false;
      try {
        const live = await readPublication();
        setPublication(live);
        if (
          live?.state === "PUBLISHED" &&
          (current.parent_revision_id == null ||
            live.current_revision_id !== current.parent_revision_id)
        ) {
          if (approvedLegacy === undefined) {
            setLegacyBaseConfirmation({
              revisionId: current.id,
              currentRevisionId: live.current_revision_id,
              generation: live.generation,
              reason: current.parent_revision_id == null ? "unknown" : "changed",
            });
            return;
          }
          if (
            approvedLegacy.revisionId !== current.id ||
            approvedLegacy.currentRevisionId !== live.current_revision_id ||
            approvedLegacy.generation !== live.generation
          ) {
            toast(t("published_content_changed"), "warning");
            return;
          }
        }
        // 1. Every queued/local change lands first; `confirmed` is the
        //    generation the server acknowledged for the LAST write.
        const confirmed = await flushSaves();
        if (confirmed === null) return;
        // 2. Seal exactly that revision at exactly that generation.
        await apiPost(`/revisions/${current.id}/seal`, {
          expected_edit_generation: confirmed,
        });
        sealed = true;
        // 3. Fresh publication generation: another actor may have published
        //    between our first read and now — CAS must see the real value.
        const fresh = await readPublication();
        await apiPost("/publications/publish", {
          entity_type: "entry",
          entity_id: props.entryId,
          target_revision_id: current.id,
          expected_generation: fresh?.generation ?? 0,
        });
        toast(t("editor_published"), "success");
        markDirty(false);
        setSaveState("saved");
        props.onChanged();
        // 4. Sync the editor with the server. The just-published revision stays
        //    on screen as the current (sealed) version — a fresh draft is a
        //    separate, explicit act, never a side effect of publishing.
        await loadWorkspace();
      } catch (caught) {
        if (
          caught instanceof ApiError &&
          (caught.code === "REVISION_STALE" || caught.code === "PUBLICATION_CONFLICT")
        ) {
          // A genuine concurrent change. No blind retry, no overwrite: reload
          // the real state and let the human reconcile.
          setConflict(generationRef.current);
          if (sealed) await loadWorkspace().catch(() => undefined);
        } else {
          toast(describeApiError(caught), "error");
          if (sealed) await loadWorkspace().catch(() => undefined);
        }
      } finally {
        publishingRef.current = false;
        setPublishing(false);
      }
    },
    [props, flushSaves, readPublication, loadWorkspace, markDirty, toast],
  );

  if (loadError !== null) {
    return <ErrorPanel message={loadError} onRetry={props.onChanged} />;
  }
  if (view === "loading" || openingDraft) {
    return (
      <div data-testid={openingDraft ? "entry-draft-loading" : "entry-loading"}>
        <Spinner />
      </div>
    );
  }
  if (view === "empty" || schema === null) {
    if (view === "empty" && schema !== null) {
      return (
        <div className="pcms-panel pcms-editor">
          <EntryStatus publication={publication} hasWorking={false} dirty={false} />
          <EmptyState
            title={t("needs_draft_title")}
            hint={t("needs_draft_hint")}
            action={
              canEdit ? (
                <Button variant="primary" onClick={() => void createDraftFromPublished()}>
                  {t("needs_draft_action")}
                </Button>
              ) : undefined
            }
          />
        </div>
      );
    }
    return <Spinner />;
  }

  const title =
    typeof values.title === "string" && values.title !== "" ? values.title : t("tree_untitled");
  const isLiveView = view === "live";
  const isPublished =
    publication?.state === "PUBLISHED" && publication.current_revision_id !== null;
  const publishingNow = publishing || saveState === "saving";

  // LIVE read-only view: the published revision, the independent status, and
  // the two separate next actions (edit the draft / stay on the publication).
  if (isLiveView) {
    return (
      <div className="pcms-panel pcms-editor" data-testid="published-content">
        <div className="pcms-editor__header">
          <div className="pcms-editor__heading">
            <h2 className="pcms-editor__title">{title}</h2>
            <EntryStatus publication={publication} hasWorking={hasWorking} dirty={dirty} />
          </div>
          <div className="pcms-editor__actions">
            {canEdit && (
              <Button variant="primary" data-testid="open-draft" onClick={() => void backToDraft()}>
                {hasWorking ? t("published_content_return_draft") : t("needs_draft_action")}
              </Button>
            )}
          </div>
        </div>
        <p className="pcms-text-muted" data-testid="published-content-hint">
          {isPublished ? t("published_content_readonly") : t("published_content_sealed_readonly")}
        </p>
        <div className="pcms-editor__location">
          <span className="pcms-editor__location-label">{t("editor_location_label")}</span>
          <LocationStrip
            {...(props.location === undefined ? {} : { location: props.location })}
            {...(props.onOpenLocation === undefined
              ? {}
              : { onOpenLocation: props.onOpenLocation })}
          />
        </div>
        <SchemaForm
          fields={schema.fieldSchema.fields}
          values={values}
          onChange={() => {}}
          disabled
          skipBlockDocument={schema.bodyPolicy === "block_document"}
        />
        {schema.bodyPolicy === "block_document" && (
          <BlockDocumentEditor
            value={(blocks ?? { schema_version: 1, blocks: [] }) as never}
            onChange={() => {}}
            disabled
          />
        )}
      </div>
    );
  }

  return (
    <div className="pcms-panel pcms-editor" data-testid="entry-workspace">
      <div className="pcms-editor__header">
        <div className="pcms-editor__heading">
          <h2 className="pcms-editor__title" data-testid="editor-title">
            {title}
          </h2>
          <span className="pcms-editor__meta">
            {schema.title} ·{" "}
            {revision?.state === "WORKING" ? t("revision_draft") : t("revision_ready")}
          </span>
          <EntryStatus publication={publication} hasWorking={hasWorking} dirty={dirty} />
        </div>
        <div className="pcms-editor__actions">
          {isPublished && !dirty && auth.can("publication.read") && (
            <Button data-testid="view-published" onClick={() => void showPublished()}>
              {t("published_content_show")}
            </Button>
          )}
          {canEdit && auth.can("preview.create") && revision?.state === "WORKING" && (
            <Button data-testid="preview-changes" onClick={() => void previewChanges()}>
              {t("published_content_preview_changes")}
            </Button>
          )}
          <span data-testid="save-state" aria-live="polite" className="pcms-editor__save-state">
            {saveState === "saving"
              ? t("saving")
              : saveState === "error"
                ? t("save_failed")
                : dirty
                  ? t("save_dirty")
                  : saveState === "saved"
                    ? t("saved")
                    : ""}
          </span>
          <Button
            data-testid="save-draft"
            variant="primary"
            disabled={publishingNow}
            onClick={() => void save()}
          >
            {t("editor_save_draft")}
          </Button>
          <Button
            data-testid="editor-publish"
            disabled={publishingNow || !canPublish}
            title={canPublish ? undefined : t("editor_publish_no_permission")}
            onClick={() => void publishNow()}
          >
            {publishingNow && publishing ? t("editor_publishing") : t("editor_publish")}
          </Button>
        </div>
      </div>
      <div className="pcms-editor__tabs">
        <Tabs items={baseTabs()} active={tab} onSelect={setTab} label={t("editor_tabs_label")} />
      </div>
      <div className="pcms-editor__location" data-testid="editor-location">
        <span className="pcms-editor__location-label">{t("editor_location_label")}</span>
        <LocationStrip
          {...(props.location === undefined ? {} : { location: props.location })}
          {...(props.onOpenLocation === undefined ? {} : { onOpenLocation: props.onOpenLocation })}
        />
        {(() => {
          // Selectable templates; the entry's current template stays listed
          // even when the theme marks it non-editor-selectable (system
          // templates such as home) — otherwise the control would go blank.
          const selectable = templates ?? [];
          const options =
            templateValue !== "" && !selectable.some((template) => template.id === templateValue)
              ? [{ id: templateValue }, ...selectable]
              : selectable;
          if (options.length > 1) {
            return (
              <label className="pcms-editor__template">
                {t("template_label")}
                <select
                  className="pcms-select"
                  style={{ width: "auto" }}
                  value={templateValue}
                  data-testid="template-select"
                  aria-label={t("template_label")}
                  onChange={(event) => void changeTemplate(event.target.value)}
                >
                  <option value="">{t("template_default_option")}</option>
                  {options.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.id}
                    </option>
                  ))}
                </select>
              </label>
            );
          }
          if (options.length === 1) {
            return (
              <span className="pcms-editor__template" data-testid="template-current">
                {t("template_label")}: {options[0]?.id}
              </span>
            );
          }
          return null;
        })()}
        {props.onMove !== undefined ? (
          <Button size="sm" onClick={props.onMove}>
            <Icon name="move" /> {t("move")}
          </Button>
        ) : null}
      </div>
      <TranslationsStrip entryId={props.entryId} />
      <TabPanel id="content" active={tab === "content"}>
        <SchemaForm
          skipBlockDocument={schema.bodyPolicy === "block_document"}
          fields={schema.fieldSchema.fields}
          values={values}
          onChange={(next) => {
            applyValues(next);
            markDirty(true);
          }}
        />
        {schema.bodyPolicy === "block_document" ? (
          <div className="pcms-panel" style={{ marginTop: "var(--pcms-admin-space-4)" }}>
            <h3>{t("blocks_section")}</h3>
            <BlockDocumentEditor
              value={(blocks ?? { schema_version: 1, blocks: [] }) as never}
              onChange={(document) => {
                applyBlocks(document);
                markDirty(true);
              }}
              {...(saveState === "saving" ? { disabled: true } : {})}
            />
          </div>
        ) : null}
      </TabPanel>
      <TabPanel id="seo" active={tab === "seo"}>
        <SeoTab entryId={props.entryId} />
      </TabPanel>
      <TabPanel id="relations" active={tab === "relations"}>
        <EmptyState
          title={t("publication.relations_title")}
          hint={t("publication.relations_hint")}
        />
      </TabPanel>
      <TabPanel id="route" active={tab === "route"}>
        <RouteTab entryId={props.entryId} />
      </TabPanel>
      <TabPanel id="revisions" active={tab === "revisions"}>
        <RevisionsTab
          entryId={props.entryId}
          onDraftChanged={() => {
            void loadWorkspace();
            props.onChanged();
          }}
        />
      </TabPanel>
      <TabPanel id="publication" active={tab === "publication"}>
        <PublicationTab
          entryId={props.entryId}
          revisionId={revision?.id ?? null}
          revisionState={
            revision === null ? null : revision.state === "WORKING" ? "WORKING" : "SEALED"
          }
          generation={generation}
          onPublicationChanged={() => {
            void loadWorkspace();
            props.onChanged();
          }}
        />
      </TabPanel>
      <Dialog
        open={legacyBaseConfirmation !== null}
        onClose={() => setLegacyBaseConfirmation(null)}
        title={t("legacy_base_title")}
        footer={
          <>
            <Button onClick={() => setLegacyBaseConfirmation(null)}>{t("conflict_stay")}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const approved = legacyBaseConfirmation;
                setLegacyBaseConfirmation(null);
                if (approved) void publishNow(approved);
              }}
            >
              {t("legacy_base_confirm")}
            </Button>
          </>
        }
      >
        <p>
          {t(
            legacyBaseConfirmation?.reason === "changed"
              ? "changed_base_warning"
              : "legacy_base_warning",
          )}
        </p>
      </Dialog>
      <Dialog
        open={conflict !== null}
        onClose={() => setConflict(null)}
        title={t("conflict_title")}
        footer={
          <>
            <Button onClick={() => setConflict(null)}>{t("conflict_stay")}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConflict(null);
                markDirty(false);
                void loadWorkspace();
              }}
            >
              {t("conflict_reload")}
            </Button>
          </>
        }
      >
        <p>{t("conflict_body")}</p>
        <p className="pcms-field__hint">
          {t("conflict_generation")} {conflict}. {t("conflict_note")}
        </p>
      </Dialog>
    </div>
  );
}
