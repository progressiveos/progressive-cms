// Reference composition helpers for M07 publication (PCMS-PUB-T010/T011).
// L1 packages cannot import each other, so cross-subsystem facts flow through
// structural ports; these helpers are the canonical wiring M09/apps reuse —
// same role `tests/helpers/navigation-viewmodels.ts` played for M04.
import type { DbPool, StableId } from "@pcms/core";
import { getAsset } from "@pcms/media";
import type { NavigationService } from "@pcms/navigation";
import type {
  PublicationValidator,
  RevisionReaderPort,
  SealedRevisionRef,
} from "@pcms/publication";
import type { MediaSnapshotPort, RevisionStore } from "@pcms/revisions";
import { hashCanonicalPayload } from "@pcms/revisions";

export function revisionReaderFromStore(store: RevisionStore): RevisionReaderPort {
  return {
    async getSealedRevision(executor, entityType, entityId, revisionId) {
      const record = await store.getRevision(executor, revisionId);
      if (record === null) return null;
      if (record.state !== "SEALED") return null;
      if (record.entityType !== entityType || record.entityId !== entityId) return null;
      if (record.payloadHash === null) return null;
      const ref: SealedRevisionRef = {
        revisionId: record.id,
        entityType: record.entityType,
        entityId: record.entityId,
        payloadHash: record.payloadHash,
        schemaVersion: record.schemaVersion,
        locale: record.locale,
        payload: record.payload,
        mediaVersions: record.mediaVersions,
        sidecar: record.sidecar,
        sealedAt: record.sealedAt ?? record.createdAt,
      };
      return ref;
    },
  };
}

/** Current-version resolution over the media subsystem (spec §52). */
export const mediaSnapshotPortFromPool = (pool: DbPool): MediaSnapshotPort => ({
  async resolveCurrentVersions(assetIds: readonly string[]) {
    const out: Record<string, number> = {};
    for (const assetId of assetIds) {
      const asset = await getAsset(pool, assetId as StableId);
      if (asset !== null) out[assetId] = asset.currentVersionNo;
    }
    return out;
  },
});

/**
 * Route-availability gate over the combined prospective resulting state
 * (spec §20, owner instruction #33): a proposed path conflicts only if it is
 * occupied by a CURRENT route that no candidate in the same operation frees.
 * Same-release swaps therefore do not self-collide.
 */
export function createRouteAvailabilityValidator(deps: {
  findActiveRoute: (
    siteId: string,
    path: string,
    locale: string | undefined,
  ) => Promise<{ readonly id: string } | null>;
}): PublicationValidator {
  type Key = string;
  // locale stays optional end-to-end: the injected findActiveRoute resolves
  // the site default, and proposed/freed keys stay consistent per release.
  const keyOf = (siteId: string, locale: string | undefined, path: string): Key =>
    `${siteId}\u0000${locale ?? ""}\u0000${path}`;
  return {
    name: "routing",
    async validate(candidates) {
      const issues: {
        code: string;
        severity: "error" | "warning";
        message: string;
        path?: string;
        candidateIndex?: number;
      }[] = [];
      const freed = new Set<Key>();
      for (const candidate of candidates) {
        const op = candidate.routeOperation;
        if (op.kind === "set" && op.freesPath !== undefined) {
          freed.add(keyOf(op.siteId, op.locale, op.freesPath));
        }
      }
      const proposed = new Map<Key, number>();
      for (let index = 0; index < candidates.length; index += 1) {
        const op = candidates[index]!.routeOperation;
        if (op.kind !== "set") continue;
        const key = keyOf(op.siteId, op.locale, op.path);
        // Intra-release duplicate proposal.
        const previousIndex = proposed.get(key);
        if (previousIndex !== undefined) {
          issues.push({
            code: "ROUTE_CONFLICT",
            severity: "error",
            message: `candidates ${previousIndex} and ${index} both claim ${op.path}`,
            candidateIndex: index,
          });
          continue;
        }
        proposed.set(key, index);
        // Combined-state check: current route must be freed within the release.
        const active = await deps.findActiveRoute(op.siteId, op.path, op.locale);
        if (active !== null && !freed.has(key)) {
          issues.push({
            code: "ROUTE_CONFLICT",
            severity: "error",
            message: `path ${op.path} is occupied by an active route not freed in this release`,
            candidateIndex: index,
          });
        }
      }
      return issues;
    },
  };
}

/** Structural view of a media readiness gate (media refs must exist). */
export function createMediaReadinessValidator(deps: {
  assetExists: (assetId: string) => Promise<boolean>;
  extractMediaAssetIds: (payload: unknown) => readonly string[];
}): PublicationValidator {
  return {
    name: "media",
    async validate(candidates) {
      const issues: {
        code: string;
        severity: "error" | "warning";
        message: string;
        path?: string;
        candidateIndex?: number;
      }[] = [];
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]!;
        const refs = deps.extractMediaAssetIds(candidate.targetRevision?.payload ?? null);
        for (const assetId of refs) {
          if (!(await deps.assetExists(assetId))) {
            issues.push({
              code: "MEDIA_NOT_READY",
              severity: "error",
              message: `media asset ${assetId} is missing or not ready`,
              candidateIndex: index,
              path: `/media/${assetId}`,
            });
          }
        }
      }
      return issues;
    },
  };
}

/**
 * Navigation revision port: adapts M04's sealed `navigation_revisions`
 * snapshots (the revision-facing contract M07 adopts) into the publication
 * RevisionReaderPort — no second navigation revision universe is created
 * (owner instruction #28). Navigation snapshots carry no stored hash, so the
 * deterministic canonical hash is computed here, composition-side.
 */
export function navigationRevisionPort(navigation: NavigationService): RevisionReaderPort {
  const hashOf = (payload: unknown) => hashCanonicalPayload(payload);
  return {
    async getSealedRevision(executor, entityType, entityId, revisionId) {
      if (entityType !== "navigation") return null;
      void executor;
      const revisions = await navigation.listRevisions(entityId);
      const found = revisions.find((revision) => revision.id === revisionId);
      if (found === undefined) return null;
      const ref: SealedRevisionRef = {
        revisionId: found.id as StableId,
        entityType: "navigation",
        entityId: found.setId as StableId,
        payloadHash: hashOf(found.payload),
        schemaVersion: "1",
        locale: "default",
        payload: found.payload,
        mediaVersions: null,
        sidecar: null,
        sealedAt: found.createdAt,
      };
      return ref;
    },
  };
}

/**
 * Composite revision port: dispatches by entity type to subsystem adapters
 * (generic revisions store, navigation snapshots, ...). This is the
 * composition-level replacement for entity-type conditionals inside L1.
 */
export function compositeRevisionPort(
  ports: readonly {
    readonly matches: (entityType: string) => boolean;
    readonly port: RevisionReaderPort;
  }[],
): RevisionReaderPort {
  return {
    async getSealedRevision(executor, entityType, entityId, revisionId) {
      for (const { matches, port } of ports) {
        if (matches(entityType)) {
          return port.getSealedRevision(executor, entityType, entityId, revisionId);
        }
      }
      return null;
    },
  };
}

/**
 * RouteOperationsPort adapter over the routing `*WithinTx` seams (T015):
 * applies same-release route operations on the apply transaction. `set` with
 * `freesPath` retires the old canonical route first; activation reuses the
 * routing service's own collision pre-check (unique index backstop).
 */
export function routeOperationsPort(
  routes: RoutingLike,
  canonical: {
    findRouteByEntry(entryId: string): Promise<{ route: { siteId: string; path: string } | null }>;
  },
): RouteOpsLike {
  return {
    async activateWithinTx(client, operation) {
      if (operation.freesPath !== undefined) {
        await routes.retireRouteWithinTx(client, {
          siteId: operation.siteId,
          path: operation.freesPath,
        });
      }
      await routes.activateRouteWithinTx(client, {
        siteId: operation.siteId,
        path: operation.path,
        targetType: "entry",
        targetId: operation.entityId,
      });
    },
    async retireWithinTx(client, input) {
      const found = await canonical.findRouteByEntry(input.entityId);
      if (found.route !== null) {
        await routes.retireRouteWithinTx(client, {
          siteId: found.route.siteId,
          path: found.route.path,
        });
      }
    },
  };
}

/** Structural subset of @pcms/routing's RouteService used by the adapter. */
export interface RoutingLike {
  activateRouteWithinTx(
    client: import("@pcms/core").DbClient,
    input: { siteId: string; path: string; targetType: "entry" | "system"; targetId: string },
  ): Promise<unknown>;
  retireRouteWithinTx(
    client: import("@pcms/core").DbClient,
    input: { siteId: string; path: string },
  ): Promise<void>;
}

export interface RouteOpsLike {
  activateWithinTx(
    client: import("@pcms/core").DbClient,
    operation: {
      kind: "set";
      siteId: string;
      path: string;
      freesPath?: string;
      entityId: import("@pcms/core").StableId;
    },
  ): Promise<void>;
  retireWithinTx(
    client: import("@pcms/core").DbClient,
    input: { entityType: string; entityId: import("@pcms/core").StableId },
  ): Promise<void>;
}
