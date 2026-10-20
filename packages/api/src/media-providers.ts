// Media provider registries (ADR-0013, Media spec §71.2, Extensions spec
// §52.2): the manifest provider registrations `media_stock_provider` and
// `image_generation_provider` become real runtime registries here. Only
// enabled, deployed extensions contribute; instances are resolved lazily
// from the named handler export with validated config (secret-ref slots
// resolved through the injected secret store) and cached briefly, so a
// disable/uninstall takes a provider away within the cache window.
import {
  composeExtensionRegistrations,
  type ExtensionCatalog,
  type ExtensionLifecycleService,
  resolveExtensionConfig,
  resolveHandler,
  validateExtensionConfig,
} from "@pcms/extensions/internal";
import type { ImageGenerationProvider, MediaProvider, MediaStockProvider } from "@pcms/media";
import { ApiError } from "./errors.js";
import { createSecretRefPrefetch } from "./extension-runtime.js";

export type MediaProviderKind = "stock" | "generation";

/** Safe wire metadata — no credential material, no trusted download URLs. */
export interface MediaProviderSummary {
  readonly provider_id: string;
  readonly extension_id: string;
  readonly kind: MediaProviderKind;
  readonly display_name: string;
  readonly configured: boolean;
}

export interface MediaProvidersInput {
  readonly catalog: ExtensionCatalog;
  readonly lifecycle: ExtensionLifecycleService;
  /**
   * Resolves an extension runtime secret slot name (E3 store). Absent ⇒
   * secret-ref slots stay unresolvable ⇒ providers report `configured: false`.
   */
  readonly resolveSecret?: (extensionId: string, refName: string) => Promise<string | undefined>;
}

export interface MediaProvidersService {
  list(): Promise<readonly MediaProviderSummary[]>;
  get(providerId: string): Promise<MediaProviderSummary | null>;
  /** Resolved stock provider instance, or null when absent/not configured. */
  stock(providerId: string): Promise<MediaStockProvider | null>;
  generation(providerId: string): Promise<ImageGenerationProvider | null>;
  /** All configured stock providers, deterministically ordered. */
  stockProviders(): Promise<readonly MediaStockProvider[]>;
  /** All configured generation providers, deterministically ordered. */
  generationProviders(): Promise<readonly ImageGenerationProvider[]>;
  /**
   * Drop cached adapter instances (all, or one extension's). Adapters capture
   * their config snapshot at creation, so every config/secret write MUST
   * invalidate — otherwise a freshly added model or rotated key stays
   * invisible until the next process restart (2026-09-29 prod incident:
   * model added in the Admin never showed up in capabilities).
   */
  invalidate(extensionId?: string): void;
}

interface ProviderRegistration {
  readonly extensionId: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly kind: MediaProviderKind;
  readonly handler: string;
}

function kindOf(registry: string): MediaProviderKind | null {
  if (registry === "media_stock_provider") return "stock";
  if (registry === "image_generation_provider") return "generation";
  return null;
}

export function createMediaProvidersService(input: MediaProvidersInput): MediaProvidersService {
  let cache: readonly ProviderRegistration[] | null = null;
  /** Lifecycle revision the registration cache was built from (R3). */
  let cacheRevision: string | null = null;
  const instances = new Map<string, MediaProvider>();

  /**
   * Prefetches every `$secret_ref` name in the config into a sync map so the
   * (synchronous) `resolveExtensionConfig` can resolve against the async
   * Admin-managed secret store. Unresolvable names stay absent → the ref
   * resolution throws → the provider reports not configured.
   */
  const prefetchSecrets = async (
    extensionId: string,
    config: Record<string, unknown>,
  ): Promise<(name: string) => string | undefined> => {
    const names = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      if (typeof record["$secret_ref"] === "string") names.add(record["$secret_ref"] as string);
      for (const child of Object.values(record)) walk(child);
    };
    walk(config);
    const values = new Map<string, string | undefined>();
    if (input.resolveSecret !== undefined) {
      for (const name of names) values.set(name, await input.resolveSecret(extensionId, name));
    }
    return (name) => values.get(name);
  };

  const registrations = async (fresh: boolean): Promise<readonly ProviderRegistration[]> => {
    // Authoritative revision stamp (ADR-0017 R3): a lifecycle change in THIS
    // or ANOTHER process moves the revision and forces a recompose — the
    // local cache is never trusted across revisions.
    const revision = await input.lifecycle.revision();
    if (!fresh && cache !== null && cacheRevision === revision) return cache;
    const enabledIds = await input.lifecycle.enabledIds();
    const composition = composeExtensionRegistrations(input.catalog, enabledIds);
    const found: ProviderRegistration[] = [];
    for (const registration of composition.registrations) {
      if (registration.kind !== "provider") continue;
      const kind = kindOf(registration.registry);
      if (kind === null) continue;
      found.push({
        extensionId: registration.extensionId,
        providerId: registration.providerId,
        displayName: registration.displayName,
        kind,
        handler: registration.handler,
      });
    }
    cache = found.sort((a, b) =>
      a.providerId === b.providerId
        ? a.extensionId < b.extensionId
          ? -1
          : 1
        : a.providerId < b.providerId
          ? -1
          : 1,
    );
    cacheRevision = revision;
    return cache;
  };

  /** Validated config with secret slots resolved, or null when unconfigured. */
  const resolvedConfig = async (
    registration: ProviderRegistration,
  ): Promise<Record<string, unknown> | null> => {
    const artifact = input.catalog.get(registration.extensionId);
    if (artifact === undefined) return null;
    const installation = await input.lifecycle.getInstallation(registration.extensionId);
    if (installation === undefined || installation.state !== "ENABLED") return null;
    const configCheck = validateConfigSafe(
      registration.extensionId,
      artifact.manifest.config_schema,
      installation.config,
    );
    if (!configCheck.ok) return null;
    try {
      const resolved = resolveExtensionConfig(
        installation.config,
        await prefetchSecrets(registration.extensionId, installation.config),
      );
      // Secret-slot semantics: the slots that COUNT are the ones the stored
      // config actually references via $secret_ref. A schema secret slot that
      // is never referenced (optional proxy_password) must NOT gate
      // «configured» (owner report 0.1.116: key stored, proxy password absent
      // → the provider showed "key not configured" and the connection test answered
      // "enter the key" although everything was saved). A config that
      // references no secret slot at all while the schema declares them is a
      // keyless enabled provider — never configured (owner rule 0.1.115).
      const schemaProps =
        (
          artifact.manifest.config_schema as
            | {
                properties?: Record<string, unknown>;
              }
            | undefined
        )?.properties ?? {};
      const schemaDeclaresSecrets = Object.values(schemaProps).some(
        (schema) => (schema as { format?: string }).format === "secret-ref",
      );
      if (schemaDeclaresSecrets) {
        const referenced = new Set<string>();
        const walk = (node: unknown): void => {
          if (Array.isArray(node)) {
            for (const item of node) walk(item);
            return;
          }
          if (typeof node !== "object" || node === null) return;
          const record = node as Record<string, unknown>;
          if (typeof record["$secret_ref"] === "string") referenced.add(record["$secret_ref"]);
          for (const child of Object.values(record)) walk(child);
        };
        walk(installation.config);
        if (referenced.size === 0) return null;
        if (input.resolveSecret === undefined) return null;
        for (const slot of referenced) {
          if ((await input.resolveSecret(registration.extensionId, slot)) === undefined) {
            return null;
          }
        }
      }
      return resolved;
    } catch {
      // EXTENSION_SECRET_REF_UNRESOLVED (or shape drift): installed but not
      // configured — a safe, inspectable state, never a crash.
      return null;
    }
  };

  const resolveInstance = async (
    registration: ProviderRegistration,
  ): Promise<MediaProvider | null> => {
    const cacheKey = `${registration.extensionId}/${registration.providerId}`;
    const cached = instances.get(cacheKey);
    if (cached !== undefined) return cached;
    const config = await resolvedConfig(registration);
    if (config === null) return null;
    const artifact = input.catalog.get(registration.extensionId);
    if (artifact === undefined) return null;
    const factory = resolveHandler(artifact, registration.handler);
    let instance: unknown;
    try {
      instance = await Promise.resolve((factory as (deps: unknown) => unknown)({ config }));
    } catch (cause) {
      throw new ApiError(
        "PROVIDER_UNAVAILABLE",
        `provider "${registration.providerId}" failed to initialize`,
        { status: 503, cause },
      );
    }
    if (typeof instance !== "object" || instance === null) {
      throw new ApiError(
        "EXTENSION_PROVIDER_INVALID",
        `provider "${registration.providerId}" of extension "${registration.extensionId}" is not a valid provider object`,
        { status: 500 },
      );
    }
    const provider = instance as MediaProvider;
    if (provider.providerId !== registration.providerId) {
      throw new ApiError(
        "EXTENSION_PROVIDER_INVALID",
        `provider id mismatch: registration says "${registration.providerId}", instance says "${provider.providerId}"`,
        { status: 500 },
      );
    }
    instances.set(cacheKey, provider);
    return provider;
  };

  const summaryOf = async (registration: ProviderRegistration): Promise<MediaProviderSummary> => ({
    provider_id: registration.providerId,
    extension_id: registration.extensionId,
    kind: registration.kind,
    display_name: registration.displayName,
    configured: (await resolvedConfig(registration)) !== null,
  });

  return {
    async list() {
      const found = await registrations(false);
      return Promise.all(found.map(summaryOf));
    },
    async get(providerId) {
      const found = (await registrations(false)).filter((entry) => entry.providerId === providerId);
      return found.length === 0 ? null : summaryOf(found[0] as ProviderRegistration);
    },
    async stock(providerId) {
      const registration = (await registrations(false)).find(
        (entry) => entry.providerId === providerId && entry.kind === "stock",
      );
      if (registration === undefined) return null;
      return (await resolveInstance(registration)) as MediaStockProvider | null;
    },
    async generation(providerId) {
      const registration = (await registrations(false)).find(
        (entry) => entry.providerId === providerId && entry.kind === "generation",
      );
      if (registration === undefined) return null;
      return (await resolveInstance(registration)) as ImageGenerationProvider | null;
    },
    async stockProviders() {
      const found = (await registrations(false)).filter((entry) => entry.kind === "stock");
      const resolved = await Promise.all(found.map(resolveInstance));
      return resolved.filter(
        (entry): entry is MediaStockProvider => entry !== null && "search" in entry,
      );
    },
    async generationProviders() {
      const found = (await registrations(false)).filter((entry) => entry.kind === "generation");
      const resolved = await Promise.all(found.map(resolveInstance));
      return resolved.filter(
        (entry): entry is ImageGenerationProvider => entry !== null && "generate" in entry,
      );
    },
    invalidate(extensionId) {
      // Registrations cache drops too: enable/disable/uninstall must be
      // visible immediately, not on the next revision read (same-process
      // fast path; cross-process correctness rides the revision stamp).
      cache = null;
      cacheRevision = null;
      if (extensionId === undefined) {
        instances.clear();
        return;
      }
      for (const key of [...instances.keys()]) {
        if (key.startsWith(`${extensionId}/`)) instances.delete(key);
      }
    },
  };
}

function validateConfigSafe(
  extensionId: string,
  schema: Record<string, unknown> | undefined,
  config: Record<string, unknown>,
): { ok: true } | { ok: false } {
  try {
    return validateExtensionConfig({ extensionId, schema, config }).ok
      ? { ok: true }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}
