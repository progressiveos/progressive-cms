// Stable payments-domain error codes (Payments spec §28–§37; append-only).
export class PaymentError extends Error {
  /** Machine-stable error code, e.g. "PAYMENT_INVALID_TRANSITION". */
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: string,
    message: string,
    options?: {
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    },
  ) {
    super(message, options === undefined ? undefined : { cause: options.cause });
    this.name = "PaymentError";
    this.code = code;
    this.details = options?.details;
  }
}

export const PAYMENT_ERROR_CODES = [
  "PAYMENT_NOT_FOUND",
  "PAYMENT_INVALID_TRANSITION",
  "PAYMENT_DUPLICATE_REQUEST",
  "PAYMENT_REQUEST_INVALID",
  "PAYMENT_REFUND_EXCEEDS_AMOUNT",
  "PAYMENT_CAPABILITY_UNSUPPORTED",
  "PAYMENT_PROVIDER_UNKNOWN",
  "PAYMENT_PROVIDER_INSTANCE_NOT_FOUND",
  "PAYMENT_PROVIDER_UNAVAILABLE",
  "PAYMENT_INBOUND_INVALID",
  "PAYMENT_METADATA_TOO_LARGE",
  "PAYMENT_CURRENCY_UNSUPPORTED",
  "PAYMENT_REFUND_IN_PROGRESS",
  // CORE-PAYMENTS-ADMIN-CONFIG-01: instance-level settings/credentials.
  /** Secret slots of one instance cannot be read or written. */
  "PAYMENT_CREDENTIALS_UNAVAILABLE",
  /** Mandatory secret slot missing (or its stored value cannot be decrypted). */
  "PAYMENT_CREDENTIALS_INCOMPLETE",
  /** Stored slot exists but cannot be decrypted with the current key. */
  "PAYMENT_CREDENTIALS_UNREADABLE",
  /** The encryption key is not configured for this deployment. */
  "PAYMENT_CREDENTIALS_KEY_MISSING",
  /** Two editors saved concurrently — the caller re-reads and retries. */
  "PAYMENT_SETTINGS_CONFLICT",
  /** Provider config is non-empty and the adapter cannot receive instance config. */
  "PAYMENT_PROVIDER_CONFIG_UNSUPPORTED",
  /** The stored endpoint is not one this provider package trusts. */
  "PAYMENT_PROVIDER_ENDPOINT_UNTRUSTED",
  /** An unknown external outcome outlived the provider's idempotency window. */
  "PAYMENT_RECONCILIATION_REQUIRED",
] as const;

export type PaymentErrorCode = (typeof PAYMENT_ERROR_CODES)[number];
