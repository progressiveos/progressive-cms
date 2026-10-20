// BlockDocument v1 (PCMS-CONT-T013; Content spec §29/§30/§32/§33/§34).
//
// Canonical conceptual form (§29):
//   { schema_version: 1, blocks: [{ id, type, schema_version, variant, props, children }] }
//
// Block instances carry stable IDs created at insert and preserved across
// edit/reorder (§30). Variants are bounded by the registered type manifest
// (§32); children follow the type's children policy (§33). Nesting and size
// are hard-bounded, and no visual-layout JSON exists — layout belongs to the
// Theme, not to row/column structures with arbitrary styles (§34).

import { isStableId } from "@pcms/core";
import Ajv from "ajv";
import { BlocksError } from "./errors.js";
import type { BlockId } from "./ids.js";
import type { BlockRegistry, RegisteredBlockType } from "./registry.js";

/** Canonical document schema_version (Content spec §29). */
export const BLOCK_DOCUMENT_SCHEMA_VERSION = 1;
/** Hard safety bounds (Content spec §71: max blocks per document / nesting depth). */
export const MAX_BLOCKS_PER_DOCUMENT = 500;
export const MAX_BLOCK_NESTING_DEPTH = 16;

export interface BlockNode {
  readonly id: BlockId;
  readonly type: string;
  readonly schemaVersion: number;
  readonly variant: string | null;
  readonly props: Record<string, unknown>;
  readonly children: BlockNode[];
}

export interface BlockDocument {
  readonly schemaVersion: 1;
  readonly blocks: BlockNode[];
}

export interface BlockIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type BlockDocumentResult =
  | { readonly ok: true; readonly value: BlockDocument }
  | { readonly ok: false; readonly issues: BlockIssue[] };

interface Budget {
  count: number;
}

function issue(path: string, code: string, message: string): BlockIssue {
  return { path, code, message };
}

const BLOCK_KEYS = new Set(["id", "type", "schema_version", "variant", "props", "children"]);
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
type PropsValidator = ReturnType<typeof ajv.compile>;
const compiledSchemas = new WeakMap<object, PropsValidator>();

function propsValidatorFor(registered: RegisteredBlockType): PropsValidator {
  const cached = compiledSchemas.get(registered.propsSchema);
  if (cached !== undefined) return cached;
  const compiled = ajv.compile(registered.propsSchema);
  compiledSchemas.set(registered.propsSchema, compiled);
  return compiled;
}

function allowedChildTypes(registered: RegisteredBlockType): "none" | "any" | Set<string> {
  if (registered.childrenPolicy === "none") return "none";
  if (registered.childrenPolicy === "blocks") return "any";
  return new Set(registered.childrenPolicy);
}

function validateNode(
  node: unknown,
  registry: BlockRegistry,
  path: string,
  depth: number,
  budget: Budget,
  issues: BlockIssue[],
): void {
  if (depth > MAX_BLOCK_NESTING_DEPTH) {
    issues.push(
      issue(path, "BLOCK_NESTING_TOO_DEEP", `block nesting exceeds ${MAX_BLOCK_NESTING_DEPTH}`),
    );
    return;
  }
  budget.count += 1;
  if (budget.count > MAX_BLOCKS_PER_DOCUMENT) {
    issues.push(
      issue(path, "BLOCK_DOCUMENT_TOO_LARGE", `document exceeds ${MAX_BLOCKS_PER_DOCUMENT} blocks`),
    );
    return;
  }
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    issues.push(issue(path, "BLOCK_MALFORMED", "expected a block object"));
    return;
  }
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!BLOCK_KEYS.has(key)) {
      // Remote-developer DX (2026-09-29): bundle fixtures historically used
      // camelCase; the API contract is snake_case. Name the corrected key in
      // the message instead of leaving clients to trial-and-error.
      const snakeCandidate = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      const hint =
        snakeCandidate !== key && BLOCK_KEYS.has(snakeCandidate)
          ? ` — use "${snakeCandidate}"`
          : ` (allowed: ${[...BLOCK_KEYS].join(", ")})`;
      issues.push(
        issue(
          `${path}/${key}`,
          "BLOCK_PROPERTY_UNKNOWN",
          `property "${key}" is not part of BlockDocument v1 (no arbitrary layout/style JSON)${hint}`,
        ),
      );
    }
  }

  const id = record.id;
  if (!isStableId(id)) {
    issues.push(
      issue(`${path}/id`, "BLOCK_ID_INVALID", "every block needs a canonical stable block id"),
    );
  }
  const type = record.type;
  if (typeof type !== "string") {
    issues.push(issue(`${path}/type`, "BLOCK_TYPE_REQUIRED", "block needs a type"));
    return;
  }
  const schemaVersion = record.schema_version;
  if (!Number.isInteger(schemaVersion) || (schemaVersion as number) < 1) {
    issues.push(
      issue(
        `${path}/schema_version`,
        "BLOCK_SCHEMA_VERSION_INVALID",
        "needs a positive integer version",
      ),
    );
    return;
  }
  const registered = registry.getBlockType(type, schemaVersion as number);
  if (registered === null) {
    issues.push(
      issue(
        `${path}/type`,
        "BLOCK_TYPE_UNKNOWN",
        `block type ${type}@${String(schemaVersion)} is not registered`,
      ),
    );
    return;
  }

  const variant = record.variant;
  if (variant !== null && variant !== undefined) {
    if (typeof variant !== "string" || !registered.allowedVariants.includes(variant)) {
      issues.push(
        issue(
          `${path}/variant`,
          "BLOCK_VARIANT_UNSUPPORTED",
          `variant "${String(variant)}" is not allowed for ${type}@${String(schemaVersion)}`,
        ),
      );
    }
  }

  const props = record.props;
  if (typeof props !== "object" || props === null || Array.isArray(props)) {
    issues.push(issue(`${path}/props`, "BLOCK_PROPS_MALFORMED", "props must be an object"));
  } else {
    const validateProps = propsValidatorFor(registered);
    if (!validateProps(props)) {
      const first = validateProps.errors?.[0];
      issues.push(
        issue(
          `${path}/props${first?.instancePath ?? ""}`,
          "BLOCK_PROPS_INVALID",
          `props fail the ${type}@${String(schemaVersion)} schema${first ? `: ${first.message ?? ""}` : ""}`,
        ),
      );
    }
    if (registered.validateProps !== undefined) {
      const semanticIssues = registered.validateProps(props as Record<string, unknown>);
      if (semanticIssues !== null) {
        for (const item of semanticIssues) {
          issues.push(issue(`${path}/props`, item.code, item.message));
        }
      }
    }
  }

  // Children follow the type's declared policy (Content spec §33).
  const children = record.children ?? [];
  if (!Array.isArray(children)) {
    issues.push(issue(`${path}/children`, "BLOCK_CHILDREN_MALFORMED", "children must be an array"));
    return;
  }
  const policy = allowedChildTypes(registered);
  if (policy === "none") {
    if (children.length > 0) {
      issues.push(
        issue(
          `${path}/children`,
          "BLOCK_CHILDREN_FORBIDDEN",
          `block type "${type}" takes no children`,
        ),
      );
    }
    return;
  }
  for (const [index, child] of children.entries()) {
    if (policy !== "any") {
      const childType = (child as { type?: unknown } | null)?.type;
      if (typeof childType === "string" && !policy.has(childType)) {
        issues.push(
          issue(
            `${path}/children/${index}/type`,
            "BLOCK_CHILD_TYPE_REJECTED",
            `block type "${childType}" is not an allowed child of "${type}"`,
          ),
        );
      }
    }
    validateNode(child, registry, `${path}/children/${index}`, depth + 1, budget, issues);
  }
}

/**
 * Validates a BlockDocument value against the registry (Content spec §29).
 * Stable block IDs, bounded nesting/size, registered types@versions,
 * allowed variants and props JSON Schemas are all enforced.
 */
export function validateBlockDocument(
  value: unknown,
  registry: BlockRegistry,
): BlockDocumentResult {
  const issues: BlockIssue[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      issues: [issue("", "BLOCK_DOCUMENT_MALFORMED", "expected a BlockDocument object")],
    };
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== BLOCK_DOCUMENT_SCHEMA_VERSION) {
    return {
      ok: false,
      issues: [
        issue(
          "/schema_version",
          "BLOCK_DOCUMENT_VERSION_UNKNOWN",
          `only BlockDocument schema_version ${BLOCK_DOCUMENT_SCHEMA_VERSION} is supported`,
        ),
      ],
    };
  }
  const blocks = record.blocks;
  if (!Array.isArray(blocks)) {
    return {
      ok: false,
      issues: [issue("/blocks", "BLOCK_DOCUMENT_MALFORMED", "blocks must be an array")],
    };
  }
  const budget: Budget = { count: 0 };
  for (const [index, node] of blocks.entries()) {
    validateNode(node, registry, `/blocks/${index}`, 1, budget, issues);
  }
  if (issues.length > 0) return { ok: false, issues };

  // Normalized view: children default to [] so consumers see one canonical shape.
  const normalize = (node: Record<string, unknown>): BlockNode => ({
    id: node.id as BlockId,
    type: node.type as string,
    schemaVersion: node.schema_version as number,
    variant: (node.variant as string | null | undefined) ?? null,
    props: (node.props as Record<string, unknown>) ?? {},
    children: ((node.children as Record<string, unknown>[]) ?? []).map(normalize),
  });
  return {
    ok: true,
    value: { schemaVersion: 1, blocks: (blocks as Record<string, unknown>[]).map(normalize) },
  };
}

export { BlocksError };
