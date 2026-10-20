// Revisions subsystem (M07): generic WORKING/SEALED revision model for
// versioned entities (Publication spec §2–§7). Entity-specific payload
// semantics arrive exclusively through registered VersionedEntityAdapter
// implementations — this package never branches on entity types.
export const PACKAGE_NAME = "@pcms/revisions";

export { canonicalJsonString, hashCanonicalPayload } from "./canonical.js";
export {
  defaultSemanticDiff,
  diffBlockDocuments,
  diffPayloads,
  diffRelations,
  EMPTY_DIFF,
} from "./diff.js";
export {
  createRevisionDiscovery,
  type DiscoveryDescriptor,
  type DiscoveryOperation,
  type RevisionDiscovery,
} from "./discovery.js";
export { REVISION_ERROR_CODES, RevisionError, type RevisionErrorCode } from "./errors.js";
export { createVersionedEntityRegistry, type VersionedEntityRegistry } from "./registry.js";
export {
  REVISIONS_RETENTION_KEEP_DEFAULT,
  type RevisionsRetentionStats,
  sweepSealedRevisions,
} from "./retention.js";
export {
  type CreateWorkingRevisionInput,
  createRevisionStore,
  type MediaSnapshotPort,
  type RevisionStore,
  type SealRevisionInput,
  type UpdateWorkingRevisionInput,
} from "./store.js";
export type {
  ActorClass,
  RevisionActor,
  RevisionIssue,
  RevisionOrigin,
  RevisionRecord,
  RevisionState,
  SealContext,
  SemanticDiff,
  VersionedEntityAdapter,
} from "./types.js";
