// Analytics & tagging settings (ADR-0016; Analytics spec §17/§18/§19).
// Provider cards over typed fields only — no arbitrary script/HTML surface
// exists anywhere in this screen by contract. Save is server-validated with
// CAS; the authoritative state is refetched after save (no optimistic fake
// enabled status).
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, apiPut } from "../../api/client.js";
import { useToast } from "../../design/toast.js";
import { Badge, Button, Card, Field, Input, Spinner } from "../../design/ui.js";
import { t } from "../../i18n/index.js";

interface ProviderConfig {
  readonly enabled: boolean;
  readonly counterId?: string | null;
  readonly measurementId?: string | null;
  readonly containerId?: string | null;
  readonly webvisor?: boolean;
  readonly clickmap?: boolean;
  readonly trackLinks?: boolean;
  readonly accurateTrackBounce?: boolean;
  readonly ecommerce?: boolean;
  readonly sendTitle?: boolean;
  readonly debugMode?: boolean;
  readonly activationPolicy?: string;
}

interface AnalyticsSettingsWire {
  readonly settings: {
    readonly schemaVersion: number;
    readonly providers: {
      readonly yandex_metrica: ProviderConfig;
      readonly google_analytics_4: ProviderConfig;
      readonly google_tag_manager: ProviderConfig;
    };
    readonly networkRules: readonly {
      readonly id: string;
      readonly label?: string;
      readonly origin: string;
      readonly directives: readonly string[];
    }[];
  };
  readonly generation: number;
}

interface DoctorIssue {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly provider?: string;
  readonly message: string;
}

const DIRECTIVES = [
  "script-src",
  "script-src-elem",
  "connect-src",
  "img-src",
  "frame-src",
  "style-src",
  "font-src",
] as const;

const TITLES: Record<string, string> = {
  yandex_metrica: "analytics.card_metrica",
  google_analytics_4: "analytics.card_ga4",
  google_tag_manager: "analytics.card_gtm",
};

function statusBadges(
  config: ProviderConfig | undefined,
  issues: readonly DoctorIssue[],
  providerId: string,
): { label: string; tone: "neutral" | "success" | "warning" | "danger" }[] {
  if (config?.enabled !== true) return [{ label: t("analytics.status_disabled"), tone: "neutral" }];
  const providerIssues = issues.filter((issue) => issue.provider === providerId);
  if (providerIssues.some((issue) => issue.severity === "error")) {
    return [{ label: t("analytics.status_invalid"), tone: "danger" }];
  }
  const id = config.counterId ?? config.measurementId ?? config.containerId ?? "";
  const badges: { label: string; tone: "neutral" | "success" | "warning" | "danger" }[] = [
    { label: `${t("analytics.status_configured")}${id !== "" ? ` · ${id}` : ""}`, tone: "neutral" },
    { label: t("analytics.status_render_ok"), tone: "success" },
  ];
  for (const issue of providerIssues) {
    if (issue.severity === "warning") badges.push({ label: issue.code, tone: "warning" });
  }
  return badges;
}

export function AnalyticsScreen() {
  const toast = useToast();
  const [state, setState] = useState<AnalyticsSettingsWire | null>(null);
  const [issues, setIssues] = useState<readonly DoctorIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [doctorRunning, setDoctorRunning] = useState(false);

  const reload = useCallback(async () => {
    const data = (await apiGet("/analytics/settings")) as AnalyticsSettingsWire;
    setState(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload().catch(() => {
      toast(t("analytics.load_failed"), "error");
      setLoading(false);
    });
  }, [reload, toast]);

  if (loading) return <Spinner label={t("core.loading")} />;
  if (state === null) return null;

  const patchProvider = (id: string, patch: Partial<ProviderConfig>) => {
    setState((current) =>
      current === null
        ? current
        : {
            ...current,
            settings: {
              ...current.settings,
              providers: {
                ...current.settings.providers,
                [id]: {
                  ...current.settings.providers[id as keyof typeof current.settings.providers],
                  ...patch,
                },
              },
            },
          },
    );
  };

  const save = async () => {
    if (state === null) return;
    setSaving(true);
    try {
      const result = (await apiPut("/analytics/settings", {
        settings: state.settings,
        expected_generation: state.generation,
      })) as { generation: number };
      setState({ ...state, generation: result.generation });
      toast(t("analytics.saved"), "success");
    } catch (error) {
      toast(
        error instanceof Error
          ? `${t("analytics.save_failed")}: ${error.message}`
          : t("analytics.save_failed"),
        "error",
      );
      await reload().catch(() => {});
    } finally {
      setSaving(false);
    }
  };

  const runDoctor = async () => {
    setDoctorRunning(true);
    try {
      const result = (await apiPost("/analytics/doctor", {})) as { issues: DoctorIssue[] };
      setIssues(result.issues ?? []);
      toast(t("analytics.doctor_done"), "success");
    } catch {
      toast(t("analytics.doctor_failed"), "error");
    } finally {
      setDoctorRunning(false);
    }
  };

  const metrica = state.settings.providers.yandex_metrica;
  const ga4 = state.settings.providers.google_analytics_4;
  const gtm = state.settings.providers.google_tag_manager;
  const directGoogle = ga4.enabled === true && gtm.enabled === true;
  const metricaGtm = metrica.enabled === true && gtm.enabled === true;

  return (
    <section className="pcms-screen" aria-label={t("analytics.screen_title")}>
      <header className="pcms-screen__header">
        <h1>{t("analytics.screen_title")}</h1>
        <div className="pcms-screen__actions">
          <Button variant="secondary" onClick={runDoctor} disabled={doctorRunning}>
            {doctorRunning ? <Spinner label="" /> : null}
            {t("analytics.doctor_button")}
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Spinner label="" /> : null}
            {t("analytics.save_button")}
          </Button>
        </div>
      </header>
      <p className="pcms-hint">
        <a href="#/settings?tab=verification">{t("analytics.ownership_link")}</a>
      </p>

      <Card title={t("analytics.card_metrica")}>
        <div className="pcms-field-row">
          {statusBadges(metrica, issues, "yandex_metrica").map((badge) => (
            <Badge key={badge.label} tone={badge.tone}>
              {badge.label}
            </Badge>
          ))}
        </div>
        <Field label={t("analytics.metrica_counter_id")} hint={t("analytics.metrica_counter_hint")}>
          <Input
            value={metrica.counterId ?? ""}
            onChange={(event) =>
              patchProvider("yandex_metrica", { counterId: event.target.value || null })
            }
            placeholder={t("analytics.metrica_counter_placeholder")}
          />
        </Field>
        <label className="pcms-check">
          <input
            type="checkbox"
            checked={metrica.enabled}
            onChange={(event) => patchProvider("yandex_metrica", { enabled: event.target.checked })}
          />
          {t("analytics.enable")}
        </label>
        {(
          [
            ["clickmap", "analytics.metrica_clickmap"],
            ["trackLinks", "analytics.metrica_tracklinks"],
            ["accurateTrackBounce", "analytics.metrica_bounce"],
            ["webvisor", "analytics.metrica_webvisor"],
            ["ecommerce", "analytics.metrica_ecommerce"],
          ] as const
        ).map(([key, label]) => (
          <label className="pcms-check" key={key}>
            <input
              type="checkbox"
              checked={metrica[key] === true}
              onChange={(event) => patchProvider("yandex_metrica", { [key]: event.target.checked })}
            />
            {t(label)}
          </label>
        ))}
        <p className="pcms-hint">{t("analytics.webvisor_note")}</p>
        <label className="pcms-check">
          <input
            type="checkbox"
            checked={metrica.debugMode === true}
            onChange={(event) =>
              patchProvider("yandex_metrica", { debugMode: event.target.checked })
            }
          />
          {t("analytics.metrica_debug")}
        </label>
        <p className="pcms-hint">{t("analytics.metrica_debug_note")}</p>
        {metricaGtm ? <p className="pcms-hint">{t("analytics.metrica_gtm_warning")}</p> : null}
      </Card>

      <Card title={t("analytics.card_ga4")}>
        <div className="pcms-field-row">
          {statusBadges(ga4, issues, "google_analytics_4").map((badge) => (
            <Badge key={badge.label} tone={badge.tone}>
              {badge.label}
            </Badge>
          ))}
        </div>
        <Field label={t("analytics.ga4_id")} hint={t("analytics.ga4_id_hint")}>
          <Input
            value={ga4.measurementId ?? ""}
            onChange={(event) =>
              patchProvider("google_analytics_4", { measurementId: event.target.value || null })
            }
            placeholder={t("analytics.ga4_id_placeholder")}
          />
        </Field>
        <label className="pcms-check">
          <input
            type="checkbox"
            checked={ga4.enabled}
            onChange={(event) =>
              patchProvider("google_analytics_4", { enabled: event.target.checked })
            }
          />
          {t("analytics.enable")}
        </label>
        {directGoogle ? <p className="pcms-hint">{t("analytics.ga4_gtm_warning")}</p> : null}
      </Card>

      <Card title={t("analytics.card_gtm")}>
        <div className="pcms-field-row">
          {statusBadges(gtm, issues, "google_tag_manager").map((badge) => (
            <Badge key={badge.label} tone={badge.tone}>
              {badge.label}
            </Badge>
          ))}
        </div>
        <Field label={t("analytics.gtm_id")} hint={t("analytics.gtm_id_hint")}>
          <Input
            value={gtm.containerId ?? ""}
            onChange={(event) =>
              patchProvider("google_tag_manager", { containerId: event.target.value || null })
            }
            placeholder={t("analytics.gtm_id_placeholder")}
          />
        </Field>
        <label className="pcms-check">
          <input
            type="checkbox"
            checked={gtm.enabled}
            onChange={(event) =>
              patchProvider("google_tag_manager", { enabled: event.target.checked })
            }
          />
          {t("analytics.enable")}
        </label>
        <label className="pcms-check">
          <input
            type="checkbox"
            checked={gtm.debugMode === true}
            onChange={(event) =>
              patchProvider("google_tag_manager", { debugMode: event.target.checked })
            }
          />
          {t("analytics.gtm_debug")}
        </label>
        <p className="pcms-hint">{t("analytics.gtm_debug_note")}</p>
        <p className="pcms-hint">{t("analytics.gtm_security_note")}</p>
      </Card>

      <Card title={t("analytics.network_rules_title")}>
        <p className="pcms-hint">{t("analytics.network_rules_hint")}</p>
        {state.settings.networkRules.map((rule) => (
          <div className="pcms-field-row" key={rule.id}>
            <Badge tone="neutral">{rule.origin}</Badge>
            <span>{rule.directives.join(", ")}</span>
            {rule.label ? <span>{rule.label}</span> : null}
            <Button
              variant="secondary"
              disabled={saving}
              aria-label={t("analytics.rule_remove_aria", { origin: rule.origin })}
              onClick={() =>
                setState((current) =>
                  current === null
                    ? current
                    : {
                        ...current,
                        settings: {
                          ...current.settings,
                          networkRules: current.settings.networkRules.filter(
                            (item) => item.id !== rule.id,
                          ),
                        },
                      },
                )
              }
            >
              {t("analytics.rule_remove")}
            </Button>
          </div>
        ))}
        {state.settings.networkRules.length === 0 ? (
          <p className="pcms-hint">{t("analytics.network_rules_empty")}</p>
        ) : null}
        <p className="pcms-hint">{t("analytics.rule_save_hint")}</p>
        <details>
          <summary>{t("analytics.network_rules_add")}</summary>
          <NetworkRuleEditor
            onAdd={(rule) => {
              setState((current) =>
                current === null
                  ? current
                  : {
                      ...current,
                      settings: {
                        ...current.settings,
                        networkRules: [...current.settings.networkRules, rule],
                      },
                    },
              );
            }}
          />
        </details>
      </Card>

      {issues.length > 0 ? (
        <Card title={t("analytics.doctor_results")}>
          {issues.map((issue) => (
            <div
              className="pcms-field-row"
              key={`${issue.code}:${issue.provider ?? ""}:${issue.message}`}
            >
              <Badge
                tone={
                  issue.severity === "error"
                    ? "danger"
                    : issue.severity === "warning"
                      ? "warning"
                      : "neutral"
                }
              >
                {issue.code}
              </Badge>
              <span>{issue.message}</span>
            </div>
          ))}
        </Card>
      ) : null}
    </section>
  );
}

function NetworkRuleEditor(props: {
  onAdd: (rule: { id: string; label?: string; origin: string; directives: string[] }) => void;
}) {
  const [origin, setOrigin] = useState("");
  const [label, setLabel] = useState("");
  const [directives, setDirectives] = useState<readonly string[]>([]);
  return (
    <div className="pcms-stack">
      <Field label={t("analytics.rule_origin")} hint={t("analytics.rule_origin_hint")}>
        <Input
          value={origin}
          onChange={(event) => setOrigin(event.target.value)}
          placeholder={t("analytics.rule_origin_placeholder")}
        />
      </Field>
      <Field label={t("analytics.rule_label")}>
        <Input value={label} onChange={(event) => setLabel(event.target.value)} />
      </Field>
      <fieldset>
        <legend>{t("analytics.rule_directives")}</legend>
        {DIRECTIVES.map((directive) => (
          <label className="pcms-check" key={directive}>
            <input
              type="checkbox"
              checked={directives.includes(directive)}
              onChange={(event) =>
                setDirectives((current) =>
                  event.target.checked
                    ? [...current, directive]
                    : current.filter((item) => item !== directive),
                )
              }
            />
            {directive}
          </label>
        ))}
      </fieldset>
      <Button
        variant="secondary"
        onClick={() => {
          if (origin.trim() === "" || directives.length === 0) return;
          props.onAdd({
            id: `rule-${Date.now().toString(36)}`,
            origin: origin.trim(),
            ...(label.trim() === "" ? {} : { label: label.trim() }),
            directives: [...directives],
          });
          setOrigin("");
          setLabel("");
          setDirectives([]);
        }}
      >
        {t("analytics.rule_add_button")}
      </Button>
    </div>
  );
}
