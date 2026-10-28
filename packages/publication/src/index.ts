// Publication subsystem (M07): publication pointers, PublicationEvents,
// CAS publish transactions, Outbox (Publication spec §8–§14, §55/§56).
// Cross-subsystem facts arrive exclusively through structural ports wired
// at the composition layer — never through L1 imports.
export const PACKAGE_NAME = "@pcms/publication";

export {
  type CalendarEntry,
  createPublicationCalendarService,
  MAX_CALENDAR_PAGE_SIZE,
  MAX_CALENDAR_RANGE_DAYS,
  type PublicationCalendarService,
} from "./calendar.js";
export {
  type AddItemInput,
  type ChangeSetItemRecord,
  type ChangeSetRecord,
  type ChangeSetService,
  type ChangeSetState,
  createChangeSetService,
  type PreflightIssue,
  type PreflightReport,
  type RouteOperationsPort,
} from "./changesets.js";
export {
  type ChangeSetDiscovery,
  createChangeSetsDiscovery,
  createPublicationPlansDiscovery,
  type DiscoveryDescriptor,
  type DiscoveryOperation,
  type PublicationPlanDiscovery,
} from "./discovery.js";
export { PUBLICATION_ERROR_CODES, PublicationError, type PublicationErrorCode } from "./errors.js";
export {
  createPublicationJobHandlers,
  type PublicationJobHandler,
  type PublicationJobOutcome,
  type PublicationJobPayload,
} from "./handlers.js";
export {
  createOutboxConsumer,
  createOutboxService,
  type OutboxConsumer,
  type OutboxDeliveryHandler,
  type OutboxEvent,
  type OutboxEventInput,
  type OutboxService,
  type OutboxStats,
  writeOutboxEvent,
} from "./outbox.js";
export {
  type OpenedPcpubArchive,
  openPcpubArchive,
  type PcpubArchiveEntry,
  sha256Hex,
  writePcpubArchive,
} from "./pcpub/archive.js";
export {
  type CanonicalBlockDocument,
  type CanonicalBlockNode,
  deterministicBlockId,
  normalizePcmdProps,
  type PcmdRichTextBridge,
  pcmdBlockDocument,
  pcmdPayload,
  type RichTextPropsResolver,
} from "./pcpub/canonical.js";
export {
  DiagnosticCollector,
  type PcpubDiagnostic,
  PcpubError,
  type PcpubErrorCode,
} from "./pcpub/diagnostics.js";
export {
  DEFAULT_PCPUB_LIMITS,
  hasCaseCollision,
  PCPUB_ACCEPTED_ASSET_MIME,
  type PcpubLimits,
} from "./pcpub/limits.js";
export {
  BUNDLE_CONTRACT,
  CONTENT_CONTRACT,
  declaredPaths,
  type ExternalEntries,
  logicalPayloadDigest,
  type ManifestArtifact,
  type ManifestAsset,
  type ManifestDocument,
  PCPUB_FORMAT,
  PCPUB_SUPPORTED_VERSIONS,
  PCPUB_VERSION,
  type PcpubManifest,
  type PublicationMode,
  parseManifest,
  serializeManifest,
} from "./pcpub/manifest.js";
export {
  collectRefs,
  type PackedBundle,
  type PackOptions,
  type ParsedWorkspace,
  packWorkspace,
  readWorkspace,
  type WorkspaceMeta,
} from "./pcpub/pack.js";
export {
  artifactKindOf,
  assertValidEntryPath,
  isAllowedEntryPath,
  PCPUB_ASSETS_PREFIX,
  PCPUB_AUTHOR_NOTES_PATH,
  PCPUB_CONTENT_PREFIX,
  PCPUB_MANIFEST_PATH,
} from "./pcpub/paths.js";
export {
  EXTERNAL_ID_PATTERN,
  PCMD_VERSION,
  type PcmdBlock,
  type PcmdDocument,
  type PcmdRoute,
  parsePcmd,
  serializePcmd,
} from "./pcpub/pcmd.js";
export { encodeUlid, generateUlid, isUlid } from "./pcpub/ulid.js";
export {
  type BundleDocument,
  inspectPcpub,
  type PcpubTargetContentType,
  type PcpubTargetContracts,
  type VerifiedBundle,
  validatePcpub,
  verifyPcpub,
} from "./pcpub/validate.js";
export {
  type BatchScheduleSpec,
  type CompiledScheduleEntry,
  createPublicationPlanService,
  type FailurePolicy,
  type ItemScheduleOverride,
  type PlanItemRecord,
  type PlanItemState,
  type PlanRecord,
  type PlanStatus,
  PUBLISH_JOB_TYPE,
  type PublicationPlanService,
  UNPUBLISH_JOB_TYPE,
} from "./plans.js";
export type { PublicationClock, RevisionReaderPort, SealedRevisionRef } from "./ports.js";
export {
  createPreviewStateResolver,
  createPreviewTokenService,
  PREVIEW_RESPONSE_HEADERS,
  type PreviewEntityState,
  type PreviewRef,
  type PreviewState,
  type PreviewStateResolver,
  type PreviewTokenService,
} from "./preview.js";
export {
  createPublicationService,
  type PublicationOperationInput,
  type PublicationOperationResult,
  type PublicationService,
  publishedEntryIds,
  publishedEventTypeFor,
  type UnpublishInput,
} from "./publication.js";
export type {
  ActorClass,
  PublicationActor,
  PublicationEventRecord,
  PublicationEventType,
  PublicationRecord,
  PublicationState,
} from "./types.js";
export {
  addDaysToWallClock,
  instantToZonedWallClock,
  type WallClock,
  zonedWallClockToInstant,
  zoneOffsetMilliseconds,
} from "./tz.js";
export {
  MAX_VALIDATION_ISSUES,
  type PublicationCandidate,
  type PublicationIssue,
  type PublicationValidationContext,
  type PublicationValidator,
  type RouteOperation,
  runPublicationValidators,
  type ValidatorIssue,
} from "./validators.js";
