// OpenAPI breaking-diff gate (PCMS-API-T026; API spec §65).
// Minor releases must fail CI on unapproved breaking changes: removed or
// renamed operations, narrowed requests and removed response envelopes are
// breaks; additive changes are not (spec §63/§77).

export interface BreakingChange {
  readonly kind:
    | "operation_removed"
    | "operation_id_changed"
    | "request_property_removed"
    | "request_property_made_required"
    | "response_envelope_removed";
  readonly location: string;
  readonly detail: string;
}

interface OperationLike {
  readonly operationId?: unknown;
  readonly responses?: unknown;
  readonly requestBody?: unknown;
}

function operationsOf(document: unknown): Map<string, OperationLike> {
  const out = new Map<string, OperationLike>();
  const paths = (document as { paths?: Record<string, unknown> }).paths ?? {};
  for (const [path, methods] of Object.entries(paths as Record<string, unknown>)) {
    for (const [method, operation] of Object.entries(methods as Record<string, unknown>)) {
      out.set(`${method.toUpperCase()} ${path}`, operation as OperationLike);
    }
  }
  return out;
}

/**
 * Computes the breaking changes turning `before` into `after`. An empty list
 * means the change is backward-compatible (additions allowed, spec §77).
 */
export function breakingDiff(before: unknown, after: unknown): readonly BreakingChange[] {
  const changes: BreakingChange[] = [];
  const beforeOps = operationsOf(before);
  const afterOps = operationsOf(after);

  for (const [key, operation] of beforeOps) {
    const next = afterOps.get(key);
    if (next === undefined) {
      changes.push({
        kind: "operation_removed",
        location: key,
        detail: "operation is no longer documented",
      });
      continue;
    }
    if (typeof operation.operationId === "string" && operation.operationId !== next.operationId) {
      changes.push({
        kind: "operation_id_changed",
        location: key,
        detail: `${String(operation.operationId)} → ${String(next.operationId)}`,
      });
    }
    // Request schema: removals and new required fields are breaks.
    const beforeBody = operation.requestBody as
      | { content?: { "application/json"?: { schema?: Record<string, unknown> } } }
      | undefined;
    const afterBody = next.requestBody as
      | { content?: { "application/json"?: { schema?: Record<string, unknown> } } }
      | undefined;
    const beforeSchema = beforeBody?.content?.["application/json"]?.schema;
    const afterSchema = afterBody?.content?.["application/json"]?.schema;
    const beforeProps = (beforeSchema?.properties ?? {}) as Record<string, unknown>;
    const afterProps = (afterSchema?.properties ?? {}) as Record<string, unknown>;
    for (const property of Object.keys(beforeProps)) {
      if (afterProps[property] === undefined) {
        changes.push({
          kind: "request_property_removed",
          location: `${key}#/${property}`,
          detail: "documented request property disappeared",
        });
      }
    }
    const beforeRequired = (beforeSchema?.required ?? []) as readonly string[];
    const afterRequired = (afterSchema?.required ?? []) as readonly string[];
    for (const property of afterRequired) {
      if (!beforeRequired.includes(property) && afterProps[property] !== undefined) {
        changes.push({
          kind: "request_property_made_required",
          location: `${key}#/#${property}`,
          detail: "previously optional request property is now required",
        });
      }
    }
    // The shared error envelope must stay the documented failure shape.
    const responses = (next.responses ?? {}) as Record<string, unknown>;
    const envelopeGone =
      Object.values(responses).length > 0 && !JSON.stringify(responses).includes("ErrorEnvelope");
    if (envelopeGone) {
      changes.push({
        kind: "response_envelope_removed",
        location: key,
        detail: "error responses no longer reference the shared ErrorEnvelope",
      });
    }
  }
  return changes;
}
