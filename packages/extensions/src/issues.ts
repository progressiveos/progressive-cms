// Unified machine-readable issue model (PCMS-EXT-T006 preflights, T012
// compatibility scanner, T013 update preflight — Extensions spec §13, §28–§30).
// Free-form strings are never the contract: every issue carries a stable
// code, severity, blocking flag, category, subject and remediation.
export type CompatibilitySeverity = "info" | "warning" | "error";

export const ISSUE_CATEGORIES = [
  "runtime",
  "database",
  "extension",
  "capability",
  "config",
  "migration",
  "theme",
  "content",
  "contract",
  "update",
] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

export interface CompatibilityIssue {
  /** Stable code, e.g. "EXTENSION_DEPENDENCY_UNSATISFIED". */
  readonly code: string;
  readonly severity: CompatibilitySeverity;
  /** Blocking issues gate the operation/upgrade; warnings do not. */
  readonly blocking: boolean;
  readonly category: IssueCategory;
  /** What the issue is about: extension id, capability key, contract item. */
  readonly subject: string;
  /** Optional finer location, e.g. "requires[0]" or a migration name. */
  readonly location?: string;
  readonly message: string;
  /** Operator-facing remediation hint. */
  readonly remediation?: string;
}

export function issue(input: CompatibilityIssue): CompatibilityIssue {
  return input;
}

export function blockingIssues(
  issues: readonly CompatibilityIssue[],
): readonly CompatibilityIssue[] {
  return issues.filter((entry) => entry.blocking);
}

export function warningIssues(
  issues: readonly CompatibilityIssue[],
): readonly CompatibilityIssue[] {
  return issues.filter((entry) => !entry.blocking && entry.severity === "warning");
}

/** Typed preflight outcome used across lifecycle and update flows. */
export type PreflightOutcome = "READY" | "READY_WITH_WARNINGS" | "BLOCKED";

export function preflightOutcome(issues: readonly CompatibilityIssue[]): PreflightOutcome {
  if (blockingIssues(issues).length > 0) return "BLOCKED";
  if (issues.length > 0) return "READY_WITH_WARNINGS";
  return "READY";
}

/**
 * Sorts issues deterministically for stable wire output:
 * category, subject, code, then message.
 */
export function sortIssues(issues: readonly CompatibilityIssue[]): readonly CompatibilityIssue[] {
  return [...issues].sort((a, b) => {
    const byField = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
    return (
      byField(a.category, b.category) ||
      byField(a.subject, b.subject) ||
      byField(a.code, b.code) ||
      byField(a.message, b.message)
    );
  });
}
