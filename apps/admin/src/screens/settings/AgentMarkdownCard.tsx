import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPut } from "../../api/client.js";
import { useAuth } from "../../auth/AuthContext.js";
import { useToast } from "../../design/toast.js";
import { Button, Card, Spinner } from "../../design/ui.js";
import { t } from "../../i18n/index.js";

interface MarkdownSettingsWire {
  readonly enabled: boolean;
  readonly generation: number;
}

export function AgentMarkdownCard() {
  const auth = useAuth();
  const toast = useToast();
  const [settings, setSettings] = useState<MarkdownSettingsWire | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    setFailed(false);
    apiGet<MarkdownSettingsWire>("/markdown/settings")
      .then(setSettings)
      .catch(() => setFailed(true));
  }, []);

  useEffect(reload, [reload]);

  if (failed) return <Button onClick={reload}>{t("seo.retry")}</Button>;
  if (settings === null) return <Spinner label={t("core.loading")} />;

  const save = async (enabled: boolean) => {
    setBusy(true);
    try {
      await apiPut("/markdown/settings", {
        enabled,
        expected_generation: settings.generation,
      });
      toast(t("markdown.global_saved"), "success");
      reload();
    } catch {
      toast(t("markdown.global_save_failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t("markdown.global_title")}>
      <p className="pcms-field__hint">{t("markdown.global_hint")}</p>
      <label className="pcms-check">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={busy || !auth.can("seo.site_settings")}
          onChange={(event) => void save(event.target.checked)}
        />
        {t("markdown.global_enabled")}
      </label>
    </Card>
  );
}
