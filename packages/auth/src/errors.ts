// Stable machine-readable auth error codes (Auth spec §68).
//
// Unauthenticated callers always receive coarse codes: the login path reports
// AUTH_INVALID_CREDENTIALS for both unknown accounts and wrong passwords, so
// no response ever distinguishes "email exists" from "password wrong".
// Richer codes are reserved for already-authorized surfaces.
export type AuthErrorCode =
  | "AUTH_UNAUTHENTICATED"
  | "AUTH_INVALID_CREDENTIALS"
  | "AUTH_ACCOUNT_DISABLED"
  | "AUTH_PERMISSION_DENIED"
  | "AUTH_MFA_REQUIRED"
  | "AUTH_STEP_UP_REQUIRED"
  | "AUTH_MFA_INVALID_CODE"
  | "AUTH_MFA_RATE_LIMITED"
  | "AUTH_RECOVERY_CODE_INVALID"
  | "AUTH_SESSION_INVALID"
  | "AUTH_SESSION_EXPIRED"
  | "AUTH_SESSION_REVOKED"
  | "AUTH_CSRF_TOKEN_MISSING"
  | "AUTH_CSRF_TOKEN_INVALID"
  | "AUTH_THROTTLED"
  | "AUTH_TOKEN_INVALID"
  | "AUTH_TOKEN_EXPIRED"
  | "AUTH_TOKEN_REVOKED"
  | "AUTH_TOKEN_SCOPE_DENIED"
  | "AUTH_TOKEN_SITE_DENIED"
  | "AUTH_TOKEN_ENVIRONMENT_DENIED"
  | "AUTH_SERVICE_ACCOUNT_DISABLED"
  | "AUTH_PASSWORD_POLICY_VIOLATION"
  | "AUTH_PASSWORD_BLOCKLISTED"
  | "AUTH_LAST_OWNER_PROTECTED"
  | "AUTH_VALIDATION"
  | "AUTH_CONFIGURATION"
  | "AUTH_UNKNOWN_PERMISSION";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  /** HTTP-agnostic status hint for transports (M09 maps these). */
  readonly status: number;

  constructor(code: AuthErrorCode, message: string, status = 400) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}
