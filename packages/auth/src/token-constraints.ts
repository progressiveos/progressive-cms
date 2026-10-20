// Token constraint evaluator (PCMS-AUTH-T022; Auth spec §29/§48/§58).
//
// Site/environment bindings narrow a token's reach. A bound token used
// without (or with a different) context is denied — fail-secure: an absent
// context does NOT inherit installation-wide rights. Unbound tokens
// (NULL constraints) pass any context; the permission check remains
// independent and always applies on top.
import { AuthError } from "./errors.js";
import type { AccessTokenRecord } from "./service-accounts.js";

export interface TokenRequestContext {
  /** The site the request targets (transports resolve this from the route). */
  siteKey?: string | null;
  /** The environment the request targets (e.g. "preview", "production"). */
  environment?: string | null;
}

export interface ConstraintVerdict {
  readonly allowed: boolean;
  readonly code?: "AUTH_TOKEN_SITE_DENIED" | "AUTH_TOKEN_ENVIRONMENT_DENIED";
}

export function evaluateTokenConstraints(
  token: Pick<AccessTokenRecord, "siteKey" | "environment">,
  context: TokenRequestContext,
): ConstraintVerdict {
  if (token.siteKey !== null) {
    if (context.siteKey === undefined || context.siteKey === null || context.siteKey === "") {
      return { allowed: false, code: "AUTH_TOKEN_SITE_DENIED" };
    }
    if (context.siteKey !== token.siteKey) {
      return { allowed: false, code: "AUTH_TOKEN_SITE_DENIED" };
    }
  }
  if (token.environment !== null) {
    if (
      context.environment === undefined ||
      context.environment === null ||
      context.environment === ""
    ) {
      return { allowed: false, code: "AUTH_TOKEN_ENVIRONMENT_DENIED" };
    }
    if (context.environment !== token.environment) {
      return { allowed: false, code: "AUTH_TOKEN_ENVIRONMENT_DENIED" };
    }
  }
  return { allowed: true };
}

/** Throwing variant for transports; code on the error mirrors the verdict. */
export function assertTokenConstraints(
  token: Pick<AccessTokenRecord, "siteKey" | "environment">,
  context: TokenRequestContext,
): void {
  const verdict = evaluateTokenConstraints(token, context);
  if (!verdict.allowed) {
    throw new AuthError(verdict.code!, "token is not valid for this site/environment", 403);
  }
}
