// Block Registry (PCMS-CONT-T013; Content spec §31/§32/§33/§35).
//
// The registry is the controlled extension point for block types: every type
// registers its JSON-Schema props contract, bounded variant set, children
// policy and reference declarations. It never executes arbitrary uploaded
// code (§31) — descriptors are pure data, props schemas are validated by
// compiling with AJV (the approved JSON Schema machinery, ADR-0004) and
// failing registration when they do not compile.
//
// The registry stays extensible so first-party subsystems can register their
// own block types later — the Forms subsystem registers `form`/`quiz` in M12
// (Content spec §35 contract note, ADR-0005).

import type { StableId } from "@pcms/core";
import Ajv from "ajv";
import { BlocksError } from "./errors.js";

/** Where a block's declared reference lives and what it may point at (§31). */
export interface BlockReferenceSpec {
  /** Props key carrying the reference. */
  readonly prop: string;
  readonly kind: "media" | "relation";
  /** For relations: accepted target content type keys. */
  readonly accepts?: readonly string[];
  /** True when the prop holds an ordered list of references. */
  readonly list?: boolean;
}

export interface BlockTypeDescriptor {
  /** Machine-stable block type key, e.g. "text", "gallery". */
  readonly typeId: string;
  /** Per-type payload schema version, starts at 1 (Content spec §70). */
  readonly schemaVersion: number;
  /** JSON Schema (object form) for the block's `props` (Content spec §31). */
  readonly propsSchema: Record<string, unknown>;
  /**
   * Children policy (Content spec §33): "none", "blocks" (any registered
   * block type), or an explicit allowlist of type ids.
   */
  readonly childrenPolicy: "none" | "blocks" | readonly string[];
  /** Bounded presentation intents; `variant` must be null or one of these (§32). */
  readonly allowedVariants?: readonly string[];
  /**
   * Prop names whose values are RichText AST documents (Content spec §15) —
   * PCMD authoring sugar bridges Markdown strings for exactly these names.
   * Per-type, because a name like "text" is a plain string on heading@1 but
   * rich text on cta@1.
   */
  readonly richTextProps?: readonly string[];
  /** Declared references for the relation/usage graph (Content spec §60). */
  readonly references?: readonly BlockReferenceSpec[];
  /** Renderer capability key surfaced to the Theme Contract discovery. */
  readonly rendererCapabilityKey?: string;
  /**
   * Optional semantic props check beyond the JSON Schema (e.g. formula
   * syntax). Pure function over the props — no I/O, no uploaded code runs
   * here (Content spec §31).
   */
  readonly validateProps?: (
    props: Record<string, unknown>,
  ) => ReadonlyArray<{ code: string; message: string }> | null;
}

export interface RegisteredBlockType {
  readonly typeId: string;
  readonly schemaVersion: number;
  readonly propsSchema: Record<string, unknown>;
  readonly childrenPolicy: BlockTypeDescriptor["childrenPolicy"];
  readonly allowedVariants: readonly string[];
  readonly richTextProps: readonly string[];
  readonly references: readonly BlockReferenceSpec[];
  readonly rendererCapabilityKey?: string;
  readonly validateProps?: (
    props: Record<string, unknown>,
  ) => ReadonlyArray<{ code: string; message: string }> | null;
}

const TYPE_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
const VARIANT_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/** Canonical block props migration path (Content spec §70). */
export interface BlockSchemaMigration {
  readonly typeId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  /** Pure deterministic props transform — no I/O, no theme involvement. */
  readonly migrateProps: (props: Record<string, unknown>) => Record<string, unknown>;
}

export interface BlockRegistry {
  /** Registers one (typeId, schemaVersion) — the controlled extension point. */
  registerBlockType(descriptor: BlockTypeDescriptor): RegisteredBlockType;
  /** Registers the canonical (typeId, from→to) props migration (§70). */
  registerBlockMigration(migration: BlockSchemaMigration): void;
  /**
   * Migrates block props along the registered chain (deterministic, guarded
   * by the from-version check).
   */
  migrateBlockProps(
    typeId: string,
    fromVersion: number,
    props: Record<string, unknown>,
    toVersion?: number,
  ): { readonly toVersion: number; readonly props: Record<string, unknown> };
  getBlockType(typeId: string, schemaVersion: number): RegisteredBlockType | null;
  getLatestBlockType(typeId: string): RegisteredBlockType | null;
  /** All registered types, sorted by typeId then schemaVersion — deterministic. */
  listBlockTypes(): RegisteredBlockType[];
  /** Distinct type ids with available versions, sorted — machine discovery. */
  listBlockTypeVersions(): Array<{ typeId: string; versions: number[] }>;
  /**
   * Merges THEME-declared presentation variants into a registered block type
   * (2026-09-29: theme.json block_renderers[].variants were dead — content
   * validation rejected every variant with BLOCK_VARIANT_UNSUPPORTED and
   * discovery reported allowedVariants: []). The registry stays the single
   * validation point; the theme is the variant SOURCE. Unknown typeIds are
   * ignored (themes may target extension blocks that are not installed).
   */
  extendBlockVariants(typeId: string, variants: readonly string[]): void;
}

export function createBlockRegistry(): BlockRegistry {
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  const byTypeVersion = new Map<string, RegisteredBlockType>();
  const migrations = new Map<string, BlockSchemaMigration[]>();

  return {
    registerBlockMigration(migration: BlockSchemaMigration): void {
      const { typeId, fromVersion, toVersion } = migration;
      if (!Number.isInteger(fromVersion) || fromVersion < 1 || toVersion !== fromVersion + 1) {
        throw new BlocksError(
          "BLOCK_MIGRATION_INVALID",
          `migration "${typeId}" must step exactly one version`,
        );
      }
      const list = migrations.get(typeId) ?? [];
      if (list.some((existing) => existing.fromVersion === fromVersion)) {
        throw new BlocksError(
          "BLOCK_MIGRATION_EXISTS",
          `a migration for ${typeId}@${fromVersion} is already registered`,
        );
      }
      list.push(migration);
      migrations.set(typeId, list);
    },

    migrateBlockProps(
      typeId: string,
      fromVersion: number,
      props: Record<string, unknown>,
      toVersion?: number,
    ): { readonly toVersion: number; readonly props: Record<string, unknown> } {
      const list = migrations.get(typeId);
      if (list === undefined || list.length === 0) {
        throw new BlocksError(
          "BLOCK_MIGRATION_MISSING",
          `no migration path registered for "${typeId}"`,
        );
      }
      const last = list[list.length - 1];
      const target = toVersion ?? last?.toVersion ?? fromVersion;
      if (target < fromVersion) {
        throw new BlocksError(
          "BLOCK_MIGRATION_TARGET_INVALID",
          `target version ${String(target)} is below ${fromVersion}`,
        );
      }
      let currentVersion = fromVersion;
      let currentProps: Record<string, unknown> = { ...props };
      while (currentVersion < target) {
        const step = list.find((candidate) => candidate.fromVersion === currentVersion);
        if (step === undefined) {
          throw new BlocksError(
            "BLOCK_MIGRATION_MISSING",
            `no migration from ${typeId}@${currentVersion}`,
          );
        }
        currentProps = step.migrateProps(currentProps);
        currentVersion = step.toVersion;
      }
      return { toVersion: currentVersion, props: currentProps };
    },

    registerBlockType(descriptor: BlockTypeDescriptor): RegisteredBlockType {
      const { typeId, schemaVersion, propsSchema } = descriptor;
      if (!TYPE_ID_RE.test(typeId)) {
        throw new BlocksError(
          "BLOCK_TYPE_ID_INVALID",
          `block type id "${typeId}" must be lowercase snake_case (≤64 chars)`,
        );
      }
      if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
        throw new BlocksError(
          "BLOCK_TYPE_VERSION_INVALID",
          `block type "${typeId}": schemaVersion must be a positive integer`,
        );
      }
      const mapKey = `${typeId}@${schemaVersion}`;
      if (byTypeVersion.has(mapKey)) {
        throw new BlocksError("BLOCK_TYPE_EXISTS", `block type ${mapKey} is already registered`);
      }
      // Props schema must compile — an uncompilable JSON Schema can never
      // validate anything downstream (Content spec §31, ADR-0004 machinery).
      if (
        typeof propsSchema !== "object" ||
        propsSchema === null ||
        Array.isArray(propsSchema) ||
        propsSchema.type !== "object"
      ) {
        throw new BlocksError(
          "BLOCK_PROPS_SCHEMA_INVALID",
          `block type "${typeId}": propsSchema must be a JSON Schema object schema`,
        );
      }
      try {
        ajv.compile(propsSchema);
      } catch (error) {
        throw new BlocksError(
          "BLOCK_PROPS_SCHEMA_INVALID",
          `block type "${typeId}": propsSchema does not compile`,
          {
            cause: error,
          },
        );
      }
      const variants = descriptor.allowedVariants ?? [];
      if (new Set(variants).size !== variants.length) {
        throw new BlocksError(
          "BLOCK_TYPE_INVALID",
          `block type "${typeId}": duplicate allowed variants`,
        );
      }
      for (const variant of variants) {
        if (!VARIANT_RE.test(variant)) {
          throw new BlocksError(
            "BLOCK_TYPE_INVALID",
            `block type "${typeId}": invalid variant key "${variant}"`,
          );
        }
      }
      const registered: RegisteredBlockType = {
        typeId,
        schemaVersion,
        propsSchema,
        childrenPolicy: descriptor.childrenPolicy,
        allowedVariants: [...variants],
        richTextProps: descriptor.richTextProps ?? [],
        references: descriptor.references ?? [],
        ...(descriptor.rendererCapabilityKey === undefined
          ? {}
          : { rendererCapabilityKey: descriptor.rendererCapabilityKey }),
        ...(descriptor.validateProps === undefined
          ? {}
          : { validateProps: descriptor.validateProps }),
      };
      byTypeVersion.set(mapKey, registered);
      return registered;
    },

    getBlockType(typeId: string, schemaVersion: number): RegisteredBlockType | null {
      return byTypeVersion.get(`${typeId}@${schemaVersion}`) ?? null;
    },

    extendBlockVariants(typeId: string, variants) {
      for (const [mapKey, registered] of byTypeVersion) {
        if (registered.typeId !== typeId) continue;
        const merged = [...new Set([...registered.allowedVariants, ...variants])];
        for (const variant of merged) {
          if (!VARIANT_RE.test(variant)) {
            throw new BlocksError(
              "BLOCK_TYPE_INVALID",
              `block type "${typeId}": invalid variant key "${variant}"`,
            );
          }
        }
        byTypeVersion.set(mapKey, { ...registered, allowedVariants: merged });
      }
    },

    getLatestBlockType(typeId: string): RegisteredBlockType | null {
      const versions = [...byTypeVersion.keys()]
        .filter((mapKey) => mapKey.startsWith(`${typeId}@`))
        .map((mapKey) => Number(mapKey.slice(typeId.length + 1)))
        .sort((a, b) => b - a);
      const latest = versions[0];
      return latest === undefined ? null : (byTypeVersion.get(`${typeId}@${latest}`) ?? null);
    },

    listBlockTypes(): RegisteredBlockType[] {
      return [...byTypeVersion.values()].sort((a, b) =>
        a.typeId === b.typeId ? a.schemaVersion - b.schemaVersion : a.typeId < b.typeId ? -1 : 1,
      );
    },

    listBlockTypeVersions(): Array<{ typeId: string; versions: number[] }> {
      const grouped = new Map<string, number[]>();
      for (const registered of byTypeVersion.values()) {
        const versions = grouped.get(registered.typeId) ?? [];
        versions.push(registered.schemaVersion);
        grouped.set(registered.typeId, versions);
      }
      return [...grouped.entries()]
        .map(([key, versions]) => ({ typeId: key, versions: versions.sort((a, b) => a - b) }))
        .sort((a, b) => (a.typeId < b.typeId ? -1 : 1));
    },
  };
}

export type { StableId };
