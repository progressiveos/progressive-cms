// Entry workspace (PCMS-ADMIN-T003): selected-entry editor with the baseline
// tabs (Admin spec §6). SEO/Route/Revisions/Publication land in T008–T011;
// autosave in T008 — this task ships explicit draft saving with CAS conflict
// handling (spec §20: no silent overwrite, ever).
import { useCallback, useEffect, useState } from "react";
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
import { Button, EmptyState, ErrorPanel, Icon, Spinner, TabPanel, Tabs } from "../../design/ui.js";
import { errorText, t } from "../../i18n/index.js";
import { BlockDocumentEditor } from "./blocks/BlockDocumentEditor.js";
import { SchemaForm } from "./SchemaForm.js";
import { TranslationsStrip } from "./TranslationsStrip.js";
import { PublicationTab } from "./tabs/PublicationTab.js";
import { RevisionsTab } from "./tabs/RevisionsTab.js";
import { RouteTab } from "./tabs/RouteTab.js";
import { SeoTab } from "./tabs/SeoTab.js";

type SaveState = "idle" | "saving" | "saved" | "error";

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
  const [schema, setSchema] = useState<ContentTypeSchemaWire | null>(null);
  const [revision, setRevision] = useState<RevisionWire | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [blocks, setBlocks] = useState<unknown>(null);
  const [generation, setGeneration] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [openingDraft, setOpeningDraft] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const auth = useAuth();
  const canPublish = auth.can("revision.seal") && auth.can("publication.publish");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [needsDraft, setNeedsDraft] = useState(false);
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

  const openDraft = useCallback(
    async (fromRevisionId?: string) => {
      setOpeningDraft(true);
      setLoadError(null);
      try {
        if (fromRevisionId !== undefined && !hasWorking) {
          const publication = await apiGet<{ state: string; current_revision_id: string | null }>(
            `/publications/entry/${encodeURIComponent(props.entryId)}`,
          );
          if (
            publication.state !== "PUBLISHED" ||
            publication.current_revision_id !== fromRevisionId
          ) {
            toast(t("published_content_changed"), "warning");
            props.onChanged();
            return;
          }
        }
        const draft = await createWorkingDraft(props.entryId, fromRevisionId);
        const loaded = await getRevision(draft.revision_id);
        setRevision(loaded);
        setValues((loaded.payload.fields ?? {}) as Record<string, unknown>);
        setBlocks(loaded.payload.blocks ?? null);
        setGeneration(loaded.edit_generation);
        setNeedsDraft(false);
        setHasWorking(true);
        setDirty(false);
        setSaveState("idle");
      } catch (caught) {
        setLoadError(
          caught instanceof ApiError
            ? (errorText(caught.code) ?? caught.message)
            : t("draft_open_failed"),
        );
      } finally {
        setOpeningDraft(false);
      }
    },
    [props.entryId, props.onChanged, hasWorking, toast],
  );

  useEffect(() => {
    let cancelled = false;
    setSchema(null);
    setRevision(null);
    setLoadError(null);
    setNeedsDraft(false);
    setHasWorking(false);
    setLegacyBaseConfirmation(null);
    setTab("content");
    const run = async () => {
      try {
        const loaded = await fetchContentTypeSchema(props.contentTypeKey);
        if (cancelled) return;
        setSchema(loaded);
        const revisions = await listRevisions(props.entryId);
        if (revisions.items.length === 0) {
          if (!cancelled) setLoadError(t("entry_no_revisions"));
          return;
        }
        const working = revisions.items.find((item) => item.state === "WORKING");
        if (working === undefined) {
          let publication: { state: string; current_revision_id: string | null } | null;
          try {
            publication = await apiGet(`/publications/entry/${encodeURIComponent(props.entryId)}`);
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) throw error;
            publication = null;
          }
          if (publication?.state === "PUBLISHED" && publication.current_revision_id !== null) {
            const published = await getRevision(publication.current_revision_id);
            if (cancelled) return;
            if (published.entity_id !== props.entryId)
              throw new Error("publication revision mismatch");
            setRevision(published);
            setValues((published.payload.fields ?? {}) as Record<string, unknown>);
            setBlocks(published.payload.blocks ?? null);
          }
          if (!cancelled) setNeedsDraft(true);
          return;
        }
        const revisionLoaded = await getRevision(working.id);
        if (cancelled) return;
        setHasWorking(true);
        setRevision(revisionLoaded);
        setValues((revisionLoaded.payload.fields ?? {}) as Record<string, unknown>);
        setBlocks(revisionLoaded.payload.blocks ?? null);
        setGeneration(revisionLoaded.edit_generation);
      } catch (caught) {
        if (!cancelled) {
          setLoadError(
            caught instanceof ApiError
              ? (errorText(caught.code) ?? caught.message)
              : t("entry_open_failed"),
          );
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [props.entryId, props.contentTypeKey]);

  const showPublished = async () => {
    try {
      const publication = await apiGet<{ state: string; current_revision_id: string | null }>(
        `/publications/entry/${encodeURIComponent(props.entryId)}`,
      );
      if (publication.state !== "PUBLISHED" || publication.current_revision_id === null) {
        toast(t("published_content_missing"), "warning");
        return;
      }
      const published = await getRevision(publication.current_revision_id);
      if (published.entity_id !== props.entryId) throw new Error("publication revision mismatch");
      setRevision(published);
      setValues((published.payload.fields ?? {}) as Record<string, unknown>);
      setBlocks(published.payload.blocks ?? null);
      setNeedsDraft(true);
    } catch (error) {
      toast(
        error instanceof ApiError
          ? (errorText(error.code) ?? error.message)
          : t("entry_open_failed"),
        "error",
      );
    }
  };

  const save = useCallback(async (): Promise<number | null> => {
    if (revision === null || schema === null) return null;
    setSaveState("saving");
    try {
      const result = await updateDraft(
        revision.id,
        {
          fields: values,
          ...(schema.bodyPolicy === "block_document"
            ? { blocks: blocks ?? { schema_version: 1, blocks: [] } }
            : {}),
        },
        generation,
      );
      setGeneration(result.edit_generation);
      setSaveState("saved");
      setDirty(false);
      props.onChanged();
      return result.edit_generation;
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "REVISION_STALE") {
        const detail = caught.details[0] as { current?: number } | undefined;
        setConflict(typeof detail?.current === "number" ? detail.current : generation);
        setSaveState("idle");
        return null;
      } else {
        setSaveState("error");
        toast(
          errorText(caught instanceof ApiError ? caught.code : "") ?? t("save_failed"),
          "error",
        );
        return null;
      }
    }
  }, [revision, values, blocks, schema, generation, props, toast]);

  const publishingNow = publishing || saveState === "saving";

  const publishNow = useCallback(
    async (approvedLegacy?: {
      revisionId: string;
      currentRevisionId: string | null;
      generation: number;
      reason: "unknown" | "changed";
    }) => {
      if (revision === null || publishingNow) return;
      setPublishing(true);
      try {
        let publication: {
          state: string;
          current_revision_id: string | null;
          generation: number;
        } | null;
        try {
          publication = await apiGet(`/publications/entry/${props.entryId}`);
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
          publication = null;
        }
        if (
          publication?.state === "PUBLISHED" &&
          (revision.parent_revision_id == null ||
            publication.current_revision_id !== revision.parent_revision_id)
        ) {
          if (approvedLegacy === undefined) {
            setLegacyBaseConfirmation({
              revisionId: revision.id,
              currentRevisionId: publication.current_revision_id,
              generation: publication.generation,
              reason: revision.parent_revision_id == null ? "unknown" : "changed",
            });
            return;
          }
          if (
            approvedLegacy.revisionId !== revision.id ||
            approvedLegacy.currentRevisionId !== publication.current_revision_id ||
            approvedLegacy.generation !== publication.generation
          ) {
            toast(t("published_content_changed"), "warning");
            return;
          }
        }
        // Owner 2026-10-06: the editor publish button ALWAYS saves the draft
        // first, then seals and publishes — one action for the human.
        const saved = await save();
        if (saved === null) return;
        await apiPost(`/revisions/${revision.id}/seal`, {
          expected_edit_generation: saved,
        });
        await apiPost("/publications/publish", {
          entity_type: "entry",
          entity_id: props.entryId,
          target_revision_id: revision.id,
          expected_generation: publication?.generation ?? 0,
        });
        toast(t("editor_published"), "success");
        setDirty(false);
        props.onChanged();
      } catch (caught) {
        // Validation issues ride the envelope details — show them (owner: the
        // human must SEE what is wrong).
        toast(describeApiError(caught), "error");
      } finally {
        setPublishing(false);
      }
    },
    [revision, publishingNow, props, toast, save],
  );

  const reloadRevision = useCallback(async () => {
    if (revision === null) return;
    const loaded = await getRevision(revision.id);
    setRevision(loaded);
    setValues((loaded.payload.fields ?? {}) as Record<string, unknown>);
    setGeneration(loaded.edit_generation);
  }, [revision]);

  // Autosave (PCMS-ADMIN-T008; Admin spec §20): debounced, explicit state,
  // optimistic generation — a stale save never silently overwrites.
  useEffect(() => {
    if (!dirty || conflict !== null || openingDraft) return;
    const timer = setTimeout(() => void save(), 1500);
    return () => clearTimeout(timer);
  }, [dirty, conflict, openingDraft, save]);

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

  if (loadError !== null) {
    return <ErrorPanel message={loadError} onRetry={props.onChanged} />;
  }
  if (needsDraft) {
    if (schema !== null && revision !== null) {
      return (
        <div className="pcms-panel pcms-editor" data-testid="published-content">
          <h2>{typeof values.title === "string" ? values.title : t("tree_untitled")}</h2>
          <p>{t("published_content_readonly")}</p>
          <LocationStrip {...(props.location === undefined ? {} : { location: props.location })} />
          {auth.can("content.edit") && (
            <Button
              variant="primary"
              disabled={openingDraft}
              onClick={() => void openDraft(revision.id)}
            >
              {hasWorking ? t("published_content_return_draft") : t("needs_draft_action")}
            </Button>
          )}
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
      <EmptyState
        title={t("needs_draft_title")}
        hint={t("needs_draft_hint")}
        action={
          auth.can("content.edit") ? (
            <Button variant="primary" disabled={openingDraft} onClick={() => void openDraft()}>
              {t("needs_draft_action")}
            </Button>
          ) : undefined
        }
      />
    );
  }
  if (openingDraft) {
    return (
      <div data-testid="entry-draft-loading">
        <Spinner />
      </div>
    );
  }
  if (schema === null || revision === null) return <Spinner />;

  const title =
    typeof values.title === "string" && values.title !== "" ? values.title : t("tree_untitled");

  return (
    <div className="pcms-panel pcms-editor" data-testid="entry-workspace">
      <div className="pcms-editor__header">
        <div className="pcms-editor__heading">
          <h2 className="pcms-editor__title" data-testid="editor-title">
            {title}
          </h2>
          <span className="pcms-editor__meta">
            {schema.title} ·{" "}
            {revision.state === "WORKING" ? t("revision_draft") : t("revision_ready")}
          </span>
        </div>
        <div className="pcms-editor__actions">
          {!dirty && auth.can("publication.read") && (
            <Button onClick={() => void showPublished()}>{t("published_content_show")}</Button>
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
          <Button variant="primary" disabled={saveState === "saving"} onClick={() => void save()}>
            {t("editor_save_draft")}
          </Button>
          <Button
            disabled={publishingNow || dirty || saveState !== "saved" || !canPublish}
            title={canPublish ? undefined : t("editor_publish_no_permission")}
            onClick={() => void publishNow()}
          >
            {publishingNow ? t("editor_publishing") : t("editor_publish")}
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
            setValues(next);
            setDirty(true);
          }}
        />
        {schema.bodyPolicy === "block_document" ? (
          <div className="pcms-panel" style={{ marginTop: "var(--pcms-admin-space-4)" }}>
            <h3>{t("blocks_section")}</h3>
            <BlockDocumentEditor
              value={(blocks ?? { schema_version: 1, blocks: [] }) as never}
              onChange={(document) => {
                setBlocks(document);
                setDirty(true);
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
          onDraftChanged={(revisionId) => {
            void openDraft(revisionId);
            props.onChanged();
          }}
        />
      </TabPanel>
      <TabPanel id="publication" active={tab === "publication"}>
        <PublicationTab
          entryId={props.entryId}
          revisionId={revision.id}
          revisionState={revision.state}
          generation={generation}
          onPublicationChanged={() => {
            void reloadRevision();
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
                void openDraft();
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
