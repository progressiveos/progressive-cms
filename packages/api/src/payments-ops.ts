// Payments application operations (PCMS-PAY-T008; Payments spec §43).
// Every operation authorizes default-deny; refund additionally audits
// (PAYMENT_REFUND) into the M08 security-event stream. REST/MCP/CLI all
// call these functions — no transport-specific domain shortcuts.
import { recordSecurityEvent } from "@pcms/auth";
import type { PaymentStatus } from "@pcms/payments";
import type { ApplicationServices, OperationContext } from "./context.js";
import { auditBase, requirePermission } from "./context.js";
import { ApiError } from "./errors.js";

export async function listPaymentProviders(app: ApplicationServices, ctx: OperationContext) {
  await app.payments.ensureComposed();
  requirePermission(app, ctx, "payments.read");
  return {
    items: app.payments.registry.list().map((provider) => ({
      provider_type: provider.providerType,
      secret_requirements: provider.secretRequirements,
      config_schema: provider.configSchema,
    })),
  };
}

export async function listPaymentProviderInstances(
  app: ApplicationServices,
  ctx: OperationContext,
) {
  requirePermission(app, ctx, "payments.read");
  const instances = await app.payments.instances.list();
  return {
    items: instances.map((instance) => ({
      id: instance.id,
      provider_type: instance.providerType,
      name: instance.name,
      enabled: instance.enabled,
      config: instance.config,
      secret_refs: instance.secretRefs,
      created_at: instance.createdAt.toISOString(),
      updated_at: instance.updatedAt.toISOString(),
    })),
  };
}

export async function getPaymentProviderCapabilities(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly provider_type: string },
) {
  await app.payments.ensureComposed();
  requirePermission(app, ctx, "payments.read");
  const provider = app.payments.registry.get(input.provider_type);
  if (provider === undefined) {
    throw new ApiError(
      "PAYMENT_PROVIDER_UNKNOWN",
      `provider "${input.provider_type}" not registered`,
      {
        status: 404,
      },
    );
  }
  return { provider_type: provider.providerType, capabilities: provider.capabilities() };
}

function paymentView(
  payment: Awaited<ReturnType<ApplicationServices["payments"]["service"]["get"]>>,
) {
  if (payment === null) return null;
  return {
    id: payment.id,
    provider_instance_id: payment.providerInstanceId,
    external_payment_id: payment.externalPaymentId,
    subject_type: payment.subjectType,
    subject_id: payment.subjectId,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    description: payment.description,
    metadata: payment.metadata,
    refunded_amount: payment.refundedAmount,
    created_at: payment.createdAt.toISOString(),
    updated_at: payment.updatedAt.toISOString(),
    paid_at: payment.paidAt === null ? null : payment.paidAt.toISOString(),
    cancelled_at: payment.cancelledAt === null ? null : payment.cancelledAt.toISOString(),
  };
}

export async function createPayment(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly provider_instance_id: string;
    readonly subject_type: string;
    readonly subject_id: string;
    readonly amount: number;
    readonly currency: string;
    readonly description?: string;
    readonly idempotency_key: string;
    readonly metadata?: Record<string, unknown>;
  },
) {
  await app.payments.ensureComposed();
  requirePermission(app, ctx, "payments.create");
  const { payment } = await app.payments.service.create(input, {
    type: ctx.actor.type,
    id: ctx.actor.id,
  });
  return paymentView(payment);
}

export async function getPayment(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly payment_id: string },
) {
  requirePermission(app, ctx, "payments.read");
  const payment = await app.payments.service.get(input.payment_id);
  if (payment === null) {
    throw new ApiError("PAYMENT_NOT_FOUND", "payment not found", { status: 404 });
  }
  return paymentView(payment);
}

export async function listPayments(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly status?: string | undefined;
    readonly subject_type?: string | undefined;
    readonly provider_instance_id?: string | undefined;
    readonly external_id?: string | undefined;
    readonly search?: string | undefined;
    readonly created_from?: string | undefined;
    readonly created_to?: string | undefined;
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  } = {},
) {
  requirePermission(app, ctx, "payments.read");
  const validStatuses: readonly string[] = [
    "CREATED",
    "PENDING",
    "SUCCEEDED",
    "FAILED",
    "CANCELLED",
    "PARTIALLY_REFUNDED",
    "REFUNDED",
  ];
  if (input.status !== undefined && !validStatuses.includes(input.status)) {
    throw new ApiError("PAYMENT_REQUEST_INVALID", `unknown status "${input.status}"`, {
      status: 422,
    });
  }
  const parseDate = (value: string | undefined, name: string): Date | undefined => {
    if (value === undefined) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new ApiError("PAYMENT_REQUEST_INVALID", `${name} is not a valid date`, { status: 422 });
    }
    return parsed;
  };
  const items = await app.payments.service.list({
    ...(input.status === undefined ? {} : { status: input.status as PaymentStatus }),
    ...(input.subject_type === undefined ? {} : { subject_type: input.subject_type }),
    ...(input.provider_instance_id === undefined
      ? {}
      : { provider_instance_id: input.provider_instance_id }),
    ...(input.external_id === undefined ? {} : { external_id: input.external_id }),
    ...(input.search === undefined ? {} : { search: input.search }),
    ...(input.created_from === undefined
      ? {}
      : { created_from: parseDate(input.created_from, "created_from") as Date }),
    ...(input.created_to === undefined
      ? {}
      : { created_to: parseDate(input.created_to, "created_to") as Date }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.offset === undefined ? {} : { offset: input.offset }),
  });
  return { items: items.map((payment) => paymentView(payment)) };
}

type ProviderInstance =
  ReturnType<typeof createPaymentProviderInstanceService> extends {
    create(input: never): Promise<infer T>;
  }
    ? T
    : never;

import type { createPaymentProviderInstanceService } from "@pcms/payments";

function providerInstanceView(instance: ProviderInstance) {
  // REDACTION: secret REFERENCES (names) only — values live in the process
  // secret channel and never enter API responses or the Admin DOM.
  return {
    id: instance.id,
    provider_type: instance.providerType,
    name: instance.name,
    enabled: instance.enabled,
    config: instance.config,
    secret_refs: instance.secretRefs,
  };
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "PAYMENT_PROVIDER_INSTANCE_NOT_FOUND") {
    return new ApiError("PAYMENT_PROVIDER_INSTANCE_NOT_FOUND", String((error as Error).message), {
      status: 404,
    });
  }
  if (code === "PAYMENT_REQUEST_INVALID") {
    return new ApiError("PAYMENT_REQUEST_INVALID", String((error as Error).message), {
      status: 422,
    });
  }
  if (
    code === "PAYMENT_PROVIDER_INSTANCE_IN_USE" ||
    String((error as { constraint?: unknown } | null)?.constraint ?? "").includes(
      "provider_instance",
    )
  ) {
    return new ApiError(
      "PAYMENT_PROVIDER_INSTANCE_IN_USE",
      "instance carries payment history — disable it instead of deleting",
      { status: 409 },
    );
  }
  return new ApiError(
    "PAYMENT_REQUEST_INVALID",
    error instanceof Error ? error.message : String(error),
    {
      status: 500,
    },
  );
}

// ---- S6 Payments Admin: provider instance configuration surface ----------
// `payments.configure` gates every mutation; offline validation only — a
// configuration check NEVER creates a payment or talks money to the provider
// (live provider checks are reported unavailable until a safe probe exists).

export async function createProviderInstance(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly provider_type: string;
    readonly name: string;
    readonly enabled?: boolean;
    readonly config?: Record<string, unknown>;
    readonly secret_refs?: Record<string, string>;
  },
) {
  await app.payments.ensureComposed();
  requirePermission(app, ctx, "payments.configure");
  if (app.payments.registry.get(input.provider_type) === undefined) {
    throw new ApiError(
      "PAYMENT_PROVIDER_UNKNOWN",
      `provider "${input.provider_type}" is not registered (extension installed and enabled?)`,
      { status: 404 },
    );
  }
  const instance = await app.payments.instances.create({
    providerType: input.provider_type,
    name: input.name,
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    config: input.config ?? {},
    ...(input.secret_refs === undefined ? {} : { secretRefs: input.secret_refs }),
  });
  await recordSecurityEvent(app.pool, null, {
    type: "PAYMENT_PROVIDER_INSTANCE_CREATED",
    ...auditBase(ctx),
    subjectType: "payment_provider_instance",
    subjectId: instance.id,
    metadata: { provider_type: instance.providerType, name: instance.name },
  });
  return { instance: providerInstanceView(instance) };
}

export async function updateProviderInstance(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly instance_id: string;
    readonly name?: string;
    readonly enabled?: boolean;
    readonly config?: Record<string, unknown>;
    readonly secret_refs?: Record<string, string>;
  },
) {
  requirePermission(app, ctx, "payments.configure");
  const instance = await app.payments.instances.update(input.instance_id, {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.config === undefined ? {} : { config: input.config }),
    ...(input.secret_refs === undefined ? {} : { secretRefs: input.secret_refs }),
  });
  await recordSecurityEvent(app.pool, null, {
    type: "PAYMENT_PROVIDER_INSTANCE_UPDATED",
    ...auditBase(ctx),
    subjectType: "payment_provider_instance",
    subjectId: instance.id,
    metadata: {
      provider_type: instance.providerType,
      name: instance.name,
      enabled: instance.enabled,
    },
  });
  return { instance: providerInstanceView(instance) };
}

export async function deleteProviderInstance(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly instance_id: string },
) {
  requirePermission(app, ctx, "payments.configure");
  const existing = await app.payments.instances.get(input.instance_id);
  if (existing === null) {
    throw new ApiError(
      "PAYMENT_PROVIDER_INSTANCE_NOT_FOUND",
      `provider instance ${input.instance_id} not found`,
      { status: 404 },
    );
  }
  try {
    await app.payments.instances.delete(input.instance_id);
  } catch (error) {
    // FK from payment: the instance carries payment history — decommission
    // by disabling instead (S6 lifecycle model), never orphan the history.
    throw toApiError(error);
  }
  await recordSecurityEvent(app.pool, null, {
    type: "PAYMENT_PROVIDER_INSTANCE_DELETED",
    ...auditBase(ctx),
    subjectType: "payment_provider_instance",
    subjectId: input.instance_id,
    metadata: { provider_type: existing.providerType, name: existing.name },
  });
  return { deleted: true };
}

export async function testProviderInstance(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly instance_id: string },
) {
  requirePermission(app, ctx, "payments.configure");
  await app.payments.ensureComposed();
  const instance = await app.payments.instances.get(input.instance_id);
  if (instance === null) {
    throw new ApiError(
      "PAYMENT_PROVIDER_INSTANCE_NOT_FOUND",
      `provider instance ${input.instance_id} not found`,
      { status: 404 },
    );
  }
  const provider = app.payments.registry.get(instance.providerType);
  const checks: { readonly check: string; readonly ok: boolean; readonly detail: string }[] = [
    {
      check: "provider_registered",
      ok: provider !== undefined,
      detail:
        provider === undefined
          ? "provider type is not composed (extension disabled or absent)"
          : `provider type ${provider.providerType} composed`,
    },
    {
      check: "instance_enabled",
      ok: instance.enabled,
      detail: instance.enabled
        ? "accepts new payments"
        : "disabled — new payments refused; callbacks for existing payments still processed",
    },
  ];
  // Secret-slot resolution (names only — values never leave the process).
  let secretsOk = true;
  const secretDetails: string[] = [];
  for (const [requirement, refName] of Object.entries(instance.secretRefs)) {
    const resolved = app.payments.secretResolver?.(refName);
    const ok = typeof resolved === "string" && resolved.length > 0;
    secretsOk = secretsOk && ok;
    secretDetails.push(`${requirement} → ${ok ? "resolvable" : "MISSING"} (${refName})`);
  }
  checks.push({
    check: "secret_refs_resolvable",
    ok: secretsOk && Object.keys(instance.secretRefs).length > 0,
    detail:
      Object.keys(instance.secretRefs).length === 0
        ? "no secret references configured"
        : secretDetails.join("; "),
  });
  checks.push({
    check: "live_provider_check",
    ok: false,
    detail:
      "unavailable: a safe diagnostic does not exist for this provider (a live check would create a real payment); configuration validated offline",
  });
  const ok =
    provider !== undefined &&
    instance.enabled &&
    secretsOk &&
    Object.keys(instance.secretRefs).length > 0;
  await recordSecurityEvent(app.pool, null, {
    type: "PAYMENT_PROVIDER_INSTANCE_TESTED",
    ...auditBase(ctx),
    subjectType: "payment_provider_instance",
    subjectId: instance.id,
    metadata: { ok },
  });
  return { ok, checks };
}

export async function listPaymentInboundEvents(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly status?: string; readonly limit?: number } = {},
) {
  requirePermission(app, ctx, "payments.events.read");
  const validStatuses: readonly string[] = ["RECEIVED", "PROCESSED", "FAILED"];
  if (input.status !== undefined && !validStatuses.includes(input.status)) {
    throw new ApiError("PAYMENT_REQUEST_INVALID", `unknown inbound status "${input.status}"`, {
      status: 422,
    });
  }
  const items = await app.integrations.inbound.list({
    sourceType: "payment_provider",
    ...(input.status === undefined
      ? {}
      : { status: input.status as "RECEIVED" | "PROCESSED" | "FAILED" }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  return {
    items: items.map((event) => ({
      id: event.id,
      source_id: event.sourceId,
      provider_event_id: event.providerEventId,
      status: event.status,
      error_code: event.errorCode,
      received_at: event.receivedAt.toISOString(),
      processed_at: event.processedAt?.toISOString() ?? null,
    })),
  };
}

export async function cancelPayment(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly payment_id: string },
) {
  await app.payments.ensureComposed();
  requirePermission(app, ctx, "payments.cancel");
  const payment = await app.payments.service.cancel(input.payment_id, {
    type: ctx.actor.type,
    id: ctx.actor.id,
  });
  return paymentView(payment);
}

export async function refundPayment(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly payment_id: string; readonly amount?: number; readonly reason?: string },
) {
  await app.payments.ensureComposed();
  requirePermission(app, ctx, "payments.refund");
  // S7: the refund returns a DURABLE INTENT — the provider call happens
  // asynchronously in the controlled worker against the intent's stable
  // idempotency key. The API answer is "recorded", not "money moved".
  const { payment, intentId } = await app.payments.service.refund(
    input.payment_id,
    {
      ...(input.amount === undefined ? {} : { amount: input.amount }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    },
    { type: ctx.actor.type, id: ctx.actor.id },
  );
  await recordSecurityEvent(app.pool, null, {
    type: "PAYMENT_REFUND",
    ...auditBase(ctx),
    subjectType: "payment",
    subjectId: input.payment_id,
    metadata: {
      refund_intent_id: intentId,
      requested_amount: input.amount ?? payment.amount - payment.refundedAmount,
      status: payment.status,
    },
  });
  // Drive the external call from the WORKER (S7): the durable intent already
  // guards the money; the job idempotency_key makes duplicated enqueues a
  // no-op and the executor's classification handles crash classes.
  await app.jobs.enqueue({
    type: "payments.refund.execute",
    payload: { intent_id: intentId },
    idempotencyKey: `refund-intent-${intentId}`,
    maxAttempts: 5,
    origin: "payments.admin",
  });
  return { ...paymentView(payment), refund_intent_id: intentId };
}

export async function listPaymentRefunds(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly payment_id: string },
) {
  requirePermission(app, ctx, "payments.read");
  const items = await app.payments.service.listRefundIntents(input.payment_id);
  return { items };
}

export async function listPaymentEvents(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly payment_id: string },
) {
  requirePermission(app, ctx, "payments.events.read");
  const events = await app.payments.service.listEvents(input.payment_id);
  return {
    items: events.map((event) => ({
      id: event.id,
      payment_id: event.paymentId,
      event_type: event.eventType,
      actor_type: event.actorType,
      actor_id: event.actorId,
      source: event.source,
      provider_event_id: event.providerEventId,
      inbound_event_id: event.inboundEventId,
      payload: event.payload,
      created_at: event.createdAt.toISOString(),
    })),
  };
}
