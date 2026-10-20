// Admin Integrations workspace (PCMS-INT-T017; Integrations spec §39).
// Reliability is a first-class surface: connections, bindings, deliveries
// with full attempt history, failures/dead-letter and inbound events —
// nothing is hidden in logs. The SPA is a thin client of /api/v1; the
// server remains the authorization authority (Admin spec §56).
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPut } from "../../api/client.js";
import { useAuth } from "../../auth/AuthContext.js";
import { Dialog } from "../../design/dialog.js";
import { useToast } from "../../design/toast.js";
import { Tooltip } from "../../design/tooltip.js";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorPanel,
  Field,
  Icon,
  Input,
  Select,
  Spinner,
  Switch,
  Tabs,
} from "../../design/ui.js";
import { errorText, t } from "../../i18n/index.js";

interface ConnectorSummary {
  readonly connector_type: string;
  readonly title: string;
  readonly description: string;
  readonly config_schema: Record<string, unknown>;
  readonly testable: boolean;
  readonly actions: readonly { readonly actionType: string }[];
  readonly secrets: readonly { readonly name: string; readonly description: string }[];
}
interface InstanceWire {
  readonly id: string;
  readonly connector_type: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly config: Record<string, unknown>;
  readonly secret_refs: Record<string, string>;
  /** Admin-managed runtime secret KEY names (values are write-only). */
  readonly runtime_secrets: readonly string[];
}
interface BindingWire {
  readonly id: string;
  readonly event_type: string;
  readonly enabled: boolean;
  readonly actions: readonly unknown[];
}
interface DeliveryWire {
  readonly id: string;
  readonly event_type: string;
  readonly action_type: string;
  readonly instance_id: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly external_id?: string | null;
  readonly last_error_code?: string | null;
}
interface AttemptWire {
  readonly attempt_no: number;
  readonly result: string;
  readonly started_at: string;
  readonly provider_error_code: string | null;
  readonly error_summary: string | null;
}
interface InboundWire {
  readonly id: string;
  readonly source_type: string;
  readonly event_type: string | null;
  readonly status: string;
  readonly received_at: string;
  readonly error_code: string | null;
}

/** Human reliability-state labels (owner rule: no raw enums in the UI). */
const STATUS_LABEL_KEYS: Record<string, string> = {
  SUCCEEDED: "integrations.delivery_status_succeeded",
  PENDING: "integrations.delivery_status_pending",
  PROCESSING: "integrations.delivery_status_processing",
  FAILED_RETRYABLE: "integrations.delivery_status_failed_retryable",
  FAILED_PERMANENT: "integrations.delivery_status_failed_permanent",
  CANCELLED: "integrations.delivery_status_cancelled",
  RECEIVED: "integrations.inbound_status_received",
  PROCESSED: "integrations.inbound_status_processed",
  FAILED: "integrations.inbound_status_failed",
};

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  SUCCEEDED: "success",
  PENDING: "neutral",
  PROCESSING: "warning",
  FAILED_RETRYABLE: "warning",
  FAILED_PERMANENT: "danger",
  CANCELLED: "neutral",
  RECEIVED: "warning",
  PROCESSED: "success",
  FAILED: "danger",
};

function StatusBadge(props: { readonly status: string }) {
  const key = STATUS_LABEL_KEYS[props.status];
  return (
    <Badge tone={STATUS_TONE[props.status] ?? "neutral"}>
      {key === undefined ? props.status : t(key)}
    </Badge>
  );
}

/** Admin-managed SMTP credentials (PCMS-OPS-T130): the operator-facing card.
 * The password is write-only — the GET contract never echoes it back; the
 * server verifies the connection before an enable is persisted. */
interface MailSettingsWire {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly from: string | null;
  readonly host: string | null;
  readonly port: number | null;
  readonly mode: "smtps" | "starttls" | "plain" | null;
  readonly username: string | null;
  readonly password_set: boolean;
  readonly encryption_ready: boolean;
  readonly updated_at: string | null;
  readonly updated_by: string | null;
}

/** TLS mode → conventional default port (owner rule): switching the mode
 * updates the port automatically UNTIL the operator edits the port manually
 * (autoPort flips off on the first manual keystroke; UI state only). */
const MODE_DEFAULT_PORT: Readonly<Record<string, string>> = {
  starttls: "587",
  smtps: "465",
  plain: "25",
};

const MODE_HINT_KEYS: Readonly<Record<string, string>> = {
  starttls: "integrations.mode_starttls_hint",
  smtps: "integrations.mode_smtps_hint",
  plain: "integrations.mode_plain_hint",
};

interface MailTestWire {
  readonly verified?: { readonly authenticated: boolean };
}

function MailSettingsCard() {
  const auth = useAuth();
  const toast = useToast();
  const [state, setState] = useState<MailSettingsWire | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [from, setFrom] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [mode, setMode] = useState<"smtps" | "starttls" | "plain">("starttls");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testAuth, setTestAuth] = useState<boolean | null>(null);
  const [autoPort, setAutoPort] = useState(true);

  const load = useCallback(() => {
    apiGet<MailSettingsWire>("/mail/settings")
      .then((wire) => {
        setState(wire);
        setEnabled(wire.enabled);
        setFrom(wire.from ?? "");
        setHost(wire.host ?? "");
        if (wire.port === null) {
          setPort(MODE_DEFAULT_PORT[wire.mode ?? "starttls"] ?? "");
          setAutoPort(true);
        } else {
          setPort(String(wire.port));
          setAutoPort(
            wire.mode !== null && wire.port === Number(MODE_DEFAULT_PORT[wire.mode] ?? NaN),
          );
        }
        if (wire.mode !== null) setMode(wire.mode);
        setUsername(wire.username ?? "");
      })
      .catch((cause: Error) => setLoadError(cause.message));
  }, []);
  useEffect(load, [load]);

  const canEdit = auth.can("integrations.configure");
  const canTest = auth.can("integrations.test");

  const changeMode = (next: "smtps" | "starttls" | "plain") => {
    setMode(next);
    if (autoPort) setPort(MODE_DEFAULT_PORT[next] ?? "");
  };
  const changePort = (value: string) => {
    setPort(value);
    setAutoPort(false);
  };

  const validate = (): readonly string[] => {
    const problems: string[] = [];
    if (from.trim() === "" || !from.includes("@")) problems.push(t("mail_settings_err_from"));
    if (host.trim() === "") problems.push(t("mail_settings_err_host"));
    if (port !== "" && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
      problems.push(t("mail_settings_err_port"));
    }
    return problems;
  };

  const humanSaveError = (cause: ApiError): string => {
    if (cause.code === "MAIL_ENCRYPTION_NOT_CONFIGURED") {
      return t("integrations.secret_store_missing");
    }
    if (cause.code === "API_REQUEST_INVALID") return t("mail_settings_err_fields");
    if (cause.code === "MAIL_VERIFY_FAILED") {
      return `${t("mail_settings_err_verify")}: ${cause.message}`;
    }
    return errorText(cause.code) ?? cause.message;
  };

  const save = () => {
    const problems = validate();
    if (problems.length > 0) {
      setError(problems.join(" "));
      return;
    }
    setBusy(true);
    setError(null);
    apiPut<MailSettingsWire>("/mail/settings", {
      enabled,
      from: from.trim(),
      host: host.trim(),
      ...(port === "" ? {} : { port: Number(port) }),
      mode,
      ...(username === "" ? {} : { username }),
      ...(password === "" ? {} : { password }),
    })
      .then((wire) => {
        setState(wire);
        setPassword("");
        setBusy(false);
        toast(t("mail_settings_saved"), wire.enabled ? "success" : "info");
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(cause instanceof ApiError ? humanSaveError(cause) : (cause as Error).message);
      });
  };

  const runTest = () => {
    setTestOk(null);
    setTestAuth(null);
    setError(null);
    // Probe the values currently typed in the form (owner rule): the stored
    // password fills in server-side when none is typed, and nothing is
    // persisted by a probe.
    void apiPost<MailTestWire>("/mail/test", {
      ...(host.trim() === "" ? {} : { host: host.trim() }),
      ...(port === "" ? {} : { port: Number(port) }),
      mode,
      ...(username === "" ? {} : { username }),
      ...(password === "" ? {} : { password }),
    })
      .then((result) => {
        setTestOk(true);
        setTestAuth(result.verified?.authenticated ?? null);
      })
      .catch((cause: unknown) => {
        setTestOk(false);
        setError(
          cause instanceof ApiError
            ? `${t("mail_settings_err_verify")}: ${cause.message}`
            : (cause as Error).message,
        );
      });
  };

  if (loadError !== null) return <ErrorPanel message={loadError} />;
  if (state === null) return <Spinner />;

  return (
    <Card title={t("mail_settings_title")}>
      <p className="pcms-field__hint">{t("mail_settings_description")}</p>
      {state.enabled ? (
        <p>
          <Badge tone="success">{t("mail_settings_state_on")}</Badge>
        </p>
      ) : null}
      <div className="pcms-form-grid pcms-form-grid--single">
        <Switch checked={enabled} onChange={setEnabled} label={t("mail_settings_enabled")} />
        <Field label={t("mail_settings_from")} required>
          <Input
            value={from}
            maxLength={320}
            placeholder="cms@example.com"
            disabled={!canEdit}
            onChange={(event) => setFrom(event.target.value)}
          />
        </Field>
        <div className="pcms-form-grid">
          <Field label={t("mail_settings_host")} required>
            <Input
              value={host}
              maxLength={253}
              placeholder="smtp.example.com"
              disabled={!canEdit}
              onChange={(event) => setHost(event.target.value)}
            />
          </Field>
          <Field label={t("mail_settings_port")} hint={t("mail_settings_port_auto_hint")}>
            <Input
              value={port}
              inputMode="numeric"
              placeholder={MODE_DEFAULT_PORT[mode] ?? ""}
              disabled={!canEdit}
              onChange={(event) => changePort(event.target.value)}
            />
          </Field>
          <Field
            label={t("mail_settings_mode")}
            hint={t(MODE_HINT_KEYS[mode] ?? "integrations.mode_starttls_hint")}
          >
            <Select
              value={mode}
              disabled={!canEdit}
              onChange={(event) => changeMode(event.target.value as "smtps" | "starttls" | "plain")}
            >
              <option value="starttls">{t("integrations.mode_starttls")}</option>
              <option value="smtps">{t("integrations.mode_smtps")}</option>
              <option value="plain">{t("integrations.mode_plain")}</option>
            </Select>
          </Field>
        </div>
        <div className="pcms-form-grid">
          <Field label={t("mail_settings_username")}>
            <Input
              value={username}
              maxLength={320}
              autoComplete="off"
              disabled={!canEdit}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field
            label={t("mail_settings_password")}
            hint={
              state.password_set
                ? t("mail_settings_password_stored")
                : state.encryption_ready
                  ? t("mail_settings_password_hint")
                  : t("integrations.secret_store_missing")
            }
          >
            <Input
              type="password"
              value={password}
              maxLength={1024}
              autoComplete="new-password"
              placeholder={state.password_set ? "••••••••" : ""}
              disabled={!canEdit || !state.encryption_ready}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        </div>
      </div>
      <div className="pcms-actions-row">
        {canEdit ? (
          <Button variant="primary" disabled={busy} onClick={save}>
            {busy ? t("saving") : t("mail_settings_save")}
          </Button>
        ) : null}
        {canTest ? (
          <Button variant="ghost" disabled={busy} onClick={runTest}>
            <Icon name="preview" /> {t("mail_settings_test")}
          </Button>
        ) : null}
        {testOk !== null ? (
          <Badge tone={testOk ? "success" : "danger"}>
            {testOk
              ? testAuth === false
                ? t("mail_settings_test_no_auth")
                : t("mail_settings_test_ok")
              : t("mail_settings_test_failed")}
          </Badge>
        ) : null}
      </div>
      {error !== null ? (
        <div className="pcms-field__error" role="alert">
          {error}
        </div>
      ) : null}
      <p className="pcms-field__hint">
        {state.updated_at === null
          ? ""
          : `${t("mail_settings_updated")}: ${new Date(state.updated_at).toLocaleString()} · ${state.updated_by}`}
      </p>
    </Card>
  );
}

/** Per-instance runtime secret editor (PCMS-OPS-T131): write-only inputs for
 * the connector's declared requirements; stored keys are visible, values are
 * never rendered back. Gated by integrations.secrets.manage. */
function InstanceSecretsRow(props: {
  readonly instance: InstanceWire;
  readonly requirements: readonly { readonly name: string; readonly description: string }[];
  readonly canManage: boolean;
  readonly onChanged: () => void;
}) {
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const requirements = props.requirements.filter(
    (requirement, index, all) =>
      all.findIndex((candidate) => candidate.name === requirement.name) === index,
  );
  if (requirements.length === 0) return null;
  const save = (key: string) => {
    const value = values[key];
    if (value === undefined || value === "") return;
    setBusy(true);
    apiPut<InstanceWire>(`/integrations/instances/${props.instance.id}/secrets/${key}`, {
      value,
    })
      .then(() => {
        setValues((current) => ({ ...current, [key]: "" }));
        setBusy(false);
        toast(t("instance_secret_saved"), "success");
        props.onChanged();
      })
      .catch((cause: Error) => {
        setBusy(false);
        toast(errorText(cause.message) ?? cause.message, "error");
      });
  };
  const clear = (key: string) => {
    setBusy(true);
    apiDelete(`/integrations/instances/${props.instance.id}/secrets/${key}`)
      .then(() => {
        setBusy(false);
        toast(t("instance_secret_cleared"), "info");
        props.onChanged();
      })
      .catch((cause: Error) => {
        setBusy(false);
        toast(cause.message, "error");
      });
  };
  return (
    <div className="pcms-instance-secrets">
      <span className="pcms-field__hint">{t("instance_secrets_title")}</span>
      {requirements.map((requirement) => {
        const stored = props.instance.runtime_secrets.includes(requirement.name);
        return (
          <span
            key={requirement.name}
            className="pcms-row"
            data-testid={`secret-${requirement.name}`}
          >
            <code>{requirement.name}</code>
            {stored ? <Badge tone="success">{t("instance_secret_stored")}</Badge> : null}
            {props.canManage ? (
              <>
                <Input
                  type="password"
                  autoComplete="new-password"
                  aria-label={`${t("instance_secret_value")} ${requirement.name}`}
                  placeholder={stored ? "••••••••" : ""}
                  value={values[requirement.name] ?? ""}
                  maxLength={4096}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [requirement.name]: event.target.value }))
                  }
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || (values[requirement.name] ?? "") === ""}
                  onClick={() => save(requirement.name)}
                >
                  {t("instance_secret_set")}
                </Button>
                {stored ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => clear(requirement.name)}
                  >
                    {t("instance_secret_clear")}
                  </Button>
                ) : null}
              </>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

function connectorTitle(connectors: readonly ConnectorSummary[], connectorType: string): string {
  return (
    connectors.find((connector) => connector.connector_type === connectorType)?.title ??
    connectorType
  );
}

/** One typed config field generated from the connector's declared JSON
 * schema (no per-connector hardcoding): string/enum/number/boolean inputs;
 * object/array values are edited as JSON. */
function ConfigField(props: {
  readonly connectorType: string;
  readonly name: string;
  readonly schema: Record<string, unknown>;
  readonly required: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const type =
    typeof props.schema["type"] === "string" ? (props.schema["type"] as string) : "string";
  const enumerated = Array.isArray(props.schema["enum"])
    ? (props.schema["enum"] as readonly string[])
    : null;
  const labelKey = fieldLabelKey(props.connectorType, props.name);
  const label = labelKey === null ? props.name : t(labelKey);
  const localizedHint = labelKey === null ? null : t(`${labelKey}_hint`);
  const hint = [
    localizedHint ??
      (typeof props.schema["description"] === "string"
        ? (props.schema["description"] as string)
        : ""),
    props.schema["format"] === "uri" && localizedHint === null ? "https://…" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Field label={label} {...(hint === "" ? {} : { hint })} required={props.required}>
      {enumerated !== null ? (
        <Select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
          <option value=""></option>
          {enumerated.map((option) => (
            <option key={option} value={option}>
              {option === "" ? "—" : option}
            </option>
          ))}
        </Select>
      ) : type === "boolean" ? (
        <Select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
          <option value=""></option>
          <option value="true">{t("integrations.field_on")}</option>
          <option value="false">{t("integrations.field_off")}</option>
        </Select>
      ) : type === "integer" || type === "number" ? (
        <Input
          inputMode="numeric"
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        />
      ) : type === "object" || type === "array" ? (
        <Input
          value={props.value}
          placeholder="{ … }"
          onChange={(event) => props.onChange(event.target.value)}
        />
      ) : (
        <Input
          value={props.value}
          maxLength={
            typeof props.schema["maxLength"] === "number"
              ? (props.schema["maxLength"] as number)
              : undefined
          }
          placeholder={props.schema["format"] === "uri" ? "https://" : ""}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

function parseConfigValue(schema: Record<string, unknown>, raw: string): unknown {
  const type = typeof schema["type"] === "string" ? (schema["type"] as string) : "string";
  if (raw === "") return undefined;
  if (type === "integer" || type === "number") return Number(raw);
  if (type === "boolean") return raw === "true";
  if (type === "object" || type === "array") return JSON.parse(raw);
  return raw;
}

/**
 * Human labels/hints per connector field (owner UX fix): the schema keys are
 * machine identifiers — operators get localized questions-and-answers about
 * what a field is, why it exists and where the value comes from. Unknown
 * fields fall back to the raw key + schema description.
 */
const FIELD_LABEL_KEYS: ReadonlyMap<string, string> = new Map([
  ["progressive-hq.base_url", "integrations.f.hq.base_url"],
  ["progressive-hq.slug", "integrations.f.hq.slug"],
  ["progressive-hq.source_site", "integrations.f.hq.source_site"],
  ["progressive-hq.timeout_ms", "integrations.f.hq.timeout_ms"],
  ["progressive-hq.signing_secret", "integrations.f.hq.signing_secret"],
  ["progressive-hq.send_attribution", "integrations.f.hq.send_attribution"],
  ["email.from", "integrations.f.email.from"],
  ["email.reply_to", "integrations.f.email.reply_to"],
  ["email.transport", "integrations.f.email.transport"],
  ["telegram.default_chat_id", "integrations.f.tg.chat"],
  ["telegram.disable_web_page_preview", "integrations.f.tg.preview"],
  ["telegram.bot_token", "integrations.f.tg.token"],
  ["nextcloud-talk.base_url", "integrations.f.talk.base_url"],
  ["nextcloud-talk.room_token", "integrations.f.talk.room"],
  ["webhook-http.url", "integrations.f.wh.url"],
  ["webhook-http.method", "integrations.f.wh.method"],
  ["webhook-http.timeout_ms", "integrations.f.wh.timeout"],
  ["bitrix24.portal_url", "integrations.f.b24.portal"],
  ["bitrix24.user_id", "integrations.f.b24.user"],
  ["bitrix24.timeout_ms", "integrations.f.b24.timeout"],
  ["bitrix24.webhook_code", "integrations.f.b24.code"],
  ["amocrm.domain", "integrations.f.amo.domain"],
  ["amocrm.pipeline_id", "integrations.f.amo.pipeline"],
  ["amocrm.presentation_field_id", "integrations.f.amo.presentation"],
  ["amocrm.timeout_ms", "integrations.f.amo.timeout"],
  ["amocrm.access_token", "integrations.f.amo.token"],
]);

/** Localized connector descriptions (fallback: the definition's English text). */
const CONNECTOR_DESC_KEYS: ReadonlyMap<string, string> = new Map([
  ["progressive-hq", "integrations.desc.progressive-hq"],
  ["email", "integrations.desc.email"],
  ["telegram", "integrations.desc.telegram"],
  ["nextcloud-talk", "integrations.desc.nextcloud-talk"],
  ["webhook-http", "integrations.desc.webhook-http"],
  ["bitrix24", "integrations.desc.bitrix24"],
  ["amocrm", "integrations.desc.amocrm"],
]);

function fieldLabelKey(connectorType: string, field: string): string | null {
  const direct = FIELD_LABEL_KEYS.get(`${connectorType}.${field}`);
  return direct ?? null;
}

/** Typed connection editor (owner rule: the Admin owner creates normal
 * connections through the UI — never through REST/MCP). Fields are
 * generated from the connector registry's declared schema; secrets are
 * write-only inputs stored via the runtime secret store. */
function CreateConnectionDialog(props: {
  readonly connectors: readonly ConnectorSummary[];
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const toast = useToast();
  const [connectorType, setConnectorType] = useState(props.connectors[0]?.connector_type ?? "");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testOutcome, setTestOutcome] = useState<string | null>(null);

  const connector = props.connectors.find((item) => item.connector_type === connectorType);
  const schema = (connector?.config_schema ?? {}) as Record<string, unknown>;
  const properties = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [];

  const buildConfig = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(config)) {
      if (raw === "") continue;
      const propertySchema = properties[key];
      if (propertySchema === undefined) {
        out[key] = raw;
        continue;
      }
      const type =
        typeof propertySchema["type"] === "string" ? (propertySchema["type"] as string) : "string";
      if (type === "integer" || type === "number") out[key] = Number(raw);
      else if (type === "boolean") out[key] = raw === "true";
      else if (type === "object" || type === "array") out[key] = JSON.parse(raw);
      else out[key] = raw;
    }
    return out;
  };

  const submit = () => {
    if (connector === undefined || name.trim() === "") return;
    try {
      setBusy(true);
      setError(null);
      setTestOutcome(null);
      void (async () => {
        const created = await apiPost<InstanceWire>("/integrations/instances", {
          connector_type: connector.connector_type,
          name: name.trim(),
          enabled: true,
          config: buildConfig(),
        });
        for (const requirement of connector.secrets) {
          const value = secrets[requirement.name];
          if (value === undefined || value === "") continue;
          await apiPut(`/integrations/instances/${created.id}/secrets/${requirement.name}`, {
            value,
          });
        }
        let outcome = t("integrations.connection_created");
        if (connector.testable) {
          const test = await apiPost<{ ok: boolean; message?: string; code?: string }>(
            `/integrations/instances/${created.id}/test`,
          );
          outcome = test.ok
            ? t("integrations.connection_test_ok")
            : `${t("integrations.connection_test_failed")}: ${test.message ?? test.code ?? ""}`;
        }
        setTestOutcome(outcome);
        toast(t("integrations.connection_created"), "success");
        props.onCreated();
        props.onClose();
      })().catch((cause: unknown) => {
        setBusy(false);
        if (cause instanceof ApiError) {
          setError(
            cause.code === "INTEGRATION_RUNTIME_SECRETS_NOT_CONFIGURED" ||
              cause.code === "MAIL_ENCRYPTION_NOT_CONFIGURED"
              ? t("integrations.secret_store_missing")
              : (errorText(cause.code) ?? cause.message),
          );
        } else if (cause instanceof SyntaxError) {
          setError(t("integrations.connection_config_json_invalid"));
        } else {
          setError((cause as Error).message);
        }
      });
    } catch (cause) {
      setBusy(false);
      setError(
        cause instanceof SyntaxError
          ? t("integrations.connection_config_json_invalid")
          : (cause as Error).message,
      );
    }
  };

  return (
    <Dialog open onClose={props.onClose} title={t("integrations.create_connection_title")} wide>
      <Field label={t("integrations.connection_type_label")} required>
        <Select value={connectorType} onChange={(event) => setConnectorType(event.target.value)}>
          {props.connectors.map((item) => (
            <option key={item.connector_type} value={item.connector_type}>
              {item.title}
            </option>
          ))}
        </Select>
      </Field>
      {connector !== undefined ? (
        <p className="pcms-field__hint">
          {CONNECTOR_DESC_KEYS.has(connector.connector_type)
            ? t(CONNECTOR_DESC_KEYS.get(connector.connector_type) ?? "")
            : connector.description}
        </p>
      ) : null}
      <Field label={t("integrations.connection_name_label")} required>
        <Input
          value={name}
          maxLength={120}
          placeholder={connector?.title}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      {Object.entries(properties).length > 0 ? (
        <h4>{t("integrations.connection_config_title")}</h4>
      ) : null}
      {Object.entries(properties).map(([key, propertySchema]) => (
        <ConfigField
          key={key}
          connectorType={connectorType}
          name={key}
          schema={propertySchema}
          required={required.includes(key)}
          value={config[key] ?? ""}
          onChange={(value) => setConfig((current) => ({ ...current, [key]: value }))}
        />
      ))}
      {connector !== undefined && connector.secrets.length > 0 ? (
        <>
          <h4>{t("integrations.connection_secrets_title")}</h4>
          {connector.secrets.map((requirement) => {
            const secretKey = fieldLabelKey(connector.connector_type, requirement.name);
            return (
              <Field
                key={requirement.name}
                label={secretKey === null ? requirement.name : t(secretKey)}
                hint={secretKey === null ? requirement.description : t(`${secretKey}_hint`)}
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={secrets[requirement.name] ?? ""}
                  onChange={(event) =>
                    setSecrets((current) => ({
                      ...current,
                      [requirement.name]: event.target.value,
                    }))
                  }
                />
              </Field>
            );
          })}
        </>
      ) : null}
      {error !== null ? (
        <div className="pcms-field__error" role="alert">
          {error}
        </div>
      ) : null}
      {testOutcome !== null ? <p className="pcms-field__hint">{testOutcome}</p> : null}
      <div className="pcms-actions-row">
        <Button onClick={props.onClose}>{t("cancel")}</Button>
        <Button
          variant="primary"
          disabled={busy || connector === undefined || name.trim() === ""}
          onClick={submit}
        >
          {busy ? t("saving") : t("integrations.connection_save_test")}
        </Button>
      </div>
    </Dialog>
  );
}

function ConnectionsTab() {
  const auth = useAuth();
  const [instances, setInstances] = useState<InstanceWire[] | null>(null);
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null>(null);
  const [editInstance, setEditInstance] = useState<InstanceWire | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; message: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void Promise.all([
      apiGet<{ items: InstanceWire[] }>("/integrations/instances"),
      apiGet<{ items: ConnectorSummary[] }>("/integrations/connectors"),
    ])
      .then(([instancesPage, connectorsPage]) => {
        setInstances(instancesPage.items);
        setConnectors(connectorsPage.items);
      })
      .catch((cause: Error) => setError(cause.message));
  }, []);
  useEffect(load, [load]);
  if (error !== null) return <ErrorPanel message={error} />;
  if (instances === null || connectors === null) return <Spinner />;
  return (
    <div className="pcms-stack">
      {auth.can("integrations.configure") && connectors.length > 0 ? (
        <Card title={t("integrations.connect_section_title")}>
          <p className="pcms-field__hint pcms-connect-text">
            {t("integrations.connect_section_text")}
          </p>
          <Button
            className="pcms-connect-big"
            variant="primary"
            onClick={() => setCreateOpen(true)}
          >
            <Icon name="plus" /> {t("integrations.connect_button")}
          </Button>
        </Card>
      ) : null}
      {createOpen ? (
        <CreateConnectionDialog
          connectors={connectors}
          onClose={() => setCreateOpen(false)}
          onCreated={load}
        />
      ) : null}
      {editInstance !== null ? (
        <EditConnectionDialog
          instance={editInstance}
          onClose={() => setEditInstance(null)}
          onSaved={load}
        />
      ) : null}
      {instances.length === 0 ? (
        <EmptyState
          title={t("integrations.instances_empty_title")}
          hint={t("integrations.instances_empty_hint")}
        />
      ) : (
        instances.map((instance) => (
          <Card key={instance.id} title={instance.name}>
            <div className="pcms-row" data-testid={`connection-${instance.name}`}>
              <Badge tone={instance.enabled ? "success" : "neutral"}>
                {instance.enabled
                  ? t("integrations.state_enabled")
                  : t("integrations.state_disabled")}
              </Badge>
              <span>
                {connectorTitle(connectors, instance.connector_type)}
                <span className="pcms-picker-row__meta"> · {instance.connector_type}</span>
              </span>
              {Object.keys(instance.secret_refs).length > 0 ? (
                <span>
                  {t("integrations.secret_refs")} {Object.keys(instance.secret_refs).join(", ")}{" "}
                  {t("integrations.secret_refs_note")}
                </span>
              ) : (
                <span>{t("integrations.no_secrets")}</span>
              )}
              {auth.can("integrations.configure") && (
                <Tooltip content={t("integrations.edit_connection_hint")}>
                  <Button onClick={() => setEditInstance(instance)}>
                    <Icon name="edit" /> {t("integrations.edit_connection")}
                  </Button>
                </Tooltip>
              )}
              {auth.can("integrations.test") && (
                <Button
                  onClick={() => {
                    void apiPost<{ ok: boolean; message?: string; code?: string }>(
                      `/integrations/instances/${instance.id}/test`,
                    )
                      .then((outcome) =>
                        setTestResult({
                          id: instance.id,
                          ok: outcome.ok,
                          message: outcome.ok
                            ? t("integrations.connection_test_ok")
                            : (outcome.message ?? outcome.code ?? t("integrations.error_fallback")),
                        }),
                      )
                      .catch((cause: Error) => setError(cause.message));
                  }}
                >
                  {t("integrations.test")}
                </Button>
              )}
              {testResult?.id === instance.id && (
                <Badge tone={testResult.ok ? "success" : "danger"}>{testResult.message}</Badge>
              )}
            </div>
            <InstanceSecretsRow
              instance={instance}
              requirements={
                connectors?.find(
                  (connector) => connector.connector_type === instance.connector_type,
                )?.secrets ?? []
              }
              canManage={auth.can("integrations.secrets.manage")}
              onChanged={load}
            />
          </Card>
        ))
      )}
    </div>
  );
}

/** Edit an existing connection: name + non-secret config (prefilled);
 * secrets stay write-only — enter a value only to replace one. */
function EditConnectionDialog(props: {
  readonly instance: InstanceWire;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const toast = useToast();
  const [connectors, setConnectors] = useState<ConnectorSummary[]>([]);
  useEffect(() => {
    apiGet<{ items: ConnectorSummary[] }>("/integrations/connectors")
      .then((result) => setConnectors(result.items))
      .catch(() => undefined);
  }, []);
  const connector = connectors.find(
    (item) => item.connector_type === props.instance.connector_type,
  );
  const schema = (connector?.config_schema ?? {}) as Record<string, unknown>;
  const properties = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
  const [name, setName] = useState(props.instance.name);
  const [config, setConfig] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const [key, value] of Object.entries(props.instance.config ?? {})) {
      if (typeof value === "object" && value !== null)
        initial[key] = JSON.stringify(value, null, 2);
      else initial[key] = String(value);
    }
    return initial;
  });
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildConfig = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(config)) {
      if (raw === "") continue;
      const propertySchema = properties[key];
      if (propertySchema === undefined) {
        out[key] = raw;
        continue;
      }
      const type =
        typeof propertySchema["type"] === "string" ? (propertySchema["type"] as string) : "string";
      if (type === "integer" || type === "number") out[key] = Number(raw);
      else if (type === "boolean") out[key] = raw === "true";
      else if (type === "object" || type === "array") out[key] = JSON.parse(raw);
      else out[key] = raw;
    }
    return out;
  };

  const submit = () => {
    setBusy(true);
    setError(null);
    void (async () => {
      await apiPatch(`/integrations/instances/${props.instance.id}`, {
        name: name.trim(),
        enabled: props.instance.enabled,
        config: buildConfig(),
      });
      for (const requirement of connector?.secrets ?? []) {
        const value = secrets[requirement.name];
        if (value === undefined || value === "") continue;
        await apiPut(`/integrations/instances/${props.instance.id}/secrets/${requirement.name}`, {
          value,
        });
      }
      toast(t("integrations.connection_updated"), "success");
      props.onSaved();
      props.onClose();
    })().catch((cause: unknown) => {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={`${t("integrations.edit_connection_title")} ${props.instance.name}`}
      wide
    >
      <Field label={t("integrations.connection_name_label")} required>
        <Input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
      </Field>
      {Object.entries(properties).length > 0 ? (
        <h4>{t("integrations.connection_config_title")}</h4>
      ) : null}
      {Object.entries(properties).map(([key, propertySchema]) => (
        <ConfigField
          key={key}
          connectorType={props.instance.connector_type}
          name={key}
          schema={propertySchema}
          required={(Array.isArray(schema["required"])
            ? (schema["required"] as string[])
            : []
          ).includes(key)}
          value={config[key] ?? ""}
          onChange={(value) => setConfig((current) => ({ ...current, [key]: value }))}
        />
      ))}
      {connector !== undefined && connector.secrets.length > 0 ? (
        <>
          <h4>{t("integrations.connection_secrets_title")}</h4>
          <p className="pcms-field__hint">{t("integrations.edit_secrets_hint")}</p>
          {connector.secrets.map((requirement) => {
            const secretKey = fieldLabelKey(connector.connector_type, requirement.name);
            return (
              <Field
                key={requirement.name}
                label={secretKey === null ? requirement.name : t(secretKey)}
                hint={
                  props.instance.runtime_secrets.includes(requirement.name)
                    ? t("integrations.secret_already_set")
                    : secretKey === null
                      ? requirement.description
                      : t(`${secretKey}_hint`)
                }
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    props.instance.runtime_secrets.includes(requirement.name)
                      ? t("integrations.secret_replace_placeholder")
                      : ""
                  }
                  value={secrets[requirement.name] ?? ""}
                  onChange={(event) =>
                    setSecrets((current) => ({
                      ...current,
                      [requirement.name]: event.target.value,
                    }))
                  }
                />
              </Field>
            );
          })}
        </>
      ) : null}
      {error !== null ? (
        <div className="pcms-field__error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="pcms-toolbar" style={{ marginTop: 16 }}>
        <span className="pcms-toolbar__spacer" />
        <Button variant="ghost" onClick={props.onClose}>
          {t("cancel")}
        </Button>
        <Button variant="primary" disabled={busy} onClick={submit}>
          {t("integrations.save_connection")}
        </Button>
      </div>
    </Dialog>
  );
}

/** Human event labels (owner rule: working concepts, not event names). The
 * technical event_type stays as secondary metadata. */
const EVENT_LABEL_KEYS: Readonly<Record<string, string>> = {
  LeadCreated: "integrations.event_lead_created",
  FormSubmitted: "integrations.event_form_submitted",
  QuizCompleted: "integrations.event_quiz_completed",
  QuizStarted: "integrations.event_quiz_started",
  QuizAbandoned: "integrations.event_quiz_abandoned",
  LeadStatusChanged: "integrations.event_lead_status_changed",
  PaymentStatusChanged: "integrations.event_payment_status_changed",
};

export function humanEvent(eventType: string): string {
  const key = EVENT_LABEL_KEYS[eventType];
  return key === undefined ? eventType : t(key);
}

const NOTIFY_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  LeadCreated: "integrations.notify_lead_created",
  FormSubmitted: "integrations.notify_form_submitted",
  QuizCompleted: "integrations.notify_quiz_completed",
};

/** Default action per (connector, event) — the one sensible thing a binding
 * between them can do. Null = no automatic action; exotic mappings stay on
 * the API/MCP surface. */
function defaultActionFor(
  connectorType: string,
  eventType: string,
  emailDestination: string,
): { readonly actionType: string; readonly payloadMapping: Record<string, unknown> } | null {
  const message = t(NOTIFY_MESSAGE_KEYS[eventType] ?? "integrations.notify_generic", {
    event: humanEvent(eventType),
  });
  switch (connectorType) {
    case "progressive-hq":
      if (eventType !== "LeadCreated") return null;
      return {
        actionType: "intake_lead",
        payloadMapping: {
          lead_id: { $event: "lead_id" },
          source_type: { $event: "source_type" },
          source_id: { $event: "source_id" },
          classification: { $event: "classification" },
        },
      };
    case "telegram":
      return { actionType: "send_message", payloadMapping: { text: { $literal: message } } };
    case "nextcloud-talk":
      return { actionType: "post_message", payloadMapping: { message: { $literal: message } } };
    case "webhook-http":
      return { actionType: "notify", payloadMapping: { text: { $literal: message } } };
    case "email":
      return emailDestination.trim() === ""
        ? null
        : {
            actionType: "send_message",
            payloadMapping: {
              to: { $literal: emailDestination.trim() },
              subject: { $literal: message },
              text: { $literal: message },
            },
          };
    default:
      return null;
  }
}

export function deliveryStatusLabel(status: string): string {
  const key = STATUS_LABEL_KEYS[status];
  return key === undefined ? status : t(key);
}

function BindingsTab() {
  const auth = useAuth();
  const [bindings, setBindings] = useState<BindingWire[] | null>(null);
  const [instances, setInstances] = useState<InstanceWire[] | null>(null);
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void Promise.all([
      apiGet<{ items: BindingWire[] }>("/integrations/bindings"),
      apiGet<{ items: InstanceWire[] }>("/integrations/instances"),
      apiGet<{ items: ConnectorSummary[] }>("/integrations/connectors"),
    ])
      .then(([bindingsPage, instancesPage, connectorsPage]) => {
        setBindings(bindingsPage.items);
        setInstances(instancesPage.items);
        setConnectors(connectorsPage.items);
      })
      .catch((cause: Error) => setError(cause.message));
  }, []);
  useEffect(load, [load]);
  if (error !== null) return <ErrorPanel message={error} />;
  if (bindings === null || instances === null || connectors === null) return <Spinner />;
  return (
    <div className="pcms-stack">
      {auth.can("integrations.configure") && instances.length > 0 ? (
        <div className="pcms-toolbar">
          <span className="pcms-toolbar__spacer" />
          <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
            {t("integrations.add_binding")}
          </Button>
        </div>
      ) : null}
      {createOpen ? (
        <CreateBindingDialog
          instances={instances}
          connectors={connectors}
          onClose={() => setCreateOpen(false)}
          onCreated={load}
        />
      ) : null}
      {bindings.length === 0 ? (
        <EmptyState
          title={t("integrations.bindings_empty_title")}
          hint={t("integrations.bindings_empty_hint")}
        />
      ) : (
        bindings.map((binding) => (
          <Card key={binding.id} title={humanEvent(binding.event_type)}>
            <div className="pcms-row">
              <Badge tone={binding.enabled ? "success" : "neutral"}>
                {binding.enabled
                  ? t("integrations.binding_enabled")
                  : t("integrations.binding_disabled")}
              </Badge>
              <span className="pcms-picker-row__meta">{binding.event_type}</span>
              <span>
                {t("integrations.actions_count")} {binding.actions.length}
              </span>
              {binding.actions.map((action, index) => {
                const record = action as { readonly instance_id?: string };
                const instance = instances.find((item) => item.id === record.instance_id);
                return (
                  <span key={record.instance_id ?? index}>
                    {instance === undefined
                      ? "—"
                      : `${instance.name} · ${connectorTitle(connectors, instance.connector_type)}`}
                  </span>
                );
              })}
            </div>
          </Card>
        ))
      )}
    </div>
  );
}

/** Human binding flow (owner sketch): WHEN (event) → WHERE (connection).
 * Optional filters and exotic mappings stay behind the API/MCP surface —
 * no rules engine invented here. */
function CreateBindingDialog(props: {
  readonly instances: readonly InstanceWire[];
  readonly connectors: readonly ConnectorSummary[];
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const toast = useToast();
  const [eventType, setEventType] = useState("LeadCreated");
  const [instanceId, setInstanceId] = useState(props.instances[0]?.id ?? "");
  const [emailDestination, setEmailDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const instance = props.instances.find((item) => item.id === instanceId);
  const connectorType = instance?.connector_type ?? "";
  const action =
    instance === undefined ? null : defaultActionFor(connectorType, eventType, emailDestination);

  const submit = () => {
    if (action === null) return;
    setBusy(true);
    setError(null);
    void apiPost("/integrations/bindings", {
      event_type: eventType,
      enabled: true,
      actions: [
        {
          instance_id: instanceId,
          action_type: action.actionType,
          payload_mapping: action.payloadMapping,
        },
      ],
    })
      .then(() => {
        setBusy(false);
        toast(t("integrations.binding_created"), "success");
        props.onCreated();
        props.onClose();
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(
          cause instanceof ApiError
            ? (errorText(cause.code) ?? cause.message)
            : (cause as Error).message,
        );
      });
  };

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t("integrations.binding_create_title")}
      footer={
        <>
          <Button onClick={props.onClose}>{t("cancel")}</Button>
          <Button variant="primary" disabled={busy || action === null} onClick={submit}>
            {t("save")}
          </Button>
        </>
      }
    >
      <Field label={t("integrations.binding_when")} required>
        <Select value={eventType} onChange={(event) => setEventType(event.target.value)}>
          {Object.keys(EVENT_LABEL_KEYS).map((type) => (
            <option key={type} value={type}>
              {humanEvent(type)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("integrations.binding_where")} required>
        <Select value={instanceId} onChange={(event) => setInstanceId(event.target.value)}>
          {props.instances.map((item) => (
            <option key={item.id} value={item.id}>
              {`${item.name} — ${connectorTitle(props.connectors, item.connector_type)}`}
            </option>
          ))}
        </Select>
      </Field>
      {connectorType === "email" ? (
        <Field label={t("integrations.binding_email_destination")} required>
          <Input
            value={emailDestination}
            maxLength={320}
            placeholder="cms@example.com"
            onChange={(event) => setEmailDestination(event.target.value)}
          />
        </Field>
      ) : null}
      <p className="pcms-field__hint">
        {action === null
          ? t("integrations.binding_no_default_action")
          : `${t("integrations.binding_action_preview")}: ${action.actionType}`}
        {action === null ? null : (
          <span className="pcms-picker-row__meta">
            {" "}
            · {humanEvent(eventType)} ({eventType})
          </span>
        )}
      </p>
      {error !== null ? (
        <div className="pcms-field__error" role="alert">
          {error}
        </div>
      ) : null}
    </Dialog>
  );
}

function DeliveriesTab(props: { readonly failuresOnly?: boolean }) {
  const auth = useAuth();
  const [deliveries, setDeliveries] = useState<DeliveryWire[] | null>(null);
  const [instances, setInstances] = useState<InstanceWire[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attemptsFor, setAttemptsFor] = useState<{ id: string; attempts: AttemptWire[] } | null>(
    null,
  );
  const load = useCallback(() => {
    // The list op filters by a single status: the failures view must merge
    // both failure states or permanent dead-letters stay invisible here.
    const failuresPage = props.failuresOnly
      ? Promise.all([
          apiGet<{ items: DeliveryWire[] }>("/integrations/deliveries?status=FAILED_RETRYABLE"),
          apiGet<{ items: DeliveryWire[] }>("/integrations/deliveries?status=FAILED_PERMANENT"),
        ]).then(([retryable, permanent]) => ({
          items: [...retryable.items, ...permanent.items],
        }))
      : apiGet<{ items: DeliveryWire[] }>("/integrations/deliveries");
    void Promise.all([failuresPage, apiGet<{ items: InstanceWire[] }>("/integrations/instances")])
      .then(([deliveriesPage, instancesPage]) => {
        setDeliveries(deliveriesPage.items);
        setInstances(instancesPage.items);
      })
      .catch((cause: Error) => setError(cause.message));
  }, [props.failuresOnly]);
  useEffect(() => {
    load();
  }, [load]);
  if (error !== null) return <ErrorPanel message={error} />;
  if (deliveries === null || instances === null) return <Spinner />;
  if (deliveries.length === 0) {
    return (
      <EmptyState
        title={
          props.failuresOnly === true
            ? t("integrations.deliveries_empty_failures")
            : t("integrations.deliveries_empty_none")
        }
        hint={t("integrations.deliveries_empty_hint")}
      />
    );
  }
  return (
    <div
      className="pcms-stack"
      data-testid={props.failuresOnly === true ? "delivery-failures" : "delivery-list"}
    >
      {deliveries.map((delivery) => {
        const instance = instances.find((item) => item.id === delivery.instance_id);
        return (
          <Card key={delivery.id} title={humanEvent(delivery.event_type)}>
            <div className="pcms-row">
              <StatusBadge status={delivery.status} />
              <span>{instance?.name ?? delivery.instance_id}</span>
              <span>
                {t("integrations.attempts")} {delivery.attempt_count}/{delivery.max_attempts}
              </span>
              {delivery.external_id !== undefined && delivery.external_id !== null ? (
                <span className="pcms-picker-row__meta">
                  {t("integrations.external_id")}: {delivery.external_id}
                </span>
              ) : null}
              {delivery.last_error_code !== null && delivery.last_error_code !== undefined && (
                <Badge tone="danger">{delivery.last_error_code}</Badge>
              )}
              {auth.can("integrations.deliveries.read") && (
                <Button
                  onClick={() => {
                    void apiGet<{ attempts: AttemptWire[] }>(
                      `/integrations/deliveries/${delivery.id}`,
                    )
                      .then((detail) =>
                        setAttemptsFor({ id: delivery.id, attempts: detail.attempts }),
                      )
                      .catch((cause: Error) => setError(cause.message));
                  }}
                >
                  {t("integrations.attempts_history")}
                </Button>
              )}
              {auth.can("integrations.retry") && (
                <Button
                  onClick={() => {
                    void apiPost(`/integrations/deliveries/${delivery.id}/retry`)
                      .then(load)
                      .catch((cause: Error) => setError(cause.message));
                  }}
                >
                  {t("integrations.retry")}
                </Button>
              )}
            </div>
            {attemptsFor?.id === delivery.id && (
              <ul data-testid="attempt-history">
                {attemptsFor.attempts.map((attempt) => (
                  <li key={attempt.attempt_no}>
                    {t("integrations.attempt")} {attempt.attempt_no}:{" "}
                    {deliveryStatusLabel(attempt.result)}
                    {attempt.provider_error_code !== null
                      ? ` — ${attempt.provider_error_code}`
                      : ""}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function InboundTab() {
  const [events, setEvents] = useState<InboundWire[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void apiGet<{ items: InboundWire[] }>("/integrations/inbound-events")
      .then((page) => setEvents(page.items))
      .catch((cause: Error) => setError(cause.message));
  }, []);
  if (error !== null) return <ErrorPanel message={error} />;
  if (events === null) return <Spinner />;
  if (events.length === 0) {
    return (
      <EmptyState
        title={t("integrations.inbound_empty_title")}
        hint={t("integrations.inbound_empty_hint")}
      />
    );
  }
  return (
    <div className="pcms-stack">
      {events.map((event) => (
        <Card key={event.id} title={event.event_type ?? t("integrations.inbound_no_type")}>
          <div className="pcms-row">
            <StatusBadge status={event.status} />
            <span>{event.source_type}</span>
            {event.error_code !== null && <Badge tone="danger">{event.error_code}</Badge>}
          </div>
        </Card>
      ))}
    </div>
  );
}

export function IntegrationsScreen() {
  const auth = useAuth();
  const [tab, setTab] = useState("connections");
  const tabs = [
    ...(auth.can("integrations.read")
      ? [{ id: "connections", title: t("integrations.tab_connections") }]
      : []),
    ...(auth.can("integrations.read")
      ? [{ id: "bindings", title: t("integrations.tab_bindings") }]
      : []),
    ...(auth.can("integrations.deliveries.read")
      ? [{ id: "deliveries", title: t("integrations.tab_deliveries") }]
      : []),
    ...(auth.can("integrations.retry")
      ? [{ id: "failures", title: t("integrations.tab_failures") }]
      : []),
    ...(auth.can("integrations.inbound.read")
      ? [{ id: "inbound", title: t("integrations.tab_inbound") }]
      : []),
  ];
  const active = tabs.some((item) => item.id === tab) ? tab : (tabs[0]?.id ?? "");
  return (
    <div className="pcms-screen" data-testid="integrations-screen">
      <h1>{t("integrations.title")}</h1>
      {tabs.length === 0 ? (
        <EmptyState title={t("integrations.denied_title")} hint={t("integrations.denied_hint")} />
      ) : (
        <>
          <Tabs
            items={tabs}
            active={active}
            onSelect={setTab}
            label={t("integrations.sections_label")}
          />
          {active === "connections" && (
            <div
              role="tabpanel"
              id="panel-connections"
              aria-label={t("integrations.tab_connections")}
            >
              <MailSettingsCard />
              <ConnectionsTab />
            </div>
          )}
          {active === "bindings" && (
            <div role="tabpanel" id="panel-bindings" aria-label={t("integrations.tab_bindings")}>
              <BindingsTab />
            </div>
          )}
          {active === "deliveries" && (
            <div
              role="tabpanel"
              id="panel-deliveries"
              aria-label={t("integrations.tab_deliveries")}
            >
              <DeliveriesTab />
            </div>
          )}
          {active === "failures" && (
            <div
              role="tabpanel"
              id="panel-failures"
              aria-label={t("integrations.tab_failures_aria")}
            >
              <DeliveriesTab failuresOnly />
            </div>
          )}
          {active === "inbound" && (
            <div role="tabpanel" id="panel-inbound" aria-label={t("integrations.tab_inbound")}>
              <InboundTab />
            </div>
          )}
        </>
      )}
    </div>
  );
}
