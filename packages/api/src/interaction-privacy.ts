// Owner-authorized addressed operations coordinate Forms and local copies.
import { createHash } from "node:crypto";
import { type Clock, type DbClient, type DbPool, isStableId, newStableId } from "@pcms/core";
import {
  computeScore,
  createFormsDomainServices,
  FormsError,
  type QuizAnswerValue,
  renderLeadPresentation,
  resolveNextStep,
  resolveOutcome,
  validateAnswerValue,
  validateFormValues,
} from "@pcms/forms";

export type PrivacyTarget = {
  readonly entity: "submission" | "quiz_run" | "lead";
  readonly id: string;
};
export type PrivacyAction = "rectify" | "block" | "unblock" | "erase";
export interface PrivacyCorrection {
  readonly submission_payload?: Readonly<Record<string, unknown>>;
  readonly quiz_answers?: readonly { readonly question_id: string; readonly value: unknown }[];
}
export interface PrivacyOperation {
  readonly target: PrivacyTarget;
  readonly action: PrivacyAction;
  readonly correction?: PrivacyCorrection;
}
export interface PrivacyActor {
  readonly type: string;
  readonly id: string;
}
export interface PrivacyPreview {
  readonly source: { readonly entity: "submission" | "quiz_run"; readonly id: string };
  readonly lead_ids: readonly string[];
  readonly outbox_ids: readonly string[];
  readonly delivery_ids: readonly string[];
  readonly in_flight: boolean;
  readonly blocked: boolean;
  readonly erased: boolean;
  readonly expected_token: string;
  readonly external_copies: readonly {
    readonly delivery_id: string;
    readonly instance_id: string;
    readonly status: string;
    readonly external_id: string | null;
  }[];
  readonly limitations: readonly string[];
}
export interface PrivacyFollowup {
  readonly delivery_id: string;
  readonly instance_id: string;
  readonly state: "pending" | "acknowledged" | "owner_exception";
  readonly evidence_ref: string | null;
  readonly external_id: string | null;
  readonly resolved_actor_type: string | null;
  readonly resolved_by: string | null;
  readonly resolved_at: string | null;
}
export interface PrivacyReceipt {
  readonly case_id: string;
  readonly target: PrivacyTarget;
  readonly source: PrivacyPreview["source"];
  readonly action: PrivacyAction;
  readonly local_state: "blocked" | "unblocked" | "rectified" | "erased";
  readonly created_at: string;
  readonly actor: PrivacyActor;
  readonly request_ref: string | null;
  readonly followups: readonly PrivacyFollowup[];
  readonly external_state: "none_known" | "pending" | "acknowledged_or_excepted";
}
export interface PrivacyApplyInput extends PrivacyOperation {
  readonly request_id: string;
  readonly expected_token: string;
  readonly actor: PrivacyActor;
  readonly request_ref?: string;
}
export interface PrivacyAcknowledgement {
  readonly decision: "acknowledged" | "owner_exception";
  readonly evidence_ref?: string;
  readonly actor: PrivacyActor;
}
export interface InteractionPrivacyService {
  deliveryBlocked(tx: DbClient, eventId: string): Promise<boolean>;
  preview(input: PrivacyOperation): Promise<PrivacyPreview>;
  apply(input: PrivacyApplyInput): Promise<PrivacyReceipt>;
  get(caseId: string): Promise<PrivacyReceipt>;
  acknowledge(
    caseId: string,
    deliveryId: string,
    input: PrivacyAcknowledgement,
  ): Promise<PrivacyReceipt>;
}

type Row = Record<string, unknown>;
type Closure = {
  source: PrivacyPreview["source"];
  record: Row;
  leads: Row[];
  outbox: Row[];
  deliveries: Row[];
  subject: Row | undefined;
  answers: Row[];
};
function fail(code: string, message: string): never {
  throw new FormsError(code, message);
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[47][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
function operation(input: PrivacyOperation): void {
  if (
    !input ||
    !input.target ||
    !["submission", "quiz_run", "lead"].includes(input.target.entity) ||
    !isStableId(input.target.id) ||
    !["rectify", "block", "unblock", "erase"].includes(input.action)
  )
    fail("PRIVACY_OPERATION_INVALID", "invalid target or operation");
  if (input.action !== "rectify" && input.correction !== undefined)
    fail("PRIVACY_OPERATION_INVALID", "correction is only accepted for rectify");
  if (
    input.action === "rectify" &&
    (input.correction === undefined ||
      input.correction === null ||
      typeof input.correction !== "object" ||
      Array.isArray(input.correction) ||
      Object.keys(input.correction).some(
        (key) => !["submission_payload", "quiz_answers"].includes(key),
      ) ||
      Number(input.correction.submission_payload !== undefined) +
        Number(input.correction.quiz_answers !== undefined) !==
        1)
  )
    fail("PRIVACY_CORRECTION_INVALID", "provide exactly one full source correction");
}
function actor(input: PrivacyActor): void {
  if (
    !input ||
    typeof input.id !== "string" ||
    input.id.length < 1 ||
    input.id.length > 200 ||
    !["USER", "SERVICE_ACCOUNT", "SYSTEM", "OPERATOR"].includes(input.type)
  )
    fail("PRIVACY_ACTOR_INVALID", "invalid authenticated actor");
}
function reference(value: unknown): void {
  if (
    value !== undefined &&
    (typeof value !== "string" || value.length > 300 || !/^[A-Za-z0-9:/_.#-]+$/.test(value))
  )
    fail("PRIVACY_REFERENCE_INVALID", "use an opaque reference, not personal data or free text");
}
async function bounded(tx: DbClient, sql: string, params: readonly unknown[]): Promise<Row[]> {
  const query = sql.endsWith(" FOR UPDATE")
    ? sql.slice(0, -11) + " LIMIT 1001 FOR UPDATE"
    : sql + " LIMIT 1001";
  const rows = (await tx.query(query, params)).rows;
  if (rows.length > 1000)
    fail("PRIVACY_SCOPE_TOO_LARGE", "more than 1000 linked records; operator review required");
  return rows;
}
async function load(tx: DbClient, target: PrivacyTarget, lock: boolean): Promise<Closure> {
  let entity: "submission" | "quiz_run" = target.entity === "quiz_run" ? "quiz_run" : "submission";
  let id = target.id;
  if (target.entity === "lead") {
    const lead = (
      await tx.query("SELECT source_type, source_id FROM forms_leads WHERE id=$1", [id])
    ).rows[0];
    if (!lead) fail("PRIVACY_TARGET_NOT_FOUND", "target lead not found");
    entity = lead.source_type === "QUIZ_RUN" ? "quiz_run" : "submission";
    id = String(lead.source_id);
  }
  const table = entity === "submission" ? "forms_submissions" : "forms_quiz_runs";
  const record = (
    await tx.query("SELECT * FROM " + table + " WHERE id=$1" + (lock ? " FOR UPDATE" : ""), [id])
  ).rows[0];
  if (!record) fail("PRIVACY_TARGET_NOT_FOUND", "source interaction not found");
  const leads = await bounded(
    tx,
    "SELECT * FROM forms_leads WHERE source_type=$1 AND source_id=$2 ORDER BY id" +
      (lock ? " FOR UPDATE" : ""),
    [entity === "submission" ? "FORM_SUBMISSION" : "QUIZ_RUN", id],
  );
  const outbox = await bounded(
    tx,
    "SELECT * FROM publication_outbox WHERE (aggregate=$1 AND aggregate_id=$2) OR (aggregate='lead' AND aggregate_id=ANY($3::text[])) ORDER BY id" +
      (lock ? " FOR UPDATE" : ""),
    [entity === "submission" ? "form_submission" : "quiz_run", id, leads.map((r) => r.id)],
  );
  const deliveries = await bounded(
    tx,
    "SELECT * FROM integration_delivery WHERE outbox_event_id=ANY($1::uuid[]) ORDER BY id" +
      (lock ? " FOR UPDATE" : ""),
    [outbox.map((r) => r.id)],
  );
  const subject = (
    await tx.query("SELECT * FROM interaction_privacy_subjects WHERE entity=$1 AND entity_id=$2", [
      entity,
      id,
    ])
  ).rows[0];
  const answers =
    entity === "quiz_run"
      ? await bounded(
          tx,
          "SELECT * FROM forms_quiz_answers WHERE run_id=$1 ORDER BY question_id" +
            (lock ? " FOR UPDATE" : ""),
          [id],
        )
      : [];
  return { source: { entity, id }, record, leads, outbox, deliveries, subject, answers };
}
function projection(state: Closure): PrivacyPreview {
  return {
    source: state.source,
    lead_ids: state.leads.map((r) => String(r.id)),
    outbox_ids: state.outbox.map((r) => String(r.id)),
    delivery_ids: state.deliveries.map((r) => String(r.id)),
    in_flight:
      state.outbox.some((r) => r.state === "PROCESSING") ||
      state.deliveries.some((r) => r.status === "PROCESSING"),
    blocked: state.subject?.blocked === true,
    erased: state.subject?.erased === true,
    expected_token: createHash("sha256").update(canonical(state)).digest("hex"),
    external_copies: state.deliveries
      .filter(
        (r) =>
          r.external_copy_possible === true ||
          Number(r.attempt_count) > 0 ||
          r.status === "SUCCEEDED",
      )
      .map((r) => ({
        delivery_id: String(r.id),
        instance_id: String(r.instance_id),
        status: String(r.status),
        external_id: r.external_id == null ? null : String(r.external_id),
      })),
    limitations: [
      "Already attempted deliveries may exist externally, including failed or timed-out attempts.",
      "External copies, operator exports, backups and provider logs are not deleted automatically.",
      "Rectification retires old queued copies; it never requeues external deliveries automatically.",
      "A lead target applies to its originating interaction and all provenance leads.",
    ],
  };
}
async function corrected(
  tx: DbClient,
  state: Closure,
  input: PrivacyCorrection,
): Promise<() => Promise<void>> {
  const pool = { query: tx.query.bind(tx) } as DbPool;
  const domain = createFormsDomainServices(pool);
  const pick = (values: Record<string, unknown>, key?: string): string | null => {
    const value = key === undefined ? null : values[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  let values: Record<string, unknown>;
  let lead: {
    name: string | null;
    email: string | null;
    phone: string | null;
    summary: string;
    presentation: string;
    classification?: string | null;
  };
  let write: () => Promise<void>;
  if (state.source.entity === "submission") {
    if (input.submission_payload === undefined)
      fail("PRIVACY_CORRECTION_INVALID", "submission_payload required");
    const definition = await domain.definitions.getVersion(
      String(state.record.form_definition_id),
      Number(state.record.form_schema_version),
    );
    values = validateFormValues(definition.fields, input.submission_payload).values;
    const policy = definition.settings.lead_policy;
    const titleRow = (
      await tx.query("SELECT title FROM forms_form_definitions WHERE id=$1", [
        state.record.form_definition_id,
      ])
    ).rows[0];
    const title = `Form "${String(titleRow?.title ?? "")}"`;
    lead = {
      name: pick(values, policy?.name_from),
      email: pick(values, policy?.email_from),
      phone: pick(values, policy?.phone_from),
      summary: pick(values, policy?.summary_from) ?? title,
      presentation: renderLeadPresentation({
        title,
        entries: [
          ...definition.fields
            .filter((field) => field.type !== "hidden_controlled")
            .map((field) => ({ label: field.label, value: values[field.key] })),
          ...(typeof state.record.source_url_snapshot === "string"
            ? [{ label: "Source", value: state.record.source_url_snapshot }]
            : []),
        ],
      }),
    };
    write = async () => {
      await tx.query("UPDATE forms_submissions SET payload=$2::jsonb WHERE id=$1", [
        state.source.id,
        JSON.stringify(values),
      ]);
    };
  } else {
    if (!Array.isArray(input.quiz_answers) || input.quiz_answers.length > 1000)
      fail("PRIVACY_CORRECTION_INVALID", "bounded quiz_answers required");
    const definition = await domain.quizzes.getVersion(
      String(state.record.quiz_definition_id),
      Number(state.record.quiz_schema_version),
    );
    const questions = definition.steps.flatMap((s) => s.questions);
    values = {};
    for (const item of input.quiz_answers) {
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        Object.keys(item).some((key) => !["question_id", "value"].includes(key)) ||
        typeof item.question_id !== "string" ||
        Object.hasOwn(values, item.question_id)
      )
        fail("PRIVACY_CORRECTION_INVALID", "duplicate or invalid answer");
      const question = questions.find((q) => q.id === item.question_id);
      if (!question) fail("PRIVACY_CORRECTION_INVALID", "unknown question");
      const value = validateAnswerValue(question, item.value);
      if (value !== undefined) values[question.id] = value;
    }
    const lookup = (id: string) =>
      Object.hasOwn(values, id)
        ? { answered: true as const, value: values[id] as QuizAnswerValue }
        : { answered: false as const };
    if (state.record.state === "COMPLETED") {
      const seen = new Set<string>();
      let stepId: string | null = definition.steps[0]?.id ?? null;
      while (stepId !== null && !seen.has(stepId)) {
        seen.add(stepId);
        const step = definition.steps.find((s) => s.id === stepId)!;
        if (step.questions.some((q) => q.required && !Object.hasOwn(values, q.id)))
          fail("PRIVACY_CORRECTION_INVALID", "required visited question missing");
        stepId = resolveNextStep(
          definition.steps,
          definition.branching_rules,
          stepId,
          lookup,
        ).next_step;
      }
    }
    const score = computeScore(definition.scoring_rules, lookup);
    const outcome = resolveOutcome(definition.outcomes, score);
    const policy = definition.settings.lead_policy;
    if (state.leads.length > 0 && policy?.consent_from && values[policy.consent_from] !== true)
      fail("PRIVACY_CORRECTION_INVALID", "use erase or block to withdraw a lead consent");
    lead = {
      name: pick(values, policy?.name_from),
      email: pick(values, policy?.email_from),
      phone: pick(values, policy?.phone_from),
      summary:
        pick(values, policy?.summary_from_answer) ??
        "Quiz (outcome: " + (outcome?.id ?? "none") + ")",
      classification: policy?.classification ?? outcome?.lead_classification ?? null,
      presentation: renderLeadPresentation({
        title:
          outcome === null
            ? 'Quiz "' + definition.title + '"'
            : 'Quiz "' + definition.title + '" — outcome: ' + outcome.title,
        entries: questions.map((q) => ({ label: q.label, value: values[q.id] })),
      }),
    };
    write = async () => {
      await tx.query("DELETE FROM forms_quiz_answers WHERE run_id=$1", [state.source.id]);
      for (const [id, value] of Object.entries(values))
        await tx.query(
          "INSERT INTO forms_quiz_answers(id,run_id,question_id,value) VALUES($1,$2,$3,$4::jsonb)",
          [newStableId(), state.source.id, id, JSON.stringify(value)],
        );
      await tx.query(
        "UPDATE forms_quiz_runs SET score=$2,outcome_id=$3,updated_at=now() WHERE id=$1",
        [
          state.source.id,
          state.record.state === "COMPLETED" ? score : null,
          state.record.state === "COMPLETED" ? (outcome?.id ?? null) : null,
        ],
      );
    };
  }
  return async () => {
    await write();
    await tx.query(
      "UPDATE forms_leads SET name=$2,email=$3,phone=$4,summary=$5,presentation=$6,classification=CASE WHEN $8 THEN $7 ELSE classification END,updated_at=now() WHERE id=ANY($1::uuid[])",
      [
        state.leads.map((r) => r.id),
        lead.name,
        lead.email,
        lead.phone,
        lead.summary,
        lead.presentation,
        lead.classification ?? null,
        state.source.entity === "quiz_run",
      ],
    );
  };
}
export function createInteractionPrivacyService(
  pool: DbPool,
  deps: { readonly clock: Clock },
): InteractionPrivacyService {
  const get = async (caseId: string, tx: DbClient = pool): Promise<PrivacyReceipt> => {
    if (!uuid(caseId)) fail("PRIVACY_REQUEST_INVALID", "invalid case id");
    const row = (await tx.query("SELECT * FROM interaction_privacy_cases WHERE id=$1", [caseId]))
      .rows[0];
    if (!row) fail("PRIVACY_CASE_NOT_FOUND", "privacy case not found");
    const followups = (
      await tx.query(
        "SELECT delivery_id,instance_id,state,evidence_ref,external_id,resolved_actor_type,resolved_by,resolved_at FROM interaction_privacy_followups WHERE case_id=$1 ORDER BY delivery_id",
        [caseId],
      )
    ).rows.map((followup) => ({
      ...followup,
      resolved_at:
        followup.resolved_at == null
          ? null
          : (followup.resolved_at instanceof Date
              ? followup.resolved_at
              : new Date(String(followup.resolved_at))
            ).toISOString(),
    })) as unknown as PrivacyFollowup[];
    return {
      case_id: caseId,
      target: { entity: row.target_entity as PrivacyTarget["entity"], id: String(row.target_id) },
      source: {
        entity: row.source_entity as PrivacyPreview["source"]["entity"],
        id: String(row.source_id),
      },
      action: row.action as PrivacyAction,
      local_state: row.local_state as PrivacyReceipt["local_state"],
      created_at: (row.created_at as Date).toISOString(),
      actor: { type: String(row.actor_type), id: String(row.actor_id) },
      request_ref: row.request_ref == null ? null : String(row.request_ref),
      followups,
      external_state:
        followups.length === 0
          ? "none_known"
          : followups.some((f) => f.state === "pending")
            ? "pending"
            : "acknowledged_or_excepted",
    };
  };
  return {
    async deliveryBlocked(tx, eventId) {
      const result = await tx.query(
        "SELECT p.blocked,p.erased FROM publication_outbox o LEFT JOIN forms_leads l ON o.aggregate='lead' AND l.id::text=o.aggregate_id JOIN interaction_privacy_subjects p ON p.entity=CASE WHEN o.aggregate='form_submission' THEN 'submission' WHEN o.aggregate='quiz_run' THEN 'quiz_run' WHEN l.source_type='FORM_SUBMISSION' THEN 'submission' WHEN l.source_type='QUIZ_RUN' THEN 'quiz_run' END AND p.entity_id::text=CASE WHEN o.aggregate='lead' THEN l.source_id::text ELSE o.aggregate_id END WHERE o.id=$1",
        [eventId],
      );
      return result.rows.some((r) => r.blocked === true || r.erased === true);
    },
    async preview(input) {
      operation(input);
      return pool.withTransaction(async (tx) => {
        const state = await load(tx, input.target, true);
        if (input.action === "rectify") await corrected(tx, state, input.correction!);
        return projection(state);
      });
    },
    async apply(input) {
      operation(input);
      actor(input.actor);
      reference(input.request_ref);
      if (
        !uuid(input.request_id) ||
        typeof input.expected_token !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.expected_token)
      )
        fail("PRIVACY_REQUEST_INVALID", "request id and preview token required");
      return pool.withTransaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('pcms:privacy:request:' || $1))", [
          input.request_id,
        ]);
        const fingerprint = createHash("sha256")
          .update(
            canonical({
              target: input.target,
              action: input.action,
              correction: input.correction,
              expected_token: input.expected_token,
              actor: input.actor,
              request_ref: input.request_ref,
            }),
          )
          .digest("hex");
        const existing = (
          await tx.query(
            "SELECT operation_fingerprint FROM interaction_privacy_cases WHERE id=$1",
            [input.request_id],
          )
        ).rows[0];
        if (existing) {
          if (existing.operation_fingerprint !== fingerprint)
            fail("PRIVACY_REQUEST_CONFLICT", "request id already used for another operation");
          return get(input.request_id, tx);
        }
        const state = await load(tx, input.target, true);
        const preview = projection(state);
        for (const eventId of preview.outbox_ids) {
          const locked = await tx.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
            ["pcms:privacy:outbox:" + eventId],
          );
          if (locked.rows[0]?.locked !== true)
            fail("PRIVACY_BUSY_CONFLICT", "outbound delivery is executing; retry after completion");
        }
        if (preview.in_flight)
          fail("PRIVACY_BUSY_CONFLICT", "delivery is in flight; retry after completion");
        if (input.expected_token !== preview.expected_token)
          fail("PRIVACY_STALE_CONFLICT", "records changed; preview again");
        if (preview.erased) fail("PRIVACY_ERASED_CONFLICT", "erased source cannot be changed");
        const writeCorrection =
          input.action === "rectify" ? await corrected(tx, state, input.correction!) : undefined;
        const destructive = input.action === "erase" || input.action === "rectify";
        const blocked =
          input.action === "block" ||
          input.action === "erase" ||
          (input.action === "rectify" && preview.blocked);
        await tx.query(
          "INSERT INTO interaction_privacy_subjects(entity,entity_id,blocked,erased,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(entity,entity_id) DO UPDATE SET blocked=EXCLUDED.blocked,erased=EXCLUDED.erased,updated_at=EXCLUDED.updated_at",
          [
            state.source.entity,
            state.source.id,
            blocked,
            input.action === "erase",
            deps.clock.now(),
          ],
        );
        if (destructive) {
          await tx.query(
            "UPDATE publication_outbox SET payload='{}'::jsonb,privacy_blocked=true,privacy_retired=true,state=CASE WHEN state='PENDING' THEN 'DEAD' ELSE state END,last_error=NULL WHERE id=ANY($1::uuid[])",
            [preview.outbox_ids],
          );
          await tx.query(
            "UPDATE integration_delivery SET payload='{}'::jsonb,privacy_blocked=true,privacy_retired=true,status=CASE WHEN status='SUCCEEDED' THEN status ELSE 'CANCELLED' END,next_attempt_at=NULL,external_id=NULL,last_error_code=NULL WHERE id=ANY($1::uuid[])",
            [preview.delivery_ids],
          );
          await tx.query(
            "UPDATE integration_delivery_attempt SET error_summary=NULL WHERE delivery_id=ANY($1::uuid[])",
            [preview.delivery_ids],
          );
        } else {
          await tx.query(
            "UPDATE publication_outbox SET privacy_blocked=$2 WHERE id=ANY($1::uuid[]) AND NOT privacy_retired",
            [preview.outbox_ids, blocked],
          );
          await tx.query(
            "UPDATE integration_delivery SET privacy_blocked=$2 WHERE id=ANY($1::uuid[]) AND NOT privacy_retired",
            [preview.delivery_ids, blocked],
          );
        }
        if (writeCorrection) await writeCorrection();
        if (input.action === "erase") {
          await tx.query("DELETE FROM forms_leads WHERE id=ANY($1::uuid[])", [preview.lead_ids]);
          await tx.query(
            "DELETE FROM " +
              (state.source.entity === "submission" ? "forms_submissions" : "forms_quiz_runs") +
              " WHERE id=$1",
            [state.source.id],
          );
        }
        const localState =
          input.action === "rectify"
            ? "rectified"
            : input.action === "erase"
              ? "erased"
              : blocked
                ? "blocked"
                : "unblocked";
        await tx.query(
          "INSERT INTO interaction_privacy_cases(id,target_entity,target_id,source_entity,source_id,action,local_state,actor_type,actor_id,request_ref,created_at,operation_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [
            input.request_id,
            input.target.entity,
            input.target.id,
            state.source.entity,
            state.source.id,
            input.action,
            localState,
            input.actor.type,
            input.actor.id,
            input.request_ref ?? null,
            deps.clock.now(),
            fingerprint,
          ],
        );
        for (const copy of preview.external_copies)
          await tx.query(
            "INSERT INTO interaction_privacy_followups(case_id,delivery_id,instance_id,external_id) VALUES($1,$2,$3,$4)",
            [input.request_id, copy.delivery_id, copy.instance_id, copy.external_id],
          );
        return get(input.request_id, tx);
      });
    },
    get,
    async acknowledge(caseId, deliveryId, input) {
      actor(input.actor);
      reference(input.evidence_ref);
      if (
        !uuid(caseId) ||
        !uuid(deliveryId) ||
        !["acknowledged", "owner_exception"].includes(input.decision)
      )
        fail("PRIVACY_ACK_INVALID", "invalid followup decision");
      return pool.withTransaction(async (tx) => {
        const current = (
          await tx.query(
            "SELECT * FROM interaction_privacy_followups WHERE case_id=$1 AND delivery_id=$2 FOR UPDATE",
            [caseId, deliveryId],
          )
        ).rows[0];
        if (!current) fail("PRIVACY_FOLLOWUP_NOT_FOUND", "followup not found");
        if (current.state !== "pending") {
          if (
            current.state !== input.decision ||
            current.evidence_ref !== (input.evidence_ref ?? null) ||
            current.resolved_by !== input.actor.id ||
            current.resolved_actor_type !== input.actor.type
          )
            fail("PRIVACY_FOLLOWUP_CONFLICT", "an acknowledged followup is immutable");
          return get(caseId, tx);
        }
        await tx.query(
          "UPDATE interaction_privacy_followups SET state=$3,evidence_ref=$4,resolved_by=$5,resolved_at=$6,resolved_actor_type=$7,external_id=NULL WHERE case_id=$1 AND delivery_id=$2",
          [
            caseId,
            deliveryId,
            input.decision,
            input.evidence_ref ?? null,
            input.actor.id,
            deps.clock.now(),
            input.actor.type,
          ],
        );
        return get(caseId, tx);
      });
    },
  };
}
