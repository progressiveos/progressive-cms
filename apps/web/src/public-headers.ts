// Public-page security headers (PCMS-OPS-T106; Operations spec §22/§57).
//
// Public HTML responses carry the security-header baseline plus a CSP built
// from the theme's validated `assets.csp` declaration (`buildCspPolicy` —
// the controlled policy layer; a theme can never inject `unsafe-*`, `data:`
// or wildcard script origins, Theme Contract §34). Provider/connector
// origins (spec §57) enter through the same declaration pipeline: an
// integration adapter's required origin is a theme-declaration-level
// extension point, not an ad-hoc header string.
//
// HSTS is deliberately NOT emitted here: TLS terminates on the reverse
// proxy, and the header belongs to the TLS-terminating layer (Operations
// spec §21/§22 "HSTS when deployment ready").
import { buildCspPolicy } from "@pcms/themes";

/** Theme `assets.csp` declaration shape (structural mirror, L1 boundary). */
export type ThemeCspDeclaration = Readonly<Partial<Record<string, readonly string[]>>>;

export interface PublicSecurityHeaders {
  readonly [header: string]: string;
}

/**
 * Deterministic security headers for a public HTML response. The theme CSP
 * declaration is the already-validated manifest input (theme validation is a
 * deployment gate); this function never accepts raw strings as policy.
 *
 * `inlineStyleHashes` extends `style-src` with `'sha256-…'` sources for
 * inline style blocks Core itself renders into the page (the Theme Contract's
 * `<style>{{ tokens_css }}</style>` injection point). Hashes are computed by
 * the caller from its own deterministic renderer output — they are not a
 * theme-declared policy surface, so the "no `unsafe-*` from theme
 * declarations" gate stays intact.
 */
export function publicSecurityHeaders(
  csp: ThemeCspDeclaration | undefined,
  inlineStyleHashes: readonly string[] = [],
  /** System analytics contribution (ADR-0016): validated origins + inline
   * script hashes computed by the analytics subsystem from ITS OWN settings —
   * the same caller-computed policy precedent as `inlineStyleHashes`; never
   * a theme-declared surface. `blobFrame` is provider-gated (Webvisor). */
  system?: {
    readonly origins: Readonly<Partial<Record<string, readonly string[]>>>;
    readonly scriptHashes: readonly string[];
    readonly blobFrame: boolean;
  },
): PublicSecurityHeaders {
  const declared: Record<string, string[]> = { ...(csp ?? {}) } as Record<string, string[]>;
  const mergedStyle = [...(declared.style_src ?? []), ...inlineStyleHashes];
  if (mergedStyle.length > 0) declared.style_src = mergedStyle;
  if (system !== undefined) {
    for (const [directive, origins] of Object.entries(system.origins)) {
      if (!origins || origins.length === 0) continue;
      declared[directive] = [...new Set([...(declared[directive] ?? []), ...origins])];
    }
    if (system.scriptHashes.length > 0) {
      declared.script_src = [...new Set([...(declared.script_src ?? []), ...system.scriptHashes])];
    }
    if (system.blobFrame) {
      declared.frame_src = [...new Set([...(declared.frame_src ?? []), "blob:"])];
    }
  }
  return {
    "content-security-policy": buildCspPolicy(declared),
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
}
