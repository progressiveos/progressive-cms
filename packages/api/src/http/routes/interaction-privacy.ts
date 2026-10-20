import type {
  PrivacyAcknowledgement,
  PrivacyApplyInput,
  PrivacyOperation,
} from "../../interaction-privacy.js";
import {
  acknowledgeInteractionPrivacy,
  applyInteractionPrivacy,
  getInteractionPrivacyCase,
  previewInteractionPrivacy,
} from "../../interaction-privacy-ops.js";
import type { ApiRoute } from "../registry.js";

const ID = {
  type: "string",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
} as const;
export const PRIVACY_OPERATION_PROPERTIES = {
  target: {
    type: "object",
    additionalProperties: false,
    properties: { entity: { type: "string", enum: ["submission", "quiz_run", "lead"] }, id: ID },
    required: ["entity", "id"],
  },
  action: { type: "string", enum: ["rectify", "block", "unblock", "erase"] },
  correction: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      submission_payload: { type: "object", maxProperties: 256 },
      quiz_answers: {
        type: "array",
        maxItems: 256,
        items: {
          type: "object",
          additionalProperties: false,
          properties: { question_id: { type: "string", maxLength: 128 }, value: {} },
          required: ["question_id", "value"],
        },
      },
    },
  },
} as const;
const ACK_PROPERTIES = {
  decision: { type: "string", enum: ["acknowledged", "owner_exception"] },
  evidence_ref: { type: "string", minLength: 1, maxLength: 300 },
} as const;
function object(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", additionalProperties: false, properties, required };
}
const BASE = { tag: "interactions", auth: "authenticated", permission: "privacy.manage" } as const;

export function makeInteractionPrivacyRoutes(): ApiRoute[] {
  return [
    {
      spec: {
        ...BASE,
        method: "POST",
        url: "/interactions/privacy/preview",
        operationId: "preview_interaction_privacy",
        csrf: true,
        summary: "Preview addressed data operation and controlled/downstream copies; no changes",
        bodySchema: object(PRIVACY_OPERATION_PROPERTIES, ["target", "action"]),
      },
      async handle(app, ctx, request) {
        return {
          status: 200,
          body: await previewInteractionPrivacy(app, ctx, request.body as PrivacyOperation),
        };
      },
    },
    {
      spec: {
        ...BASE,
        method: "POST",
        url: "/interactions/privacy/apply",
        operationId: "apply_interaction_privacy",
        csrf: true,
        summary:
          "Apply an explicit owner-authorized personal-data action using preview token and request ID",
        bodySchema: object(
          {
            ...PRIVACY_OPERATION_PROPERTIES,
            request_id: ID,
            expected_token: { type: "string", minLength: 1, maxLength: 128 },
            request_ref: { type: "string", minLength: 1, maxLength: 300 },
          },
          ["target", "action", "request_id", "expected_token"],
        ),
      },
      async handle(app, ctx, request) {
        return {
          status: 200,
          body: await applyInteractionPrivacy(
            app,
            ctx,
            request.body as Omit<PrivacyApplyInput, "actor">,
          ),
        };
      },
    },
    {
      spec: {
        ...BASE,
        method: "GET",
        url: "/interactions/privacy/cases/:caseId",
        operationId: "get_interaction_privacy_case",
        summary: "Read local action receipt and external-copy followups",
        paramsSchema: object({ caseId: ID }, ["caseId"]),
      },
      async handle(app, ctx, request) {
        return {
          status: 200,
          body: await getInteractionPrivacyCase(
            app,
            ctx,
            (request.params as { caseId: string }).caseId,
          ),
        };
      },
    },
    {
      spec: {
        ...BASE,
        method: "POST",
        url: "/interactions/privacy/cases/:caseId/deliveries/:deliveryId/acknowledge",
        operationId: "acknowledge_interaction_privacy",
        csrf: true,
        summary:
          "Record processor action evidence or explicit owner exception; never pretends to erase remote copies",
        paramsSchema: object({ caseId: ID, deliveryId: ID }, ["caseId", "deliveryId"]),
        bodySchema: object(ACK_PROPERTIES, ["decision"]),
      },
      async handle(app, ctx, request) {
        const { caseId, deliveryId } = request.params as { caseId: string; deliveryId: string };
        return {
          status: 200,
          body: await acknowledgeInteractionPrivacy(
            app,
            ctx,
            caseId,
            deliveryId,
            request.body as Omit<PrivacyAcknowledgement, "actor">,
          ),
        };
      },
    },
  ];
}
