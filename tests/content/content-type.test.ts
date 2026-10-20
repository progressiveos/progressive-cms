// PCMS-CONT-T011 — ContentType registry + versioned schema loader.
// Acceptance: schema discovery returns a deterministic model
// (Content spec §8/§9/§10/§73).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContentError,
  type ContentTypeDefinition,
  createContentTypeRegistry,
  SEMANTIC_FIELD_IDS_V1,
} from "@pcms/content";

const PAGE_V1: ContentTypeDefinition = {
  key: "page",
  version: 1,
  title: "Страница",
  description: "Обычная структурная страница",
  fields: {
    title: { id: "title", type: "string", required: true },
    menu_title: { id: "menu_title", type: "string" },
    slug_hint: { id: "slug_hint", type: "slug" },
    intro: { id: "intro", type: "text" },
    body: { id: "body", type: "rich_text" },
  },
  bodyPolicy: "block_document",
  defaultTemplateHint: "page",
};

const SERVICE_V1: ContentTypeDefinition = {
  key: "service",
  version: 1,
  title: "Услуга",
  fields: {
    title: { id: "title", type: "string", required: true },
    price: {
      id: "price",
      type: "money",
    },
  },
  bodyPolicy: "rich_text",
};

const SERVICE_V2: ContentTypeDefinition = {
  key: "service",
  version: 2,
  title: "Услуга",
  fields: {
    title: { id: "title", type: "string", required: true },
    price: { id: "price", type: "money" },
    duration: { id: "duration", type: "integer", min: 0 },
  },
};

test("register + load specific versions; latest resolver returns highest", () => {
  const registry = createContentTypeRegistry();
  registry.registerContentType(PAGE_V1);
  registry.registerContentType(SERVICE_V1);
  registry.registerContentType(SERVICE_V2);

  assert.equal(registry.getContentType("service", 1)?.fieldSchema.fields.price?.type, "money");
  assert.equal(registry.getContentType("service", 1)?.fieldSchema.fields.duration, undefined);
  assert.equal(registry.getContentType("service", 2)?.fieldSchema.fields.duration?.type, "integer");
  assert.equal(registry.getLatestContentType("service")?.version, 2);
  assert.equal(registry.getContentType("service", 3), null);
  assert.equal(registry.getLatestContentType("missing"), null);
});

test("discovery is deterministic: sorted by key then version, stable across calls", () => {
  const registry = createContentTypeRegistry();
  registry.registerContentType(SERVICE_V2);
  registry.registerContentType(PAGE_V1);
  registry.registerContentType(SERVICE_V1);

  const first = registry.listContentTypes().map((entry) => `${entry.key}@${entry.version}`);
  const second = registry.listContentTypes().map((entry) => `${entry.key}@${entry.version}`);
  assert.deepEqual(first, ["page@1", "service@1", "service@2"]);
  assert.deepEqual(first, second);

  assert.deepEqual(registry.listContentTypeVersions(), [
    { key: "page", versions: [1] },
    { key: "service", versions: [1, 2] },
  ]);
});

test("registration is validated: bad keys, versions, titles, body policies", () => {
  const registry = createContentTypeRegistry();
  const expectCode = (run: () => unknown, code: string): void => {
    assert.throws(
      run,
      (error: unknown) => error instanceof ContentError && error.code === code,
      `expected ${code}`,
    );
  };
  expectCode(
    () => registry.registerContentType({ ...PAGE_V1, key: "Bad-Key" }),
    "CONTENT_TYPE_KEY_INVALID",
  );
  expectCode(
    () => registry.registerContentType({ ...PAGE_V1, version: 0 }),
    "CONTENT_TYPE_VERSION_INVALID",
  );
  expectCode(
    () => registry.registerContentType({ ...PAGE_V1, title: "" }),
    "CONTENT_TYPE_TITLE_REQUIRED",
  );
  expectCode(
    () => registry.registerContentType({ ...PAGE_V1, bodyPolicy: "html" as "rich_text" }),
    "CONTENT_TYPE_BODY_POLICY_INVALID",
  );
  // Duplicate (key, version) is rejected; a new version is the evolution path.
  registry.registerContentType(PAGE_V1);
  expectCode(() => registry.registerContentType(PAGE_V1), "CONTENT_TYPE_EXISTS");
});

test("field schemas are validated at registration through the schema machinery", () => {
  const registry = createContentTypeRegistry();
  assert.throws(
    () =>
      registry.registerContentType({
        ...PAGE_V1,
        fields: { "Bad Id": { id: "Bad Id", type: "string" } },
      }),
    (error: unknown) => error instanceof ContentError && error.code === "FIELD_ID_INVALID",
  );
  assert.throws(
    () =>
      registry.registerContentType({
        ...PAGE_V1,
        fields: { ghost: { id: "ghost", type: "alien_type" as "string" } },
      }),
    (error: unknown) => error instanceof ContentError && error.code === "FIELD_TYPE_UNREGISTERED",
  );
});

test("registries are independent; semantic field vocabulary is stable", () => {
  const a = createContentTypeRegistry();
  const b = createContentTypeRegistry();
  a.registerContentType(PAGE_V1);
  assert.equal(b.getLatestContentType("page"), null);
  assert.deepEqual(
    [...SEMANTIC_FIELD_IDS_V1],
    ["title", "menu_title", "h1", "slug_hint", "intro", "hero_image", "body"],
  );
});
