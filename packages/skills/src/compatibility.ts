// Skill ↔ server compatibility evaluation (PCMS-SKILL-T001/T017, spec §6,
// task brief §27/§70–§71). Machine-readable result — never just a string:
// compatible | warning | incompatible with stable issue codes.
import { minVersion, parse, satisfies, validRange } from "semver";
import type { SkillManifestV1 } from "./manifest.js";
export type SkillCompatibilityResult = "compatible" | "warning" | "incompatible";

export interface SkillCompatibilityIssue {
  readonly code:
    | "CONTRACT_MISSING"
    | "CONTRACT_MAJOR_MISMATCH"
    | "CONTRACT_VARIANCE"
    | "CAPABILITY_MISSING"
    | "CAPABILITY_MISSING_OPTIONAL"
    | "CMS_VERSION_VARIANCE";
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
  readonly message: string;
}

/** Server-side snapshot the manifest is checked against (bootstrap/contracts). */
export interface SkillServerSnapshot {
  /** System contract versions, e.g. { theme_contract: "1.0.0", mcp: "2024-11-05" }. */
  readonly contractVersions: Readonly<Record<string, string | number>>;
  /** Capability names available to the connecting actor (registered permissions). */
  readonly capabilities: readonly string[];
}

/**
 * Partial dotted-numeric versions ("1", "1.0") are padded to full SemVer
 * ("1.0.0"): shipped contract versions are often abbreviated, and ranges
 * like "^1.0" must match them (R17, 2026-10-03 site-developer report —
 * semver.parse returns null for partials, which used to classify every
 * abbreviated contract as a major mismatch). Dates and arbitrary tags are
 * never coerced — they keep the exact-match path.
 */
function fullVersion(value: string): string | null {
  if (parse(value)) return value;
  if (!/^\d+(\.\d+){0,2}$/.test(value)) return null;
  const parts = value.split(".");
  while (parts.length < 3) parts.push("0");
  const padded = parts.join(".");
  return parse(padded) ? padded : null;
}

function contractSatisfies(range: string, version: string): boolean {
  // SemVer contracts (theme_contract "1.0.0") use range semantics; non-SemVer
  // contracts (mcp date versions "2024-11-05") fall back to exact match.
  if (validRange(range)) {
    const full = fullVersion(version);
    if (full !== null) return satisfies(full, range);
  }
  return range === version;
}

/**
 * Evaluate one skill manifest against a server snapshot. Required contract/
 * capability violations stop the skill before any mutation (spec §6);
 * same-major variance and missing optional capabilities only warn (§71).
 */
export function evaluateSkillCompatibility(
  manifest: Pick<SkillManifestV1, "version" | "requires">,
  snapshot: SkillServerSnapshot,
): {
  readonly result: SkillCompatibilityResult;
  readonly issues: readonly SkillCompatibilityIssue[];
} {
  const issues: SkillCompatibilityIssue[] = [];
  let hard = false;

  if (manifest.requires.cms !== undefined) {
    const cms = snapshot.contractVersions.cms;
    const actual = cms === undefined ? "" : String(cms);
    if (actual === "" || !contractSatisfies(manifest.requires.cms, actual)) {
      hard = true;
      issues.push({
        code: cms === undefined ? "CONTRACT_MISSING" : "CMS_VERSION_VARIANCE",
        path: "requires.cms",
        expected: manifest.requires.cms,
        actual: actual || "(absent)",
        message: `CMS version ${actual || "(absent)"} does not satisfy ${manifest.requires.cms}`,
      });
    }
  }

  for (const [key, range] of Object.entries(manifest.requires.contracts ?? {})) {
    const value = snapshot.contractVersions[key];
    if (value === undefined) {
      hard = true;
      issues.push({
        code: "CONTRACT_MISSING",
        path: `requires.contracts.${key}`,
        expected: range,
        actual: "(absent)",
        message: `server does not expose contract "${key}"`,
      });
      continue;
    }
    const actual = String(value);
    if (contractSatisfies(range, actual)) continue;
    // Compare real SemVer majors when both sides parse (a range floor of
    // "^1.0.0" has major 1); unparseable pairs fail safe as a major mismatch.
    const rangeFloor = validRange(range) ? minVersion(range) : null;
    const actualFull = fullVersion(actual);
    const actualVersion = actualFull === null ? null : parse(actualFull);
    if (!rangeFloor || !actualVersion || rangeFloor.major !== actualVersion.major) {
      hard = true;
      issues.push({
        code: "CONTRACT_MAJOR_MISMATCH",
        path: `requires.contracts.${key}`,
        expected: range,
        actual,
        message: `contract "${key}" major mismatch: expected ${range}, server has ${actual}`,
      });
    } else {
      issues.push({
        code: "CONTRACT_VARIANCE",
        path: `requires.contracts.${key}`,
        expected: range,
        actual,
        message: `contract "${key}" drifted beyond the declared range: server has ${actual}`,
      });
    }
  }

  const available = new Set(snapshot.capabilities);
  for (const capability of manifest.requires.minimum_capabilities ?? []) {
    if (!available.has(capability)) {
      hard = true;
      issues.push({
        code: "CAPABILITY_MISSING",
        path: `requires.minimum_capabilities.${capability}`,
        expected: capability,
        actual: "(absent)",
        message: `required capability "${capability}" is not available to this actor`,
      });
    }
  }
  for (const capability of manifest.requires.optional_capabilities ?? []) {
    if (!available.has(capability)) {
      issues.push({
        code: "CAPABILITY_MISSING_OPTIONAL",
        path: `requires.optional_capabilities.${capability}`,
        expected: capability,
        actual: "(absent)",
        message: `optional capability "${capability}" is not available to this actor`,
      });
    }
  }

  return { result: hard ? "incompatible" : issues.length > 0 ? "warning" : "compatible", issues };
}
