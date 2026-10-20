// The only versioned extension-author entrypoint. Core composition imports
// implementation APIs from @pcms/extensions/internal.
export const PACKAGE_NAME = "@pcms/extensions";

export type {
  AdminContributionApi,
  AdminNavItem,
  AdminNavSection,
  AdminRequestOptions,
  AdminRoute,
  ExtensionContribution,
} from "./admin-sdk.js";
export { EXTENSION_ERROR_CODES, ExtensionError, type ExtensionErrorCode } from "./errors.js";
export type {
  ExtensionEventHandler,
  ExtensionEventSubscriptionSpec,
  ExtensionEventView,
} from "./events.js";
export {
  EXTENSION_CONTRACT_VERSION,
  EXTENSION_MANIFEST_ISSUE_CODES,
  EXTENSION_MANIFEST_MAX_BYTES,
  EXTENSION_MANIFEST_SCHEMA,
  EXTENSION_PROVIDER_REGISTRIES,
  EXTENSION_VALIDATOR_POINTS,
  type ExtensionBlockRegistration,
  type ExtensionCapabilityProvision,
  type ExtensionCapabilityRequirement,
  type ExtensionDataPolicy,
  type ExtensionEventSubscription,
  type ExtensionFieldTypeRegistration,
  type ExtensionHttpRouteRegistration,
  type ExtensionJobRegistration,
  type ExtensionManifest,
  type ExtensionManifestIssue,
  type ExtensionManifestIssueCode,
  type ExtensionManifestValidation,
  type ExtensionObligationRegistration,
  type ExtensionOperationRegistration,
  type ExtensionProviderRegistration,
  type ExtensionProviderRegistry,
  type ExtensionRegistrations,
  type ExtensionRouteRegistration,
  type ExtensionSearchSourceRegistration,
  type ExtensionSourceRegistration,
  type ExtensionValidatorPoint,
  type ExtensionValidatorRegistration,
  type ExtensionViewRegistration,
  validateExtensionManifest,
} from "./manifest.js";
export {
  createExtensionFetchClient,
  createExtensionFetchClientFromConfig,
  type ExtensionFetchClient,
  type ExtensionOutboundMode,
  type ExtensionOutboundPolicy,
  isTransportFailure,
  parseOutboundPolicy,
  type Socks5ProxyConfig,
} from "./outbound.js";
export type {
  ExtensionCallContext,
  ExtensionDbReader,
  ExtensionHttpCallContext,
  ExtensionJobsPort,
  ExtensionPlatformServices,
  ExtensionPrincipal,
  ExtensionSiteContext,
  ExtensionTransactionContext,
} from "./platform.js";
