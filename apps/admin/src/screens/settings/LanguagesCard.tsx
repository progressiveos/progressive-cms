// Settings → Languages card (opt-in multilingual enablement, work package
// #17/#18). Gated by site.configure like the rest of the screen; enabling
// validates theme capability server-side and is audited.
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPut } from "../../api/client.js";
import { useToast } from "../../design/toast.js";
import { Button, Card, Field, Input, Select, Spinner } from "../../design/ui.js";
import { errorText, t } from "../../i18n/index.js";

interface LocalizationWire {
  readonly enabled: boolean;
  readonly default_locale: string;
  readonly locales: readonly string[];
  readonly routing_strategy: string;
  readonly updated_at: string;
  readonly updated_by: string;
}

export function LanguagesCard() {
  const toast = useToast();
  const [state, setState] = useState<LocalizationWire | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [defaultLocale, setDefaultLocale] = useState("");
  const [locales, setLocales] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const wire = await apiGet<LocalizationWire>("/localization");
      setState(wire);
      setEnabled(wire.enabled);
      setDefaultLocale(wire.default_locale);
      setLocales(wire.locales.join(", "));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === null) {
    return error === null ? (
      <Spinner />
    ) : (
      <Card title={t("localization.locales_title")}>
        <p role="alert">{error}</p>
      </Card>
    );
  }

  const parsedLocales = locales
    .split(",")
    .map((code) => code.trim())
    .filter((code) => code.length > 0);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPut("/localization", {
        enabled,
        default_locale: defaultLocale,
        locales: parsedLocales,
      });
      await load();
      toast(t("localization.saved_toast"), "success");
    } catch (cause) {
      const code = (cause as { code?: string }).code ?? "";
      setError(errorText(code) ?? (cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t("localization.locales_title")} data-testid="languages-card">
      <div className="pcms-stack">
        <Field label={t("localization.mode")}>
          <Select
            value={enabled ? "multi" : "single"}
            onChange={(event) => setEnabled(event.target.value === "multi")}
          >
            <option value="single">{t("localization.mode_single")}</option>
            <option value="multi">{t("localization.mode_multiple")}</option>
          </Select>
        </Field>
        {enabled && (
          <>
            <Field label={t("localization.default_locale")}>
              <Select
                value={defaultLocale}
                onChange={(event) => setDefaultLocale(event.target.value)}
              >
                {parsedLocales.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("localization.enabled_locales")}>
              <Input value={locales} onChange={(event) => setLocales(event.target.value)} />
            </Field>
            <p className="pcms-text-muted">{t("localization.default_prefix_note")}</p>
          </>
        )}
        {state.enabled && !enabled && (
          <p className="pcms-text-muted">
            {t("localization.enabled_locales_display")}: {state.locales.join(", ")}
          </p>
        )}
        {error !== null && (
          <p role="alert" className="pcms-text-muted">
            {error}
          </p>
        )}
        <div className="pcms-row">
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {t("save")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
