import { createHash } from "node:crypto";
import { recordSecurityEvent, type SecurityEventType } from "@pcms/auth";
import {
  type ExtensionPaymentSubjectResolver,
  type ExtensionPaymentsPort,
  type ExtensionPrincipal,
  type ExtensionSiteContext,
  resolveHandler,
} from "@pcms/extensions/internal";
import type { ApplicationServices } from "./context.js";
import { ApiError } from "./errors.js";

export function extensionPaymentsPort(
  app: ApplicationServices,
  extensionId: string,
  actor: ExtensionPrincipal,
  site: ExtensionSiteContext,
  requestId: string,
): ExtensionPaymentsPort {
  async function resolver(subjectType: string): Promise<ExtensionPaymentSubjectResolver> {
    const enabled = new Set(await app.extensions.lifecycle.enabledIds());
    const owners = app.extensionCatalog
      .list()
      .filter(
        (artifact) =>
          enabled.has(artifact.manifest.id) &&
          artifact.manifest.registrations.providers.some(
            (p) => p.registry === "payment_subject" && p.provider_id === subjectType,
          ),
      );
    const owner = owners.length === 1 ? owners[0] : undefined;
    if (
      owner === undefined ||
      owner.manifest.id !== extensionId ||
      !Object.hasOwn(app.extensions.paymentSubjectGrants, extensionId) ||
      !app.extensions.paymentSubjectGrants[extensionId]?.includes(subjectType) ||
      !owner.manifest.provides.some((p) => p.capability === "payments.create-on-behalf")
    )
      throw new ApiError("AUTH_PERMISSION_DENIED", "payment subject owner is not authorized", {
        status: 403,
      });
    const registrations = owner.manifest.registrations.providers.filter(
      (p) => p.registry === "payment_subject" && p.provider_id === subjectType,
    );
    if (registrations.length !== 1)
      throw new ApiError("AUTH_PERMISSION_DENIED", "ambiguous payment subject owner", {
        status: 403,
      });
    return resolveHandler(
      owner,
      registrations[0]!.handler,
    ) as unknown as ExtensionPaymentSubjectResolver;
  }
  return {
    async create(input) {
      if (
        typeof input.idempotencyKey !== "string" ||
        input.idempotencyKey.length < 8 ||
        input.idempotencyKey.length > 200
      )
        throw new ApiError("PAYMENT_REQUEST_INVALID", "idempotency key must be 8–200 characters", {
          status: 422,
        });
      const resolve = await resolver(input.subjectType);
      await app.payments.ensureComposed();
      const key = createHash("sha256")
        .update(extensionId)
        .update("\0")
        .update(input.idempotencyKey)
        .digest("hex");
      const result = await app.payments.service.createForExtension(
        {
          provider_instance_id: input.providerInstanceId,
          subject_type: input.subjectType,
          subject_id: input.subjectId,
          idempotency_key: key,
          metadata: { extension_id: extensionId },
        },
        async (tx) => {
          const snapshot = await resolve({
            subjectId: input.subjectId,
            proof: input.proof,
            actor,
            site,
            operation: "create",
            tx,
          });
          if (snapshot === null)
            throw new ApiError("AUTH_PERMISSION_DENIED", "payment subject access denied", {
              status: 403,
            });
          if (
            !Number.isSafeInteger(snapshot.amountMinor) ||
            snapshot.amountMinor <= 0 ||
            snapshot.amountMinor > 999999999999
          )
            throw new ApiError("PAYMENT_REQUEST_INVALID", "invalid payment subject snapshot", {
              status: 422,
            });
          await recordSecurityEvent(tx, null, {
            type: "EXTENSION_PAYMENT_CREATE" as SecurityEventType,
            actorType:
              actor.kind === "guest"
                ? "GUEST"
                : actor.kind === "anonymous"
                  ? "SYSTEM"
                  : actor.type === "service_account"
                    ? "SERVICE_ACCOUNT"
                    : "USER",
            actorId: actor.kind === "anonymous" ? null : actor.id,
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            siteKey: site.key,
            transport: "api",
            metadata: { extension_id: extensionId, request_id: requestId },
          });
          return { amount: snapshot.amountMinor / 100, currency: snapshot.currency };
        },
        { type: "extension", id: extensionId },
      );
      return {
        id: result.payment.id,
        status: result.payment.status,
        replayed: result.replayed,
        // T3: the storefront needs the bank's form; a replay returns the same
        // one because it is stored with the payment.
        paymentUrl: result.payment.paymentUrl,
      };
    },
    async get(input) {
      const payment = await app.payments.service.get(input.paymentId);
      if (payment === null) return null;
      if (payment.metadata.extension_id !== extensionId)
        throw new ApiError("AUTH_PERMISSION_DENIED", "payment belongs to another extension", {
          status: 403,
        });
      const resolve = await resolver(payment.subjectType);
      await app.pool.withTransaction(async (tx) => {
        const snapshot = await resolve({
          subjectId: payment.subjectId,
          proof: input.proof,
          actor,
          site,
          operation: "get",
          tx,
        });
        if (snapshot === null)
          throw new ApiError("AUTH_PERMISSION_DENIED", "payment subject access denied", {
            status: 403,
          });
      });
      return { id: payment.id, status: payment.status, paymentUrl: payment.paymentUrl };
    },
  };
}
