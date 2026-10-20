// PCMS-CONT-T022 — schema/block version migration registry.
// Acceptance: v1→v2 fixture migration deterministic (Content spec §69/§70).
import assert from "node:assert/strict";
import { test } from "node:test";
import { type BlockSchemaMigration, createBlockRegistry } from "@pcms/blocks";
import { ContentError, createSchemaMigrationRegistry } from "@pcms/content";

// ---------------------------------------------------------------------------
// Content schema migrations (§69)
// ---------------------------------------------------------------------------

test("content schema migration v1→v2 transforms a fixture deterministically", () => {
  const registry = createSchemaMigrationRegistry();
  registry.registerSchemaMigration({
    contentTypeKey: "service",
    fromVersion: 1,
    toVersion: 2,
    migrate: (fields) => {
      const { price_old, ...rest } = fields as { price_old?: unknown };
      return { ...rest, price: price_old };
    },
  });
  const fixture = { title: "Аудит", price_old: "125000.00" };
  const first = registry.migrateFields("service", 1, fixture);
  assert.deepEqual(first, { toVersion: 2, fields: { title: "Аудит", price: "125000.00" } });
  // Deterministic: same input → same output.
  const second = registry.migrateFields("service", 1, fixture);
  assert.deepEqual(second, first);
});

test("chained v1→v2→v3 applies along the single registered path", () => {
  const registry = createSchemaMigrationRegistry();
  registry.registerSchemaMigration({
    contentTypeKey: "page",
    fromVersion: 1,
    toVersion: 2,
    migrate: (fields) => ({ ...fields, intro_text: fields.intro }),
  });
  registry.registerSchemaMigration({
    contentTypeKey: "page",
    fromVersion: 2,
    toVersion: 3,
    migrate: (fields) => {
      const { intro_text, ...rest } = fields as { intro_text?: unknown };
      return { ...rest, intro: intro_text };
    },
  });
  const result = registry.migrateFields("page", 1, { intro: "привет" }, 3);
  assert.equal(result.toVersion, 3);
  assert.deepEqual(result.fields, { intro: "привет" });
});

test("registration guards: single-step only, no duplicates; application is version-checked", () => {
  const registry = createSchemaMigrationRegistry();
  assert.throws(
    () =>
      registry.registerSchemaMigration({
        contentTypeKey: "x",
        fromVersion: 1,
        toVersion: 3,
        migrate: (fields) => fields,
      }),
    (error: unknown) => error instanceof ContentError && error.code === "SCHEMA_MIGRATION_INVALID",
  );
  registry.registerSchemaMigration({
    contentTypeKey: "x",
    fromVersion: 1,
    toVersion: 2,
    migrate: (fields) => fields,
  });
  assert.throws(
    () =>
      registry.registerSchemaMigration({
        contentTypeKey: "x",
        fromVersion: 1,
        toVersion: 2,
        migrate: (fields) => fields,
      }),
    (error: unknown) => error instanceof ContentError && error.code === "SCHEMA_MIGRATION_EXISTS",
  );
  // Applying from the same version to the same target is an idempotent no-op (§69).
  const noop = registry.migrateFields("x", 2, { keep: true }, 2);
  assert.deepEqual(noop, { toVersion: 2, fields: { keep: true } });
  // Explicit target below the payload version is guarded.
  assert.throws(
    () => registry.migrateFields("x", 2, {}, 1),
    (error: unknown) =>
      error instanceof ContentError && error.code === "SCHEMA_MIGRATION_TARGET_INVALID",
  );
  // Missing chain step.
  assert.throws(
    () => registry.migrateFields("x", 1, {}, 5),
    (error: unknown) => error instanceof ContentError && error.code === "SCHEMA_MIGRATION_MISSING",
  );
  // No path registered at all.
  assert.throws(
    () => registry.migrateFields("unknown", 1, {}),
    (error: unknown) => error instanceof ContentError && error.code === "SCHEMA_MIGRATION_MISSING",
  );
});

// ---------------------------------------------------------------------------
// Block props migrations (§70) — canonical path belongs to the Block Registry
// ---------------------------------------------------------------------------

const GALLERY_MIGRATION: BlockSchemaMigration = {
  typeId: "gallery",
  fromVersion: 1,
  toVersion: 2,
  migrateProps: (props) => {
    const { images, ...rest } = props as { images?: unknown };
    return {
      ...rest,
      items: (images as string[] | undefined)?.map((mediaId) => ({ media_id: mediaId })),
    };
  },
};

test("block migration gallery@1→@2 migrates props via the registry", () => {
  const registry = createBlockRegistry();
  registry.registerBlockMigration(GALLERY_MIGRATION);
  const result = registry.migrateBlockProps("gallery", 1, { images: ["a", "b"] });
  assert.equal(result.toVersion, 2);
  assert.deepEqual(result.props, { items: [{ media_id: "a" }, { media_id: "b" }] });
  // Deterministic.
  assert.deepEqual(registry.migrateBlockProps("gallery", 1, { images: ["a", "b"] }), result);
});

test("block migration guards: duplicates, missing paths, wrong steps", () => {
  const registry = createBlockRegistry();
  registry.registerBlockMigration(GALLERY_MIGRATION);
  assert.throws(
    () => registry.registerBlockMigration(GALLERY_MIGRATION),
    (error: unknown) => (error as { code?: string }).code === "BLOCK_MIGRATION_EXISTS",
  );
  assert.throws(
    () => registry.migrateBlockProps("text", 1, {}),
    (error: unknown) => (error as { code?: string }).code === "BLOCK_MIGRATION_MISSING",
  );
  // Same-version application is an idempotent no-op; explicit lower target guarded.
  const noop = registry.migrateBlockProps("gallery", 2, { items: [] });
  assert.deepEqual(noop, { toVersion: 2, props: { items: [] } });
  assert.throws(
    () => registry.migrateBlockProps("gallery", 2, {}, 1),
    (error: unknown) => (error as { code?: string }).code === "BLOCK_MIGRATION_TARGET_INVALID",
  );
  assert.throws(
    () =>
      registry.registerBlockMigration({
        typeId: "gallery",
        fromVersion: 2,
        toVersion: 4,
        migrateProps: (props) => props,
      }),
    (error: unknown) => (error as { code?: string }).code === "BLOCK_MIGRATION_INVALID",
  );
});
