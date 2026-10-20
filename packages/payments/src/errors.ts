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
] as const;

export type PaymentErrorCode = (typeof PAYMENT_ERROR_CODES)[number];
