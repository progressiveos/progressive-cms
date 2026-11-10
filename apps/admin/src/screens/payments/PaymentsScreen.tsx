// Admin Payments workspace (PCMS-PAY-T009; Payments spec §38; CORE-P0-01 S6).
//
// Four surfaces: Payments (list with provider/status/date filters, search,
// pagination), Payment detail (lifecycle timeline + metadata), Providers
// (trusted catalog types + instance configuration with `payments.configure`,
// safe offline test, disable/enable lifecycle), Events & diagnostics
// (inbound callbacks incl. retained orphans). No credentials are ever
// displayed — configuration carries secret REFERENCES only. Refund/cancel
// controls are deliberately absent until the S7 financial safety gates pass.
import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost, describeApiError } from "../../api/client.js";
import { useRoute } from "../../layout/router.js";
import { useAuth } from "../../auth/AuthContext.js";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorPanel,
  Field,
  Input,
  Select,
  Spinner,
  Tabs,
} from "../../design/ui.js";
import { t } from "../../i18n/index.js";
import { ProviderSettingsDialog } from "./ProviderSettingsDialog.js";

interface PaymentWire {
  readonly id: string;
  readonly provider_instance_id: string;
  readonly external_payment_id: string | null;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: string;
  readonly description: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly refunded_amount: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly paid_at: string | null;
}
interface ProviderInstanceWire {
  readonly id: string;
  readonly provider_type: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly config: Record<string, unknown>;
  readonly settings_generation?: number;
}
interface ProviderTypeWire {
  readonly provider_type: string;
  readonly display_name: string;
  readonly extension_id: string | null;
  readonly secret_requirements: readonly string[];
  readonly config_schema: Record<string, unknown>;
  readonly accepts_instance_config: boolean;
}
interface EventWire {
  readonly id: string;
  readonly event_type: string;
  readonly source: string;
  readonly actor_id: string | null;
  readonly provider_event_id: string | null;
  readonly created_at: string;
}
interface InboundWire {
  readonly id: string;
  readonly source_id: string;
  readonly provider_event_id: string | null;
  readonly status: string;
  readonly error_code: string | null;
  readonly received_at: string;
  readonly processed_at: string | null;
}
interface TestCheck {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  SUCCEEDED: "success",
  PENDING: "warning",
  CREATED: "neutral",
  FAILED: "danger",
  CANCELLED: "neutral",
  PARTIALLY_REFUNDED: "warning",
  REFUNDED: "neutral",
};

const STATUSES = [
  "CREATED",
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
] as const;

function statusLabel(status: string): string {
  const key = `payments.status_${status.toLowerCase()}`;
  const translated = t(key);
  // t() surfaces unknown keys as "[key]" — fall back to the raw machine status.
  return translated === `[${key}]` ? status : translated;
}

function formatAmount(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

// ---- Payments list + detail ------------------------------------------------

function PaymentsTab() {
  const auth = useAuth();
  const canRead = auth.can("payments.read");
  const [payments, setPayments] = useState<PaymentWire[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<PaymentWire | null>(null);
  const [timeline, setTimeline] = useState<EventWire[] | null>(null);
  const [refunds, setRefunds] = useState<
    readonly {
      id: string;
      status: string;
      amount: number;
      provider_refund_id: string | null;
      attempts: number;
      last_error: string | null;
      created_by: string;
      created_at: string;
    }[]
  >([]);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const limit = 25;

  const load = useCallback(() => {
    setError(null);
    const params = new URLSearchParams();
    if (status !== "") params.set("status", status);
    if (search.trim() !== "") params.set("search", search.trim());
    if (from !== "") params.set("created_from", from);
    if (to !== "") params.set("created_to", `${to}T23:59:59Z`);
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    apiGet<{ items: PaymentWire[] }>(`/payments?${params.toString()}`)
      .then((result) => setPayments(result.items))
      .catch((cause: unknown) => setError(describeApiError(cause)));
  }, [status, search, from, to, offset]);

  useEffect(() => {
    if (canRead) load();
  }, [canRead, load]);

  const openDetail = (payment: PaymentWire) => {
    setDetail(payment);
    apiGet<{ items: EventWire[] }>(`/payments/${payment.id}/events`)
      .then((result) => setTimeline(result.items))
      .catch((cause: unknown) => setTimeline([]));
    apiGet<{
      items: {
        id: string;
        status: string;
        amount: number;
        provider_refund_id: string | null;
        attempts: number;
        last_error: string | null;
        created_by: string;
        created_at: string;
      }[];
    }>(`/payments/${payment.id}/refunds`)
      .then((result) => setRefunds(result.items))
      .catch(() => setRefunds([]));
  };

  const requestRefund = (paymentId: string, amount: number | null) => {
    setActionError(null);
    apiPost<{ refund_intent_id: string }>(`/payments/${paymentId}/refund`, {
      ...(amount === null ? {} : { amount }),
      reason: refundReason.trim() === "" ? "operator request" : refundReason.trim(),
    })
      .then((result) => {
        setActionNote(t("payments.refund_recorded", { id: result.refund_intent_id }));
        setRefundAmount("");
        setRefundReason("");
        openDetail({ ...detail!, status: "REFUND_REQUESTED" });
      })
      .catch((cause: unknown) => setActionError(describeApiError(cause)));
  };

  const requestCancel = (paymentId: string) => {
    setActionError(null);
    if (!window.confirm(t("payments.cancel_confirm"))) return;
    apiPost(`/payments/${paymentId}/cancel`, {})
      .then(() => {
        setActionNote(t("payments.cancel_done"));
        openDetail({ ...detail!, status: "CANCELLED" });
      })
      .catch((cause: unknown) => setActionError(describeApiError(cause)));
  };

  if (!canRead) return <EmptyState title={t("core.forbidden")} />;
  if (error !== null) return <ErrorPanel message={error} />;
  if (payments === null) return <Spinner />;

  if (detail !== null) {
    return (
      <div>
        <Button
          variant="ghost"
          onClick={() => {
            setDetail(null);
            setTimeline(null);
          }}
        >
          ← {t("payments.back_to_list")}
        </Button>
        <Card title={`${formatAmount(detail.amount, detail.currency)} · ${detail.id}`}>
          <div style={{ display: "grid", gap: 6 }}>
            <Badge tone={STATUS_TONE[detail.status] ?? "neutral"}>
              {statusLabel(detail.status)}
            </Badge>
            <div>
              {t("payments.field_provider_instance")}: <code>{detail.provider_instance_id}</code>
            </div>
            <div>
              {t("payments.field_external_id")}: <code>{detail.external_payment_id ?? "—"}</code>
            </div>
            <div>
              {t("payments.field_subject")}: {detail.subject_type}/{detail.subject_id}
            </div>
            {detail.description !== null ? <div>{detail.description}</div> : null}
            <div>
              {t("payments.field_created")}: {new Date(detail.created_at).toLocaleString()}
            </div>
            {detail.paid_at !== null ? (
              <div>
                {t("payments.field_paid")}: {new Date(detail.paid_at).toLocaleString()}
              </div>
            ) : null}
            {detail.metadata !== null && Object.keys(detail.metadata).length > 0 ? (
              <div>
                {t("payments.field_metadata")}: <code>{JSON.stringify(detail.metadata)}</code>
              </div>
            ) : null}
          </div>
        </Card>
        <Card title={t("payments.refund_intents")}>
          {refunds.length === 0 ? (
            <EmptyState title={t("payments.refunds_empty")} />
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "start" }}>{t("payments.col_status")}</th>
                  <th style={{ textAlign: "start" }}>{t("payments.col_amount")}</th>
                  <th style={{ textAlign: "start" }}>{t("payments.col_provider_refund")}</th>
                  <th style={{ textAlign: "start" }}>{t("payments.col_attempts")}</th>
                  <th style={{ textAlign: "start" }}>{t("payments.col_error")}</th>
                </tr>
              </thead>
              <tbody>
                {refunds.map((intent) => (
                  <tr key={intent.id}>
                    <td>
                      <Badge
                        tone={
                          intent.status === "SUCCEEDED"
                            ? "success"
                            : intent.status === "NEEDS_REVIEW"
                              ? "warning"
                              : intent.status === "FAILED"
                                ? "danger"
                                : "neutral"
                        }
                      >
                        {intent.status}
                      </Badge>
                      {intent.status === "NEEDS_REVIEW" ? (
                        <div style={{ fontSize: "0.85em", opacity: 0.75 }}>
                          {t("payments.needs_review_hint")}
                        </div>
                      ) : null}
                    </td>
                    <td>{intent.amount.toFixed(2)}</td>
                    <td>
                      <code>{intent.provider_refund_id ?? t("payments.col_none")}</code>
                    </td>
                    <td>{intent.attempts}</td>
                    <td>{intent.last_error ?? t("payments.col_none")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {auth.can("payments.refund") &&
          (detail.status === "SUCCEEDED" || detail.status === "PARTIALLY_REFUNDED") ? (
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                alignItems: "end",
                marginTop: 10,
              }}
            >
              <Field label={t("payments.refund_amount")}>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={refundAmount}
                  onChange={(event) => setRefundAmount(event.currentTarget.value)}
                  placeholder={t("payments.refund_full_hint")}
                />
              </Field>
              <Field label={t("payments.refund_reason")}>
                <Input
                  value={refundReason}
                  onChange={(event) => setRefundReason(event.currentTarget.value)}
                />
              </Field>
              <Button
                onClick={() =>
                  requestRefund(detail.id, refundAmount.trim() === "" ? null : Number(refundAmount))
                }
              >
                {t("payments.refund_request")}
              </Button>
              <span style={{ opacity: 0.7 }}>{t("payments.refund_async_hint")}</span>
            </div>
          ) : null}
          {auth.can("payments.cancel") &&
          (detail.status === "CREATED" || detail.status === "PENDING") ? (
            <div style={{ marginTop: 8 }}>
              <Button variant="ghost" onClick={() => requestCancel(detail.id)}>
                {t("payments.cancel_request")}
              </Button>
            </div>
          ) : null}
          {actionNote !== null ? <p>{actionNote}</p> : null}
          {actionError !== null ? <ErrorPanel message={actionError} /> : null}
        </Card>
        <Card title={t("payments.timeline")}>
          {timeline === null ? (
            <Spinner />
          ) : timeline.length === 0 ? (
            <EmptyState title={t("payments.timeline_empty")} />
          ) : (
            <ol style={{ display: "grid", gap: 6, margin: 0, paddingLeft: 18 }}>
              {timeline.map((event) => (
                <li key={event.id}>
                  <code>{event.event_type}</code> · {new Date(event.created_at).toLocaleString()}
                  {event.provider_event_id !== null ? (
                    <>
                      {" · "}
                      <code>{event.provider_event_id}</code>
                    </>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
        <Field label={t("payments.filter_status")}>
          <Select
            value={status}
            onChange={(event) => {
              setOffset(0);
              setStatus(event.currentTarget.value);
            }}
          >
            <option value="">{t("payments.filter_all")}</option>
            {STATUSES.map((entry) => (
              <option key={entry} value={entry}>
                {statusLabel(entry)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("payments.filter_search")}>
          <Input
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder={t("payments.filter_search_placeholder")}
          />
        </Field>
        <Field label={t("payments.filter_from")}>
          <Input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.currentTarget.value)}
          />
        </Field>
        <Field label={t("payments.filter_to")}>
          <Input type="date" value={to} onChange={(event) => setTo(event.currentTarget.value)} />
        </Field>
        <Button
          onClick={() => {
            setOffset(0);
            load();
          }}
        >
          {t("payments.apply")}
        </Button>
      </div>
      {payments.length === 0 ? (
        <EmptyState title={t("payments.empty")} />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "start" }}>{t("payments.col_amount")}</th>
              <th style={{ textAlign: "start" }}>{t("payments.col_status")}</th>
              <th style={{ textAlign: "start" }}>{t("payments.col_subject")}</th>
              <th style={{ textAlign: "start" }}>{t("payments.col_external")}</th>
              <th style={{ textAlign: "start" }}>{t("payments.col_created")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {payments.map((payment) => (
              <tr key={payment.id}>
                <td>{formatAmount(payment.amount, payment.currency)}</td>
                <td>
                  <Badge tone={STATUS_TONE[payment.status] ?? "neutral"}>
                    {statusLabel(payment.status)}
                  </Badge>
                </td>
                <td>
                  {payment.subject_type}/{payment.subject_id}
                </td>
                <td>
                  <code>{payment.external_payment_id ?? "—"}</code>
                </td>
                <td>{new Date(payment.created_at).toLocaleString()}</td>
                <td>
                  <Button variant="ghost" onClick={() => openDetail(payment)}>
                    {t("payments.open")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <Button
          variant="ghost"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - limit))}
        >
          ← {t("payments.prev")}
        </Button>
        <Button
          variant="ghost"
          disabled={payments === null || payments.length < limit}
          onClick={() => setOffset(offset + limit)}
        >
          {t("payments.next")} →
        </Button>
      </div>
    </div>
  );
}

// ---- Providers (trusted catalog types + instance configuration) ------------

function ProvidersTab(props: { readonly openInstanceId?: string | null }) {
  const auth = useAuth();
  const canConfigure = auth.can("payments.configure");
  const [types, setTypes] = useState<ProviderTypeWire[] | null>(null);
  const [instances, setInstances] = useState<ProviderInstanceWire[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, TestCheck[] | undefined>>({});
  const [settingsFor, setSettingsFor] = useState<string | null>(props.openInstanceId ?? null);
  const [creating, setCreating] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([
      apiGet<{ items: ProviderTypeWire[] }>("/payments/providers"),
      apiGet<{ items: ProviderInstanceWire[] }>("/payments/providers/instances"),
    ])
      .then(([typeResult, instanceResult]) => {
        setTypes(typeResult.items);
        setInstances(instanceResult.items);
      })
      .catch((cause: unknown) => setError(describeApiError(cause)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (types === null || instances === null) {
    return error !== null ? <ErrorPanel message={error} /> : <Spinner />;
  }

  const mutate = (action: () => Promise<unknown>, noteKey: string) => {
    setError(null);
    setNote(null);
    action()
      .then(() => {
        setNote(t(noteKey));
        load();
      })
      .catch((cause: unknown) => setError(describeApiError(cause)));
  };

  /** A connection is born as a DISABLED draft; the dialog then configures and
   * enables it in one save. A failed first save leaves a visible draft, never
   * a false success. */
  const connect = (type: ProviderTypeWire) => {
    setCreating(type.provider_type);
    setError(null);
    apiPost<{ instance: ProviderInstanceWire }>("/payments/providers/instances", {
      provider_type: type.provider_type,
      name: `${type.display_name} — ${new Date().toLocaleDateString()}`,
    })
      .then((result) => {
        load();
        setSettingsFor(result.instance.id);
      })
      .catch((cause: unknown) => setError(describeApiError(cause)))
      .finally(() => setCreating(null));
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {error !== null ? <ErrorPanel message={error} /> : null}
      {note !== null ? <p>{note}</p> : null}
      {!canConfigure ? <p>{t("payments.readonly_notice")}</p> : null}
      <Card title={t("payments.providers_catalog")}>
        <div style={{ display: "grid", gap: 8 }}>
          {types.length === 0 ? (
            <EmptyState title={t("payments.providers_none_composed")} />
          ) : (
            types.map((type) => (
              <div
                key={type.provider_type}
                style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
              >
                <strong>{type.display_name}</strong>
                <code style={{ opacity: 0.7 }}>{type.provider_type}</code>
                {canConfigure ? (
                  <Button disabled={creating !== null} onClick={() => connect(type)}>
                    {t("payments.connect")}
                  </Button>
                ) : null}
              </div>
            ))
          )}
        </div>
      </Card>
      <Card title={t("payments.instances")}>
        {instances.length === 0 ? (
          <EmptyState title={t("payments.instances_empty")} />
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {instances.map((instance) => (
              <div key={instance.id} style={{ display: "grid", gap: 4 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <strong>{instance.name}</strong>
                  <code>{instance.provider_type}</code>
                  <Badge tone={instance.enabled ? "success" : "warning"}>
                    {instance.enabled
                      ? t("payments.instance_enabled")
                      : t("payments.instance_disabled")}
                  </Badge>
                  {!instance.enabled ? (
                    <span style={{ opacity: 0.7 }}>{t("payments.instance_disabled_hint")}</span>
                  ) : null}
                </div>
                {canConfigure ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Button variant="ghost" onClick={() => setSettingsFor(instance.id)}>
                      {t("payments.edit")}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        mutate(
                          () =>
                            apiPatch(`/payments/providers/instances/${instance.id}`, {
                              enabled: !instance.enabled,
                            }),
                          instance.enabled ? "payments.note_disabled" : "payments.note_enabled",
                        )
                      }
                    >
                      {instance.enabled ? t("payments.disable") : t("payments.enable")}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setTestResult((current) => ({ ...current, [instance.id]: [] }));
                        apiPost<{ ok: boolean; checks: TestCheck[] }>(
                          `/payments/providers/instances/${instance.id}/test`,
                          {},
                        )
                          .then((result) =>
                            setTestResult((current) => ({
                              ...current,
                              [instance.id]: result.checks,
                            })),
                          )
                          .catch((cause: unknown) => setError(describeApiError(cause)));
                      }}
                    >
                      {t("payments.test")}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        if (!window.confirm(t("payments.delete_confirm"))) return;
                        mutate(
                          () => apiDelete(`/payments/providers/instances/${instance.id}`),
                          "payments.note_deleted",
                        );
                      }}
                    >
                      {t("payments.delete")}
                    </Button>
                  </div>
                ) : null}
                {testResult[instance.id] !== undefined ? (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {(testResult[instance.id] ?? []).map((check) => (
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
              </div>
            ))}
          </div>
        )}
      </Card>
      {settingsFor !== null ? (
        <ProviderSettingsDialog
          instanceId={settingsFor}
          onClose={() => setSettingsFor(null)}
          onSaved={() => load()}
        />
      ) : null}
    </div>
  );
}

// ---- Events & diagnostics --------------------------------------------------

function EventsTab() {
  const auth = useAuth();
  const canRead = auth.can("payments.events.read");
  const [events, setEvents] = useState<InboundWire[] | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    const params = new URLSearchParams();
    if (status !== "") params.set("status", status);
    apiGet<{ items: InboundWire[] }>(`/payments/inbound-events?${params.toString()}`)
      .then((result) => setEvents(result.items))
      .catch((cause: unknown) => setError(describeApiError(cause)));
  }, [status]);

  useEffect(() => {
    if (canRead) load();
  }, [canRead, load]);

  if (!canRead) return <EmptyState title={t("core.forbidden")} />;
  if (error !== null) return <ErrorPanel message={error} />;
  if (events === null) return <Spinner />;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p style={{ opacity: 0.7, margin: 0 }}>{t("payments.inbound_hint")}</p>
      <Field label={t("payments.filter_status")}>
        <Select value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
          <option value="">{t("payments.filter_all")}</option>
          <option value="RECEIVED">{t("payments.inbound_received")}</option>
          <option value="PROCESSED">{t("payments.inbound_processed")}</option>
          <option value="FAILED">{t("payments.inbound_failed")}</option>
        </Select>
      </Field>
      {events.length === 0 ? (
        <EmptyState title={t("payments.inbound_empty")} />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "start" }}>{t("payments.col_status")}</th>
              <th style={{ textAlign: "start" }}>{t("payments.col_instance")}</th>
              <th style={{ textAlign: "start" }}>{t("payments.col_provider_event")}</th>
              <th style={{ textAlign: "start" }}>{t("payments.col_error")}</th>
              <th style={{ textAlign: "start" }}>{t("payments.col_received")}</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>
                  <Badge
                    tone={
                      event.status === "PROCESSED"
                        ? "success"
                        : event.status === "FAILED"
                          ? "danger"
                          : "warning"
                    }
                  >
                    {event.status}
                  </Badge>
                </td>
                <td>
                  <code>{event.source_id}</code>
                </td>
                <td>
                  <code>{event.provider_event_id ?? "—"}</code>
                </td>
                <td>{event.error_code ?? "—"}</td>
                <td>{new Date(event.received_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function PaymentsScreen() {
  // Deep link contract (CORE-PAYMENTS-ADMIN-CONFIG-01 §5.3): the Extensions
  // screen's "Configure" for a payment provider lands here, on the SAME
  // instance form — merchant credentials are never edited in two places.
  const route = useRoute();
  const requestedTab = route.query.get("tab");
  const [tab, setTab] = useState(
    requestedTab === "providers" || requestedTab === "events" ? requestedTab : "payments",
  );
  const openInstance = route.query.get("instance");
  useEffect(() => {
    if (requestedTab === "providers" || requestedTab === "events") setTab(requestedTab);
  }, [requestedTab]);
  return (
    <div data-testid="payments-screen">
      <h1>{t("payments.title")}</h1>
      <Tabs
        label={t("payments.title")}
        items={[
          { id: "payments", title: t("payments.tab_payments") },
          { id: "providers", title: t("payments.tab_providers") },
          { id: "events", title: t("payments.tab_events") },
        ]}
        active={tab}
        onSelect={setTab}
      />
      {tab === "payments" ? <PaymentsTab /> : null}
      {tab === "providers" ? <ProvidersTab openInstanceId={openInstance} /> : null}
      {tab === "events" ? <EventsTab /> : null}
    </div>
  );
}
