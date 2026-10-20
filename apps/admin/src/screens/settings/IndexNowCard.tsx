// IndexNow settings card (Progressive_CMS_IndexNow_v1_Spec.md §24/§25).
// Site-level, DISABLED by default; enabling generates the key automatically
// and queues at most one homepage verification. Statuses never claim
// indexing — HTTP 200/202 mean the notification was accepted.
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, apiPut } from "../../api/client.js";
import { useToast } from "../../design/toast.js";
import { Badge, Button, Card, Field, Spinner } from "../../design/ui.js";
import { t } from "../../i18n/index.js";

interface IndexNowWire {
  readonly settings: {
    readonly enabled: boolean;
    readonly notifyOnPublish: boolean;
    readonly notifyOnUpdate: boolean;
    readonly notifyOnUnpublish: boolean;
    readonly notifyOnRouteChange: boolean;
  };
  readonly generation: number;
  readonly keyFileUrl: string | null;
  readonly state: string;
  readonly status: {
    readonly lastAttemptAt: string | null;
    readonly lastSuccessAt: string | null;
    readonly lastHttpStatus: number | null;
    readonly lastBatchSize: number | null;
    readonly lastDiagnostic: string | null;
  };
}

interface StatusWire {
  readonly state: string;
  readonly key_file_url: string | null;
  readonly pending_url_count: number;
  readonly checks: readonly { code: string; ok: boolean; severity: string }[];
}

const STATE_TONE: Record<string, "neutral" | "success" | "warning" | "danger"> = {
  Disabled: "neutral",
  Configured: "neutral",
  Operational: "success",
  "Awaiting verification": "warning",
  "Rate limited": "warning",
  "Configuration error": "danger",
  "Delivery degraded": "warning",
  "Suppressed by noindex": "warning",
};

export function IndexNowCard() {
  const toast = useToast();
  const [wire, setWire] = useState<IndexNowWire | null>(null);
  const [status, setStatus] = useState<StatusWire | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const [settings, statusData] = await Promise.all([
      apiGet<IndexNowWire>("/seo/indexnow"),
      apiGet<StatusWire>("/seo/indexnow/status"),
    ]);
    setWire(settings);
    setStatus(statusData);
  }, []);

  useEffect(() => {
    reload().catch(() => {});
  }, [reload]);

  if (wire === null || status === null) return <Spinner label={t("core.loading")} />;

  const save = async (enabled: boolean) => {
    setBusy(true);
    try {
      await apiPut("/seo/indexnow", {
        settings: {
          enabled,
          notifyOnPublish: wire.settings.notifyOnPublish,
          notifyOnUpdate: wire.settings.notifyOnUpdate,
          notifyOnUnpublish: wire.settings.notifyOnUnpublish,
          notifyOnRouteChange: wire.settings.notifyOnRouteChange,
        },
        expected_generation: wire.generation,
      });
      await reload();
      toast(t(enabled ? "indexnow.enabled_toast" : "indexnow.disabled_toast"), "success");
    } catch (error) {
      toast(
        error instanceof Error
          ? `${t("indexnow.save_failed")}: ${error.message}`
          : t("indexnow.save_failed"),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    setBusy(true);
    try {
      await apiPost("/seo/indexnow/rotate-key", {});
      await reload();
      toast(t("indexnow.rotated_toast"), "success");
    } catch {
      toast(t("indexnow.save_failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setBusy(true);
    try {
      const result = await apiPost<{ queued: boolean }>("/seo/indexnow/check", {});
      await reload();
      toast(t(result.queued ? "indexnow.check_queued" : "indexnow.check_suppressed"), "success");
    } catch {
      toast(t("indexnow.save_failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t("indexnow.card_title")}>
      <p className="pcms-field__hint">{t("indexnow.card_hint")}</p>
      <div className="pcms-field-row">
        <Badge tone={STATE_TONE[wire.state] ?? "neutral"}>{wire.state}</Badge>
        {status.pending_url_count > 0 ? (
          <Badge tone="neutral">{t("indexnow.pending", { count: status.pending_url_count })}</Badge>
        ) : null}
      </div>
      <label className="pcms-check">
        <input
          type="checkbox"
          checked={wire.settings.enabled}
          disabled={busy}
          onChange={(event) => void save(event.target.checked)}
        />
        {t("indexnow.enable")}
      </label>
      {wire.settings.enabled ? (
        <>
          {wire.keyFileUrl !== null ? (
            <Field label={t("indexnow.key_file_label")} hint={t("indexnow.key_file_hint")}>
              <code>{wire.keyFileUrl}</code>
            </Field>
          ) : null}
          <div className="pcms-field-row">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void check()}>
              {t("indexnow.check_button")}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void rotate()}>
              {t("indexnow.rotate_button")}
            </Button>
          </div>
          {wire.status.lastSuccessAt !== null ? (
            <p className="pcms-field__hint">
              {t("indexnow.last_success", {
                at: wire.status.lastSuccessAt,
                status: String(wire.status.lastHttpStatus ?? ""),
                count: String(wire.status.lastBatchSize ?? 0),
              })}
            </p>
          ) : null}
          {wire.status.lastDiagnostic !== null ? (
            <p className="pcms-field__hint">{wire.status.lastDiagnostic}</p>
          ) : null}
          {status.checks
            .filter((check) => !check.ok)
            .map((check) => (
              <p className="pcms-field__hint" key={check.code}>
                {check.code}
              </p>
            ))}
          <p className="pcms-field__hint">{t("indexnow.no_guarantee_note")}</p>
        </>
      ) : null}
    </Card>
  );
}
