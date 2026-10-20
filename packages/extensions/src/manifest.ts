// Extension manifest v2 (CORE-PREPUBLIC-01, public Extension SDK).
//
// The manifest is the machine-readable identity of a trusted deployed
// extension. It is a pure data contract: it never carries executable
// material — no entrypoint paths, no commands, no SQL (the trusted
// deployment catalog binds an extension id to its artifact; handlers are
// named exports, referenced by name only). Validation is deterministic and
// fail-closed: unknown fields are rejected, shapes are bounded, versions are
// real SemVer (the `semver` package, not an ad-hoc parser), and every
// problem carries a stable issue code.
import Ajv from "ajv";
import { valid as semverValid, validRange } from "semver";

/** Version of the extension contract this package implements. */
export const EXTENSION_CONTRACT_VERSION = "2.0";

/** Extension ids starting with a reserved prefix are first-party only. */
const RESERVED_ID_PREFIXES = ["cms.", "pcms."] as const;

/** Reverse-DNS identity, at least two labels: "com.example.gallery". */
const ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/;
/** Capability key: dotted lowercase, e.g. "blocks.gallery", "theme-contract". */
const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9-]{0,62}){0,9}$/;
/** Permission key shape (registry existence is checked at composition). */
const PERMISSION_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,9}$/;
/** Event type shape (M07 outbox event types, e.g. "EntryPublished"). */
const EVENT_TYPE_PATTERN = /^[A-Z][A-Za-z0-9]{0,99}$/;
/**
 * Handler references are plain named exports of the extension's deployed
 * module. Deliberately no ".", "/", ":" or "$" — a manifest can never point
 * at a path, URL or computed member.
 */
const HANDLER_PATTERN = /^[a-z][a-zA-Z0-9_]{0,99}$/;
/** Registration-local identifier (subscription_id, validator_id, …). */
const LOCAL_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9-]{0,62}){0,9}$/;
/** Block type / field type keys reuse the existing M02 key shape. */
const BLOCK_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9-]{0,62}){0,9}$/;
/**
 * Migration directory: a relative path inside the extension artifact. No
 * absolute paths, no ".." segments — the trusted catalog, not the manifest,
 * decides where the artifact lives.
 */
const MIGRATIONS_DIR_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*){0,9}$/;

/** Provider/adapter registries an extension may contribute to. */
export const EXTENSION_PROVIDER_REGISTRIES = [
  "search_provider",
  "media_storage",
  "form_destination",
  "payment_provider",
  "integration_connector",
  // Media acquisition (ADR-0013, Media spec §71): consumed by the media
  // provider registries at composition — not by media storage.
  "media_stock_provider",
  "image_generation_provider",
] as const;
export type ExtensionProviderRegistry = (typeof EXTENSION_PROVIDER_REGISTRIES)[number];

/** Synchronous validator points an extension may contribute to. */
export const EXTENSION_VALIDATOR_POINTS = ["publication", "theme"] as const;
export type ExtensionValidatorPoint = (typeof EXTENSION_VALIDATOR_POINTS)[number];

export interface ExtensionCapabilityRequirement {
  readonly capability: string;
  /** SemVer range the provider must satisfy, e.g. "^1.0.0". */
  readonly range: string;
}

export interface ExtensionCapabilityProvision {
  readonly capability: string;
  /** Exact SemVer version provided, e.g. "1.0.0". */
  readonly version: string;
}

export interface ExtensionBlockRegistration {
  readonly block_type: string;
}

export interface ExtensionFieldTypeRegistration {
  readonly type: string;
}

export interface ExtensionRouteRegistration {
  readonly route_id: string;
  readonly kind: "public" | "system";
}

/** Extension Contract 2.0 (ADR-0018): an extension
 * HTTP route served under the site-level mount assigned by the operator
 * (pcms_extension_route_mounts) — canonical URLs are mount-based
 * (`<mount>/<path>`); the built-in technical mount is "/x/<extensionId>".
 * The path is RELATIVE to the mount ("catalog/:slug"); parameters use
 * ":param", wildcard "/*rest". Public requests use the shared rate limit;
 * mutations also require same-origin, guest identity and idempotency gates.
 * Session/admin carry a registered permission, enforced fail-closed at
 * composition. */
export interface ExtensionHttpRouteRegistration {
  readonly route_id: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly visibility: "public" | "session" | "admin";
  readonly permission?: string;
  readonly handler: string;
  readonly response_schema?: Record<string, unknown>;
  /** view_id of THIS package rendered as the HTML page for this route. */
  readonly view?: string;
}

/** A typed, versioned view model the extension can render through the
 * Theme renderer. `base_template` is a Liquid file INSIDE the artifact —
 * content fragment; the active theme renders it in layout.default unless
 * templates[].accepts_views supplies a theme-owned content fragment. */
export interface ExtensionViewRegistration {
  readonly view_id: string;
  readonly view_model_schema_version: string;
  readonly view_model_schema: Record<string, unknown>;
  readonly base_template: string;
}

/** Named-export contributor for sitemap / search / media-usage surfaces
 * (one registration kind, three distinct ports). */
export interface ExtensionSourceRegistration {
  readonly source_id: string;
  readonly handler: string;
}

/**
 * Search source (PREPUBLIC §2): `handler` builds one document by id;
 * `page_ids_handler` enumerates ids cursor/batch (`pageIds(ctx, cursor,
 * limit) → {ids, cursor}`) so the full reindex covers extension-owned
 * entities through the same Source Contract as Core entries. Required —
 * a search source that cannot enumerate cannot be fully reindexed.
 */
export interface ExtensionSearchSourceRegistration extends ExtensionSourceRegistration {
  readonly page_ids_handler: string;
}

/**
 * Lifecycle obligation (D07): an outstanding unit of work the extension
 * itself tracks (e.g. unexpired reservations, open orders). Core enforces
 * that disable/uninstall is blocked while obligations are outstanding,
 * using a PostgreSQL advisory transaction lock that serializes with the
 * extension's business operations creating those obligations. Core never
 * knows the obligation structure — only the count the extension reports.
 */
export interface ExtensionObligationRegistration {
  /** Local obligation id (unique within this extension). */
  readonly obligation_id: string;
  /** Named export counting outstanding obligations within a transaction.
   * Signature: `(tx: ExtensionTransactionContext) => Promise<number>`.
   * Returns the number of outstanding obligations; greater than zero blocks
   * disable/uninstall. */
  readonly count_handler: string;
  /** PostgreSQL advisory transaction-lock key (bigint). Core takes
   * pg_advisory_xact_lock(lock_key) before calling count_handler, so a
   * concurrent business transaction creating an obligation serializes with
   * the lifecycle change — fail-closed, no race window. */
  readonly lock_key: number;
}

/**
 * Durable background job (PREPUBLIC §4): workers execute the named export
 * through the shared M07 queue — no second queue. Job type is
 * "<extensionId>/<job_id>". `payload_version` is the schema version this
 * handler reads; the platform stamps it into every enqueued job and a job
 * stamped with a version the DEPLOYED handler no longer accepts fails
 * permanently WITHOUT invocation — reading older payload generations is an
 * explicit migration policy: list them in accepts_payload_versions.
 */
export interface ExtensionJobRegistration {
  readonly job_id: string;
  /** Named export of the extension module executing the job. */
  readonly handler: string;
  /** Current payload schema version (positive integer). */
  readonly payload_version: number;
  /** Older payload versions this handler still reads (migration policy). */
  readonly accepts_payload_versions?: readonly number[];
  /**
   * Optional positive interval in seconds. When present, the Core worker
   * re-enqueues this job after every successful run (idempotent per
   * interval, idempotency key scoped to the extension). Absent ⇒ on-demand
   * only (enqueued by API/HTTP/MCP or business code). No per-order job:
   * one schedule per logical recurring task. */
  readonly interval_seconds?: number;
}

/** Shared schema for sitemap / media-usage source registrations. */
const SOURCE_REGISTRATIONS_SCHEMA = {
  type: "array",
  maxItems: 16,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["source_id", "handler"],
    properties: {
      source_id: { type: "string", pattern: LOCAL_ID_PATTERN.source, maxLength: 200 },
      handler: { type: "string", pattern: HANDLER_PATTERN.source, maxLength: 100 },
    },
  },
} as const;

/** Search sources additionally require the enumeration handler. */
const SEARCH_SOURCE_REGISTRATIONS_SCHEMA = {
  type: "array",
  maxItems: 16,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["source_id", "handler", "page_ids_handler"],
    properties: {
      source_id: { type: "string", pattern: LOCAL_ID_PATTERN.source, maxLength: 200 },
      handler: { type: "string", pattern: HANDLER_PATTERN.source, maxLength: 100 },
      page_ids_handler: { type: "string", pattern: HANDLER_PATTERN.source, maxLength: 100 },
    },
  },
} as const;

const JOB_REGISTRATIONS_SCHEMA = {
  type: "array",
  maxItems: 16,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["job_id", "handler", "payload_version"],
    properties: {
      job_id: { type: "string", pattern: LOCAL_ID_PATTERN.source, maxLength: 200 },
      handler: { type: "string", pattern: HANDLER_PATTERN.source, maxLength: 100 },
      payload_version: { type: "integer", minimum: 1, maximum: 1_000_000 },
      accepts_payload_versions: {
        type: "array",
        maxItems: 32,
        items: { type: "integer", minimum: 1, maximum: 1_000_000 },
      },
      interval_seconds: {
        type: "integer",
        minimum: 1,
        maximum: 3_600_000,
      },
    },
  },
} as const;

export interface ExtensionEventSubscription {
  readonly subscription_id: string;
  readonly event_type: string;
  /** Named export of the extension module handling the event. */
  readonly handler: string;
}

export interface ExtensionValidatorRegistration {
  readonly point: ExtensionValidatorPoint;
  readonly validator_id: string;
  /** Named export implementing the typed validator contract. */
  readonly handler: string;
}

export interface ExtensionProviderRegistration {
  readonly registry: ExtensionProviderRegistry;
  readonly provider_id: string;
  /** Optional human display name (Admin provider cards). */
  readonly title?: string;
  /** Named export implementing the typed provider contract. */
  readonly handler: string;
}

/**
 * Typed application-operation contribution (ADR-0013, Extensions spec
 * §52.3): one handler, exposed identically by REST and MCP. Schemas are
 * JSON Schema (draft-07 subset, same keyword whitelist as config_schema);
 * the permission key must exist in the platform registry — composition
 * fails closed otherwise (validation ≠ grant).
 */
export interface ExtensionOperationRegistration {
  readonly operation_id: string;
  readonly permission: string;
  readonly mutation: boolean;
  readonly title: string;
  readonly input_schema: Record<string, unknown>;
  readonly output_schema: Record<string, unknown>;
  /** Named export implementing the operation. */
  readonly handler: string;
  /**
   * Semantic capability this operation fulfils (ADR-0017 S4): generic
   * consumers (Admin media studio, CLI) bind to the CAPABILITY, never to an
   * extension id — e.g. "media.prompt-enhance", "research.search".
   */
  readonly capability?: string;
}

export interface ExtensionRegistrations {
  readonly blocks: readonly ExtensionBlockRegistration[];
  readonly field_types: readonly ExtensionFieldTypeRegistration[];
  readonly routes: readonly ExtensionRouteRegistration[];
  readonly event_subscriptions: readonly ExtensionEventSubscription[];
  readonly validators: readonly ExtensionValidatorRegistration[];
  readonly providers: readonly ExtensionProviderRegistration[];
  readonly operations: readonly ExtensionOperationRegistration[];
  /** Registration collections normalize to empty arrays when omitted. */
  readonly http_routes: readonly ExtensionHttpRouteRegistration[];
  readonly views: readonly ExtensionViewRegistration[];
  readonly sitemap_sources: readonly ExtensionSourceRegistration[];
  readonly search_sources: readonly ExtensionSearchSourceRegistration[];
  readonly media_usage_sources: readonly ExtensionSourceRegistration[];
  readonly jobs: readonly ExtensionJobRegistration[];
  /**
   * Optional lifecycle obligations guard (D07). An extension that declares
   * obligations cannot be disabled/uninstalled while it has outstanding
   * obligations; Core enforces this with a transactional advisory lock that
   * serializes with the extension's own business operations creating them.
   */
  readonly obligations: readonly ExtensionObligationRegistration[];
}

/** Uninstall data policy (PCMS-EXT-T007). Default is the safe "retain". */
export type ExtensionDataPolicy = "retain" | "archive" | "drop";

export interface ExtensionManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly extension_contract: typeof EXTENSION_CONTRACT_VERSION;
  readonly cms_compatibility: string;
  readonly requires: readonly ExtensionCapabilityRequirement[];
  readonly provides: readonly ExtensionCapabilityProvision[];
  readonly permissions: readonly string[];
  readonly config_schema: Record<string, unknown> | undefined;
  readonly migrations: { readonly dir: string } | undefined;
  readonly data_policy: ExtensionDataPolicy;
  readonly entrypoint: { readonly type: "module"; readonly factory?: string };
  /**
   * Namespace this package owns for permission keys (ADR-0017 R1): when
   * declared, the package may declare `<namespace>.*` permission keys beyond
   * the platform registry. Absent ⇒ only platform-registered keys.
   */
  readonly permission_namespace?: string;
  /**
   * Bilingual operator-facing description (ADR-0017 S4): Admin renders it per
   * locale instead of keeping per-extension i18n dictionaries in Core.
   */
  readonly description?: { readonly ru: string; readonly en: string };
  /** Admin icon key (Icon registry); unknown keys fall back to the generic icon. */
  readonly icon?: string;
  /**
   * The package ships Admin UI contributions in `admin/index.ts`
   * (ADR-0017 S6 UI contract): registerAdminContributions(api) registers
   * nav/routes/translations, runtime-gated by the extension's enabled state.
   */
  readonly admin_contributions?: true;
  readonly registrations: ExtensionRegistrations;
}

/** The published JSON Schema (draft-07) for extension manifest documents. */
export const EXTENSION_MANIFEST_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://progressive-cms.dev/schemas/extension-manifest-v2.json",
  title: "Progressive CMS extension manifest v2",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "version",
    "extension_contract",
    "cms_compatibility",
    "entrypoint",
    "registrations",
  ],
  properties: {
    id: { type: "string", pattern: ID_PATTERN.source, maxLength: 200 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    version: { type: "string", minLength: 1, maxLength: 32 },
    extension_contract: { const: EXTENSION_CONTRACT_VERSION },
    cms_compatibility: { type: "string", minLength: 1, maxLength: 128 },
    requires: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["capability", "range"],
        properties: {
          capability: { type: "string", pattern: CAPABILITY_PATTERN.source, maxLength: 200 },
          range: { type: "string", minLength: 1, maxLength: 128 },
        },
      },
    },
    provides: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["capability", "version"],
        properties: {
          capability: { type: "string", pattern: CAPABILITY_PATTERN.source, maxLength: 200 },
          version: { type: "string", minLength: 1, maxLength: 32 },
        },
      },
    },
    permissions: {
      type: "array",
      maxItems: 64,
      items: { type: "string", pattern: PERMISSION_PATTERN.source, maxLength: 200 },
    },
    config_schema: { type: "object", additionalProperties: true },
    migrations: {
      type: "object",
      additionalProperties: false,
      required: ["dir"],
      properties: {
        dir: { type: "string", pattern: MIGRATIONS_DIR_PATTERN.source, maxLength: 200 },
      },
    },
    data_policy: { enum: ["retain", "archive", "drop"] },
    permission_namespace: {
      type: "string",
      pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
      maxLength: 64,
    },
    description: {
      type: "object",
      additionalProperties: false,
      required: ["ru", "en"],
      properties: {
        ru: { type: "string", minLength: 1, maxLength: 300 },
        en: { type: "string", minLength: 1, maxLength: 300 },
      },
    },
    icon: { type: "string", pattern: "^[a-z][a-z0-9-]{0,40}$" },
    admin_contributions: { const: true },
    entrypoint: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: { const: "module" },
        factory: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]*$", maxLength: 100 },
      },
    },
    registrations: {
      type: "object",
      additionalProperties: false,
      properties: {
        blocks: {
          type: "array",
          maxItems: 128,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["block_type"],
            properties: {
              block_type: { type: "string", pattern: BLOCK_TYPE_PATTERN.source, maxLength: 200 },
            },
          },
        },
        field_types: {
          type: "array",
          maxItems: 128,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type"],
            properties: {
              type: { type: "string", pattern: BLOCK_TYPE_PATTERN.source, maxLength: 200 },
            },
          },
        },
        routes: {
          type: "array",
          maxItems: 128,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["route_id", "kind"],
            properties: {
              route_id: { type: "string", pattern: LOCAL_ID_PATTERN.source, maxLength: 200 },
              kind: { enum: ["public", "system"] },
            },
          },
        },
        event_subscriptions: {
          type: "array",
          maxItems: 128,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["subscription_id", "event_type", "handler"],
            properties: {
              subscription_id: {
                type: "string",
                pattern: LOCAL_ID_PATTERN.source,
                maxLength: 200,
              },
              event_type: { type: "string", pattern: EVENT_TYPE_PATTERN.source, maxLength: 100 },
              handler: { type: "string", pattern: HANDLER_PATTERN.source, maxLength: 100 },
            },
          },
        },
        validators: {
          type: "array",
          maxItems: 128,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["point", "validator_id", "handler"],
            properties: {
              point: { enum: [...EXTENSION_VALIDATOR_POINTS] },
              validator_id: { type: "string", pattern: LOCAL_ID_PATTERN.source, maxLength: 200 },
              handler: { type: "string", pattern: HANDLER_PATTERN.source, maxLength: 100 },
            },
          },
        },
        providers: {
          type: "array",
          maxItems: 128,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["registry", "provider_id", "handler"],
            properties: {
              registry: { enum: [...EXTENSION_PROVIDER_REGISTRIES] },
              provider_id: { type: "string", pattern: LOCAL_ID_PATTERN.source, maxLength: 200 },
              title: { type: "string", minLength: 1, maxLength: 200 },
              handler: { type: "string", pattern: HANDLER_PATTERN.source, maxLength: 100 },
            },
          },
        },
        operations: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "operation_id",
              "permission",
              "mutation",
              "title",
              "input_schema",
              "output_schema",
              "handler",
            ],
            properties: {
              operation_id: { type: "string", pattern: LOCAL_ID_PATTERN.source, maxLength: 200 },
              permission: { type: "string", pattern: PERMISSION_PATTERN.source, maxLength: 200 },
              mutation: { type: "boolean" },
              title: { type: "string", minLength: 1, maxLength: 200 },
              input_schema: { type: "object", additionalProperties: true },
              output_schema: { type: "object", additionalProperties: true },
              handler: { type: "string", pattern: HANDLER_PATTERN.source, maxLength: 100 },
              capability: { type: "string", pattern: CAPABILITY_PATTERN.source, maxLength: 100 },
            },
          },
        },
        http_routes: {
          type: "array",
          maxItems: 128,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["route_id", "method", "path", "visibility", "handler"],
            properties: {
              route_id: { type: "string", pattern: LOCAL_ID_PATTERN.source, maxLength: 200 },
              method: { enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
              path: {
                type: "string",
                pattern: "^[a-z0-9][a-z0-9_\\-/:*]*$|^\\*rest$",
                maxLength: 300,
              },
              visibility: { enum: ["public", "session", "admin"] },
              permission: { type: "string", pattern: PERMISSION_PATTERN.source, maxLength: 200 },
              handler: { type: "string", pattern: HANDLER_PATTERN.source, maxLength: 100 },
              response_schema: { type: "object", additionalProperties: true },
              view: { type: "string", pattern: LOCAL_ID_PATTERN.source, maxLength: 200 },
            },
          },
        },
        views: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "view_id",
              "view_model_schema_version",
              "view_model_schema",
              "base_template",
            ],
            properties: {
              view_id: { type: "string", pattern: LOCAL_ID_PATTERN.source, maxLength: 200 },
              view_model_schema_version: {
                type: "string",
                pattern: "^\\d+\\.\\d+\\.\\d+$",
                maxLength: 32,
              },
              view_model_schema: { type: "object", additionalProperties: true },
              base_template: {
                type: "string",
                pattern: "^[a-zA-Z0-9][a-zA-Z0-9._\\-/]*$",
                maxLength: 300,
              },
            },
          },
        },
        sitemap_sources: SOURCE_REGISTRATIONS_SCHEMA,
        search_sources: SEARCH_SOURCE_REGISTRATIONS_SCHEMA,
        media_usage_sources: SOURCE_REGISTRATIONS_SCHEMA,
        jobs: JOB_REGISTRATIONS_SCHEMA,
        obligations: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["obligation_id", "count_handler", "lock_key"],
            properties: {
              obligation_id: { type: "string", pattern: LOCAL_ID_PATTERN.source, maxLength: 200 },
              count_handler: { type: "string", pattern: HANDLER_PATTERN.source, maxLength: 100 },
              lock_key: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
            },
          },
        },
      },
    },
  },
} as const;

export const EXTENSION_MANIFEST_ISSUE_CODES = [
  "MANIFEST_NOT_OBJECT",
  "MANIFEST_UNKNOWN_FIELD",
  "MANIFEST_REQUIRED_FIELD_MISSING",
  "MANIFEST_ID_INVALID",
  "MANIFEST_ID_RESERVED",
  "MANIFEST_NAME_INVALID",
  "MANIFEST_VERSION_INVALID",
  "MANIFEST_CONTRACT_UNSUPPORTED",
  "MANIFEST_CMS_COMPATIBILITY_INVALID",
  "MANIFEST_REQUIRES_INVALID",
  "MANIFEST_PROVIDES_INVALID",
  "MANIFEST_PERMISSIONS_INVALID",
  "MANIFEST_CONFIG_SCHEMA_INVALID",
  "MANIFEST_MIGRATIONS_INVALID",
  "MANIFEST_DATA_POLICY_INVALID",
  "MANIFEST_ENTRYPOINT_INVALID",
  "MANIFEST_REGISTRATIONS_INVALID",
  "MANIFEST_DUPLICATE",
  "MANIFEST_TOO_LARGE",
] as const;

export type ExtensionManifestIssueCode = (typeof EXTENSION_MANIFEST_ISSUE_CODES)[number];

export interface ExtensionManifestIssue {
  readonly code: ExtensionManifestIssueCode;
  /** Dotted path inside the manifest document, e.g. "requires[0].range". */
  readonly path: string;
  readonly message: string;
}

export type ExtensionManifestValidation =
  | { readonly ok: true; readonly manifest: ExtensionManifest }
  | { readonly ok: false; readonly issues: readonly ExtensionManifestIssue[] };

/** Serialized manifest size bound — manifests are small identity documents. */
export const EXTENSION_MANIFEST_MAX_BYTES = 256 * 1024;

/** JSON Schema keyword subset allowed inside extension config schemas. */
const CONFIG_SCHEMA_ALLOWED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
  "format",
  "default",
  "description",
  "title",
  "anyOf",
  "allOf",
  "oneOf",
]);

function configSchemaIssues(schema: unknown, path: string, issues: ExtensionManifestIssue[]): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    issues.push({
      code: "MANIFEST_CONFIG_SCHEMA_INVALID",
      path,
      message: "config schema must be a JSON object",
    });
    return;
  }
  for (const [key, value] of Object.entries(schema)) {
    if (!CONFIG_SCHEMA_ALLOWED_KEYWORDS.has(key)) {
      issues.push({
        code: "MANIFEST_CONFIG_SCHEMA_INVALID",
        path: path ? `${path}.${key}` : key,
        message: `config schema keyword "${key}" is outside the supported manifest subset`,
      });
      continue;
    }
    if (key === "properties" || key === "additionalProperties") {
      if (key === "properties" && typeof value === "object" && value !== null) {
        for (const [name, child] of Object.entries(value)) {
          configSchemaIssues(child, `${path}.properties.${name}`, issues);
        }
      } else if (key === "additionalProperties" && typeof value === "object" && value !== null) {
        configSchemaIssues(value, `${path}.additionalProperties`, issues);
      }
    } else if ((key === "anyOf" || key === "allOf" || key === "oneOf") && Array.isArray(value)) {
      for (const [index, child] of value.entries()) {
        configSchemaIssues(child, `${path}.${key}[${index}]`, issues);
      }
    } else if (key === "items" && typeof value === "object" && value !== null) {
      configSchemaIssues(value, `${path}.items`, issues);
    }
  }
}

interface ValidationResult {
  readonly issues: ExtensionManifestIssue[];
}

/** Coarse stable code for a structural (ajv) failure at a manifest path. */
function structuralCode(path: string, keyword: string): ExtensionManifestIssueCode {
  if (keyword === "required") return "MANIFEST_REQUIRED_FIELD_MISSING";
  if (keyword === "additionalProperties") return "MANIFEST_UNKNOWN_FIELD";
  const segment = path.split(/[.[]/, 1)[0] ?? "";
  const byField: Record<string, ExtensionManifestIssueCode> = {
    id: "MANIFEST_ID_INVALID",
    name: "MANIFEST_NAME_INVALID",
    version: "MANIFEST_VERSION_INVALID",
    extension_contract: "MANIFEST_CONTRACT_UNSUPPORTED",
    cms_compatibility: "MANIFEST_CMS_COMPATIBILITY_INVALID",
    requires: "MANIFEST_REQUIRES_INVALID",
    provides: "MANIFEST_PROVIDES_INVALID",
    permissions: "MANIFEST_PERMISSIONS_INVALID",
    config_schema: "MANIFEST_CONFIG_SCHEMA_INVALID",
    migrations: "MANIFEST_MIGRATIONS_INVALID",
    data_policy: "MANIFEST_DATA_POLICY_INVALID",
    entrypoint: "MANIFEST_ENTRYPOINT_INVALID",
    registrations: "MANIFEST_REGISTRATIONS_INVALID",
  };
  return byField[segment] ?? "MANIFEST_NOT_OBJECT";
}

const ajv = new Ajv({ allErrors: true });
const validateShape = ajv.compile(EXTENSION_MANIFEST_SCHEMA);

/**
 * Deterministic, fail-closed validation of an extension manifest document.
 * Returns every problem found (structural + semantic) instead of the first.
 * On success the manifest is normalized: registration arrays and optional
 * fields are materialized so consumers never see undefined collections.
 */
export function validateExtensionManifest(input: unknown): ExtensionManifestValidation {
  const issues: ValidationResult["issues"] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      issues: [
        { code: "MANIFEST_NOT_OBJECT", path: "", message: "manifest must be a JSON object" },
      ],
    };
  }
  if (JSON.stringify(input).length > EXTENSION_MANIFEST_MAX_BYTES) {
    return {
      ok: false,
      issues: [
        {
          code: "MANIFEST_TOO_LARGE",
          path: "",
          message: `manifest exceeds ${EXTENSION_MANIFEST_MAX_BYTES} bytes`,
        },
      ],
    };
  }
  const doc = input as Record<string, unknown>;
  if (!validateShape(doc)) {
    for (const error of validateShape.errors ?? []) {
      const rawPath = error.instancePath
        .split("/")
        .filter((segment) => segment !== "")
        .map((segment, index) =>
          /^\d+$/.test(segment) ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
        )
        .join("");
      const params = error.params as { missingProperty?: string; additionalProperty?: string };
      const attached =
        error.keyword === "required"
          ? params.missingProperty
          : error.keyword === "additionalProperties"
            ? params.additionalProperty
            : undefined;
      const path = attached ? `${rawPath ? `${rawPath}.` : ""}${attached}` : rawPath || "(root)";
      issues.push({
        code: structuralCode(path, error.keyword),
        path,
        message: error.message ?? "invalid value",
      });
    }
    return { ok: false, issues };
  }

  // ---- semantic layer: SemVer, reserved ids, duplicates, safe shapes ----
  const manifest = doc as unknown as ExtensionManifest;
  if (!semverValid(manifest.version)) {
    issues.push({
      code: "MANIFEST_VERSION_INVALID",
      path: "version",
      message: `version "${manifest.version}" is not valid SemVer`,
    });
  }
  if (!validRange(manifest.cms_compatibility)) {
    issues.push({
      code: "MANIFEST_CMS_COMPATIBILITY_INVALID",
      path: "cms_compatibility",
      message: `"${manifest.cms_compatibility}" is not a valid Core SemVer range`,
    });
  }
  if (RESERVED_ID_PREFIXES.some((prefix) => manifest.id.startsWith(prefix))) {
    issues.push({
      code: "MANIFEST_ID_RESERVED",
      path: "id",
      message: `extension id prefix is reserved for first-party extensions (${RESERVED_ID_PREFIXES.join(", ")})`,
    });
  }
  const requires = manifest.requires ?? [];
  requires.forEach((req, index) => {
    if (!validRange(req.range)) {
      issues.push({
        code: "MANIFEST_REQUIRES_INVALID",
        path: `requires[${index}].range`,
        message: `"${req.range}" is not a valid SemVer range`,
      });
    }
  });
  const providedKeys = new Set<string>();
  (manifest.provides ?? []).forEach((prov, index) => {
    if (!semverValid(prov.version)) {
      issues.push({
        code: "MANIFEST_PROVIDES_INVALID",
        path: `provides[${index}].version`,
        message: `"${prov.version}" is not valid SemVer`,
      });
    }
    if (providedKeys.has(prov.capability)) {
      issues.push({
        code: "MANIFEST_DUPLICATE",
        path: `provides[${index}].capability`,
        message: `capability "${prov.capability}" provided more than once`,
      });
    }
    providedKeys.add(prov.capability);
  });
  const requiredKeys = new Set<string>();
  requires.forEach((req, index) => {
    if (requiredKeys.has(req.capability)) {
      issues.push({
        code: "MANIFEST_DUPLICATE",
        path: `requires[${index}].capability`,
        message: `capability "${req.capability}" required more than once`,
      });
    }
    requiredKeys.add(req.capability);
  });
  if (
    manifest.permissions !== undefined &&
    new Set(manifest.permissions).size !== manifest.permissions.length
  ) {
    issues.push({
      code: "MANIFEST_DUPLICATE",
      path: "permissions",
      message: "permission key listed more than once",
    });
  }
  if (manifest.config_schema !== undefined) {
    configSchemaIssues(manifest.config_schema, "config_schema", issues);
  }
  if (manifest.migrations !== undefined && !MIGRATIONS_DIR_PATTERN.test(manifest.migrations.dir)) {
    issues.push({
      code: "MANIFEST_MIGRATIONS_INVALID",
      path: "migrations.dir",
      message: "migrations.dir must be a relative directory inside the extension artifact",
    });
  }
  const registrations = manifest.registrations ?? {};
  const uniqueBy = <T>(items: readonly T[], key: (item: T) => string, label: string): void => {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (seen.has(key(item))) {
        issues.push({
          code: "MANIFEST_DUPLICATE",
          path: `registrations[${label}][${index}]`,
          message: `duplicate registration "${key(item)}"`,
        });
      }
      seen.add(key(item));
    }
  };
  const regs = registrations as Partial<ExtensionRegistrations> | undefined;
  uniqueBy(regs?.blocks ?? [], (b) => b.block_type, "blocks");
  uniqueBy(regs?.field_types ?? [], (f) => f.type, "field_types");
  uniqueBy(regs?.routes ?? [], (r) => r.route_id, "routes");
  uniqueBy(regs?.event_subscriptions ?? [], (s) => s.subscription_id, "event_subscriptions");
  uniqueBy(regs?.validators ?? [], (v) => `${v.point}/${v.validator_id}`, "validators");
  uniqueBy(regs?.providers ?? [], (p) => `${p.registry}/${p.provider_id}`, "providers");
  uniqueBy(regs?.operations ?? [], (o) => o.operation_id, "operations");
  uniqueBy(regs?.jobs ?? [], (j) => j.job_id, "jobs");
  uniqueBy(regs?.obligations ?? [], (o) => o.obligation_id, "obligations");
  (regs?.operations ?? []).forEach((operation, index) => {
    // Operation I/O schemas use the same bounded JSON Schema subset as
    // config schemas — fail closed on keywords the runtime cannot honor.
    configSchemaIssues(
      operation.input_schema,
      `registrations.operations[${index}].input_schema`,
      issues,
    );
    configSchemaIssues(
      operation.output_schema,
      `registrations.operations[${index}].output_schema`,
      issues,
    );
  });

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    manifest: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      extension_contract: EXTENSION_CONTRACT_VERSION,
      cms_compatibility: manifest.cms_compatibility,
      requires,
      provides: manifest.provides ?? [],
      permissions: manifest.permissions ?? [],
      config_schema: manifest.config_schema,
      migrations: manifest.migrations,
      data_policy: manifest.data_policy ?? "retain",
      entrypoint:
        manifest.entrypoint?.factory === undefined
          ? { type: "module" }
          : { type: "module", factory: manifest.entrypoint.factory },
      ...(manifest.permission_namespace === undefined
        ? {}
        : { permission_namespace: manifest.permission_namespace }),
      ...(manifest.description === undefined ? {} : { description: manifest.description }),
      ...(manifest.icon === undefined ? {} : { icon: manifest.icon }),
      ...(manifest.admin_contributions === undefined
        ? {}
        : { admin_contributions: manifest.admin_contributions }),
      registrations: {
        blocks: regs?.blocks ?? [],
        field_types: regs?.field_types ?? [],
        routes: regs?.routes ?? [],
        event_subscriptions: regs?.event_subscriptions ?? [],
        validators: regs?.validators ?? [],
        providers: regs?.providers ?? [],
        operations: regs?.operations ?? [],
        http_routes: regs?.http_routes ?? [],
        views: regs?.views ?? [],
        sitemap_sources: regs?.sitemap_sources ?? [],
        search_sources: regs?.search_sources ?? [],
        media_usage_sources: regs?.media_usage_sources ?? [],
        jobs: regs?.jobs ?? [],
        obligations: regs?.obligations ?? [],
      },
    },
  };
}
