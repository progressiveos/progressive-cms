// Stable integrations-domain error codes (Integrations spec §17–§25; codes
// are contract and append-only, messages are not).
export class IntegrationError extends Error {
  /** Machine-stable error code, e.g. "INTEGRATION_URL_BLOCKED". */
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
    this.name = "IntegrationError";
    this.code = code;
    this.details = options?.details;
  }
}

export const INTEGRATION_ERROR_CODES = [
  "CONNECTOR_TYPE_UNKNOWN",
  "INTEGRATION_ACTION_UNKNOWN",
  "INTEGRATION_INSTANCE_NOT_FOUND",
  "INTEGRATION_CONFIG_INVALID",
  "INTEGRATION_SECRET_REF_INVALID",
  "INTEGRATION_SECRET_MISSING",
  "INTEGRATION_BINDING_INVALID",
  "INTEGRATION_CONDITION_INVALID",
  "INTEGRATION_BINDING_NOT_FOUND",
  "INTEGRATION_DELIVERY_NOT_FOUND",
  "INTEGRATION_DELIVERY_STATE",
  "INTEGRATION_PROJECTION_UNAVAILABLE",
  "INTEGRATION_URL_BLOCKED",
  "INTEGRATION_DELIVERY_FAILED",
  "INTEGRATION_INBOUND_INVALID",
  "INTEGRATION_INBOUND_PAYLOAD_TOO_LARGE",
  "INTEGRATION_INBOUND_NOT_FOUND",
] as const;

export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number];
