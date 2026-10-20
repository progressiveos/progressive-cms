// Revision domain model (Publication spec §2–§7, PCMS-PUB-T001).
//
// A Revision is an immutable-after-sealing semantic snapshot of one versioned
// entity (Entry, Navigation, GlobalContent, ThemeSettings — spec §2). The
// domain types here are entity-agnostic: concrete payload semantics arrive
// through VersionedEntityAdapter registrations, never through entity-type
// conditionals (owner instruction: controlled registry boundary).
import type { StableId } from "@pcms/core";

/** Fundamental revision states (spec §4). Not an editorial workflow. */
export type RevisionState = "WORKING" | "SEALED";

/** Why a revision exists (spec §7). */
export type RevisionOrigin = "human" | "service_account" | "import" | "migration" | "system";

/** Who performed an operation — structural mirror of the auth actor classes
 * (M08 ActorContext is mapped onto this at the composition layer; this
 * package never imports @pcms/auth). */
export type ActorClass = "human" | "service_account" | "system" | "operator";

export interface RevisionActor {
  readonly actorClass: ActorClass;
  /** Opaque actor reference (user/service-account id, job id, "system"). */
  readonly actorId: string;
  readonly origin: RevisionOrigin;
  /** Traceability fields (spec §7), where applicable. */
  readonly sourceRunId?: string;
  readonly bundleId?: string;
}

export interface RevisionIssue {
  readonly code: string;
  /** JSON pointer into the payload, where meaningful. */
  readonly path?: string;
  readonly message: string;
  readonly severity: "error" | "warning";
}

export interface RevisionRecord {
  readonly id: StableId;
  readonly entityType: string;
  readonly entityId: StableId;
  readonly revisionNo: number;
  readonly parentRevisionId: StableId | null;
  readonly state: RevisionState;
  /** Working payload as submitted; canonical JSON after sealing. */
  readonly payload: unknown;
  readonly schemaVersion: string;
  /** Locale/context the revision belongs to (spec §3). */
  readonly locale: string;
  readonly origin: RevisionOrigin;
  readonly createdByType: ActorClass;
  readonly createdBy: string;
  readonly sourceRunId: string | null;
  readonly bundleId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly sealedAt: Date | null;
  /** Optimistic edit generation for WORKING saves (spec §49/§50). */
  readonly editGeneration: number;
  /** Deterministic hash of the canonical payload, fixed at seal (spec §51). */
  readonly payloadHash: string | null;
  /** Sealed MediaVersion pinning snapshot: assetId → versionNo (spec §52). */
  readonly mediaVersions: Readonly<Record<string, number>> | null;
  /** Entity-scoped sealed snapshots (e.g. effective SEO document), set at
   * seal alongside the payload so historical renders stay reproducible. */
  readonly sidecar: Readonly<Record<string, unknown>> | null;
}

/**
 * Entity adapter: everything that is entity-specific about versioning one
 * entity type. Registered in a VersionedEntityRegistry; the revision store
 * has zero hard-coded entity types.
 */
export interface VersionedEntityAdapter {
  /** Versioned entity type key, e.g. "entry", "navigation", "global_content". */
  readonly entityType: string;
  readonly description: string;
  /**
   * Deterministic canonical form used for hashing at seal. The default
   * canonicalization is deep key-sorting; adapters only need this when the
   * payload carries unordered structures that must hash identically.
   */
  canonicalize?(payload: unknown): unknown;
  /**
   * Seal-level validation. Draft-level completeness is allowed to be missing;
   * a revision that does not pass with zero `severity: "error"` issues cannot
   * be sealed (spec §51).
   */
  validateForSeal(
    payload: unknown,
    context: SealContext,
  ): Promise<readonly RevisionIssue[]> | readonly RevisionIssue[];
  /**
   * Media asset ids referenced by the payload. At seal the store snapshots
   * their current MediaVersion numbers so later logical replacement of a
   * document cannot rewrite the historical render (spec §52; Media spec §53).
   */
  extractMediaAssetIds?(
    payload: unknown,
    context: SealContext,
  ): readonly string[] | Promise<readonly string[]>;
  /** Entity-specific semantic diff; falls back to the generic field diff. */
  semanticDiff?(from: unknown, to: unknown): SemanticDiff;
}

export interface SealContext {
  readonly entityType: string;
  readonly entityId: StableId;
  readonly locale: string;
  /** Current revision state for diagnostics that apply only to new edits. */
  readonly revisionState?: RevisionState;
  /**
   * The owning transaction, when validation runs inside one (PCMS-API-T017):
   * adapters resolving cross-subsystem facts MUST read through it, or rows
   * created in the same transaction are invisible to them.
   */
  readonly executor?: unknown;
}

/**
 * Semantic diff (spec §71): never a raw JSON diff. Field-level changes use
 * JSON-pointer paths; block/relations axes are filled by adapters.
 */
export interface SemanticDiff {
  readonly fieldsChanged: readonly {
    readonly path: string;
    readonly from: unknown;
    readonly to: unknown;
  }[];
  readonly fieldsAdded: readonly { readonly path: string; readonly value: unknown }[];
  readonly fieldsRemoved: readonly { readonly path: string; readonly value: unknown }[];
  readonly blocksAdded: readonly { readonly id: string; readonly type: string }[];
  readonly blocksRemoved: readonly { readonly id: string; readonly type: string }[];
  readonly blocksMoved: readonly {
    readonly id: string;
    readonly from: number;
    readonly to: number;
  }[];
  readonly blocksChanged: readonly { readonly id: string; readonly type: string }[];
  readonly relationsChanged: readonly {
    readonly path: string;
    readonly from: unknown;
    readonly to: unknown;
  }[];
}
