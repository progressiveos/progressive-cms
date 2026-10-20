// Machine-readable block discovery (PCMS-CONT-T024; Content spec §73).
// list/get block type schemas without source-code knowledge: descriptors are
// deterministic JSON snapshots of the registry state.
import type { BlockRegistry, RegisteredBlockType } from "./registry.js";

export interface BlockTypeSummary {
  readonly typeId: string;
  readonly versions: readonly number[];
}

export interface BlockSchemaDescriptor {
  readonly typeId: string;
  readonly schemaVersion: number;
  readonly propsSchema: Record<string, unknown>;
  readonly childrenPolicy: "none" | "blocks" | readonly string[];
  readonly allowedVariants: readonly string[];
  readonly references: RegisteredBlockType["references"];
  readonly rendererCapabilityKey?: string;
}

export interface BlockDiscovery {
  listBlockTypes(): BlockTypeSummary[];
  getBlockSchema(typeId: string, schemaVersion: number): BlockSchemaDescriptor | null;
}

function describe(registered: RegisteredBlockType): BlockSchemaDescriptor {
  return {
    typeId: registered.typeId,
    schemaVersion: registered.schemaVersion,
    propsSchema: registered.propsSchema,
    childrenPolicy: registered.childrenPolicy,
    allowedVariants: [...registered.allowedVariants],
    references: registered.references,
    ...(registered.rendererCapabilityKey === undefined
      ? {}
      : { rendererCapabilityKey: registered.rendererCapabilityKey }),
  };
}

export function createBlockDiscovery(registry: BlockRegistry): BlockDiscovery {
  return {
    listBlockTypes(): BlockTypeSummary[] {
      return registry.listBlockTypeVersions();
    },
    getBlockSchema(typeId: string, schemaVersion: number): BlockSchemaDescriptor | null {
      const registered = registry.getBlockType(typeId, schemaVersion);
      return registered === null ? null : describe(registered);
    },
  };
}
