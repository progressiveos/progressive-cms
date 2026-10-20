// @pcms/content — Content Model & Blocks subsystem (M02, PCMS-CONT-T001).
//
// Public application surface of the Content bounded context. Other packages
// interact with Content exclusively through what this entry re-exports
// (Baseline §6: modules interact via public application contracts, events,
// registries — never through internals or tables, Content spec §82).
// Deep imports like "@pcms/content/src/…" are a boundary violation and are
// rejected by tests/architecture.test.ts.
//
// Later M02 tasks re-export their public contracts here:
//   Field Registry (T005+), ContentType registry (T011), validation (T012),
//   discovery (T024).

export {
  CONTEXT_REFS,
  type CollectionDefinition,
  type CollectionMode,
  type ContextRef,
  FILTER_OPS,
  type FilterCondition,
  type FilterOp,
  MAX_COLLECTION_LIMIT,
  type SortDirection,
  type SortSpec,
  validateCollectionDefinition,
} from "./collections/definition.js";
export {
  type CollectionSourceBinding,
  type CompiledCollectionQuery,
  compileAutomaticCollection,
} from "./collections/query.js";
export {
  type CollectionResolveResult,
  type CollectionResolver,
  createCollectionResolver,
} from "./collections/resolver.js";
export {
  type BodyPolicyType,
  type ContentTypeDefinition,
  type ContentTypeRegistry,
  createContentTypeRegistry,
  type LoadedContentType,
  SEMANTIC_FIELD_IDS_V1,
} from "./content-types/content-type.js";
export { loadContentTypeDefinitions } from "./content-types/load-definitions.js";
export {
  type ContentTypeDiff,
  diffContentTypeDefinitions,
  effectiveContentTypeDefinitions,
  loadContentTypeOverrides,
  mergeContentTypeDefinitions,
  parseDefinitionsInput,
} from "./content-types/overrides.js";
export {
  createSchemaMigrationRegistry,
  type SchemaMigration,
  type SchemaMigrationRegistry,
} from "./content-types/schema-migrations.js";
export {
  type CollectionCapabilities,
  type ContentDiscovery,
  type ContentTypeSchemaDescriptor,
  type ContentTypeSummary,
  createContentDiscovery,
  type FieldDescriptor,
} from "./discovery.js";
export {
  type ContentTreeService,
  createContentTreeService,
  TREE_WALK_LIMIT,
} from "./entries/content-tree.js";
export {
  type CreateEntryInput,
  createEntriesService,
  ENTRY_KINDS,
  type EntriesService,
  type EntryKind,
  type EntryRecord,
} from "./entries/entries.js";
export { ContentError } from "./errors.js";
export {
  EXTENSIONS_KEY,
  type ExtensionIssue,
  extensionIssues,
  extractExtensions,
  isExtensionNamespace,
  MAX_EXTENSIONS_BYTES,
  mergeExtensions,
} from "./extensions/extension-data.js";
export {
  createFieldRegistry,
  FIELD_TYPES_V1,
  type FieldRegistry,
  type FieldTypeDescriptor,
  type FieldTypeName,
} from "./fields/field-registry.js";
export { ICON_CATALOG_V1, isInIconCatalog } from "./fields/icon-catalog.js";
export {
  checkRelationTarget,
  type EntryLookup,
  type MediaListValue,
  type MediaValue,
  type ReferenceIssue,
  type RelationListValue,
  type RelationValue,
  validateMediaListValue,
  validateMediaValue,
  validateRelationListValue,
  validateRelationValue,
} from "./fields/reference-fields.js";
export {
  dateIssues,
  datetimeIssues,
  decimalIssues,
  enumIssues,
  integerIssues,
  moneyIssues,
} from "./fields/scalar-serialization.js";
export {
  type DecimalFieldSchema,
  defineDateSchema,
  defineDatetimeSchema,
  defineDecimalSchema,
  defineEnumSchema,
  defineIntegerSchema,
  defineListSchema,
  defineMoneySchema,
  defineObjectSchema,
  defineRelationListSchema,
  defineRelationSchema,
  defineRepeaterSchema,
  type EnumFieldSchema,
  type FieldSchema,
  type IntegerFieldSchema,
  type ListFieldSchema,
  MAX_REPEATER_ITEMS,
  MAX_SCHEMA_DEPTH,
  type MoneyFieldSchema,
  type ObjectFieldSchema,
  REPEATER_ITEM_ID_KEY,
  type RelationFieldSchema,
  type RelationListFieldSchema,
  type RepeaterFieldSchema,
  type ScalarFieldSchema,
  SEARCH_WEIGHT_CLASSES,
  type SearchWeightClass,
  type StructuredIssue,
  type StructuredValidationResult,
  validateStructuredValue,
} from "./fields/structured-schemas.js";
export {
  type CreateGlobalInput,
  createGlobalContentService,
  type GlobalContentRecord,
  type GlobalContentService,
} from "./globals/global-content.js";
export {
  type EntryId,
  isStableId,
  newEntryId,
  newRepeaterItemId,
  newStableId,
  type RepeaterItemId,
  type StableId,
  stableIdAs,
} from "./ids/stable-id.js";
export {
  createReferenceGraphService,
  type DeleteImpactResult,
  type ExtractedReference,
  extractReferences,
  type InboundReference,
  type ReferenceGraphService,
  type ReferenceTargetKind,
} from "./references/reference-graph.js";
export {
  RICHTEXT_AST_VERSIONS,
  RICHTEXT_MARKS,
  RICHTEXT_MAX_DEPTH,
  RICHTEXT_MAX_NODES,
  RICHTEXT_NODE_TYPES,
  type RichTextMark,
  type RichTextNodeType,
  type RichTextValidationResult,
  validateRichText,
} from "./richtext/ast.js";
export {
  containsRawHtml,
  markdownToRichText,
  type RichTextNode,
  richTextToMarkdown,
} from "./richtext/markdown.js";
export {
  type ContentValidationResult,
  type ContentValidatorOptions,
  type ValidationIssue,
  type ValidationLevel,
  type ValidationSeverity,
  validateContentPayload,
  validateContentPayloadAsync,
} from "./validation/content-validation.js";
export const PACKAGE_NAME = "@pcms/content";

export { collectRichTextMediaIds } from "./richtext/migrate.js";
