import { useState } from "react";
import { ApiError, apiGet, apiPost } from "../../api/client.js";
import { Button, Field, Input, Select, Textarea } from "../../design/ui.js";
import { errorText, t } from "../../i18n/index.js";
import { useRoute } from "../../layout/router.js";

type Target = { entity: "submission" | "quiz_run" | "lead"; id: string };
type Action = "block" | "unblock" | "rectify" | "erase";
type Cell = { key: string; label: string; value: string; json: boolean };
interface Preview {
  source: { entity: "submission" | "quiz_run"; id: string };
  lead_ids: string[];
  outbox_ids: string[];
  delivery_ids: string[];
  expected_token: string;
  in_flight: boolean;
  external_copies: {
    delivery_id: string;
    instance_id: string;
    status: string;
    external_id?: string | null;
  }[];
  limitations: string[];
}
interface Receipt {
  case_id: string;
  local_state: string;
  external_state: string;
  actor?: { type: string; id: string };
  created_at?: string;
  request_ref?: string | null;
  followups: {
    delivery_id: string;
    instance_id: string;
    state: string;
    external_id?: string | null;
    evidence_ref: string | null;
    resolved_by?: string | null;
    resolved_at?: string | null;
  }[];
}

export function AdminPrivacyScreen() {
  const route = useRoute();
  const [target, setTarget] = useState<Target>(() => {
    const entity = route.query.get("entity");
    return {
      entity: entity === "quiz_run" || entity === "lead" ? entity : "submission",
      id: route.query.get("id") ?? "",
    };
  });
  const [action, setAction] = useState<Action>("block");
  const [cells, setCells] = useState<Cell[]>([]);
  const [correctionEntity, setCorrectionEntity] = useState<"submission" | "quiz_run" | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [caseId, setCaseId] = useState("");
  const [requestRef, setRequestRef] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [evidence, setEvidence] = useState("");
  const invalidate = () => {
    setPreview(null);
    setRequestId(crypto.randomUUID());
  };
  const perform = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? (errorText(failure.code) ?? failure.message)
          : failure instanceof Error
            ? failure.message
            : String(failure),
      );
    } finally {
      setBusy(false);
    }
  };
  const loadFields = async () => {
    let source: Target = target;
    if (source.entity === "lead") {
      const lead = await apiGet<{ source_type: string; source_id: string }>(
        `/interactions/leads/${encodeURIComponent(source.id)}`,
      );
      source = {
        entity: lead.source_type === "FORM_SUBMISSION" ? "submission" : "quiz_run",
        id: lead.source_id,
      };
    }
    const detail = await apiGet<{
      payload?: Record<string, unknown>;
      labels?: Record<string, string>;
      answers?: { question_id: string; label: string; value: unknown }[];
    }>(
      `/interactions/${source.entity === "submission" ? "submissions" : "quiz-runs"}/${encodeURIComponent(source.id)}`,
    );
    const values =
      source.entity === "submission"
        ? Object.entries(detail.payload ?? {}).map(([key, value]) => ({
            key,
            label: detail.labels?.[key] ?? key,
            value,
          }))
        : (detail.answers ?? []).map((answer) => ({
            key: answer.question_id,
            label: answer.label,
            value: answer.value,
          }));
    setCells(
      values.map(({ key, label, value }) => ({
        key,
        label,
        value: typeof value === "string" ? value : JSON.stringify(value),
        json: typeof value !== "string",
      })),
    );
    setCorrectionEntity(source.entity as "submission" | "quiz_run");
    invalidate();
  };
  const operation = () => {
    if (action !== "rectify") return { target, action };
    if (correctionEntity === null) throw new Error(t("privacy.load_first"));
    const entries = cells.map(
      (cell) => [cell.key, cell.json ? (JSON.parse(cell.value) as unknown) : cell.value] as const,
    );
    return {
      target,
      action,
      correction:
        correctionEntity === "submission"
          ? { submission_payload: Object.fromEntries(entries) }
          : { quiz_answers: entries.map(([question_id, value]) => ({ question_id, value })) },
    };
  };
  return (
    <div className="pcms-workspace">
      <h1>{t("privacy.title")}</h1>
      <p>{t("privacy.explanation")}</p>
      {error ? (
        <p role="alert" className="pcms-field__error">
          {error}
        </p>
      ) : null}
      <Field label={t("privacy.entity")}>
        <Select
          disabled={busy}
          value={target.entity}
          onChange={(event) => {
            setTarget({ ...target, entity: event.target.value as Target["entity"] });
            setCorrectionEntity(null);
            setCells([]);
            invalidate();
          }}
        >
          <option value="submission">{t("privacy.submission")}</option>
          <option value="quiz_run">{t("privacy.quiz_run")}</option>
          <option value="lead">{t("privacy.lead")}</option>
        </Select>
      </Field>
      <Field label={t("privacy.record_id")}>
        <Input
          disabled={busy}
          value={target.id}
          onChange={(event) => {
            setTarget({ ...target, id: event.target.value });
            setCorrectionEntity(null);
            setCells([]);
            invalidate();
          }}
        />
      </Field>
      <Field label={t("privacy.action")}>
        <Select
          disabled={busy}
          value={action}
          onChange={(event) => {
            setAction(event.target.value as Action);
            invalidate();
          }}
        >
          {(["block", "unblock", "rectify", "erase"] as const).map((value) => (
            <option key={value} value={value}>
              {t(`privacy.${value}`)}
            </option>
          ))}
        </Select>
      </Field>
      {action === "rectify" ? (
        <section>
          <Button disabled={busy || !target.id} onClick={() => void perform(loadFields)}>
            {t("privacy.load_fields")}
          </Button>
          <p className="pcms-field__hint">{t("privacy.correct_hint")}</p>
          {cells.map((cell) => (
            <Field
              key={cell.key}
              label={cell.label}
              {...(cell.json ? { hint: t("privacy.structured_hint") } : {})}
            >
              <Textarea
                disabled={busy}
                value={cell.value}
                onChange={(event) => {
                  setCells(
                    cells.map((value) =>
                      value.key === cell.key ? { ...value, value: event.target.value } : value,
                    ),
                  );
                  invalidate();
                }}
              />
            </Field>
          ))}
        </section>
      ) : null}
      <Field label={t("privacy.request_ref")}>
        <Input
          disabled={busy}
          value={requestRef}
          onChange={(event) => setRequestRef(event.target.value)}
        />
      </Field>
      <Button
        disabled={busy || !target.id}
        onClick={() =>
          void perform(async () =>
            setPreview(await apiPost<Preview>("/interactions/privacy/preview", operation())),
          )
        }
      >
        {t("privacy.preview")}
      </Button>
      {preview ? (
        <section aria-label={t("privacy.preview")}>
          <p>
            {preview.source.entity}: {preview.source.id}
          </p>
          <p>
            {t("privacy.local_counts", {
              leads: preview.lead_ids.length,
              outbox: preview.outbox_ids.length,
              deliveries: preview.delivery_ids.length,
            })}
          </p>
          <details>
            <summary>{t("privacy.affected_ids")}</summary>
            <pre>
              {JSON.stringify(
                {
                  leads: preview.lead_ids,
                  outbox: preview.outbox_ids,
                  deliveries: preview.delivery_ids,
                },
                null,
                2,
              )}
            </pre>
          </details>
          {preview.external_copies.map((copy) => (
            <p key={copy.delivery_id}>
              {copy.instance_id} · {copy.delivery_id} · {copy.status} {copy.external_id}
            </p>
          ))}
          {preview.limitations.map((limit) => (
            <p key={limit}>{limit}</p>
          ))}
          {preview.in_flight ? <p>{t("privacy.in_flight")}</p> : null}
          <Button
            variant={action === "erase" ? "danger" : "primary"}
            disabled={busy || preview.in_flight}
            onClick={() =>
              void perform(async () => {
                const result = await apiPost<Receipt>("/interactions/privacy/apply", {
                  ...operation(),
                  expected_token: preview.expected_token,
                  request_id: requestId,
                  ...(requestRef.trim() ? { request_ref: requestRef.trim() } : {}),
                });
                setReceipt(result);
                setCaseId(result.case_id);
                setPreview(null);
              })
            }
          >
            {t("privacy.apply")}: {t(`privacy.${action}`)}
          </Button>
        </section>
      ) : null}
      <hr />
      <Field label={t("privacy.case_id")}>
        <Input disabled={busy} value={caseId} onChange={(event) => setCaseId(event.target.value)} />
      </Field>
      <Button
        disabled={busy || !caseId}
        onClick={() =>
          void perform(async () =>
            setReceipt(
              await apiGet<Receipt>(`/interactions/privacy/cases/${encodeURIComponent(caseId)}`),
            ),
          )
        }
      >
        {t("privacy.open_case")}
      </Button>
      {receipt ? (
        <section>
          <p>
            {receipt.case_id} · {receipt.local_state} · {receipt.external_state}
          </p>
          <p>
            {receipt.actor?.id} {receipt.created_at} {receipt.request_ref}
          </p>
          <p>{t("privacy.external_hint")}</p>
          <Field label={t("privacy.evidence")}>
            <Input
              disabled={busy}
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
            />
          </Field>
          {receipt.followups.map((followup) => (
            <div key={followup.delivery_id}>
              <p>
                {followup.instance_id} · {followup.delivery_id} · {followup.state}{" "}
                {followup.external_id} {followup.evidence_ref} {followup.resolved_by}{" "}
                {followup.resolved_at}
              </p>
              {followup.state === "pending" ? (
                <div className="pcms-actions-row">
                  {(["acknowledged", "owner_exception"] as const).map((decision) => (
                    <Button
                      key={decision}
                      disabled={busy}
                      variant="ghost"
                      onClick={() =>
                        void perform(async () =>
                          setReceipt(
                            await apiPost<Receipt>(
                              `/interactions/privacy/cases/${receipt.case_id}/deliveries/${followup.delivery_id}/acknowledge`,
                              {
                                decision,
                                ...(evidence.trim() ? { evidence_ref: evidence.trim() } : {}),
                              },
                            ),
                          ),
                        )
                      }
                    >
                      {t(`privacy.${decision}`)}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}
