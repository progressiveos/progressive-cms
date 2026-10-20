// @pcms/extensions/internal — Core implementation surface for this bounded
// context. Extension authors use the versioned allowlist in sdk.ts.
export const PACKAGE_NAME = "@pcms/extensions/internal";

export {
  assertCapabilitiesSatisfied,
  type CapabilityProvision,
  type CapabilityRegistry,
  type CapabilityRequirement,
  type CapabilityRequirementStatus,
  createCapabilityRegistry,
  resolveCapabilities,
} from "./capabilities.js";
export {
  type ComposedRegistration,
  composeExtensionRegistrations,
  createExtensionCatalog,
  type DeployedExtensionArtifact,
  defineExtensionArtifact,
  type ExtensionCatalog,
  type ExtensionComposition,
  manifestFingerprint,
  resolveHandler,
} from "./catalog.js";
export {
  createExtensionConfigSpace,
  EXTENSION_CONFIG_MAX_BYTES,
  type ExtensionConfigIssue,
  type ExtensionConfigSpace,
  type ExtensionConfigValidation,
  resolveExtensionConfig,
  validateExtensionConfig,
} from "./config.js";
export {
  breakingDiffFindings,
  CONTRACT_DIFF_CODES,
  type ContractDiffCode,
  type ContractDiffFinding,
  diffContractDocuments,
  keyedBy,
} from "./contract-diff.js";
export {
  assertRemovalPolicyCompliant,
  createDeprecationRegistry,
  DEPRECATION_STATUSES,
  type DeprecationRecord,
  type DeprecationRegistry,
  type DeprecationStatus,
} from "./deprecations.js";
export {
  EXTENSION_ERROR_CODES,
  ExtensionError,
  type ExtensionErrorCode,
} from "./errors.js";
export {
  createExtensionEventConsumer,
  EVENT_CONSUMPTIONS_TABLE,
  type ExtensionEventConsumer,
  type ExtensionEventHandler,
  type ExtensionEventSubscriptionSpec,
  type ExtensionEventView,
  mergeOutboxHandlers,
} from "./events.js";
export {
  assertEvolutionPhaseAllowed,
  classifyEvolutionPhase,
  EVOLUTION_PHASES,
  type EvolutionMetadata,
  type EvolutionPhase,
} from "./evolution.js";
export {
  blockingIssues,
  type CompatibilityIssue,
  type CompatibilitySeverity,
  ISSUE_CATEGORIES,
  type IssueCategory,
  type PreflightOutcome,
  preflightOutcome,
  sortIssues,
  warningIssues,
} from "./issues.js";
export {
  createExtensionLifecycleService,
  type ExtensionInstallation,
  type ExtensionLifecycleAuditEvent,
  type ExtensionLifecycleService,
  type ExtensionLifecycleServiceOptions,
  type ExtensionLifecycleState,
  INSTALLATIONS_TABLE,
  type LifecyclePreflight,
} from "./lifecycle.js";
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
  type ExtensionJobRegistration,
  type ExtensionManifest,
  type ExtensionManifestIssue,
  type ExtensionManifestIssueCode,
  type ExtensionManifestValidation,
  type ExtensionProviderRegistration,
  type ExtensionProviderRegistry,
  type ExtensionRegistrations,
  type ExtensionRouteRegistration,
  type ExtensionSearchSourceRegistration,
  type ExtensionValidatorPoint,
  type ExtensionValidatorRegistration,
  validateExtensionManifest,
} from "./manifest.js";
export {
  applyAllExtensionMigrations,
  applyExtensionMigrations,
  EXTENSION_MIGRATIONS_TABLE,
  type ExtensionMigrateResult,
  type ExtensionMigrationStatus,
  extensionMigrationStatus,
  loadMigrations,
  type Migration,
} from "./migrations.js";
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
export {
  ANONYMOUS_PRINCIPAL,
  createExtensionPlatformServices,
  type ExtensionCallContext,
  type ExtensionDbReader,
  type ExtensionHttpCallContext,
  type ExtensionPlatformServices,
  type ExtensionPrincipal,
  type ExtensionSiteContext,
  type ExtensionTransactionContext,
} from "./platform.js";
export {
  createValidatorExtensionPoint,
  registerValidatorContributions,
  type ValidatorExtensionPoint,
  type ValidatorPointContribution,
} from "./points.js";
export {
  type ConfigChangeNote,
  parseReleaseManifest,
  type ReleaseManifestV1,
  ROLLBACK_POLICIES,
  type RollbackPolicy,
  UPDATE_MANIFEST_MAX_BYTES,
  UPDATE_MANIFEST_V1_SCHEMA,
  type UpdateManifestIssue,
  validateReleaseManifest,
} from "./release-manifest.js";
// Extension runtime secret store (ADR-0013 §52.4, PCMS-MPA-T006).
export {
  clearExtensionRuntimeSecret,
  ExtensionRuntimeSecretError,
  type ExtensionSecretBox,
  getExtensionRuntimeSecret,
  listExtensionRuntimeSecretSlots,
  setExtensionRuntimeSecret,
} from "./runtime-secrets.js";
export {
  type CompatibilityReport,
  type CompatibilitySnapshot,
  type RuntimeRange,
  type ScannedExtension,
  scanCompatibility,
} from "./scanner.js";
export {
  type BackupGate,
  createUpdateOrchestrator,
  latestUpdateRecord,
  type MaintenanceController,
  type MigrationApplier,
  type PostflightDoctor,
  type ReleaseDeploymentPort,
  recordFailedUpdateAttempt,
  type ServiceRestartPort,
  UPDATE_HISTORY_TABLE,
  UPDATE_PHASES,
  type UpdateActor,
  type UpdateHistoryRecord,
  type UpdateOrchestrationPorts,
  type UpdateOrchestrator,
  type UpdatePhase,
} from "./update-apply.js";
export {
  checkUpdate,
  type UpdatePreflight,
} from "./update-check.js";
export {
  CONTRACT_VERSION_KEYS,
  type ContractVersionEntry,
  type ContractVersionKey,
  type ContractVersionRegistry,
  createContractVersionRegistry,
  createSystemContractVersionRegistry,
  discoverCmsVersion,
  SUPPORTED_NODE_RANGE,
  SUPPORTED_POSTGRES_RANGE,
  type SystemContractVersions,
} from "./versions.js";
