// Public abuse controls (PCMS-FORM-T013; Forms spec §22/§23/§37). Layered:
// honeypot + field bounds live in the submission/quiz services; THIS module
// owns the per-IP rate limit (token bucket, bounded memory) and the
// configless origin/same-site policy for public endpoints. Transport adds its
// own body limit on top (defense in depth).
import { FormsError } from "./errors.js";

/** Thrown code is fixed per guard (FORM_RATE_LIMITED vs QUIZ_RATE_LIMITED). */
export interface AbuseGuard {
  /** Throws when the key (e.g. ip or ip+definition) exceeded its bucket. */
  assertAllowed(key: string): void;
}

/** In-process token bucket. Single-process capacity (ponytail: per-instance
 * limiter; move to a shared store if public ingress is ever multi-node). */
export function createAbuseGuard(
  options: {
    readonly capacity: number;
    readonly refillPerSecond: number;
    readonly maxKeys?: number;
    readonly code?: string;
  },
  clock: { readonly now: () => Date },
): AbuseGuard {
  const maxKeys = options.maxKeys ?? 10_000;
  const buckets = new Map<string, { tokens: number; updatedMilliseconds: number }>();
  return {
    assertAllowed(key) {
      const nowMilliseconds = clock.now().getTime();
      const bucket = buckets.get(key);
      const tokens =
        bucket === undefined
          ? options.capacity
          : Math.min(
              options.capacity,
              bucket.tokens +
                ((nowMilliseconds - bucket.updatedMilliseconds) / 1000) * options.refillPerSecond,
            );
      if (tokens < 1) {
        throw new FormsError(options.code ?? "FORM_RATE_LIMITED", "too many requests, slow down");
      }
      // Bounded memory: drop the oldest bucket when the map overflows
      // (insertion order ≈ oldest use; exactness is irrelevant under attack).
      if (bucket === undefined && buckets.size >= maxKeys) {
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined) buckets.delete(oldest);
      }
      buckets.set(key, { tokens: tokens - 1, updatedMilliseconds: nowMilliseconds });
    },
  };
}

/** Origin/same-site policy (spec §22): browsers always send Origin on
 * cross-site POSTs; when present it MUST match the serving host. Absent
 * Origin (curl, same-origin form fallbacks, proxies that strip it) is
 * allowed — rate limiting and honeypot still apply. */
export function assertOriginAllowed(
  originHeader: string | undefined,
  hostHeader: string | undefined,
): void {
  if (originHeader === undefined || originHeader === "") return;
  if (hostHeader === undefined) {
    throw new FormsError("FORM_ORIGIN_DENIED", "request origin cannot be verified");
  }
  let originHost: string;
  try {
    originHost = new URL(originHeader).host;
  } catch {
    throw new FormsError("FORM_ORIGIN_DENIED", "request origin is malformed");
  }
  if (originHost.toLowerCase() !== hostHeader.toLowerCase()) {
    throw new FormsError("FORM_ORIGIN_DENIED", "cross-origin submissions are not accepted");
  }
}
