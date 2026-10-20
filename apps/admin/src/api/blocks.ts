// Block discovery + validation fetchers (PCMS-ADMIN-T006/T007).
import { apiGet, apiPost } from "./client.js";

export interface BlockTypeSummary {
  readonly typeId: string;
  readonly versions: readonly number[];
}

/** JSON-schema subset used by first-party block props schemas (v1). */
export interface BlockPropSchema {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, BlockPropSchema>>;
  readonly items?: BlockPropSchema;
  readonly required?: readonly string[];
  readonly enum?: readonly string[];
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly additionalProperties?: boolean;
  readonly anyOf?: readonly BlockPropSchema[];
  readonly allOf?: readonly Record<string, unknown>[];
  readonly title?: string;
}

export interface BlockReferenceSpec {
  readonly prop: string;
  readonly kind: "media" | "relation";
  readonly accepts?: readonly string[];
  readonly list?: boolean;
}

export interface BlockSchemaWire {
  readonly typeId: string;
  readonly schemaVersion: number;
  readonly propsSchema: BlockPropSchema;
  readonly childrenPolicy: "none" | "blocks" | readonly string[];
  readonly allowedVariants: readonly string[];
  readonly references: readonly BlockReferenceSpec[];
}

export interface BlockNodeWire {
  readonly id: string;
  readonly type: string;
  readonly schema_version: number;
  readonly variant: string | null;
  readonly props: Record<string, unknown>;
  readonly children: readonly BlockNodeWire[];
}

export interface BlockDocumentWire {
  readonly schema_version: number;
  readonly blocks: readonly BlockNodeWire[];
}

export interface ValidateBlockResultWire {
  readonly ok: boolean;
  readonly issues: readonly {
    readonly code: string;
    readonly path: string;
    readonly message: string;
  }[];
  readonly computed?: readonly { readonly label: string; readonly value: string }[];
}

export function listBlockTypes(): Promise<{ items: readonly BlockTypeSummary[] }> {
  return apiGet("/discovery/blocks");
}

export function getBlockSchema(typeId: string): Promise<BlockSchemaWire> {
  return apiGet(`/discovery/blocks/${encodeURIComponent(typeId)}`);
}

export function validateBlock(
  typeId: string,
  props: Record<string, unknown>,
  sampleValues?: Record<string, number>,
): Promise<ValidateBlockResultWire> {
  return apiPost<ValidateBlockResultWire>("/blocks/validate", {
    type_id: typeId,
    props,
    ...(sampleValues === undefined ? {} : { sample_values: sampleValues }),
  });
}
