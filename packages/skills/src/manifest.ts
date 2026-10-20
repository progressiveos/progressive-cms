// Agent Skill manifest v1 (PCMS-SKILL-T001, Agent Skills spec §3–§6).
//
// A skill manifest is compatibility metadata only — it never carries
// executable material and never grants permissions (spec §0: a Skill cannot
// extend a token). Parsing is bounded and fail-closed with stable issue
// codes, mirroring the release-manifest approach (packages/extensions).
import Ajv from "ajv";
import { valid as semverValid, validRange } from "semver";

/**
 * System contract keys accepted in requires.contracts. Kept in sync with
 * @pcms/extensions CONTRACT_VERSION_KEYS — skills stays a dependency-free
 * L1 subsystem (architecture map, tests/architecture.test.ts), and the
 * equality of the two lists is pinned by tests/skills/manifest.test.ts.
 */
export const SYSTEM_CONTRACT_KEYS: readonly string[] = [
  "cms",
  "config_schema",
  "extension_contract",
  "rest_api",
  "mcp",
  "theme_contract",
  "block_document",
  "search_index",
  "bundle",
  "pcpub",
  "pcmd",
];

/** Safety levels (Agent Skills spec §38; milestone task brief §30). */
export const SKILL_SAFETY_LEVELS = [
  "READ",
  "DRAFT_WRITE",
  "PREVIEW",
  "SCHEDULE",
  "PUBLIC_MUTATION",
  "SECURITY_ACTIVATION",
] as const;
export type SkillSafetyLevel = (typeof SKILL_SAFETY_LEVELS)[number];

export const SKILL_MANIFEST_MAX_BYTES = 256 * 1024;
// Dots are allowed for the community namespace ("community.<name>"); the
// installer pins first-party ids to the dash form and reserves the prefix.
const SKILL_ID_PATTERN = /^[a-z][a-z0-9.-]{2,63}$/;
const SEMVER_RANGE_MAX_LENGTH = 64;
/** Capabilities/scopes are validated against this cap before registry lookup. */
const SCOPE_MAX_LENGTH = 64;

export interface SkillManifestV1 {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly requires: {
    readonly cms?: string | undefined;
    readonly contracts?: Readonly<Record<string, string>> | undefined;
    readonly minimum_capabilities?: readonly string[] | undefined;
    readonly optional_capabilities?: readonly string[] | undefined;
  };
  readonly recommended_scopes: readonly string[];
  readonly optional_scopes: readonly string[];
  readonly dangerous_optional_scopes: readonly string[];
  readonly entry_workflow: readonly string[];
  readonly safety_levels: readonly SkillSafetyLevel[];
  readonly references: readonly string[];
  /** Community packages only (installed, never first-party): origin data
   * the operator can audit. Absent on release-shipped skills. */
  readonly attribution?: {
    readonly author: string;
    readonly homepage?: string;
    readonly source?: string;
  };
}

export interface SkillManifestIssue {
  /** Stable issue code, e.g. VERSION_NOT_SEMVER / UNKNOWN_CONTRACT. */
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export const SKILL_MANIFEST_V1_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://progressive-cms.dev/schemas/skill-manifest-v1.json",
  title: "Progressive CMS agent skill manifest v1",
  type: "object",
  additionalProperties: false,
  required: ["id", "version", "description", "entry_workflow", "safety_levels"],
  properties: {
    id: { type: "string", pattern: SKILL_ID_PATTERN.source, maxLength: 64 },
    version: { type: "string", minLength: 1, maxLength: 32 },
    description: { type: "string", minLength: 1, maxLength: 500 },
    requires: {
      type: "object",
      additionalProperties: false,
      properties: {
        cms: { type: "string", minLength: 1, maxLength: SEMVER_RANGE_MAX_LENGTH },
        contracts: {
          type: "object",
          maxProperties: 32,
          additionalProperties: {
            type: "string",
            minLength: 1,
            maxLength: SEMVER_RANGE_MAX_LENGTH,
          },
        },
        minimum_capabilities: {
          type: "array",
          maxItems: 64,
          items: { type: "string", minLength: 1, maxLength: SCOPE_MAX_LENGTH },
        },
        optional_capabilities: {
          type: "array",
          maxItems: 64,
          items: { type: "string", minLength: 1, maxLength: SCOPE_MAX_LENGTH },
        },
      },
    },
    recommended_scopes: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: SCOPE_MAX_LENGTH },
    },
    optional_scopes: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: SCOPE_MAX_LENGTH },
    },
    dangerous_optional_scopes: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: SCOPE_MAX_LENGTH },
    },
    entry_workflow: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
    safety_levels: {
      type: "array",
      minItems: 1,
      maxItems: SKILL_SAFETY_LEVELS.length,
      items: { enum: [...SKILL_SAFETY_LEVELS] },
    },
    references: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
    attribution: {
      type: "object",
      additionalProperties: false,
      required: ["author"],
      properties: {
        author: { type: "string", minLength: 1, maxLength: 200 },
        homepage: { type: "string", minLength: 1, maxLength: 500 },
        source: { type: "string", minLength: 1, maxLength: 500 },
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true });
const validateShape = ajv.compile(SKILL_MANIFEST_V1_SCHEMA);

export interface ValidateSkillManifestOptions {
  /**
   * Registered permission keys (packages/auth PERMISSION_REGISTRY). When
   * provided, scopes/capabilities outside the registry are rejected —
   * manifests may not invent permissions (task brief §95).
   */
  readonly knownScopes?: ReadonlySet<string> | undefined;
}

function scopeIssues(
  manifest: SkillManifestV1,
  knownScopes: ReadonlySet<string> | undefined,
): SkillManifestIssue[] {
  if (!knownScopes) return [];
  const issues: SkillManifestIssue[] = [];
  const check = (path: string, values: readonly string[] | undefined) => {
    for (const scope of values ?? []) {
      if (!knownScopes.has(scope)) {
        issues.push({
          code: "UNKNOWN_SCOPE",
          path: `${path}.${scope}`,
          message: `"${scope}" is not a registered permission`,
        });
      }
    }
  };
  check("requires.minimum_capabilities", manifest.requires?.minimum_capabilities);
  check("requires.optional_capabilities", manifest.requires?.optional_capabilities);
  check("recommended_scopes", manifest.recommended_scopes);
  check("optional_scopes", manifest.optional_scopes);
  check("dangerous_optional_scopes", manifest.dangerous_optional_scopes);
  return issues;
}

/**
 * Deterministic, fail-closed validation of a skill manifest document.
 * The schema is data only (no executable fields); unknown fields are
 * rejected. Real SemVer is enforced on `version` (task brief §25: the
 * project already uses `semver` — no hand-rolled parser).
 */
export function validateSkillManifest(
  input: unknown,
  options: ValidateSkillManifestOptions = {},
):
  | { readonly ok: true; readonly manifest: SkillManifestV1 }
  | { readonly ok: false; readonly issues: readonly SkillManifestIssue[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      issues: [
        { code: "NOT_AN_OBJECT", path: "", message: "skill manifest must be a JSON object" },
      ],
    };
  }
  if (JSON.stringify(input).length > SKILL_MANIFEST_MAX_BYTES) {
    return {
      ok: false,
      issues: [
        {
          code: "TOO_LARGE",
          path: "",
          message: `skill manifest exceeds ${SKILL_MANIFEST_MAX_BYTES} bytes`,
        },
      ],
    };
  }
  const issues: SkillManifestIssue[] = [];
  if (!validateShape(input)) {
    for (const error of validateShape.errors ?? []) {
      const rawPath = error.instancePath
        .split("/")
        .filter((segment) => segment !== "")
        .map((segment, index) =>
          /^\d+$/.test(segment) ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
        )
        .join("");
      const params = error.params as { missingProperty?: string };
      const path =
        error.keyword === "required" && params.missingProperty
          ? rawPath
            ? `${rawPath}.${params.missingProperty}`
            : params.missingProperty
          : rawPath || "(root)";
      issues.push({ code: "SCHEMA_VIOLATION", path, message: error.message ?? "invalid value" });
    }
    return { ok: false, issues };
  }

  const manifest = input as unknown as SkillManifestV1;
  const requires = manifest.requires ?? {};
  if (!semverValid(manifest.version)) {
    issues.push({
      code: "VERSION_NOT_SEMVER",
      path: "version",
      message: `"${manifest.version}" is not valid SemVer`,
    });
  }
  if (requires.cms !== undefined && !validRange(requires.cms)) {
    issues.push({
      code: "CMS_RANGE_INVALID",
      path: "requires.cms",
      message: `"${requires.cms}" is not a valid SemVer range`,
    });
  }
  for (const key of Object.keys(requires.contracts ?? {})) {
    if (!SYSTEM_CONTRACT_KEYS.includes(key)) {
      issues.push({
        code: "UNKNOWN_CONTRACT",
        path: `requires.contracts.${key}`,
        message: `"${key}" is not a system contract key`,
      });
    }
    // Contract values may be SemVer ranges ("^1.0.0") or exact non-SemVer
    // versions (MCP date protocol "2024-11-05"); length is schema-bounded and
    // a typo degrades fail-safe to "incompatible" at evaluation time.
  }
  issues.push(...scopeIssues(manifest, options.knownScopes));
  if (issues.length > 0) return { ok: false, issues };

  return { ok: true, manifest };
}

/** Fails closed with the stable SKILL_MANIFEST_INVALID code. */
export function parseSkillManifest(
  document: unknown,
  options: ValidateSkillManifestOptions = {},
): SkillManifestV1 {
  const validation = validateSkillManifest(document, options);
  if (!validation.ok) {
    const error = new Error("skill manifest is invalid") as Error & {
      code: string;
      details: unknown;
    };
    error.code = "SKILL_MANIFEST_INVALID";
    error.details = { issues: validation.issues };
    throw error;
  }
  return validation.manifest;
}
