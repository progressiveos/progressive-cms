// Admin Extensions workspace (PCMS-EXT-T019; Extensions spec §48–§50).
// Human-readable read surface: extensions, compatibility, deprecations and
// the update preflight. The SPA is a thin client of /api/v1 — the server
// stays the authorization and preflight authority. There is deliberately NO
// upload/editor: executable extension artifacts arrive only through the
// trusted deployment path, never through Admin.
import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut } from "../../api/client.js";
import { useAuth } from "../../auth/AuthContext.js";
import { ConfirmDialog, Dialog } from "../../design/dialog.js";
import { adminIcons } from "../../design/icons.js";
import { Tooltip } from "../../design/tooltip.js";
import {
  type AdminIconName,
  Badge,
  Button,
  Card,
  type DomainAccent,
  EmptyState,
  ErrorPanel,
  Field,
  Icon,
  Input,
  Spinner,
  Switch,
  TabPanel,
  Tabs,
} from "../../design/ui.js";
import { t } from "../../i18n/index.js";
import { getLocale } from "../../i18n/locale.js";
import { acquisitionErrorText, useMediaProviders } from "../media/acquisition.js";

interface IssueWire {
  readonly code: string;
  readonly severity: string;
  readonly blocking: boolean;
  readonly category: string;
  readonly subject: string;
  readonly location?: string;
  readonly message: string;
  readonly remediation?: string;
}

interface ExtensionWire {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly extension_contract: string;
  readonly cms_compatibility: string | null;
  readonly installed: boolean;
  readonly state: string | null;
  readonly data_policy: string;
  /** Manifest-authored metadata (ADR-0017 S4) — present when the manifest
   * carries it (extensionView spreads it into the wire). */
  readonly description?: { readonly ru: string; readonly en: string } | undefined;
  readonly icon?: string | undefined;
  readonly requires: readonly { capability: string; range: string }[];
  readonly provides: readonly { capability: string; version: string }[];
  readonly compatibility_outcome: string;
  readonly issues: readonly IssueWire[];
  readonly has_config_schema?: boolean;
  readonly registrations: Record<string, number>;
}

interface DeprecationWire {
  readonly id: string;
  readonly contract: string;
  readonly item: string;
  readonly deprecated_in: string;
  readonly replacement: string | null;
  readonly planned_removal_major: number;
  readonly status: string;
}

interface PreflightWire {
  readonly outcome: string;
  readonly current: { readonly version: string };
  readonly target: {
    readonly version: string;
    readonly rollback_policy: string;
    readonly backup_required: boolean;
    readonly manual_steps: readonly string[];
  };
  readonly planned_core_migrations: readonly string[];
  readonly issues: readonly IssueWire[];
}

const STATE_LABEL_KEYS: Readonly<Record<string, string>> = {
  INSTALLED: "extensions.state_installed",
  ENABLED: "extensions.state_enabled",
  DISABLED: "extensions.state_disabled",
};

const ROLLBACK_POLICY_LABEL_KEYS: Readonly<Record<string, string>> = {
  rollback_safe: "extensions.policy_rollback_safe",
  restore_required: "extensions.policy_restore_required",
  forward_fix_only: "extensions.policy_forward_fix_only",
};

/** Raw enum values for display; called during render, never at module scope. */
function stateLabel(state: string | null): string {
  if (state === null) return t("extensions.state_deployed");
  const key = STATE_LABEL_KEYS[state];
  return key === undefined ? state : t(key);
}

function rollbackPolicyLabel(policy: string): string {
  const key = ROLLBACK_POLICY_LABEL_KEYS[policy];
  return key === undefined ? policy : t(key);
}

const OUTCOME_LABEL_KEYS: Readonly<Record<string, string>> = {
  READY: "extensions.outcome_ready",
  READY_WITH_WARNINGS: "extensions.outcome_ready_with_warnings",
  BLOCKED: "extensions.outcome_blocked",
};

function outcomeLabel(outcome: string): string {
  const key = OUTCOME_LABEL_KEYS[outcome];
  return key === undefined ? outcome : t(key);
}

function IssueList({ issues }: { readonly issues: readonly IssueWire[] }) {
  if (issues.length === 0) {
    return <p>{t("extensions.issues_none")}</p>;
  }
  return (
    <ul>
      {issues.map((issue) => (
        <li key={`${issue.code}/${issue.subject}/${issue.message}`}>
          <Badge
            tone={issue.blocking ? "danger" : issue.severity === "warning" ? "warning" : "neutral"}
          >
            {issue.code}
          </Badge>{" "}
          {issue.message}
          {issue.remediation === undefined ? null : (
            <div>
              <em>{t("extensions.issue_remediation", { remediation: issue.remediation })}</em>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---- Extension settings (PCMS-PRE-RESEARCH A2): one declarative dialog ----
// Every extension's settings render from its manifest config_schema. Media
// providers keep their dedicated transport (/media/providers/…) and their
// Test-connection button; other extensions use /extensions/{id}/config.
// Credentials and Network/Proxy are SEPARATE sections — the key action never
// touches proxy settings and vice versa.

interface ProviderSummaryWire {
  readonly provider_id: string;
  readonly extension_id: string;
  readonly kind: "stock" | "generation";
  readonly display_name: string;
  readonly configured: boolean;
}

interface SchemaPropertyWire {
  readonly type?: string;
  readonly enum?: readonly string[];
  readonly default?: unknown;
  readonly description?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

interface SettingsDetailWire {
  readonly config_schema: {
    readonly properties?: Readonly<Record<string, SchemaPropertyWire>>;
  } | null;
  readonly config: Readonly<Record<string, unknown>>;
  readonly secret_slots: readonly string[];
}

const NETWORK_MODES = ["direct", "socks5", "direct_then_socks5"] as const;

const ROOT_LABEL_KEYS: Readonly<Record<string, string>> = {
  xmlstock: "extensions.group_xmlstock",
  search: "extensions.group_search",
  fetch: "extensions.group_fetch",
};

const FIELD_LABEL_KEYS: Readonly<Record<string, string>> = {
  "xmlstock.user_id": "extensions.field_xmlstock_user_id",
  "xmlstock.api_key": "extensions.field_xmlstock_api_key",
  "vision.enabled": "extensions.field_vision_enabled",
  "vision.api_key": "extensions.field_vision_api_key",
  "vision.base_url": "extensions.field_vision_base_url",
  "vision.model": "extensions.field_vision_model",
  "vision.timeout_ms": "extensions.field_vision_timeout",
  "vision.max_pages": "extensions.field_vision_max_pages",
  "fetch.browser.enabled": "extensions.field_fetch_browser",
  "fetch.allowed_ports": "extensions.field_allowed_ports",
};

function isSecretRef(schema: SchemaPropertyWire | undefined): boolean {
  return (schema as { format?: string } | undefined)?.format === "secret-ref";
}

/** Human label for a config key: curated catalog label when known, else
 * "Group: field" for dotted keys (xmlstock and vision keys must never share
 * one ambiguous "API key"), else the humanized key. */
function fieldLabel(key: string): string {
  const catalogKey = FIELD_LABEL_KEYS[key];
  if (catalogKey !== undefined) return t(catalogKey);
  const last = key.includes(".") ? (key.split(".").pop() ?? key) : key;
  const words = last.replace(/_/g, " ").trim();
  const human = words.charAt(0).toUpperCase() + words.slice(1);
  if (key.includes(".")) {
    const prefix = key.split(".")[0] ?? "";
    const group = t(ROOT_LABEL_KEYS[prefix] ?? "extensions.group_params_prefix", {
      prefix: humanizeFieldLabel(prefix),
    });
    return `${group}: ${human}`;
  }
  return human;
}

function humanizeFieldLabel(key: string): string {
  const last = key.includes(".") ? (key.split(".").pop() ?? key) : key;
  const words = last.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function networkModeLabel(mode: string | null): string {
  if (mode === "socks5") return t("extensions.network_badge_socks5");
  if (mode === "direct_then_socks5") return t("extensions.network_badge_fallback");
  return t("extensions.network_badge_direct");
}

type SettingsTarget =
  | {
      readonly base: string;
      readonly title: string;
      readonly testable: false;
      readonly credits: false;
      readonly hideConfigKeys?: readonly string[];
    }
  | {
      readonly base: string;
      readonly title: string;
      readonly testable: true;
      readonly credits: boolean;
      readonly hideConfigKeys?: readonly string[];
    };

/** Config keys the dialog must NOT render as generic fields for generation
 *  providers: the models list and the legacy scalar model shapes are managed
 *  by the card's "Generation models" section (catalog picker + default marker),
 *  not by hand (owner report 2026-09-30: the Runware modal asked for raw model
 *  JSON). The dialog still round-trips their stored values on save — the
 *  provider config PUT is replace-semantics for non-secret keys. */
const GENERATION_MANAGED_CONFIG_KEYS: readonly string[] = [
  "models",
  "model",
  "model_slug",
  "model_params",
  "default_model",
];

function ExtensionSettingsDialog(props: {
  readonly target: SettingsTarget;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [detail, setDetail] = useState<SettingsDetailWire | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [network, setNetwork] = useState<Record<string, string | boolean>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadDetail = useCallback(() => {
    apiGet<SettingsDetailWire>(`${props.target.base}/config`)
      .then((result) => {
        setDetail(result);
        const initial: Record<string, string> = {};
        const schemaKeys = Object.keys(result.config_schema?.properties ?? {});
        for (const [key, value] of Object.entries(result.config)) {
          if (!schemaKeys.includes(key)) continue;
          const schema = result.config_schema?.properties?.[key];
          if (typeof value === "string") initial[key] = value;
          else if (typeof value === "object" && value !== null)
            initial[key] = JSON.stringify(value, null, 2);
          else if (typeof value !== "object") initial[key] = String(value);
          void schema;
        }
        setValues(initial);
        const net = result.config["network"];
        setNetwork(
          typeof net === "object" && net !== null
            ? (Object.fromEntries(
                // Numbers (proxy_port) stringify too — otherwise a saved port
                // reopens as an empty field (owner report 2026-09-30).
                Object.entries(net as Record<string, unknown>)
                  .filter(
                    ([, value]) =>
                      typeof value === "string" ||
                      typeof value === "boolean" ||
                      typeof value === "number",
                  )
                  .map(([key, value]) => [key, typeof value === "number" ? String(value) : value]),
              ) as Record<string, string | boolean>)
            : {},
        );
      })
      .catch((cause: unknown) => {
        // A failed settings load must never leave the dialog spinning.
        setLoadError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [props.target]);
  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const schemaOf = (key: string): SchemaPropertyWire =>
    detail?.config_schema?.properties?.[key] ?? {};
  const schemaProps = detail?.config_schema?.properties ?? {};
  const hasNetwork = schemaProps["network"] !== undefined;
  const hiddenKeys = props.target.hideConfigKeys ?? [];
  const configKeys = Object.keys(schemaProps).filter(
    (key) => key !== "network" && !isSecretRef(schemaProps[key]) && !hiddenKeys.includes(key),
  );
  const secretProps = Object.keys(schemaProps).filter(
    (key) => key !== "network" && isSecretRef(schemaProps[key]),
  );
  const proxySecret =
    secretProps.find(
      (slot) => slot.endsWith("proxy_password") || slot.includes("proxy_password"),
    ) ?? null;
  const credentialSecrets = secretProps.filter((slot) => slot !== proxySecret);
  const storedSlots = new Set(detail?.secret_slots ?? []);
  const slotIsSet = (slot: string): boolean => storedSlots.has(slot);

  // Settings grouped by key prefix (xmlstock.* → «XMLStock», search.* → …);
  // unprefixed keys form the generic "Parameters" section.
  const fieldGroups: { readonly title: string; readonly keys: readonly string[] }[] = (() => {
    const groups: { title: string; keys: string[] }[] = [];
    for (const key of configKeys) {
      const prefix = key.includes(".") ? (key.split(".")[0] ?? "") : "";
      const title =
        prefix === ""
          ? t("extensions.group_params")
          : t(ROOT_LABEL_KEYS[prefix] ?? "extensions.group_params_prefix", {
              prefix: humanizeFieldLabel(prefix),
            });
      const last = groups[groups.length - 1];
      if (last !== undefined && last.title === title) last.keys.push(key);
      else groups.push({ title, keys: [key] });
    }
    return groups;
  })();
  const mode = typeof network["mode"] === "string" ? (network["mode"] as string) : "direct";
  const proxySelected = mode === "socks5" || mode === "direct_then_socks5";

  const parseValue = (key: string): { ok: true; value: unknown } | { ok: false } => {
    const raw = values[key];
    const schema = schemaOf(key);
    if (raw === undefined || raw === "") return { ok: true, value: undefined };
    if (schema.enum !== undefined) return { ok: true, value: raw };
    if (schema.type === "boolean") return { ok: true, value: raw === "true" };
    if (schema.type === "number" || schema.type === "integer") {
      const num = Number(raw);
      return Number.isFinite(num) ? { ok: true, value: num } : { ok: false };
    }
    if (schema.type === "object" || schema.type === "array") {
      try {
        return { ok: true, value: JSON.parse(raw) };
      } catch {
        return { ok: false };
      }
    }
    return { ok: true, value: raw };
  };

  const save = () => {
    if (detail === null) return;
    setBusy(true);
    setMessage(null);
    const config: Record<string, unknown> = {};
    // Round-trip keys managed outside this dialog (e.g. the models list):
    // the provider config PUT replaces non-secret keys, so omitting them
    // would silently wipe the stored models on any save.
    for (const [key, value] of Object.entries(detail.config)) {
      if (hiddenKeys.includes(key)) config[key] = value;
    }
    for (const key of configKeys) {
      const parsed = parseValue(key);
      if (!parsed.ok) {
        setBusy(false);
        setMessage(`${t("extensions.invalid_json")}: ${key}`);
        return;
      }
      if (parsed.value !== undefined) config[key] = parsed.value;
    }
    const net: Record<string, unknown> = {};
    if (mode !== "direct") {
      net["mode"] = mode;
      for (const key of ["proxy_host", "proxy_username"] as const) {
        const value = network[key];
        if (typeof value === "string" && value !== "") net[key] = value;
      }
      const port = Number(network["proxy_port"]);
      if (
        network["proxy_port"] !== undefined &&
        network["proxy_port"] !== "" &&
        Number.isInteger(port)
      ) {
        net["proxy_port"] = port;
      }
      net["remote_dns"] = network["remote_dns"] !== false;
      if (proxySelected && network["proxy_host"] === undefined) {
        setBusy(false);
        setMessage(t("extensions.network_host_required"));
        return;
      }
    }
    if (Object.keys(net).length > 0) config["network"] = net;
    const secretPuts = secretProps
      .filter((slot) => (secrets[slot] ?? "") !== "")
      .map((slot) =>
        apiPut(`${props.target.base}/secrets/${slot}`, { value: secrets[slot] ?? "" }),
      );
    apiPut(`${props.target.base}/config`, { config })
      .then(() => Promise.all(secretPuts))
      .then(() => {
        setSecrets({});
        setMessage(t("extensions.provider_saved"));
        loadDetail();
        props.onSaved();
      })
      .catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const test = () => {
    setBusy(true);
    setMessage(null);
    apiPost<{ ok: boolean; code?: string; message?: string }>(`${props.target.base}/test`, {})
      .then((result) =>
        setMessage(
          result.ok
            ? t("extensions.provider_test_ok")
            : acquisitionErrorText(result.code ?? "PROVIDER_FAILED"),
        ),
      )
      .catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const deleteSlot = (slot: string) => {
    if (detail === null) return;
    setBusy(true);
    setMessage(null);
    apiDelete(`${props.target.base}/secrets/${slot}`)
      .then(() => {
        setMessage(t("extensions.provider_key_deleted"));
        props.onSaved();
      })
      .catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const networkLabel = (key: string): string =>
    t(
      {
        mode: "extensions.network_mode",
        proxy_host: "extensions.network_host",
        proxy_port: "extensions.network_port",
        remote_dns: "extensions.network_remote_dns",
        proxy_username: "extensions.network_username",
      }[key as "mode"] ?? "extensions.network_mode",
    );

  const schemaHint = (key: string): string | undefined => {
    const schema = schemaOf(key);
    const description = schema.description;
    const hasDefault =
      schema.default !== undefined && schema.default !== null && schema.default !== "";
    if (!hasDefault) return description;
    const defaultText = `${t("extensions.settings_hint_default", {
      value:
        typeof schema.default === "object"
          ? JSON.stringify(schema.default)
          : String(schema.default),
    })}`;
    return description === undefined ? defaultText : `${description} · ${defaultText}`;
  };

  const renderField = (key: string) => {
    const schema = schemaOf(key);
    const hint = schemaHint(key);
    // exactOptionalPropertyTypes: omit the prop entirely when there is no hint.
    const hintProps = hint === undefined ? {} : { hint };
    if (schema.type === "boolean") {
      return (
        <Field key={key} label={fieldLabel(key)} {...hintProps}>
          <Switch
            label={fieldLabel(key)}
            checked={
              values[key] === "true" || (values[key] === undefined && schema.default === true)
            }
            onChange={(checked) => setValues({ ...values, [key]: checked ? "true" : "false" })}
          />
        </Field>
      );
    }
    if (schema.type === "array") {
      return (
        <Field key={key} label={fieldLabel(key)} {...hintProps}>
          <textarea
            className="pcms-input"
            rows={2}
            spellCheck={false}
            placeholder={t("extensions.field_array_hint")}
            value={values[key] ?? ""}
            onChange={(event) => setValues({ ...values, [key]: event.target.value })}
          />
        </Field>
      );
    }
    if (schema.enum !== undefined) {
      return (
        <Field key={key} label={fieldLabel(key)} {...hintProps}>
          <select
            className="pcms-select"
            style={{ maxWidth: 320 }}
            value={values[key] ?? String(schema.default ?? "")}
            onChange={(event) => setValues({ ...values, [key]: event.target.value })}
          >
            {schema.enum.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
      );
    }
    if (schema.type === "object") {
      return (
        <Field key={key} label={fieldLabel(key)} {...hintProps}>
          <textarea
            className="pcms-input"
            rows={4}
            spellCheck={false}
            value={values[key] ?? ""}
            onChange={(event) => setValues({ ...values, [key]: event.target.value })}
          />
        </Field>
      );
    }
    const numeric = schema.type === "number" || schema.type === "integer";
    return (
      <Field key={key} label={fieldLabel(key)} {...hintProps}>
        <Input
          type={numeric ? "number" : "text"}
          style={numeric ? { maxWidth: 180 } : undefined}
          value={values[key] ?? ""}
          onChange={(event) => setValues({ ...values, [key]: event.target.value })}
        />
      </Field>
    );
  };

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={`${t("extensions.settings_title")} ${props.target.title}`}
      footer={
        <>
          <span className="pcms-field__hint" role="status">
            {message}
          </span>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={props.onClose}>
            {t("cancel")}
          </Button>
          {props.target.testable ? (
            <Tooltip content={t("extensions.tooltip_test")}>
              <Button onClick={test} disabled={busy}>
                {t("extensions.provider_test")}
              </Button>
            </Tooltip>
          ) : null}
          <Tooltip content={t("extensions.tooltip_save")}>
            <Button variant="primary" disabled={busy} onClick={save}>
              {t("extensions.provider_save")}
            </Button>
          </Tooltip>
        </>
      }
    >
      {detail === null ? (
        loadError !== null ? (
          <ErrorPanel message={loadError} />
        ) : (
          <Spinner />
        )
      ) : (
        <div style={{ maxWidth: 560 }}>
          {fieldGroups.map((group) =>
            group.keys.length === 0 ? null : (
              <div key={group.title}>
                <h4 className="pcms-admin-h4" style={{ margin: "12px 0 8px" }}>
                  {group.title}
                </h4>
                {group.keys.map(renderField)}
              </div>
            ),
          )}

          {credentialSecrets.length > 0 ? (
            <div>
              <h4 className="pcms-admin-h4" style={{ margin: "16px 0 8px" }}>
                {t("extensions.section_credentials")}
              </h4>
              {credentialSecrets.map((slot) => {
                const set = slotIsSet(slot);
                return (
                  <Field
                    key={slot}
                    label={
                      <>
                        {fieldLabel(slot)}{" "}
                        <Tooltip
                          content={
                            set
                              ? t("extensions.tooltip_secret_set")
                              : t("extensions.tooltip_secret_not_set")
                          }
                        >
                          <Badge tone={set ? "success" : "warning"}>
                            {set ? t("extensions.secret_set") : t("extensions.secret_not_set")}
                          </Badge>
                        </Tooltip>
                      </>
                    }
                    hint={t("extensions.provider_secret_hint")}
                  >
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <div style={{ flex: 1 }}>
                        <Input
                          type="password"
                          autoComplete="new-password"
                          placeholder={set ? t("extensions.secret_keep") : ""}
                          value={secrets[slot] ?? ""}
                          onChange={(event) =>
                            setSecrets({ ...secrets, [slot]: event.target.value })
                          }
                        />
                      </div>
                      {set ? (
                        <Tooltip content={t("extensions.tooltip_delete_key")}>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => deleteSlot(slot)}
                          >
                            {t("extensions.provider_delete_key")}
                          </Button>
                        </Tooltip>
                      ) : null}
                    </div>
                  </Field>
                );
              })}
            </div>
          ) : null}

          {hasNetwork ? (
            <div>
              <h4 className="pcms-admin-h4" style={{ margin: "16px 0 8px" }}>
                {t("extensions.network_title")}
              </h4>
              <Field label={t("extensions.network_mode")}>
                <select
                  className="pcms-select"
                  value={mode}
                  onChange={(event) => setNetwork({ ...network, mode: event.target.value })}
                >
                  {NETWORK_MODES.map((value) => (
                    <option key={value} value={value}>
                      {t(
                        {
                          direct: "extensions.network_mode_direct",
                          socks5: "extensions.network_mode_socks5",
                          direct_then_socks5: "extensions.network_mode_fallback",
                        }[value],
                      )}
                    </option>
                  ))}
                </select>
              </Field>
              {proxySelected ? (
                <>
                  <Field label={t("extensions.network_host")}>
                    <Input
                      value={
                        typeof network["proxy_host"] === "string"
                          ? (network["proxy_host"] as string)
                          : ""
                      }
                      onChange={(event) =>
                        setNetwork({ ...network, proxy_host: event.target.value })
                      }
                    />
                  </Field>
                  <Field label={t("extensions.network_port")}>
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      value={
                        typeof network["proxy_port"] === "string"
                          ? (network["proxy_port"] as string)
                          : ""
                      }
                      onChange={(event) =>
                        setNetwork({ ...network, proxy_port: event.target.value })
                      }
                    />
                  </Field>
                  <Switch
                    checked={network["remote_dns"] !== false}
                    label={t("extensions.network_remote_dns")}
                    onChange={(checked) => setNetwork({ ...network, remote_dns: checked })}
                  />
                  <Field label={t("extensions.network_username")}>
                    <Input
                      value={
                        typeof network["proxy_username"] === "string"
                          ? (network["proxy_username"] as string)
                          : ""
                      }
                      onChange={(event) =>
                        setNetwork({ ...network, proxy_username: event.target.value })
                      }
                    />
                  </Field>
                </>
              ) : null}
              {proxySecret !== null ? (
                <Field
                  label={
                    <>
                      {t("extensions.network_password")}{" "}
                      <Badge tone={slotIsSet(proxySecret) ? "success" : "warning"}>
                        {slotIsSet(proxySecret)
                          ? t("extensions.secret_set")
                          : t("extensions.secret_not_set")}
                      </Badge>
                    </>
                  }
                  hint={t("extensions.provider_secret_hint")}
                >
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <div style={{ flex: 1 }}>
                      <Input
                        type="password"
                        autoComplete="new-password"
                        placeholder={slotIsSet(proxySecret) ? t("extensions.secret_keep") : ""}
                        value={secrets[proxySecret] ?? ""}
                        onChange={(event) =>
                          setSecrets({ ...secrets, [proxySecret]: event.target.value })
                        }
                      />
                    </div>
                    {slotIsSet(proxySecret) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => deleteSlot(proxySecret)}
                      >
                        {t("extensions.network_password_delete")}
                      </Button>
                    ) : null}
                  </div>
                </Field>
              ) : null}
            </div>
          ) : null}
          {props.target.credits ? (
            <p className="pcms-field__hint">{t("extensions.provider_test_credits")}</p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

function ProviderSection({
  extensionId,
  canConfigure,
}: {
  readonly extensionId: string;
  readonly canConfigure: boolean;
}) {
  const { providers, reload } = useMediaProviders();
  const [configuring, setConfiguring] = useState(false);
  const [networkMode, setNetworkMode] = useState<string | null>(null);
  const mine = (providers ?? []).filter((entry) => entry.extension_id === extensionId);
  const first = mine[0];
  useEffect(() => {
    if (first === undefined) return;
    let cancelled = false;
    apiGet<SettingsDetailWire>(`/media/providers/${encodeURIComponent(first.provider_id)}/config`)
      .then((result) => {
        if (cancelled) return;
        const net = result.config["network"];
        setNetworkMode(
          typeof net === "object" &&
            net !== null &&
            typeof (net as Record<string, unknown>)["mode"] === "string"
            ? ((net as Record<string, unknown>)["mode"] as string)
            : null,
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [first]);
  if (first === undefined) return null;
  return (
    <>
      <p data-testid="provider-section">
        {t("extensions.provider_section")}: <strong>{first.display_name}</strong>{" "}
        <Badge tone={first.configured ? "success" : "warning"}>
          {first.configured
            ? t("extensions.provider_configured")
            : t("extensions.provider_not_configured")}
        </Badge>{" "}
        <Badge tone={networkMode === null ? "neutral" : "info"}>
          {networkModeLabel(networkMode)}
        </Badge>{" "}
        {canConfigure ? (
          <Tooltip content={t("extensions.provider_keys_network_hint")}>
            <Button size="sm" onClick={() => setConfiguring(true)}>
              <Icon name="key" /> {t("extensions.provider_keys_network")}
            </Button>
          </Tooltip>
        ) : null}
        {configuring ? (
          <ExtensionSettingsDialog
            target={{
              base: `/media/providers/${encodeURIComponent(first.provider_id)}`,
              title: first.display_name,
              testable: true,
              credits: first.kind === "generation",
              ...(first.kind === "generation"
                ? { hideConfigKeys: GENERATION_MANAGED_CONFIG_KEYS }
                : {}),
            }}
            onClose={() => setConfiguring(false)}
            onSaved={reload}
          />
        ) : null}
      </p>
      {first.kind === "generation" && canConfigure ? (
        <ModelsSection providerId={first.provider_id} />
      ) : null}
    </>
  );
}

/** Generation-model configuration (Image Generation v2, plan T4.2): lists
 *  configured models with contract freshness, adds models through the
 *  provider's native catalog search + live contract sync, removes/resyncs.
 *  Config edits ride the existing provider config PUT (secret refs kept). */
function ModelsSection({ providerId }: { readonly providerId: string }) {
  const [models, setModels] = useState<
    | readonly { model: string; display_name: string; stale: boolean; last_synced_at: string }[]
    | null
  >(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(() => {
    apiGet<{
      configured_models: readonly {
        model: string;
        display_name: string;
        stale: boolean;
        last_synced_at: string;
      }[];
    }>(`/media/providers/${encodeURIComponent(providerId)}/capabilities`)
      .then((result) => setModels(result.configured_models))
      .catch(() => setModels([]));
  }, [providerId]);
  useEffect(() => {
    reload();
  }, [reload]);

  const mutateConfig = useCallback(
    (mutate: (models: Record<string, unknown>[]) => Record<string, unknown>[]) => {
      setBusy(true);
      setMessage(null);
      apiGet<{ config: Record<string, unknown> }>(
        `/media/providers/${encodeURIComponent(providerId)}/config`,
      )
        .then((detail) => {
          const existing = Array.isArray(detail.config["models"])
            ? (detail.config["models"] as Record<string, unknown>[]).filter(
                (entry) => typeof entry === "object" && entry !== null,
              )
            : [];
          return apiPut(`/media/providers/${encodeURIComponent(providerId)}/config`, {
            config: { ...detail.config, models: mutate(existing) },
          });
        })
        .then(() => reload())
        .catch((cause: unknown) =>
          setMessage(cause instanceof Error ? cause.message : String(cause)),
        )
        .finally(() => setBusy(false));
    },
    [providerId, reload],
  );

  const resync = (model: string) => {
    setBusy(true);
    setMessage(null);
    apiGet<{ model: { stale: boolean; last_synced_at: string } }>(
      `/media/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(model)}?sync=true`,
    )
      .then((result) => {
        // Replace in place: filter+append would move the model to the end and
        // silently change the default (the first entry is the default).
        mutateConfig((existing) =>
          existing.map((entry) =>
            entry["model"] === model ? { model, capabilities: result.model } : entry,
          ),
        );
      })
      .catch((cause: unknown) => {
        setMessage(cause instanceof Error ? cause.message : String(cause));
        setBusy(false);
      });
  };

  const makeDefault = (model: string) => {
    mutateConfig((existing) => {
      const entry = existing.find((item) => item["model"] === model);
      if (entry === undefined) return existing;
      return [entry, ...existing.filter((item) => item["model"] !== model)];
    });
  };

  return (
    <div data-testid="provider-models" className="pcms-provider-models">
      <h4>{t("extensions.models_title")}</h4>
      {models === null ? <Spinner /> : null}
      {models !== null && models.length === 0 ? (
        <p className="pcms-field__hint">{t("extensions.models_empty")}</p>
      ) : null}
      {(models ?? []).map((entry, index) => (
        <p key={entry.model}>
          <strong>{entry.display_name}</strong> <code>{entry.model}</code>{" "}
          {index === 0 ? (
            <Tooltip content={t("extensions.models_default_hint")}>
              <Badge tone="info">{t("extensions.models_default")}</Badge>
            </Tooltip>
          ) : null}{" "}
          {entry.stale ? <Badge tone="warning">{t("extensions.models_stale")}</Badge> : null}{" "}
          {index > 0 ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => makeDefault(entry.model)}
              >
                {t("extensions.models_make_default")}
              </Button>{" "}
            </>
          ) : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => resync(entry.model)}>
            {t("extensions.models_sync")}
          </Button>{" "}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              mutateConfig((existing) => existing.filter((e) => e["model"] !== entry.model))
            }
          >
            {t("extensions.models_delete")}
          </Button>
        </p>
      ))}
      <Button size="sm" disabled={busy} onClick={() => setAdding(true)}>
        {t("extensions.models_add")}
      </Button>
      {message !== null ? (
        <p className="pcms-field__error" role="alert">
          {message}
        </p>
      ) : null}
      {adding ? (
        <ModelPickerDialog
          providerId={providerId}
          onClose={() => setAdding(false)}
          onAdded={(model, capabilities) => {
            setAdding(false);
            mutateConfig((existing) => [
              ...existing.filter((entry) => entry["model"] !== model),
              { model, capabilities },
            ]);
          }}
        />
      ) : null}
    </div>
  );
}

/** Catalog search + live contract preview (the "service returns features"
 *  setup flow): search → sync → review → add. */
function ModelPickerDialog(props: {
  readonly providerId: string;
  readonly onClose: () => void;
  readonly onAdded: (model: string, capabilities: Record<string, unknown>) => void;
}) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<readonly { model: string; display_name: string }[] | null>(
    null,
  );
  const [preview, setPreview] = useState<{
    readonly model: string;
    readonly display_name: string;
    readonly size_options: readonly {
      ratio: string;
      width: number;
      height: number;
      tier: string | null;
    }[];
    readonly resolution_map: Record<string, string> | null;
    readonly max_reference_images: number;
    readonly max_count: number;
    readonly supports_negative_prompt: boolean;
    readonly pricing: readonly { unit: string; cost_usd: number; variant?: string }[] | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const runSearch = () => {
    setBusy(true);
    setMessage(null);
    apiGet<{ items: readonly { model: string; display_name: string }[] }>(
      `/media/providers/${encodeURIComponent(props.providerId)}/models?limit=20${
        search.trim() === "" ? "" : `&search=${encodeURIComponent(search.trim())}`
      }`,
    )
      .then((result) => setResults(result.items))
      .catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const pick = (model: string) => {
    setBusy(true);
    setMessage(null);
    apiGet<{
      model: {
        model: string;
        display_name: string;
        size_options: readonly {
          ratio: string;
          width: number;
          height: number;
          tier: string | null;
        }[];
        resolution_map: Record<string, string> | null;
        max_reference_images: number;
        max_count: number;
        supports_negative_prompt: boolean;
        pricing: readonly { unit: string; cost_usd: number; variant?: string }[] | null;
      };
      resolved: string;
    }>(
      `/media/providers/${encodeURIComponent(props.providerId)}/models/${encodeURIComponent(model)}?sync=true`,
    )
      .then((result) => setPreview(result.model))
      .catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open onClose={props.onClose} title={t("extensions.models_add")} wide>
      <div className="pcms-provider-models__picker">
        <Field label={t("extensions.models_search")}>
          <div className="pcms-inline">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("extensions.models_search_placeholder")}
              onKeyDown={(event) => {
                if (event.key === "Enter") runSearch();
              }}
            />
            <Button disabled={busy} onClick={runSearch}>
              {t("extensions.models_search")}
            </Button>
          </div>
        </Field>
        {message !== null ? (
          <p className="pcms-field__error" role="alert">
            {message}
          </p>
        ) : null}
        {results !== null && preview === null ? (
          <div>
            {results.length === 0 ? (
              <p className="pcms-field__hint">{t("extensions.models_empty")}</p>
            ) : null}
            {results.map((entry) => (
              <p key={entry.model}>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => pick(entry.model)}>
                  {entry.display_name}
                </Button>{" "}
                <code>{entry.model}</code>
              </p>
            ))}
          </div>
        ) : null}
        {preview !== null ? (
          <div data-testid="model-contract-preview">
            <p>
              <strong>{preview.display_name}</strong> <code>{preview.model}</code>
            </p>
            <p className="pcms-field__hint">
              {t("extensions.models_contract_sizes")}:{" "}
              {preview.size_options
                .slice(0, 6)
                .map(
                  (option) =>
                    `${option.ratio} ${option.width}×${option.height}${option.tier === null ? "" : ` (${option.tier.toUpperCase()})`}`,
                )
                .join(", ")}
              {preview.size_options.length > 6 ? "…" : ""}
            </p>
            <p className="pcms-field__hint">
              {t("extensions.models_contract_refs")}: {preview.max_reference_images} ·{" "}
              {t("extensions.models_contract_max")}: {preview.max_count} ·{" "}
              {t("extensions.models_contract_negative")}:{" "}
              {preview.supports_negative_prompt
                ? t("extensions.models_yes")
                : t("extensions.models_no")}
            </p>
            {preview.pricing !== null && preview.pricing.length > 0 ? (
              <p className="pcms-field__hint">
                {t("extensions.models_contract_price")}:{" "}
                {preview.pricing
                  .map(
                    (line) =>
                      `$${line.cost_usd}/${line.unit}${line.variant === undefined ? "" : ` (${line.variant})`}`,
                  )
                  .join(", ")}
              </p>
            ) : null}
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                props.onAdded(preview.model, preview as unknown as Record<string, unknown>)
              }
            >
              {t("extensions.models_add")}
            </Button>{" "}
            <Button variant="ghost" onClick={() => setPreview(null)}>
              {t("extensions.models_back")}
            </Button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Web Research test panel (PCMS-WEB-RESEARCH §83/§84): one bounded search
 * and one bounded fetch through the extension's own typed operations. Errors
 * surface typed; no raw HTML ever renders. */
function ResearchTestSection({ extensionId }: { readonly extensionId: string }) {
  const [query, setQuery] = useState("incus containers");
  const [url, setUrl] = useState("https://example.com");
  const [busy, setBusy] = useState(false);
  const [searchResult, setSearchResult] = useState<string | null>(null);
  const [fetchResult, setFetchResult] = useState<string | null>(null);
  const operationsBase = `/extensions/${encodeURIComponent(extensionId)}/operations`;
  // Capability-bound operation ids (ADR-0017 S4): resolved from discovery,
  // never hardcoded — the section renders only when this extension actually
  // contributes research.search/research.fetch operations.
  const [searchOperationId, setSearchOperationId] = useState<string | null>(null);
  const [fetchOperationId, setFetchOperationId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiGet<{ items: readonly { operation_id: string; capability?: string }[] }>(`${operationsBase}`)
      .then((result) => {
        if (cancelled) return;
        setSearchOperationId(
          result.items.find((operation) => operation.capability === "research.search")
            ?.operation_id ?? null,
        );
        setFetchOperationId(
          result.items.find((operation) => operation.capability === "research.fetch")
            ?.operation_id ?? null,
        );
      })
      .catch(() => {
        /* section stays hidden when discovery is unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, [operationsBase]);
  if (searchOperationId === null && fetchOperationId === null) return null;

  const runSearch = () => {
    setBusy(true);
    setSearchResult(null);
    apiPost<{
      count: number;
      results: readonly { rank: number; domain: string; title: string }[];
    }>(`${operationsBase}/${searchOperationId}`, { query, limit: 5 })
      .then((result) =>
        setSearchResult(
          result.count === 0
            ? t("extensions.research_test_no_results")
            : [
                t("extensions.research_test_search_ok", { count: result.count }),
                ...result.results.map((item) => `${item.rank}. [${item.domain}] ${item.title}`),
              ].join("\n"),
        ),
      )
      .catch((cause: unknown) =>
        setSearchResult(
          t("extensions.research_test_failed", {
            code: (cause as { code?: string }).code ?? "RESEARCH_SEARCH_FAILED",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        ),
      )
      .finally(() => setBusy(false));
  };

  const runFetch = () => {
    setBusy(true);
    setFetchResult(null);
    apiPost<{
      title?: string;
      method: string;
      network_path: string;
      word_count: number;
      extraction_quality: string;
      markdown: string;
    }>(`${operationsBase}/${fetchOperationId}`, { url, mode: "http_only", max_chars: 4000 })
      .then((result) =>
        setFetchResult(
          [
            t("extensions.research_test_fetch_ok", {
              words: result.word_count,
              method: result.method,
              network: result.network_path,
            }),
            `${t("extensions.research_test_preview")}: ${result.markdown.slice(0, 200)}…`,
          ].join("\n"),
        ),
      )
      .catch((cause: unknown) =>
        setFetchResult(
          t("extensions.research_test_failed", {
            code: (cause as { code?: string }).code ?? "RESEARCH_FETCH_FAILED",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        ),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div data-testid="research-test-section" className="pcms-field">
      <p className="pcms-field__hint">{t("extensions.research_test_title")}</p>
      <input
        className="pcms-input"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label={t("extensions.research_test_query")}
      />{" "}
      <Button
        size="sm"
        disabled={busy || searchOperationId === null || query.trim().length < 2}
        onClick={runSearch}
      >
        {t("extensions.research_test_search")}
      </Button>{" "}
      <input
        className="pcms-input"
        type="url"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        aria-label={t("extensions.research_test_url")}
      />{" "}
      <Button
        size="sm"
        disabled={busy || fetchOperationId === null || url.trim().length < 8}
        onClick={runFetch}
      >
        {t("extensions.research_test_fetch")}
      </Button>
      <p className="pcms-field__hint">{t("extensions.research_test_balance")}</p>
      {searchResult !== null ? <pre className="pcms-field__hint">{searchResult}</pre> : null}
      {fetchResult !== null ? <pre className="pcms-field__hint">{fetchResult}</pre> : null}
    </div>
  );
}

/** Settings entry for NON-provider extensions that declare a config_schema. */
function ExtensionSettingsSection({
  extensionId,
  extensionName,
  canConfigure,
}: {
  readonly extensionId: string;
  readonly extensionName: string;
  readonly canConfigure: boolean;
}) {
  const [configuring, setConfiguring] = useState(false);
  if (!canConfigure) return null;
  return (
    <p data-testid="extension-settings-section">
      <Tooltip content={t("extensions.extension_settings_hint")}>
        <Button size="sm" onClick={() => setConfiguring(true)}>
          <Icon name="settings" /> {t("extensions.extension_settings")}
        </Button>
      </Tooltip>
      {configuring ? (
        <ExtensionSettingsDialog
          target={{
            base: `/extensions/${encodeURIComponent(extensionId)}`,
            title: extensionName,
            testable: false,
            credits: false,
          }}
          onClose={() => setConfiguring(false)}
          onSaved={() => setConfiguring(false)}
        />
      ) : null}
    </p>
  );
}

/** Manifest-authored description (ADR-0017 S4): rendered per locale; packages
 * without one simply omit the block. No per-extension dictionaries in Core. */
function extensionDescription(extension: {
  readonly description?: { readonly ru: string; readonly en: string } | undefined;
}): string | null {
  const description = extension.description;
  if (description === undefined) return null;
  return getLocale() === "ru" ? description.ru : description.en;
}

/** Visual identity from the manifest `icon` key (validated against the Admin
 * Icon registry; unknown keys fall back to the generic puzzle). The accent
 * tint derives from a stable id hash — cosmetic variety, no per-id table. */
function extensionVisual(extension: { readonly id: string; readonly icon?: string | undefined }): {
  readonly icon: AdminIconName;
  readonly accent: DomainAccent;
} {
  const requested = extension.icon;
  const icon =
    requested !== undefined && requested in adminIcons
      ? (requested as AdminIconName)
      : "extensions";
  const accents: readonly DomainAccent[] = [
    "media",
    "search",
    "theme",
    "content",
    "navigation",
    "interactions",
    "system",
  ];
  let hash = 0;
  for (const ch of extension.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return { icon, accent: accents[hash % accents.length] as DomainAccent };
}

function ExtensionsTab({
  canManage,
  can,
}: {
  readonly canManage: boolean;
  readonly can: (permission: string) => boolean;
}) {
  const [items, setItems] = useState<readonly ExtensionWire[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { providers } = useMediaProviders();
  // Provider extensions are configured through their provider section (keys +
  // network + test connection); the generic settings dialog would duplicate it.
  const providerExtensionIds = new Set((providers ?? []).map((provider) => provider.extension_id));

  const reload = useCallback(() => {
    apiGet<{ items: readonly ExtensionWire[] }>("/extensions")
      .then((result) => setItems(result.items))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  useEffect(reload, [reload]);

  const [showAvailable, setShowAvailable] = useState(false);
  const [confirmLifecycle, setConfirmLifecycle] = useState<{
    extensionId: string;
    action: "enable" | "disable";
    blocking: number;
  } | null>(null);

  /** Operator-facing "Enable" hides the install/enable split: a catalog
   * artifact is installed first when needed, then the preflight/confirm
   * enable flow runs (owner directive 2026-09-30). */
  const requestLifecycle = async (
    extensionId: string,
    action: "enable" | "disable",
    options?: { readonly installFirst?: boolean },
  ) => {
    setBusy(true);
    setError(null);
    try {
      if (options?.installFirst === true) {
        await apiPost(`/extensions/${encodeURIComponent(extensionId)}/install`, {});
      }
      const compatibility = await apiGet<{ issues: readonly IssueWire[] }>(
        `/extensions/${encodeURIComponent(extensionId)}/compatibility`,
      );
      const blocking = compatibility.issues.filter((issue) => issue.blocking).length;
      setConfirmLifecycle({ extensionId, action, blocking });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const runLifecycle = async (extensionId: string, action: "enable" | "disable") => {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/extensions/${encodeURIComponent(extensionId)}/${action}`, {});
      setConfirmLifecycle(null);
      // ADR-0017 S6: Admin UI contributions are gated on the ENABLED set —
      // nav/routes appear/disappear without a reload.
      window.dispatchEvent(new window.CustomEvent("pcms:extensions-changed"));
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (error !== null) return <ErrorPanel message={error} />;
  if (items === null) return <Spinner />;
  if (items.length === 0) {
    return <EmptyState title={t("extensions.empty_title")} hint={t("extensions.empty_hint")} />;
  }
  // Owner directive 2026-09-30: the screen shows what is IN USE (ENABLED).
  // Everything else from the trusted delivery lives in the collapsed
  // "Available out of the box" section with a single "Enable" button — a
  // disabled/uninstalled extension disappears from the working surface, and
  // an operator without a service subscription simply never enables it.
  const enabledExtensions = items.filter((extension) => extension.state === "ENABLED");
  const availableExtensions = items.filter((extension) => extension.state !== "ENABLED");

  return (
    <>
      {enabledExtensions.length > 0 ? (
        <h3 data-testid="extensions-enabled-title">{t("extensions.section_enabled")}</h3>
      ) : (
        <EmptyState
          title={t("extensions.none_enabled_title")}
          hint={t("extensions.none_enabled_hint")}
        />
      )}
      <div className="pcms-card-grid">
        {error !== null ? <ErrorPanel message={error} /> : null}
        {enabledExtensions.map((extension) => {
          const visual = extensionVisual(extension);
          return (
            <Card
              key={extension.id}
              title={t("extensions.card_title", { name: extension.name, id: extension.id })}
              icon={visual.icon}
              accent={visual.accent}
            >
              {(() => {
                const description = extensionDescription(extension);
                return description !== null ? (
                  <p className="pcms-ext-desc" key="desc">
                    {description}
                  </p>
                ) : null;
              })()}
              <p>
                <Badge tone="neutral">
                  {t("extensions.version_badge", { version: extension.version })}
                </Badge>{" "}
                <Badge
                  tone={
                    extension.state === "ENABLED"
                      ? "success"
                      : extension.state === null
                        ? "neutral"
                        : "warning"
                  }
                >
                  {stateLabel(extension.state)}
                </Badge>
                {extension.compatibility_outcome === "READY_WITH_WARNINGS" ? (
                  <>
                    {" "}
                    <Badge tone="warning">{t("extensions.outcome_ready_with_warnings")}</Badge>
                  </>
                ) : null}
              </p>
              <ProviderSection
                extensionId={extension.id}
                canConfigure={can("media.providers.manage")}
              />
              {extension.installed &&
              extension.has_config_schema === true &&
              !providerExtensionIds.has(extension.id) ? (
                <ExtensionSettingsSection
                  extensionId={extension.id}
                  extensionName={extension.name}
                  canConfigure={canManage}
                />
              ) : null}
              {canManage ? <ResearchTestSection extensionId={extension.id} /> : null}
              {extension.issues.length > 0 ? <IssueList issues={extension.issues} /> : null}
              {canManage ? (
                <p style={{ display: "flex", justifyContent: "flex-end", margin: "12px 0 0" }}>
                  <Tooltip content={t("extensions.tooltip_disable")}>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      data-testid={`extension-disable-${extension.id}`}
                      onClick={() => void requestLifecycle(extension.id, "disable")}
                    >
                      {t("extensions.disable")}
                    </Button>
                  </Tooltip>
                </p>
              ) : null}
            </Card>
          );
        })}
      </div>
      {availableExtensions.length > 0 && canManage ? (
        <>
          <Tooltip content={t("extensions.tooltip_toggle_available")}>
            <Button
              variant="ghost"
              data-testid="extensions-toggle-available"
              onClick={() => setShowAvailable(!showAvailable)}
            >
              {showAvailable
                ? t("extensions.hide_available")
                : t("extensions.show_available", { count: availableExtensions.length })}
            </Button>
          </Tooltip>
          {showAvailable ? (
            <div className="pcms-card-grid">
              {availableExtensions.map((extension) => (
                <Card
                  key={extension.id}
                  title={t("extensions.card_title", { name: extension.name, id: extension.id })}
                  icon={extensionVisual(extension).icon}
                  accent={extensionVisual(extension).accent}
                >
                  {(() => {
                    const description = extensionDescription(extension);
                    return description !== null ? (
                      <p className="pcms-ext-desc">{description}</p>
                    ) : null;
                  })()}
                  <p>
                    <Tooltip content={t("extensions.tooltip_enable")}>
                      <Button
                        variant="primary"
                        disabled={busy}
                        data-testid={`extension-enable-${extension.id}`}
                        onClick={() =>
                          void requestLifecycle(extension.id, "enable", {
                            installFirst: !extension.installed,
                          })
                        }
                      >
                        {t("extensions.enable")}
                      </Button>
                    </Tooltip>
                  </p>
                </Card>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {confirmLifecycle !== null ? (
        <ConfirmDialog
          open
          onClose={() => setConfirmLifecycle(null)}
          onConfirm={() => void runLifecycle(confirmLifecycle.extensionId, confirmLifecycle.action)}
          title={
            confirmLifecycle.action === "enable"
              ? t("extensions.confirm_enable_title", { id: confirmLifecycle.extensionId })
              : t("extensions.confirm_disable_title", { id: confirmLifecycle.extensionId })
          }
          body={
            confirmLifecycle.action === "enable"
              ? t("extensions.confirm_enable_body")
              : t("extensions.confirm_disable_body")
          }
          details={[
            {
              label: t("extensions.confirm_blocking_label"),
              value: String(confirmLifecycle.blocking),
            },
          ]}
          confirmLabel={
            confirmLifecycle.action === "enable" ? t("extensions.enable") : t("extensions.disable")
          }
          tone={confirmLifecycle.action === "disable" ? "danger" : "primary"}
          busy={busy}
        />
      ) : null}
    </>
  );
}

function DeprecationsTab() {
  const [items, setItems] = useState<readonly DeprecationWire[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiGet<{ items: readonly DeprecationWire[] }>("/extensions/deprecations")
      .then((result) => setItems(result.items))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  if (error !== null) return <ErrorPanel message={error} />;
  if (items === null) return <Spinner />;
  if (items.length === 0) {
    // No actionable deprecations — compatibility shows a quiet confirmation.
    return <p className="pcms-field__hint">{t("extensions.deprecations_empty_hint")}</p>;
  }
  return (
    <ul>
      {items.map((record) => (
        <li key={record.id}>
          <strong>{record.item}</strong>
          {t("extensions.deprecated_since", { since: record.deprecated_in })}
          {record.replacement === null
            ? ""
            : t("extensions.deprecated_replacement", { replacement: record.replacement })}
          {t("extensions.deprecated_removal", { major: record.planned_removal_major })}
        </li>
      ))}
    </ul>
  );
}

function UpdateTab({ canManage }: { readonly canManage: boolean }) {
  const [preflight, setPreflight] = useState<PreflightWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    apiGet<PreflightWire>("/update/preflight")
      .then(setPreflight)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  useEffect(load, [load]);
  if (preflight === null && error === null) return <Spinner />;
  if (error !== null) {
    return (
      <div>
        <ErrorPanel message={error} />
        <p className="muted">
          {t("extensions.update_not_configured")}
          <code>{t("extensions.update_check_command")}</code>.
        </p>
      </div>
    );
  }
  if (preflight === null) return null;
  const blocking = preflight.issues.filter((issue) => issue.blocking);
  return (
    <div>
      <p>
        {t("extensions.update_current_prefix")} <strong>{preflight.current.version}</strong>{" "}
        {t("extensions.update_target_mid")} <strong>{preflight.target.version}</strong>
        {t("extensions.update_outcome_prefix")}{" "}
        <Badge
          tone={
            preflight.outcome === "READY"
              ? "success"
              : preflight.outcome === "BLOCKED"
                ? "danger"
                : "warning"
          }
        >
          {outcomeLabel(preflight.outcome)}
        </Badge>
      </p>
      <p>
        {t("extensions.update_rollback_line", {
          policy: rollbackPolicyLabel(preflight.target.rollback_policy),
        })}
        {preflight.target.backup_required ? t("extensions.update_backup_note") : ""}
      </p>
      {preflight.planned_core_migrations.length > 0 ? (
        <p>
          {t("extensions.update_migrations_line", {
            migrations: preflight.planned_core_migrations.join(", "),
          })}
        </p>
      ) : null}
      <IssueList issues={preflight.issues} />
      {canManage && preflight.target.manual_steps.length > 0 ? (
        <Card title={t("extensions.update_manual_steps")}>
          <ul>
            {preflight.target.manual_steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </Card>
      ) : null}
      {canManage && blocking.length === 0 ? (
        <p className="muted">
          {t("extensions.update_cli_note")} <code>{t("extensions.update_apply_command")}</code>.
        </p>
      ) : null}
      <p className="pcms-field__hint">{t("extensions.update_scope_hint")}</p>
      <Button onClick={load}>{t("extensions.refresh")}</Button>
    </div>
  );
}

export default function ExtensionsScreen() {
  const { can } = useAuth();
  const canManage = can("extensions.manage");
  const [active, setActive] = useState("extensions");
  return (
    <div data-testid="extensions-screen">
      <div className="pcms-toolbar">
        <h1>{t("extensions.title")}</h1>
      </div>
      <p className="pcms-field__hint">{t("extensions.subtitle")}</p>
      <Tabs
        label={t("extensions.tabs_label")}
        active={active}
        onSelect={setActive}
        items={[
          { id: "extensions", title: t("extensions.tab_extensions") },
          { id: "compatibility", title: t("extensions.tab_compatibility") },
          { id: "update", title: t("extensions.tab_updates") },
        ]}
      />
      <TabPanel id="extensions" active={active === "extensions"}>
        <ExtensionsTab canManage={canManage} can={can} />
      </TabPanel>
      <TabPanel id="compatibility" active={active === "compatibility"}>
        <DeprecationsTab />
      </TabPanel>
      <TabPanel id="update" active={active === "update"}>
        <UpdateTab canManage={canManage} />
      </TabPanel>
    </div>
  );
}
