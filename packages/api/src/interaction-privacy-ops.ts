import type { ApplicationServices, OperationContext } from "./context.js";
import { ApiError } from "./errors.js";
import type {
  PrivacyAcknowledgement,
  PrivacyApplyInput,
  PrivacyOperation,
} from "./interaction-privacy.js";

async function authorize(app: ApplicationServices, ctx: OperationContext): Promise<void> {
  app.authorize(ctx.actor, "privacy.manage");
  await app.authorization.authorizeSite(ctx.actor, app.defaultSiteKey);
}

function assertKeys(input: unknown, allowed: readonly string[]): void {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  ) {
    throw new ApiError("PRIVACY_OPERATION_INVALID", "unknown operation fields or invalid object", {
      status: 422,
    });
  }
}

export async function previewInteractionPrivacy(
  app: ApplicationServices,
  ctx: OperationContext,
  input: PrivacyOperation,
) {
  await authorize(app, ctx);
  assertKeys(input, ["target", "action", "correction"]);
  return app.interactionPrivacy.preview(input);
}

export async function applyInteractionPrivacy(
  app: ApplicationServices,
  ctx: OperationContext,
  input: Omit<PrivacyApplyInput, "actor">,
) {
  await authorize(app, ctx);
  assertKeys(input, [
    "target",
    "action",
    "correction",
    "request_id",
    "expected_token",
    "request_ref",
  ]);
  return app.interactionPrivacy.apply({
    ...input,
    actor: { type: ctx.actor.type, id: ctx.actor.id },
  });
}

export async function getInteractionPrivacyCase(
  app: ApplicationServices,
  ctx: OperationContext,
  caseId: string,
) {
  await authorize(app, ctx);
  return app.interactionPrivacy.get(caseId);
}

export async function acknowledgeInteractionPrivacy(
  app: ApplicationServices,
  ctx: OperationContext,
  caseId: string,
  deliveryId: string,
  input: Omit<PrivacyAcknowledgement, "actor">,
) {
  await authorize(app, ctx);
  assertKeys(input, ["decision", "evidence_ref"]);
  return app.interactionPrivacy.acknowledge(caseId, deliveryId, {
    ...input,
    actor: { type: ctx.actor.type, id: ctx.actor.id },
  });
}
