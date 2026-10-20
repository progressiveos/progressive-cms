// Structural ports the composition layer adapts (M07 outbox precedent). L1
// rules: @pcms/forms imports @pcms/core only — domain events are written
// through this port, which packages/api binds to the publication outbox
// (`writeOutboxEvent`) inside the caller's transaction.
import type { DbClient } from "@pcms/core";

export interface FormsOutboxEventInput {
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
}

export interface FormsOutboxPort {
  /** Must write inside the caller's transaction — atomicity boundary. */
  write(executor: DbClient, event: FormsOutboxEventInput): Promise<void>;
}
