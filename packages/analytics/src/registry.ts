// Provider registry (Analytics spec §3): typed, composition-time
// registration only — the trusted/static contribution model. Extension
// provider modules register during composition; Admin input can never add
// provider code.

import { AnalyticsError } from "./settings-schema.js";
import type { AnalyticsTagProviderV1 } from "./types.js";

export interface AnalyticsRegistry {
  registerProvider(provider: AnalyticsTagProviderV1): void;
  get(id: string): AnalyticsTagProviderV1 | null;
  list(): readonly AnalyticsTagProviderV1[];
}

export function createAnalyticsRegistry(): AnalyticsRegistry {
  const byId = new Map<string, AnalyticsTagProviderV1>();
  return {
    registerProvider(provider) {
      if (provider.version !== 1) {
        throw new AnalyticsError(
          "ANALYTICS_PROVIDER_UNKNOWN",
          `unsupported provider contract version: ${String(provider.version)}`,
        );
      }
      if (byId.has(provider.id)) {
        throw new AnalyticsError(
          "ANALYTICS_PROVIDER_UNKNOWN",
          `provider already registered: ${provider.id}`,
        );
      }
      byId.set(provider.id, provider);
    },
    get(id) {
      return byId.get(id) ?? null;
    },
    list() {
      return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    },
  };
}
