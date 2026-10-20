// Publication Calendar (PCMS-ADMIN-T017; Admin spec §35): calendar/list
// toggle over the M07 calendar service; reschedule via an exact-datetime
// modal (drag is optional and omitted), cancel and publish-now where
// permitted; persisted semantics never reinterpreted in the browser.
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../../api/client.js";
import { useAuth } from "../../auth/AuthContext.js";
import { Dialog } from "../../design/dialog.js";
import { useToast } from "../../design/toast.js";
import { Badge, Button, EmptyState, Field, Input, Spinner } from "../../design/ui.js";
import { formatDateTime, formatTime, t } from "../../i18n/index.js";

interface CalendarEntryWire {
  readonly planId: string;
  readonly planItemId: string;
  readonly changesetId: string;
  readonly changesetTitle: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly kind: string;
  readonly instant: string;
  readonly state: string;
  readonly lastError: string | null;
}

/** Label maps resolve per render so a locale switch re-localizes them. */
function kindLabel(kind: string): string {
  switch (kind) {
    case "scheduled-publish":
      return t("publication.kind_publish");
    case "scheduled-unpublish":
      return t("publication.kind_unpublish");
    case "failed":
      return t("publication.kind_failed");
    case "cancelled":
      return t("publication.kind_cancelled");
    case "paused":
      return t("publication.kind_paused");
    default:
      return kind;
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case "SCHEDULED":
      return t("publication.state_scheduled");
    case "PUBLISHED":
      return t("publication.state_published");
    case "UNPUBLISHED":
      return t("publication.state_unpublished");
    case "FAILED":
      return t("publication.state_failed");
    case "CANCELLED":
      return t("publication.state_cancelled");
    case "PAUSED":
      return t("publication.state_paused");
    default:
      return state;
  }
}

const STATE_TONES: Readonly<
  Record<string, "neutral" | "accent" | "success" | "warning" | "danger">
> = {
  SCHEDULED: "accent",
  PUBLISHED: "success",
  UNPUBLISHED: "neutral",
  FAILED: "danger",
  CANCELLED: "neutral",
  PAUSED: "warning",
};

export function CalendarScreen() {
  const auth = useAuth();
  const toast = useToast();
  const [entries, setEntries] = useState<readonly CalendarEntryWire[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"calendar" | "list">("calendar");
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [reschedule, setReschedule] = useState<CalendarEntryWire | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    setError(null);
    const parts = month.split("-").map((part) => Number(part));
    const year = parts[0] ?? new Date().getUTCFullYear();
    const mon = parts[1] ?? 1;
    const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    const from = `${month}-01T00:00:00Z`;
    const to = `${month}-${String(lastDay).padStart(2, "0")}T23:59:59Z`;
    apiGet<{ items: readonly CalendarEntryWire[] }>(
      `/publication/calendar?from=${from}&to=${to}&limit=100`,
    )
      .then((result) => setEntries(result.items))
      .catch(() => setError(t("publication.calendar_load_failed")));
  }, [month]);

  useEffect(reload, [reload]);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      toast(success, "success");
      reload();
    } catch {
      toast(t("publication.operation_failed_short"), "error");
    } finally {
      setBusy(false);
    }
  };

  const monthDates = useCallback((): { day: Date; entries: readonly CalendarEntryWire[] }[] => {
    const parts = month.split("-").map((part) => Number(part));
    const year = parts[0] ?? new Date().getUTCFullYear();
    const mon = parts[1] ?? 1;
    const first = new Date(Date.UTC(year, mon - 1, 1));
    const last = new Date(Date.UTC(year, mon, 0));
    const days: { day: Date; entries: readonly CalendarEntryWire[] }[] = [];
    for (let day = 1; day <= last.getUTCDate(); day += 1) {
      const date = new Date(Date.UTC(year, mon - 1, day));
      const key = date.toISOString().slice(0, 10);
      days.push({
        day: date,
        entries: (entries ?? []).filter((entry) => entry.instant.slice(0, 10) === key),
      });
    }
    void first;
    return days;
  }, [month, entries]);

  if (error !== null) {
    return (
      <div>
        <p>{error}</p>
        <Button onClick={reload}>{t("publication.retry")}</Button>
      </div>
    );
  }
  if (entries === null) return <Spinner />;

  return (
    <div data-testid="calendar-screen">
      <div className="pcms-toolbar">
        <Input
          type="month"
          style={{ width: "auto" }}
          aria-label={t("publication.month_aria")}
          value={month}
          onChange={(event) => setMonth(event.target.value)}
        />
        <Button variant="ghost" onClick={() => setMode(mode === "calendar" ? "list" : "calendar")}>
          {mode === "calendar" ? t("publication.view_list") : t("publication.view_calendar")}
        </Button>
        <span className="pcms-toolbar__spacer" />
        <span className="pcms-field__hint">{t("publication.timezone_hint")}</span>
      </div>

      {entries.length === 0 ? (
        <EmptyState title={t("publication.empty_month")} />
      ) : mode === "calendar" ? (
        <div className="pcms-calendar-grid" data-testid="calendar-grid">
          {monthDates().map(({ day, entries: dayEntries }) => (
            <div key={day.toISOString()} className="pcms-calendar-cell">
              <div className="pcms-calendar-cell__day">{day.getUTCDate()}</div>
              {dayEntries.map((entry) => (
                <button
                  key={entry.planItemId}
                  type="button"
                  className="pcms-calendar-entry"
                  title={t("publication.entry_tooltip", {
                    title: entry.changesetTitle,
                    time: formatTime(entry.instant),
                  })}
                  onClick={() => setReschedule(entry)}
                >
                  {formatTime(entry.instant, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}{" "}
                  {entry.changesetTitle}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="pcms-table-wrap">
          <table className="pcms-table" data-testid="calendar-list">
            <thead>
              <tr>
                <th>{t("publication.col_when")}</th>
                <th>{t("publication.col_changeset")}</th>
                <th>{t("publication.col_type")}</th>
                <th>{t("publication.col_status")}</th>
                <th>{t("publication.col_actions")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.planItemId}>
                  <td>{formatDateTime(entry.instant)}</td>
                  <td>{entry.changesetTitle}</td>
                  <td>{kindLabel(entry.kind)}</td>
                  <td>
                    <Badge tone={STATE_TONES[entry.state] ?? "neutral"}>
                      {stateLabel(entry.state)}
                    </Badge>
                    {entry.lastError === null ? null : (
                      <div className="pcms-field__error">{entry.lastError}</div>
                    )}
                  </td>
                  <td className="pcms-actions-row">
                    {auth.can("publication.schedule") && entry.state === "SCHEDULED" ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setReschedule(entry)}
                        >
                          {t("publication.reschedule")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () =>
                                apiPost(
                                  `/plans/${entry.planId}/items/${entry.planItemId}/cancel`,
                                  {},
                                ),
                              t("publication.publish_cancelled"),
                            )
                          }
                        >
                          {t("publication.cancel_publication")}
                        </Button>
                      </>
                    ) : null}
                    {auth.can("publication.publish") && entry.state === "SCHEDULED" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              apiPost(
                                `/plans/${entry.planId}/items/${entry.planItemId}/publish-now`,
                                {},
                              ),
                            t("publication.published_now"),
                          )
                        }
                      >
                        {t("publication.publish_now")}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reschedule !== null ? (
        <RescheduleDialog
          entry={reschedule}
          onClose={() => setReschedule(null)}
          onReschedule={(publishAt) => {
            const target = reschedule;
            setReschedule(null);
            void run(
              () =>
                apiPost(`/plans/${target.planId}/items/${target.planItemId}/reschedule`, {
                  publish_at: publishAt,
                }),
              t("publication.rescheduled_done"),
            );
          }}
        />
      ) : null}
    </div>
  );
}

function RescheduleDialog(props: {
  readonly entry: CalendarEntryWire;
  readonly onClose: () => void;
  readonly onReschedule: (publishAt: string) => void;
}) {
  const local = new Date(props.entry.instant);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const initial = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}`;
  const [value, setValue] = useState(initial);
  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t("publication.reschedule_title", { title: props.entry.changesetTitle })}
      footer={
        <>
          <Button onClick={props.onClose}>{t("cancel")}</Button>
          <Button
            variant="primary"
            disabled={value === ""}
            onClick={() => props.onReschedule(new Date(value).toISOString())}
          >
            {t("publication.reschedule")}
          </Button>
        </>
      }
    >
      <Field label={t("publication.new_datetime_label")} required>
        <Input
          type="datetime-local"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
    </Dialog>
  );
}
