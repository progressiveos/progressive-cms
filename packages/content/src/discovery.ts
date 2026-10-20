// Machine-readable content discovery (PCMS-CONT-T024; Content spec §73).
//
// The application layer exposes deterministic, JSON-serializable discovery
// models so agents/machines can enumerate the content vocabulary without
// source-code knowledge: list/get content type schemas, field types and
// collection capabilities. Outputs are snapshots — frozen descriptor copies
// in sorted order — never live registry internals.

import { CONTEXT_REFS, FILTER_OPS, MAX_COLLECTION_LIMIT } from "./collections/definition.js";
import type { ContentTypeRegistry, LoadedContentType } from "./content-types/content-type.js";
import type { FieldRegistry } from "./fields/field-registry.js";
import type { ObjectFieldSchema } from "./fields/structured-schemas.js";

export interface ContentTypeSummary {
  readonly key: string;
  readonly version: number;
  readonly title: string;
  readonly bodyPolicy: string;
}

export interface FieldDescriptor {
  readonly type: string;
  readonly required: boolean;
  readonly filterable: boolean;
  readonly sortable: boolean;
  readonly searchable: boolean;
  /** M11 search weight class when the schema declares one (Search spec §5). */
  readonly search_weight: "A" | "B" | "C" | "D" | null;
}

export interface ContentTypeSchemaDescriptor {
  readonly key: string;
  readonly version: number;
  readonly title: string;
  readonly description?: string;
  readonly bodyPolicy: string;
  /** Sorted field descriptors keyed by stable field id. */
  readonly fields: Record<string, FieldDescriptor>;
  /**
   * Full typed field schema keyed by stable field id (PCMS-ADMIN-T002;
   * additive since API contract 1.0.0). The shallow `fields` summary stays
   * unchanged; editors need the deep parameters (enum values, repeater item
   * fields, relation `accepts`, numeric bounds) to render schema-driven forms.
   */
  readonly fieldSchema: ObjectFieldSchema;
}

export interface CollectionCapabilities {
  readonly ops: readonly string[];
  readonly contextRefs: readonly string[];
  readonly maxLimit: number;
}

export interface ContentDiscovery {
  listContentTypes(): ContentTypeSummary[];
  getContentTypeSchema(key: string, version: number): ContentTypeSchemaDescriptor | null;
  getLatestContentTypeSchema(key: string): ContentTypeSchemaDescriptor | null;
  listFieldTypes(): readonly string[];
  getCollectionCapabilities(): CollectionCapabilities;
}

function describe(schema: LoadedContentType): ContentTypeSchemaDescriptor {
  const fields: Record<string, FieldDescriptor> = {};
  for (const name of Object.keys(schema.fieldSchema.fields).sort()) {
    const field = schema.fieldSchema.fields[name];
    if (field === undefined) continue;
    fields[name] = Object.freeze({
      type: String(field.type),
      required: field.required === true,
      filterable: field.filterable === true,
      sortable: field.sortable === true,
      searchable: field.searchable === true,
      search_weight: field.search_weight ?? null,
    });
  }
  // JSON round-trip detaches the snapshot from registry internals; field
  // schemas are JSON-validated at load, so the payload is serializable.
  const fieldSchema = JSON.parse(JSON.stringify(schema.fieldSchema)) as ObjectFieldSchema;
  return {
    key: schema.key,
    version: schema.version,
    title: schema.title,
    ...(schema.description === undefined ? {} : { description: schema.description }),
    bodyPolicy: schema.bodyPolicy,
    fields: Object.freeze(fields),
    fieldSchema: Object.freeze(fieldSchema),
  };
}

export function createContentDiscovery(input: {
  contentTypes: ContentTypeRegistry;
  fields: FieldRegistry;
}): ContentDiscovery {
  const { contentTypes, fields } = input;
  return {
    listContentTypes(): ContentTypeSummary[] {
      return contentTypes.listContentTypes().map((schema) => ({
        key: schema.key,
        version: schema.version,
        title: schema.title,
        bodyPolicy: schema.bodyPolicy,
      }));
    },

    getContentTypeSchema(key: string, version: number): ContentTypeSchemaDescriptor | null {
      const schema = contentTypes.getContentType(key, version);
      return schema === null ? null : describe(schema);
    },

    getLatestContentTypeSchema(key: string): ContentTypeSchemaDescriptor | null {
      const schema = contentTypes.getLatestContentType(key);
      return schema === null ? null : describe(schema);
    },

    listFieldTypes(): readonly string[] {
      return Object.freeze(fields.listFieldTypes().map((descriptor) => descriptor.name));
    },

    getCollectionCapabilities(): CollectionCapabilities {
      return Object.freeze({
        ops: [...FILTER_OPS],
        contextRefs: [...CONTEXT_REFS],
        maxLimit: MAX_COLLECTION_LIMIT,
      });
    },
  };
}
