// Cross-subsystem publication validator pipeline (PCMS-PUB-T010).
// Validators are registered at the composition layer (content validity,
// route availability, theme/navigation compatibility, media readiness, SEO
// validity, permissions) — this package defines only the structural
// contract and the deterministic, bounded runner (spec §20).
import type { Clock, DbClient } from "@pcms/core";
import type { SealedRevisionRef } from "./ports.js";

export type RouteOperation =
  | { readonly kind: "none" }
  | {
      readonly kind: "set";
      readonly siteId: string;
      readonly path: string;
      readonly locale?: string;
      readonly domainBindingId?: string;
      /** Path this candidate's entity currently occupies and abandons in the
       * same release — makes same-release route swaps valid combined state
       * (owner instruction #33). */
      readonly freesPath?: string;
    }
  | { readonly kind: "retire" };

export interface PublicationCandidate {
  readonly entityType: string;
  readonly entityId: string;
  readonly context: string;
  readonly intent: "PUBLISH" | "UNPUBLISH";
  readonly targetRevision: SealedRevisionRef | null;
  readonly routeOperation: RouteOperation;
}

export interface PublicationIssue {
  /** Stable machine code, e.g. ROUTE_CONFLICT / MEDIA_NOT_READY (spec §72). */
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly validator: string;
  /** Candidate position this issue belongs to (validators tag it). */
  readonly candidateIndex: number;
  readonly path?: string;
}

/** What validators produce; the runner attributes validator + candidate. */
export interface ValidatorIssue {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly path?: string;
  readonly candidateIndex?: number;
}

export interface PublicationValidator {
  /** Deterministic validator identity, e.g. "routing", "content", "seo". */
  readonly name: string;
  /**
   * Receives ALL candidates of the operation so validators can check the
   * combined prospective resulting state, not each item against the stale
   * current state (spec §20, owner instruction #33 — route swaps must not
   * collide with themselves).
   */
  validate(
    candidates: readonly PublicationCandidate[],
    context: PublicationValidationContext,
  ): Promise<readonly ValidatorIssue[]>;
}

export interface PublicationValidationContext {
  readonly executor: DbClient;
  readonly clock: Clock;
}

export const MAX_VALIDATION_ISSUES = 200;

/** Deterministic, bounded pipeline run: issues sorted by (candidate, code,
 * validator); any `severity: "error"` blocks the operation. */
export async function runPublicationValidators(
  validators: readonly PublicationValidator[],
  candidates: readonly PublicationCandidate[],
  context: PublicationValidationContext,
): Promise<readonly PublicationIssue[]> {
  const issues: PublicationIssue[] = [];
  for (const validator of validators) {
    const produced = await validator.validate(candidates, context);
    for (const issue of produced) {
      issues.push({
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
        ...(issue.path !== undefined && { path: issue.path }),
        validator: validator.name,
        candidateIndex: issue.candidateIndex ?? 0,
      });
    }
  }
  issues.sort(
    (a, b) =>
      a.candidateIndex - b.candidateIndex ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
      (a.validator < b.validator ? -1 : 1),
  );
  return issues.length > MAX_VALIDATION_ISSUES ? issues.slice(0, MAX_VALIDATION_ISSUES) : issues;
}
