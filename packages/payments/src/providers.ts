import { PaymentError } from "./errors.js";

// PaymentProvider contract + registry (PCMS-PAY-T002; Payments spec §31).
// Provider-specific semantics live in adapters; the Payment domain never
// branches on a concrete provider. A provider registers capabilities and
// the caller gates cancel/refund/sync on them.
export interface PaymentProviderCapabilities {
  readonly cancel: boolean;
  readonly refund: boolean;
  /** Provider honors an idempotency key on create (safe retries). */
  readonly providerIdempotency: boolean;
  /** getPayment status sync is available. */
  readonly statusSync: boolean;
}

/** Provider outcomes normalized onto Payment states (spec §29). */
export type NormalizedProviderOutcome = "PENDING" | "SUCCEEDED" | "FAILED";

export interface PaymentSecrets {
  /** Requirement name → secret value, resolved at call time. */
  readonly values: Readonly<Record<string, string>>;
}

export interface ProviderCreateInput {
  readonly paymentId: string;
  readonly amount: number;
  readonly currency: string;
  readonly description?: string;
  /** CMS-owned stable key for provider-side dedup (spec §33). */
  readonly idempotencyKey: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly callbackUrl?: string;
}

export interface ProviderCreateResult {
  readonly externalId: string;
  readonly status: NormalizedProviderOutcome;
  readonly providerStatus?: string;
}

export interface InboundRequestView {
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
}

export interface ParsedCallback {
  readonly providerEventId: string | null;
  /** Locate the payment by provider id and/or CMS idempotency key. */
  readonly externalPaymentId: string | null;
  readonly idempotencyKey: string | null;
  readonly outcome: NormalizedProviderOutcome;
  readonly providerStatus?: string;
  readonly amount?: number;
  readonly currency?: string;
}

export interface PaymentProvider {
  readonly providerType: string;
  /** Secret requirement names (instance.secret_refs must cover these). */
  readonly secretRequirements: readonly string[];
  readonly configSchema: Record<string, unknown>;
  capabilities(): PaymentProviderCapabilities;
  createPayment(input: ProviderCreateInput, secrets: PaymentSecrets): Promise<ProviderCreateResult>;
  getPayment?(
    externalId: string,
    secrets: PaymentSecrets,
  ): Promise<{ status: NormalizedProviderOutcome; providerStatus?: string } | null>;
  cancelPayment?(externalId: string, secrets: PaymentSecrets): Promise<void>;
  refundPayment?(
    externalId: string,
    amount: number,
    currency: string,
    secrets: PaymentSecrets,
    /** S7: the durable refund intent's stable key — providers that support
     * idempotency (Stripe Idempotency-Key, PayPal PayPal-Request-Id,
     * YooKassa, Alipay out_request_no, T-Bank Idempotency-Key header) reuse
     * it across retries; providers WITHOUT it (Tabby) are never auto-retried
     * after an unknown outcome. */
    idempotencyKey?: string,
  ): Promise<{ providerRefundId?: string }>;
  /** Throws PaymentError("PAYMENT_INBOUND_INVALID") on bad signatures.
   * MAY be async (e.g. PayPal verifies through its API); the inbound
   * registration awaits it before the callback is trusted. */
  verifyCallback(request: InboundRequestView, secrets: PaymentSecrets): void | Promise<void>;
  parseCallback(request: InboundRequestView): ParsedCallback;
}

export class PaymentProviderRegistry {
  private readonly providers = new Map<string, PaymentProvider>();

  register(provider: PaymentProvider): void {
    if (this.providers.has(provider.providerType)) {
      throw new PaymentError(
        "PAYMENT_PROVIDER_UNKNOWN",
        `provider type "${provider.providerType}" is already registered`,
      );
    }
    this.providers.set(provider.providerType, provider);
  }

  /** Composition lifecycle (ADR-0017 S5/R3): the trusted composition
   * rebuilds the registry when the extension lifecycle revision moves —
   * a disabled/uninstalled provider package must stop being offered. */
  clear(): void {
    this.providers.clear();
  }

  get(providerType: string): PaymentProvider | undefined {
    return this.providers.get(providerType);
  }

  list(): readonly PaymentProvider[] {
    return [...this.providers.values()].sort((a, b) =>
      a.providerType.localeCompare(b.providerType),
    );
  }
}
