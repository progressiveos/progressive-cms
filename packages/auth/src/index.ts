// @pcms/auth — Auth, Authorization & Agent Identity subsystem (M08).
//
// Public application surface: the unified ActorContext, the permission
// registry and role model, password/credential services, opaque sessions,
// TOTP/recovery MFA, service accounts with scoped access tokens, and
// structured security events. Deep imports ("@pcms/auth/src/…") are
// boundary violations (tests/architecture.test.ts).

export {
  type ActorContext,
  type ActorType,
  type AuthFactor,
  type AuthStrength,
  actorHasPermission,
  operatorActor,
  systemActor,
} from "./actor.js";
export {
  type AuthenticationService,
  createAuthenticationService,
  type LoginInput,
  type LoginResult,
  type MfaRequirementGate,
} from "./authentication.js";
export { type AuthorizationService, createAuthorizationService } from "./authorize.js";
export {
  assertValidCookieConfig,
  CookieConfigError,
  DEFAULT_SESSION_COOKIE,
  parseSessionCookie,
  type SessionCookieConfig,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from "./cookies.js";
export {
  assertCsrfToken,
  assertSameOrigin,
  hashCsrfToken,
  newCsrfToken,
} from "./csrf.js";
export { InvalidEmailError, normalizeEmail } from "./email.js";
export type { AuthErrorCode } from "./errors.js";
export { AuthError } from "./errors.js";
export {
  createMfaPolicyService,
  DEFAULT_MFA_POLICY,
  DEFAULT_STEP_UP_WINDOW_MILLISECONDS,
  type MfaPolicyMode,
  type MfaPolicyService,
  mfaRequiredFor,
} from "./mfa.js";
export {
  assertNoActiveOwner,
  assertNotLastActiveOwner,
  hasActiveOwner,
} from "./owner-invariant.js";
export {
  ARGON2_BASELINE,
  type Argon2Params,
  assertArgon2Params,
  createPasswordCredentialService,
  type PasswordCredentialService,
  type PasswordVerifyResult,
} from "./password.js";
export {
  createPasswordPolicy,
  PASSWORD_MAX_CODE_POINTS,
  PASSWORD_MIN_CODE_POINTS,
  type PasswordBlocklistHook,
  type PasswordIssue,
  type PasswordIssueCode,
  type PasswordPolicy,
} from "./password-policy.js";
export {
  assertAllRegistered,
  BUILTIN_ROLE_BUNDLES,
  BUILTIN_ROLE_KEYS,
  type BuiltinRoleKey,
  builtinRolePermissions,
  isRegisteredPermission,
  PERMISSION_REGISTRY,
  type PermissionDefinition,
  permissionDefinition,
  registerExtensionPermissions,
  resetExtensionPermissionsForTests,
} from "./permissions.js";
export {
  createProvisioningService,
  type ProvisioningOptions,
  type ProvisioningService,
} from "./provisioning.js";
export {
  createRecoveryCodeService,
  RECOVERY_CODE_COUNT,
  type RecoveryCodeService,
} from "./recovery.js";
export {
  type CreateCustomRoleData,
  createRoleService,
  type RoleRecord,
  type RoleService,
} from "./roles.js";
export {
  createSecretBox,
  decodeEncryptionKey,
  deriveKeyForTesting,
  SECRET_BOX_KEY_BYTES,
  type SecretBox,
} from "./secret-box.js";
export {
  listSecurityEvents,
  recordSecurityEvent,
  type SecurityEvent,
  type SecurityEventSink,
  type SecurityEventType,
  type SecurityTransport,
} from "./security-events.js";
export {
  type ClientSessionMetadata,
  createSessionService,
  DEFAULT_SESSION_TIMEOUTS,
  hashSessionToken,
  type ResolvedSession,
  type SessionRecord,
  type SessionService,
  type SessionTimeouts,
  sessionHashesEqual,
} from "./sessions.js";
export {
  createThrottleService,
  DEFAULT_THROTTLE_CONFIG,
  loginBucketKeys,
  type ThrottleConfig,
  type ThrottleService,
} from "./throttle.js";
export {
  createTotpService,
  type TotpService,
} from "./totp.js";
export {
  type CreateUserData,
  createUserIdentityService,
  listUsers,
  type UserEmailRecord,
  type UserIdentityService,
  type UserRecord,
  type UserStatus,
} from "./users.js";

export const PACKAGE_NAME = "@pcms/auth";
export {
  type ActorResolver,
  createActorResolver,
  type TokenAuthenticationResult,
} from "./actor-resolver.js";
export {
  AGENT_SCOPE_PRESETS,
  ALL_PERMISSION_SCOPES,
  CONTENT_WORK_SCOPES,
  INTEGRATIONS_WORK_SCOPES,
  READONLY_DIAGNOSTICS_SCOPES,
  SITE_DEVELOPMENT_SCOPES,
  THEME_WORK_SCOPES,
} from "./agent-scopes.js";
export {
  type AccessTokenRecord,
  createMachineIdentityService,
  filterRegisteredScopes,
  formatRawToken,
  hashTokenSecret,
  type MachineIdentityService,
  type ServiceAccountRecord,
  TOKEN_PREFIX_RE,
} from "./service-accounts.js";
export {
  assertTokenConstraints,
  type ConstraintVerdict,
  evaluateTokenConstraints,
  type TokenRequestContext,
} from "./token-constraints.js";
