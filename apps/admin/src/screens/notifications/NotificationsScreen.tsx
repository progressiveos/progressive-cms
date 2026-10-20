// Notifications settings (owner brief 2026-10-07): per-category recipient
// routing to SITE USERS (never free-form addresses), MODX-style per-form
// overrides (departments), system events route to admins via their own
// account-menu subscriptions. Gated by integrations.read/configure — the
// delivery transport (managed SMTP) lives on the same screen family.
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPut } from "../../api/client.js";
import { useToast } from "../../design/toast.js";
import { Button, Card, ErrorPanel, Field, Input, Spinner, Switch } from "../../design/ui.js";
import { t } from "../../i18n/index.js";

type Category = "leads" | "forms" | "quizzes" | "system";

interface SettingsWire {
  readonly site_name: string;
  readonly recipients: Readonly<Record<Category, readonly string[]>>;
  readonly form_recipients: Readonly<Record<string, readonly string[]>>;
}

interface Candidate {
  readonly user_id: string;
  readonly display_name: string;
  readonly email: string;
  readonly roles: readonly string[];
}

interface SettingsPayload {
  readonly settings: SettingsWire;
  readonly candidates: readonly Candidate[];
  readonly forms: readonly { readonly id: string; readonly title: string }[];
}

const CATEGORY_KEYS: readonly Category[] = ["leads", "forms", "quizzes"];
const CATEGORY_LABEL_KEYS: Readonly<Record<Category, string>> = {
  leads: "notifications.cat_leads",
  forms: "notifications.cat_forms",
  quizzes: "notifications.cat_quizzes",
  system: "notifications.cat_system",
};

function RecipientPicker(props: {
  readonly candidates: readonly Candidate[];
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (userId: string) => void;
}) {
  if (props.candidates.length === 0) {
    return <p className="pcms-text-muted">{t("notifications.recipients_empty")}</p>;
  }
  return (
    <div className="pcms-recipient-picker">
      {props.candidates.map((candidate) => (
        <label key={candidate.user_id} className="pcms-recipient-picker__item">
          <input
            type="checkbox"
            checked={props.selected.has(candidate.user_id)}
            onChange={() => props.onToggle(candidate.user_id)}
          />
          <span>{candidate.display_name}</span>
          <span className="pcms-text-muted">{candidate.email}</span>
        </label>
      ))}
    </div>
  );
}

export function NotificationsScreen() {
  const toast = useToast();
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [siteName, setSiteName] = useState("");
  const [selected, setSelected] = useState<Record<Category, Set<string>>>({
    leads: new Set(),
    forms: new Set(),
    quizzes: new Set(),
    system: new Set(),
  });
  const [overrides, setOverrides] = useState<Record<string, readonly string[]>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    void apiGet<SettingsPayload>("/notifications/settings")
      .then((data) => {
        setPayload(data);
        setSiteName(data.settings.site_name);
        setSelected({
          leads: new Set(data.settings.recipients.leads ?? []),
          forms: new Set(data.settings.recipients.forms ?? []),
          quizzes: new Set(data.settings.recipients.quizzes ?? []),
          system: new Set(),
        });
        setOverrides(data.settings.form_recipients ?? {});
      })
      .catch((cause: Error) => setError(cause.message));
  }, []);
  useEffect(load, [load]);

  const toggle = (category: Category, userId: string) => {
    setSelected((current) => {
      const next = new Set(current[category]);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return { ...current, [category]: next };
    });
  };

  const save = () => {
    setSaving(true);
    const formRecipients: Record<string, string[]> = {};
    for (const [formId, list] of Object.entries(overrides)) {
      if (list !== null && list.length > 0) formRecipients[formId] = [...list];
    }
    void apiPut("/notifications/settings", {
      settings: {
        site_name: siteName,
        recipients: {
          leads: [...selected.leads],
          forms: [...selected.forms],
          quizzes: [...selected.quizzes],
          system: [],
        },
        form_recipients: formRecipients,
      },
    })
      .then(() => toast(t("notifications.saved"), "success"))
      .catch((cause: Error) =>
        toast(`${t("notifications.save_failed")}: ${cause.message}`, "error"),
      )
      .finally(() => setSaving(false));
  };

  if (error !== null) {
    return <ErrorPanel title={t("notifications.load_failed")} message={error} />;
  }
  if (payload === null) {
    return <Spinner label={t("loading")} />;
  }

  const candidates = payload.candidates;

  return (
    <div className="pcms-screen">
      <p className="pcms-text-muted">{t("notifications.screen_hint")}</p>

      <Card title={t("notifications.site_name_label")}>
        <Field label={t("notifications.site_name_label")} hint={t("notifications.site_name_hint")}>
          <Input
            value={siteName}
            onChange={(event) => setSiteName(event.target.value)}
            maxLength={120}
          />
        </Field>
      </Card>

      {CATEGORY_KEYS.map((category) => (
        <Card key={category} title={t(CATEGORY_LABEL_KEYS[category])}>
          <Field
            label={t("notifications.recipients_label")}
            hint={t("notifications.recipients_hint")}
          >
            <RecipientPicker
              candidates={candidates}
              selected={selected[category]}
              onToggle={(userId) => toggle(category, userId)}
            />
          </Field>
        </Card>
      ))}

      <Card title={t("notifications.cat_system")}>
        <p className="pcms-text-muted">{t("notifications.cat_system_hint")}</p>
      </Card>

      <Card title={t("notifications.forms_override_title")}>
        <p className="pcms-text-muted">{t("notifications.forms_override_hint")}</p>
        {payload.forms.length === 0 ? (
          <p className="pcms-text-muted">{t("notifications.forms_empty")}</p>
        ) : (
          <div className="pcms-form-overrides">
            {payload.forms.map((form) => {
              const current = overrides[form.id] ?? null;
              const hasOverride = current !== null;
              return (
                <div key={form.id} className="pcms-form-overrides__row">
                  <div className="pcms-form-overrides__head">
                    <span>{form.title}</span>
                    <Switch
                      checked={hasOverride}
                      label={t("notifications.override_toggle")}
                      onChange={(checked) => {
                        setOverrides((currentOverrides) => {
                          const next = { ...currentOverrides };
                          if (checked) next[form.id] = [...selected.forms];
                          else delete next[form.id];
                          return next;
                        });
                      }}
                    />
                  </div>
                  {hasOverride ? (
                    <RecipientPicker
                      candidates={candidates}
                      selected={new Set(current ?? [])}
                      onToggle={(userId) => {
                        setOverrides((currentOverrides) => {
                          const set = new Set(currentOverrides[form.id] ?? []);
                          if (set.has(userId)) set.delete(userId);
                          else set.add(userId);
                          return { ...currentOverrides, [form.id]: [...set] };
                        });
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <div className="pcms-screen__actions">
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {t("notifications.save")}
        </Button>
      </div>
    </div>
  );
}
