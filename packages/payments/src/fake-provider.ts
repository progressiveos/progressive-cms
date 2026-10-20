// Deterministic fake payment provider (PCMS-PAY-T002/T005). In-memory,
// scripted, zero network: the reference adapter for the M13 acceptance
// corpus and the sandbox playground. PCMS-PAY-T010 (a real provider
// adapter) stays deferred until the owner/pilot selects a provider.
import { createHmac, timingSafeEqual } from "node:crypto";
import { PaymentError } from "./errors.js";
import type {
  InboundRequestView,
  NormalizedProviderOutcome,
  ParsedCallback,
  PaymentProvider,
  PaymentProviderCapabilities,
  PaymentSecrets,
  ProviderCreateInput,
  ProviderCreateResult,
} from "./providers.js";

interface FakeRecord {
  readonly externalId: string;
  readonly paymentId: string;
  readonly amount: number;
  readonly currency: string;
  status: NormalizedProviderOutcome;
  refunds: { amount: number; id: string }[];
}

export class FakePaymentProvider implements PaymentProvider {
  readonly providerType = "fake";
  readonly secretRequirements = ["signing"] as const;
  readonly configSchema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties: {},
  };
  private readonly records = new Map<string, FakeRecord>();
  private readonly createCalls: ProviderCreateInput[] = [];
  private refundCounter = 0;

  capabilities(): PaymentProviderCapabilities {
    return { cancel: true, refund: true, providerIdempotency: true, statusSync: true };
  }

  /** Corpus helper: forces a provider-side state for a created payment. */
  settle(externalId: string, status: NormalizedProviderOutcome): void {
    const record = this.records.get(externalId);
    if (record !== undefined) record.status = status;
  }

  createCallsCount(): number {
    return this.createCalls.length;
  }

  async createPayment(
    input: ProviderCreateInput,
    _secrets?: PaymentSecrets,
  ): Promise<ProviderCreateResult> {
    this.createCalls.push(input);
    const externalId = `fake_${input.paymentId}`;
    const existing = this.records.get(externalId);
    if (existing !== undefined) {
      // Provider-side idempotency: same key → same logical payment.
      return { externalId, status: existing.status, providerStatus: existing.status };
    }
    this.records.set(externalId, {
      externalId,
      paymentId: input.paymentId,
      amount: input.amount,
      currency: input.currency,
      status: "PENDING",
      refunds: [],
    });
    return { externalId, status: "PENDING", providerStatus: "PENDING" };
  }

  async getPayment(
    externalId: string,
    _secrets?: PaymentSecrets,
  ): Promise<{ status: NormalizedProviderOutcome; providerStatus?: string } | null> {
    const record = this.records.get(externalId);
    if (record === undefined) return null;
    return { status: record.status, providerStatus: record.status };
  }

  async cancelPayment(externalId: string, _secrets?: PaymentSecrets): Promise<void> {
    const record = this.records.get(externalId);
    if (record === undefined) {
      throw new PaymentError("PAYMENT_NOT_FOUND", `fake payment ${externalId} not found`);
    }
    if (record.status === "PENDING") record.status = "FAILED";
  }

  async refundPayment(
    externalId: string,
    amount: number,
    _currency?: string,
    _secrets?: PaymentSecrets,
  ): Promise<{ providerRefundId?: string }> {
    const record = this.records.get(externalId);
    if (record === undefined) {
      throw new PaymentError("PAYMENT_NOT_FOUND", `fake payment ${externalId} not found`);
    }
    this.refundCounter += 1;
    const refund = { amount, id: `fake_refund_${this.refundCounter}` };
    record.refunds.push(refund);
    return { providerRefundId: refund.id };
  }

  verifyCallback(request: InboundRequestView, secrets: PaymentSecrets): void {
    const provided = request.headers["x-fake-signature"];
    const secret = secrets.values["signing"];
    const expected =
      secret === undefined
        ? ""
        : createHmac("sha256", secret).update(request.rawBody).digest("hex");
    if (
      provided === undefined ||
      provided === "" ||
      provided.length !== expected.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
    ) {
      throw new PaymentError("PAYMENT_INBOUND_INVALID", "callback signature mismatch");
    }
  }

  parseCallback(request: InboundRequestView): ParsedCallback {
    const parsed = JSON.parse(request.rawBody) as {
      event_id?: string;
      external_payment_id?: string;
      idempotency_key?: string;
      outcome?: string;
      amount?: number;
    };
    const outcome = parsed.outcome;
    if (outcome !== "PENDING" && outcome !== "SUCCEEDED" && outcome !== "FAILED") {
      throw new PaymentError("PAYMENT_INBOUND_INVALID", `unknown outcome "${String(outcome)}"`);
    }
    return {
      providerEventId: parsed.event_id ?? null,
      externalPaymentId: parsed.external_payment_id ?? null,
      idempotencyKey: parsed.idempotency_key ?? null,
      outcome,
      ...(parsed.amount === undefined ? {} : { amount: parsed.amount }),
    };
  }

  /** Builds a correctly signed callback body for corpus tests. */
  signedCallbackBody(
    payload: {
      event_id: string;
      external_payment_id: string;
      outcome: NormalizedProviderOutcome;
      amount?: number;
    },
    signingSecret: string,
  ): { headers: Record<string, string>; rawBody: string } {
    const rawBody = JSON.stringify(payload);
    return {
      headers: {
        "content-type": "application/json",
        "x-fake-signature": createHmac("sha256", signingSecret).update(rawBody).digest("hex"),
      },
      rawBody,
    };
  }
}
