// Route tab (PCMS-ADMIN-T011; Admin spec §27): canonical URL, slug/path
// proposal, history and explicit change with a warning — URL math happens in
// M04 routing, the browser never computes paths.
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../../../api/client.js";
import { useAuth } from "../../../auth/AuthContext.js";
import { useToast } from "../../../design/toast.js";
import { Badge, Button, Field, Input, Spinner } from "../../../design/ui.js";
import { formatDateTime, t } from "../../../i18n/index.js";

interface EntryRouteWire {
  readonly site_id: string;
  readonly current: { readonly path: string; readonly is_home: boolean } | null;
  readonly proposal: string;
  readonly history: readonly {
    readonly old_path: string;
    readonly target_type: string | null;
    readonly status_code: number;
    readonly created_at: string;
    readonly retired_at: string | null;
  }[];
}

export function RouteTab(props: { readonly entryId: string }) {
  const auth = useAuth();
  const toast = useToast();
  const [view, setView] = useState<EntryRouteWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newPath, setNewPath] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    setError(null);
    apiGet<EntryRouteWire>(`/entries/${props.entryId}/route`)
      .then((result) => {
        setView(result);
        setNewPath(result.current?.path ?? result.proposal);
      })
      .catch(() => setError(t("route.load_failed")));
  }, [props.entryId]);

  useEffect(reload, [reload]);

  if (error !== null) {
    return (
      <div>
        <p>{error}</p>
        <Button onClick={reload}>{t("route.retry")}</Button>
      </div>
    );
  }
  if (view === null) return <Spinner />;

  const changeUnsaved = view.current !== null && newPath !== view.current.path;
  const canChange = auth.can("navigation.edit") && view.current !== null;

  const applyChange = async () => {
    setBusy(true);
    try {
      const result = await apiPost<{ old_path: string; new_path: string }>(
        `/entries/${props.entryId}/route/change`,
        { to_path: newPath, reason: t("route.change_reason") },
      );
      toast(
        t("route.changed_toast", { old_path: result.old_path, new_path: result.new_path }),
        "success",
      );
      setConfirming(false);
      reload();
    } catch {
      toast(t("route.change_failed_toast"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="route-tab" className="pcms-screen">
      <div className="pcms-toolbar">
        {view.current === null ? (
          <Badge>{t("route.badge_no_path")}</Badge>
        ) : view.current.is_home ? (
          <Badge tone="success">{t("route.badge_home")}</Badge>
        ) : (
          <Badge tone="accent">{view.current.path}</Badge>
        )}
        <span className="pcms-toolbar__spacer" />
      </div>

      <Field
        label={t("route.path_label")}
        hint={
          view.current === null
            ? t("route.hint_proposal", { proposal: view.proposal })
            : t("route.hint_after_publish")
        }
      >
        <Input
          value={newPath}
          onChange={(event) => setNewPath(event.target.value)}
          disabled={!canChange}
          maxLength={500}
        />
      </Field>
      {canChange ? (
        <div className="pcms-actions-row">
          <Button disabled={!changeUnsaved || busy} onClick={() => setConfirming(true)}>
            {t("route.change_button")}
          </Button>
          {changeUnsaved ? (
            <span className="pcms-field__error">{t("route.change_warning")}</span>
          ) : null}
        </div>
      ) : null}

      <h3>{t("route.history_title")}</h3>
      {view.history.length === 0 ? (
        <p className="pcms-text-muted">{t("route.history_empty")}</p>
      ) : (
        <div className="pcms-table-wrap">
          <table className="pcms-table">
            <thead>
              <tr>
                <th>{t("route.col_old")}</th>
                <th>{t("route.col_redirect")}</th>
                <th>{t("route.col_created")}</th>
                <th>{t("route.col_active")}</th>
              </tr>
            </thead>
            <tbody>
              {view.history.map((record) => (
                <tr key={`${record.old_path}-${record.created_at}`}>
                  <td>{record.old_path}</td>
                  <td>{record.status_code}</td>
                  <td>{formatDateTime(record.created_at)}</td>
                  <td>{record.retired_at === null ? t("route.yes") : t("route.no")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirming ? (
        <div className="pcms-panel" role="alertdialog" aria-label={t("route.confirm_dialog_label")}>
          <p>
            <strong>{t("route.confirm_question")}</strong> {t("route.confirm_body")}
          </p>
          <div className="pcms-actions-row">
            <Button variant="danger" disabled={busy} onClick={() => void applyChange()}>
              {t("route.confirm_action", { path: newPath })}
            </Button>
            <Button onClick={() => setConfirming(false)}>{t("route.cancel")}</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
