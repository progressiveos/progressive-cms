// Payments REST operations (PCMS-PAY-T008; Payments spec §43). Transport
// only — authorization/audit live in payments-ops.ts. The callback
// receiver is the documented anonymous allowlist entry point; its
// authentication is the provider verifier and its idempotency is the
// InboundEvent dedup + payment state machine.
import type { FastifyRequest } from "fastify";
import type { ApplicationServices, OperationContext } from "../../context.js";
import { ApiError } from "../../errors.js";
import {
  cancelPayment,
  createPayment,
  createProviderInstance,
  deleteProviderInstance,
  getPayment,
  getPaymentProviderCapabilities,
  listPaymentEvents,
  listPaymentInboundEvents,
  listPaymentProviderInstances,
  listPaymentProviders,
  listPaymentRefunds,
  listPayments,
  refundPayment,
  testProviderInstance,
  updateProviderInstance,
} from "../../payments-ops.js";
import type { ApiRoute, RouteResult } from "../registry.js";

function jsonBody(request: FastifyRequest): Record<string, unknown> {
  if (typeof request.body !== "object" || request.body === null) {
    throw new ApiError("API_REQUEST_INVALID", "a JSON object body is required", { status: 400 });
  }
  return request.body as Record<string, unknown>;
}

async function handle(
  app: ApplicationServices,
  ctx: OperationContext,
  fn: (app: ApplicationServices, ctx: OperationContext) => Promise<unknown> | unknown,
): Promise<RouteResult> {
  return { status: 200, body: await fn(app, ctx) };
}

const ID_PARAM = {
  type: "object",
  additionalProperties: false,
  properties: { paymentId: { type: "string", pattern: "^[0-9a-f-]{36}$" } },
  required: ["paymentId"],
} as const;

const CREATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    provider_instance_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
    subject_type: { type: "string", maxLength: 60 },
    subject_id: { type: "string", maxLength: 120 },
    amount: { type: "number", exclusiveMinimum: 0 },
    currency: { type: "string", pattern: "^[A-Z]{3}$" },
    description: { type: "string", maxLength: 500 },
    idempotency_key: { type: "string", minLength: 8, maxLength: 200 },
    metadata: { type: "object" },
  },
  required: [
    "provider_instance_id",
    "subject_type",
    "subject_id",
    "amount",
    "currency",
    "idempotency_key",
  ],
} as const;

export function makePaymentsRoutes(): ApiRoute[] {
  return [
    {
      spec: {
        method: "GET",
        url: "/payments/providers",
        operationId: "list_payment_providers",
        summary: "Registered payment provider types with secret requirements",
        tag: "payments",
        auth: "authenticated",
        permission: "payments.read",
      },
      async handle(app, ctx) {
        return handle(app, ctx, (a, c) => listPaymentProviders(a, c));
      },
    },
    {
      spec: {
        method: "GET",
        url: "/payments/providers/instances",
        operationId: "list_payment_provider_instances",
        summary: "Configured provider instances (secret-ref NAMES only)",
        tag: "payments",
        auth: "authenticated",
        permission: "payments.read",
      },
      async handle(app, ctx) {
        return handle(app, ctx, (a, c) => listPaymentProviderInstances(a, c));
      },
    },
    {
      spec: {
        method: "GET",
        url: "/payments/providers/:providerType/capabilities",
        operationId: "get_payment_provider_capabilities",
        summary: "Provider capability report (cancel/refund/idempotency/sync)",
        tag: "payments",
        auth: "authenticated",
        permission: "payments.read",
        paramsSchema: {
          type: "object",
          additionalProperties: false,
          properties: { providerType: { type: "string", maxLength: 60 } },
          required: ["providerType"],
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { providerType: string };
        return handle(app, ctx, (a, c) =>
          getPaymentProviderCapabilities(a, c, { provider_type: params.providerType }),
        );
      },
    },
    {
      spec: {
        method: "POST",
        url: "/payments",
        operationId: "create_payment",
        summary: "Create a payment (idempotency_key is the retry identity)",
        tag: "payments",
        auth: "authenticated",
        permission: "payments.create",
        csrf: true,
        idempotency: "supported",
        bodySchema: CREATE_SCHEMA,
      },
      async handle(app, ctx, request) {
        return handle(app, ctx, (a, c) => createPayment(a, c, jsonBody(request) as never));
      },
    },
    {
      spec: {
        method: "GET",
        url: "/payments",
        operationId: "list_payments",
        summary: "Payment list with bounded filters (reliability surface)",
        tag: "payments",
        auth: "authenticated",
        permission: "payments.read",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", maxLength: 24 },
            subject_type: { type: "string", maxLength: 60 },
            provider_instance_id: { type: "string", maxLength: 64 },
            external_id: { type: "string", maxLength: 200 },
            search: { type: "string", maxLength: 120 },
            created_from: { type: "string", maxLength: 32 },
            created_to: { type: "string", maxLength: 32 },
            limit: { type: "string", pattern: "^[0-9]+$" },
            offset: { type: "string", pattern: "^[0-9]+$" },
          },
        },
      },
      async handle(app, ctx, request) {
        const query = request.query as Record<string, unknown>;
        const str = (name: string) =>
          typeof query[name] === "string" ? (query[name] as string) : undefined;
        const num = (name: string) =>
          typeof query[name] === "string" ? Number(query[name]) : undefined;
        return handle(app, ctx, (a, c) =>
          listPayments(a, c, {
            ...(str("status") === undefined ? {} : { status: str("status") }),
            ...(str("subject_type") === undefined ? {} : { subject_type: str("subject_type") }),
            ...(str("provider_instance_id") === undefined
              ? {}
              : { provider_instance_id: str("provider_instance_id") }),
            ...(str("external_id") === undefined ? {} : { external_id: str("external_id") }),
            ...(str("search") === undefined ? {} : { search: str("search") }),
            ...(str("created_from") === undefined ? {} : { created_from: str("created_from") }),
            ...(str("created_to") === undefined ? {} : { created_to: str("created_to") }),
            ...(num("limit") === undefined ? {} : { limit: num("limit") }),
            ...(num("offset") === undefined ? {} : { offset: num("offset") }),
          }),
        );
      },
    },
    {
      spec: {
        method: "GET",
        url: "/payments/:paymentId",
        operationId: "get_payment",
        summary: "One payment with normalized/provider status",
        tag: "payments",
        auth: "authenticated",
        permission: "payments.read",
        paramsSchema: ID_PARAM,
      },
      async handle(app, ctx, request) {
        const params = request.params as { paymentId: string };
        return handle(app, ctx, (a, c) => getPayment(a, c, { payment_id: params.paymentId }));
      },
    },
    {
      spec: {
        method: "POST",
        url: "/payments/:paymentId/cancel",
        operationId: "cancel_payment",
        summary: "Cancel a CREATED/PENDING payment",
        tag: "payments",
        auth: "authenticated",
        permission: "payments.cancel",
        csrf: true,
        paramsSchema: ID_PARAM,
      },
      async handle(app, ctx, request) {
        const params = request.params as { paymentId: string };
        return handle(app, ctx, (a, c) => cancelPayment(a, c, { payment_id: params.paymentId }));
      },
    },
    {
      spec: {
        method: "POST",
        url: "/payments/:paymentId/refund",
        operationId: "refund_payment",
        summary: "Privileged refund (partial or full; audited)",
        tag: "payments",
        auth: "authenticated",
        permission: "payments.refund",
        csrf: true,
        paramsSchema: ID_PARAM,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            amount: { type: "number", exclusiveMinimum: 0 },
            reason: { type: "string", maxLength: 300 },
          },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { paymentId: string };
        const body =
          typeof request.body === "object" && request.body !== null
            ? (request.body as Record<string, unknown>)
            : {};
        return handle(app, ctx, (a, c) =>
          refundPayment(a, c, {
            payment_id: params.paymentId,
            ...(body["amount"] === undefined ? {} : { amount: body["amount"] as number }),
            ...(body["reason"] === undefined ? {} : { reason: body["reason"] as string }),
          }),
        );
      },
    },
    {
      spec: {
        method: "GET",
        url: "/payments/:paymentId/events",
        operationId: "list_payment_events",
        summary: "Append-only payment timeline",
        tag: "payments",
        auth: "authenticated",
        permission: "payments.events.read",
        paramsSchema: ID_PARAM,
      },
      async handle(app, ctx, request) {
        const params = request.params as { paymentId: string };
        return handle(app, ctx, (a, c) =>
          listPaymentEvents(a, c, { payment_id: params.paymentId }),
        );
      },
    },
    {
      spec: {
        method: "GET",
        url: "/payments/:paymentId/refunds",
        operationId: "list_payment_refund_intents",
        summary: "Refund intents of one payment (durable state machine, S7).",
        tag: "payments",
        auth: "authenticated",
        permission: "payments.read",
        paramsSchema: {
          type: "object",
          additionalProperties: false,
          required: ["paymentId"],
          properties: { paymentId: { type: "string", pattern: "^[0-9a-f-]{36}$" } },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { paymentId: string };
        return handle(app, ctx, (a, c) =>
          listPaymentRefunds(a, c, { payment_id: params.paymentId }),
        );
      },
    },
    {
      spec: {
        method: "GET",
        url: "/payments/inbound-events",
        operationId: "list_payment_inbound_events",
        summary:
          "Inbound provider callbacks with processing state (S6 diagnostics; raw payloads never returned).",
        tag: "payments",
        auth: "authenticated",
        permission: "payments.events.read",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { enum: ["RECEIVED", "PROCESSED", "FAILED"] },
            limit: { type: "string", pattern: "^[0-9]+$" },
          },
        },
      },
      async handle(app, ctx, request) {
        const query = request.query as Record<string, unknown>;
        return handle(app, ctx, (a, c) =>
          listPaymentInboundEvents(a, c, {
            ...(typeof query["status"] === "string" ? { status: query["status"] } : {}),
            ...(typeof query["limit"] === "string" ? { limit: Number(query["limit"]) } : {}),
          }),
        );
      },
    },
    {
      spec: {
        method: "POST",
        url: "/payments/providers/instances",
        operationId: "create_payment_provider_instance",
        summary: "Configure a provider instance (secret references only — no credential values).",
        tag: "payments",
        auth: "authenticated",
        permission: "payments.configure",
        csrf: true,
        bodySchema: { type: "object", additionalProperties: true, maxProperties: 32 },
      },
      async handle(app, ctx, request) {
        return handle(app, ctx, (a, c) => createProviderInstance(a, c, jsonBody(request) as never));
      },
    },
    {
      spec: {
        method: "PATCH",
        url: "/payments/providers/instances/:instanceId",
        operationId: "update_payment_provider_instance",
        summary:
          "Update name/config/secret refs/enabled. Disabling refuses NEW payments; callbacks for existing payments keep processing.",
        tag: "payments",
        auth: "authenticated",
        permission: "payments.configure",
        csrf: true,
        paramsSchema: {
          type: "object",
          additionalProperties: false,
          required: ["instanceId"],
          properties: { instanceId: { type: "string", maxLength: 64 } },
        },
        bodySchema: { type: "object", additionalProperties: true, maxProperties: 32 },
      },
      async handle(app, ctx, request) {
        const params = request.params as Record<string, unknown>;
        return handle(app, ctx, (a, c) =>
          updateProviderInstance(a, c, {
            instance_id: String(params.instanceId),
            ...(jsonBody(request) as Record<string, never>),
          }),
        );
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/payments/providers/instances/:instanceId",
        operationId: "delete_payment_provider_instance",
        summary:
          "Decommission an instance; refused while payment history references it (disable instead).",
        tag: "payments",
        auth: "authenticated",
        permission: "payments.configure",
        csrf: true,
        paramsSchema: {
          type: "object",
          additionalProperties: false,
          required: ["instanceId"],
          properties: { instanceId: { type: "string", maxLength: 64 } },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as Record<string, unknown>;
        return handle(app, ctx, (a, c) =>
          deleteProviderInstance(a, c, { instance_id: String(params.instanceId) }),
        );
      },
    },
    {
      spec: {
        method: "POST",
        url: "/payments/providers/instances/:instanceId/test",
        operationId: "test_payment_provider_instance",
        summary:
          "Offline configuration check (schema + secret resolvability + composition state); no live provider call.",
        tag: "payments",
        auth: "authenticated",
        permission: "payments.configure",
        csrf: true,
        paramsSchema: {
          type: "object",
          additionalProperties: false,
          required: ["instanceId"],
          properties: { instanceId: { type: "string", maxLength: 64 } },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as Record<string, unknown>;
        return handle(app, ctx, (a, c) =>
          testProviderInstance(a, c, { instance_id: String(params.instanceId) }),
        );
      },
    },
    {
      spec: {
        method: "GET",
        url: "/payments/callback/:providerInstanceId",
        operationId: "receive_payment_callback",
        summary:
          "Provider callback receiver (anonymous allowlist; provider verifier + InboundEvent dedup + state machine)",
        tag: "payments",
        auth: "public",
        bodyLimit: 262144,
      },
      async handle(app, _ctx, request) {
        const params = request.params as { providerInstanceId: string };
        const instance = await app.payments.instances.get(params.providerInstanceId);
        if (instance === null) {
          throw new ApiError("PAYMENT_PROVIDER_INSTANCE_NOT_FOUND", "callback endpoint not found", {
            status: 404,
          });
        }
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === "string") headers[name.toLowerCase()] = value;
        }
        const rawBody =
          typeof request.body === "string"
            ? request.body
            : Buffer.isBuffer(request.body)
              ? (request.body as Buffer).toString("utf8")
              : JSON.stringify(request.body ?? null);
        // Pipeline (spec §34): verify → persist/dedupe → normalize →
        // apply (lock/transition/event/outbox in one tx).
        let outcome: Awaited<ReturnType<typeof app.integrations.inbound.receive>>;
        try {
          outcome = await app.integrations.inbound.receive({
            sourceType: "payment_provider",
            sourceId: instance.id,
            contractKey: `payment_provider:${instance.providerType}`,
            headers,
            rawBody,
          });
        } catch (error) {
          // S6 lifecycle policy: a callback for a provider whose extension is
          // disabled/absent (no registered contract) is RETAINED FAILED —
          // fail-closed for payment state, never lost (S7 recovery replays).
          // Deliberately NOT applied to verification failures: an
          // unauthenticated call is dropped, not retained.
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("no inbound contract registered")) {
            const record = await app.integrations.inbound.receiveOrphan({
              sourceType: "payment_provider",
              sourceId: instance.id,
              rawBody,
              reason: `provider type "${instance.providerType}" is not composed (extension disabled or absent)`,
            });
            return {
              status: 200,
              body: { received: true, retained: true, applied: false, event_id: record.id },
            };
          }
          throw error;
        }
        if (outcome.duplicate) {
          // Duplicate callback: acknowledged, business state untouched.
          return {
            status: 200,
            body: { received: true, duplicate: true, event_id: outcome.record.id },
          };
        }
        if (outcome.record.status === "FAILED" || outcome.normalized === null) {
          return {
            status: 200,
            body: { received: true, duplicate: false, applied: false, event_id: outcome.record.id },
          };
        }
        const parsed = outcome.normalized as {
          providerEventId: string | null;
          externalPaymentId: string | null;
          idempotencyKey: string | null;
          outcome: "PENDING" | "SUCCEEDED" | "FAILED";
          providerStatus?: string;
          amount?: number;
        };
        try {
          const applied = await app.payments.service.processCallback({
            providerInstanceId: instance.id,
            parsed,
            inboundEventId: outcome.record.id,
          });
          await app.integrations.inbound.markProcessed(outcome.record.id);
          return {
            status: 200,
            body: {
              received: true,
              duplicate: false,
              applied: applied.applied,
              event_id: outcome.record.id,
            },
          };
        } catch (error) {
          // Domain-level refusal: keep the inbound record inspectable.
          // Classify the refusal honestly: only an actual unknown-payment
          // 404 is PAYMENT_NOT_FOUND; every other domain refusal (signature,
          // amount mismatch, state machine) is an invalid inbound payload.
          await app.integrations.inbound.markFailed(
            outcome.record.id,
            error instanceof ApiError && error.status === 404
              ? "PAYMENT_NOT_FOUND"
              : "PAYMENT_INBOUND_INVALID",
          );
          throw error;
        }
      },
    },
  ];
}
