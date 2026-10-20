// Settings + System (PCMS-ADMIN-T025; Admin spec §48-§51): typed sections,
// site identity editing, doctor-style status. No arbitrary env editor, no
// secrets; later Ops/Update modules extend via the typed slots below.
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPut } from "../../api/client.js";
import { useToast } from "../../design/toast.js";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  Input,
  Select,
  Spinner,
  Textarea,
} from "../../design/ui.js";
import { formatDateTime, formatFileSize, t } from "../../i18n/index.js";
import { navigate, useRoute } from "../../layout/router.js";
import { MaintenanceScreen } from "../maintenance/MaintenanceScreen.js";
import { IndexNowCard } from "./IndexNowCard.js";
import { LanguagesCard } from "./LanguagesCard.js";

interface SiteInfoWire {
  readonly site: { readonly id: string; readonly key: string; readonly title: string };
  readonly route_policy: Record<string, unknown>;
  readonly domains: readonly { readonly hostname: string; readonly is_primary: boolean }[];
}

interface VerificationWire {
  readonly provider: string;
  readonly content: string;
  readonly label?: string;
  readonly method?: "meta" | "file";
  readonly file?: { readonly filename: string; readonly body: string };
}

interface VerificationDraft extends VerificationWire {
  readonly editorId: string;
}

interface IdentityWire {
  readonly site_name?: string;
  readonly alternate_site_name?: string | null;
  readonly legal_name?: string | null;
  readonly organization_type?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly title_pattern?: string | null;
  readonly verification?: VerificationWire[];
}

interface SystemStatusWire {
  readonly site: { readonly key: string; readonly title: string } | null;
  readonly db_migration_head: string | null;
  readonly worker_queue: { readonly pending: number; readonly dead: number } | null;
  readonly media_storage: boolean;
  readonly theme: {
    readonly id: string;
    readonly contract: string;
    readonly validation_ok: boolean | null;
  } | null;
  readonly runtime: {
    readonly uptime_seconds: number;
    readonly memory_used_bytes: number;
    readonly memory_limit_bytes: number | null;
  } | null;
  readonly db_ok: boolean | null;
  readonly db_latency_ms: number | null;
  readonly media_storage_bytes: number | null;
  readonly search: {
    readonly available: boolean;
    readonly document_count: number;
    readonly reindex_required: boolean;
    readonly last_reindex_at: string | null;
  } | null;
  readonly last_update: {
    readonly to_version: string;
    readonly status: string;
    readonly completed_at: string | null;
  } | null;
  readonly stats: {
    readonly entries: number | null;
    readonly entries_published: number | null;
    readonly entries_drafts: number | null;
    readonly media_assets: number | null;
    readonly forms: number | null;
    readonly submissions_24h: number | null;
    readonly submissions_7d: number | null;
    readonly leads_new: number | null;
    readonly quiz_runs: number | null;
  } | null;
  readonly worker_heartbeat: {
    readonly last_beat_at: string;
    readonly age_seconds: number;
    readonly fresh: boolean;
  } | null;
}

export function SettingsScreen() {
  const route = useRoute();
  const requestedTab = route.query.get("tab");
  const tab =
    requestedTab === "site" || requestedTab === "verification" ? requestedTab : "identity";
  return (
    <div data-testid="settings-screen">
      <div className="pcms-tabs" role="tablist" aria-label={t("settings.tabs_aria")}>
        {(
          [
            ["identity", t("settings.tab_identity")],
            ["verification", t("settings.verification_title")],
            ["site", t("settings.tab_site")],
          ] as const
        ).map(([id, title]) => (
          <button
            key={id}
            type="button"
            role="tab"
            className="pcms-tab"
            aria-selected={tab === id}
            onClick={() => navigate(`settings?tab=${id}`)}
          >
            {title}
          </button>
        ))}
      </div>
      {tab !== "site" ? (
        <IdentityTab verificationOnly={tab === "verification"} />
      ) : (
        <>
          <SiteTab />
          <LanguagesCard />
          <IndexNowCard />
        </>
      )}
    </div>
  );
}

function IdentityTab({ verificationOnly }: { readonly verificationOnly: boolean }) {
  const toast = useToast();
  const [identity, setIdentity] = useState<IdentityWire | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [proofs, setProofs] = useState<VerificationDraft[]>([]);

  const reload = useCallback(() => {
    setError(null);
    apiGet<{ identity: IdentityWire | null }>("/settings/site-identity")
      .then((result) => {
        setIdentity(result.identity ?? {});
        setProofs(
          (result.identity?.verification ?? []).map((entry) => ({
            ...entry,
            editorId: crypto.randomUUID(),
          })),
        );
        setRaw(JSON.stringify(result.identity ?? {}, null, 2));
      })
      .catch(() => setError(t("settings.identity_load_failed")));
  }, []);

  useEffect(reload, [reload]);

  if (error !== null) {
    return (
      <div>
        <p>{error}</p>
        <Button onClick={reload}>{t("retry")}</Button>
      </div>
    );
  }
  if (identity === null || raw === null) return <Spinner />;

  const patch = (key: keyof IdentityWire, value: string) =>
    setIdentity({ ...identity, [key]: value === "" ? null : value });

  const save = async () => {
    setBusy(true);
    try {
      await apiPut("/settings/site-identity", {
        identity: {
          ...identity,
          verification: proofs.map(({ editorId: _editorId, ...proof }) => proof),
        },
      });
      toast(t("settings.identity_saved"), "success");
      reload();
    } catch {
      toast(t("settings.identity_save_failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="identity-form">
      {verificationOnly ? (
        <OwnershipVerificationEditor entries={proofs} onChange={setProofs} />
      ) : (
        <div className="pcms-form-grid pcms-form-grid--identity">
          <Field label={t("settings.field_site_name")} required>
            <Input
              value={identity.site_name ?? ""}
              onChange={(event) => patch("site_name", event.target.value)}
            />
          </Field>
          <Field label={t("settings.field_alternate_name")}>
            <Input
              value={identity.alternate_site_name ?? ""}
              onChange={(event) => patch("alternate_site_name", event.target.value)}
            />
          </Field>
          <Field label={t("settings.field_legal_name")}>
            <Input
              value={identity.legal_name ?? ""}
              onChange={(event) => patch("legal_name", event.target.value)}
            />
          </Field>
          <Field label={t("settings.field_organization_type")}>
            <Select
              value={identity.organization_type ?? ""}
              onChange={(event) => patch("organization_type", event.target.value)}
            >
              <option value="">{t("settings.organization_unspecified")}</option>
              <option value="Organization">{t("settings.org_type_organization")}</option>
              <option value="LocalBusiness">{t("settings.org_type_local_business")}</option>
            </Select>
          </Field>
          <Field label={t("settings.field_phone")}>
            <Input
              value={identity.phone ?? ""}
              onChange={(event) => patch("phone", event.target.value)}
            />
          </Field>
          <Field label={t("settings.field_email")}>
            <Input
              value={identity.email ?? ""}
              onChange={(event) => patch("email", event.target.value)}
            />
          </Field>
          <Field label={t("settings.field_title_pattern")} hint="{page_title} — {site_name}">
            <Input
              value={identity.title_pattern ?? ""}
              onChange={(event) => patch("title_pattern", event.target.value)}
            />
          </Field>
        </div>
      )}
      <div className="pcms-actions-row">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          {t("save")}
        </Button>
      </div>
      {verificationOnly ? null : (
        <details className="pcms-panel">
          <summary>{t("settings.advanced_summary")}</summary>
          <p className="pcms-field__hint">{t("settings.identity_document_hint")}</p>
          <Textarea aria-label={t("settings.identity_document_aria")} readOnly value={raw} />
        </details>
      )}
    </div>
  );
}

/**
 * Typed ownership-verification editor (2026-10-18 task B): provider,
 * meta/file method and the provider proof. Values stay typed — a pasted
 * meta tag is parsed to its token server-side; the file editor carries the
 * provider-generated filename/body pair exactly. No raw <head> HTML surface.
 */
function OwnershipVerificationEditor(props: {
  readonly entries: readonly VerificationDraft[];
  readonly onChange: (entries: VerificationDraft[]) => void;
}) {
  const toast = useToast();
  const patch = (index: number, entry: Partial<VerificationWire>) => {
    props.onChange(
      props.entries.map((e, i) => {
        if (i !== index) return e;
        const next = { ...e, ...entry };
        if (next.method === "file") return next;
        const { file: _file, ...meta } = next;
        return meta;
      }),
    );
  };
  const remove = (index: number) => props.onChange(props.entries.filter((_, i) => i !== index));
  const readProviderFile = async (index: number, file: File) => {
    try {
      const body = await file.text();
      const entry = props.entries[index];
      const token =
        entry?.provider === "google"
          ? /^google-site-verification:\s*(\S+)\s*$/.exec(body)?.[1]
          : /^yandex_([0-9a-f]{16})\.html$/i.exec(file.name)?.[1];
      patch(index, {
        method: "file",
        file: { filename: file.name.toLowerCase(), body },
        ...(token === undefined ? {} : { content: token }),
      });
    } catch {
      toast(t("settings.verification_file_read_failed"), "error");
    }
  };
  return (
    <div className="pcms-panel" data-testid="verification-editor">
      <h3>{t("settings.verification_title")}</h3>
      <p className="pcms-field__hint">{t("settings.verification_hint")}</p>
      <ol>
        <li>{t("settings.verification_step_provider")}</li>
        <li>{t("settings.verification_step_cms")}</li>
        <li>{t("settings.verification_step_confirm")}</li>
      </ol>
      {props.entries.map((entry, index) => {
        const isFile = entry.method === "file";
        const providerFixed = entry.provider === "other";
        return (
          <div
            className="pcms-stack"
            data-testid={`verification-entry-${index}`}
            key={entry.editorId}
          >
            <div className="pcms-form-grid pcms-form-grid--identity">
              <Field label={t("settings.verification_provider")}>
                <Select
                  value={entry.provider}
                  onChange={(event) => {
                    const provider = event.target.value;
                    patch(
                      index,
                      provider === "other" ? { provider, method: "meta" } : { provider },
                    );
                  }}
                >
                  <option value="google">{t("settings.verification_provider_google")}</option>
                  <option value="yandex">{t("settings.verification_provider_yandex")}</option>
                  <option value="other">{t("settings.verification_provider_other")}</option>
                </Select>
              </Field>
              {providerFixed ? null : (
                <Field label={t("settings.verification_method")}>
                  <Select
                    value={entry.method ?? "meta"}
                    onChange={(event) =>
                      patch(
                        index,
                        event.target.value === "file" ? { method: "file" } : { method: "meta" },
                      )
                    }
                  >
                    <option value="meta">{t("settings.verification_method_meta")}</option>
                    <option value="file">{t("settings.verification_method_file")}</option>
                  </Select>
                </Field>
              )}
            </div>
            <Field
              label={t(isFile ? "settings.verification_file_token" : "settings.verification_token")}
              {...(isFile ? {} : { hint: t("settings.verification_token_hint") })}
            >
              <Input
                value={entry.content ?? ""}
                onChange={(event) => patch(index, { content: event.target.value })}
              />
            </Field>
            {isFile && entry.provider !== "other" ? (
              <>
                <Field label={t("settings.verification_filename")}>
                  <Input
                    value={entry.file?.filename ?? ""}
                    onChange={(event) =>
                      patch(index, {
                        file: { filename: event.target.value, body: entry.file?.body ?? "" },
                      })
                    }
                  />
                </Field>
                <Field label={t("settings.verification_body")}>
                  <Textarea
                    aria-label={t("settings.verification_body")}
                    value={entry.file?.body ?? ""}
                    onChange={(event) =>
                      patch(index, {
                        file: { filename: entry.file?.filename ?? "", body: event.target.value },
                      })
                    }
                  />
                </Field>
                <label className="pcms-check">
                  <input
                    type="file"
                    accept=".html,text/html"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file !== undefined) void readProviderFile(index, file);
                    }}
                  />
                  {t("settings.verification_pick")}
                </label>
              </>
            ) : null}
            <div className="pcms-actions-row">
              <Button variant="secondary" onClick={() => remove(index)}>
                {t("settings.verification_remove")}
              </Button>
            </div>
          </div>
        );
      })}
      <div className="pcms-actions-row">
        <Button
          variant="secondary"
          onClick={() =>
            props.onChange([
              ...props.entries,
              { provider: "google", content: "", method: "meta", editorId: crypto.randomUUID() },
            ])
          }
        >
          {t("settings.verification_add")}
        </Button>
      </div>
      <p className="pcms-field__hint">{t("settings.verification_public_hint")}</p>
    </div>
  );
}

function SiteTab() {
  const [site, setSite] = useState<SiteInfoWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiGet<SiteInfoWire>("/site")
      .then(setSite)
      .catch(() => setError(t("settings.site_load_failed")));
  }, []);
  if (error !== null) return <EmptyState title={error} />;
  if (site === null) return <Spinner />;
  return (
    <div className="pcms-panel" data-testid="site-info">
      <h3>{t("settings.site_title")}</h3>
      <p>
        {site.site.title} <span className="pcms-picker-row__meta">({site.site.key})</span>
      </p>
      <h3>{t("settings.domains_title")}</h3>
      {site.domains.length === 0 ? (
        <p className="pcms-text-muted">{t("settings.domains_empty")}</p>
      ) : (
        site.domains.map((domain) => (
          <p key={domain.hostname}>
            {domain.hostname}{" "}
            {domain.is_primary ? (
              <Badge tone="success">{t("settings.domain_primary")}</Badge>
            ) : null}
          </p>
        ))
      )}
      <h3>{t("settings.route_policy_title")}</h3>
      <ul>
        <li>
          {site.route_policy.trailingSlash === true
            ? t("settings.policy_trailing_slash_on")
            : t("settings.policy_trailing_slash_off")}
        </li>
        <li>
          {site.route_policy.lowercase === true
            ? t("settings.policy_lowercase_on")
            : t("settings.policy_lowercase_off")}
        </li>
        <li>
          {(site.route_policy.slug as { cyrillic?: boolean } | undefined)?.cyrillic === true
            ? t("settings.policy_cyrillic_on")
            : t("settings.policy_cyrillic_off")}
        </li>
      </ul>
      <details>
        <summary>{t("settings.advanced_summary")}</summary>
        <pre style={{ fontSize: "var(--pcms-admin-text-sm)" }}>
          {JSON.stringify(site.route_policy, null, 2)}
        </pre>
      </details>
    </div>
  );
}

/** Tiny inline SVG sparkline (owner UX §40): no chart library. */
function Sparkline(props: {
  readonly points: readonly number[];
  readonly label: string;
  readonly max?: number;
  /** Current value shown next to the graph; null renders as unavailable (never fake 0). */
  readonly current?: number | null;
  readonly format?: (value: number) => string;
  /** ISO timestamp of the newest sample — surfaced as freshness. */
  readonly lastTs?: string | null;
}) {
  const width = 220;
  const height = 36;
  const values = props.points.length > 0 ? props.points : [0];
  const max = props.max ?? Math.max(...values, 1);
  const step = width / Math.max(values.length - 1, 1);
  const path = values
    .map((value, index) => {
      const x = index * step;
      const y = height - (Math.max(0, value) / max) * (height - 4) - 2;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const current =
    props.current === null || props.current === undefined
      ? null
      : (props.format ?? ((value: number) => String(Math.round(value))))(props.current);
  return (
    <figure className="pcms-sparkline" data-testid="system-metric">
      <figcaption>
        {props.label}{" "}
        <strong data-testid="system-metric-value">
          {current === null ? t("settings.metrics_unavailable") : current}
        </strong>
        {props.lastTs !== null && props.lastTs !== undefined ? (
          <span className="pcms-field__hint"> · {formatDateTime(props.lastTs)}</span>
        ) : null}
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={props.label}>
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </figure>
  );
}

function HealthCard(props: {
  readonly icon: Parameters<typeof Icon>[0]["name"];
  readonly title: string;
  readonly ok: boolean | null;
  readonly detail: string;
}) {
  return (
    <div className="pcms-panel pcms-health-card">
      <div className="pcms-row" style={{ alignItems: "center" }}>
        <Icon name={props.icon} />
        <strong>{props.title}</strong>
        <span className="pcms-toolbar__spacer" />
        {props.ok === null ? (
          <Badge>{t("settings.health_unknown")}</Badge>
        ) : props.ok ? (
          <Badge tone="success">{t("settings.health_ok")}</Badge>
        ) : (
          <Badge tone="danger">{t("settings.health_attention")}</Badge>
        )}
      </div>
      <p className="pcms-field__hint">{props.detail}</p>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return t("settings.uptime_dhm", { d: days, h: hours, m: minutes });
  if (hours > 0) return t("settings.uptime_hm", { h: hours, m: minutes });
  return t("settings.uptime_m", { m: minutes });
}

export function SystemScreen() {
  const [status, setStatus] = useState<SystemStatusWire | null>(null);
  const [samples, setSamples] = useState<
    | readonly {
        ts: string;
        cpu_percent: number | null;
        memory_used_bytes: number | null;
        memory_limit_bytes: number | null;
        queue_pending: number | null;
      }[]
    | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(() => {
    setError(null);
    Promise.all([
      apiGet<SystemStatusWire>("/system/status").catch(() => null),
      apiGet<{
        samples: readonly {
          ts: string;
          cpu_percent: number | null;
          memory_used_bytes: number | null;
          memory_limit_bytes: number | null;
          queue_pending: number | null;
        }[];
      }>("/system/metrics?hours=24").catch(() => null),
    ])
      .then(([statusResult, metrics]) => {
        setStatus(statusResult);
        setSamples(metrics?.samples ?? []);
        setLoaded(true);
      })
      .catch(() => setError(t("settings.system_load_failed")));
  }, []);
  useEffect(reload, [reload]);
  // Live series (PCMS-PRE-RESEARCH A5): the collector samples once a minute,
  // so a 60s quiet refetch keeps the graphs current without a page reload.
  // A hidden tab pauses polling and resumes with a fresh fetch.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(reload, 60_000);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stop();
      else {
        reload();
        start();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reload]);
  if (error !== null) {
    return (
      <div>
        <p>{error}</p>
        <Button onClick={reload}>{t("retry")}</Button>
      </div>
    );
  }
  if (!loaded) return <Spinner />;
  if (status === null) {
    return (
      <EmptyState
        title={t("settings.system_unavailable_title")}
        hint={t("settings.system_unavailable_hint")}
      />
    );
  }

  const healthy =
    (status.db_ok ?? false) &&
    (status.worker_heartbeat?.fresh ?? false) &&
    (status.worker_queue?.dead ?? 0) === 0 &&
    status.media_storage;

  return (
    <div className="pcms-screen" data-testid="system-screen">
      <div className="pcms-toolbar">
        <h1>{t("settings.system_title")}</h1>
        <span className="pcms-toolbar__spacer" />
        <span data-testid="system-health" className="pcms-toolbar__health">
          <Badge tone={healthy ? "success" : "warning"}>
            {healthy ? t("settings.health_summary_ok") : t("settings.health_summary_attention")}
          </Badge>
        </span>
      </div>

      <div className="pcms-health-grid">
        <HealthCard
          icon="success"
          title={t("settings.health_web")}
          ok={status.db_ok !== null ? true : null}
          detail={`${t("settings.health_uptime")}: ${
            status.runtime === null ? "—" : formatUptime(status.runtime.uptime_seconds)
          }`}
        />
        <HealthCard
          icon="code"
          title={t("settings.health_worker")}
          ok={status.worker_heartbeat === null ? null : status.worker_heartbeat.fresh}
          detail={
            status.worker_heartbeat === null
              ? t("settings.health_worker_missing")
              : `${t("settings.health_last_beat")}: ${formatDateTime(status.worker_heartbeat.last_beat_at)}`
          }
        />
        <HealthCard
          icon="code"
          title={t("settings.health_db")}
          ok={status.db_ok}
          detail={`${status.db_latency_ms === null ? "—" : `${status.db_latency_ms} ms`} · ${t("settings.migrations_head")}: ${status.db_migration_head ?? "—"}`}
        />
        <HealthCard
          icon="warning"
          title={t("settings.queue_title")}
          ok={status.worker_queue === null ? null : status.worker_queue.dead === 0}
          detail={
            status.worker_queue === null
              ? t("settings.queue_unavailable")
              : `${t("settings.queue_pending")}: ${status.worker_queue.pending} · ${t("settings.queue_dead")}: ${status.worker_queue.dead}`
          }
        />
        <HealthCard
          icon="media"
          title={t("settings.media_storage_title")}
          ok={status.media_storage}
          detail={
            status.media_storage_bytes === null
              ? t("settings.media_storage_missing")
              : `${t("settings.health_media_size")}: ${formatFileSize(status.media_storage_bytes)}`
          }
        />
        <HealthCard
          icon="theme"
          title={t("settings.theme_title")}
          ok={status.theme?.validation_ok ?? null}
          detail={
            status.theme === null
              ? t("settings.theme_source_missing")
              : `${status.theme.id} · ${status.theme.contract}`
          }
        />
        <HealthCard
          icon="search"
          title={t("settings.health_search")}
          ok={status.search === null ? null : status.search.available}
          detail={
            status.search === null
              ? t("settings.health_unknown")
              : `${t("search.documents", { count: String(status.search.document_count) })}${
                  status.search.last_reindex_at === null
                    ? ""
                    : ` · ${t("search.last_reindex", { time: formatDateTime(status.search.last_reindex_at) })}`
                }`
          }
        />
        <HealthCard
          icon="code"
          title={t("settings.health_updates")}
          ok={status.last_update === null ? null : status.last_update.status === "SUCCEEDED"}
          detail={
            status.last_update === null
              ? t("settings.health_updates_none")
              : `${status.last_update.to_version} · ${status.last_update.status}${
                  status.last_update.completed_at === null
                    ? ""
                    : ` · ${formatDateTime(status.last_update.completed_at)}`
                }`
          }
        />
      </div>

      <div className="pcms-panel" data-testid="system-maintenance">
        <h3>{t("maintenance_screen_title")}</h3>
        <p className="pcms-field__hint">{t("settings.maintenance_hint")}</p>
        <MaintenanceScreen />
      </div>

      {samples !== null && samples.length > 1 ? (
        <div className="pcms-panel">
          <h3>{t("settings.metrics_title")}</h3>
          <p className="pcms-field__hint">{t("settings.metrics_hint")}</p>
          <div className="pcms-health-grid">
            <Sparkline
              label={t("settings.metrics_cpu")}
              points={samples.map((sample) => sample.cpu_percent ?? 0)}
              max={100}
              current={samples.at(-1)?.cpu_percent ?? null}
              format={(value) => `${value.toFixed(1)} %`}
              lastTs={samples.at(-1)?.ts ?? null}
            />
            <Sparkline
              label={t("settings.metrics_memory")}
              points={samples.map((sample) => sample.memory_used_bytes ?? 0)}
              current={samples.at(-1)?.memory_used_bytes ?? null}
              format={(value) => formatFileSize(value)}
              lastTs={samples.at(-1)?.ts ?? null}
            />
            <Sparkline
              label={t("settings.metrics_queue")}
              points={samples.map((sample) => sample.queue_pending ?? 0)}
              current={samples.at(-1)?.queue_pending ?? null}
              lastTs={samples.at(-1)?.ts ?? null}
            />
          </div>
        </div>
      ) : (
        <div className="pcms-panel">
          <h3>{t("settings.metrics_title")}</h3>
          <p className="pcms-field__hint">{t("settings.metrics_empty")}</p>
        </div>
      )}

      {status.stats !== null ? (
        <div className="pcms-panel">
          <h3>{t("settings.stats_title")}</h3>
          <div className="pcms-stats-grid">
            {(
              [
                ["settings.stats_entries", status.stats.entries],
                ["settings.stats_published", status.stats.entries_published],
                ["settings.stats_drafts", status.stats.entries_drafts],
                ["settings.stats_media", status.stats.media_assets],
                ["settings.stats_forms", status.stats.forms],
                ["settings.stats_submissions_24h", status.stats.submissions_24h],
                ["settings.stats_submissions_7d", status.stats.submissions_7d],
                ["settings.stats_leads_new", status.stats.leads_new],
                ["settings.stats_quiz_runs", status.stats.quiz_runs],
              ] as const
            ).map(([key, value]) => (
              <div key={key} className="pcms-stats-cell">
                <strong>{value === null || value === undefined ? "—" : value}</strong>
                <span>{t(key)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <p className="pcms-field__hint">{t("settings.backup_hint")}</p>
      <p className="pcms-field__hint">{t("settings.updates_hint")}</p>
    </div>
  );
}
