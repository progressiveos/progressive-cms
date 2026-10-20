// Shared resolved-runtime view of an installed extension (PCMS-PRE-RESEARCH
// A2): validated config with `$secret_ref` slots resolved through the Admin
// extension runtime secret store. Operation handlers receive this through
// the call context; the provider registries keep their own (cached) path.
import {
  type ExtensionCatalog,
  type ExtensionLifecycleService,
  resolveExtensionConfig,
  validateExtensionConfig,
} from "@pcms/extensions/internal";

export interface ExtensionRuntime {
  readonly id: string;
  /** Validated config with `$secret_ref` slots already resolved to values. */
  readonly config: Record<string, unknown>;
}

export interface ExtensionRuntimeResolverInput {
  readonly catalog: ExtensionCatalog;
  readonly lifecycle: ExtensionLifecycleService;
  /** Resolves an extension runtime secret slot name (E3 store). */
  readonly resolveSecret?: (extensionId: string, refName: string) => Promise<string | undefined>;
}

/** Null = not installed, not enabled, config invalid, or secrets unresolved. */
export type ExtensionRuntimeResolver = (extensionId: string) => Promise<ExtensionRuntime | null>;

/**
 * Shared `$secret_ref` prefetch: collect every ref name in the config,
 * resolve them through the runtime secret store, and return a name → value
 * lookup (unresolvable names stay absent → callers fail closed).
 */
export function createSecretRefPrefetch(
  resolveSecret: ((extensionId: string, name: string) => Promise<string | undefined>) | undefined,
): (
  extensionId: string,
  config: Record<string, unknown>,
) => Promise<(name: string) => string | undefined> {
  return async (extensionId, config) => {
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
    const resolved = new Map<string, string | undefined>();
    for (const name of names) {
      resolved.set(
        name,
        resolveSecret === undefined ? undefined : await resolveSecret(extensionId, name),
      );
    }
    return (name: string) => resolved.get(name);
  };
}

export function createExtensionRuntimeResolver(
  input: ExtensionRuntimeResolverInput,
): ExtensionRuntimeResolver {
  const prefetchSecrets = createSecretRefPrefetch(input.resolveSecret);

  return async (extensionId: string): Promise<ExtensionRuntime | null> => {
    const artifact = input.catalog.get(extensionId);
    if (artifact === undefined) return null;
    const installation = await input.lifecycle.getInstallation(extensionId);
    if (installation === undefined || installation.state !== "ENABLED") return null;
    try {
      if (
        !validateExtensionConfig({
          extensionId,
          schema: artifact.manifest.config_schema,
          config: installation.config,
        }).ok
      ) {
        return null;
      }
      return {
        id: extensionId,
        config: resolveExtensionConfig(
          installation.config,
          await prefetchSecrets(extensionId, installation.config),
        ) as Record<string, unknown>,
      };
    } catch {
      // EXTENSION_SECRET_REF_UNRESOLVED (or shape drift): installed but not
      // configured — a safe, inspectable state, never a crash.
      return null;
    }
  };
}
