// Forms/Quizzes/Leads REST operations (PCMS-FORM-T020; Forms spec §12/§24/
// §36/§37). Public interaction endpoints are anonymous but layered: per-IP
// token bucket + configless same-site origin policy here, honeypot/validation
// bounds inside the forms services, transport body limit on top. Definition
// discovery/management ride the shared permission model. All semantics live
// in the application layer — this file is transport only.
import {
  type AbuseGuard,
  assertOriginAllowed,
  createAbuseGuard,
  FORM_FIELD_TYPE_INFO_V1,
} from "@pcms/forms";
import type { ApplicationServices } from "../../context.js";
import type { ApiRoute } from "../registry.js";

/** Interaction endpoints: modest buckets — a human fills forms slower than
 * this; a script does not (ponytail: per-instance buckets, as search). */
const SUBMIT_GUARD = { capacity: 5, refillPerSecond: 0.2, code: "FORM_RATE_LIMITED" } as const;
const QUIZ_GUARD = { capacity: 30, refillPerSecond: 2, code: "QUIZ_RATE_LIMITED" } as const;
const GUARD_BUCKETS_MAX = 10_000;

function guardOf(app: ApplicationServices, key: "submit" | "quiz"): AbuseGuard {
  // Guards live on the app object (one per process, not per route table).
  const guards = guardsCache.get(app) ?? {};
  if (guards[key] === undefined) {
    guards[key] =
      key === "submit"
        ? createAbuseGuard({ ...SUBMIT_GUARD, maxKeys: GUARD_BUCKETS_MAX }, app.clock)
        : createAbuseGuard({ ...QUIZ_GUARD, maxKeys: GUARD_BUCKETS_MAX }, app.clock);
    guardsCache.set(app, guards);
  }
  return guards[key]!;
}
const guardsCache = new WeakMap<ApplicationServices, Record<string, AbuseGuard | undefined>>();

function clientKey(request: { ip?: string }): string {
  // Transport-resolved peer (trustProxy-aware). Raw X-Forwarded-For is
  // client-controlled: keying on its first hop let any caller rotate fresh
  // abuse buckets at will.
  return typeof request.ip === "string" && request.ip !== "" ? request.ip : "local";
}

function assertPublicOrigin(request: { headers: Record<string, unknown>; ip?: string }): void {
  const origin = request.headers.origin;
  const host = request.headers.host;
  assertOriginAllowed(
    typeof origin === "string" ? origin : undefined,
    typeof host === "string" ? host : undefined,
  );
}

function stableIdParamSchema(param: string): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      [param]: {
        type: "string",
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      },
    },
    required: [param],
  };
}

const SUBMISSION_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    values: { type: "object" },
    submission_token: { type: "string", maxLength: 128 },
    source_entry_id: { type: "string", maxLength: 64 },
    source_url: { type: "string", maxLength: 500 },
    attribution: { type: "object" },
  },
  required: ["values"],
} as const;

const QUIZ_TOKEN_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    resume_token: { type: "string", minLength: 32, maxLength: 128 },
  },
  required: ["resume_token"],
} as const;

const DEFINITION_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: { type: "string", maxLength: 64 },
    title: { type: "string", maxLength: 300 },
    fields: { type: "array" },
    steps: { type: "array" },
    branching_rules: { type: "array" },
    scoring_rules: { type: "array" },
    outcomes: { type: "array" },
    settings: { type: "object" },
  },
} as const;

export function makeFormsRoutes(): ApiRoute[] {
  return [
    // ─── Public interaction endpoints (anonymous; Forms spec §12/§23/§37) ───
    {
      spec: {
        method: "POST",
        url: "/public/forms/:formId/submit",
        operationId: "submit_public_form",
        summary: "Anonymous form submission: validate → persist → outbox, retry-safe (§3/§23)",
        tag: "forms",
        auth: "public",
        bodyLimit: 65536,
        bodySchema: SUBMISSION_BODY_SCHEMA,
        paramsSchema: stableIdParamSchema("formId"),
      },
      async handle(app, _ctx, request) {
        assertPublicOrigin(request);
        guardOf(app, "submit").assertAllowed(clientKey(request));
        const params = request.params as { formId: string };
        const body = (request.body ?? {}) as {
          values?: unknown;
          submission_token?: string;
          source_entry_id?: string;
          source_url?: string;
          attribution?: unknown;
        };
        const result = await app.formsSource.publicForm.submit({
          form_definition_id: params.formId,
          values: body.values,
          ...(body.submission_token === undefined
            ? {}
            : { submission_token: body.submission_token }),
          ...(body.source_entry_id === undefined ? {} : { source_entry_id: body.source_entry_id }),
          ...(body.source_url === undefined ? {} : { source_url: body.source_url }),
          ...(body.attribution === undefined ? {} : { attribution: body.attribution }),
          submitter: {
            ip: clientKey(request) === "local" ? null : clientKey(request),
            user_agent:
              typeof request.headers["user-agent"] === "string"
                ? request.headers["user-agent"]
                : null,
          },
        });
        return { status: 200, body: result };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/public/quizzes/:quizId/start",
        operationId: "start_public_quiz",
        summary: "Start an anonymous server-driven quiz run (§11/§16)",
        tag: "forms",
        auth: "public",
        bodyLimit: 4096,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            source_entry_id: { type: "string", maxLength: 64 },
            attribution: { type: "object" },
          },
        },
        paramsSchema: stableIdParamSchema("quizId"),
      },
      async handle(app, _ctx, request) {
        assertPublicOrigin(request);
        guardOf(app, "quiz").assertAllowed(clientKey(request));
        const params = request.params as { quizId: string };
        const body = (request.body ?? {}) as { source_entry_id?: string; attribution?: unknown };
        const result = await app.formsSource.publicQuiz.start({
          quiz_definition_id: params.quizId,
          ...(body.source_entry_id === undefined ? {} : { source_entry_id: body.source_entry_id }),
          ...(body.attribution === undefined ? {} : { attribution: body.attribution }),
          submitter: {
            ip: clientKey(request) === "local" ? null : clientKey(request),
            user_agent:
              typeof request.headers["user-agent"] === "string"
                ? request.headers["user-agent"]
                : null,
          },
        });
        return { status: 200, body: result };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/public/quizzes/runs/:runId/answer",
        operationId: "answer_public_quiz",
        summary: "Record one server-validated answer; branching decides the next step (§12/§13)",
        tag: "forms",
        auth: "public",
        bodyLimit: 8192,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            resume_token: { type: "string", minLength: 32, maxLength: 128 },
            question_id: { type: "string", maxLength: 64 },
            value: {},
          },
          required: ["resume_token", "question_id"],
        },
        paramsSchema: stableIdParamSchema("runId"),
      },
      async handle(app, _ctx, request) {
        assertPublicOrigin(request);
        guardOf(app, "quiz").assertAllowed(clientKey(request));
        const params = request.params as { runId: string };
        const body = (request.body ?? {}) as {
          resume_token: string;
          question_id: string;
          value?: unknown;
        };
        const result = await app.formsSource.publicQuiz.answer({
          quiz_run_id: params.runId,
          resume_token: body.resume_token,
          question_id: body.question_id,
          value: body.value,
        });
        return { status: 200, body: result };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/public/quizzes/runs/:runId/complete",
        operationId: "complete_public_quiz",
        summary: "Complete a run: server computes score/outcome, may create a lead (§14/§15)",
        tag: "forms",
        auth: "public",
        bodyLimit: 4096,
        bodySchema: QUIZ_TOKEN_BODY_SCHEMA,
        paramsSchema: stableIdParamSchema("runId"),
      },
      async handle(app, _ctx, request) {
        assertPublicOrigin(request);
        guardOf(app, "quiz").assertAllowed(clientKey(request));
        const params = request.params as { runId: string };
        const body = (request.body ?? {}) as { resume_token: string };
        const result = await app.formsSource.publicQuiz.complete({
          quiz_run_id: params.runId,
          resume_token: body.resume_token,
        });
        return { status: 200, body: result };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/public/quizzes/runs/:runId/abandon",
        operationId: "abandon_public_quiz",
        summary: "Explicit client exit: run becomes ABANDONED (§17)",
        tag: "forms",
        auth: "public",
        bodyLimit: 4096,
        bodySchema: QUIZ_TOKEN_BODY_SCHEMA,
        paramsSchema: stableIdParamSchema("runId"),
      },
      async handle(app, _ctx, request) {
        assertPublicOrigin(request);
        guardOf(app, "quiz").assertAllowed(clientKey(request));
        const params = request.params as { runId: string };
        const body = (request.body ?? {}) as { resume_token: string };
        const result = await app.formsSource.publicQuiz.abandon({
          quiz_run_id: params.runId,
          resume_token: body.resume_token,
        });
        return { status: 200, body: result };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/public/quizzes/:quizId/schema",
        operationId: "get_quiz_public_schema",
        summary: "Sanitized public quiz schema for rendering clients (§36)",
        tag: "forms",
        auth: "public",
        paramsSchema: stableIdParamSchema("quizId"),
      },
      async handle(app, _ctx, request) {
        const params = request.params as { quizId: string };
        return {
          status: 200,
          body: await app.formsSource.publicQuiz.getPublicSchema(params.quizId),
        };
      },
    },

    // ─── Definition discovery (Forms spec §34/§36) ───
    {
      spec: {
        method: "GET",
        url: "/forms",
        operationId: "list_forms",
        summary: "List form definitions (current version each)",
        tag: "forms",
        auth: "authenticated",
        permission: "forms.read_definition",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: { status: { type: "string", enum: ["ACTIVE", "ARCHIVED"] } },
        },
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "forms.read_definition");
        const query = request.query as { status?: "ACTIVE" | "ARCHIVED" };
        const items = await app.formsSource.domain.definitions.listDefinitions(
          query.status === undefined ? {} : { status: query.status },
        );
        return { status: 200, body: { items } };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/forms/:formId",
        operationId: "get_form_definition",
        summary: "One form definition (identity + current immutable version)",
        tag: "forms",
        auth: "authenticated",
        permission: "forms.read_definition",
        paramsSchema: stableIdParamSchema("formId"),
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "forms.read_definition");
        const params = request.params as { formId: string };
        return {
          status: 200,
          body: await app.formsSource.domain.definitions.getDefinition(params.formId),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/forms/field-types",
        operationId: "list_form_field_types",
        summary: "Builder-facing field type corpus with supported properties",
        tag: "forms",
        auth: "authenticated",
        permission: "forms.read_definition",
      },
      async handle(app, ctx) {
        app.authorize(ctx.actor, "forms.read_definition");
        return { status: 200, body: { items: FORM_FIELD_TYPE_INFO_V1 } };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/forms/:formId/stats",
        operationId: "get_form_stats",
        summary: "Submission and lead counts for a form definition",
        tag: "forms",
        auth: "authenticated",
        permission: "forms.read_definition",
        paramsSchema: stableIdParamSchema("formId"),
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "forms.read_definition");
        const params = request.params as { formId: string };
        return {
          status: 200,
          body: await app.formsSource.definitionStats({
            kind: "form",
            definition_id: params.formId,
          }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/forms/:formId/usage",
        operationId: "get_form_usage",
        summary: "Entries whose content references the form definition",
        tag: "forms",
        auth: "authenticated",
        permission: "forms.read_definition",
        paramsSchema: stableIdParamSchema("formId"),
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "forms.read_definition");
        const params = request.params as { formId: string };
        return {
          status: 200,
          body: await app.formsSource.findDefinitionUsage({
            kind: "form",
            definition_id: params.formId,
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/forms",
        operationId: "create_form_definition",
        summary: "Create a form definition (version 1; forms.manage_definition)",
        tag: "forms",
        auth: "authenticated",
        permission: "forms.manage_definition",
        idempotency: "supported",
        bodyLimit: 131072,
        bodySchema: DEFINITION_BODY_SCHEMA,
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "forms.manage_definition");
        const body = (request.body ?? {}) as Record<string, unknown>;
        const created = await app.formsSource.domain.definitions.createDefinition({
          key: body.key as string,
          title: body.title as string,
          fields: body.fields,
          ...(body.settings === undefined ? {} : { settings: body.settings }),
        });
        return { status: 201, body: created };
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/forms/:formId",
        operationId: "update_form_definition",
        summary: "Append the next immutable form definition version",
        tag: "forms",
        auth: "authenticated",
        permission: "forms.manage_definition",
        bodyLimit: 131072,
        bodySchema: DEFINITION_BODY_SCHEMA,
        paramsSchema: stableIdParamSchema("formId"),
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "forms.manage_definition");
        const params = request.params as { formId: string };
        const body = (request.body ?? {}) as Record<string, unknown>;
        const updated = await app.formsSource.domain.definitions.addVersion({
          form_definition_id: params.formId,
          ...(body.title === undefined ? {} : { title: body.title as string }),
          fields: body.fields,
          ...(body.settings === undefined ? {} : { settings: body.settings }),
        });
        return { status: 200, body: updated };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/quizzes",
        operationId: "list_quizzes",
        summary: "List quiz definitions (current version each)",
        tag: "forms",
        auth: "authenticated",
        permission: "quizzes.read_definition",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: { status: { type: "string", enum: ["ACTIVE", "ARCHIVED"] } },
        },
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "quizzes.read_definition");
        const query = request.query as { status?: "ACTIVE" | "ARCHIVED" };
        const items = await app.formsSource.domain.quizzes.listDefinitions(
          query.status === undefined ? {} : { status: query.status },
        );
        return { status: 200, body: { items } };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/quizzes/:quizId",
        operationId: "get_quiz_definition",
        summary: "One quiz definition (steps/branching/scoring/outcomes of the current version)",
        tag: "forms",
        auth: "authenticated",
        permission: "quizzes.read_definition",
        paramsSchema: stableIdParamSchema("quizId"),
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "quizzes.read_definition");
        const params = request.params as { quizId: string };
        return {
          status: 200,
          body: await app.formsSource.domain.quizzes.getDefinition(params.quizId),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/quizzes/:quizId/stats",
        operationId: "get_quiz_stats",
        summary: "Run, completion and lead counts for a quiz definition",
        tag: "forms",
        auth: "authenticated",
        permission: "quizzes.read_definition",
        paramsSchema: stableIdParamSchema("quizId"),
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "quizzes.read_definition");
        const params = request.params as { quizId: string };
        return {
          status: 200,
          body: await app.formsSource.definitionStats({
            kind: "quiz",
            definition_id: params.quizId,
          }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/quizzes/:quizId/usage",
        operationId: "get_quiz_usage",
        summary: "Entries whose content references the quiz definition",
        tag: "forms",
        auth: "authenticated",
        permission: "quizzes.read_definition",
        paramsSchema: stableIdParamSchema("quizId"),
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "quizzes.read_definition");
        const params = request.params as { quizId: string };
        return {
          status: 200,
          body: await app.formsSource.findDefinitionUsage({
            kind: "quiz",
            definition_id: params.quizId,
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/quizzes",
        operationId: "create_quiz_definition",
        summary: "Create a quiz definition (version 1; quizzes.manage_definition)",
        tag: "forms",
        auth: "authenticated",
        permission: "quizzes.manage_definition",
        idempotency: "supported",
        bodyLimit: 131072,
        bodySchema: DEFINITION_BODY_SCHEMA,
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "quizzes.manage_definition");
        const body = (request.body ?? {}) as Record<string, unknown>;
        const created = await app.formsSource.domain.quizzes.createDefinition({
          key: body.key as string,
          title: body.title as string,
          steps: body.steps,
          ...(body.branching_rules === undefined ? {} : { branching_rules: body.branching_rules }),
          ...(body.scoring_rules === undefined ? {} : { scoring_rules: body.scoring_rules }),
          ...(body.outcomes === undefined ? {} : { outcomes: body.outcomes }),
          ...(body.settings === undefined ? {} : { settings: body.settings }),
        });
        return { status: 201, body: created };
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/quizzes/:quizId",
        operationId: "update_quiz_definition",
        summary: "Append the next immutable quiz definition version",
        tag: "forms",
        auth: "authenticated",
        permission: "quizzes.manage_definition",
        bodyLimit: 131072,
        bodySchema: DEFINITION_BODY_SCHEMA,
        paramsSchema: stableIdParamSchema("quizId"),
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "quizzes.manage_definition");
        const params = request.params as { quizId: string };
        const body = (request.body ?? {}) as Record<string, unknown>;
        const updated = await app.formsSource.domain.quizzes.addVersion({
          quiz_definition_id: params.quizId,
          ...(body.title === undefined ? {} : { title: body.title as string }),
          steps: body.steps,
          ...(body.branching_rules === undefined ? {} : { branching_rules: body.branching_rules }),
          ...(body.scoring_rules === undefined ? {} : { scoring_rules: body.scoring_rules }),
          ...(body.outcomes === undefined ? {} : { outcomes: body.outcomes }),
          ...(body.settings === undefined ? {} : { settings: body.settings }),
        });
        return { status: 200, body: updated };
      },
    },
  ];
}
