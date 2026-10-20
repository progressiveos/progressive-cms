// Revisions tab (PCMS-ADMIN-T008; Admin spec §24/§25; redesign spec §22):
// human revision states ("Ready to publish" for sealed, with a definition
// tooltip), current-published marker, semantic diff viewer, "create draft
// from" and permission-gated rollback with an explicit confirm — rollback
// re-points the live publication immediately (no new revision is created).
import { useEffect, useState } from "react";
import { useBootstrap } from "../../../api/bootstrap.js";
import { apiDelete, apiGet, apiPost } from "../../../api/client.js";
import { useAuth } from "../../../auth/AuthContext.js";
import { ConfirmDialog, Dialog } from "../../../design/dialog.js";
import { Popover } from "../../../design/popover.js";
import { useToast } from "../../../design/toast.js";
import { Tooltip } from "../../../design/tooltip.js";
import { Badge, Button, EmptyState, Icon, Spinner, StatusBadge } from "../../../design/ui.js";
import { formatDateTime, t } from "../../../i18n/index.js";

interface RevisionRow {
  readonly id: string;
  readonly revision_no: number;
  readonly state: "WORKING" | "SEALED";
  readonly created_at: string;
  readonly sealed_at: string | null;
}

interface PublicationWire {
  readonly state: "PUBLISHED" | "UNPUBLISHED";
  readonly current_revision_id: string | null;
}

interface DiffWire {
  readonly fieldsChanged: readonly { path: string; from: unknown; to: unknown }[];
  readonly fieldsAdded: readonly { path: string; value: unknown }[];
  readonly fieldsRemoved: readonly { path: string; value: unknown }[];
  readonly blocksAdded: readonly { id: string; type: string }[];
  readonly blocksRemoved: readonly { id: string; type: string }[];
  readonly blocksMoved: readonly { id: string; from: number; to: number }[];
  readonly blocksChanged: readonly { id: string; type: string }[];
  readonly relationsChanged: readonly { path: string; from: unknown; to: unknown }[];
}

function short(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value === "" ? "—" : value;
  return JSON.stringify(value);
}

/** Site-developer report 2026-09-29: a sealed revision can sit unpublished
 * for days with no signal anywhere in the Admin. A day is editorial judgment,
 * not a contract. */
function isStaleUnpublished(row: {
  state: "WORKING" | "SEALED";
  sealed_at: string | null;
}): boolean {
  if (row.state !== "SEALED" || row.sealed_at === null) return false;
  const sealedAt = Date.parse(row.sealed_at);
  return Number.isFinite(sealedAt) && Date.now() - sealedAt > 24 * 60 * 60 * 1000;
}

function SealedBadge() {
  return (
    <Tooltip content={t("revision_sealed_definition")}>
      <StatusBadge tone="violet" icon="lock">
        {t("revision_ready")}
      </StatusBadge>
    </Tooltip>
  );
}

export function RevisionsTab(props: {
  readonly entryId: string;
  readonly onDraftChanged: (revisionId: string) => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const bootstrap = useBootstrap();
  const [rows, setRows] = useState<readonly RevisionRow[] | null>(null);
  const [published, setPublished] = useState<PublicationWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffWire | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<RevisionRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RevisionRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [menuRow, setMenuRow] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);

  // Bumped by destructive actions (revision delete) to refetch in place.
  const [reloadTick, setReloadTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick refreshes the list after explicit revision actions.
  useEffect(() => {
    setRows(null);
    apiGet<{ items: readonly RevisionRow[] }>(`/entries/${props.entryId}/revisions?limit=100`)
      .then((result) => setRows([...result.items].reverse()))
      .catch(() => setError(t("revisions_load_failed")));
    apiGet<PublicationWire>(`/publications/entry/${props.entryId}`)
      .then(setPublished)
      .catch(() => setPublished(null));
  }, [props.entryId, reloadTick]);

  const showDiff = async (fromId: string, toId: string) => {
    try {
      const result = await apiGet<{ diff: DiffWire }>(`/revisions/${fromId}/diff/${toId}`);
      const empty = result.diff.blocksAdded === undefined;
      setDiff(
        empty
          ? {
              ...result.diff,
              blocksAdded: [],
              blocksRemoved: [],
              blocksMoved: [],
              blocksChanged: [],
              relationsChanged: [],
            }
          : result.diff,
      );
    } catch {
      toast(t("diff_failed"), "error");
    }
  };

  const createDraftFrom = async (revisionId: string) => {
    try {
      const result = await apiPost<{ revision_id: string }>(`/entries/${props.entryId}/draft`, {
        from_revision_id: revisionId,
      });
      toast(t("draft_from_revision_done"), "success");
      props.onDraftChanged(result.revision_id);
    } catch {
      toast(t("draft_from_revision_failed"), "error");
    }
  };

  const runRollback = async () => {
    if (rollbackTarget === null) return;
    setRollbackBusy(true);
    setRollbackError(null);
    try {
      await apiPost("/publications/rollback", {
        entity_type: "entry",
        entity_id: props.entryId,
        target_revision_id: rollbackTarget.id,
      });
      setRollbackTarget(null);
      toast(t("rollback_done"), "success");
    } catch (caught) {
      setRollbackError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRollbackBusy(false);
    }
  };

  const runDelete = async () => {
    if (deleteTarget === null) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await apiDelete(`/revisions/${encodeURIComponent(deleteTarget.id)}`);
      setDeleteTarget(null);
      toast(t("revisions_delete_done"), "success");
      setReloadTick((tick) => tick + 1);
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDeleteBusy(false);
    }
  };

  if (error !== null) return <EmptyState title={error} />;
  if (rows === null) return <Spinner />;
  if (rows.length === 0) return <EmptyState title={t("revisions_empty")} />;

  const environment =
    bootstrap === null
      ? null
      : bootstrap.environment.classification === "production"
        ? t("env_production")
        : t("env_development");

  return (
    <div>
      <div className="pcms-table-wrap">
        <table className="pcms-table" data-testid="revisions-table">
          <thead>
            <tr>
              <th>{t("revisions_col_no")}</th>
              <th>{t("revisions_col_state")}</th>
              <th>{t("revisions_col_created")}</th>
              <th>{t("revisions_col_sealed")}</th>
              <th>{t("revisions_col_actions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const previous = index > 0 ? rows[index - 1] : undefined;
              const isCurrentPublished = published?.current_revision_id === row.id;
              return (
                <tr key={row.id}>
                  <td>
                    {row.revision_no}
                    {isCurrentPublished ? (
                      <>
                        {" "}
                        <Badge tone="success">{t("revisions_current")}</Badge>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {row.state === "WORKING" ? (
                      <StatusBadge tone="info" icon="edit">
                        {t("revision_draft")}
                      </StatusBadge>
                    ) : (
                      <>
                        <SealedBadge />{" "}
                        {!isCurrentPublished && isStaleUnpublished(row) ? (
                          <span title={t("revisions_sealed_unpublished_hint")}>
                            <Badge tone="warning">{t("revisions_sealed_unpublished")}</Badge>
                          </span>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td>{formatDateTime(row.created_at)}</td>
                  <td>{row.sealed_at === null ? "—" : formatDateTime(row.sealed_at)}</td>
                  <td className="pcms-actions-row pcms-revisions-actions">
                    {previous === undefined ? null : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void showDiff(previous.id, row.id)}
                      >
                        {t("revisions_compare")}
                      </Button>
                    )}
                    <span className="pcms-menu-wrap">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-haspopup="menu"
                        aria-label={t("tree_actions")}
                        onClick={(event) => {
                          const anchor = event.currentTarget;
                          setMenuAnchor(anchor);
                          setMenuRow(menuRow === row.id ? null : row.id);
                        }}
                      >
                        <Icon name="menu" />
                      </Button>
                      {menuRow === row.id && menuAnchor !== null ? (
                        <Popover
                          open
                          onClose={() => setMenuRow(null)}
                          anchor={menuAnchor}
                          align="end"
                        >
                          <div role="menu" aria-label={t("tree_actions")}>
                            {row.state === "SEALED" ? (
                              <button
                                type="button"
                                role="menuitem"
                                className="pcms-menu__item"
                                onClick={() => {
                                  setMenuRow(null);
                                  void createDraftFrom(row.id);
                                }}
                              >
                                <Icon name="duplicate" /> {t("revisions_draft_from")}
                              </button>
                            ) : null}
                            {row.state === "SEALED" && auth.can("publication.rollback") ? (
                              <button
                                type="button"
                                role="menuitem"
                                className="pcms-menu__item pcms-menu__item--danger"
                                onClick={() => {
                                  setMenuRow(null);
                                  setRollbackError(null);
                                  setRollbackTarget(row);
                                }}
                              >
                                <Icon name="history" /> {t("revisions_rollback")}
                              </button>
                            ) : null}
                            {!isCurrentPublished && auth.can("content.edit") ? (
                              <button
                                type="button"
                                role="menuitem"
                                className="pcms-menu__item pcms-menu__item--danger"
                                onClick={() => {
                                  setMenuRow(null);
                                  setDeleteError(null);
                                  setDeleteTarget(row);
                                }}
                              >
                                <Icon name="delete" /> {t("revisions_delete")}
                              </button>
                            ) : null}
                          </div>
                        </Popover>
                      ) : null}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Dialog open={diff !== null} onClose={() => setDiff(null)} title={t("diff_title")} wide>
        {diff === null ? null : (
          <div className="pcms-diff">
            {diff.fieldsChanged.map((entry) => (
              <p key={`c-${entry.path}`} className="pcms-diff__changed">
                <strong>{entry.path}</strong>: {short(entry.from)} → {short(entry.to)}
              </p>
            ))}
            {diff.fieldsAdded.map((entry) => (
              <p key={`a-${entry.path}`} className="pcms-diff__added">
                <strong>{entry.path}</strong>: {t("diff_added")} ({short(entry.value)})
              </p>
            ))}
            {diff.fieldsRemoved.map((entry) => (
              <p key={`r-${entry.path}`} className="pcms-diff__removed">
                <strong>{entry.path}</strong>: {t("diff_removed")} ({t("diff_was")}{" "}
                {short(entry.value)})
              </p>
            ))}
            {diff.blocksAdded.map((block) => (
              <p key={`ba-${block.id}`} className="pcms-diff__added">
                {t("diff_block")} «{block.type}»: {t("diff_added")}
              </p>
            ))}
            {diff.blocksRemoved.map((block) => (
              <p key={`br-${block.id}`} className="pcms-diff__removed">
                {t("diff_block")} «{block.type}»: {t("diff_removed")}
              </p>
            ))}
            {diff.blocksMoved.map((block) => (
              <p key={`bm-${block.id}`} className="pcms-diff__changed">
                {t("diff_block")}: {t("diff_moved")} {block.from + 1} → {block.to + 1}
              </p>
            ))}
            {diff.blocksChanged.map((block) => (
              <p key={`bc-${block.id}`} className="pcms-diff__changed">
                {t("diff_block")} «{block.type}»: {t("diff_content_changed")}
              </p>
            ))}
            {diff.relationsChanged.map((entry) => (
              <p key={`rel-${entry.path}`} className="pcms-diff__changed">
                <strong>{entry.path}</strong>: {short(entry.from)} → {short(entry.to)}
              </p>
            ))}
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={rollbackTarget !== null}
        onClose={() => {
          setRollbackTarget(null);
          setRollbackError(null);
        }}
        onConfirm={() => void runRollback()}
        title={t("rollback_confirm_title")}
        body={t("rollback_confirm_body")}
        details={
          rollbackTarget === null
            ? []
            : [
                { label: t("rollback_confirm_version"), value: `№ ${rollbackTarget.revision_no}` },
                ...(environment === null
                  ? []
                  : [{ label: t("rollback_confirm_env"), value: environment }]),
              ]
        }
        confirmLabel={t("rollback_confirm_action")}
        tone="danger"
        busy={rollbackBusy}
        error={rollbackError}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => {
          setDeleteTarget(null);
          setDeleteError(null);
        }}
        onConfirm={() => void runDelete()}
        title={t("revisions_delete_confirm_title")}
        body={t("revisions_delete_confirm_body")}
        details={
          deleteTarget === null
            ? []
            : [{ label: t("rollback_confirm_version"), value: `№ ${deleteTarget.revision_no}` }]
        }
        confirmLabel={t("revisions_delete_confirm_action")}
        tone="danger"
        busy={deleteBusy}
        error={deleteError}
      />
    </div>
  );
}
