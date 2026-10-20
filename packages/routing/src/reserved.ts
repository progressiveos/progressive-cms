// Reserved route registry (PCMS-NAV-T011; Navigation spec §29).
// Content routes cannot claim Core/system namespaces. The registry is a
// single policy object — no scattered if-statements; deployment prefixes
// are configurable (spec §29 "exact deployment prefixes configurable").
import { RoutingError } from "./errors.js";
import { DEFAULT_RESERVED_PREFIXES } from "./policy.js";

export interface ReservedRouteRegistry {
  /** True when the (normalized) path falls inside a reserved namespace. */
  isReserved(path: string): boolean;
  /** Throws ROUTE_RESERVED when the path claims a reserved namespace. */
  assertNotReserved(path: string): void;
  /** Machine-readable listing for discovery surfaces. */
  listReserved(): readonly string[];
}

/**
 * Creates the registry from the default Core namespaces plus optional
 * deployment-specific extras. Prefixes are normalized (lowercase, trailing
 * slash) at construction; both `/admin` and `/admin/anything` are reserved.
 */
export function createReservedRouteRegistry(
  customPrefixes?: readonly string[],
): ReservedRouteRegistry {
  const prefixes = new Set<string>();
  for (const raw of [...DEFAULT_RESERVED_PREFIXES, ...(customPrefixes ?? [])]) {
    if (typeof raw !== "string" || !raw.startsWith("/") || raw.length < 2) {
      throw new RoutingError(
        "ROUTE_RESERVED_PREFIX_INVALID",
        `reserved prefixes look like "/admin/"`,
        {
          details: { prefix: String(raw) },
        },
      );
    }
    const lower = raw.toLowerCase();
    prefixes.add(lower.endsWith("/") ? lower : `${lower}/`);
  }
  const sorted = [...prefixes].sort((a, b) => b.length - a.length);
  return {
    isReserved(path) {
      if (path === "/") return false;
      const lower = `${path.toLowerCase()}`;
      // "/admin" (no slash) still matches the "/admin/" namespace.
      const candidate = lower.endsWith("/") ? lower : `${lower}/`;
      return sorted.some((prefix) => candidate.startsWith(prefix));
    },
    assertNotReserved(path) {
      if (this.isReserved(path)) {
        throw new RoutingError(
          "ROUTE_RESERVED",
          `content routes cannot claim reserved namespaces`,
          {
            details: { path },
          },
        );
      }
    },
    listReserved() {
      return [...sorted];
    },
  };
}
