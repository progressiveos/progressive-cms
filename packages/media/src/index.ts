// @pcms/media — Media subsystem (M05, PCMS-MEDIA-T001).
//
// Public application surface of the Media bounded context (Baseline §6,
// Media spec §0): Content stores Media Asset IDs, the Theme asks for presets
// and receives resolved view models — neither ever touches storage keys,
// filesystem paths or generated transform URLs. Other packages interact with
// Media exclusively through what this entry re-exports; deep imports like
// "@pcms/media/src/…" are a boundary violation and are rejected by
// tests/architecture.test.ts.
export const PACKAGE_NAME = "@pcms/media";
export type {
  AssetProvenance,
  GenerationRunRecord,
  GenerationRunStatus,
  NewGenerationRun,
} from "./acquisition.js";
// Media acquisition (ADR-0013): candidate tokens, provenance, generation runs.
export {
  CandidateTokenError,
  createGenerationRun,
  deleteExpiredGenerationRuns,
  findAssetIdByProviderAsset,
  markGenerationRunFailed,
  markGenerationRunReady,
  markGenerationRunRunning,
  recordCandidateAccept,
  requireGenerationRun,
  setAssetProvenance,
  signStockCandidate,
  verifyStockCandidate,
} from "./acquisition.js";
export {
  ensureCoreDerivative,
  FAVICON_PRESET_ID,
  findCoreDerivative,
  LOGO_PRESET_ID,
  OG_IMAGE_PRESET_ID,
  RICHTEXT_IMAGE_PRESET_ID,
} from "./core-derivatives.js";
export type {
  MediaAssetSummary,
  MediaDiscoveryService,
  SearchMediaQuery,
  SearchResultPage,
} from "./discovery.js";
export { createMediaDiscoveryService, MAX_SEARCH_LIMIT } from "./discovery.js";
export { MediaError } from "./errors.js";
export type { MediaFolderRecord } from "./folders.js";
export {
  createMediaFolder,
  deleteMediaFolder,
  listMediaFolders,
  moveMediaAsset,
  updateMediaFolder,
} from "./folders.js";
export type { GcApplyResult, GcCandidateBlob, GcReport } from "./gc.js";
export { gcApply, gcDryRun } from "./gc.js";
export type { CostBasis, GenerationCostEstimate, GenerationCostIntent } from "./generation-cost.js";
// Image generation cost preview (Image Generation v2, plan T1.6).
export { estimateGenerationCost } from "./generation-cost.js";
export type {
  ImageDecodeLimits,
  ImageTechnicalMetadata,
  TransformInstruction,
} from "./image.js";
export {
  DEFAULT_IMAGE_DECODE_LIMITS,
  DERIVATIVE_METADATA_POLICY,
  PROCESSOR_ID,
  processorVersion,
  readImageMetadata,
  transformImage,
} from "./image.js";
export type { AcceptedMedia, IngestDependencies, IngestLimits, UploadInput } from "./ingest.js";
export { uploadMedia } from "./ingest.js";
export type { MediaJob, MediaJobRunner, MediaJobRunnerOptions } from "./jobs.js";
export { createMediaJobRunner } from "./jobs.js";
export type {
  ReplaceDependencies,
  ReplacementInput,
  ReplacementResult,
} from "./lifecycle.js";
export {
  getVersionAudit,
  replaceDocument,
} from "./lifecycle.js";
export type {
  SniffResult,
  TypeDescriptor,
  TypeRegistry,
  TypeValidationInput,
  TypeValidationResult,
} from "./mime.js";
export {
  createTypeRegistry,
  DEFAULT_TYPE_REGISTRY,
  filenameExtension,
  sniffMimeType,
  validateUploadType,
} from "./mime.js";
export type {
  MediaAssetRecord,
  MediaBlobRecord,
  MediaKind,
  MediaMetadata,
  MediaVersionRecord,
  MetadataPatch,
  NewAssetInput,
} from "./model.js";
export {
  archiveAsset,
  commitReplacementVersion,
  createAssetWithFirstVersion,
  deleteAssetRows,
  ensureBlobRow,
  getAsset,
  getBlobByHash,
  listVersions,
  MEDIA_KINDS,
  restoreAsset,
  updateAssetMetadata,
} from "./model.js";
export type {
  MediaPreset,
  MediaPresetCrop,
  MediaPresetFit,
  MediaPresetFormat,
  MediaPresetLoading,
  MediaPresetRegistry,
} from "./presets.js";
export {
  assertMediaId,
  createMediaPresetRegistry,
  validatePresetInput,
  variantKeyFor,
} from "./presets.js";
export type {
  FetchedMedia,
  GeneratedCandidate,
  GenerationProviderCapabilities,
  GenerationRequest,
  GenerationResult,
  ImageGenerationProvider,
  MediaProvider,
  MediaProviderFactory,
  MediaStockProvider,
  ModelCapabilities,
  ModelRequestProfile,
  ModelSizeOption,
  ProviderContext,
  ProviderErrorCode,
  ProviderFactoryInput,
  ProviderHealth,
  ProviderModelSummary,
  ReferenceImage,
  ResolutionTier,
  StockCandidate,
  StockOrientation,
  StockProviderCapabilities,
  StockSearchRequest,
  StockSearchResult,
} from "./providers.js";
// Media acquisition provider contracts (ADR-0013).
export {
  DEFAULT_COUNT,
  effectiveMaxCount,
  isModelStale,
  MAX_COUNT_CEILING,
  MAX_COUNT_HUMAN,
  MODEL_SNAPSHOT_STALE_TTL_MS,
  normalizeModelCapabilities,
  ProviderError,
  providerErrorFromStatus,
  providerErrorFromTransport,
  providerFetchBytes,
  providerFetchJson,
} from "./providers.js";
export type {
  RemoteFetchDependencies,
  RemoteFetchResult,
  RemoteImportLimits,
} from "./remote.js";
export {
  DEFAULT_REMOTE_IMPORT_LIMITS,
  fetchRemoteMedia,
  validateRemoteUrl,
} from "./remote.js";
export type { MediaStorage, StoredBlob } from "./storage.js";
export { assertSafeKey, InMemoryMediaStorage, LocalMediaStorage } from "./storage.js";
export type { SvgValidationResult } from "./svg.js";
export { SVG_MAX_BYTES, validateSvg } from "./svg.js";
export type {
  HardDeleteDependencies,
  HardDeleteRequest,
  HardDeleteResult,
  MediaUsagePort,
  MediaUsageReport,
  MediaUsageService,
  UsageOrigin,
  UsageReference,
} from "./usage.js";
export {
  createMediaUsageService,
  hardDeleteAsset,
} from "./usage.js";
export type {
  GeneratedVariant,
  MediaVariantRecord,
  VariantDependencies,
} from "./variants.js";
export {
  generateVariantsForAsset,
  getVariant,
  listVariants,
  readVariantBytes,
} from "./variants.js";
export type {
  ImageSourceModel,
  MediaAssetPublicViewModel,
  MediaViewModelProvider,
  PublicDerivative,
  ResponsiveImageModel,
} from "./view-model.js";
export {
  buildResponsiveImageModel,
  createMediaViewModelProvider,
  documentCurrentUrl,
  documentDownloadUrl,
  resolveAlt,
  sanitizeFilenameSlug,
  variantPublicUrl,
} from "./view-model.js";
