// Server-side authorization service (PCMS-AUTH-T019; Auth spec §38, §48).
//
// Every sensitive application operation calls `authorize` (or the deny
// helpers) with the resolved ActorContext. There is no role shortcut and no
// UI-visibility authorization: the check is this function, server-side,
// default-deny. Object/context restrictions (site binding) are evaluated
// together with the permission key, not as a separate courtesy check.
import type { ActorContext } from "./actor.js";
import { AuthError } from "./errors.js";
import { isRegisteredPermission } from "./permissions.js";

export interface AuthorizationService {
  /**
   * Throws unless the actor holds the registered permission key.
   * AUTH_UNKNOWN_PERMISSION — the checked key is not in the registry
   * (server bug/forged key; deny). AUTH_PERMISSION_DENIED — registered but
   * not granted (default deny).
   */
  authorize(actor: ActorContext, permission: string): Promise<void> | void;
  /**
   * Context check (spec §48): when `requiredSiteKey` is given, a bound
   * actor (service-account token) must match it. Unbound actors (human
   * users, operators) pass — their scope is the installation.
   */
  authorizeSite(actor: ActorContext, requiredSiteKey: string): void;
}

export function createAuthorizationService(): AuthorizationService {
  return {
    authorize(actor: ActorContext, permission: string): void {
      if (!isRegisteredPermission(permission)) {
        throw new AuthError(
          "AUTH_UNKNOWN_PERMISSION",
          `permission "${permission}" is not registered`,
          500,
        );
      }
      if (!actor.permissions.has(permission)) {
        throw new AuthError(
          "AUTH_PERMISSION_DENIED",
          `permission "${permission}" is required`,
          403,
        );
      }
    },

    authorizeSite(actor: ActorContext, requiredSiteKey: string): void {
      if (actor.siteKey !== null && actor.siteKey !== requiredSiteKey) {
        throw new AuthError(
          "AUTH_TOKEN_SITE_DENIED",
          "the credential is not valid for this site",
          403,
        );
      }
    },
  };
}
