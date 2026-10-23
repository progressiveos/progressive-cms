// @pcms/operations — production operations contracts (M15).
//
// The package owns milestone M15: release artifact model, deployment and
// runtime operation contracts that bind the Progressive CMS product to real
// production infrastructure (Operations spec §1–§64). Transport- and
// environment-specific scripts live under scripts/ and deploy/ and consume
// these contracts.

export {
  createWorkerHeartbeatWriter,
  heartbeatAgeMilliseconds,
  heartbeatIsFresh,
  readWorkerHeartbeat,
  WORKER_HEARTBEAT_FRESH_WINDOW_MS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  type WorkerHeartbeatSnapshot,
  type WorkerHeartbeatWriter,
  workerHeartbeatTableExists,
} from "./heartbeat.js";
export {
  type MaintenanceState,
  type MaintenanceStatePatch,
  maintenanceStateTableExists,
  readMaintenanceState,
  updateMaintenanceState,
} from "./maintenance.js";
export {
  createMaintenancePageHtml,
  DEFAULT_MAINTENANCE_SETTINGS,
  loadPcmsMarkSvg,
  type MaintenancePageSettings,
} from "./maintenance-page.js";
export {
  createMetricSampler,
  type MetricSampler,
  readRuntimeResourceSample,
} from "./metrics.js";
export {
  type ContractVersionFact,
  createReleaseBuildMetadata,
  createReleaseId,
  RELEASE_LAYOUT,
  type ReleaseBuildMetadata,
  type ReleaseManifestIdentity,
  type ReleaseUpdateManifestDraft,
  readSelectedReleaseStatus,
  resolveReleaseIdentity,
  type SelectedReleaseStatus,
  toCompiledExports,
  toReleasePackageDocument,
  type WorkspacePackageDocument,
} from "./release.js";
