// @pcms/blocks — Block Registry subsystem (M02, PCMS-CONT-T001/T013).
//
// Public application surface of the Block bounded context: the block type
// registry, BlockDocument v1 and block identity. Deep imports are rejected by
// tests/architecture.test.ts.
//
// The registry stays extensible so the Forms subsystem can register
// `form`/`quiz` block types in M12 (Content spec §35 contract note, ADR-0005).

export {
  CALCULATOR_BLOCK,
  type CalculatorIssue,
  evaluateFormula,
  evaluateFormulaText,
  type FormulaNode,
  type FormulaVariables,
  MAX_FORMULA_LENGTH,
  MAX_FORMULA_NODES,
  parseFormula,
} from "./calculator.js";
export {
  type BlockDiscovery,
  type BlockSchemaDescriptor,
  type BlockTypeSummary,
  createBlockDiscovery,
} from "./discovery.js";
export {
  BLOCK_DOCUMENT_SCHEMA_VERSION,
  type BlockDocument,
  type BlockDocumentResult,
  type BlockIssue,
  type BlockNode,
  MAX_BLOCK_NESTING_DEPTH,
  MAX_BLOCKS_PER_DOCUMENT,
  validateBlockDocument,
} from "./document.js";
export { BlocksError } from "./errors.js";
export {
  ACTION_PROP_SCHEMA,
  FIRST_PARTY_BLOCK_TYPES_V1,
  type FirstPartyBlockTypeV1,
  registerFirstPartyBlocksV1,
  STABLE_ID_PATTERN,
} from "./first-party.js";
export { type BlockId, newBlockId } from "./ids.js";
export {
  type BlockReferenceSpec,
  type BlockRegistry,
  type BlockSchemaMigration,
  type BlockTypeDescriptor,
  createBlockRegistry,
  type RegisteredBlockType,
} from "./registry.js";
