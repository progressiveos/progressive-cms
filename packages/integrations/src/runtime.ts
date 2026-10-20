// Connector runtime contracts (PCMS-INT-T005): the execution side of a
// connector. Definitions (connectors.ts) describe; runtimes DO. Transports
// are injected — production wires a guarded HTTP client + mail transport,
// tests wire deterministic fakes (spec §35: no public networks in tests).
import type { IntegrationInstance } from "./instances.js";

/** Secrets resolved at execution time — never persisted, never logged. */
export interface ActionExecutionContext {
  readonly instance: IntegrationInstance;
  readonly secrets: Readonly<Record<string, string>>;
  /**
   * Execution-time domain projection (owner Progressive-HQ task): fresh
   * fields fetched by the dispatcher when the action declares an
   * `executionProjection`. Rides the context only — never persisted into
   * the delivery payload, never logged.
   */
  readonly projection?: Readonly<Record<string, unknown>>;
  /** MKT-010: outbound body format pinned on the delivery at materialization
   * (1 = legacy, 2 = with data.attribution). Connectors MUST build the body
   * from this revision, never from current instance config, so retries of
   * old deliveries replay byte-identical payloads. Absent = revision 1. */
  readonly bodyRevision?: number;
}

export interface ActionResult {
  readonly ok: boolean;
  /** Provider-side object id when one was created (safe to store). */
  readonly externalId?: string;
  readonly httpStatus?: number;
  /** Normalized provider/machine error code (safe to store). */
  readonly providerErrorCode?: string;
  /** Human-safe summary — must never contain credentials/headers. */
  readonly errorMessage?: string;
  /** true → FAILED_RETRYABLE (timeouts, 5xx, 429); false → permanent. */
  readonly retryable: boolean;
}

export function actionSucceeded(externalId?: string): ActionResult {
  return { ok: true, ...(externalId === undefined ? {} : { externalId }), retryable: false };
}

export function actionFailed(result: {
  readonly providerErrorCode?: string;
  readonly errorMessage?: string;
  readonly httpStatus?: number;
  readonly retryable: boolean;
}): ActionResult {
  return { ok: false, ...result };
}

export interface ConnectorRuntime {
  /** Executes one configured action against the external system. */
  execute(
    actionType: string,
    payload: Readonly<Record<string, unknown>>,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult>;
  /** Safe connector-specific probe for the privileged test operation. */
  test(ctx: ActionExecutionContext): Promise<ActionResult>;
}

export class ConnectorRuntimeRegistry {
  private readonly runtimes = new Map<string, ConnectorRuntime>();

  register(connectorType: string, runtime: ConnectorRuntime): void {
    this.runtimes.set(connectorType, runtime);
  }

  get(connectorType: string): ConnectorRuntime | undefined {
    return this.runtimes.get(connectorType);
  }

  list(): readonly string[] {
    return [...this.runtimes.keys()].sort();
  }
}
