// Trusted extension catalog and controlled registration composition
// (PCMS-EXT-T002, Extensions spec §4–§6).
//
// The catalog is the deployment-time source of truth: an artifact enters it
// only through the trusted developer/operator path (never from the database,
// never from an Admin upload). Composition is the only place where
// registrations become live, it is deterministic (sorted by extension id),
// and collisions fail closed — there is no "last registration wins" and no
// arbitrary hook category. A disabled extension contributes nothing.
import { createHash } from "node:crypto";
import { ExtensionError } from "./errors.js";
import { type ExtensionManifest, validateExtensionManifest } from "./manifest.js";

/**
 * A trusted deployed extension artifact. `module` is the already-imported
 * ESM namespace of the artifact (imported by the deployment path — the
 * catalog never receives or evaluates source code). Handlers referenced by
 * manifest registrations are resolved as named exports of this module.
 */
export interface DeployedExtensionArtifact {
  readonly manifest: ExtensionManifest;
  readonly module: Record<string, unknown>;
  /**
   * Extension-owned migration directory, as deployed (manifest declares the
   * relative name; the trusted deployment binds it to a real location).
   */
  readonly migrationsDir: string | undefined;
  /**
   * Deployed package directory (cwd-relative), when the artifact has lock
   * provenance (ADR-0018: view base templates resolve relative to it —
   * package directory names are NOT derived from extension ids).
   */
  readonly extensionsDir: string | undefined;
  /**
   * Content digest of the deployed artifact (lock `content_sha256`, ADR-0017
   * R2 artifact identity — a code change without a manifest bump changes it).
   * Undefined for artifacts without lock provenance (test fixtures).
   */
  readonly contentSha256: string | undefined;
}

export interface ExtensionCatalog {
  /** Registers a deployed artifact; duplicate extension ids fail closed. */
  register(artifact: DeployedExtensionArtifact): void;
  list(): readonly DeployedExtensionArtifact[];
  get(id: string): DeployedExtensionArtifact | undefined;
  has(id: string): boolean;
}

export function createExtensionCatalog(): ExtensionCatalog {
  const byId = new Map<string, DeployedExtensionArtifact>();
  return {
    register(artifact) {
      if (byId.has(artifact.manifest.id)) {
        throw new ExtensionError(
          "EXTENSION_ALREADY_DEPLOYED",
          `extension "${artifact.manifest.id}" is already present in the trusted catalog`,
        );
      }
      byId.set(artifact.manifest.id, artifact);
    },
    list() {
      return [...byId.values()].sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : 1));
    },
    get(id) {
      return byId.get(id);
    },
    has(id) {
      return byId.has(id);
    },
  };
}

/**
 * The trusted deployment boundary: validates a manifest document and binds
 * it to an already-imported module. This is the only supported way to turn
 * a manifest document into a catalog artifact — there is no API that loads
 * code from a path or the database.
 */
export function defineExtensionArtifact(input: {
  readonly extensionsDir?: string;
  readonly manifest: unknown;
  readonly module: Record<string, unknown>;
  /** Real location of the extension's migrations, as deployed. */
  readonly migrationsDir?: string | undefined;
  /** Lock content digest (ADR-0017 R2); bound by the generated catalog. */
  readonly contentSha256?: string | undefined;
}): DeployedExtensionArtifact {
  const validation = validateExtensionManifest(input.manifest);
  if (!validation.ok) {
    throw new ExtensionError("EXTENSION_MANIFEST_INVALID", "extension manifest is invalid", {
      details: { issues: validation.issues },
    });
  }
  const manifest = validation.manifest;
  if (manifest.migrations !== undefined && input.migrationsDir === undefined) {
    throw new ExtensionError(
      "EXTENSION_DEPLOYMENT_INVALID",
      `extension "${manifest.id}" declares migrations but the deployment binds no migrations directory`,
      { details: { extension_id: manifest.id } },
    );
  }
  return {
    manifest,
    module: input.module,
    migrationsDir: input.migrationsDir,
    extensionsDir: input.extensionsDir,
    contentSha256: input.contentSha256,
  };
}

/** Deterministic fingerprint of a validated manifest (canonical JSON + sha256). */
export function manifestFingerprint(manifest: ExtensionManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

/**
 * Resolves a manifest handler reference against the deployed module.
 * Fail-closed: a registration whose handler export is missing or is not a
 * function cannot compose.
 */
export function resolveHandler(
  artifact: DeployedExtensionArtifact,
  handler: string,
): (...args: never[]) => unknown {
  const value = artifact.module[handler];
  if (typeof value !== "function") {
    throw new ExtensionError(
      "EXTENSION_HANDLER_UNRESOLVED",
      `handler "${handler}" of extension "${artifact.manifest.id}" is not a named function export of the deployed module`,
      { details: { extension_id: artifact.manifest.id, handler } },
    );
  }
  return value as (...args: never[]) => unknown;
}

/** Flattened, order-deterministic registration produced by composition. */
export type ComposedRegistration =
  | { readonly kind: "block"; readonly key: string; readonly extensionId: string }
  | { readonly kind: "field_type"; readonly key: string; readonly extensionId: string }
  | {
      readonly kind: "route";
      readonly key: string;
      readonly extensionId: string;
      readonly routeKind: "public" | "system";
    }
  | {
      readonly kind: "event_subscription";
      readonly key: string;
      readonly extensionId: string;
      readonly eventType: string;
      readonly subscriptionId: string;
      readonly handler: string;
    }
  | {
      readonly kind: "job";
      readonly key: string;
      readonly extensionId: string;
      readonly jobId: string;
      readonly handler: string;
      readonly payloadVersion: number;
      readonly acceptsPayloadVersions: readonly number[];
    }
  | {
      readonly kind: "validator";
      readonly key: string;
      readonly extensionId: string;
      readonly point: string;
      readonly validatorId: string;
      readonly handler: string;
    }
  | {
      readonly kind: "provider";
      readonly key: string;
      readonly extensionId: string;
      readonly registry: string;
      readonly providerId: string;
      readonly displayName: string;
      readonly handler: string;
    }
  | {
      readonly kind: "operation";
      readonly key: string;
      readonly extensionId: string;
      readonly operationId: string;
      readonly permission: string;
      readonly mutation: boolean;
      readonly title: string;
      readonly inputSchema: Record<string, unknown>;
      readonly outputSchema: Record<string, unknown>;
      readonly handler: string;
      /** Semantic capability (S4): generic consumers bind to this, not ids. */
      readonly capability: string | undefined;
    }
  | {
      readonly kind: "http_route";
      readonly key: string;
      readonly extensionId: string;
      readonly routeId: string;
      readonly method: string;
      readonly path: string;
      readonly visibility: "public" | "session" | "admin";
      readonly permission: string | undefined;
      readonly handler: string;
      readonly responseSchema: Record<string, unknown> | undefined;
      readonly view: string | undefined;
    }
  | {
      readonly kind: "view";
      readonly key: string;
      readonly extensionId: string;
      readonly viewId: string;
      readonly viewModelSchemaVersion: string;
      readonly viewModelSchema: Record<string, unknown>;
      readonly baseTemplate: string;
    }
  | {
      readonly kind: "sitemap_source";
      readonly key: string;
      readonly extensionId: string;
      readonly sourceId: string;
      readonly handler: string;
    }
  | {
      readonly kind: "search_source";
      readonly key: string;
      readonly extensionId: string;
      readonly sourceId: string;
      readonly handler: string;
    }
  | {
      readonly kind: "media_usage_source";
      readonly key: string;
      readonly extensionId: string;
      readonly sourceId: string;
      readonly handler: string;
    };

export interface ExtensionComposition {
  /** Registrations of all enabled, deployed extensions, deterministically ordered. */
  readonly registrations: readonly ComposedRegistration[];
  /** Extension ids that were enabled but have no deployed artifact. */
  readonly undeployed: readonly string[];
}

function registrationKey(registration: ComposedRegistration): string {
  return registration.key;
}

/**
 * Composes the effective registrations of the given enabled extension ids
 * against the trusted catalog. Only enabled extensions contribute anything;
 * a key collision inside a scope is a hard composition failure (stable code
 * EXTENSION_REGISTRATION_CONFLICT), never a silent override.
 */
export function composeExtensionRegistrations(
  catalog: ExtensionCatalog,
  enabledIds: readonly string[],
): ExtensionComposition {
  const registrations: ComposedRegistration[] = [];
  const undeployed: string[] = [];
  const byScope = new Map<string, Map<string, string>>();

  const claim = (scope: string, key: string, extensionId: string): void => {
    let scopeMap = byScope.get(scope);
    if (scopeMap === undefined) {
      scopeMap = new Map();
      byScope.set(scope, scopeMap);
    }
    const owner = scopeMap.get(key);
    if (owner !== undefined && owner !== extensionId) {
      throw new ExtensionError(
        "EXTENSION_REGISTRATION_CONFLICT",
        `${scope} "${key}" is already registered by extension "${owner}"`,
        { details: { scope, key, owner, challenger: extensionId } },
      );
    }
    scopeMap.set(key, extensionId);
  };

  for (const id of [...enabledIds].sort()) {
    const artifact = catalog.get(id);
    if (artifact === undefined) {
      undeployed.push(id);
      continue;
    }
    const { manifest } = artifact;
    for (const block of manifest.registrations.blocks) {
      claim("block", block.block_type, manifest.id);
      registrations.push({
        kind: "block",
        key: block.block_type,
        extensionId: manifest.id,
      });
    }
    for (const fieldType of manifest.registrations.field_types) {
      claim("field_type", fieldType.type, manifest.id);
      registrations.push({
        kind: "field_type",
        key: fieldType.type,
        extensionId: manifest.id,
      });
    }
    for (const route of manifest.registrations.routes) {
      claim("route", route.route_id, manifest.id);
      registrations.push({
        kind: "route",
        key: route.route_id,
        extensionId: manifest.id,
        routeKind: route.kind,
      });
    }
    for (const subscription of manifest.registrations.event_subscriptions) {
      // Event subscriptions are not exclusive by design (multiple extensions
      // may observe the same fact); uniqueness is per subscription id.
      claim(
        `event_subscription/${subscription.event_type}`,
        subscription.subscription_id,
        manifest.id,
      );
      registrations.push({
        kind: "event_subscription",
        key: `${subscription.event_type}/${subscription.subscription_id}`,
        extensionId: manifest.id,
        eventType: subscription.event_type,
        subscriptionId: subscription.subscription_id,
        handler: subscription.handler,
      });
    }
    for (const job of manifest.registrations.jobs) {
      // Job types carry the extension id prefix, so cross-extension
      // collisions cannot happen; the claim guards duplicates within one
      // manifest.
      claim(`job/${manifest.id}`, job.job_id, manifest.id);
      registrations.push({
        kind: "job",
        key: `${manifest.id}/${job.job_id}`,
        extensionId: manifest.id,
        jobId: job.job_id,
        handler: job.handler,
        payloadVersion: job.payload_version,
        acceptsPayloadVersions: job.accepts_payload_versions ?? [],
      });
    }
    for (const validator of manifest.registrations.validators) {
      claim(`validator/${validator.point}`, validator.validator_id, manifest.id);
      registrations.push({
        kind: "validator",
        key: `${validator.point}/${validator.validator_id}`,
        extensionId: manifest.id,
        point: validator.point,
        validatorId: validator.validator_id,
        handler: validator.handler,
      });
    }
    for (const provider of manifest.registrations.providers) {
      claim(`provider/${provider.registry}`, provider.provider_id, manifest.id);
      registrations.push({
        kind: "provider",
        key: `${provider.registry}/${provider.provider_id}`,
        extensionId: manifest.id,
        registry: provider.registry,
        providerId: provider.provider_id,
        displayName: provider.title ?? provider.provider_id,
        handler: provider.handler,
      });
    }
    for (const operation of manifest.registrations.operations) {
      // Operations are extension-qualified at the transports (route path and
      // MCP tool name both carry the extension id), so uniqueness is scoped
      // per extension.
      claim(`operation/${manifest.id}`, operation.operation_id, manifest.id);
      registrations.push({
        kind: "operation",
        key: `${manifest.id}/${operation.operation_id}`,
        extensionId: manifest.id,
        operationId: operation.operation_id,
        permission: operation.permission,
        mutation: operation.mutation,
        title: operation.title,
        inputSchema: operation.input_schema,
        outputSchema: operation.output_schema,
        handler: operation.handler,
        capability: operation.capability,
      });
    }
    // ---- Extension Contract 2.0 (ADR-0018): routes/views/sources -------------
    for (const route of manifest.registrations.http_routes) {
      // Public canonical URLs come from the site-level mount; uniqueness of
      // the technical identity is per extension.
      claim(`http_route/${manifest.id}`, route.route_id, manifest.id);
      if (route.visibility !== "public") {
        // session/admin routes MUST carry a permission — structural gate
        // here; the permission REGISTRY check lives at the composition root
        // (api context), which owns the platform permission registry.
        if (route.permission === undefined) {
          throw new ExtensionError(
            "EXTENSION_REGISTRATION_CONFLICT",
            `http route "${manifest.id}/${route.route_id}" (${route.visibility}) requires a permission`,
            { details: { scope: "http_route", key: route.route_id, owner: manifest.id } },
          );
        }
      }
      // PREPUBLIC §5: public mutations are a UNIVERSAL contract — the
      // dispatcher enforces origin/rate-limit/guest/idempotency gates for
      // every mutating method; no method restriction here.
      registrations.push({
        kind: "http_route",
        key: `${manifest.id}/${route.route_id}`,
        extensionId: manifest.id,
        routeId: route.route_id,
        method: route.method,
        path: route.path,
        visibility: route.visibility,
        permission: route.permission,
        handler: route.handler,
        responseSchema: route.response_schema,
        view: route.view,
      });
    }
    for (const view of manifest.registrations.views) {
      claim(`view/${manifest.id}`, view.view_id, manifest.id);
      registrations.push({
        kind: "view",
        key: `${manifest.id}/${view.view_id}`,
        extensionId: manifest.id,
        viewId: view.view_id,
        viewModelSchemaVersion: view.view_model_schema_version,
        viewModelSchema: view.view_model_schema,
        baseTemplate: view.base_template,
      });
    }
    for (const source of manifest.registrations.sitemap_sources) {
      claim("sitemap_source", `${manifest.id}/${source.source_id}`, manifest.id);
      registrations.push({
        kind: "sitemap_source",
        key: `${manifest.id}/${source.source_id}`,
        extensionId: manifest.id,
        sourceId: source.source_id,
        handler: source.handler,
      });
    }
    for (const source of manifest.registrations.search_sources) {
      claim("search_source", `${manifest.id}/${source.source_id}`, manifest.id);
      registrations.push({
        kind: "search_source",
        key: `${manifest.id}/${source.source_id}`,
        extensionId: manifest.id,
        sourceId: source.source_id,
        handler: source.handler,
      });
    }
    for (const source of manifest.registrations.media_usage_sources) {
      claim("media_usage_source", `${manifest.id}/${source.source_id}`, manifest.id);
      registrations.push({
        kind: "media_usage_source",
        key: `${manifest.id}/${source.source_id}`,
        extensionId: manifest.id,
        sourceId: source.source_id,
        handler: source.handler,
      });
    }
  }

  registrations.sort((a, b) =>
    a.extensionId === b.extensionId
      ? registrationKey(a) < registrationKey(b)
        ? -1
        : 1
      : a.extensionId < b.extensionId
        ? -1
        : 1,
  );
  return { registrations, undeployed };
}
