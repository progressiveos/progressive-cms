// Integration connector contracts + registry (PCMS-INT-T001; Integrations
// spec §4–§7). A connector is a CODE capability: protocol semantics only,
// never credentials. Instances (config + secret refs) and deliveries are
// stored separately.
//
// `IntegrationAction` here is deliberately a different namespace from the
// public Content `Action` (link/form/phone) — spec §15 requires the type
// names never collide.
import { IntegrationError } from "./errors.js";
import { type SchemaIssues, validateAgainstSchema } from "./schema.js";

/** Bounded JSON-schema subset — see schema.ts. */
export type ConnectorSchema = Record<string, unknown>;

export interface ConnectorActionDescriptor {
  /** e.g. "send_message" — unique per connector. */
  readonly actionType: string;
  readonly description: string;
  /** Bounded payload shape validated at binding save and dispatch time. */
  readonly payloadSchema: ConnectorSchema;
  /**
   * Execution-time projection request (owner Progressive-HQ task): the
   * dispatcher fetches fresh domain fields for the aggregate id taken from
   * the MAPPED payload right before the network call. Values ride the
   * action context only — the persisted delivery payload stays whatever the
   * binding mapping produced (PII-free by contract).
   */
  readonly executionProjection?: {
    /** Domain aggregate, e.g. "lead" — must match the projection source. */
    readonly aggregate: string;
    /** Dotted path into the mapped payload carrying the aggregate id. */
    readonly idFromPayload: string;
    /** Requested fields; the projection source allowlists the vocabulary. */
    readonly fields: readonly string[];
  };
}

export interface ConnectorSecretRequirement {
  /** Requirement name inside instance.secret_refs, e.g. "bot_token". */
  readonly name: string;
  readonly description: string;
}

export interface ConnectorInboundDescriptor {
  /** Normalized inbound event types this connector accepts. */
  readonly eventTypes: readonly string[];
  /** Hard payload cap for the raw provider body (bytes). */
  readonly payloadLimitBytes: number;
}

export interface ConnectorDefinition {
  readonly connectorType: string;
  readonly title: string;
  readonly description: string;
  /** Non-secret instance config shape. */
  readonly configSchema: ConnectorSchema;
  readonly secrets: readonly ConnectorSecretRequirement[];
  readonly actions: readonly ConnectorActionDescriptor[];
  /** Safe connector-specific probe (spec §40); absent = test reports unsupported. */
  readonly testable: boolean;
  readonly inbound?: ConnectorInboundDescriptor;
}

export interface ConnectorRegistry {
  register(definition: ConnectorDefinition): void;
  list(): readonly ConnectorDefinition[];
  get(connectorType: string): ConnectorDefinition | undefined;
}

export function createConnectorRegistry(): ConnectorRegistry {
  const byType = new Map<string, ConnectorDefinition>();
  return {
    register(definition) {
      if (byType.has(definition.connectorType)) {
        throw new IntegrationError(
          "CONNECTOR_TYPE_UNKNOWN",
          `connector type "${definition.connectorType}" is already registered`,
        );
      }
      const actions = new Set<string>();
      for (const action of definition.actions) {
        if (actions.has(action.actionType)) {
          throw new IntegrationError(
            "CONNECTOR_TYPE_UNKNOWN",
            `connector "${definition.connectorType}" declares duplicate action "${action.actionType}"`,
          );
        }
        actions.add(action.actionType);
      }
      byType.set(definition.connectorType, definition);
    },
    list() {
      return [...byType.values()].sort((a, b) => a.connectorType.localeCompare(b.connectorType));
    },
    get(connectorType) {
      return byType.get(connectorType);
    },
  };
}

export function connectorAction(
  definition: ConnectorDefinition,
  actionType: string,
): ConnectorActionDescriptor | undefined {
  return definition.actions.find((action) => action.actionType === actionType);
}

/** Validates instance config / action payload against the connector schema. */
export function validateConnectorPayload(
  schema: ConnectorSchema,
  payload: unknown,
  label: string,
): SchemaIssues {
  return validateAgainstSchema(schema, payload, label);
}
