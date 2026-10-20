// Publication workspace (PCMS-ADMIN-T016..T018; Admin spec §34-§37).
// ChangeSets: grouped items, validate/preview/apply/cancel with stale
// conflicts surfaced; schedule rides the batch plan builder with an exact
// timeline preview before anything is committed.
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiGet, apiPost, apiRequest, describeApiError } from "../../api/client.js";
import { useAuth } from "../../auth/AuthContext.js";
import { ConfirmDialog, Dialog } from "../../design/dialog.js";
import { useToast } from "../../design/toast.js";
import {
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
import { formatDateTime, t } from "../../i18n/index.js";
import { EntryPickerDialog } from "../content/fields/pickers.js";
import { CalendarScreen } from "./CalendarScreen.js";

export interface ChangeSetWire {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly created_at: string;
}

/**
 * The GET /changesets/:id route returns M07 ChangeSetItemRecords verbatim —
 * camelCase. Both casings accepted so the wire contract can evolve without
 * breaking the Admin grouping.
 */
export interface ItemWire {
  readonly id: string;
  readonly entity_type?: string;
  readonly entityType?: string;
  readonly entity_id?: string;
  readonly entityId?: string;
  readonly intent?: string;
  readonly target_revision_id?: string | null;
  readonly targetRevisionId?: string | null;
  readonly routeOperation?: unknown;
  readonly route_operation?: unknown;
}

function itemType(item: ItemWire): string {
  return item.entity_type ?? item.entityType ?? "unknown";
}
function itemIdOf(item: ItemWire): string {
  return item.entity_id ?? item.entityId ?? "";
}
function itemIntent(item: ItemWire): string {
  return item.intent ?? "PUBLISH";
}
function itemTargetRevision(item: ItemWire): string | null {
  return item.target_revision_id ?? item.targetRevisionId ?? null;
}
function itemRouteOperation(item: ItemWire): unknown {
  return item.routeOperation ?? item.route_operation ?? null;
}

interface PreflightWire {
  readonly ok: boolean;
  readonly issues: readonly {
    readonly code: string;
    readonly message: string;
    readonly severity?: string;
  }[];
  readonly stale?: unknown;
}

/** Label maps resolve per render so a locale switch re-localizes them. */
function entityGroupLabel(entityType: string): string {
  switch (entityType) {
    case "entry":
      return t("publication.group_entry");
    case "navigation":
      return t("publication.group_navigation");
    case "global_content":
      return t("publication.group_global_content");
    case "theme_settings":
      return t("publication.group_theme_settings");
    default:
      return entityType;
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case "OPEN":
      return t("publication.state_open");
    case "READY":
      return t("publication.state_ready");
    case "APPLIED":
      return t("publication.state_applied");
    case "PARTIALLY_SCHEDULED":
      return t("publication.state_partially_scheduled");
    case "CANCELLED":
      return t("publication.state_cancelled");
    case "FAILED":
      return t("publication.state_failed");
    default:
      return state;
  }
}

function intentLabel(intent: string): string {
  switch (intent) {
    case "PUBLISH":
      return t("publication.intent_publish");
    case "UNPUBLISH":
      return t("publication.intent_unpublish");
    default:
      return intent;
  }
}

const STATE_TONES: Readonly<
  Record<string, "neutral" | "accent" | "success" | "warning" | "danger">
> = {
  OPEN: "accent",
  READY: "success",
  APPLIED: "success",
  PARTIALLY_SCHEDULED: "warning",
  CANCELLED: "neutral",
  FAILED: "danger",
};

export function ChangesetsScreen() {
  return <PublicationTabs />;
}

/**
 * Human publication model (owner UX pass 0.1.28): the editor thinks in
 * "waiting for publication / scheduled / history", not in changesets. The
 * changeset machinery stays authoritative under the hood and remains fully
 * reachable in the "Advanced" tab.
 */
function PublicationTabs() {
  const [tab, setTab] = useState("ready");
  return (
    <div>
      <div className="pcms-tabs" role="tablist" aria-label={t("publication.sections_aria")}>
        <button
          type="button"
          role="tab"
          className="pcms-tab"
          aria-selected={tab === "ready"}
          onClick={() => setTab("ready")}
        >
          {t("publication.tab_ready")}
        </button>
        <button
          type="button"
          role="tab"
          className="pcms-tab"
          aria-selected={tab === "calendar"}
          onClick={() => setTab("calendar")}
        >
          {t("publication.tab_calendar")}
        </button>
        <button
          type="button"
          role="tab"
          className="pcms-tab"
          aria-selected={tab === "history"}
          onClick={() => setTab("history")}
        >
          {t("publication.tab_history")}
        </button>
        <button
          type="button"
          role="tab"
          className="pcms-tab"
          aria-selected={tab === "advanced"}
          onClick={() => setTab("advanced")}
        >
          {t("publication.tab_advanced")}
        </button>
        <button
          type="button"
          role="tab"
          className="pcms-tab"
          aria-selected={tab === "bundle"}
          onClick={() => setTab("bundle")}
        >
          {t("publication.tab_bundle")}
        </button>
      </div>
      {tab === "calendar" ? (
        <CalendarScreen />
      ) : tab === "history" ? (
        <HistoryTab />
      ) : tab === "advanced" ? (
        <ChangesetsTab />
      ) : tab === "bundle" ? (
        <ImportBundleTab />
      ) : (
        <ReadyTab />
      )}
    </div>
  );
}

interface PendingWire {
  readonly entry_id: string;
  readonly content_type: string | null;
  readonly title: string;
  readonly status: "draft" | "working_changes" | "ready";
  readonly revision_id: string;
  readonly revision_state: "WORKING" | "SEALED";
  readonly edit_generation: number;
  readonly changed_at: string;
  readonly changed_by: string | null;
  readonly route_path: string | null;
  readonly published: boolean;
  readonly scheduled_at: string | null;
  readonly expected_generation: number;
}

/**
 * Status is a group of semantic icons with tooltips (owner rule: no long text
 * chips in dense tables; colour never carries meaning alone). Two independent
 * dimensions: live state (a public version exists) and working state, plus a
 * pending-schedule marker.
 */
function PendingStatusCell(props: { readonly item: PendingWire }) {
  return (
    <span className="pcms-status-icons" data-testid={`pending-status-${props.item.entry_id}`}>
      {props.item.published ? (
        <Icon
          name="globe"
          label={t("publication.live_published")}
          title={t("publication.live_published")}
          className="pcms-status-icon pcms-status-icon--ok"
        />
      ) : null}
      {props.item.status === "draft" ? (
        <Icon
          name="file"
          label={t("publication.live_never_published")}
          title={t("publication.live_never_published")}
          className="pcms-status-icon pcms-status-icon--muted"
        />
      ) : props.item.status === "working_changes" ? (
        <Icon
          name="edit"
          label={t("publication.working_unpublished_changes")}
          title={t("publication.working_unpublished_changes")}
          className="pcms-status-icon pcms-status-icon--warn"
        />
      ) : (
        <Icon
          name="check"
          label={t("publication.working_ready_to_publish")}
          title={t("publication.working_ready_to_publish")}
          className="pcms-status-icon pcms-status-icon--ok"
        />
      )}
      {props.item.scheduled_at !== null ? (
        <Icon
          name="clock"
          label={t("publication.scheduled_for", {
            at: formatDateTime(props.item.scheduled_at),
          })}
          title={t("publication.scheduled_for", {
            at: formatDateTime(props.item.scheduled_at),
          })}
          className="pcms-status-icon pcms-status-icon--info"
        />
      ) : null}
    </span>
  );
}

function ReadyTab() {
  const auth = useAuth();
  const toast = useToast();
  const [items, setItems] = useState<readonly PendingWire[] | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<PendingWire | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [planning, setPlanning] = useState<ChangeSetWire | null>(null);
  const [previewIssue, setPreviewIssue] = useState<{
    readonly entryId: string;
    readonly title: string;
    readonly issues: readonly { readonly code: string; readonly message: string }[];
  } | null>(null);

  const reload = useCallback(() => {
    apiGet<{ items: readonly PendingWire[] }>("/publication/pending?limit=200")
      .then((result) => setItems(result.items))
      .catch(() => toast(t("publication.pending_load_failed"), "error"));
  }, [toast]);

  useEffect(reload, [reload]);

  const openPreview = async (item: PendingWire) => {
    try {
      // Preview is a pure read (2026-10-01 owner incident): an earlier
      // implementation sealed the WORKING revision and forked a fresh draft
      // just to look at it — mutating revisions and misattributing changed_by
      // on a mere "Preview". The server contract renders an unsealed
      // WORKING revision directly from an allow_draft token; no seal, no
      // fork, no PATCH. The token shows the CURRENT draft state — later
      // edits change what it renders.
      const result = await apiPost<{ token: string }>("/previews", {
        scope: {
          kind: "revision",
          entity_type: "entry",
          entity_id: item.entry_id,
          revision_id: item.revision_id,
          ...(item.revision_state === "WORKING" ? { allow_draft: true } : {}),
        },
      });
      window.open(`/preview/page?token=${encodeURIComponent(result.token)}`, "_blank", "noopener");
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "REVISION_VALIDATION_FAILED") {
        const issues = caught.details.filter(
          (detail): detail is { readonly code: string; readonly message: string } =>
            typeof detail === "object" &&
            detail !== null &&
            typeof (detail as { message?: unknown }).message === "string",
        );
        setPreviewIssue({ entryId: item.entry_id, title: item.title, issues });
      } else if (caught instanceof ApiError && caught.code === "REVISION_STALE") {
        toast(t("publication.preview_stale"), "error");
      } else {
        toast(t("preview_failed"), "error");
      }
    } finally {
      reload();
    }
  };

  const publishNow = async (item: PendingWire) => {
    setBusy(true);
    setConfirmError(null);
    try {
      // A working revision is sealed first — the same gate the manual
      // changeset flow enforces; the editor just never has to think about it.
      if (item.revision_state === "WORKING") {
        await apiPost(`/revisions/${item.revision_id}/seal`, {
          expected_edit_generation: item.edit_generation,
        });
      }
      await apiPost("/publications/publish", {
        entity_type: "entry",
        entity_id: item.entry_id,
        target_revision_id: item.revision_id,
        expected_generation: item.expected_generation,
      });
      toast(t("publication.pending_published"), "success");
      setConfirmTarget(null);
      reload();
    } catch (caught) {
      setConfirmError(
        caught instanceof ApiError ? describeApiError(caught) : t("publication.operation_failed"),
      );
    } finally {
      setBusy(false);
    }
  };

  /** Single-entry schedule: seal + a one-item changeset + the plan builder. */
  const startScheduling = async (item: PendingWire) => {
    setBusy(true);
    try {
      if (item.revision_state === "WORKING") {
        await apiPost(`/revisions/${item.revision_id}/seal`, {
          expected_edit_generation: item.edit_generation,
        });
      }
      const changeset = await apiPost<{ id: string; title: string }>("/changesets", {
        title: t("publication.pending_package_title", { title: item.title }),
      });
      await apiPost(`/changesets/${changeset.id}/items`, {
        entity_type: "entry",
        entity_id: item.entry_id,
        intent: "PUBLISH",
        target_revision_id: item.revision_id,
        expected_generation: item.expected_generation,
      });
      setPlanning({ id: changeset.id, title: changeset.title, state: "OPEN", created_at: "" });
    } catch (caught) {
      toast(
        caught instanceof ApiError
          ? (caught.message ?? caught.code)
          : t("publication.operation_failed"),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  if (items === null) return <Spinner />;

  return (
    <div className="pcms-screen--wide" data-testid="ready-screen">
      <p className="pcms-field__hint">{t("publication.pending_hint")}</p>
      {items.length === 0 ? (
        <EmptyState
          title={t("publication.pending_empty_title")}
          hint={t("publication.pending_empty_hint")}
        />
      ) : (
        <div className="pcms-table-wrap">
          <table className="pcms-table" data-testid="pending-table">
            <thead>
              <tr>
                <th>{t("publication.pending_th_entry")}</th>
                <th>{t("publication.pending_th_changed")}</th>
                <th>{t("publication.pending_th_actor")}</th>
                <th>{t("publication.pending_th_status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.entry_id}>
                  <td>
                    <a href={`#/content/${item.entry_id}`}>{item.title}</a>
                    <div className="pcms-picker-row__meta">
                      {item.content_type ?? ""}
                      {item.route_path === null ? "" : ` · ${item.route_path}`}
                    </div>
                  </td>
                  <td>{formatDateTime(item.changed_at)}</td>
                  <td>{item.changed_by ?? "—"}</td>
                  <td>
                    <PendingStatusCell item={item} />
                  </td>
                  <td>
                    <div className="pcms-row__actions">
                      {auth.can("preview.create") ? (
                        <IconButton
                          icon="preview"
                          label={t("publication_preview")}
                          small
                          disabled={busy}
                          onClick={() => void openPreview(item)}
                        />
                      ) : null}
                      {auth.can("publication.publish") ? (
                        <IconButton
                          icon="publish"
                          label={t("publication_publish")}
                          small
                          onClick={() => setConfirmTarget(item)}
                        />
                      ) : null}
                      {auth.can("publication.plan") || auth.can("publication.schedule") ? (
                        <IconButton
                          icon="clock"
                          label={t("publication.pending_schedule")}
                          small
                          disabled={busy}
                          onClick={() => void startScheduling(item)}
                        />
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={confirmTarget !== null}
        onClose={() => (busy ? undefined : setConfirmTarget(null))}
        onConfirm={() => confirmTarget !== null && void publishNow(confirmTarget)}
        title={t("publish_confirm_title")}
        body={t("publish_confirm_body")}
        details={
          confirmTarget === null
            ? []
            : [
                { label: t("publish_confirm_entry"), value: confirmTarget.title },
                ...(confirmTarget.route_path === null
                  ? []
                  : [{ label: t("publish_confirm_route"), value: confirmTarget.route_path }]),
              ]
        }
        confirmLabel={t("publication_publish")}
        tone="primary"
        busy={busy}
        error={confirmError}
      />
      {planning !== null ? (
        <PlanBuilderDialog
          changeset={planning}
          single
          onClose={() => {
            setPlanning(null);
            reload();
          }}
        />
      ) : null}
      {previewIssue !== null ? (
        <Dialog
          open
          onClose={() => setPreviewIssue(null)}
          title={t("publication.preview_unavailable")}
          footer={
            <>
              <Button onClick={() => setPreviewIssue(null)}>{t("cancel")}</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const entryId = previewIssue.entryId;
                  setPreviewIssue(null);
                  window.location.hash = `#/content/${entryId}`;
                }}
              >
                {t("publication.open_entry")}
              </Button>
            </>
          }
        >
          <p>{t("publication.preview_fix_issues", { title: previewIssue.title })}</p>
          <ul>
            {previewIssue.issues.map((issue) => (
              <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        </Dialog>
      ) : null}
    </div>
  );
}

interface HistoryWire {
  readonly title: string;
  readonly kind: "package" | "single";
  readonly event_types: readonly string[];
  readonly actor: string | null;
  readonly occurred_at: string;
  readonly entry_count: number;
  readonly entries: readonly { readonly entry_id: string; readonly title: string }[];
  readonly changeset_id: string | null;
}

function historyResultLabel(eventTypes: readonly string[]): string {
  const has = (type: string) => eventTypes.includes(type);
  if (has("UNPUBLISH")) return t("publication.history_unpublished");
  if (has("ROLLBACK")) return t("publication.history_rolled_back");
  if (has("PUBLISH_FIRST")) return t("publication.history_published_first");
  if (has("PUBLISH_UPDATE")) return t("publication.history_published_update");
  return eventTypes.join(", ");
}

function HistoryTab() {
  const [items, setItems] = useState<readonly HistoryWire[] | null>(null);

  useEffect(() => {
    apiGet<{ items: readonly HistoryWire[] }>("/publication/history?limit=100")
      .then((result) => setItems(result.items))
      .catch(() => setItems([]));
  }, []);

  if (items === null) return <Spinner />;

  return (
    <div className="pcms-screen--wide" data-testid="history-screen">
      {items.length === 0 ? (
        <EmptyState
          title={t("publication.history_empty_title")}
          hint={t("publication.history_empty_hint")}
        />
      ) : (
        <div className="pcms-table-wrap">
          <table className="pcms-table" data-testid="history-table">
            <thead>
              <tr>
                <th>{t("publication.history_th_operation")}</th>
                <th>{t("publication.history_th_date")}</th>
                <th>{t("publication.history_th_actor")}</th>
                <th>{t("publication.history_th_count")}</th>
                <th>{t("publication.history_th_result")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={`${item.changeset_id ?? "single"}-${item.occurred_at}-${item.title}`}>
                  <td>
                    {item.title}
                    {item.kind === "package" ? (
                      <div className="pcms-picker-row__meta">
                        <Badge>{t("publication.history_package")}</Badge>
                      </div>
                    ) : null}
                    <details>
                      <summary className="pcms-field__hint">
                        {t("publication.history_details")}
                      </summary>
                      <ul>
                        {item.entries.map((entry) => (
                          <li key={entry.entry_id}>
                            {entry.title === ""
                              ? "—"
                              : t("publication.history_entry", { title: entry.title })}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </td>
                  <td>{formatDateTime(item.occurred_at)}</td>
                  <td>{item.actor ?? "—"}</td>
                  <td>{item.entry_count}</td>
                  <td>{historyResultLabel(item.event_types)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ChangesetsTab() {
  const auth = useAuth();
  const toast = useToast();
  const [changesets, setChangesets] = useState<readonly ChangeSetWire[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [items, setItems] = useState<readonly ItemWire[] | null>(null);
  const [preflight, setPreflight] = useState<PreflightWire | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [applyConfirm, setApplyConfirm] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    apiGet<{ items: readonly ChangeSetWire[] }>("/changesets?limit=50")
      .then((result) => {
        setChangesets([...result.items].reverse());
        setActiveId((current) => current ?? result.items[0]?.id ?? null);
      })
      .catch(() => toast(t("publication.changesets_load_failed"), "error"));
  }, [toast]);

  useEffect(reload, [reload]);

  const active = changesets?.find((changeset) => changeset.id === activeId) ?? null;

  const loadItems = useCallback(async (changesetId: string) => {
    setPreflight(null);
    try {
      const result = await apiGet<{ items: readonly ItemWire[] }>(`/changesets/${changesetId}`);
      setItems(result.items);
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    if (activeId === null) {
      setItems(null);
      return;
    }
    setItems(null);
    void loadItems(activeId);
  }, [activeId, loadItems]);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      toast(success, "success");
      reload();
      if (activeId !== null) await loadItems(activeId);
    } catch {
      toast(t("publication.operation_failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const preflightNow = async () => {
    if (activeId === null) return;
    setBusy(true);
    try {
      const result = await apiPost<PreflightWire>(`/changesets/${activeId}/preflight`, {});
      setPreflight(result);
    } catch (caught) {
      setPreflight({
        ok: false,
        issues: [
          {
            code: "PREFLIGHT_FAILED",
            message:
              caught instanceof Error && "code" in caught
                ? t("publication.preflight_failed_code", {
                    code: String((caught as { code: string }).code),
                  })
                : t("publication.preflight_failed"),
          },
        ],
      });
    } finally {
      setBusy(false);
    }
  };

  const grouped = new Map<string, readonly ItemWire[]>();
  for (const item of items ?? []) {
    const type = itemType(item);
    grouped.set(type, [...(grouped.get(type) ?? []), item]);
  }

  return (
    <div className="pcms-screen--wide" data-testid="changesets-screen">
      <p className="pcms-field__hint">{t("publication.advanced_hint")}</p>
      <h1>{t("publication.tab_changesets")}</h1>
      <div className="pcms-toolbar">
        <strong>{t("publication.tab_changesets")}</strong>
        <span className="pcms-toolbar__spacer" />
        {auth.can("publication.plan") ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            {t("publication.new_changeset")}
          </Button>
        ) : null}
      </div>

      <div className="pcms-columns pcms-columns--tree">
        <div className="pcms-panel">
          {changesets === null ? (
            <Spinner />
          ) : changesets.length === 0 ? (
            <EmptyState
              title={t("publication.empty_list_title")}
              hint={t("publication.empty_list_hint")}
            />
          ) : (
            <ul className="pcms-tree">
              {changesets.map((changeset) => (
                <li key={changeset.id}>
                  <button
                    type="button"
                    className="pcms-tree__row"
                    aria-current={changeset.id === activeId}
                    onClick={() => setActiveId(changeset.id)}
                  >
                    <span className="pcms-tree__label">{changeset.title}</span>
                    <Badge tone={STATE_TONES[changeset.state] ?? "neutral"}>
                      {stateLabel(changeset.state)}
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="pcms-panel">
          {active === null ? (
            <EmptyState title={t("publication.empty_selection")} />
          ) : (
            <>
              <div className="pcms-toolbar">
                <h3>{active.title}</h3>
                <Badge tone={STATE_TONES[active.state] ?? "neutral"}>
                  {stateLabel(active.state)}
                </Badge>
                <span className="pcms-toolbar__spacer" />
                {auth.can("publication.plan") && active.state === "OPEN" ? (
                  <>
                    <Button size="sm" disabled={busy} onClick={() => setAddOpen(true)}>
                      {t("publication.add_item")}
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => void preflightNow()}>
                      {t("publication.preflight_button")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setPlanOpen(true)}
                    >
                      {t("publication.schedule_button")}
                    </Button>
                  </>
                ) : null}
                {auth.can("publication.publish") && active.state === "READY" ? (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={() => setApplyConfirm(true)}
                  >
                    {t("publication.publish_changeset")}
                  </Button>
                ) : null}
                {auth.can("publication.plan") &&
                (active.state === "OPEN" || active.state === "READY") ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () =>
                          apiPost(`/changesets/${active.id}/cancel`, {
                            reason: t("publication.cancel_reason_default"),
                          }),
                        t("publication.changeset_cancelled"),
                      )
                    }
                  >
                    {t("publication.cancel_publication")}
                  </Button>
                ) : null}
              </div>

              {preflight !== null ? (
                <div
                  className="pcms-panel"
                  role={preflight.ok ? "status" : "alert"}
                  data-testid="preflight-report"
                >
                  {preflight.ok ? (
                    <Badge tone="success">{t("publication.preflight_passed")}</Badge>
                  ) : (
                    <>
                      <strong>{t("publication.preflight_issues_title")}</strong>
                      <ul>
                        {preflight.issues.map((issue) => (
                          <li key={`${issue.code}-${issue.message}`}>
                            {issue.message}{" "}
                            <span className="pcms-picker-row__meta">({issue.code})</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              ) : null}

              {items === null ? (
                <Spinner />
              ) : items.length === 0 ? (
                <EmptyState
                  title={t("publication.empty_items_title")}
                  hint={t("publication.empty_items_hint")}
                />
              ) : (
                [...grouped.entries()].map(([entityType, groupItems]) => (
                  <div key={entityType} className="pcms-panel">
                    <h3>{entityGroupLabel(entityType)}</h3>
                    {groupItems.map((item) => (
                      <div key={item.id} className="pcms-row" style={{ alignItems: "center" }}>
                        <div className="pcms-row__body">
                          <span className="pcms-picker-row__meta">{itemIdOf(item)}</span>
                        </div>
                        <Badge tone={item.intent === "PUBLISH" ? "success" : "warning"}>
                          {intentLabel(itemIntent(item))}
                        </Badge>
                        {itemTargetRevision(item) === null ? null : (
                          <span className="pcms-picker-row__meta">
                            {t("publication.rev_short", {
                              rev: String(itemTargetRevision(item)).slice(0, 8),
                            })}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>

      {createOpen ? (
        <CreateChangesetDialog
          onClose={() => setCreateOpen(false)}
          onCreate={(title) => {
            setCreateOpen(false);
            void run(async () => {
              const result = await apiPost<{ id: string }>("/changesets", { title });
              reload();
              setActiveId(result.id);
            }, t("publication.changeset_created"));
          }}
        />
      ) : null}

      {addOpen && active !== null ? (
        <AddItemDialog
          onClose={() => setAddOpen(false)}
          onAdd={(payload) => {
            setAddOpen(false);
            void run(async () => {
              await apiPost(`/changesets/${active.id}/items`, payload);
            }, t("publication.item_added"));
          }}
        />
      ) : null}

      {applyConfirm && active !== null ? (
        <Dialog
          open
          onClose={() => setApplyConfirm(false)}
          title={t("publication.publish_confirm_title")}
          footer={
            <>
              <Button onClick={() => setApplyConfirm(false)}>{t("cancel")}</Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  setApplyConfirm(false);
                  void run(
                    () => apiPost(`/changesets/${active.id}/apply`, {}),
                    t("publication.changeset_published"),
                  );
                }}
              >
                {t("publication_publish")}
              </Button>
            </>
          }
        >
          <p>{t("publication.publish_confirm_body")}</p>
        </Dialog>
      ) : null}

      {planOpen && active !== null ? (
        <PlanBuilderDialog changeset={active} onClose={() => setPlanOpen(false)} />
      ) : null}
    </div>
  );
}

function CreateChangesetDialog(props: {
  readonly onClose: () => void;
  readonly onCreate: (title: string) => void;
}) {
  const [title, setTitle] = useState("");
  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t("publication.create_title")}
      footer={
        <>
          <Button onClick={props.onClose}>{t("cancel")}</Button>
          <Button
            variant="primary"
            disabled={title.trim() === ""}
            onClick={() => props.onCreate(title.trim())}
          >
            {t("publication.create_submit")}
          </Button>
        </>
      }
    >
      <Field label={t("publication.create_name_label")} required>
        <Input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
      </Field>
    </Dialog>
  );
}

function AddItemDialog(props: {
  readonly onClose: () => void;
  readonly onAdd: (payload: Record<string, unknown>) => void;
}) {
  const [entityType, setEntityType] = useState("entry");
  const [entryId, setEntryId] = useState<string | null>(null);
  const [entityId, setEntityId] = useState("");
  const [revisionId, setRevisionId] = useState("");
  const [revisions, setRevisions] = useState<readonly { id: string; revision_no: number }[] | null>(
    null,
  );
  const [intent, setIntent] = useState("PUBLISH");
  const [picking, setPicking] = useState(false);
  const [generation, setGeneration] = useState("0");

  useEffect(() => {
    if (entryId === null) {
      setRevisions(null);
      return;
    }
    void apiGet<{ items: readonly { id: string; revision_no: number; state: string }[] }>(
      `/entries/${entryId}/revisions`,
    ).then((result) => {
      const sealed = result.items
        .filter((item) => item.state === "SEALED")
        .map((item) => ({ id: item.id, revision_no: item.revision_no }));
      setRevisions(sealed);
      setRevisionId(sealed[0]?.id ?? "");
    });
    void apiGet<{ generation: number }>(`/publications/entry/${entryId}`)
      .then((publication) => setGeneration(String(publication.generation)))
      .catch(() => setGeneration("0"));
  }, [entryId]);

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t("publication.add_item_title")}
      footer={
        <>
          <Button onClick={props.onClose}>{t("cancel")}</Button>
          <Button
            variant="primary"
            disabled={entityType === "entry" && (entryId === null || revisionId === "")}
            onClick={() =>
              props.onAdd({
                entity_type: entityType,
                entity_id: entityType === "entry" ? entryId : entityId,
                intent,
                ...(intent === "PUBLISH" && entityType === "entry"
                  ? { target_revision_id: revisionId }
                  : {}),
                expected_generation: Number(generation),
              })
            }
          >
            {t("publication.add_submit")}
          </Button>
        </>
      }
    >
      <Field label={t("publication.entity_type_label")}>
        <Select value={entityType} onChange={(event) => setEntityType(event.target.value)}>
          <option value="entry">{t("publication.entity_entry")}</option>
          <option value="navigation">{t("publication.entity_navigation")}</option>
          <option value="global_content">{t("publication.entity_global_content")}</option>
          <option value="theme_settings">{t("publication.entity_theme_settings")}</option>
        </Select>
      </Field>
      {entityType === "entry" ? (
        <>
          <Field label={t("publication.entry_label")} required>
            <div className="pcms-ref">
              <span className="pcms-picker-row__meta">
                {entryId ?? t("publication.not_selected")}
              </span>
              <Button size="sm" onClick={() => setPicking(true)}>
                {t("publication.pick_button")}
              </Button>
            </div>
          </Field>
          {revisions !== null && revisions.length === 0 ? (
            <p className="pcms-field__error">{t("publication.no_sealed_revisions")}</p>
          ) : revisions === null ? null : (
            <Field label={t("publication.sealed_revision_label")} required>
              <Select value={revisionId} onChange={(event) => setRevisionId(event.target.value)}>
                {revisions.map((revision) => (
                  <option key={revision.id} value={revision.id}>
                    №{revision.revision_no}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </>
      ) : (
        <Field label={t("publication.entity_id_label")} required>
          <Input value={entityId} onChange={(event) => setEntityId(event.target.value)} />
        </Field>
      )}
      <Field label={t("publication.action_label")}>
        <Select value={intent} onChange={(event) => setIntent(event.target.value)}>
          <option value="PUBLISH">{t("publication.intent_option_publish")}</option>
          <option value="UNPUBLISH">{t("publication_unpublish")}</option>
        </Select>
      </Field>
      <Field
        label={t("publication.expected_generation_label")}
        hint={t("publication.expected_generation_hint")}
      >
        <Input
          inputMode="numeric"
          value={generation}
          onChange={(event) => setGeneration(event.target.value)}
        />
      </Field>
      {picking ? (
        <EntryPickerDialog
          open
          onClose={() => setPicking(false)}
          title={t("publication.picker_title")}
          onPick={(picked) => {
            setPicking(false);
            setEntryId(picked);
          }}
        />
      ) : null}
    </Dialog>
  );
}

interface CompiledEntry {
  readonly changesetItemId: string;
  readonly publishAt: string | null;
}

function PlanBuilderDialog(props: {
  readonly changeset: ChangeSetWire;
  /** Single-entry schedule (pending list): date/time/timezone only — the
   * batch machinery stays an "Advanced"-tab concern. */
  readonly single?: boolean;
  readonly onClose: () => void;
}) {
  const toast = useToast();
  // Local wall-clock date, not UTC: the server reads startLocal in the site
  // timezone, and a UTC default between 00:00 and the UTC offset is YESTERDAY
  // locally (2026-10-02 corpus catch: "23:59 today" landed in the past).
  const [startDate, setStartDate] = useState(() => {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  });
  const [startTime, setStartTime] = useState("09:00");
  const [batchSize, setBatchSize] = useState("3");
  const [intervalValue, setIntervalValue] = useState("12");
  const [intervalUnit, setIntervalUnit] = useState("hours");
  const [failurePolicy, setFailurePolicy] = useState("continue");
  const [planId, setPlanId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<readonly CompiledEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

  const buildSpec = () => ({
    batchSize: Number(batchSize),
    interval: { unit: intervalUnit, value: Number(intervalValue) },
    ...(startDate !== "" && startTime !== ""
      ? { startLocal: { date: startDate, time: startTime } }
      : {}),
  });

  const ensurePlan = async (): Promise<string> => {
    if (planId !== null) return planId;
    const plan = await apiPost<{ id: string }>("/plans", {
      changeset_id: props.changeset.id,
      timezone,
      failure_policy: failurePolicy,
    });
    setPlanId(plan.id);
    return plan.id;
  };

  const preview = async () => {
    setBusy(true);
    try {
      const id = await ensurePlan();
      const previewed = await apiPost<{ items: readonly CompiledEntry[] }>(`/plans/${id}/preview`, {
        spec: buildSpec(),
      });
      setTimeline(previewed.items);
    } catch {
      toast(t("publication.schedule_preview_failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const schedule = async () => {
    setBusy(true);
    try {
      const id = await ensurePlan();
      await apiPost(`/plans/${id}/schedule`, { spec: buildSpec() });
      toast(t("publication.schedule_committed"), "success");
      props.onClose();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "SCHEDULE_IN_PAST") {
        toast(t("publication.schedule_in_past"), "error");
      } else if (caught instanceof ApiError && caught.code === "API_REQUEST_INVALID") {
        toast(t("publication.schedule_invalid"), "error");
      } else {
        const code = caught instanceof ApiError ? caught.code : "UNKNOWN";
        toast(t("publication.schedule_failed", { code }), "error");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t("publication.schedule_dialog_title", { title: props.changeset.title })}
      wide={!props.single}
    >
      <div className="pcms-form-grid">
        <Field label={t("publication.start_date_label")}>
          <Input
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
        </Field>
        <Field label={t("publication.start_time_label")}>
          <Input
            type="time"
            value={startTime}
            onChange={(event) => setStartTime(event.target.value)}
          />
        </Field>
        {props.single ? null : (
          <>
            <Field label={t("publication.batch_size_label")}>
              <Input
                inputMode="numeric"
                value={batchSize}
                onChange={(event) => setBatchSize(event.target.value)}
              />
            </Field>
            <Field label={t("publication.interval_label")}>
              <div className="pcms-ref">
                <Input
                  inputMode="numeric"
                  value={intervalValue}
                  onChange={(event) => setIntervalValue(event.target.value)}
                  style={{ width: "5rem" }}
                />
                <Select
                  value={intervalUnit}
                  onChange={(event) => setIntervalUnit(event.target.value)}
                >
                  <option value="minutes">{t("publication.unit_minutes")}</option>
                  <option value="hours">{t("publication.unit_hours")}</option>
                  <option value="days">{t("publication.unit_days")}</option>
                </Select>
              </div>
            </Field>
            <Field label={t("publication.on_failure_label")}>
              <Select
                value={failurePolicy}
                onChange={(event) => setFailurePolicy(event.target.value)}
              >
                <option value="continue">{t("publication.failure_continue")}</option>
                <option value="pause_batch">{t("publication.failure_pause_batch")}</option>
                <option value="pause_plan">{t("publication.failure_pause_plan")}</option>
              </Select>
            </Field>
          </>
        )}
      </div>
      {props.single ? (
        <p className="pcms-field__hint">{t("publication.schedule_tz_hint", { tz: timezone })}</p>
      ) : null}
      <div className="pcms-actions-row">
        {props.single ? null : (
          <Button disabled={busy} onClick={() => void preview()}>
            {t("publication.show_exact_schedule")}
          </Button>
        )}
        <Button
          variant="primary"
          disabled={busy || (!props.single && timeline === null)}
          onClick={() => void schedule()}
        >
          {props.single ? t("publication.pending_schedule") : t("publication.commit_schedule")}
        </Button>
      </div>
      {timeline === null ? null : (
        <div className="pcms-panel" data-testid="plan-timeline">
          <h3>{t("publication.exact_schedule_title")}</h3>
          <ol>
            {timeline.map((entry) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: schedule entries can repeat per item
              <li key={`${entry.changesetItemId}-${String(entry.publishAt)}`}>
                {entry.publishAt === null ? "—" : formatDateTime(entry.publishAt)}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Dialog>
  );
}

// ---- Import Publication Bundle (ADR-0014, Admin spec §70.6) ----

interface BundleIngestWire {
  readonly ingest_id: string;
  readonly bundle_id: string;
  readonly stage: string;
  readonly outcome: string | null;
  readonly error_code: string | null;
  readonly safe_error_detail: {
    readonly diagnostics?: readonly {
      readonly code: string;
      readonly path: string;
      readonly message: string;
    }[];
  } | null;
  readonly result: {
    readonly entries?: readonly unknown[];
    readonly media?: readonly unknown[];
    readonly changeset_id?: string;
  } | null;
}

const PCPUB_MIME = "application/vnd.progressive-cms.pcpub+zip";

function ImportBundleTab() {
  const auth = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<{
    readonly ok: boolean;
    readonly issues: readonly {
      readonly code: string;
      readonly path: string;
      readonly message: string;
    }[];
  } | null>(null);
  const [ingest, setIngest] = useState<BundleIngestWire | null>(null);

  if (!auth.can("content.create")) {
    return <EmptyState title={t("publication.bundle_forbidden")} />;
  }

  const pick = (input: HTMLInputElement | null): void => {
    setFile(input?.files?.[0] ?? null);
    setPreflight(null);
    setIngest(null);
    setMessage(null);
  };

  const validate = async (): Promise<void> => {
    if (file === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await apiRequest<{
        ok: boolean;
        issues: { code: string; path: string; message: string }[];
      }>("POST", "/bundles/pcpub?mode=validate", {
        rawBody: file,
        headers: { "content-type": PCPUB_MIME },
      });
      setPreflight(result);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (file === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const received = await apiRequest<{ ingest_id: string }>("POST", "/bundles/pcpub", {
        rawBody: file,
        headers: { "content-type": PCPUB_MIME },
      });
      // Poll to a terminal outcome (bounded).
      const deadline = Date.now() + 5 * 60 * 1000;
      for (;;) {
        const status = await apiGet<BundleIngestWire>(
          `/bundles/pcpub/ingests/${encodeURIComponent(received.ingest_id)}`,
        );
        setIngest(status);
        if (status.outcome !== null || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const diagnostics = ingest?.safe_error_detail?.diagnostics ?? preflight?.issues ?? [];
  return (
    <div className="pcms-stack" style={{ maxWidth: 720 }}>
      <Field label={t("publication.bundle_file")}>
        <input
          type="file"
          accept=".pcpub"
          data-testid="bundle-file-input"
          onChange={(event) => pick(event.currentTarget)}
        />
      </Field>
      <div style={{ display: "flex", gap: 8 }}>
        <Button disabled={busy || file === null} onClick={() => void validate()}>
          {t("publication.bundle_validate")}
        </Button>
        <Button variant="primary" disabled={busy || file === null} onClick={() => void submit()}>
          {t("publication.bundle_submit")}
        </Button>
      </div>
      {message !== null ? (
        <p className="pcms-field__hint" role="alert">
          {message}
        </p>
      ) : null}
      {preflight !== null ? (
        <div data-testid="bundle-preflight">
          <Badge tone={preflight.ok ? "success" : "danger"}>
            {preflight.ok
              ? t("publication.bundle_preflight_ok")
              : t("publication.bundle_preflight_fail")}
          </Badge>
          {preflight.issues.slice(0, 20).map((issue) => (
            <p key={`${issue.code}:${issue.path}:${issue.message}`} className="pcms-field__hint">
              [{issue.code}] {issue.path}: {issue.message}
            </p>
          ))}
        </div>
      ) : null}
      {ingest !== null ? (
        <div data-testid="bundle-ingest-status">
          <p>
            {t("publication.bundle_stage")}: <strong>{ingest.stage}</strong>
            {ingest.outcome !== null ? (
              <>
                {" · "}
                {t("publication.bundle_outcome")}: <strong>{ingest.outcome}</strong>
              </>
            ) : null}
          </p>
          {diagnostics.slice(0, 20).map((issue) => (
            <p key={`${issue.code}:${issue.path}:${issue.message}`} className="pcms-field__hint">
              [{issue.code}] {issue.path}: {issue.message}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
