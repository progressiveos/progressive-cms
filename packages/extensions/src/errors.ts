// Stable extensions-domain error codes (Extensions/Compatibility/Updates spec
// §3–§28; codes are contract and append-only, messages are not). The coarse
// `code` travels over REST/MCP/CLI wire surfaces; fine-grained manifest and
// preflight issues carry their own stable issue codes (manifest.ts /
// issues.ts) so operators never parse messages.
export class ExtensionError extends Error {
  /** Machine-stable error code, e.g. "EXTENSION_MANIFEST_INVALID". */
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
    this.name = "ExtensionError";
    this.code = code;
    this.details = options?.details;
  }
}

export const EXTENSION_ERROR_CODES = [
  "EXTENSION_MANIFEST_INVALID",
  "EXTENSION_NOT_DEPLOYED",
  "EXTENSION_NOT_INSTALLED",
  "EXTENSION_ALREADY_INSTALLED",
  "EXTENSION_ALREADY_DEPLOYED",
  "EXTENSION_DEPLOYMENT_INVALID",
  "EXTENSION_HANDLER_UNRESOLVED",
  "EXTENSION_DEPENDENCY_UNSATISFIED",
  "EXTENSION_CAPABILITY_CONFLICT",
  "EXTENSION_CONFIG_INVALID",
  "EXTENSION_CORE_INCOMPATIBLE",
  "EXTENSION_SECRET_REF_UNRESOLVED",
  "EXTENSION_MIGRATION_DRIFT",
  "EXTENSION_MIGRATION_FAILED",
  "EXTENSION_DISABLE_BLOCKED",
  "EXTENSION_UNINSTALL_BLOCKED",
  "EXTENSION_OBLIGATIONS_OUTSTANDING",
  "EXTENSION_OBLIGATION_CHECK_UNAVAILABLE",
  "EXTENSION_OBLIGATION_CHECK_FAILED",
  "EXTENSION_OBLIGATION_CHECK_INVALID",
  "EXTENSION_DATA_POLICY_CONFIRMATION_REQUIRED",
  "EXTENSION_REGISTRATION_CONFLICT",
  "EXTENSION_EVENT_CONSUMPTION_INVALID",
  "UPDATE_MANIFEST_INVALID",
  "UPDATE_RUNTIME_INCOMPATIBLE",
  "UPDATE_DATABASE_INCOMPATIBLE",
  "UPDATE_COMPATIBILITY_BLOCKED",
  "UPDATE_BACKUP_REQUIRED",
  "UPDATE_DEPLOYMENT_ADAPTER_UNAVAILABLE",
  "UPDATE_POSTFLIGHT_FAILED",
] as const;

export type ExtensionErrorCode = (typeof EXTENSION_ERROR_CODES)[number];
