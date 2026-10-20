// Progressive HQ connector (owner integration task): pushes newly created
// CMS leads into a Progressive HQ inbound intake endpoint. The HQ contract
// (discovered from the HQ codebase, NOT invented): POST
// {base_url}/api/v1/integrations/inbound/{slug} with HMAC-SHA256 request
// signing (X-Phq-Timestamp / X-Phq-Signature over "{ts}.{event_id}.{body}")
// and idempotent replay via X-Phq-Event-Id. Direction v1 is CMS → HQ only;
// the trigger is the persisted LeadCreated event through a normal binding —
// no Forms special case, no direct HQ database access.
//
// PII discipline: the binding mapping carries only routing-safe event
// fields (lead_id, source ids); the lead's contact fields are fetched by
// the dispatcher's execution projection at delivery time and live only in
// the action context — never in the delivery payload, attempts or logs.
import { createHmac } from "node:crypto";
import type { ConnectorDefinition } from "./connectors.js";
import {
  type ActionExecutionContext,
  type ActionResult,
  actionFailed,
  actionSucceeded,
  type ConnectorRuntime,
} from "./runtime.js";
import { networkFailure, type OutboundHttp, type OutboundHttpResponse } from "./transport.js";

export const HQ_INTAKE_EVENT_TYPE = "intake.received";

/** Fields the intake action needs from the execution projection. */
export const HQ_LEAD_PROJECTION_FIELDS = [
  "presentation",
  "attribution",
  "name",
  "email",
  "phone",
  "summary",
  "classification",
  "source_type",
  "source_id",
  "created_at",
] as const;

/** X-Phq-Event-Id pattern on the HQ side: ^[A-Za-z0-9._:-]{1,255}$. */
export function hqEventId(sourceSite: string, leadId: string): string {
  const site = sourceSite.replace(/[^A-Za-z0-9._-]/g, "-");
  return site === "" ? `pcms:${leadId}` : `pcms:${site}:${leadId}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function hqIntakeEnvelope(input: {
  readonly leadId: string;
  readonly sourceSite: string;
  readonly projection: Readonly<Record<string, unknown>>;
  /** MKT-010: send data.attribution (the lead's frozen snapshot; null when
   * the lead predates capture). Keep false until the HQ intake schema accepts
   * the optional field — the current HQ rejects unknown keys (extra=forbid).
   * Flipping it changes outbound bytes: enable only with an empty retry
   * queue, after HQ ships support. */
  readonly includeAttribution?: boolean;
}): Record<string, unknown> {
  const { leadId, projection } = input;
  const site = text(input.sourceSite);
  const name = text(projection["name"]);
  const email = text(projection["email"]);
  const phone = text(projection["phone"]);
  const summary = text(projection["summary"]);
  const classification = text(projection["classification"]);
  const sourceType = text(projection["source_type"]);
  const sourceId = text(projection["source_id"]);
  const createdAt = text(projection["created_at"]);
  // HQ requires initial_message (1..100000); leads without a summary fall
  // back to a deterministic, stable description so retries stay byte-equal
  // (same event id + same payload → HQ replays instead of duplicating).
  // The readable representation (fixed answers of the originating
  // submission/run) is the message a HQ manager sees; summary is the legacy
  // fallback. Both are deterministic, so retries stay byte-equal.
  const initialMessage =
    text(projection["presentation"]) !== ""
      ? text(projection["presentation"])
      : summary !== ""
        ? summary
        : `${sourceType || "lead"} ${sourceId || leadId}`;
  const acquisitionSource = (site === "" ? "Progressive CMS" : `Progressive CMS / ${site}`).slice(
    0,
    80,
  );
  const attribution =
    input.includeAttribution === true ? (projection["attribution"] ?? null) : undefined;
  return {
    schema_version: 1,
    event_type: HQ_INTAKE_EVENT_TYPE,
    // Stable timestamps only — a retry recomputing Date.now() would change
    // the payload hash and trip HQ's same-id/different-payload 409.
    occurred_at: createdAt === "" ? null : createdAt,
    data: {
      organization_name: null,
      person_name: name === "" ? null : name,
      email: email === "" ? null : email,
      phone: phone === "" ? null : phone,
      initial_message: initialMessage,
      detected_need: classification === "" ? null : classification,
      acquisition_source: acquisitionSource,
      source_reference: leadId,
      ...(attribution === undefined ? {} : { attribution }),
    },
  };
}

function hqSignature(secret: string, timestamp: number, eventId: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${eventId}.${body}`).digest("hex");
}

interface HqInboundResponse {
  readonly status?: string;
  readonly replayed?: boolean;
  readonly result?: { readonly intake_record_id?: string };
  readonly detail?: unknown;
}

function detailSlice(detail: unknown): string {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail ?? null);
  return (text ?? "null").slice(0, 200);
}

export const progressiveHqConnectorDefinition: ConnectorDefinition = {
  connectorType: "progressive-hq",
  title: "Progressive HQ",
  description:
    "Delivers new CMS leads to a Progressive HQ inbound intake endpoint (HMAC-signed, idempotent)",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      base_url: { type: "string", format: "uri", maxLength: 255 },
      slug: { type: "string", format: "identifier", minLength: 3, maxLength: 120 },
      source_site: { type: "string", maxLength: 80 },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 60000 },
      send_attribution: { type: "boolean", default: false },
    },
    required: ["base_url", "slug"],
  },
  secrets: [
    { name: "signing_secret", description: "Progressive HQ inbound endpoint webhook secret" },
  ],
  actions: [
    {
      actionType: "intake_lead",
      description: "Push the lead into the HQ intake (creates a HQ intake record)",
      payloadSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          lead_id: { type: "string", maxLength: 64 },
          source_type: { type: "string", maxLength: 40 },
          source_id: { type: "string", maxLength: 64 },
          classification: { type: "string", maxLength: 120 },
          created_at: { type: "string", maxLength: 64 },
        },
        required: ["lead_id"],
      },
      executionProjection: {
        aggregate: "lead",
        idFromPayload: "lead_id",
        fields: [...HQ_LEAD_PROJECTION_FIELDS],
      },
    },
  ],
  testable: true,
};

export function createProgressiveHqConnectorRuntime(http: OutboundHttp): ConnectorRuntime {
  async function execute(
    actionType: string,
    payload: Readonly<Record<string, unknown>>,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult> {
    if (actionType !== "intake_lead") {
      return actionFailed({
        retryable: false,
        providerErrorCode: "INTEGRATION_ACTION_UNKNOWN",
        errorMessage: `unknown progressive-hq action "${actionType}"`,
      });
    }
    const secret = ctx.secrets["signing_secret"];
    if (secret === undefined || secret === "") {
      return actionFailed({
        retryable: false,
        providerErrorCode: "HQ_NO_SIGNING_SECRET",
        errorMessage: "the signing secret is not configured for this connection",
      });
    }
    const baseUrl = text(ctx.instance.config["base_url"]).replace(/\/+$/, "");
    const slug = text(ctx.instance.config["slug"]);
    if (baseUrl === "" || slug === "") {
      return actionFailed({
        retryable: false,
        providerErrorCode: "HQ_CONFIG_INVALID",
        errorMessage: "base_url and slug are required in the connection config",
      });
    }
    const leadId = text(payload["lead_id"]);
    if (leadId === "") {
      return actionFailed({
        retryable: false,
        providerErrorCode: "HQ_PAYLOAD_INVALID",
        errorMessage: "mapped payload lacks lead_id",
      });
    }
    const sourceSite = text(ctx.instance.config["source_site"]);
    const timeoutMs =
      typeof ctx.instance.config["timeout_ms"] === "number"
        ? (ctx.instance.config["timeout_ms"] as number)
        : 15_000;
    const eventId = hqEventId(sourceSite, leadId);
    const projection = ctx.projection ?? {};
    // Contact format check BEFORE sending (owner refinement §4): HQ would
    // reject a malformed email with 422 and a malformed phone/length with
    // 422 — surfacing that as a typed permanent failure here keeps the
    // delivery history explicit instead of silently dropping the value.
    const email = text(projection["email"]);
    if (email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return actionFailed({
        retryable: false,
        providerErrorCode: "HQ_CONTACT_FORMAT_INVALID",
        errorMessage: `projected email does not look like an address: "${email.slice(0, 64)}"`,
      });
    }
    const phone = text(projection["phone"]);
    if (phone !== "" && !/^[+0-9()\-\s]{5,40}$/.test(phone)) {
      return actionFailed({
        retryable: false,
        providerErrorCode: "HQ_CONTACT_FORMAT_INVALID",
        errorMessage: `projected phone does not look like a number: "${phone.slice(0, 64)}"`,
      });
    }
    // Body format pinned per delivery (MKT-010 review): revision 1 = legacy
    // envelope, 2 = with data.attribution. Old deliveries keep replaying the
    // original bytes even after the connection flag flips.
    const envelope = hqIntakeEnvelope({
      leadId,
      sourceSite,
      projection,
      includeAttribution: ctx.bodyRevision === 2,
    });
    const body = JSON.stringify(envelope);
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      const response = await http({
        method: "POST",
        // The URL is never logged (transport contract), the secret only ever
        // feeds the HMAC — neither enters errors or delivery history.
        url: `${baseUrl}/api/v1/integrations/inbound/${encodeURIComponent(slug)}`,
        headers: {
          "content-type": "application/json",
          "x-phq-event-id": eventId,
          "x-phq-timestamp": String(timestamp),
          "x-phq-signature": `sha256=${hqSignature(secret, timestamp, eventId, body)}`,
        },
        body,
        timeoutMs,
      });
      if (response.status === 200 || response.status === 201) {
        // Confirmed delivery requires a JSON OBJECT carrying a non-empty
        // STRING intake_record_id (F2 §5): "null", a bare number, an array
        // or an unparseable body prove nothing about the created IntakeRecord.
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(response.body);
        } catch {
          // fall through → HQ_RESPONSE_INVALID below
        }
        const intakeId =
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as HqInboundResponse).result?.intake_record_id
            : undefined;
        if (typeof intakeId !== "string" || intakeId.trim() === "") {
          return actionFailed({
            retryable: false,
            providerErrorCode: "HQ_RESPONSE_INVALID",
            errorMessage: "2xx without result.intake_record_id — delivery not confirmed",
            httpStatus: response.status,
          });
        }
        return actionSucceeded(intakeId);
      }
      const retryable = response.status === 429 || response.status >= 500;
      let detail = `hq http ${response.status}`;
      try {
        detail = detailSlice((JSON.parse(response.body) as HqInboundResponse).detail);
      } catch {
        // keep the status-only summary
      }
      return actionFailed({
        retryable,
        providerErrorCode:
          response.status === 409 ? "HQ_EVENT_CONFLICT" : `HQ_HTTP_${response.status}`,
        errorMessage: detail,
        httpStatus: response.status,
      });
    } catch (error) {
      return networkFailure(error, new URL(baseUrl).host);
    }
  }

  return {
    execute,
    async test(ctx: ActionExecutionContext): Promise<ActionResult> {
      // Step 1 — reachability: the public /about endpoint (cheap, no auth).
      const baseUrl = text(ctx.instance.config["base_url"]).replace(/\/+$/, "");
      if (baseUrl === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "HQ_CONFIG_INVALID",
          errorMessage: "base_url is required in the connection config",
        });
      }
      try {
        const response = await http({
          method: "GET",
          url: `${baseUrl}/api/v1/about`,
          timeoutMs: 10_000,
        });
        if (response.status >= 500) {
          return actionFailed({
            retryable: true,
            providerErrorCode: `HQ_HTTP_${response.status}`,
            errorMessage: `hq http ${response.status}`,
            httpStatus: response.status,
          });
        }
      } catch (error) {
        return networkFailure(error, new URL(baseUrl).host);
      }
      // Step 2 — signed dry-run probe (INT-010-F2 §3): proves slug, active
      // endpoint, timestamp window and the signing secret WITHOUT creating
      // records. The probe body carries a "dry_run" field the HQ intake
      // schema rejects (extra="forbid"), so the current HQ answers 422 AFTER
      // signature verification and persists nothing — that outcome IS the
      // pass. A dry-run-capable HQ (X-Phq-Dry-Run honored) answers 200
      // {"status":"dry_run_ok"} instead. Only reachability is reported when
      // slug or secret are not configured yet.
      const slug = text(ctx.instance.config["slug"]);
      const secret = ctx.secrets["signing_secret"];
      if (slug === "" || secret === undefined || secret === "") return actionSucceeded();
      const sourceSite = text(ctx.instance.config["source_site"]);
      const eventId = hqEventId(sourceSite, "probe");
      const body = JSON.stringify({
        schema_version: 1,
        event_type: HQ_INTAKE_EVENT_TYPE,
        occurred_at: null,
        data: {
          person_name: "PCMS Probe",
          initial_message: "PCMS dry-run probe — not a lead",
        },
        dry_run: true,
      });
      const timestamp = Math.floor(Date.now() / 1000);
      let probe: OutboundHttpResponse;
      try {
        probe = await http({
          method: "POST",
          // URL and secret never enter logs or result metadata (transport contract).
          url: `${baseUrl}/api/v1/integrations/inbound/${encodeURIComponent(slug)}`,
          headers: {
            "content-type": "application/json",
            "x-phq-dry-run": "1",
            "x-phq-event-id": eventId,
            "x-phq-timestamp": String(timestamp),
            "x-phq-signature": `sha256=${hqSignature(secret, timestamp, eventId, body)}`,
          },
          body,
          timeoutMs: 10_000,
        });
      } catch (error) {
        return networkFailure(error, new URL(baseUrl).host);
      }
      const detail = (body_text: string): string => {
        try {
          return detailSlice((JSON.parse(body_text) as HqInboundResponse).detail);
        } catch {
          return "";
        }
      };
      if (probe.status === 422) return actionSucceeded();
      if (probe.status === 200 || probe.status === 201) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(probe.body);
        } catch {
          // fall through to the stored-probe failure below
        }
        const dryRunOk =
          parsed !== null &&
          typeof parsed === "object" &&
          (parsed as HqInboundResponse).status === "dry_run_ok";
        if (dryRunOk) return actionSucceeded();
        return actionFailed({
          retryable: false,
          providerErrorCode: "HQ_PROBE_STORED",
          errorMessage:
            "the endpoint stored the probe as a real event — it is not the strict/dry-run-capable HQ intake; check for a stray 'PCMS Probe' record",
          httpStatus: probe.status,
        });
      }
      if (probe.status === 401) {
        return actionFailed({
          retryable: false,
          providerErrorCode: "HQ_PROBE_AUTH",
          errorMessage: detail(probe.body) || "signature or timestamp rejected by the endpoint",
          httpStatus: 401,
        });
      }
      if (probe.status === 404) {
        return actionFailed({
          retryable: false,
          providerErrorCode: "HQ_ENDPOINT_MISSING",
          errorMessage: "no active inbound endpoint for the configured slug",
          httpStatus: 404,
        });
      }
      return actionFailed({
        retryable: probe.status === 429 || probe.status >= 500,
        providerErrorCode: `HQ_HTTP_${probe.status}`,
        errorMessage: detail(probe.body) || `hq http ${probe.status}`,
        httpStatus: probe.status,
      });
    },
  };
}
