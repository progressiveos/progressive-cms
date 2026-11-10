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
  /**
   * How long the provider honours that key. A retry AFTER the window is a NEW
   * operation at the provider, so an unknown outcome older than this must go
   * to reconciliation instead of being re-sent. Absent = the package declares
   * no documented bound; Core then keeps the historical retry behaviour for
   * that provider instead of inventing a window.
   */
  readonly providerIdempotencyWindowSeconds?: number;
  /** getPayment status sync is available. */
  readonly statusSync: boolean;
}

/** Result of one refund submission. */
export interface ProviderRefundResult {
  readonly providerRefundId?: string;
  /**
   * Provider-confirmed outcome of the refund itself. Omitted means "the call
   * returned a confirmed refund" (the historical contract). A provider that
   * can answer with a non-final state MUST report it, so the domain never
   * books money the provider has not returned.
   */
  readonly status?: NormalizedProviderOutcome;
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
  /**
   * Where the payer must be sent to complete the payment (a provider-hosted
   * form). It is returned by the provider itself, persisted with the payment
   * and handed to the storefront — a client-supplied URL is never accepted as
   * a bank result.
   */
  readonly paymentUrl?: string;
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
  /** Instance configuration from payment_provider_instance.config (CORE-
   * PAYMENTS-ADMIN-CONFIG-01). Returns a provider carrying that config; the
   * receiver must be per-call state (no cached OAuth token, no instance ids)
   * because one process serves every instance of the type. Adapters that
   * need instance settings MUST declare it — an adapter without it receives
   * only the empty config (the composition refuses a non-empty one). */
  withConfig?(config: Readonly<Record<string, unknown>>): PaymentProvider;
  /**
   * Credential slots that identify the MERCHANT ACCOUNT rather than a
   * rotatable secret (e.g. a shop id, a terminal key, a client id). Replacing
   * one on a connection that already has payment history is refused: a
   * historical refund/callback must never travel to another merchant. A normal
   * key rotation (same identity) stays allowed.
   */
  readonly merchantIdentitySlots?: readonly string[];
  /**
   * Config keys this adapter needs to VERIFY inbound callbacks (e.g. a
   * platform public key). A draft may omit them; enabling may not — otherwise
   * the connection could take money and silently reject every confirmation.
   */
  readonly callbackConfigRequirements?: readonly string[];
  /**
   * Origins (scheme://host[:port]) the adapter may send merchant credentials
   * to when a connection overrides its endpoint (apiBase/gatewayUrl). Absent
   * or empty ⇒ endpoint overrides are refused: a saved secret must never be
   * redirected to an unverified host by a config edit.
   */
  readonly trustedEndpointOrigins?: readonly string[];
  /**
   * The origins this package used BEFORE per-connection config existed (its
   * built-in defaults). They are the only provably equivalent target when a
   * connection with real payment history must be repaired: pre-policy code
   * ignored instance.config, so historical calls went to these origins.
   */
  readonly defaultEndpointOrigins?: readonly string[];
  /**
   * Package-level problems in a stored config that the JSON schema cannot
   * express (e.g. a malformed CIDR entry). Readiness reports them; a malformed
   * trust boundary never passes as "configured".
   */
  configDiagnostics?(config: Readonly<Record<string, unknown>>): readonly string[];
  /**
   * Plain body the provider requires as a successful notification
   * acknowledgement (T-Bank answers "OK"; a JSON body makes it retry). Absent:
   * the API's normal JSON acknowledgement.
   */
  readonly callbackAck?: string;
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
  ): Promise<ProviderRefundResult>;
  /**
   * Reads a refund the provider already created (by its id) — a state lookup,
   * not a new movement. Absent = the provider cannot expose it, and a pending
   * refund then has no safe confirmation path.
   */
  getRefund?(
    refundId: string,
    secrets: PaymentSecrets,
  ): Promise<{ status: NormalizedProviderOutcome; providerStatus?: string } | null>;
  /** Throws PaymentError("PAYMENT_INBOUND_INVALID") on bad signatures.
   * MAY be async (e.g. PayPal verifies through its API); the inbound
   * registration awaits it before the callback is trusted. */
  verifyCallback(request: InboundRequestView, secrets: PaymentSecrets): void | Promise<void>;
  parseCallback(request: InboundRequestView): ParsedCallback;
}

/**
 * Binds one registry entry to one connection's saved config (CORE-PAYMENTS-
 * ADMIN-CONFIG-01). An adapter without `withConfig` may only receive the
 * empty config: a non-empty setting would be silently ignored otherwise, so
 * it is a typed refusal instead of a false "saved".
 */
export function configureProvider(
  provider: PaymentProvider,
  config: Readonly<Record<string, unknown>>,
): PaymentProvider {
  if (provider.withConfig === undefined) {
    if (Object.keys(config).length === 0) return provider;
    throw new PaymentError(
      "PAYMENT_PROVIDER_CONFIG_UNSUPPORTED",
      `provider type "${provider.providerType}" cannot receive instance settings — update the payment extension`,
    );
  }
  return provider.withConfig(config);
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
