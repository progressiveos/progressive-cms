// Audit screen (PCMS-ADMIN-T022; Admin spec §47): security events with
// actor type / transport / event filters. Human, agent, system and operator
// actors are distinguishable at a glance.
import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../../api/client.js";
import { Badge, Button, EmptyState, Input, Select, Spinner } from "../../design/ui.js";
import { useDebouncedReload } from "../../design/use-debounced-reload.js";
import { formatDateTime, t } from "../../i18n/index.js";

interface AuditRow {
  readonly id: string;
  readonly event_type: string;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly subject_type: string | null;
  readonly subject_id: string | null;
  readonly transport: string | null;
  readonly metadata: unknown;
  readonly created_at: string;
}

const ACTOR_TONES: Readonly<Record<string, "neutral" | "accent" | "success" | "warning">> = {
  USER: "accent",
  SERVICE_ACCOUNT: "warning",
  SYSTEM: "neutral",
  OPERATOR: "success",
};

/** Actor type → t() key; unknown types fall back to the raw API value. */
const ACTOR_KEYS: Readonly<Record<string, string>> = {
  USER: "access.actor_user",
  SERVICE_ACCOUNT: "access.actor_service_account",
  SYSTEM: "access.actor_system",
  OPERATOR: "access.actor_operator",
};

export function AuditScreen() {
  const [rows, setRows] = useState<readonly AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [eventType, setEventType] = useState("");
  const [actorType, setActorType] = useState("");
  const [transport, setTransport] = useState("");
  const [actorId, setActorId] = useState("");

  const reload = useCallback(() => {
    setError(null);
    const params = new URLSearchParams({ limit: "100" });
    if (eventType !== "") params.set("event_type", eventType);
    if (actorType !== "") params.set("actor_type", actorType);
    if (transport !== "") params.set("transport", transport);
    if (actorId !== "") params.set("actor_id", actorId);
    apiGet<{ items: readonly AuditRow[] }>(`/audit?${params.toString()}`)
      .then((result) => setRows(result.items))
      .catch(() => setError(t("access.audit_load_failed")));
  }, [eventType, actorType, transport, actorId]);

  useDebouncedReload(reload);

  if (error !== null) {
    return (
      <div>
        <p>{error}</p>
        <Button onClick={reload}>{t("core.retry")}</Button>
      </div>
    );
  }
  if (rows === null) return <Spinner />;

  return (
    <div className="pcms-screen--wide" data-testid="audit-screen">
      <h1>{t("access.audit_title")}</h1>
      <div className="pcms-toolbar">
        <Input
          style={{ maxWidth: "14rem" }}
          placeholder={t("access.audit_event_placeholder")}
          aria-label={t("access.audit_event_aria")}
          value={eventType}
          onChange={(event) => setEventType(event.target.value)}
        />
        <Select
          style={{ width: "auto" }}
          aria-label={t("access.audit_actor_aria")}
          value={actorType}
          onChange={(event) => setActorType(event.target.value)}
        >
          <option value="">{t("access.audit_all_actors")}</option>
          <option value="USER">{t("access.audit_actor_user")}</option>
          <option value="SERVICE_ACCOUNT">{t("access.audit_actor_service")}</option>
          <option value="SYSTEM">{t("access.audit_actor_system")}</option>
          <option value="OPERATOR">{t("access.audit_actor_operator")}</option>
        </Select>
        <Select
          style={{ width: "auto" }}
          aria-label={t("access.audit_transport_aria")}
          value={transport}
          onChange={(event) => setTransport(event.target.value)}
        >
          <option value="">{t("access.audit_all_transports")}</option>
          <option value="api">{t("access.transport_api")}</option>
          <option value="mcp">{t("access.transport_mcp")}</option>
          <option value="cli">{t("access.transport_cli")}</option>
          <option value="operator">{t("access.transport_operator")}</option>
        </Select>
        <Input
          style={{ maxWidth: "14rem" }}
          placeholder={t("access.audit_actor_id")}
          aria-label={t("access.audit_actor_id")}
          value={actorId}
          onChange={(event) => setActorId(event.target.value)}
        />
      </div>
      {rows.length === 0 ? (
        <EmptyState title={t("access.audit_empty")} hint={t("access.audit_empty_hint")} />
      ) : (
        <div className="pcms-table-wrap">
          <table className="pcms-table" data-testid="audit-table">
            <thead>
              <tr>
                <th>{t("access.th_time")}</th>
                <th>{t("access.th_event")}</th>
                <th>{t("access.th_actor")}</th>
                <th>{t("access.th_transport")}</th>
                <th>{t("access.th_subject")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const actorKey = ACTOR_KEYS[row.actor_type];
                return (
                  <tr key={row.id}>
                    <td>{formatDateTime(row.created_at)}</td>
                    <td
                      style={{
                        fontFamily: "var(--pcms-admin-font-mono)",
                        fontSize: "var(--pcms-admin-text-sm)",
                      }}
                    >
                      {row.event_type}
                    </td>
                    <td>
                      <Badge tone={ACTOR_TONES[row.actor_type] ?? "neutral"}>
                        {actorKey === undefined ? row.actor_type : t(actorKey)}
                      </Badge>
                      {row.actor_id === null ? null : (
                        <div className="pcms-picker-row__meta">{row.actor_id.slice(0, 8)}…</div>
                      )}
                    </td>
                    <td>{row.transport ?? "—"}</td>
                    <td>
                      {row.subject_type === null
                        ? "—"
                        : `${row.subject_type} ${row.subject_id?.slice(0, 8) ?? ""}…`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
