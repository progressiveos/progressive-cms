// Unified actor model (PCMS-AUTH-T001; Auth spec §61).
//
// Every authorization decision in the platform consumes an ActorContext.
// The context makes the principal class explicitly observable — human user,
// service account, system component or local operator are never folded into
// one `user_id`-shaped thing (Auth spec §25 reconciliation): audit and
// application services can always tell them apart.

export type ActorType =
  | "USER"
  | "SERVICE_ACCOUNT"
  | "SYSTEM"
  | "OPERATOR"
  /** PREPUBLIC §5: unauthenticated guest identity on public mutations. */
  | "GUEST";

export type AuthFactor = "password" | "totp" | "recovery_code" | "access_token" | "local_operator";

/** How strongly the principal authenticated, and when. */
export interface AuthStrength {
  readonly factors: readonly AuthFactor[];
  /** Completion of the primary authentication (password/token/operator). */
  readonly authenticatedAt: Date;
  /**
   * Completion of the strong (MFA) factor for this session; null while MFA
   * is not (yet) satisfied. Drives MFA policy and step-up checks (§24).
   */
  readonly mfaAt: Date | null;
}

export interface ActorContext {
  readonly type: ActorType;
  /** Immutable internal id: user_id, service account id, or a synthetic id. */
  readonly id: string;
  /**
   * Effective permission keys. For users this is the union of role grants;
   * for service accounts it is the precomputed intersection
   * account-allowed ∩ token scopes ∩ binding/capability (Auth spec §29
   * reconciliation) — a token can never broaden its service account.
   */
  readonly permissions: ReadonlySet<string>;
  /** Site/environment context; null for unbound (site-global) actors. */
  readonly siteKey: string | null;
  readonly environment: string | null;
  readonly strength: AuthStrength;
  /** Server-side session id for browser actors; null for machine actors. */
  readonly sessionId: string | null;
}

export function systemActor(id: string): ActorContext {
  return {
    type: "SYSTEM",
    id,
    permissions: new Set<string>(),
    siteKey: null,
    environment: null,
    strength: {
      factors: [],
      authenticatedAt: new Date(0),
      mfaAt: null,
    },
    sessionId: null,
  };
}

export function operatorActor(id: string): ActorContext {
  return {
    type: "OPERATOR",
    id,
    permissions: new Set<string>(),
    siteKey: null,
    environment: null,
    strength: {
      factors: ["local_operator"],
      authenticatedAt: new Date(),
      mfaAt: null,
    },
    sessionId: null,
  };
}

/**
 * Default-deny membership check (Auth spec §38). Authorization is always
 * evaluated server-side against this set — role labels and UI visibility
 * are never security decisions.
 */
export function actorHasPermission(actor: ActorContext, permission: string): boolean {
  return actor.permissions.has(permission);
}
