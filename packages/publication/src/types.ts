// Publication domain types (Publication spec §8/§9, PCMS-PUB-T005/T006).
// Publication is a pointer/state — never a boolean flag. The actor shape is
// a structural mirror of the M08 ActorContext classes; @pcms/auth is never
// imported (composition maps one onto the other).
import type { StableId } from "@pcms/core";

export type PublicationState = "PUBLISHED" | "UNPUBLISHED";

export type ActorClass = "human" | "service_account" | "system" | "operator";

export interface PublicationActor {
  readonly actorClass: ActorClass;
  /** Opaque actor reference (user id, service-account id, job id, "system"). */
  readonly actorId: string;
  /** Free-form audit reason, where supplied. */
  readonly reason?: string;
  /** Request/correlation id, where available (spec §58). */
  readonly requestId?: string;
}

export type PublicationEventType =
  | "PUBLISH_FIRST"
  | "PUBLISH_UPDATE"
  | "UNPUBLISH"
  | "ROLLBACK"
  | "SCHEDULE_CREATED"
  | "SCHEDULE_CANCELLED";

export interface PublicationRecord {
  readonly entityType: string;
  readonly entityId: StableId;
  /** Locale/channel context of the identity (spec §8); v1 default context. */
  readonly context: string;
  readonly state: PublicationState;
  /** Last sealed revision the pointer references (still set after unpublish
   * — history is preserved; only `state` decides public visibility). */
  readonly currentRevisionId: StableId | null;
  readonly currentPayloadHash: string | null;
  /** Compare-and-swap counter; every pointer move bumps it exactly once. */
  readonly generation: number;
  readonly firstPublishedAt: Date | null;
  readonly publishedAt: Date | null;
  /** Last time the public content actually changed (payload hash moved). */
  readonly modifiedAt: Date | null;
  readonly unpublishedAt: Date | null;
  readonly updatedAt: Date;
}

export interface PublicationEventRecord {
  readonly id: StableId;
  readonly entityType: string;
  readonly entityId: StableId;
  readonly context: string;
  readonly eventType: PublicationEventType;
  readonly fromRevisionId: StableId | null;
  readonly toRevisionId: StableId | null;
  readonly actorClass: ActorClass;
  readonly actorId: string;
  readonly reason: string | null;
  readonly changesetId: StableId | null;
  readonly jobId: StableId | null;
  readonly requestId: string | null;
  readonly createdAt: Date;
}
