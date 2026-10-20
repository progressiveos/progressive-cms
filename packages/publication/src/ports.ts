// Structural ports for cross-subsystem facts (PCMS-PUB-T007/T010).
// L1 packages never import each other: the composition layer (tests, then
// apps/*) implements these over @pcms/revisions and the validator fleet —
// the established house pattern (SeoCanonicalPort, MediaUsagePort).
import type { Clock, DbClient, StableId } from "@pcms/core";

/**
 * Read-side seam over the revisions subsystem. Only SEALED revisions are
 * publishable; implementations must answer `null` for missing revisions and
 * must throw an Error with `code === "REVISION_NOT_SEALED"` (or answer null)
 * when the target exists but is still WORKING.
 */
export interface RevisionReaderPort {
  getSealedRevision(
    executor: DbClient,
    entityType: string,
    entityId: StableId,
    revisionId: StableId,
  ): Promise<SealedRevisionRef | null>;
  listRevisionsSealed?(
    executor: DbClient,
    entityType: string,
    entityId: StableId,
    options?: { readonly limit?: number; readonly offset?: number },
  ): Promise<readonly SealedRevisionRef[]>;
  /**
   * Draft preview (2026-09-29): resolve a WORKING revision into the same
   * snapshot shape so the edit→look→edit loop stops requiring a seal (seal
   * stays the gate to publication). payloadHash is preview-grade (may be
   * derived), mediaVersions unpinned — preview is private no-store state.
   * Optional: transports without it keep answering REVISION_NOT_SEALED.
   */
  getWorkingRevision?(
    executor: DbClient,
    entityType: string,
    entityId: StableId,
    revisionId: StableId,
  ): Promise<SealedRevisionRef | null>;
}

export interface SealedRevisionRef {
  readonly revisionId: StableId;
  readonly entityType: string;
  readonly entityId: StableId;
  readonly payloadHash: string;
  readonly schemaVersion: string;
  readonly locale: string;
  readonly payload: unknown;
  /** Sealed MediaVersion pins: assetId → versionNo (spec §52). */
  readonly mediaVersions: Readonly<Record<string, number>> | null;
  readonly sidecar: Readonly<Record<string, unknown>> | null;
  readonly sealedAt: Date;
}

/** Deterministic clock (core primitive) — scheduler/test control (spec §68). */
export type PublicationClock = Clock;
