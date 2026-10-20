// ЛК dialog (owner brief 2026-10-07): every admin picks what the engine
// e-mails them — per-category opt-outs plus immediate/digest cadence.
// Defaults: everything enabled, delivered immediately.
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPut } from "../../api/client.js";
import { Dialog } from "../../design/dialog.js";
import { useToast } from "../../design/toast.js";
import { Button, Field, Select, Spinner, Switch } from "../../design/ui.js";
import { t } from "../../i18n/index.js";

type Category = "leads" | "forms" | "quizzes" | "system";

const CATEGORIES: readonly { readonly key: Category; readonly labelKey: string }[] = [
  { key: "leads", labelKey: "notifications.cat_leads" },
  { key: "forms", labelKey: "notifications.cat_forms" },
  { key: "quizzes", labelKey: "notifications.cat_quizzes" },
  { key: "system", labelKey: "notifications.cat_system" },
];

const DIGEST_OPTIONS: readonly { readonly value: number; readonly labelKey: string }[] = [
  { value: 0, labelKey: "notifications.prefs_digest_immediate" },
  { value: 60, labelKey: "notifications.prefs_digest_1h" },
  { value: 180, labelKey: "notifications.prefs_digest_3h" },
  { value: 360, labelKey: "notifications.prefs_digest_6h" },
  { value: 720, labelKey: "notifications.prefs_digest_12h" },
];

export function NotificationPrefsDialog(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly isUser: boolean;
}) {
  const toast = useToast();
  const [disabled, setDisabled] = useState<Set<Category>>(new Set());
  const [digest, setDigest] = useState(0);
  const [locale, setLocale] = useState<"ru" | "en">("ru");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    if (!props.open) return;
    void apiGet<{ disabled: Category[]; digest_minutes: number }>("/notifications/subscriptions")
      .then((data) => {
        setDisabled(new Set(data.disabled ?? []));
        setDigest(data.digest_minutes ?? 0);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [props.open]);
  useEffect(load, [load]);

  const save = () => {
    setSaving(true);
    void apiPut("/notifications/subscriptions", {
      disabled: [...disabled],
      digest_minutes: digest,
      locale,
    })
      .then(() => {
        toast(t("notifications.prefs_saved"), "success");
        props.onClose();
      })
      .catch((cause: Error) =>
        toast(`${t("notifications.prefs_failed")}: ${cause.message}`, "error"),
      )
      .finally(() => setSaving(false));
  };

  return (
    <Dialog open={props.open} onClose={props.onClose} title={t("notifications.prefs_title")}>
      {props.isUser ? null : (
        <p className="pcms-field__hint">{t("notifications.prefs_user_only")}</p>
      )}
      <p className="pcms-field__hint">{t("notifications.prefs_hint")}</p>
      {!props.isUser || !loaded ? (
        <Spinner />
      ) : (
        <>
          {CATEGORIES.map((category) => (
            <Switch
              key={category.key}
              checked={!disabled.has(category.key)}
              label={t(category.labelKey)}
              onChange={(checked) => {
                setDisabled((current) => {
                  const next = new Set(current);
                  if (checked) next.delete(category.key);
                  else next.add(category.key);
                  return next;
                });
              }}
            />
          ))}
          <Field label={t("notifications.prefs_language")}>
            <Select
              value={locale}
              onChange={(event) => setLocale(event.target.value as "ru" | "en")}
            >
              <option value="ru">{t("notifications.prefs_language_ru")}</option>
              <option value="en">{t("notifications.prefs_language_en")}</option>
            </Select>
          </Field>
          <Field label={t("notifications.prefs_digest_label")}>
            <Select
              value={String(digest)}
              onChange={(event) => setDigest(Number(event.target.value))}
            >
              {DIGEST_OPTIONS.map((option) => (
                <option key={option.value} value={String(option.value)}>
                  {t(option.labelKey)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="pcms-dialog__footer">
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {t("save")}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
