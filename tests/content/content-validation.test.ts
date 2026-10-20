// PCMS-CONT-T012 — draft vs publish-level content validation core.
// Acceptance: stable error codes + JSON pointer paths (Content spec §61/§65/§66).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ContentTypeDefinition,
  createContentTypeRegistry,
  type LoadedContentType,
  newEntryId,
  newStableId,
  validateContentPayload,
  validateContentPayloadAsync,
} from "@pcms/content";

const SERVICE: ContentTypeDefinition = {
  key: "service",
  version: 1,
  title: "Услуга",
  fields: {
    title: { id: "title", type: "string", required: true },
    intro: { id: "intro", type: "text" },
    price: { id: "price", type: "money" },
    hero: { id: "hero", type: "media" },
    related: { id: "related", type: "relation", accepts: ["service", "case"] },
  },
};

function loaded(definition: ContentTypeDefinition): LoadedContentType {
  const registry = createContentTypeRegistry();
  return registry.registerContentType(definition);
}

test("draft validation tolerates incomplete payloads but rejects type errors", () => {
  const contentType = loaded(SERVICE);
  // Incomplete draft: required title missing — valid at draft level (§65).
  const draft = validateContentPayload(contentType, {}, "draft");
  assert.equal(draft.level, "draft");
  assert.equal(draft.ok, true, JSON.stringify(draft.errors));

  // Schema/type safety still applies at draft level.
  const broken = validateContentPayload(contentType, { title: 42 }, "draft");
  assert.equal(broken.ok, false);
  assert.deepEqual(
    broken.errors.map((issue) => [issue.path, issue.code]),
    [["/fields/title", "TYPE_MISMATCH"]],
  );
});

test("publish validation enforces required fields with pointed JSON-pointer paths", async () => {
  const contentType = loaded(SERVICE);
  const publish = await validateContentPayloadAsync(
    contentType,
    { intro: "почти готово" },
    "publish",
  );
  assert.equal(publish.level, "publish");
  assert.equal(publish.ok, false);
  assert.deepEqual(
    publish.errors.map((issue) => [issue.path, issue.code, issue.severity, issue.source]),
    [["/fields/title", "FIELD_REQUIRED", "error", "content-schema"]],
  );

  // The same payload at draft level passes.
  assert.equal(validateContentPayload(contentType, { intro: "почти готово" }, "draft").ok, true);
});

test("publish rejects dangling required references; draft tolerates unresolved optionals", async () => {
  const contentType = loaded(SERVICE);
  const missingTarget = newEntryId();
  const payload = { title: "Аудит", related: missingTarget };

  // Draft: unresolved optional reference allowed (§61).
  assert.equal(validateContentPayload(contentType, payload, "draft").ok, true);

  // Publish without an entries lookup: only structural checks run.
  assert.equal((await validateContentPayloadAsync(contentType, payload, "publish")).ok, true);

  // Publish with the entries lookup: dangling reference → stable code.
  const result = await validateContentPayloadAsync(contentType, payload, "publish", {
    entries: { findEntry: async () => null },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((issue) => [issue.path, issue.code]),
    [["/fields/related", "RELATION_TARGET_NOT_FOUND"]],
  );
});

test("publish checks accepted content types of relation targets", async () => {
  const contentType = loaded(SERVICE);
  const newsEntry = { id: newEntryId(), contentTypeId: "news" };
  const result = await validateContentPayloadAsync(
    contentType,
    { title: "x", related: newsEntry.id },
    "publish",
    { entries: { findEntry: async () => newsEntry } },
  );
  assert.deepEqual(
    result.errors.map((issue) => [issue.code, issue.path]),
    [["RELATION_TYPE_REJECTED", "/fields/related"]],
  );

  // Accepted type passes.
  const okResult = await validateContentPayloadAsync(
    contentType,
    { title: "x", related: newsEntry.id },
    "publish",
    { entries: { findEntry: async () => ({ ...newsEntry, contentTypeId: "case" }) } },
  );
  assert.equal(okResult.ok, true);
});

test("media availability resolves through the injected checker (M05 wiring point)", async () => {
  const contentType = loaded(SERVICE);
  const asset = newStableId();
  const missing = newStableId();
  const result = await validateContentPayloadAsync(
    contentType,
    { title: "x", hero: missing },
    "publish",
    {
      checkMediaAsset: async (id) => id === asset,
    },
  );
  assert.deepEqual(
    result.errors.map((issue) => [issue.path, issue.code]),
    [["/fields/hero", "MEDIA_NOT_FOUND"]],
  );
  assert.equal(
    (
      await validateContentPayloadAsync(contentType, { title: "x", hero: asset }, "publish", {
        checkMediaAsset: async () => true,
      })
    ).ok,
    true,
  );
});

test("relation_list items are checked per index with pointed paths", async () => {
  const withList: ContentTypeDefinition = {
    ...SERVICE,
    fields: {
      ...SERVICE.fields,
      related: { id: "related", type: "relation_list", accepts: ["service"] },
    },
  };
  const contentType = loaded(withList);
  const known = newEntryId();
  const missing = newEntryId();
  const result = await validateContentPayloadAsync(
    contentType,
    { title: "x", related: [known, missing] },
    "publish",
    {
      entries: {
        findEntry: async (id) => (id === known ? { id, contentTypeId: "service" } : null),
      },
    },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((issue) => issue.path),
    ["/fields/related/1"],
  );
});

test("warnings are kept separate from errors in the result shape", async () => {
  const contentType = loaded(SERVICE);
  const result = await validateContentPayloadAsync(contentType, { title: "x" }, "publish");
  assert.deepEqual(result.warnings, []);
  // The machine-readable contract always carries code + path + severity.
  for (const issue of result.errors) {
    assert.equal(typeof issue.code, "string");
    assert.ok(issue.path.startsWith("/fields"));
    assert.equal(issue.severity, "error");
  }
});
