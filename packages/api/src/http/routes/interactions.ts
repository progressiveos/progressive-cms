// Privileged interaction history + export REST operations (PCMS-FORM-T021;
// Forms spec §29/§32/§36). Every operation is permission-gated (interactions.*,
// leads.*) and list endpoints are bounded with keyset cursors. Export is
// audited through the forms audit port (security-event stream); the exported
// PII lives only in the response body, never in logs or events.
import type { ApplicationServices } from "../../context.js";
import { leadDeliveryProjection, submissionDeliveryProjection } from "../../lead-deliveries.js";
import { decodeCursor, pageOf, parsePageRequest } from "../pagination.js";
import type { ApiRoute } from "../registry.js";
import { optionalString } from "./helpers.js";
import { makeInteractionPrivacyRoutes } from "./interaction-privacy.js";

const STABLE_ID = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

function idParamSchema(param: string): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: { [param]: { type: "string", pattern: STABLE_ID } },
    required: [param],
  };
}

function listQuerySchema(statusEnum?: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "string", pattern: "^[0-9]+$" },
      cursor: { type: "string", maxLength: 128 },
      form_definition_id: { type: "string", pattern: STABLE_ID },
      quiz_definition_id: { type: "string", pattern: STABLE_ID },
      ...(statusEnum === undefined ? {} : { status: { type: "string", enum: statusEnum } }),
    },
  };
}

/** Decodes the (timestamp, id) keyset cursor into a repo `before` pair. Shared with the MCP surface. */
export function decodeInteractionCursor(
  cursor: string | null,
): { at: string; id: string } | undefined {
  if (cursor === null) return undefined;
  const parts = decodeCursor(cursor, 2);
  return { at: String(parts[0]), id: String(parts[1]) };
}

const EXPORT_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    entity: { type: "string", enum: ["submissions", "quiz_runs", "leads"] },
    format: { type: "string", enum: ["csv", "json"] },
    form_definition_id: { type: "string", pattern: STABLE_ID },
    quiz_definition_id: { type: "string", pattern: STABLE_ID },
    status: { type: "string", maxLength: 32 },
    created_after: { type: "string", maxLength: 32 },
    limit: { type: "integer", minimum: 1, maximum: 10_000 },
  },
  required: ["entity", "format"],
} as const;

export function makeInteractionsRoutes(): ApiRoute[] {
  return [
    ...makeInteractionPrivacyRoutes(),
    {
      spec: {
        method: "GET",
        url: "/interactions/submissions",
        operationId: "list_submissions",
        summary: "Bounded, cursor-paginated form submission history (interactions.read)",
        tag: "interactions",
        auth: "authenticated",
        permission: "interactions.read",
        querySchema: listQuerySchema(["ACCEPTED", "SPAM", "ARCHIVED"]),
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "interactions.read");
        const query = request.query as Record<string, unknown>;
        const page = parsePageRequest(query);
        const formFilter = optionalString(query.form_definition_id);
        const statusFilter = optionalString(query.status);
        const before = decodeInteractionCursor(page.cursor);
        const rows = await app.formsSource.domain.submissions.listSubmissions({
          ...(formFilter === undefined ? {} : { form_definition_id: formFilter }),
          ...(statusFilter === undefined
            ? {}
            : { status: statusFilter as "ACCEPTED" | "SPAM" | "ARCHIVED" }),
          ...(before === undefined ? {} : { before: { submitted_at: before.at, id: before.id } }),
          limit: page.limit + 1,
        });
        const titles = await app.formsSource.definitionTitles({
          kind: "form",
          ids: rows.map((row) => row.form_definition_id),
        });
        return {
          status: 200,
          body: pageOf(
            rows.map((row) => ({
              ...row,
              definition_title: titles[row.form_definition_id] ?? null,
            })),
            page.limit,
            (row) => [row.submitted_at, row.id],
          ),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/interactions/submissions/:submissionId",
        operationId: "get_submission",
        summary: "One form submission: payload, consent snapshot, bounded spam metadata",
        tag: "interactions",
        auth: "authenticated",
        permission: "interactions.read",
        paramsSchema: idParamSchema("submissionId"),
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "interactions.read");
        const params = request.params as { submissionId: string };
        const detail = await app.formsSource.adminSubmissionDetail(params.submissionId);
        // READ projection (owner task §63): downstream deliveries correlated
        // exactly via the transactional outbox aggregates.
        const deliveries = await submissionDeliveryProjection(app.pool, params.submissionId);
        return { status: 200, body: { ...detail, deliveries } };
      },
    },
    {
      spec: {
        method: "PATCH",
        url: "/interactions/submissions/:submissionId",
        operationId: "update_submission_status",
        summary: "Moderate a submission: ACCEPTED/SPAM/ARCHIVED (interactions.manage)",
        tag: "interactions",
        auth: "authenticated",
        permission: "interactions.manage",
        csrf: true,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          properties: { status: { type: "string", enum: ["ACCEPTED", "SPAM", "ARCHIVED"] } },
          required: ["status"],
        },
        paramsSchema: idParamSchema("submissionId"),
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "interactions.manage");
        const params = request.params as { submissionId: string };
        const body = (request.body ?? {}) as { status: "ACCEPTED" | "SPAM" | "ARCHIVED" };
        return {
          status: 200,
          body: await app.formsSource.setSubmissionStatus({
            submission_id: params.submissionId,
            status: body.status,
          }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/interactions/quiz-runs",
        operationId: "list_quiz_runs",
        summary: "Bounded quiz run history with server-computed results (interactions.read)",
        tag: "interactions",
        auth: "authenticated",
        permission: "interactions.read",
        querySchema: listQuerySchema(["STARTED", "COMPLETED", "ABANDONED", "EXPIRED"]),
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "interactions.read");
        const query = request.query as Record<string, unknown>;
        const page = parsePageRequest(query);
        const quizFilter = optionalString(query.quiz_definition_id);
        const stateFilter = optionalString(query.status);
        const before = decodeInteractionCursor(page.cursor);
        const rows = await app.formsSource.domain.runs.listRuns({
          ...(quizFilter === undefined ? {} : { quiz_definition_id: quizFilter }),
          ...(stateFilter === undefined
            ? {}
            : { state: stateFilter as "STARTED" | "COMPLETED" | "ABANDONED" | "EXPIRED" }),
          ...(before === undefined ? {} : { before: { started_at: before.at, id: before.id } }),
          limit: page.limit + 1,
        });
        const titles = await app.formsSource.definitionTitles({
          kind: "quiz",
          ids: rows.map((row) => row.quiz_definition_id),
        });
        return {
          status: 200,
          body: pageOf(
            rows.map((row) => ({ ...row, quiz_title: titles[row.quiz_definition_id] ?? null })),
            page.limit,
            (row) => [row.started_at, row.id],
          ),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/interactions/quiz-runs/:runId",
        operationId: "get_quiz_run",
        summary: "One quiz run: lifecycle, score/outcome, all recorded answers",
        tag: "interactions",
        auth: "authenticated",
        permission: "interactions.read",
        paramsSchema: idParamSchema("runId"),
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "interactions.read");
        const params = request.params as { runId: string };
        const run = await app.formsSource.domain.runs.getRun(params.runId);
        const detail = await app.formsSource.adminQuizRunDetail(params.runId);
        return {
          status: 200,
          body: {
            ...run,
            quiz_title: detail.quiz_title,
            outcome_title: detail.outcome_title,
            lead_id: detail.lead_id,
            answers: detail.answers,
          },
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/interactions/leads",
        operationId: "list_leads",
        summary: "Bounded lead list (PII; leads.read)",
        tag: "interactions",
        auth: "authenticated",
        permission: "leads.read",
        querySchema: listQuerySchema(["NEW", "VIEWED", "PROCESSED", "ARCHIVED", "SPAM"]),
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "leads.read");
        const query = request.query as Record<string, unknown>;
        const page = parsePageRequest(query);
        const statusFilter = optionalString(query.status);
        const before = decodeInteractionCursor(page.cursor);
        const rows = await app.formsSource.domain.leads.listLeads({
          ...(statusFilter === undefined ? {} : { status: statusFilter as never }),
          ...(before === undefined ? {} : { before: { created_at: before.at, id: before.id } }),
          limit: page.limit + 1,
        });
        return {
          status: 200,
          body: pageOf(rows, page.limit, (row) => [row.created_at, row.id]),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/interactions/leads/:leadId",
        operationId: "get_lead",
        summary: "One lead with source provenance (PII; leads.read)",
        tag: "interactions",
        auth: "authenticated",
        permission: "leads.read",
        paramsSchema: idParamSchema("leadId"),
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "leads.read");
        const params = request.params as { leadId: string };
        const lead = await app.formsSource.domain.leads.getLead(params.leadId);
        // READ projection over existing IntegrationDelivery records (owner
        // task §62): where this enquiry has already been delivered.
        const deliveries = await leadDeliveryProjection(app.pool, params.leadId);
        return { status: 200, body: { ...lead, deliveries } };
      },
    },
    {
      spec: {
        method: "PATCH",
        url: "/interactions/leads/:leadId",
        operationId: "update_lead_status",
        summary: "Lead lifecycle transition; emits LeadStatusChanged atomically (leads.manage)",
        tag: "interactions",
        auth: "authenticated",
        permission: "leads.manage",
        csrf: true,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["NEW", "VIEWED", "PROCESSED", "ARCHIVED", "SPAM"] },
          },
          required: ["status"],
        },
        paramsSchema: idParamSchema("leadId"),
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "leads.manage");
        const params = request.params as { leadId: string };
        const body = (request.body ?? {}) as {
          status: "NEW" | "VIEWED" | "PROCESSED" | "ARCHIVED" | "SPAM";
        };
        return {
          status: 200,
          body: await app.formsSource.setLeadStatus({
            lead_id: params.leadId,
            status: body.status,
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/interactions/export",
        operationId: "export_interactions",
        summary: "Permission-gated, audited CSV/JSON export of submissions/quiz-runs/leads (§29)",
        tag: "interactions",
        auth: "authenticated",
        permission: "interactions.export",
        idempotency: "supported",
        bodyLimit: 8192,
        bodySchema: EXPORT_BODY_SCHEMA,
      },
      async handle(app, ctx, request) {
        // Entity-specific authorization: leads are a separate PII boundary.
        const body = (request.body ?? {}) as {
          entity: "submissions" | "quiz_runs" | "leads";
          format: "csv" | "json";
        };
        app.authorize(ctx.actor, body.entity === "leads" ? "leads.export" : "interactions.export");
        const result = await app.formsSource.export.export(
          {
            ...body,
            ...(typeof (request.body as Record<string, unknown>).form_definition_id === "string"
              ? { form_definition_id: (request.body as Record<string, string>).form_definition_id }
              : {}),
            ...(typeof (request.body as Record<string, unknown>).quiz_definition_id === "string"
              ? { quiz_definition_id: (request.body as Record<string, string>).quiz_definition_id }
              : {}),
            ...(typeof (request.body as Record<string, unknown>).status === "string"
              ? { status: (request.body as Record<string, string>).status }
              : {}),
            ...(typeof (request.body as Record<string, unknown>).created_after === "string"
              ? { created_after: (request.body as Record<string, string>).created_after }
              : {}),
            ...(typeof (request.body as Record<string, unknown>).limit === "number"
              ? { limit: (request.body as Record<string, number>).limit }
              : {}),
          },
          { actor_type: ctx.actor.type, actor_id: ctx.actor.id },
        );
        return {
          status: 200,
          headers: {
            "content-type":
              result.format === "csv"
                ? "text/csv; charset=utf-8"
                : "application/json; charset=utf-8",
            "x-pcms-export-rows": String(result.rows),
            "content-disposition": `attachment; filename="pcms-${result.entity}.${result.format}"`,
          },
          body: result.content,
        };
      },
    },
  ];
}
