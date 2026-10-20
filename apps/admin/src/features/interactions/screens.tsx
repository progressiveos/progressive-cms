// Interactions workspace screens (PCMS-FORM-T022; owner productization pass
// 0.1.28). Human-first: visual form/quiz builders over the versioned
// definition model, submissions/runs with labels resolved against the exact
// historical version, lead lifecycle actions, and permission-gated CSV
// exports. Raw JSON survives only as a read-only Advanced view.
import { type DragEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import {
  ApiError,
  apiDelete,
  apiDownload,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
} from "../../api/client.js";
import { useAuth } from "../../auth/AuthContext.js";
import { Drawer } from "../../design/dialog.js";
import { useToast } from "../../design/toast.js";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Input,
  Select,
  Spinner,
  Switch,
  Textarea,
} from "../../design/ui.js";
import { useDebouncedReload } from "../../design/use-debounced-reload.js";
import { errorText, formatDateTime, t } from "../../i18n/index.js";
import { navigate } from "../../layout/router.js";
import { deliveryStatusLabel, humanEvent } from "../../screens/integrations/IntegrationsScreen.js";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const STATUS_TONES: Readonly<Record<string, Tone>> = {
  ACCEPTED: "success",
  SPAM: "danger",
  ARCHIVED: "neutral",
  NEW: "accent",
  VIEWED: "warning",
  PROCESSED: "success",
  STARTED: "warning",
  COMPLETED: "success",
  ABANDONED: "neutral",
  EXPIRED: "neutral",
};

const STATUS_LABEL_KEYS: Readonly<Record<string, string>> = {
  ACTIVE: "interactions.status_active",
  ACCEPTED: "interactions.status_accepted",
  SPAM: "interactions.status_spam",
  ARCHIVED: "interactions.status_archived",
  NEW: "interactions.status_new",
  VIEWED: "interactions.status_viewed",
  PROCESSED: "interactions.status_processed",
  STARTED: "interactions.state_started",
  COMPLETED: "interactions.state_completed",
  ABANDONED: "interactions.state_abandoned",
  EXPIRED: "interactions.state_expired",
};

/** Raw enum values for display; called during render, never at module scope. */
function statusLabel(value: string): string {
  const key = STATUS_LABEL_KEYS[value];
  return key === undefined ? value : t(key);
}

function failure(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? (errorText(caught.code) ?? caught.message) : fallback;
}

/** CSV export through the audited, permission-gated export operation. */
async function downloadExport(body: Record<string, unknown>, filename: string): Promise<void> {
  const blob = await apiDownload("POST", "/interactions/export", body);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function ExportButton(props: {
  readonly entity: "submissions" | "quiz_runs" | "leads";
  readonly filename: string;
  readonly filters?: Record<string, string>;
}) {
  const auth = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!auth.can("interactions.export")) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        downloadExport({ entity: props.entity, format: "csv", ...props.filters }, props.filename)
          .then(() => toast(t("interactions.export_done"), "success"))
          .catch((caught: unknown) =>
            toast(failure(caught, t("interactions.export_failed")), "error"),
          )
          .finally(() => setBusy(false));
      }}
    >
      {t("interactions.export_button")}
    </Button>
  );
}

// ─── Definitions (Forms / Quizzes) ─────────────────────────────────────────

/** Forms and quizzes definitions render identically — one row shape. */
interface DefinitionRow {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly schema_version: number;
  readonly status: string;
  readonly created_at: string;
}

function TableWrap(props: {
  readonly testId: string;
  readonly error: string | null;
  readonly rows: readonly unknown[] | null;
  readonly onRetry: () => void;
  readonly headers: readonly string[];
  readonly children: ReactNode;
}) {
  if (props.error !== null) {
    return (
      <div>
        <p>{props.error}</p>
        <Button onClick={props.onRetry}>{t("interactions.retry")}</Button>
      </div>
    );
  }
  if (props.rows === null) return <Spinner />;
  if (props.rows.length === 0) {
    return <EmptyState title={t("interactions.empty_title")} hint={t("interactions.empty_hint")} />;
  }
  return (
    <div className="pcms-table-wrap">
      <table className="pcms-table" data-testid={props.testId}>
        <thead>
          <tr>
            {props.headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>{props.children}</tbody>
      </table>
    </div>
  );
}

interface DefinitionListProps {
  readonly kind: "forms" | "quizzes";
  readonly testId: string;
  readonly tableTestId: string;
}

function DefinitionsScreen(props: DefinitionListProps) {
  const path = `/${props.kind}`;
  const uiPath = props.kind === "forms" ? "interactions/forms" : "interactions/quizzes";
  const [rows, setRows] = useState<readonly DefinitionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [keyValue, setKeyValue] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const toast = useToast();

  const reload = useCallback(() => {
    setError(null);
    apiGet<{ items: readonly DefinitionRow[] }>(path)
      .then((result) => setRows(result.items))
      .catch(() => setError(t("interactions.definitions_load_failed")));
  }, [path]);
  useEffect(() => {
    reload();
  }, [reload]);

  const create = async (): Promise<void> => {
    setBusy(true);
    setCreateError(null);
    try {
      const starter =
        props.kind === "forms"
          ? {
              key: keyValue,
              title,
              fields: [
                {
                  key: "name",
                  type: "text",
                  label: t("interactions.starter_name"),
                  required: true,
                },
                {
                  key: "contact",
                  type: "phone",
                  label: t("interactions.starter_phone"),
                  required: true,
                },
              ],
              settings: {},
            }
          : {
              key: keyValue,
              title,
              steps: [
                {
                  id: "step-1",
                  title: t("interactions.starter_step"),
                  questions: [
                    {
                      id: "q1",
                      type: "text",
                      label: t("interactions.starter_question"),
                      required: true,
                    },
                  ],
                },
              ],
              outcomes: [{ id: "result", title: t("interactions.starter_outcome") }],
              settings: {},
            };
      const created = await apiPost<{ id: string }>(path, starter);
      toast(t("interactions.created_toast"), "success");
      navigate(`${uiPath}/${created.id}`);
    } catch (caught) {
      setCreateError(failure(caught, t("interactions.create_failed_toast")));
    } finally {
      setBusy(false);
    }
  };

  const toggleArchive = async (row: DefinitionRow): Promise<void> => {
    try {
      await apiPatch(`${path}/${row.id}`, { archived: row.status !== "ARCHIVED" });
      reload();
    } catch {
      toast(t("interactions.status_failed_toast"), "error");
    }
  };

  if (error !== null) {
    return (
      <div>
        <p>{error}</p>
        <Button onClick={reload}>{t("interactions.retry")}</Button>
      </div>
    );
  }
  if (rows === null) return <Spinner />;

  return (
    <div className="pcms-screen--wide" data-testid={props.testId}>
      <h1>
        {props.kind === "forms" ? t("interactions.forms_title") : t("interactions.quizzes_title")}
      </h1>
      {rows.length === 0 && props.kind === "quizzes" ? (
        <EmptyState
          title={t("interactions.quizzes_empty_title")}
          hint={t("interactions.quizzes_empty_hint")}
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t("interactions.quizzes_empty_action")}
            </Button>
          }
        />
      ) : null}
      {rows.length === 0 && props.kind === "forms" ? (
        <EmptyState
          title={t("interactions.forms_empty_title")}
          hint={t("interactions.forms_empty_hint")}
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t("interactions.create_button")}
            </Button>
          }
        />
      ) : null}
      {rows.length > 0 ? (
        <div className="pcms-toolbar">
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t("interactions.create_button")}
          </Button>
        </div>
      ) : null}
      {creating ? (
        <div className="pcms-panel">
          <Field label={t("interactions.key_aria")} required hint={t("interactions.key_hint")}>
            <Input value={keyValue} onChange={(e) => setKeyValue(e.target.value)} />
          </Field>
          <Field label={t("interactions.title_aria")} required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          {createError !== null ? (
            <div className="pcms-field__error" role="alert">
              {createError}
            </div>
          ) : null}
          <div className="pcms-actions-row">
            <Button
              variant="primary"
              disabled={busy || keyValue.trim() === "" || title.trim() === ""}
              onClick={() => void create()}
            >
              {t("interactions.create_submit")}
            </Button>
            <Button onClick={() => setCreating(false)}>{t("interactions.cancel")}</Button>
          </div>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <TableWrap
          testId={props.tableTestId}
          error={null}
          rows={rows}
          onRetry={reload}
          headers={[
            t("interactions.th_title"),
            t("interactions.th_key"),
            t("interactions.th_version"),
            t("interactions.th_status"),
            t("interactions.th_created"),
            "",
          ]}
        >
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <a href={`#/${uiPath}/${row.id}`}>{row.title}</a>
              </td>
              <td>{row.key}</td>
              <td>{t("interactions.version_prefix", { no: row.schema_version })}</td>
              <td>
                <Badge tone={row.status === "ACTIVE" ? "success" : "neutral"}>
                  {statusLabel(row.status)}
                </Badge>
              </td>
              <td>{formatDateTime(row.created_at)}</td>
              <td>
                <div className="pcms-row__actions">
                  <Button size="sm" onClick={() => navigate(`${uiPath}/${row.id}`)}>
                    {t("interactions.edit_button")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void toggleArchive(row)}>
                    {row.status === "ACTIVE"
                      ? t("interactions.archive_button")
                      : t("interactions.restore_button")}
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </TableWrap>
      ) : null}
    </div>
  );
}

// ─── Field type descriptors (from the backend allowlist — never hardcoded) ──

interface FieldTypeDescriptor {
  readonly type: string;
  readonly supports: readonly string[];
}

function useFieldTypeDescriptors(): readonly FieldTypeDescriptor[] | null {
  const [descriptors, setDescriptors] = useState<readonly FieldTypeDescriptor[] | null>(null);
  useEffect(() => {
    apiGet<{ items: readonly FieldTypeDescriptor[] }>("/forms/field-types")
      .then((result) => setDescriptors(result.items))
      .catch(() => setDescriptors([]));
  }, []);
  return descriptors;
}

interface OptionDraft {
  readonly value: string;
  readonly label: string;
}

interface FieldDraft {
  readonly key: string;
  readonly type: string;
  readonly label: string;
  readonly required: boolean;
  readonly help: string;
  readonly placeholder: string;
  readonly min_length: string;
  readonly max_length: string;
  readonly pattern: string;
  readonly min: string;
  readonly max: string;
  readonly options: readonly OptionDraft[];
  readonly expected_value: string;
  readonly consent_key: string;
  readonly consent_text: string;
  readonly policy_reference: string;
}

function emptyField(key: string, type: string): FieldDraft {
  return {
    key,
    type,
    label: "",
    required: false,
    help: "",
    placeholder: "",
    min_length: "",
    max_length: "",
    pattern: "",
    min: "",
    max: "",
    options: [],
    expected_value: "",
    consent_key: "",
    consent_text: "",
    policy_reference: "",
  };
}

function fieldFromWire(wire: Record<string, unknown>): FieldDraft {
  const text = (key: string): string =>
    typeof wire[key] === "string" ? (wire[key] as string) : "";
  const num = (key: string): string => (typeof wire[key] === "number" ? String(wire[key]) : "");
  const options = Array.isArray(wire.options)
    ? wire.options.map((option) => {
        const record = (option ?? {}) as Record<string, unknown>;
        return {
          value: typeof record.value === "string" ? record.value : "",
          label: typeof record.label === "string" ? record.label : "",
        };
      })
    : [];
  return {
    ...emptyField(text("key"), text("type")),
    label: text("label"),
    required: wire.required === true,
    help: text("help"),
    placeholder: text("placeholder"),
    min_length: num("min_length"),
    max_length: num("max_length"),
    pattern: text("pattern"),
    min: num("min"),
    max: num("max"),
    options,
    expected_value: text("expected_value"),
    consent_key: text("consent_key"),
    consent_text: text("consent_text"),
    policy_reference: text("policy_reference"),
  };
}

function fieldToWire(field: FieldDraft): Record<string, unknown> {
  const wire: Record<string, unknown> = { key: field.key, type: field.type, label: field.label };
  if (field.required) wire.required = true;
  if (field.help !== "") wire.help = field.help;
  if (field.placeholder !== "") wire.placeholder = field.placeholder;
  if (field.min_length !== "") wire.min_length = Number(field.min_length);
  if (field.max_length !== "") wire.max_length = Number(field.max_length);
  if (field.pattern !== "") wire.pattern = field.pattern;
  if (field.min !== "") wire.min = Number(field.min);
  if (field.max !== "") wire.max = Number(field.max);
  if (field.options.length > 0) {
    wire.options = field.options.filter((option) => option.value !== "");
  }
  if (field.expected_value !== "") wire.expected_value = field.expected_value;
  if (field.type === "consent") {
    if (field.consent_key !== "") wire.consent_key = field.consent_key;
    if (field.consent_text !== "") wire.consent_text = field.consent_text;
    if (field.policy_reference !== "") wire.policy_reference = field.policy_reference;
  }
  return wire;
}

function FieldEditorCard(props: {
  readonly field: FieldDraft;
  readonly descriptors: readonly FieldTypeDescriptor[];
  readonly index: number;
  readonly count: number;
  readonly onChange: (field: FieldDraft) => void;
  readonly onRemove: () => void;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onDragStart: () => void;
  readonly onDragOver: (event: DragEvent) => void;
  readonly onDrop: () => void;
}) {
  const { field, descriptors } = props;
  const supports = new Set(
    descriptors.find((d) => d.type === field.type)?.supports ?? ["required", "help"],
  );
  const set = (patch: Partial<FieldDraft>) => props.onChange({ ...field, ...patch });
  const setOption = (index: number, patch: Partial<OptionDraft>) =>
    set({
      options: field.options.map((option, i) => (i === index ? { ...option, ...patch } : option)),
    });
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag handle card — no semantic draggable element
    <div
      className="pcms-panel pcms-field-card"
      draggable
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
    >
      <div className="pcms-toolbar">
        <strong>
          {props.index + 1}. {field.label === "" ? field.key : field.label}
        </strong>
        <span className="pcms-toolbar__spacer" />
        <IconButton
          icon="move"
          small
          label={t("interactions.field_drag")}
          className="pcms-field-card__handle"
        />
        <IconButton
          icon="arrowUp"
          small
          label={t("interactions.field_move_up")}
          disabled={props.index === 0}
          onClick={() => props.onMove(-1)}
        />
        <IconButton
          icon="arrowDown"
          small
          label={t("interactions.field_move_down")}
          disabled={props.index === props.count - 1}
          onClick={() => props.onMove(1)}
        />
        <IconButton
          icon="delete"
          small
          label={t("interactions.field_remove")}
          onClick={props.onRemove}
        />
      </div>
      <div className="pcms-form-grid">
        <Field label={t("interactions.field_label")} required>
          <Input value={field.label} onChange={(e) => set({ label: e.target.value })} />
        </Field>
        <Field label={t("interactions.field_type")}>
          <Select value={field.type} onChange={(e) => set({ type: e.target.value })}>
            {descriptors.map((descriptor) => (
              <option key={descriptor.type} value={descriptor.type}>
                {t(`interactions.fieldtype_${descriptor.type}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Switch
        label={t("interactions.field_required")}
        checked={field.required}
        disabled={!supports.has("required")}
        onChange={(checked) => set({ required: checked })}
      />
      {supports.has("placeholder") ? (
        <Field label={t("interactions.field_placeholder")}>
          <Input value={field.placeholder} onChange={(e) => set({ placeholder: e.target.value })} />
        </Field>
      ) : null}
      <Field label={t("interactions.field_help")}>
        <Input value={field.help} onChange={(e) => set({ help: e.target.value })} />
      </Field>
      {supports.has("min_length") || supports.has("max_length") ? (
        <div className="pcms-form-grid">
          <Field label={t("interactions.field_min_length")}>
            <Input
              type="number"
              value={field.min_length}
              onChange={(e) => set({ min_length: e.target.value })}
            />
          </Field>
          <Field label={t("interactions.field_max_length")}>
            <Input
              type="number"
              value={field.max_length}
              onChange={(e) => set({ max_length: e.target.value })}
            />
          </Field>
        </div>
      ) : null}
      {supports.has("pattern") ? (
        <Field label={t("interactions.field_pattern")} hint={t("interactions.field_pattern_hint")}>
          <Input value={field.pattern} onChange={(e) => set({ pattern: e.target.value })} />
        </Field>
      ) : null}
      {supports.has("min") || supports.has("max") ? (
        <div className="pcms-form-grid">
          <Field label={t("interactions.field_min")}>
            <Input type="number" value={field.min} onChange={(e) => set({ min: e.target.value })} />
          </Field>
          <Field label={t("interactions.field_max")}>
            <Input type="number" value={field.max} onChange={(e) => set({ max: e.target.value })} />
          </Field>
        </div>
      ) : null}
      {supports.has("expected_value") ? (
        <Field label={t("interactions.field_expected")}>
          <Input
            value={field.expected_value}
            onChange={(e) => set({ expected_value: e.target.value })}
          />
        </Field>
      ) : null}
      {supports.has("options") ? (
        <fieldset className="pcms-fieldset">
          <legend>{t("interactions.field_options")}</legend>
          {field.options.map((option, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: editable rows — value-derived keys would remount inputs mid-keystroke
            <div key={index} className="pcms-row">
              <Input
                aria-label={t("interactions.option_value_aria")}
                placeholder={t("interactions.option_value")}
                value={option.value}
                onChange={(e) => setOption(index, { value: e.target.value })}
              />
              <Input
                aria-label={t("interactions.option_label_aria")}
                placeholder={t("interactions.option_label")}
                value={option.label}
                onChange={(e) => setOption(index, { label: e.target.value })}
              />
              <IconButton
                icon="delete"
                small
                label={t("interactions.option_remove")}
                onClick={() => set({ options: field.options.filter((_, i) => i !== index) })}
              />
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              set({
                options: [...field.options, { value: `opt${field.options.length + 1}`, label: "" }],
              })
            }
          >
            {t("interactions.option_add")}
          </Button>
        </fieldset>
      ) : null}
      {supports.has("consent") ? (
        <>
          <Field label={t("interactions.consent_key")} required>
            <Input
              value={field.consent_key}
              onChange={(e) => set({ consent_key: e.target.value })}
            />
          </Field>
          <Field label={t("interactions.consent_text")}>
            <Textarea
              rows={2}
              value={field.consent_text}
              onChange={(e) => set({ consent_text: e.target.value })}
            />
          </Field>
          <Field
            label={t("interactions.consent_policy")}
            hint={t("interactions.consent_policy_hint")}
          >
            <Input
              value={field.policy_reference}
              onChange={(e) => set({ policy_reference: e.target.value })}
            />
          </Field>
        </>
      ) : null}
    </div>
  );
}

/** Delivery projection row type (READ projection over IntegrationDelivery). */
interface LeadDeliveryWire {
  readonly id: string;
  readonly event_type: string;
  readonly connector_type: string | null;
  readonly instance_name: string | null;
  readonly status: string;
  readonly external_id?: string | null;
  readonly last_error_code?: string | null;
  readonly attempt_count: number;
  readonly max_attempts: number;
}

/** Owner task §62/§63: where this enquiry already went (HQ, Telegram, …).
 * READ projection over existing records — statuses human, ids secondary. */
function DeliveryProjectionList(props: {
  readonly deliveries: readonly LeadDeliveryWire[] | undefined;
}) {
  const empty = props.deliveries === undefined || props.deliveries.length === 0;
  return (
    <div data-testid="lead-deliveries">
      <h3>{t("interactions.deliveries_title")}</h3>
      {empty ? (
        <p className="pcms-field__hint">{t("interactions.deliveries_none")}</p>
      ) : (
        props.deliveries.map((delivery) => (
          <div key={delivery.id} className="pcms-row" style={{ alignItems: "center" }}>
            <Badge tone={DELIVERY_TONES[delivery.status] ?? "neutral"}>
              {deliveryStatusLabel(delivery.status)}
            </Badge>
            <span>{delivery.instance_name ?? delivery.connector_type ?? "—"}</span>
            <span className="pcms-picker-row__meta">{humanEvent(delivery.event_type)}</span>
            {delivery.external_id != null && delivery.external_id !== "" ? (
              <span className="pcms-picker-row__meta">
                {t("integrations.external_id")}: {delivery.external_id}
              </span>
            ) : null}
            {delivery.last_error_code != null && delivery.last_error_code !== "" ? (
              <Badge tone="danger">{delivery.last_error_code}</Badge>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}

const DELIVERY_TONES: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  SUCCEEDED: "success",
  PENDING: "neutral",
  PROCESSING: "warning",
  FAILED_RETRYABLE: "warning",
  FAILED_PERMANENT: "danger",
  CANCELLED: "neutral",
};

/** Notifications projection: existing M13 bindings for form/lead events,
 * shown as per-connection statuses (owner sketch §61). */
function NotificationsPanel(props: { readonly events: readonly string[] }) {
  const auth = useAuth();
  const [bindings, setBindings] = useState<
    | readonly {
        event_type: string;
        enabled: boolean;
        actions: readonly { instance_id?: string }[];
      }[]
    | null
  >(null);
  const [instances, setInstances] = useState<
    readonly { id: string; name: string; connector_type: string }[] | null
  >(null);
  useEffect(() => {
    if (!auth.can("integrations.read")) return;
    void Promise.all([
      apiGet<{
        items: readonly {
          event_type: string;
          enabled: boolean;
          actions: readonly { instance_id?: string }[];
        }[];
      }>("/integrations/bindings"),
      apiGet<{
        items: readonly { id: string; name: string; connector_type: string }[];
      }>("/integrations/instances"),
    ])
      .then(([bindingsResult, instancesResult]) => {
        setBindings(bindingsResult.items);
        setInstances(instancesResult.items);
      })
      .catch(() => {
        setBindings([]);
        setInstances([]);
      });
  }, [auth]);
  if (!auth.can("integrations.read") || bindings === null || instances === null) return null;
  const relevant = bindings.filter((binding) => props.events.includes(binding.event_type));
  const boundInstanceIds = new Set(
    relevant.flatMap((binding) =>
      binding.actions
        .map((action) => action.instance_id)
        .filter((id): id is string => typeof id === "string"),
    ),
  );
  return (
    <div className="pcms-panel" data-testid="notifications-panel">
      <h3>{t("interactions.notifications_section")}</h3>
      {relevant.length === 0 ? (
        <p className="pcms-field__hint">{t("interactions.notifications_none")}</p>
      ) : null}
      {instances.map((instance) => (
        <div key={instance.id} className="pcms-row" style={{ alignItems: "center" }}>
          {boundInstanceIds.has(instance.id) ? (
            <Badge tone="success">{t("interactions.notifications_ready")}</Badge>
          ) : (
            <Badge>{t("interactions.notifications_missing")}</Badge>
          )}
          <span>{instance.name}</span>
        </div>
      ))}
      <p className="pcms-field__hint">{t("interactions.notifications_hint")}</p>
      <Button size="sm" variant="ghost" onClick={() => navigate("integrations")}>
        {t("interactions.notifications_configure")}
      </Button>
    </div>
  );
}

/** Definition usage + stats summary line. */
function UsagePanel(props: { readonly kind: "forms" | "quizzes"; readonly id: string }) {
  const path = props.kind === "forms" ? `/forms/${props.id}` : `/quizzes/${props.id}`;
  const [usage, setUsage] = useState<readonly { entry_id: string; title: string }[] | null>(null);
  const [stats, setStats] = useState<{ primary: number; completed: number; leads: number } | null>(
    null,
  );
  useEffect(() => {
    apiGet<{ entries: readonly { entry_id: string; title: string }[] }>(`${path}/usage`)
      .then((result) => setUsage(result.entries))
      .catch(() => setUsage([]));
    apiGet<{ primary: number; completed: number; leads: number }>(`${path}/stats`)
      .then(setStats)
      .catch(() => setStats(null));
  }, [path]);
  return (
    <div className="pcms-panel" data-testid="usage-panel">
      <h3>{t("interactions.usage_title")}</h3>
      {stats !== null ? (
        <p>
          {props.kind === "forms"
            ? t("interactions.usage_submissions", { count: stats.primary })
            : t("interactions.usage_runs", { count: stats.primary })}
          {props.kind === "quizzes"
            ? ` · ${t("interactions.usage_completed", { count: stats.completed })}`
            : ""}{" "}
          · {t("interactions.usage_leads", { count: stats.leads })}
        </p>
      ) : null}
      {usage === null ? null : usage.length === 0 ? (
        <p className="pcms-field__hint">{t("interactions.usage_none")}</p>
      ) : (
        <>
          <p className="pcms-field__hint">{t("interactions.usage_used_on")}</p>
          <ul>
            {usage.map((entry) => (
              <li key={entry.entry_id}>
                <a href={`#/content/${entry.entry_id}`}>
                  {entry.title === "" ? t("tree_untitled") : entry.title}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

interface SettingsDraft {
  successType: string;
  successMessage: string;
  successPath: string;
  successUrl: string;
  honeypot: string;
  retentionMode: string;
  retentionDays: string;
  createLead: boolean;
  leadClassification: string;
  leadNameFrom: string;
  leadEmailFrom: string;
  leadPhoneFrom: string;
  leadSummaryFrom: string;
}

function wireSettings(draft: SettingsDraft, fieldKeys: readonly string[]): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  if (draft.successType !== "") {
    const success: Record<string, unknown> = { type: draft.successType };
    if (draft.successMessage !== "") success.message = draft.successMessage;
    if (draft.successPath !== "") success.path = draft.successPath;
    if (draft.successUrl !== "") success.url = draft.successUrl;
    settings.success_behavior = success;
  }
  if (draft.honeypot !== "") settings.spam_policy = { honeypot_field: draft.honeypot };
  if (draft.retentionMode !== "") {
    const retention: Record<string, unknown> = { mode: draft.retentionMode };
    if (draft.retentionDays !== "") retention.after_days = Number(draft.retentionDays);
    settings.retention = retention;
  }
  if (draft.createLead) {
    const lead: Record<string, unknown> = { create_lead: true };
    if (draft.leadClassification !== "") lead.classification = draft.leadClassification;
    for (const [key, mapping] of [
      ["name_from", draft.leadNameFrom],
      ["email_from", draft.leadEmailFrom],
      ["phone_from", draft.leadPhoneFrom],
      ["summary_from", draft.leadSummaryFrom],
    ] as const) {
      if (mapping !== "" && fieldKeys.includes(mapping)) lead[key] = mapping;
    }
    settings.lead_policy = lead;
  }
  return settings;
}

function FormEditorScreen(props: { readonly formId: string }) {
  const toast = useToast();
  const auth = useAuth();
  const descriptors = useFieldTypeDescriptors();
  const [loading, setLoading] = useState(true);
  const [keyLabel, setKeyLabel] = useState("");
  const [title, setTitle] = useState("");
  const [version, setVersion] = useState(0);
  const [fields, setFields] = useState<readonly FieldDraft[]>([]);
  const [settings, setSettings] = useState<SettingsDraft>(defaultSettings());
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const canManage = auth.can("forms.manage_definition");

  const reload = useCallback(() => {
    setLoading(true);
    apiGet<Record<string, unknown>>(`/forms/${props.formId}`)
      .then((definition) => {
        setKeyLabel(typeof definition.key === "string" ? definition.key : "");
        setTitle(typeof definition.title === "string" ? definition.title : "");
        setVersion(typeof definition.schema_version === "number" ? definition.schema_version : 0);
        const wire = Array.isArray(definition.fields) ? definition.fields : [];
        setFields(wire.map((field) => fieldFromWire((field ?? {}) as Record<string, unknown>)));
        const raw = (definition.settings ?? {}) as Record<string, unknown>;
        setSettings(settingsFromWire(raw));
        setLoading(false);
      })
      .catch(() => {
        toast(t("interactions.definitions_load_failed"), "error");
        setLoading(false);
      });
  }, [props.formId, toast]);
  useEffect(() => {
    reload();
  }, [reload]);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await apiPut(`/forms/${props.formId}`, {
        title,
        fields: fields.map(fieldToWire),
        settings: wireSettings(
          settings,
          fields.map((field) => field.key),
        ),
      });
      toast(t("interactions.saved_new_version"), "success");
      reload();
    } catch (caught) {
      toast(failure(caught, t("interactions.save_failed")), "error");
    } finally {
      setBusy(false);
    }
  };

  if (loading || descriptors === null) return <Spinner />;

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(target, 0, moved);
    setFields(next);
  };

  return (
    <div className="pcms-screen--wide" data-testid="form-editor">
      <p className="pcms-field__hint">
        <a href="#/interactions/forms">{t("interactions.back_to_list")}</a>
      </p>
      <div className="pcms-toolbar">
        <h1>{t("interactions.editor_title")}</h1>
        <Badge>{t("interactions.version_prefix", { no: version })}</Badge>
        <span className="pcms-picker-row__meta">{keyLabel}</span>
        <span className="pcms-toolbar__spacer" />
        {canManage ? (
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {t("interactions.save_button")}
          </Button>
        ) : null}
      </div>
      <p className="pcms-field__hint">{t("interactions.editor_version_hint")}</p>
      <div className="pcms-columns pcms-columns--tree">
        <div>
          <Field label={t("interactions.title_aria")}>
            <Input
              value={title}
              disabled={!canManage}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <h3>{t("interactions.fields_title")}</h3>
          {fields.map((field, index) => (
            <FieldEditorCard
              key={field.key}
              field={field}
              descriptors={descriptors}
              index={index}
              count={fields.length}
              onChange={(next) => setFields(fields.map((f, i) => (i === index ? next : f)))}
              onRemove={() => setFields(fields.filter((_, i) => i !== index))}
              onMove={(direction) => move(index, direction)}
              onDragStart={() => setDragIndex(index)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragIndex !== null && dragIndex !== index) {
                  const next = [...fields];
                  const moved = next.splice(dragIndex, 1)[0];
                  if (moved !== undefined) next.splice(index, 0, moved);
                  setFields(next);
                }
                setDragIndex(null);
              }}
            />
          ))}
          {canManage ? (
            <Button
              size="sm"
              disabled={descriptors.length === 0}
              onClick={() => {
                const type = descriptors[0]?.type ?? "text";
                setFields([...fields, emptyField(`field_${fields.length + 1}`, type)]);
              }}
            >
              {t("interactions.field_add")}
            </Button>
          ) : null}
          {canManage ? (
            <details className="pcms-panel">
              <summary>{t("interactions.advanced_title")}</summary>
              <h3>{t("interactions.after_submit_title")}</h3>
              <Field label={t("interactions.after_submit_type")}>
                <Select
                  value={settings.successType}
                  onChange={(e) => setSettings({ ...settings, successType: e.target.value })}
                >
                  <option value="">{t("interactions.after_submit_default")}</option>
                  <option value="message">{t("interactions.after_submit_message")}</option>
                  <option value="redirect_internal">
                    {t("interactions.after_submit_internal")}
                  </option>
                  <option value="redirect_external_trusted">
                    {t("interactions.after_submit_external")}
                  </option>
                </Select>
              </Field>
              {settings.successType === "message" ? (
                <Field label={t("interactions.after_submit_message_label")}>
                  <Input
                    value={settings.successMessage}
                    onChange={(e) => setSettings({ ...settings, successMessage: e.target.value })}
                  />
                </Field>
              ) : null}
              {settings.successType === "redirect_internal" ? (
                <Field label={t("interactions.after_submit_path")}>
                  <Input
                    value={settings.successPath}
                    onChange={(e) => setSettings({ ...settings, successPath: e.target.value })}
                  />
                </Field>
              ) : null}
              {settings.successType === "redirect_external_trusted" ? (
                <Field label={t("interactions.after_submit_url")}>
                  <Input
                    value={settings.successUrl}
                    onChange={(e) => setSettings({ ...settings, successUrl: e.target.value })}
                  />
                </Field>
              ) : null}
              <h3>{t("interactions.lead_policy_title")}</h3>
              <Switch
                label={t("interactions.create_lead")}
                checked={settings.createLead}
                onChange={(checked) => setSettings({ ...settings, createLead: checked })}
              />
              <p className="pcms-field__hint">{t("interactions.create_lead_hint")}</p>
              {settings.createLead ? (
                <>
                  <Field label={t("interactions.lead_classification")}>
                    <Input
                      value={settings.leadClassification}
                      onChange={(e) =>
                        setSettings({ ...settings, leadClassification: e.target.value })
                      }
                    />
                  </Field>
                  {(
                    [
                      ["leadNameFrom", "interactions.lead_name_from"],
                      ["leadEmailFrom", "interactions.lead_email_from"],
                      ["leadPhoneFrom", "interactions.lead_phone_from"],
                      ["leadSummaryFrom", "interactions.lead_summary_from"],
                    ] as const
                  ).map(([key, labelKey]) => (
                    <Field key={key} label={t(labelKey)}>
                      <Select
                        value={settings[key]}
                        onChange={(e) => setSettings({ ...settings, [key]: e.target.value })}
                      >
                        <option value="">—</option>
                        {fields.map((field) => (
                          <option key={field.key} value={field.key}>
                            {field.label === "" ? field.key : field.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ))}
                </>
              ) : null}
              <h3>{t("interactions.antispam_title")}</h3>
              <Field label={t("interactions.honeypot_label")}>
                <Input
                  value={settings.honeypot}
                  onChange={(e) => setSettings({ ...settings, honeypot: e.target.value })}
                />
              </Field>
              <h3>{t("interactions.retention_title")}</h3>
              <div className="pcms-form-grid">
                <Field label={t("interactions.retention_mode")}>
                  <Select
                    value={settings.retentionMode}
                    onChange={(e) => setSettings({ ...settings, retentionMode: e.target.value })}
                  >
                    <option value="retain">{t("interactions.retention_retain")}</option>
                    <option value="anonymize">{t("interactions.retention_anonymize")}</option>
                    <option value="delete">{t("interactions.retention_delete")}</option>
                  </Select>
                </Field>
                <Field label={t("interactions.retention_days")}>
                  <Input
                    type="number"
                    value={settings.retentionDays}
                    onChange={(e) => setSettings({ ...settings, retentionDays: e.target.value })}
                  />
                </Field>
              </div>
              <details>
                <summary>{t("interactions.view_json")}</summary>
                <Textarea
                  rows={8}
                  readOnly
                  aria-label={t("interactions.view_json_aria")}
                  value={JSON.stringify(
                    {
                      fields: fields.map(fieldToWire),
                      settings: wireSettings(
                        settings,
                        fields.map((field) => field.key),
                      ),
                    },
                    null,
                    2,
                  )}
                />
              </details>
            </details>
          ) : null}
        </div>
        <div>
          <UsagePanel kind="forms" id={props.formId} />
          <NotificationsPanel events={["FormSubmitted", "LeadCreated"]} />
        </div>
      </div>
    </div>
  );
}

function defaultSettings(): SettingsDraft {
  return {
    successType: "",
    successMessage: "",
    successPath: "",
    successUrl: "",
    honeypot: "",
    retentionMode: "retain",
    retentionDays: "",
    createLead: false,
    leadClassification: "",
    leadNameFrom: "",
    leadEmailFrom: "",
    leadPhoneFrom: "",
    leadSummaryFrom: "",
  };
}

function settingsFromWire(raw: Record<string, unknown>): SettingsDraft {
  const draft = defaultSettings();
  const success = (raw.success_behavior ?? {}) as Record<string, unknown>;
  if (typeof success.type === "string") draft.successType = success.type;
  if (typeof success.message === "string") draft.successMessage = success.message;
  if (typeof success.path === "string") draft.successPath = success.path;
  if (typeof success.url === "string") draft.successUrl = success.url;
  const spam = (raw.spam_policy ?? {}) as Record<string, unknown>;
  if (typeof spam.honeypot_field === "string") draft.honeypot = spam.honeypot_field;
  const retention = (raw.retention ?? {}) as Record<string, unknown>;
  if (retention.mode === "anonymize" || retention.mode === "delete") {
    draft.retentionMode = retention.mode;
  }
  if (typeof retention.after_days === "number") draft.retentionDays = String(retention.after_days);
  const lead = (raw.lead_policy ?? {}) as Record<string, unknown>;
  draft.createLead = lead.create_lead === true;
  if (typeof lead.classification === "string") draft.leadClassification = lead.classification;
  if (typeof lead.name_from === "string") draft.leadNameFrom = lead.name_from;
  if (typeof lead.email_from === "string") draft.leadEmailFrom = lead.email_from;
  if (typeof lead.phone_from === "string") draft.leadPhoneFrom = lead.phone_from;
  if (typeof lead.summary_from === "string") draft.leadSummaryFrom = lead.summary_from;
  return draft;
}

// ─── Quiz builder ───────────────────────────────────────────────────────────

interface QuestionDraft {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly required: boolean;
  readonly help: string;
  readonly options: readonly OptionDraft[];
  readonly min: string;
  readonly max: string;
  readonly max_length: string;
}

interface StepDraft {
  readonly id: string;
  readonly title: string;
  readonly questions: readonly QuestionDraft[];
}

interface OutcomeDraft {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly min_score: string;
  readonly max_score: string;
  readonly lead_classification: string;
}

const QUIZ_QUESTION_TYPES: readonly string[] = [
  "single_choice",
  "multiple_choice",
  "text",
  "number",
  "boolean",
];

function questionToWire(question: QuestionDraft): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    id: question.id,
    type: question.type,
    label: question.label,
  };
  if (question.required) wire.required = true;
  if (question.help !== "") wire.help = question.help;
  if (question.options.length > 0) {
    wire.options = question.options.filter((option) => option.value !== "");
  }
  if (question.min !== "") wire.min = Number(question.min);
  if (question.max !== "") wire.max = Number(question.max);
  if (question.max_length !== "") wire.max_length = Number(question.max_length);
  return wire;
}

function QuizEditorScreen(props: { readonly quizId: string }) {
  const toast = useToast();
  const auth = useAuth();
  const [loading, setLoading] = useState(true);
  const [keyLabel, setKeyLabel] = useState("");
  const [title, setTitle] = useState("");
  const [version, setVersion] = useState(0);
  const [steps, setSteps] = useState<readonly StepDraft[]>([]);
  const [outcomes, setOutcomes] = useState<readonly OutcomeDraft[]>([]);
  const [branching, setBranching] = useState("");
  const [scoring, setScoring] = useState("");
  const [createLead, setCreateLead] = useState(false);
  const [classification, setClassification] = useState("");
  const [busy, setBusy] = useState(false);
  const canManage = auth.can("quizzes.manage_definition");

  const reload = useCallback(() => {
    setLoading(true);
    apiGet<Record<string, unknown>>(`/quizzes/${props.quizId}`)
      .then((definition) => {
        setKeyLabel(typeof definition.key === "string" ? definition.key : "");
        setTitle(typeof definition.title === "string" ? definition.title : "");
        setVersion(typeof definition.schema_version === "number" ? definition.schema_version : 0);
        const wireSteps = Array.isArray(definition.steps) ? definition.steps : [];
        setSteps(
          wireSteps.map((step) => {
            const record = (step ?? {}) as Record<string, unknown>;
            const questions = Array.isArray(record.questions) ? record.questions : [];
            return {
              id: typeof record.id === "string" ? record.id : "",
              title: typeof record.title === "string" ? record.title : "",
              questions: questions.map((question) => {
                const q = (question ?? {}) as Record<string, unknown>;
                const options = Array.isArray(q.options)
                  ? q.options.map((option) => {
                      const o = (option ?? {}) as Record<string, unknown>;
                      return {
                        value: typeof o.value === "string" ? o.value : "",
                        label: typeof o.label === "string" ? o.label : "",
                      };
                    })
                  : [];
                return {
                  id: typeof q.id === "string" ? q.id : "",
                  type: typeof q.type === "string" ? q.type : "text",
                  label: typeof q.label === "string" ? q.label : "",
                  required: q.required === true,
                  help: typeof q.help === "string" ? q.help : "",
                  options,
                  min: typeof q.min === "number" ? String(q.min) : "",
                  max: typeof q.max === "number" ? String(q.max) : "",
                  max_length: typeof q.max_length === "number" ? String(q.max_length) : "",
                };
              }),
            };
          }),
        );
        const wireOutcomes = Array.isArray(definition.outcomes) ? definition.outcomes : [];
        setOutcomes(
          wireOutcomes.map((outcome) => {
            const o = (outcome ?? {}) as Record<string, unknown>;
            return {
              id: typeof o.id === "string" ? o.id : "",
              title: typeof o.title === "string" ? o.title : "",
              description: typeof o.description === "string" ? o.description : "",
              min_score: typeof o.min_score === "number" ? String(o.min_score) : "",
              max_score: typeof o.max_score === "number" ? String(o.max_score) : "",
              lead_classification:
                typeof o.lead_classification === "string" ? o.lead_classification : "",
            };
          }),
        );
        setBranching(
          JSON.stringify(
            Array.isArray(definition.branching_rules) ? definition.branching_rules : [],
            null,
            2,
          ),
        );
        setScoring(
          JSON.stringify(
            Array.isArray(definition.scoring_rules) ? definition.scoring_rules : [],
            null,
            2,
          ),
        );
        const settings = (definition.settings ?? {}) as Record<string, unknown>;
        const lead = (settings.lead_policy ?? {}) as Record<string, unknown>;
        setCreateLead(lead.create_lead === true);
        if (typeof lead.classification === "string") setClassification(lead.classification);
        setLoading(false);
      })
      .catch(() => {
        toast(t("interactions.definitions_load_failed"), "error");
        setLoading(false);
      });
  }, [props.quizId, toast]);
  useEffect(() => {
    reload();
  }, [reload]);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await apiPut(`/quizzes/${props.quizId}`, {
        title,
        steps: steps.map((step) => ({
          id: step.id,
          ...(step.title === "" ? {} : { title: step.title }),
          questions: step.questions.map(questionToWire),
        })),
        outcomes: outcomes.map((outcome) => {
          const wire: Record<string, unknown> = { id: outcome.id, title: outcome.title };
          if (outcome.description !== "") wire.description = outcome.description;
          if (outcome.min_score !== "") wire.min_score = Number(outcome.min_score);
          if (outcome.max_score !== "") wire.max_score = Number(outcome.max_score);
          if (outcome.lead_classification !== "")
            wire.lead_classification = outcome.lead_classification;
          return wire;
        }),
        settings: {
          ...(createLead
            ? {
                lead_policy: {
                  create_lead: true,
                  ...(classification === "" ? {} : { classification }),
                },
              }
            : {}),
        },
      });
      toast(t("interactions.saved_new_version"), "success");
      reload();
    } catch (caught) {
      toast(failure(caught, t("interactions.save_failed")), "error");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="pcms-screen--wide" data-testid="quiz-editor">
      <p className="pcms-field__hint">
        <a href="#/interactions/quizzes">{t("interactions.back_to_list")}</a>
      </p>
      <div className="pcms-toolbar">
        <h1>{t("interactions.quiz_editor_title")}</h1>
        <Badge>{t("interactions.version_prefix", { no: version })}</Badge>
        <span className="pcms-picker-row__meta">{keyLabel}</span>
        <span className="pcms-toolbar__spacer" />
        {canManage ? (
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {t("interactions.save_button")}
          </Button>
        ) : null}
      </div>
      <div className="pcms-columns pcms-columns--tree">
        <div>
          <Field label={t("interactions.title_aria")}>
            <Input value={title} disabled={!canManage} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          {steps.map((step, stepIndex) => (
            <div key={step.id} className="pcms-panel">
              <div className="pcms-toolbar">
                <strong>{t("interactions.step_label", { no: stepIndex + 1 })}</strong>
                <span className="pcms-toolbar__spacer" />
                {canManage && steps.length > 1 ? (
                  <IconButton
                    icon="delete"
                    small
                    label={t("interactions.step_remove")}
                    onClick={() => setSteps(steps.filter((_, i) => i !== stepIndex))}
                  />
                ) : null}
              </div>
              <Field label={t("interactions.step_title")}>
                <Input
                  value={step.title}
                  disabled={!canManage}
                  onChange={(e) =>
                    setSteps(
                      steps.map((s, i) => (i === stepIndex ? { ...s, title: e.target.value } : s)),
                    )
                  }
                />
              </Field>
              {step.questions.map((question, qIndex) => (
                <div key={question.id} className="pcms-fieldset">
                  <div className="pcms-toolbar">
                    <strong>{question.label === "" ? question.id : question.label}</strong>
                    <span className="pcms-toolbar__spacer" />
                    {canManage ? (
                      <IconButton
                        icon="delete"
                        small
                        label={t("interactions.question_remove")}
                        onClick={() =>
                          setSteps(
                            steps.map((s, i) =>
                              i === stepIndex
                                ? { ...s, questions: s.questions.filter((_, j) => j !== qIndex) }
                                : s,
                            ),
                          )
                        }
                      />
                    ) : null}
                  </div>
                  <div className="pcms-form-grid">
                    <Field label={t("interactions.question_label")} required>
                      <Input
                        value={question.label}
                        disabled={!canManage}
                        onChange={(e) =>
                          setSteps(
                            steps.map((s, i) =>
                              i === stepIndex
                                ? {
                                    ...s,
                                    questions: s.questions.map((q, j) =>
                                      j === qIndex ? { ...q, label: e.target.value } : q,
                                    ),
                                  }
                                : s,
                            ),
                          )
                        }
                      />
                    </Field>
                    <Field label={t("interactions.question_type")}>
                      <Select
                        value={question.type}
                        disabled={!canManage}
                        onChange={(e) =>
                          setSteps(
                            steps.map((s, i) =>
                              i === stepIndex
                                ? {
                                    ...s,
                                    questions: s.questions.map((q, j) =>
                                      j === qIndex ? { ...q, type: e.target.value } : q,
                                    ),
                                  }
                                : s,
                            ),
                          )
                        }
                      >
                        {QUIZ_QUESTION_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {t(`interactions.questiontype_${type}`)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  {(question.type === "single_choice" || question.type === "multiple_choice") &&
                  canManage ? (
                    <fieldset className="pcms-fieldset">
                      <legend>{t("interactions.field_options")}</legend>
                      {question.options.map((option, oIndex) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: editable rows — value-derived keys would remount inputs mid-keystroke
                        <div key={oIndex} className="pcms-row">
                          <Input
                            aria-label={t("interactions.option_value_aria")}
                            value={option.value}
                            onChange={(e) =>
                              setSteps(
                                steps.map((s, i) =>
                                  i === stepIndex
                                    ? {
                                        ...s,
                                        questions: s.questions.map((q, j) =>
                                          j === qIndex
                                            ? {
                                                ...q,
                                                options: q.options.map((o, k) =>
                                                  k === oIndex
                                                    ? { ...o, value: e.target.value }
                                                    : o,
                                                ),
                                              }
                                            : q,
                                        ),
                                      }
                                    : s,
                                ),
                              )
                            }
                          />
                          <Input
                            aria-label={t("interactions.option_label_aria")}
                            value={option.label}
                            onChange={(e) =>
                              setSteps(
                                steps.map((s, i) =>
                                  i === stepIndex
                                    ? {
                                        ...s,
                                        questions: s.questions.map((q, j) =>
                                          j === qIndex
                                            ? {
                                                ...q,
                                                options: q.options.map((o, k) =>
                                                  k === oIndex
                                                    ? { ...o, label: e.target.value }
                                                    : o,
                                                ),
                                              }
                                            : q,
                                        ),
                                      }
                                    : s,
                                ),
                              )
                            }
                          />
                          <IconButton
                            icon="delete"
                            small
                            label={t("interactions.option_remove")}
                            onClick={() =>
                              setSteps(
                                steps.map((s, i) =>
                                  i === stepIndex
                                    ? {
                                        ...s,
                                        questions: s.questions.map((q, j) =>
                                          j === qIndex
                                            ? {
                                                ...q,
                                                options: q.options.filter((_, k) => k !== oIndex),
                                              }
                                            : q,
                                        ),
                                      }
                                    : s,
                                ),
                              )
                            }
                          />
                        </div>
                      ))}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setSteps(
                            steps.map((s, i) =>
                              i === stepIndex
                                ? {
                                    ...s,
                                    questions: s.questions.map((q, j) =>
                                      j === qIndex
                                        ? {
                                            ...q,
                                            options: [
                                              ...q.options,
                                              { value: `opt${q.options.length + 1}`, label: "" },
                                            ],
                                          }
                                        : q,
                                    ),
                                  }
                                : s,
                            ),
                          )
                        }
                      >
                        {t("interactions.option_add")}
                      </Button>
                    </fieldset>
                  ) : null}
                </div>
              ))}
              {canManage ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setSteps(
                      steps.map((s, i) =>
                        i === stepIndex
                          ? {
                              ...s,
                              questions: [
                                ...s.questions,
                                {
                                  id: `q${stepIndex + 1}_${s.questions.length + 1}`,
                                  type: "text",
                                  label: "",
                                  required: false,
                                  help: "",
                                  options: [],
                                  min: "",
                                  max: "",
                                  max_length: "",
                                },
                              ],
                            }
                          : s,
                      ),
                    )
                  }
                >
                  {t("interactions.question_add")}
                </Button>
              ) : null}
            </div>
          ))}
          {canManage ? (
            <Button
              size="sm"
              onClick={() =>
                setSteps([
                  ...steps,
                  {
                    id: `step-${steps.length + 1}`,
                    title: "",
                    questions: [],
                  },
                ])
              }
            >
              {t("interactions.step_add")}
            </Button>
          ) : null}
          <h3>{t("interactions.outcomes_title")}</h3>
          {outcomes.map((outcome, index) => (
            <div key={outcome.id} className="pcms-panel">
              <div className="pcms-form-grid">
                <Field label={t("interactions.outcome_title_label")} required>
                  <Input
                    value={outcome.title}
                    disabled={!canManage}
                    onChange={(e) =>
                      setOutcomes(
                        outcomes.map((o, i) => (i === index ? { ...o, title: e.target.value } : o)),
                      )
                    }
                  />
                </Field>
                <Field label={t("interactions.outcome_min")}>
                  <Input
                    type="number"
                    value={outcome.min_score}
                    disabled={!canManage}
                    onChange={(e) =>
                      setOutcomes(
                        outcomes.map((o, i) =>
                          i === index ? { ...o, min_score: e.target.value } : o,
                        ),
                      )
                    }
                  />
                </Field>
                <Field label={t("interactions.outcome_max")}>
                  <Input
                    type="number"
                    value={outcome.max_score}
                    disabled={!canManage}
                    onChange={(e) =>
                      setOutcomes(
                        outcomes.map((o, i) =>
                          i === index ? { ...o, max_score: e.target.value } : o,
                        ),
                      )
                    }
                  />
                </Field>
              </div>
              <Field label={t("interactions.outcome_description")}>
                <Input
                  value={outcome.description}
                  disabled={!canManage}
                  onChange={(e) =>
                    setOutcomes(
                      outcomes.map((o, i) =>
                        i === index ? { ...o, description: e.target.value } : o,
                      ),
                    )
                  }
                />
              </Field>
            </div>
          ))}
          {canManage ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setOutcomes([
                  ...outcomes,
                  {
                    id: `outcome-${outcomes.length + 1}`,
                    title: "",
                    description: "",
                    min_score: "",
                    max_score: "",
                    lead_classification: "",
                  },
                ])
              }
            >
              {t("interactions.outcome_add")}
            </Button>
          ) : null}
          <Switch
            label={t("interactions.create_lead")}
            checked={createLead}
            disabled={!canManage}
            onChange={setCreateLead}
          />
          {createLead ? (
            <Field label={t("interactions.lead_classification")}>
              <Input
                value={classification}
                disabled={!canManage}
                onChange={(e) => setClassification(e.target.value)}
              />
            </Field>
          ) : null}
          <details className="pcms-panel">
            <summary>{t("interactions.advanced_title")}</summary>
            <p className="pcms-field__hint">{t("interactions.branching_hint")}</p>
            <Field label={t("interactions.branching_label")}>
              <Textarea rows={4} readOnly value={branching} />
            </Field>
            <Field label={t("interactions.scoring_label")}>
              <Textarea rows={4} readOnly value={scoring} />
            </Field>
          </details>
        </div>
        <div>
          <UsagePanel kind="quizzes" id={props.quizId} />
          <NotificationsPanel events={["QuizCompleted", "LeadCreated"]} />
        </div>
      </div>
    </div>
  );
}

export function AdminFormsScreen() {
  return (
    <DefinitionsScreen
      kind="forms"
      testId="interactions-forms-screen"
      tableTestId="interactions-forms-table"
    />
  );
}

export function AdminFormEditorScreen(props: Readonly<Record<string, string>>) {
  return <FormEditorScreen formId={props.formId ?? ""} />;
}

export function AdminQuizzesScreen() {
  return (
    <DefinitionsScreen
      kind="quizzes"
      testId="interactions-quizzes-screen"
      tableTestId="interactions-quizzes-table"
    />
  );
}

export function AdminQuizEditorScreen(props: Readonly<Record<string, string>>) {
  return <QuizEditorScreen quizId={props.quizId ?? ""} />;
}

// ─── Submissions ────────────────────────────────────────────────────────────

interface SubmissionRow {
  readonly id: string;
  readonly form_definition_id: string;
  readonly definition_title: string | null;
  readonly status: string;
  readonly submitted_at: string;
  readonly payload: Record<string, unknown>;
  readonly source_url_snapshot: string | null;
  readonly anonymized_at: string | null;
}

/** Best-effort human contact summary straight from the payload. */
function contactSummary(payload: Record<string, unknown>): string {
  const pick = (needle: string): string | null => {
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === "string" && value.trim() !== "" && key.includes(needle)) {
        return value.trim();
      }
    }
    return null;
  };
  const parts = [pick("name"), pick("email"), pick("phone"), pick("tel")].filter(
    (part): part is string => part !== null,
  );
  return parts.join(" · ");
}

export function AdminSubmissionsScreen() {
  const [rows, setRows] = useState<readonly SubmissionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const toast = useToast();

  const reload = useCallback(() => {
    setError(null);
    const params = new URLSearchParams({ limit: "50" });
    if (status !== "") params.set("status", status);
    apiGet<{ items: readonly SubmissionRow[] }>(`/interactions/submissions?${params.toString()}`)
      .then((result) => setRows(result.items))
      .catch(() => setError(t("interactions.submissions_load_failed")));
  }, [status]);
  useDebouncedReload(reload);

  const moderate = async (id: string, next: string): Promise<void> => {
    try {
      await apiPatch(`/interactions/submissions/${id}`, { status: next });
      toast(t("interactions.status_updated_toast"), "success");
      reload();
    } catch {
      toast(t("interactions.submissions_permission_toast"), "error");
    }
  };

  return (
    <div className="pcms-screen--wide" data-testid="interactions-submissions-screen">
      <h1>{t("interactions.submissions_title")}</h1>
      <div className="pcms-toolbar">
        <Select
          style={{ width: "auto" }}
          aria-label={t("interactions.status_aria")}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">{t("interactions.status_all")}</option>
          <option value="ACCEPTED">{t("interactions.filter_accepted")}</option>
          <option value="SPAM">{t("interactions.filter_spam")}</option>
          <option value="ARCHIVED">{t("interactions.filter_archived")}</option>
        </Select>
        <span className="pcms-toolbar__spacer" />
        {rows !== null ? (
          <ExportButton
            entity="submissions"
            filename="submissions.csv"
            filters={status === "" ? {} : { status }}
          />
        ) : null}
      </div>
      <TableWrap
        testId="submissions-table"
        error={error}
        rows={rows}
        onRetry={reload}
        headers={[
          t("interactions.th_form"),
          t("interactions.th_contact"),
          t("interactions.th_submitted"),
          t("interactions.th_source"),
          t("interactions.th_status"),
        ]}
      >
        {rows?.map((row) => (
          <tr
            key={row.id}
            onClick={() => setDetailId(row.id)}
            style={{ cursor: "pointer" }}
            data-testid="submissions-row"
          >
            <td>{row.definition_title ?? t("interactions.unknown_definition")}</td>
            <td>{contactSummary(row.payload) === "" ? "—" : contactSummary(row.payload)}</td>
            <td>{formatDateTime(row.submitted_at)}</td>
            <td>{row.source_url_snapshot === null ? "—" : row.source_url_snapshot.slice(0, 40)}</td>
            <td>
              <Badge tone={STATUS_TONES[row.status] ?? "neutral"}>{statusLabel(row.status)}</Badge>
            </td>
          </tr>
        ))}
      </TableWrap>
      {detailId !== null ? (
        <SubmissionDrawer id={detailId} onClose={() => setDetailId(null)} onChanged={reload} />
      ) : null}
    </div>
  );
}

function SubmissionDrawer(props: {
  readonly id: string;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const toast = useToast();
  const auth = useAuth();
  const [detail, setDetail] = useState<
    | (SubmissionRow & {
        readonly consent_snapshot: readonly unknown[];
        readonly spam_reasons: readonly string[];
        readonly definition_title: string | null;
        readonly labels: Readonly<Record<string, string>>;
        readonly lead_id: string | null;
        readonly deliveries?: readonly LeadDeliveryWire[];
      })
    | null
  >(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch once per submission id
  useEffect(() => {
    apiGet<typeof detail>(`/interactions/submissions/${props.id}`)
      .then((result) => setDetail(result))
      .catch(() => {
        toast(t("interactions.submissions_load_failed"), "error");
        props.onClose();
      });
  }, [props.id]);

  if (detail === null) return <Spinner />;
  const labels = detail.labels;
  const moderate = async (next: string) => {
    try {
      await apiPatch(`/interactions/submissions/${detail.id}`, { status: next });
      toast(t("interactions.status_updated_toast"), "success");
      props.onChanged();
      props.onClose();
    } catch {
      toast(t("interactions.submissions_permission_toast"), "error");
    }
  };
  return (
    <Drawer
      open
      onClose={props.onClose}
      title={detail.definition_title ?? t("interactions.submission_detail")}
    >
      <p>
        <Badge tone={STATUS_TONES[detail.status] ?? "neutral"}>{statusLabel(detail.status)}</Badge>{" "}
        {formatDateTime(detail.submitted_at)}
      </p>
      {detail.anonymized_at !== null ? (
        <p className="pcms-field__hint">{t("interactions.anonymized_note")}</p>
      ) : (
        <>
          <dl className="pcms-detail-list">
            {Object.entries(detail.payload).map(([key, value]) => (
              <div key={key} className="pcms-row">
                <dt>{labels[key] ?? key}</dt>
                <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
              </div>
            ))}
          </dl>
          {detail.consent_snapshot.length > 0 ? (
            <p className="pcms-field__hint">{t("interactions.consent_recorded")}</p>
          ) : null}
          {detail.spam_reasons.length > 0 ? (
            <p className="pcms-field__error">
              {t("interactions.spam_reasons", { reasons: detail.spam_reasons.join(", ") })}
            </p>
          ) : null}
        </>
      )}
      {detail.lead_id !== null ? (
        <p>
          <a href="#/interactions/leads">{t("interactions.link_lead")}</a>
        </p>
      ) : null}
      <DeliveryProjectionList deliveries={detail.deliveries} />
      {auth.can("privacy.manage") ? (
        <p>
          <a href={`#/interactions/privacy?entity=submission&id=${encodeURIComponent(props.id)}`}>
            {t("privacy.title")}
          </a>
        </p>
      ) : null}
      {auth.can("interactions.manage") ? (
        <div className="pcms-actions-row">
          {detail.status !== "ACCEPTED" ? (
            <Button size="sm" onClick={() => void moderate("ACCEPTED")}>
              {t("interactions.accept_button")}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void moderate("ARCHIVED")}>
            {t("interactions.archive_button")}
          </Button>
          <Button size="sm" variant="danger" onClick={() => void moderate("SPAM")}>
            {t("interactions.spam_button")}
          </Button>
        </div>
      ) : null}
    </Drawer>
  );
}

// ─── Quiz Runs ──────────────────────────────────────────────────────────────

interface QuizRunRow {
  readonly id: string;
  readonly quiz_definition_id: string;
  readonly quiz_title: string | null;
  readonly state: string;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly score: number | null;
  readonly outcome_id: string | null;
  readonly outcome_title: string | null;
  readonly lead_id: string | null;
}

export function AdminQuizRunsScreen() {
  const [rows, setRows] = useState<readonly QuizRunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);

  const reload = useCallback(() => {
    setError(null);
    const params = new URLSearchParams({ limit: "50" });
    if (state !== "") params.set("status", state);
    apiGet<{ items: readonly QuizRunRow[] }>(`/interactions/quiz-runs?${params.toString()}`)
      .then((result) => setRows(result.items))
      .catch(() => setError(t("interactions.quiz_runs_load_failed")));
  }, [state]);
  useDebouncedReload(reload);

  return (
    <div className="pcms-screen--wide" data-testid="interactions-quiz-runs-screen">
      <h1>{t("interactions.quiz_runs_title")}</h1>
      <div className="pcms-toolbar">
        <Select
          style={{ width: "auto" }}
          aria-label={t("interactions.state_aria")}
          value={state}
          onChange={(e) => setState(e.target.value)}
        >
          <option value="">{t("interactions.state_all")}</option>
          <option value="STARTED">{t("interactions.filter_started")}</option>
          <option value="COMPLETED">{t("interactions.filter_completed")}</option>
          <option value="ABANDONED">{t("interactions.filter_abandoned")}</option>
          <option value="EXPIRED">{t("interactions.filter_expired")}</option>
        </Select>
        <span className="pcms-toolbar__spacer" />
        {rows !== null ? (
          <ExportButton
            entity="quiz_runs"
            filename="quiz-runs.csv"
            filters={state === "" ? {} : { status: state }}
          />
        ) : null}
      </div>
      <TableWrap
        testId="quiz-runs-table"
        error={error}
        rows={rows}
        onRetry={reload}
        headers={[
          t("interactions.th_quiz"),
          t("interactions.th_started"),
          t("interactions.th_completed"),
          t("interactions.th_state"),
          t("interactions.th_outcome"),
          t("interactions.th_score"),
        ]}
      >
        {rows?.map((row) => (
          <tr key={row.id} onClick={() => setDetailId(row.id)} style={{ cursor: "pointer" }}>
            <td>{row.quiz_title ?? t("interactions.unknown_definition")}</td>
            <td>{formatDateTime(row.started_at)}</td>
            <td>{row.completed_at === null ? "—" : formatDateTime(row.completed_at)}</td>
            <td>
              <Badge tone={STATUS_TONES[row.state] ?? "neutral"}>{statusLabel(row.state)}</Badge>
            </td>
            <td>{row.outcome_title ?? "—"}</td>
            <td>{row.score === null ? "—" : String(row.score)}</td>
          </tr>
        ))}
      </TableWrap>
      {detailId !== null ? <QuizRunDrawer id={detailId} onClose={() => setDetailId(null)} /> : null}
    </div>
  );
}

function QuizRunDrawer(props: { readonly id: string; readonly onClose: () => void }) {
  const [detail, setDetail] = useState<{
    readonly state: string;
    readonly started_at: string;
    readonly completed_at: string | null;
    readonly quiz_title: string | null;
    readonly outcome_title: string | null;
    readonly score: number | null;
    readonly lead_id: string | null;
    readonly anonymized_at: string | null;
    readonly answers: readonly {
      readonly question_id: string;
      readonly label: string;
      readonly value_label: string | null;
      readonly value: unknown;
    }[];
  } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch once per quiz run id
  useEffect(() => {
    apiGet<typeof detail>(`/interactions/quiz-runs/${props.id}`)
      .then((result) => setDetail(result))
      .catch(() => props.onClose());
  }, [props.id]);

  if (detail === null) return <Spinner />;
  return (
    <Drawer
      open
      onClose={props.onClose}
      title={detail.quiz_title ?? t("interactions.quiz_run_detail")}
    >
      <p>
        <Badge tone={STATUS_TONES[detail.state] ?? "neutral"}>{statusLabel(detail.state)}</Badge>{" "}
        {formatDateTime(detail.started_at)}
        {detail.completed_at === null ? "" : ` — ${formatDateTime(detail.completed_at)}`}
      </p>
      {detail.anonymized_at !== null ? (
        <p className="pcms-field__hint">{t("interactions.anonymized_note")}</p>
      ) : (
        <dl className="pcms-detail-list">
          {detail.answers.map((answer) => (
            <div key={answer.question_id} className="pcms-row">
              <dt>{answer.label}</dt>
              <dd>
                {answer.value_label ??
                  (typeof answer.value === "string" ? answer.value : JSON.stringify(answer.value))}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <PrivacyToolsLink entity="quiz_run" id={props.id} />
      <p>
        {t("interactions.th_score")}: {detail.score === null ? "—" : String(detail.score)}
        {detail.outcome_title === null ? "" : ` · ${detail.outcome_title}`}
      </p>
      {detail.lead_id !== null ? (
        <p>
          <a href="#/interactions/leads">{t("interactions.link_lead")}</a>
        </p>
      ) : null}
    </Drawer>
  );
}

// ─── Leads ──────────────────────────────────────────────────────────────────

interface LeadRow {
  readonly id: string;
  readonly source_type: string;
  readonly source_id: string;
  readonly status: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly summary: string;
  readonly classification: string | null;
  readonly created_at: string;
}

export function AdminLeadsScreen() {
  const [rows, setRows] = useState<readonly LeadRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const toast = useToast();

  const reload = useCallback(() => {
    setError(null);
    const params = new URLSearchParams({ limit: "50" });
    if (status !== "") params.set("status", status);
    apiGet<{ items: readonly LeadRow[] }>(`/interactions/leads?${params.toString()}`)
      .then((result) => setRows(result.items))
      .catch(() => setError(t("interactions.leads_load_failed")));
  }, [status]);
  useDebouncedReload(reload);

  const setStatusOf = async (id: string, next: string): Promise<void> => {
    try {
      await apiPatch(`/interactions/leads/${id}`, { status: next });
      toast(t("interactions.lead_status_updated_toast"), "success");
      reload();
    } catch {
      toast(t("interactions.leads_permission_toast"), "error");
    }
  };

  return (
    <div className="pcms-screen--wide" data-testid="interactions-leads-screen">
      <h1>{t("interactions.leads_title")}</h1>
      <p className="pcms-field__hint">{t("interactions.leads_hint")}</p>
      <div className="pcms-toolbar">
        <Select
          style={{ width: "auto" }}
          aria-label={t("interactions.lead_status_aria")}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">{t("interactions.status_all")}</option>
          <option value="NEW">{t("interactions.filter_new")}</option>
          <option value="VIEWED">{t("interactions.filter_viewed")}</option>
          <option value="PROCESSED">{t("interactions.filter_processed")}</option>
          <option value="ARCHIVED">{t("interactions.filter_archived")}</option>
          <option value="SPAM">{t("interactions.filter_spam")}</option>
        </Select>
        <span className="pcms-toolbar__spacer" />
        {rows !== null ? (
          <ExportButton
            entity="leads"
            filename="leads.csv"
            filters={status === "" ? {} : { status }}
          />
        ) : null}
      </div>
      <TableWrap
        testId="leads-table"
        error={error}
        rows={rows}
        onRetry={reload}
        headers={[
          t("interactions.th_contact"),
          t("interactions.th_source"),
          t("interactions.th_created_lead"),
          t("interactions.th_status"),
          "",
        ]}
      >
        {rows?.map((row) => (
          <tr
            key={row.id}
            onClick={() => setDetailId(row.id)}
            style={{ cursor: "pointer" }}
            data-testid="leads-row"
          >
            <td>
              {row.name ?? "—"}
              {(row.email !== null || row.phone !== null) && (
                <div className="pcms-picker-row__meta">
                  {[row.email, row.phone].filter((part) => part !== null).join(" · ")}
                </div>
              )}
            </td>
            <td>
              {row.source_type === "FORM_SUBMISSION"
                ? t("interactions.source_form")
                : t("interactions.source_quiz")}
            </td>
            <td>{formatDateTime(row.created_at)}</td>
            <td>
              <Badge tone={STATUS_TONES[row.status] ?? "neutral"}>{statusLabel(row.status)}</Badge>
            </td>
            <td>
              <div className="pcms-row__actions">
                {row.status === "NEW" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(event) => {
                      event.stopPropagation();
                      void setStatusOf(row.id, "VIEWED");
                    }}
                  >
                    {t("interactions.lead_viewed_button")}
                  </Button>
                ) : null}
                {row.status !== "PROCESSED" && row.status !== "SPAM" ? (
                  <Button
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      void setStatusOf(row.id, "PROCESSED");
                    }}
                  >
                    {t("interactions.lead_process_button")}
                  </Button>
                ) : null}
                {row.status !== "ARCHIVED" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(event) => {
                      event.stopPropagation();
                      void setStatusOf(row.id, "ARCHIVED");
                    }}
                  >
                    {t("interactions.archive_button")}
                  </Button>
                ) : null}
                {row.status !== "SPAM" ? (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={(event) => {
                      event.stopPropagation();
                      void setStatusOf(row.id, "SPAM");
                    }}
                  >
                    {t("interactions.spam_button")}
                  </Button>
                ) : null}
              </div>
            </td>
          </tr>
        ))}
      </TableWrap>
      {detailId !== null ? (
        <LeadDrawer id={detailId} onClose={() => setDetailId(null)} onChanged={reload} />
      ) : null}
    </div>
  );
}

/** Lead detail drawer (owner task §62): the lead fields plus the READ
 * delivery projection over existing IntegrationDelivery records. */
function LeadDrawer(props: {
  readonly id: string;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const toast = useToast();
  const [lead, setLead] = useState<
    (LeadRow & { readonly deliveries?: readonly LeadDeliveryWire[] }) | null
  >(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch once per lead id
  useEffect(() => {
    apiGet<typeof lead>(`/interactions/leads/${props.id}`)
      .then(setLead)
      .catch(() => {
        toast(t("interactions.leads_load_failed"), "error");
        props.onClose();
      });
  }, [props.id]);

  const setStatusOf = async (next: string): Promise<void> => {
    try {
      await apiPatch(`/interactions/leads/${props.id}`, { status: next });
      toast(t("interactions.lead_status_updated_toast"), "success");
      const fresh = await apiGet<typeof lead>(`/interactions/leads/${props.id}`);
      setLead(fresh);
      props.onChanged();
    } catch {
      toast(t("interactions.leads_permission_toast"), "error");
    }
  };

  if (lead === null) return <Spinner />;
  return (
    <Drawer open onClose={props.onClose} title={lead.name ?? t("interactions.leads_title")}>
      <p>
        <Badge tone={STATUS_TONES[lead.status] ?? "neutral"}>{statusLabel(lead.status)}</Badge>{" "}
        {formatDateTime(lead.created_at)} ·{" "}
        {lead.source_type === "FORM_SUBMISSION"
          ? t("interactions.source_form")
          : t("interactions.source_quiz")}
      </p>
      <dl className="pcms-detail-list">
        {lead.name !== null ? (
          <div className="pcms-row">
            <dt>{t("interactions.lead_field_name")}</dt>
            <dd>{lead.name}</dd>
          </div>
        ) : null}
        {lead.email !== null ? (
          <div className="pcms-row">
            <dt>{t("interactions.lead_field_email")}</dt>
            <dd>
              <a href={`mailto:${lead.email}`}>{lead.email}</a>
            </dd>
          </div>
        ) : null}
        {lead.phone !== null ? (
          <div className="pcms-row">
            <dt>{t("interactions.lead_field_phone")}</dt>
            <dd>
              <a href={`tel:${lead.phone}`}>{lead.phone}</a>
            </dd>
          </div>
        ) : null}
        {lead.summary !== "" ? (
          <div className="pcms-row">
            <dt>{t("interactions.lead_field_summary")}</dt>
            <dd>{lead.summary}</dd>
          </div>
        ) : null}
        {lead.classification !== null ? (
          <div className="pcms-row">
            <dt>{t("interactions.lead_field_classification")}</dt>
            <dd>{lead.classification}</dd>
          </div>
        ) : null}
      </dl>
      <DeliveryProjectionList deliveries={lead.deliveries} />
      <PrivacyToolsLink entity="lead" id={props.id} />
      <div className="pcms-actions-row">
        {lead.status !== "PROCESSED" && lead.status !== "SPAM" ? (
          <Button size="sm" onClick={() => void setStatusOf("PROCESSED")}>
            {t("interactions.lead_process_button")}
          </Button>
        ) : null}
        {lead.status !== "ARCHIVED" ? (
          <Button size="sm" variant="ghost" onClick={() => void setStatusOf("ARCHIVED")}>
            {t("interactions.archive_button")}
          </Button>
        ) : null}
        {lead.status !== "SPAM" ? (
          <Button size="sm" variant="danger" onClick={() => void setStatusOf("SPAM")}>
            {t("interactions.spam_button")}
          </Button>
        ) : null}
      </div>
    </Drawer>
  );
}

/** Home for the legacy "interactions" path: links into the sections. */
export function AdminInteractionsHome() {
  const sections = [
    {
      path: "interactions/forms",
      title: t("interactions.forms_title"),
      permission: "forms.read_definition",
    },
    {
      path: "interactions/quizzes",
      title: t("interactions.quizzes_title"),
      permission: "quizzes.read_definition",
    },
    {
      path: "interactions/submissions",
      title: t("interactions.submissions_title"),
      permission: "interactions.read",
    },
    {
      path: "interactions/quiz-runs",
      title: t("interactions.quiz_runs_title"),
      permission: "interactions.read",
    },
    { path: "interactions/leads", title: t("interactions.leads_title"), permission: "leads.read" },
  ];
  return (
    <div data-testid="interactions-home-screen">
      <h1>{t("interactions.home_title")}</h1>
      <div className="pcms-toolbar">
        {sections.map((section) => (
          <Button key={section.path} onClick={() => navigate(section.path)}>
            {section.title}
          </Button>
        ))}
      </div>
    </div>
  );
}

function PrivacyToolsLink(props: { entity: "quiz_run" | "lead"; id: string }) {
  const auth = useAuth();
  return auth.can("privacy.manage") ? (
    <p>
      <a href={`#/interactions/privacy?entity=${props.entity}&id=${encodeURIComponent(props.id)}`}>
        {t("privacy.title")}
      </a>
    </p>
  ) : null;
}
