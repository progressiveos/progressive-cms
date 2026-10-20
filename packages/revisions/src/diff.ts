// Semantic revision diff (PCMS-PUB-T012, spec §71). Never a raw JSON diff:
// field-level changes use JSON-pointer paths, and block documents get
// block-level axes (added/removed/moved/changed) keyed by stable block IDs.
// Output is deterministic: paths and block entries are sorted.
import { RevisionError } from "./errors.js";
import type { SemanticDiff } from "./types.js";

const MAX_DEPTH = 32;
const MAX_ENTRIES = 1000;

export const EMPTY_DIFF: SemanticDiff = {
  fieldsChanged: [],
  fieldsAdded: [],
  fieldsRemoved: [],
  blocksAdded: [],
  blocksRemoved: [],
  blocksMoved: [],
  blocksChanged: [],
  relationsChanged: [],
};

interface FieldChange {
  readonly path: string;
  readonly from: unknown;
  readonly to: unknown;
}

/** Recursive leaf-level pointer diff between two canonical payloads. */
export function diffPayloads(
  from: unknown,
  to: unknown,
): {
  readonly fieldsChanged: readonly FieldChange[];
  readonly fieldsAdded: readonly { readonly path: string; readonly value: unknown }[];
  readonly fieldsRemoved: readonly { readonly path: string; readonly value: unknown }[];
} {
  const changed: FieldChange[] = [];
  const added: { path: string; value: unknown }[] = [];
  const removed: { path: string; value: unknown }[] = [];
  walk(from, to, "", 0);
  if (changed.length + added.length + removed.length >= MAX_ENTRIES) {
    throw new RevisionError(
      "REVISION_DIFF_ADAPTER_MISSING",
      `payload diff exceeds ${MAX_ENTRIES} entries; register an entity-specific diff adapter`,
    );
  }
  return { fieldsChanged: changed, fieldsAdded: added, fieldsRemoved: removed };

  function walk(a: unknown, b: unknown, path: string, depth: number): void {
    if (depth > MAX_DEPTH) {
      throw new RevisionError("REVISION_DIFF_ADAPTER_MISSING", "payload diff exceeds depth 32");
    }
    if (a === b) return;
    const aObj = isPlainObject(a);
    const bObj = isPlainObject(b);
    if (aObj && bObj) {
      const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])].sort();
      for (const key of keys) {
        const childA = (a as Record<string, unknown>)[key];
        const childB = (b as Record<string, unknown>)[key];
        const escaped = escapeToken(key);
        if (childA === undefined) added.push({ path: `${path}/${escaped}`, value: childB });
        else if (childB === undefined) removed.push({ path: `${path}/${escaped}`, value: childA });
        else walk(childA, childB, `${path}/${escaped}`, depth + 1);
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      // Array positions are semantic for lists; positional compare, length
      // mismatch handled as trailing remove/add.
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len; i += 1) {
        const childA = a[i];
        const childB = b[i];
        if (childA === undefined) added.push({ path: `${path}/${i}`, value: childB });
        else if (childB === undefined) removed.push({ path: `${path}/${i}`, value: childA });
        else walk(childA, childB, `${path}/${i}`, depth + 1);
      }
      return;
    }
    changed.push({ path: path === "" ? "/" : path, from: a, to: b });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

interface BlockLike {
  readonly id: string;
  readonly type: string;
}

function readBlocks(payload: unknown): readonly BlockLike[] | null {
  if (!isPlainObject(payload)) return null;
  const blocks = payload["blocks"];
  if (!Array.isArray(blocks)) return null;
  const out: BlockLike[] = [];
  for (const block of blocks) {
    if (!isPlainObject(block)) return null;
    const id = block["id"];
    const type = block["type"];
    if (typeof id !== "string" || typeof type !== "string") return null;
    out.push({ id, type });
  }
  return out;
}

/**
 * Block-document axis diff for structural `{ blocks: [{ id, type, ... }] }`
 * payloads. `changed` is decided with the field diff: same stable ID with any
 * differing member. Deterministic (sorted by block ID within each axis).
 */
export function diffBlockDocuments(
  from: unknown,
  to: unknown,
): Partial<Pick<SemanticDiff, "blocksAdded" | "blocksRemoved" | "blocksMoved" | "blocksChanged">> {
  const fromBlocks = readBlocks(from);
  const toBlocks = readBlocks(to);
  if (fromBlocks === null || toBlocks === null) return {};
  const fromById = new Map(fromBlocks.map((b, index) => [b.id, { ...b, index }]));
  const toById = new Map(toBlocks.map((b, index) => [b.id, { ...b, index }]));

  const byBlockId = (a: BlockLike, b: BlockLike) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const blocksAdded = toBlocks.filter((b) => !fromById.has(b.id)).sort(byBlockId);
  const blocksRemoved = fromBlocks.filter((b) => !toById.has(b.id)).sort(byBlockId);
  const blocksMoved: { id: string; from: number; to: number }[] = [];
  const blocksChanged: { id: string; type: string }[] = [];
  for (const b of toBlocks) {
    const before = fromById.get(b.id);
    if (before === undefined) continue;
    if (before.index !== toById.get(b.id)!.index) {
      blocksMoved.push({ id: b.id, from: before.index, to: toById.get(b.id)!.index });
    }
  }
  return {
    ...(blocksAdded.length > 0 && { blocksAdded }),
    ...(blocksRemoved.length > 0 && { blocksRemoved }),
    ...(blocksMoved.length > 0 && { blocksMoved }),
    ...(blocksChanged.length > 0 && { blocksChanged }),
  };
}

/**
 * Default semantic diff for an entity: field axes from the pointer diff,
 * block axes when both payloads carry structural block lists. Adapters may
 * override `semanticDiff` entirely (registry hook).
 */
export function defaultSemanticDiff(from: unknown, to: unknown): SemanticDiff {
  const fields = diffPayloads(from, to);
  const blocks = diffBlockDocuments(from, to);
  return {
    ...EMPTY_DIFF,
    fieldsChanged: fields.fieldsChanged,
    fieldsAdded: fields.fieldsAdded,
    fieldsRemoved: fields.fieldsRemoved,
    ...blocks,
  };
}

/** Media/relation reference extraction over structural `media`/`relation`
 * shaped values — used to populate `relationsChanged` for adapters that opt
 * in. Deterministic, pointer-sorted. */
export function diffRelations(
  from: unknown,
  to: unknown,
  referencesAt: (
    payload: unknown,
  ) => readonly { readonly path: string; readonly targetId: string }[],
): SemanticDiff["relationsChanged"] {
  const before = new Map(referencesAt(from).map((r) => [r.path, r.targetId]));
  const after = referencesAt(to);
  const changes: { path: string; from: unknown; to: unknown }[] = [];
  for (const ref of after) {
    const previous = before.get(ref.path);
    if (previous !== ref.targetId) {
      changes.push({ path: ref.path, from: previous ?? null, to: ref.targetId });
    }
    before.delete(ref.path);
  }
  for (const [path, targetId] of [...before.entries()].sort()) {
    changes.push({ path, from: targetId, to: null });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : 1));
}
