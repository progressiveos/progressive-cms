// Capability registry (PCMS-EXT-T003, Extensions spec §14).
//
// A capability is machine-readable identity: key + version + provider
// source. Extensions declare requirements with SemVer ranges; resolution is
// deterministic and fail-closed — there is no silent "some provider wins".
// Multiple providers for one capability are only possible where the
// capability is explicitly registered as multi-provider.
import { satisfies, valid as semverValid, validRange } from "semver";
import { ExtensionError } from "./errors.js";

export interface CapabilityProvision {
  readonly key: string;
  /** Exact SemVer version provided. */
  readonly version: string;
  /** Provider source: extension id or a "cms:*" system source. */
  readonly provider: string;
  /** Explicit multi-provider declaration of the extension point. */
  readonly multi: boolean;
}

export interface CapabilityRegistry {
  /**
   * Registers a capability provision. A second provider for a
   * single-provider capability fails closed (EXTENSION_CAPABILITY_CONFLICT).
   */
  provide(input: { key: string; version: string; provider: string; multi?: boolean }): void;
  has(key: string): boolean;
  providers(key: string): readonly CapabilityProvision[];
  /** Deterministic discovery: sorted by key, then provider. */
  list(): readonly CapabilityProvision[];
}

export function createCapabilityRegistry(): CapabilityRegistry {
  const byKey = new Map<string, CapabilityProvision[]>();
  return {
    provide(input) {
      if (!semverValid(input.version)) {
        throw new ExtensionError(
          "EXTENSION_CAPABILITY_CONFLICT",
          `capability "${input.key}" version "${input.version}" is not valid SemVer`,
          { details: { capability: input.key, provider: input.provider } },
        );
      }
      const existing = byKey.get(input.key) ?? [];
      // Multi-provider is an explicit property of the capability itself; a
      // capability is multi only if every provision (including the new one)
      // declares it. Everything else conflicts.
      if (existing.length > 0 && (input.multi !== true || existing.some((p) => !p.multi))) {
        throw new ExtensionError(
          "EXTENSION_CAPABILITY_CONFLICT",
          `capability "${input.key}" already provided by "${existing.map((p) => p.provider).join(", ")}" and is not a multi-provider capability`,
          { details: { capability: input.key, challenger: input.provider } },
        );
      }
      byKey.set(input.key, [
        ...existing,
        {
          key: input.key,
          version: input.version,
          provider: input.provider,
          multi: input.multi === true,
        },
      ]);
    },
    has(key) {
      return byKey.has(key);
    },
    providers(key) {
      return [...(byKey.get(key) ?? [])].sort((a, b) => (a.provider < b.provider ? -1 : 1));
    },
    list() {
      return [...byKey.values()]
        .flat()
        .sort((a, b) =>
          a.key === b.key ? (a.provider < b.provider ? -1 : 1) : a.key < b.key ? -1 : 1,
        );
    },
  };
}

export type CapabilityRequirementStatus =
  | {
      readonly capability: string;
      readonly range: string;
      readonly status: "satisfied";
      readonly providers: readonly string[];
    }
  | {
      readonly capability: string;
      readonly range: string;
      readonly status: "unsatisfied";
      readonly reason: "missing";
    }
  | {
      readonly capability: string;
      readonly range: string;
      readonly status: "unsatisfied";
      readonly reason: "version_mismatch";
      readonly available: readonly string[];
    };

export interface CapabilityRequirement {
  readonly capability: string;
  readonly range: string;
}

/**
 * Resolves requirements against the registry. Deterministic: the result is
 * in input order and provider lists are sorted; a requirement is satisfied
 * when at least one provider version falls inside its SemVer range.
 */
export function resolveCapabilities(
  registry: CapabilityRegistry,
  requirements: readonly CapabilityRequirement[],
): readonly CapabilityRequirementStatus[] {
  return requirements.map((requirement) => {
    if (!validRange(requirement.range)) {
      throw new ExtensionError(
        "EXTENSION_CAPABILITY_CONFLICT",
        `requirement range "${requirement.range}" for capability "${requirement.capability}" is not a valid SemVer range`,
        { details: { capability: requirement.capability, range: requirement.range } },
      );
    }
    const providers = registry.providers(requirement.capability);
    if (providers.length === 0) {
      return {
        capability: requirement.capability,
        range: requirement.range,
        status: "unsatisfied" as const,
        reason: "missing" as const,
      };
    }
    const satisfying = providers.filter((provision) =>
      satisfies(provision.version, requirement.range),
    );
    if (satisfying.length === 0) {
      return {
        capability: requirement.capability,
        range: requirement.range,
        status: "unsatisfied" as const,
        reason: "version_mismatch" as const,
        available: providers.map((provision) => provision.version),
      };
    }
    return {
      capability: requirement.capability,
      range: requirement.range,
      status: "satisfied" as const,
      providers: satisfying.map((provision) => provision.provider),
    };
  });
}

/** Fail-closed variant for lifecycle gates: any unsatisfied requirement throws. */
export function assertCapabilitiesSatisfied(
  registry: CapabilityRegistry,
  requirements: readonly CapabilityRequirement[],
  requiredBy: string,
): void {
  const statuses = resolveCapabilities(registry, requirements);
  const unsatisfied = statuses.filter((status) => status.status === "unsatisfied");
  if (unsatisfied.length > 0) {
    throw new ExtensionError(
      "EXTENSION_DEPENDENCY_UNSATISFIED",
      `extension "${requiredBy}" has unsatisfied capability requirements: ${unsatisfied
        .map(
          (status) =>
            `${status.capability}@${status.range}` +
            (status.reason === "version_mismatch"
              ? ` (available: ${status.available.join(", ")})`
              : " (missing)"),
        )
        .join("; ")}`,
      { details: { extension_id: requiredBy, unsatisfied: statuses } },
    );
  }
}
