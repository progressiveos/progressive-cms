// MFA policy enforcement + step-up (PCMS-AUTH-T014; Auth spec §23/§24).
//
// Policy: OPTIONAL, REQUIRED_PRIVILEGED (recommended default — OWNER/ADMIN/
// DEVELOPER are the privileged baseline) or REQUIRED_ALL. Enforcement is
// server-side: the login flow marks a session PENDING_MFA when the policy
// requires it, and authorization of privileged operations must consult
// assertMfaSatisfied — UI hints never satisfy this check.
//
// Step-up (spec §24): sensitive actions (user/role management, MFA resets,
// privileged token creation, mass publish, security settings) require
// RECENT strong authentication. Recent = the session's mfaAt inside the
// window; a user without any confirmed MFA factor under OPTIONAL policy
// falls back to a recent password authentication — deliberately stricter
// deployments set REQUIRED_PRIVILEGED to close that fallback.
import type { ActorContext } from "./actor.js";
import { AuthError } from "./errors.js";

export type MfaPolicyMode = "OPTIONAL" | "REQUIRED_PRIVILEGED" | "REQUIRED_ALL";

export const DEFAULT_MFA_POLICY: MfaPolicyMode = "REQUIRED_PRIVILEGED";
export const DEFAULT_STEP_UP_WINDOW_MILLISECONDS = 15 * 60 * 1000;

/** Spec §23 privileged baseline. */
const PRIVILEGED_ROLES: readonly string[] = ["OWNER", "ADMIN", "DEVELOPER"];

export interface MfaPolicyInput {
  policy: MfaPolicyMode;
  /** The login's assigned role keys (built-in or custom). */
  roleKeys: readonly string[];
  /** Effective permissions (custom roles may carry privileged keys). */
  permissions: ReadonlySet<string>;
}

/** True when the policy requires MFA for this principal. */
export function mfaRequiredFor(input: MfaPolicyInput): boolean {
  if (input.policy === "REQUIRED_ALL") return true;
  if (input.policy === "OPTIONAL") return false;
  // REQUIRED_PRIVILEGED: built-in privileged roles…
  if (input.roleKeys.some((role) => PRIVILEGED_ROLES.includes(role))) return true;
  // …or any principal holding security-sensitive permissions (custom roles
  // must not become an MFA bypass via role naming).
  for (const key of [
    "users.manage",
    "roles.manage",
    "tokens.manage",
    "integrations.secrets.manage",
  ]) {
    if (input.permissions.has(key)) return true;
  }
  return false;
}

export interface MfaPolicyService {
  /** Throws AUTH_MFA_REQUIRED when the actor's strength lacks the MFA factor. */
  assertMfaSatisfied(actor: ActorContext): void;
  /**
   * Step-up: throws AUTH_STEP_UP_REQUIRED unless a strong (MFA) verification
   * happened within the window; falls back to recent primary authentication
   * only when the actor genuinely has no confirmed MFA (OPTIONAL policy).
   */
  assertRecentStrongAuth(
    actor: ActorContext,
    options?: { windowMilliseconds?: number; hasConfirmedMfa?: boolean; now?: Date },
  ): void;
}

export function createMfaPolicyService(options: { policy?: MfaPolicyMode } = {}): MfaPolicyService {
  const policy = options.policy ?? DEFAULT_MFA_POLICY;

  return {
    assertMfaSatisfied(actor: ActorContext): void {
      if (actor.strength.mfaAt === null) {
        throw new AuthError("AUTH_MFA_REQUIRED", "multi-factor authentication required", 403);
      }
    },

    assertRecentStrongAuth(actor, stepOptions) {
      const now = stepOptions?.now ?? new Date();
      const windowMs = stepOptions?.windowMilliseconds ?? DEFAULT_STEP_UP_WINDOW_MILLISECONDS;
      const withinWindow = (at: Date | null): boolean =>
        at !== null && now.getTime() - at.getTime() <= windowMs;
      const hasConfirmedMfa = stepOptions?.hasConfirmedMfa ?? true;
      if (withinWindow(actor.strength.mfaAt)) return;
      if (
        !hasConfirmedMfa &&
        policy !== "REQUIRED_ALL" &&
        withinWindow(actor.strength.authenticatedAt)
      ) {
        return;
      }
      throw new AuthError(
        "AUTH_STEP_UP_REQUIRED",
        "recent strong authentication required for this action",
        403,
      );
    },
  };
}
