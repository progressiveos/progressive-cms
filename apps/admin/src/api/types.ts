// Shared /api/v1 payload projections used across Admin screens.
// Wire shape mirrors the M09 contract (snake_case) — no client-side renaming.
export interface ActorInfo {
  readonly actor_type: "USER" | "SERVICE_ACCOUNT" | "SYSTEM" | "OPERATOR";
  readonly actor_id: string;
  readonly permissions: readonly string[];
  readonly factors: readonly string[];
  readonly authenticated_at: string;
}

export interface LoginResponse {
  readonly stage: "PASSWORD_OK" | "PASSWORD_OK_PENDING_MFA";
  readonly user_id: string;
  readonly mfa_required: boolean;
  readonly csrf_token: string;
}

export interface SessionInfo {
  readonly session_id: string;
  readonly current: boolean;
  readonly created_at: string;
  readonly last_seen_at: string;
  readonly expires_at: string;
}
