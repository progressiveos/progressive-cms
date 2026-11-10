// Human configuration of ONE payment connection (CORE-PAYMENTS-ADMIN-CONFIG-01
// §5): schema-driven ordinary fields, write-only credentials (set / replace /
// remove), the callback address with a copy button, an offline check and one
// atomic Save. There is no raw-JSON field and no process-secret name here.
//
// Safety rules enforced by this component:
//   - a saved credential value is never rendered (no value, no mask): the form
//     shows only "configured" and an empty "new value" input;
//   - raw values live in component state only and are dropped after save,
//     close, or when the dialog unmounts — never in localStorage / the URL;
//   - a 409 keeps the form open and offers to reload the current settings;
//   - field errors point at the field and nothing is partially applied.
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, apiPut, describeApiError } from "../../api/client.js";
import { Dialog } from "../../design/dialog.js";
import { type DocError, type DocState, fromConfig, toConfig } from "../../design/schema-model.js";
import {
  isUnsupportedShape,
  SchemaField,
  splitByAdvanced,
  type FieldMeta,
} from "../../design/schema-form.js";
import {
  Badge,
  Button,
  ErrorPanel,
  Field,
  Input,
  Spinner,
  Switch,
  Textarea,
} from "../../design/ui.js";
import { t } from "../../i18n/index.js";
import { isPemSlot, providerAdvancedKeys, providerFieldMeta } from "./provider-fields.js";

interface SlotWire {
  readonly slot: string;
  readonly configured: boolean;
  readonly source: "runtime" | "legacy" | null;
  readonly updated_at: string | null;
}

interface ReadinessWire {
  readonly ready: boolean;
  readonly code: string;
  readonly missing: readonly string[];
  readonly unreadable: readonly string[];
  readonly configIssues: readonly string[];
  readonly legacyRefs: readonly string[];
  readonly detail: string;
}

export interface SettingsWire {
  readonly instance: {
    readonly id: string;
    readonly provider_type: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly config: Record<string, unknown>;
    readonly settings_generation: number;
    readonly updated_at: string;
  };
  readonly config_schema: { readonly properties?: Readonly<Record<string, never>> } | null;
  readonly secret_requirements: readonly string[];
  readonly slots: readonly SlotWire[];
  readonly readiness: ReadinessWire;
  readonly secret_box: { readonly available: boolean; readonly code?: string };
  readonly config_supported: boolean;
  readonly callback: { readonly url: string | null; readonly hint: string };
}

const READINESS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  ready: "success",
  disabled: "warning",
  credentials_missing: "warning",
  credentials_unreadable: "danger",
  config_invalid: "danger",
  config_unsupported: "danger",
  provider_not_composed: "danger",
  legacy_refs_import_pending: "warning",
  legacy_refs_pending_import: "warning",
};

const READINESS_LABEL_KEY: Record<string, string> = {
  ready: "payments.readiness_ready",
  disabled: "payments.readiness_disabled",
  credentials_missing: "payments.readiness_missing",
  credentials_unreadable: "payments.readiness_unreadable",
  config_invalid: "payments.readiness_config_invalid",
  config_unsupported: "payments.readiness_unsupported",
  provider_not_composed: "payments.readiness_absent",
  legacy_refs_pending_import: "payments.readiness_legacy",
};

export function ProviderSettingsDialog(props: {
  readonly instanceId: string;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [detail, setDetail] = useState<SettingsWire | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [doc, setDoc] = useState<DocState>({ scalars: {}, lists: {}, nested: {} });
  const [enabled, setEnabled] = useState(false);
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [clearedSlots, setClearedSlots] = useState<readonly string[]>([]);
  const [fieldErrors, setFieldErrors] = useState<readonly DocError[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testChecks, setTestChecks] = useState<
    readonly { readonly check: string; readonly ok: boolean; readonly detail: string }[] | null
  >(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    setLoadError(null);
    apiGet<SettingsWire>(`/payments/providers/instances/${props.instanceId}/settings`)
      .then((result) => {
        setDetail(result);
        setName(result.instance.name);
        setEnabled(result.instance.enabled);
        const properties =
          (result.config_schema as { properties?: never } | null)?.properties ?? {};
        setDoc(fromConfig(properties, result.instance.config));
        // Credential values are never loaded back: the inputs start empty.
        setSecretInputs({});
        setClearedSlots([]);
        setConflict(false);
      })
      .catch((cause: unknown) => setLoadError(describeApiError(cause)));
  }, [props.instanceId]);

  useEffect(() => {
    load();
  }, [load]);

  // Raw values must not outlive the dialog.
  useEffect(
    () => () => {
      setSecretInputs({});
    },
    [],
  );

  const properties = useMemo(
    () =>
      ((detail?.config_schema as { properties?: Record<string, never> } | null)?.properties ??
        {}) as Record<string, never>,
    [detail],
  );
  const advancedKeys = useMemo(
    () => providerAdvancedKeys(detail?.instance.provider_type ?? "", Object.keys(properties)),
    [detail, properties],
  );
  const groups = useMemo(
    () => splitByAdvanced(properties, advancedKeys),
    [properties, advancedKeys],
  );

  const readOnly = detail === null ? true : !detail.secret_box.available;

  const setSecret = (slot: string, value: string) => {
    setSecretInputs((current) => ({ ...current, [slot]: value }));
  };
  const clearSecret = (slot: string) => {
    setClearedSlots((current) => (current.includes(slot) ? current : [...current, slot]));
    setSecretInputs((current) => {
      const next = { ...current };
      delete next[slot];
      return next;
    });
  };

  const save = () => {
    if (detail === null) return;
    const built = toConfig(properties, doc, detail.instance.config);
    if (!built.ok) {
      setFieldErrors(built.errors);
      setMessage(t("payments.settings_fix_fields"));
      return;
    }
    setFieldErrors([]);
    const secretUpdates: Record<string, { action: "set"; value: string } | { action: "clear" }> =
      {};
    for (const slot of detail.secret_requirements) {
      const value = secretInputs[slot] ?? "";
      if (value.trim() !== "") secretUpdates[slot] = { action: "set", value };
      else if (clearedSlots.includes(slot)) secretUpdates[slot] = { action: "clear" };
    }
    setBusy(true);
    setMessage(null);
    setConflict(false);
    apiPut<SettingsWire>(`/payments/providers/instances/${detail.instance.id}/settings`, {
      expected_generation: detail.instance.settings_generation,
      name: name.trim(),
      config: built.config,
      enabled,
      ...(Object.keys(secretUpdates).length === 0 ? {} : { secret_updates: secretUpdates }),
    })
      .then((result) => {
        // Drop the raw values immediately after a successful save.
        setSecretInputs({});
        setClearedSlots([]);
        setDetail(result);
        setMessage(t("payments.settings_saved"));
        props.onSaved();
      })
      .catch((cause: unknown) => {
        const text = describeApiError(cause);
        setMessage(text);
        if (text.includes("PAYMENT_SETTINGS_CONFLICT") || text.includes("another editor")) {
          setConflict(true);
        }
      })
      .finally(() => setBusy(false));
  };

  const test = () => {
    if (detail === null) return;
    setBusy(true);
    setMessage(null);
    apiPost<{ ok: boolean; checks: readonly { check: string; ok: boolean; detail: string }[] }>(
      `/payments/providers/instances/${detail.instance.id}/test`,
      {},
    )
      .then((result) => {
        setTestChecks(result.checks);
        setMessage(result.ok ? t("payments.settings_test_ok") : t("payments.settings_test_fail"));
      })
      .catch((cause: unknown) => setMessage(describeApiError(cause)))
      .finally(() => setBusy(false));
  };

  const copyCallback = () => {
    const url = detail?.callback.url;
    if (url === null || url === undefined) return;
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const meta = (key: string): FieldMeta =>
    providerFieldMeta(detail?.instance.provider_type ?? "", key);

  const errorFor = (path: string): DocError | undefined =>
    fieldErrors.find((error) => error.path === path);

  const secretConfigured = (slot: string): boolean => {
    if (clearedSlots.includes(slot)) return false;
    return detail?.slots.some((entry) => entry.slot === slot && entry.configured) === true;
  };

  const readiness = detail?.readiness;
  const readinessTone =
    readiness === undefined ? "neutral" : (READINESS_TONE[readiness.code] ?? "neutral");

  return (
    <Dialog
      open
      onClose={props.onClose}
      wide
      title={t("payments.settings_title")}
      footer={
        <>
          <span className="pcms-field__hint" role="status">
            {message}
          </span>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" onClick={props.onClose}>
            {t("cancel")}
          </Button>
          <Button onClick={test} disabled={busy || detail === null}>
            {t("payments.settings_test")}
          </Button>
          <Button
            variant="primary"
            onClick={save}
            disabled={busy || detail === null || name.trim() === ""}
          >
            {t("core.save")}
          </Button>
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
        <div style={{ display: "grid", gap: 14, maxWidth: 720 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <code>{detail.instance.provider_type}</code>
            <Badge tone={readinessTone}>
              {t(READINESS_LABEL_KEY[readiness?.code ?? ""] ?? "payments.readiness_unknown")}
            </Badge>
            {detail.instance.enabled ? (
              <Badge tone="success">{t("payments.instance_enabled")}</Badge>
            ) : (
              <Badge tone="warning">{t("payments.instance_disabled")}</Badge>
            )}
          </div>
          <p style={{ margin: 0, opacity: 0.75 }}>{readiness?.detail}</p>
          {conflict ? (
            <div role="alert" style={{ display: "grid", gap: 6 }}>
              <span>{t("payments.settings_conflict")}</span>
              <div>
                <Button variant="ghost" onClick={load}>
                  {t("payments.settings_reload")}
                </Button>
              </div>
            </div>
          ) : null}
          {!detail.secret_box.available ? (
            <ErrorPanel message={t("payments.settings_key_missing")} />
          ) : null}

          <Field label={t("payments.instance_name")}>
            <Input value={name} onChange={(event) => setName(event.currentTarget.value)} />
          </Field>

          {detail.secret_requirements.length > 0 ? (
            <section style={{ display: "grid", gap: 10 }}>
              <h3 className="pcms-admin-h4" style={{ margin: 0 }}>
                {t("payments.settings_credentials")}
              </h3>
              {detail.secret_requirements.map((slot) => {
                const configured = secretConfigured(slot);
                return (
                  <Field
                    key={slot}
                    label={meta(slot).label}
                    {...(meta(slot).hint === undefined ? {} : { hint: meta(slot).hint })}
                    {...(() => {
                      const message = errorFor(slot)?.message;
                      return message === undefined ? {} : { error: t(message) };
                    })()}
                  >
                    <div style={{ display: "grid", gap: 6 }}>
                      <div
                        style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
                      >
                        <Badge tone={configured ? "success" : "warning"}>
                          {configured
                            ? t("payments.settings_secret_set")
                            : t("payments.settings_secret_not_set")}
                        </Badge>
                        {configured ? (
                          <Button variant="ghost" onClick={() => clearSecret(slot)} disabled={busy}>
                            {t("payments.settings_secret_clear")}
                          </Button>
                        ) : null}
                      </div>
                      {isPemSlot(slot) ? (
                        <Textarea
                          rows={5}
                          spellCheck={false}
                          autoComplete="off"
                          style={{ fontFamily: "monospace" }}
                          placeholder={
                            configured
                              ? t("payments.settings_secret_keep")
                              : t("payments.settings_secret_placeholder")
                          }
                          value={secretInputs[slot] ?? ""}
                          onChange={(event) => setSecret(slot, event.target.value)}
                        />
                      ) : (
                        <Input
                          type="password"
                          autoComplete="new-password"
                          spellCheck={false}
                          placeholder={
                            configured
                              ? t("payments.settings_secret_keep")
                              : t("payments.settings_secret_placeholder")
                          }
                          value={secretInputs[slot] ?? ""}
                          onChange={(event) => setSecret(slot, event.target.value)}
                        />
                      )}
                    </div>
                  </Field>
                );
              })}
              <p className="pcms-field__hint" style={{ margin: 0 }}>
                {t("payments.settings_credentials_hint")}
              </p>
            </section>
          ) : null}

          <section style={{ display: "grid", gap: 10 }}>
            <h3 className="pcms-admin-h4" style={{ margin: 0 }}>
              {t("payments.settings_parameters")}
            </h3>
            {groups.primary.length === 0 ? (
              <p className="pcms-field__hint" style={{ margin: 0 }}>
                {t("payments.settings_no_parameters")}
              </p>
            ) : null}
            {groups.primary.map((key) => (
              <SchemaField
                key={key}
                propertyKey={key}
                schema={properties[key] ?? {}}
                meta={meta(key)}
                state={doc}
                onChange={setDoc}
                error={errorFor(key)}
                disabled={busy}
              />
            ))}
            {groups.advanced.length > 0 ? (
              <div>
                <Button variant="ghost" onClick={() => setAdvancedOpen((open) => !open)}>
                  {advancedOpen
                    ? t("payments.settings_advanced_hide")
                    : t("payments.settings_advanced_show")}
                </Button>
                {advancedOpen ? (
                  <div style={{ display: "grid", gap: 10, marginTop: 8 }}>
                    {groups.advanced.map((key) => (
                      <SchemaField
                        key={key}
                        propertyKey={key}
                        schema={properties[key] ?? {}}
                        meta={meta(key)}
                        state={doc}
                        onChange={setDoc}
                        error={errorFor(key)}
                        disabled={busy}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {Object.entries(properties).some(([, schema]) => isUnsupportedShape(schema)) ? (
              <p className="pcms-field__hint" style={{ margin: 0 }}>
                {t("payments.settings_unsupported_shape")}
              </p>
            ) : null}
          </section>

          <section style={{ display: "grid", gap: 6 }}>
            <h3 className="pcms-admin-h4" style={{ margin: 0 }}>
              {t("payments.settings_callback")}
            </h3>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <code data-testid="payment-callback-url">{detail.callback.url ?? "—"}</code>
              <Button
                variant="ghost"
                disabled={detail.callback.url === null}
                onClick={copyCallback}
              >
                {copied ? t("payments.settings_copied") : t("payments.settings_copy")}
              </Button>
            </div>
            <p className="pcms-field__hint" style={{ margin: 0 }}>
              {detail.callback.hint}
            </p>
          </section>

          <section style={{ display: "grid", gap: 6 }}>
            <h3 className="pcms-admin-h4" style={{ margin: 0 }}>
              {t("payments.settings_enable_title")}
            </h3>
            {/* The switch stays interactive: readiness describes the STORED
                state, while this save may be adding the missing credentials.
                The server refuses an incomplete enable and the error is shown
                in place — no deadlock, no optimistic flip. */}
            <Switch
              label={t("payments.settings_enable")}
              checked={enabled}
              disabled={busy}
              onChange={setEnabled}
            />
            <p className="pcms-field__hint" style={{ margin: 0 }}>
              {t("payments.settings_enable_hint")}
            </p>
          </section>

          {testChecks !== null ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {testChecks.map((check) => (
                <li key={check.check}>
                  <Badge
                    tone={
                      check.ok
                        ? "success"
                        : check.check === "live_provider_check"
                          ? "neutral"
                          : "danger"
                    }
                  >
                    {check.ok
                      ? t("payments.check_ok")
                      : check.check === "live_provider_check"
                        ? t("payments.check_na")
                        : t("payments.check_fail")}
                  </Badge>{" "}
                  {check.detail}
                </li>
              ))}
            </ul>
          ) : null}
          {readOnly ? (
            <p className="pcms-field__hint">{t("payments.settings_readonly_storage")}</p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
