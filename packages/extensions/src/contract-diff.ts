// Contract diff gate (PCMS-EXT-T016, Extensions spec §41).
//
// Minor compatibility over canonical JSON contracts: additive change →
// pass, deprecation metadata → pass, removal/rename/type narrowing →
// breaking (fails CI). The OpenAPI layer uses the existing M09
// `breakingDiff`; this module covers the generic structural rules shared by
// MCP, permission registry, config schema and theme corpora. Frozen
// fixtures are the baselines — never hand-edited; regenerate via their
// generators instead.
export const CONTRACT_DIFF_CODES = [
  "CONTRACT_ITEM_REMOVED",
  "CONTRACT_TYPE_NARROWED",
  "CONTRACT_REQUIRED_ADDED",
  "CONTRACT_ENUM_NARROWED",
] as const;

export type ContractDiffCode = (typeof CONTRACT_DIFF_CODES)[number];

export interface ContractDiffFinding {
  readonly code: ContractDiffCode;
  readonly path: string;
  readonly message: string;
  readonly breaking: boolean;
}

export function breakingDiffFindings(
  findings: readonly ContractDiffFinding[],
): readonly ContractDiffFinding[] {
  return findings.filter((finding) => finding.breaking);
}

/** Keys an object array by an identity field (permissions: "key", tools: "name"). */
export function keyedBy(items: readonly unknown[], field: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of items) {
    if (typeof item === "object" && item !== null && field in item) {
      const key = (item as Record<string, unknown>)[field];
      if (typeof key === "string") out[key] = item;
    }
  }
  return out;
}

function typeNames(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string");
  return [];
}

/**
 * Generic structural diff of two canonical JSON contract documents.
 * Deterministic (findings sorted by path then code). Unknown/extra content
 * in the target is additive and never reported as breaking.
 */
export function diffContractDocuments(
  baseline: unknown,
  target: unknown,
  path = "",
): readonly ContractDiffFinding[] {
  const findings: ContractDiffFinding[] = [];
  const push = (finding: ContractDiffFinding): void => void findings.push(finding);
  const at = (name: string): string => (path === "" ? name : `${path}.${name}`);

  if (Array.isArray(baseline) && Array.isArray(target)) {
    for (const [index, before] of baseline.entries()) {
      if (index >= target.length) break;
      findings.push(...diffContractDocuments(before, target[index], `${path}[${index}]`));
    }
    return sortFindings(findings);
  }

  if (
    typeof baseline !== "object" ||
    baseline === null ||
    typeof target !== "object" ||
    target === null
  ) {
    return findings;
  }
  const before = baseline as Record<string, unknown>;
  const after = target as Record<string, unknown>;

  // Removals: baseline items that vanished.
  for (const key of Object.keys(before)) {
    if (!(key in after)) {
      push({
        code: "CONTRACT_ITEM_REMOVED",
        path: at(key),
        message: `contract item "${at(key)}" was removed`,
        breaking: true,
      });
      continue;
    }
    // Schema-aware narrowing rules on JSON-Schema-ish documents.
    if (key === "type") {
      const beforeTypes = new Set(typeNames(before[key]));
      const afterTypes = new Set(typeNames(after[key]));
      const narrowed = [...beforeTypes].filter((entry) => !afterTypes.has(entry));
      if (narrowed.length > 0) {
        push({
          code: "CONTRACT_TYPE_NARROWED",
          path: at(key),
          message: `type narrowed: ${narrowed.join(", ")} no longer accepted`,
          breaking: true,
        });
      }
      continue;
    }
    if (key === "required" && Array.isArray(before[key]) && Array.isArray(after[key])) {
      const beforeRequired = new Set(before[key] as string[]);
      const afterRequired = new Set(after[key] as string[]);
      for (const name of beforeRequired) {
        if (!afterRequired.has(name)) continue; // un-required is additive
      }
      for (const name of afterRequired) {
        if (!beforeRequired.has(name) && !(name in (before as Record<string, unknown>))) {
          push({
            code: "CONTRACT_REQUIRED_ADDED",
            path: `${at(key)}[${name}]`,
            message: `new required property "${name}" without a default breaks existing clients`,
            breaking: true,
          });
        }
      }
      continue;
    }
    if (key === "enum" && Array.isArray(before[key]) && Array.isArray(after[key])) {
      const beforeValues = new Set(before[key].map((entry) => JSON.stringify(entry)));
      const afterValues = new Set(after[key].map((entry) => JSON.stringify(entry)));
      for (const value of beforeValues) {
        if (!afterValues.has(value)) {
          push({
            code: "CONTRACT_ENUM_NARROWED",
            path: at(key),
            message: `enum value ${value} no longer accepted`,
            breaking: true,
          });
        }
      }
      continue;
    }
    findings.push(...diffContractDocuments(before[key], after[key], at(key)));
  }
  return sortFindings(findings);
}

function sortFindings(findings: readonly ContractDiffFinding[]): readonly ContractDiffFinding[] {
  return [...findings].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : 1,
  );
}
