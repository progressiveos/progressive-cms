// Admin Maintenance Mode screen (PCMS-OPS-T118; redesign spec §11).
// The SPA is a thin client of /api/v1: the server stays the authorization
// authority (site.maintenance) and every toggle is audited server-side.
// Toggling runs through the shared ConfirmDialog and waits for the server —
// no optimistic state (redesign §3.1/§11.5).
import { useCallback, useEffect, useState } from "react";
import { useBootstrap } from "../../api/bootstrap.js";
import { apiGet, apiPut } from "../../api/client.js";
import { ConfirmDialog } from "../../design/dialog.js";
import { Badge, Button, Card, ErrorPanel, Spinner } from "../../design/ui.js";
import { t } from "../../i18n/index.js";

interface MaintenanceWire {
  readonly configured: boolean;
  readonly enabled?: boolean;
  readonly title?: string;
  readonly message?: string;
  readonly promo_label?: string;
  readonly promo_url?: string;
  readonly retry_after_seconds?: number;
  readonly updated_at?: string;
  readonly updated_by?: string;
}

export function MaintenanceScreen() {
  const bootstrap = useBootstrap();
  const [state, setState] = useState<MaintenanceWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<boolean | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      // GET /maintenance returns the flat MaintenanceWire (OpenAPI contract).
      const response = await apiGet<MaintenanceWire>("/maintenance");
      setState(response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (body: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    setPendingError(null);
    try {
      setError(null);
      const response = await apiPut<MaintenanceWire>("/maintenance", body);
      setState(response);
      setPending(null);
    } catch (cause) {
      setPendingError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (state === null && error === null) {
    return <Spinner label={t("loading")} />;
  }

  const environment =
    bootstrap === null
      ? null
      : bootstrap.environment.classification === "production"
        ? t("env_production")
        : t("env_development");

  return (
    <section aria-labelledby="maintenance-heading">
      <h2 id="maintenance-heading">{t("maintenance_screen_title")}</h2>
      {error !== null ? <ErrorPanel message={error} /> : null}
      {state === null ? null : (
        <>
          <Card title={t("maintenance_screen_state")}>
            <p>
              {t("maintenance_screen_public")}:{" "}
              {state.enabled === true ? (
                <Badge tone="warning">{t("maintenance_badge_on")}</Badge>
              ) : (
                <Badge tone="success">{t("maintenance_badge_off")}</Badge>
              )}
            </p>
            {state.updated_at !== undefined ? (
              <p className="muted">
                {t("maintenance_changed")}: {state.updated_at} ({state.updated_by})
              </p>
            ) : null}
            <p>
              <Button
                variant={state.enabled === true ? "primary" : "danger"}
                disabled={busy}
                onClick={() => {
                  setPendingError(null);
                  setPending(state.enabled !== true);
                }}
              >
                {state.enabled === true
                  ? t("maintenance_disable_action")
                  : t("maintenance_enable_action")}
              </Button>
            </p>
          </Card>
          {state.enabled !== true ? null : (
            <Card title={t("maintenance_visitors_title")}>
              <p className="muted">{t("maintenance_visitors_text")}</p>
              <h3>{state.title}</h3>
              <p style={{ whiteSpace: "pre-line" }}>{state.message}</p>
              <p>
                <span className="muted">{t("maintenance_promo_link")}: </span>
                {state.promo_url} ({state.promo_label})
              </p>
            </Card>
          )}
          <ConfirmDialog
            open={pending !== null}
            onClose={() => {
              setPending(null);
              setPendingError(null);
            }}
            onConfirm={() => void save({ enabled: pending })}
            title={
              pending === true
                ? t("maintenance_enable_confirm_title")
                : t("maintenance_disable_confirm_title")
            }
            body={
              pending === true
                ? t("maintenance_enable_confirm_body")
                : t("maintenance_disable_confirm_body")
            }
            details={
              environment === null ? [] : [{ label: t("publish_confirm_env"), value: environment }]
            }
            confirmLabel={
              pending === true ? t("maintenance_enable_action") : t("maintenance_disable_action")
            }
            tone={pending === true ? "primary" : "danger"}
            busy={busy}
            error={pendingError}
          />
        </>
      )}
    </section>
  );
}
