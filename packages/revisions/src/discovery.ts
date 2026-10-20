// Revision discovery (PCMS-PUB-T028, spec §69): machine-readable revision
// operations + deterministic descriptor for agent workflows. Discovery only
// — the transport layer (M09) exposes it.
import type { DbClient, DbPool, StableId } from "@pcms/core";
import { defaultSemanticDiff } from "./diff.js";
import { RevisionError } from "./errors.js";
import type { VersionedEntityRegistry } from "./registry.js";
import type { RevisionStore } from "./store.js";
import type { RevisionActor, SemanticDiff } from "./types.js";

export interface DiscoveryOperation {
  readonly name: string;
  /** Permission key from the M08 registry (structural string). */
  readonly permission: string;
  readonly input: readonly string[];
  readonly output: readonly string[];
}

export interface DiscoveryDescriptor {
  readonly family: string;
  readonly description: string;
  readonly operations: readonly DiscoveryOperation[];
}

function record(value: unknown, omit: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (omit.includes(key)) continue;
    out[key] = member instanceof Date ? member.toISOString() : member !== undefined ? member : null;
  }
  return out;
}

export interface RevisionDiscovery {
  describe(): DiscoveryDescriptor;
  list_revisions(input: {
    entityType: string;
    entityId: StableId;
    limit?: number;
    offset?: number;
  }): Promise<readonly Record<string, unknown>[]>;
  get_revision(input: { revisionId: StableId }): Promise<Record<string, unknown>>;
  diff_revisions(input: {
    fromRevisionId: StableId;
    toRevisionId: StableId;
  }): Promise<SemanticDiff>;
  create_working_revision(input: {
    entityType: string;
    entityId: StableId;
    payload: unknown;
    schemaVersion: string;
    actor: RevisionActor;
  }): Promise<Record<string, unknown>>;
  validate_revision(input: { revisionId: StableId }): Promise<Record<string, unknown>>;
  seal_revision(input: { revisionId: StableId }): Promise<Record<string, unknown>>;
}

const DESCRIPTOR: DiscoveryDescriptor = {
  family: "revisions",
  description: "WORKING/SEALED revision lifecycle over versioned entities (Publication spec §69)",
  operations: [
    {
      name: "list_revisions",
      permission: "publication.read",
      input: ["entityType", "entityId"],
      output: ["RevisionRecord[]"],
    },
    {
      name: "get_revision",
      permission: "publication.read",
      input: ["revisionId"],
      output: ["RevisionRecord"],
    },
    {
      name: "diff_revisions",
      permission: "publication.read",
      input: ["fromRevisionId", "toRevisionId"],
      output: ["SemanticDiff"],
    },
    {
      name: "create_working_revision",
      permission: "content.edit",
      input: ["entityType", "entityId", "payload", "schemaVersion", "actor"],
      output: ["RevisionRecord"],
    },
    {
      name: "validate_revision",
      permission: "revision.seal",
      input: ["revisionId"],
      output: ["issues[]"],
    },
    {
      name: "seal_revision",
      permission: "revision.seal",
      input: ["revisionId"],
      output: ["RevisionRecord"],
    },
  ],
};

export function createRevisionDiscovery(deps: {
  readonly pool: DbPool;
  readonly store: RevisionStore;
  readonly registry: VersionedEntityRegistry;
}): RevisionDiscovery {
  const { pool, store, registry } = deps;
  const executor = pool as unknown as DbClient;
  return {
    describe: () => DESCRIPTOR,
    async list_revisions(input) {
      const records = await store.listRevisions(executor, input.entityType, input.entityId, {
        ...(input.limit !== undefined && { limit: input.limit }),
        ...(input.offset !== undefined && { offset: input.offset }),
      });
      return records.map((entry) => record(entry));
    },
    async get_revision(input) {
      const found = await store.getRevision(executor, input.revisionId);
      if (found === null) {
        throw new RevisionError("REVISION_NOT_FOUND", `revision ${input.revisionId} not found`);
      }
      return record(found);
    },
    async diff_revisions(input) {
      const from = await store.requireRevision(executor, input.fromRevisionId);
      const to = await store.requireRevision(executor, input.toRevisionId);
      if (from.entityType !== to.entityType) {
        throw new RevisionError("REVISION_ENTITY_MISMATCH", "cannot diff across entity types");
      }
      const adapter = registry.get(to.entityType);
      return adapter.semanticDiff !== undefined
        ? adapter.semanticDiff(from.payload, to.payload)
        : defaultSemanticDiff(from.payload, to.payload);
    },
    async create_working_revision(input) {
      registry.get(input.entityType);
      return record(await store.createWorkingRevision(input));
    },
    async validate_revision(input) {
      const found = await store.requireRevision(executor, input.revisionId);
      const adapter = registry.get(found.entityType);
      const issues = await adapter.validateForSeal(found.payload, {
        entityType: found.entityType,
        entityId: found.entityId,
        locale: found.locale,
        revisionState: found.state,
      });
      return {
        revisionId: input.revisionId,
        canSeal: !issues.some((issue) => issue.severity === "error"),
        issues: issues.map((issue) => record(issue)),
      };
    },
    async seal_revision(input) {
      return record(await store.sealRevision({ revisionId: input.revisionId }));
    },
  };
}
