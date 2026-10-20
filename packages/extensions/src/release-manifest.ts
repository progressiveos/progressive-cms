// Release/update manifest v1 (PCMS-EXT-T013, Extensions spec §22, §25–§26).
//
// A release publishes machine-readable metadata; the manifest DESCRIBES the
// release and never carries executable material — no commands, no SQL, no
// scripts (schema is additionalProperties:false and every field is from the
// allowlist). Parsing is bounded and fail-closed with stable issue codes.
import Ajv from "ajv";
import { valid as semverValid, validRange } from "semver";
import { ExtensionError } from "./errors.js";

export const UPDATE_MANIFEST_MAX_BYTES = 256 * 1024;

export const ROLLBACK_POLICIES = ["rollback_safe", "restore_required", "forward_fix_only"] as const;
export type RollbackPolicy = (typeof ROLLBACK_POLICIES)[number];

export interface ConfigChangeNote {
  /** Config path, e.g. "http.shutdownTimeoutMilliseconds". */
  readonly key: string;
  readonly kind: "added" | "removed" | "type_changed" | "behavior_changed";
  readonly security_relevant: boolean;
  /** For added keys: whether a default exists. */
  readonly has_default?: boolean | undefined;
  readonly description?: string;
}

export interface ReleaseManifestV1 {
  readonly manifest_version: "1";
  readonly version: string;
  readonly release_date?: string | undefined;
  readonly required_runtime: {
    readonly node: string;
    readonly postgres: string;
  };
  /** Core migration names this release may apply (descriptive, not executed). */
  readonly core_db_migrations: readonly string[];
  /**
   * First-party package inventory (ADR-0017 R2): exact version + content
   * digest + migration checksums per shipped package, so update preflight
   * plans extension migrations without executing target code. Optional —
   * manifests predating ADR-0017 omit it (no extension planning).
   */
  readonly first_party_extensions?:
    | readonly {
        readonly id: string;
        readonly version: string;
        readonly content_sha256: string;
        readonly migrations: readonly { readonly name: string; readonly checksum: string }[];
      }[]
    | undefined;
  /** Supported extension contract versions of this release. */
  readonly supports_extension_contracts: readonly string[];
  /** Target values for the system contract keys (subset allowed). */
  readonly contract_versions: Readonly<Record<string, string>>;
  readonly deprecations: readonly {
    readonly id: string;
    readonly usage_key?: string;
    readonly replacement?: string;
    /** Version where the item is removed; removal blocks the update. */
    readonly removed_in?: string;
  }[];
  readonly security_notes: readonly string[];
  readonly manual_steps: readonly string[];
  readonly backup_required: boolean;
  readonly rollback_policy: RollbackPolicy;
  readonly config_changes: readonly ConfigChangeNote[];
}

const MIGRATION_NAME_PATTERN = /^\d{4}_[a-z0-9_]+$/;
const CONTRACT_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const SEMVER_RANGE_MAX_LENGTH = 128;

export const UPDATE_MANIFEST_V1_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://progressive-cms.dev/schemas/release-manifest-v2.json",
  title: "Progressive CMS release manifest v1",
  type: "object",
  additionalProperties: false,
  required: [
    "manifest_version",
    "version",
    "required_runtime",
    "supports_extension_contracts",
    "backup_required",
    "rollback_policy",
  ],
  properties: {
    manifest_version: { const: "1" },
    version: { type: "string", minLength: 1, maxLength: 32 },
    release_date: { type: "string", minLength: 1, maxLength: 32 },
    required_runtime: {
      type: "object",
      additionalProperties: false,
      required: ["node", "postgres"],
      properties: {
        node: { type: "string", minLength: 1, maxLength: SEMVER_RANGE_MAX_LENGTH },
        postgres: { type: "string", minLength: 1, maxLength: SEMVER_RANGE_MAX_LENGTH },
      },
    },
    core_db_migrations: {
      type: "array",
      maxItems: 4096,
      items: { type: "string", pattern: MIGRATION_NAME_PATTERN.source, maxLength: 100 },
    },
    first_party_extensions: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "version", "content_sha256", "migrations"],
        properties: {
          id: {
            type: "string",
            pattern: "^[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)+$",
            maxLength: 130,
          },
          version: { type: "string", minLength: 1, maxLength: 32 },
          content_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          migrations: {
            type: "array",
            maxItems: 256,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "checksum"],
              properties: {
                name: { type: "string", pattern: MIGRATION_NAME_PATTERN.source, maxLength: 100 },
                checksum: { type: "string", pattern: "^[0-9a-f]{64}$" },
              },
            },
          },
        },
      },
    },
    supports_extension_contracts: {
      type: "array",
      maxItems: 16,
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", pattern: "^\\d+\\.\\d+$", maxLength: 16 },
    },
    contract_versions: {
      type: "object",
      maxProperties: 64,
      additionalProperties: { type: "string", minLength: 1, maxLength: 32 },
      propertyNames: { pattern: CONTRACT_KEY_PATTERN.source },
    },
    deprecations: {
      type: "array",
      maxItems: 512,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 200 },
          usage_key: { type: "string", minLength: 1, maxLength: 200 },
          replacement: { type: "string", minLength: 1, maxLength: 200 },
          removed_in: { type: "string", minLength: 1, maxLength: 32 },
        },
      },
    },
    security_notes: {
      type: "array",
      maxItems: 128,
      items: { type: "string", minLength: 1, maxLength: 1000 },
    },
    manual_steps: {
      type: "array",
      maxItems: 128,
      items: { type: "string", minLength: 1, maxLength: 1000 },
    },
    backup_required: { type: "boolean" },
    rollback_policy: { enum: [...ROLLBACK_POLICIES] },
    config_changes: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "kind", "security_relevant"],
        properties: {
          key: { type: "string", minLength: 1, maxLength: 200 },
          kind: { enum: ["added", "removed", "type_changed", "behavior_changed"] },
          security_relevant: { type: "boolean" },
          has_default: { type: "boolean" },
          description: { type: "string", minLength: 1, maxLength: 1000 },
        },
      },
    },
  },
} as const;

export interface UpdateManifestIssue {
  readonly path: string;
  readonly message: string;
}

const ajv = new Ajv({ allErrors: true });
const validateShape = ajv.compile(UPDATE_MANIFEST_V1_SCHEMA);

/**
 * Deterministic, fail-closed validation of a release manifest document.
 * The manifest is data only: the schema has no field that could carry a
 * command, SQL or script, and unknown fields are rejected.
 */
export function validateReleaseManifest(
  input: unknown,
):
  | { readonly ok: true; readonly manifest: ReleaseManifestV1 }
  | { readonly ok: false; readonly issues: readonly UpdateManifestIssue[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      issues: [{ path: "", message: "release manifest must be a JSON object" }],
    };
  }
  if (JSON.stringify(input).length > UPDATE_MANIFEST_MAX_BYTES) {
    return {
      ok: false,
      issues: [
        { path: "", message: `release manifest exceeds ${UPDATE_MANIFEST_MAX_BYTES} bytes` },
      ],
    };
  }
  const doc = input as Record<string, unknown>;
  if (!validateShape(doc)) {
    const issues: UpdateManifestIssue[] = [];
    for (const error of validateShape.errors ?? []) {
      const rawPath = error.instancePath
        .split("/")
        .filter((segment) => segment !== "")
        .map((segment, index) =>
          /^\d+$/.test(segment) ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
        )
        .join("");
      const params = error.params as {
        missingProperty?: string;
        additionalProperty?: string;
      };
      const attached =
        error.keyword === "required"
          ? params.missingProperty
          : error.keyword === "additionalProperties"
            ? params.additionalProperty
            : undefined;
      issues.push({
        path: attached ? `${rawPath ? `${rawPath}.` : ""}${attached}` : rawPath || "(root)",
        message: error.message ?? "invalid value",
      });
    }
    return { ok: false, issues };
  }

  // Semantic layer: real SemVer on versions and runtime ranges.
  const issues: UpdateManifestIssue[] = [];
  const manifest = doc as unknown as ReleaseManifestV1;
  if (!semverValid(manifest.version)) {
    issues.push({ path: "version", message: `"${manifest.version}" is not valid SemVer` });
  }
  for (const key of ["node", "postgres"] as const) {
    const range = manifest.required_runtime[key];
    if (!validRange(range)) {
      issues.push({
        path: `required_runtime.${key}`,
        message: `"${range}" is not a valid SemVer range`,
      });
    }
  }
  if (
    manifest.supports_extension_contracts !== undefined &&
    manifest.supports_extension_contracts.length === 0
  ) {
    issues.push({
      path: "supports_extension_contracts",
      message: "release must support at least one extension contract version",
    });
  }
  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    manifest: {
      manifest_version: "1",
      version: manifest.version,
      release_date: manifest.release_date,
      required_runtime: manifest.required_runtime,
      core_db_migrations: manifest.core_db_migrations ?? [],
      supports_extension_contracts: manifest.supports_extension_contracts,
      contract_versions: manifest.contract_versions ?? {},
      deprecations: manifest.deprecations ?? [],
      security_notes: manifest.security_notes ?? [],
      manual_steps: manifest.manual_steps ?? [],
      backup_required: manifest.backup_required,
      rollback_policy: manifest.rollback_policy,
      config_changes: manifest.config_changes ?? [],
    },
  };
}

/** Fails closed with the stable UPDATE_MANIFEST_INVALID code. */
export function parseReleaseManifest(document: unknown): ReleaseManifestV1 {
  const validation = validateReleaseManifest(document);
  if (!validation.ok) {
    throw new ExtensionError("UPDATE_MANIFEST_INVALID", "release manifest is invalid", {
      details: { issues: validation.issues },
    });
  }
  return validation.manifest;
}
