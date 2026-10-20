// Collection resolver: manual / automatic / hybrid (PCMS-CONT-T021;
// Content spec §56).
//
// manual   — pinned Entry IDs in their explicit order;
// automatic— the compiled query result;
// hybrid   — pinned IDs first, then automatic fill excluding duplicates
//            (Content spec §56: "pinned Entry IDs + automatic fill excluding
//            duplicates").
import type { DbPool } from "@pcms/core";
import type { LoadedContentType } from "../content-types/content-type.js";
import { isStableId, type StableId } from "../ids/stable-id.js";
import {
  type CollectionDefinition,
  MAX_COLLECTION_LIMIT,
  validateCollectionDefinition,
} from "./definition.js";
import { type CollectionSourceBinding, compileAutomaticCollection } from "./query.js";

export interface CollectionResolveResult {
  /** Ordered entry IDs: pinned order first, no duplicates. */
  readonly entryIds: StableId[];
  readonly mode: CollectionDefinition["mode"];
  /** How many entries came from the automatic fill (manual/hybrid only). */
  readonly automaticFillCount: number;
}

export interface CollectionResolver {
  resolve(
    definition: CollectionDefinition,
    schemas: ReadonlyMap<string, LoadedContentType>,
    source: CollectionSourceBinding,
    options?: { numericFields?: readonly string[] },
  ): Promise<CollectionResolveResult>;
}

export function createCollectionResolver(pool: DbPool): CollectionResolver {
  return {
    async resolve(definition, schemas, source, options = {}): Promise<CollectionResolveResult> {
      validateCollectionDefinition(definition, schemas);
      const pinned = definition.pinnedIds ?? [];

      if (definition.mode === "manual") {
        return { entryIds: [...pinned], mode: "manual", automaticFillCount: 0 };
      }

      const limit = definition.limit ?? MAX_COLLECTION_LIMIT;
      const compiled = compileAutomaticCollection(
        {
          contentTypes: definition.source.contentTypes,
          ...(definition.filters === undefined ? {} : { filters: definition.filters }),
          ...(definition.sort === undefined ? {} : { sort: definition.sort }),
          limit,
          ...(options.numericFields === undefined ? {} : { numericFields: options.numericFields }),
        },
        source,
      );
      const result = await pool.query<{ entry_id: string }>(compiled.sql, [...compiled.params]);
      const automaticIds = result.rows
        .map((row) => row.entry_id)
        .filter((id) => isStableId(id))
        .map((id) => id as StableId);

      if (definition.mode === "automatic") {
        return {
          entryIds: automaticIds,
          mode: "automatic",
          automaticFillCount: automaticIds.length,
        };
      }

      // Hybrid: pinned first, automatic fill excluding duplicates.
      const seen = new Set<string>(pinned);
      const fill: StableId[] = [];
      for (const id of automaticIds) {
        if (fill.length + pinned.length >= limit) break;
        if (!seen.has(id)) {
          seen.add(id);
          fill.push(id);
        }
      }
      return {
        entryIds: [...pinned, ...fill],
        mode: "hybrid",
        automaticFillCount: fill.length,
      };
    },
  };
}
