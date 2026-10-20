// Extension config namespacing (PCMS-EXT-T004, Extensions spec §32).
//
// Extension configuration is typed by the extension's own manifest config
// schema and stored per extension id — an extension can never write global
// PCMS_* configuration, and two extensions may safely use the same local
// key. Secret material never lives in the config document: a secret slot
// (schema `format: "secret-ref"`) holds a reference object, the value is
// resolved in memory only, and plaintext in a secret slot is rejected.
import Ajv, { type ValidateFunction } from "ajv";
import { ExtensionError } from "./errors.js";

/** Bound size of a stored extension config document. */
export const EXTENSION_CONFIG_MAX_BYTES = 64 * 1024;

/** Reference name shape: namespaced, bounded, no whitespace. */
const SECRET_REF_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export interface ExtensionConfigIssue {
  /** Dotted path inside the config document, e.g. "bot.token". */
  readonly path: string;
  readonly message: string;
}

export type ExtensionConfigValidation =
  | { readonly ok: true; readonly config: Record<string, unknown> }
  | { readonly ok: false; readonly issues: readonly ExtensionConfigIssue[] };

/**
 * Rewrites `format: "secret-ref"` string schemas into the exact accepted
 * shape — a reference object `{"$secret_ref": "name"}` and nothing else.
 * Plaintext in a secret slot can therefore never validate.
 */
function materializeSecretRefs(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(materializeSecretRefs);
  if (typeof schema !== "object" || schema === null) return schema;
  const record = schema as Record<string, unknown>;
  if (record.format === "secret-ref") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["$secret_ref"],
      properties: {
        $secret_ref: { type: "string", pattern: SECRET_REF_NAME.source, maxLength: 128 },
      },
    };
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "properties" && typeof value === "object" && value !== null) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, materializeSecretRefs(child)]),
      );
    } else if (key === "items") {
      out[key] = materializeSecretRefs(value);
    } else if ((key === "anyOf" || key === "allOf" || key === "oneOf") && Array.isArray(value)) {
      out[key] = value.map(materializeSecretRefs);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Collects the dotted config paths whose schema slot declares
 * `format: "secret-ref"` — references are legal exactly there.
 */
function collectSecretRefPaths(schema: unknown, prefix: string, into: Set<string>): void {
  if (Array.isArray(schema)) {
    for (const child of schema) collectSecretRefPaths(child, prefix, into);
    return;
  }
  if (typeof schema !== "object" || schema === null) return;
  const record = schema as Record<string, unknown>;
  if (record.format === "secret-ref") into.add(prefix);
  const properties = record.properties;
  if (typeof properties === "object" && properties !== null) {
    for (const [name, child] of Object.entries(properties)) {
      collectSecretRefPaths(child, prefix ? `${prefix}.${name}` : name, into);
    }
  }
  if (record.items !== undefined) collectSecretRefPaths(record.items, prefix, into);
  for (const key of ["anyOf", "allOf", "oneOf"] as const) {
    if (Array.isArray(record[key])) {
      for (const child of record[key] as unknown[]) collectSecretRefPaths(child, prefix, into);
    }
  }
}

/** Rejects `$secret_ref` objects outside declared secret slots. */
function misplacedRefIssues(
  value: unknown,
  path: string,
  secretPaths: Set<string>,
): ExtensionConfigIssue[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      misplacedRefIssues(item, `${path}[${index}]`, secretPaths),
    );
  }
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  if ("$secret_ref" in record) {
    if (secretPaths.has(path)) return [];
    return [
      {
        path,
        message:
          'secret references are only allowed in schema slots declared with format "secret-ref"',
      },
    ];
  }
  return Object.entries(record).flatMap(([key, child]) =>
    misplacedRefIssues(child, path ? `${path}.${key}` : key, secretPaths),
  );
}

const ajv = new Ajv({ allErrors: true });
const compiledSchemas = new Map<string, ValidateFunction>();

function compileCached(schema: Record<string, unknown>): ValidateFunction {
  const canonical = JSON.stringify(schema);
  const cached = compiledSchemas.get(canonical);
  if (cached) return cached;
  const compiled = ajv.compile(materializeSecretRefs(schema) as Record<string, unknown>);
  compiledSchemas.set(canonical, compiled);
  return compiled;
}

/**
 * Deterministic validation of an extension config document against the
 * manifest's config schema. Fail-closed: unknown problems reject, secrets
 * are accepted only as references, plaintext never passes a secret slot.
 */
export function validateExtensionConfig(input: {
  readonly extensionId: string;
  readonly config: unknown;
  readonly schema: Record<string, unknown> | undefined;
}): ExtensionConfigValidation {
  const { extensionId, config, schema } = input;
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return {
      ok: false,
      issues: [{ path: "", message: "extension config must be a JSON object" }],
    };
  }
  if (JSON.stringify(config).length > EXTENSION_CONFIG_MAX_BYTES) {
    return {
      ok: false,
      issues: [
        { path: "", message: `extension config exceeds ${EXTENSION_CONFIG_MAX_BYTES} bytes` },
      ],
    };
  }
  if (schema === undefined) {
    if (Object.keys(config).length > 0) {
      return {
        ok: false,
        issues: [
          {
            path: "",
            message: `extension "${extensionId}" declares no config schema and must be configured with an empty object`,
          },
        ],
      };
    }
    return { ok: true, config: {} };
  }
  const secretPaths = new Set<string>();
  collectSecretRefPaths(schema, "", secretPaths);
  const refIssues = misplacedRefIssues(config, "", secretPaths);
  if (refIssues.length > 0) return { ok: false, issues: refIssues };
  const validate = compileCached(schema);
  if (!validate(config)) {
    const issues: ExtensionConfigIssue[] = [];
    for (const error of validate.errors ?? []) {
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
      const path = attached ? `${rawPath ? `${rawPath}.` : ""}${attached}` : rawPath || "(root)";
      issues.push({ path, message: error.message ?? "invalid value" });
    }
    return { ok: false, issues };
  }
  return { ok: true, config: config as Record<string, unknown> };
}

/**
 * Resolves secret references against a resolver (the existing M01 secret
 * channel). The resolved document exists only in memory for the extension's
 * runtime context — it must never be persisted, logged or serialized; the
 * stored config keeps the references.
 */
export function resolveExtensionConfig(
  config: Record<string, unknown>,
  resolveSecret: (name: string) => string | undefined,
): Record<string, unknown> {
  const walk = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}[${index}]`));
    if (typeof value !== "object" || value === null) return value;
    const record = value as Record<string, unknown>;
    if ("$secret_ref" in record) {
      const name = record.$secret_ref;
      if (typeof name !== "string" || !SECRET_REF_NAME.test(name)) {
        throw new ExtensionError(
          "EXTENSION_CONFIG_INVALID",
          `invalid secret reference at "${path}"`,
          { details: { extension_path: path } },
        );
      }
      const resolved = resolveSecret(name);
      if (resolved === undefined) {
        throw new ExtensionError(
          "EXTENSION_SECRET_REF_UNRESOLVED",
          `secret reference "${name}" cannot be resolved from the configured secret channel`,
          { details: { secret_ref: name } },
        );
      }
      return resolved;
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [
        key,
        walk(child, path ? `${path}.${key}` : key),
      ]),
    );
  };
  return walk(config, "") as Record<string, unknown>;
}

/**
 * Per-extension config space: documents live under their extension id, so
 * identical local keys in different extensions never collide, and no
 * extension gains access to another extension's config or to global
 * PCMS_* configuration.
 */
export interface ExtensionConfigSpace {
  set(extensionId: string, config: Record<string, unknown>): void;
  get(extensionId: string): Record<string, unknown> | undefined;
  ids(): readonly string[];
}

export function createExtensionConfigSpace(): ExtensionConfigSpace {
  const byId = new Map<string, Record<string, unknown>>();
  return {
    set(extensionId, config) {
      byId.set(extensionId, config);
    },
    get(extensionId) {
      return byId.get(extensionId);
    },
    ids() {
      return [...byId.keys()].sort();
    },
  };
}
