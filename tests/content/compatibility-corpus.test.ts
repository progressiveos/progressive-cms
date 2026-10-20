// PCMS-CONT-T026 — Content Model compatibility test corpus.
// Acceptance: old schema/blocks fixture suite gates minor changes
// (Content spec §75/§88).
//
// These fixtures freeze historical serialized shapes. A minor release must
// keep this suite green: old payload versions stay readable, canonical block
// payloads stay valid, migrations stay deterministic and unknown extensions
// survive — the corpus is the executable compatibility contract.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  createBlockRegistry,
  registerFirstPartyBlocksV1,
  validateBlockDocument,
} from "@pcms/blocks";
import {
  type ContentTypeDefinition,
  createContentTypeRegistry,
  createSchemaMigrationRegistry,
  mergeExtensions,
  validateContentPayload,
  validateRichText,
} from "@pcms/content";

interface CorpusFile {
  legacySchemas: ContentTypeDefinition[];
  legacyPayloads: Array<{
    name: string;
    schema: string;
    fields: Record<string, unknown>;
  }>;
  legacyBlockDocuments: Array<{ name: string; document: unknown }>;
  migrations: Array<{
    contentTypeKey: string;
    fromVersion: number;
    toVersion: number;
    expected: Record<string, unknown>;
  }>;
}

const corpus = JSON.parse(
  readFileSync(join("fixtures", "content", "compatibility-corpus.json"), "utf8"),
) as CorpusFile;

test("legacy schema versions stay readable by the current validator (§88)", () => {
  const registry = createContentTypeRegistry();
  for (const definition of corpus.legacySchemas) registry.registerContentType(definition);
  for (const payload of corpus.legacyPayloads) {
    const [key, versionPart] = payload.schema.split("@");
    if (key === undefined || versionPart === undefined) {
      throw new Error(`malformed schema reference "${payload.schema}"`);
    }
    const schema = registry.getContentType(key, Number(versionPart));
    assert.ok(schema !== null, `legacy schema ${payload.schema} must be registered`);
    const result = validateContentPayload(schema, payload.fields, "publish");
    assert.equal(
      result.ok,
      true,
      `legacy payload ${payload.name} must stay valid: ${JSON.stringify(result.errors)}`,
    );
  }
});

test("legacy BlockDocuments stay valid against the current registry (§88)", () => {
  const registry = createBlockRegistry();
  registerFirstPartyBlocksV1(registry);
  for (const entry of corpus.legacyBlockDocuments) {
    const result = validateBlockDocument(entry.document, registry);
    assert.equal(
      result.ok,
      true,
      `legacy document ${entry.name} must stay valid: ${JSON.stringify(result.ok ? [] : result.issues)}`,
    );
  }
});

test("declared migrations migrate legacy payloads deterministically to expected shapes (§69)", () => {
  const registry = createContentTypeRegistry();
  for (const definition of corpus.legacySchemas) registry.registerContentType(definition);
  const migrations = createSchemaMigrationRegistry();
  for (const migration of corpus.migrations) {
    migrations.registerSchemaMigration({
      contentTypeKey: migration.contentTypeKey,
      fromVersion: migration.fromVersion,
      toVersion: migration.toVersion,
      migrate: (fields) => {
        // price_old "125000.00" → money value; extensions ride along.
        const { price_old: oldPrice, ...rest } = fields as { price_old?: string };
        return { ...rest, price: { amount: oldPrice, currency: "RUB" } };
      },
    });
  }
  for (const migration of corpus.migrations) {
    const payload = corpus.legacyPayloads.find(
      (candidate) => candidate.schema === `${migration.contentTypeKey}@${migration.fromVersion}`,
    );
    assert.ok(payload !== undefined, "migration fixture must reference a stored payload");
    const result = migrations.migrateFields(
      migration.contentTypeKey,
      migration.fromVersion,
      payload.fields,
    );
    assert.equal(result.toVersion, migration.toVersion);
    assert.deepEqual(result.fields, migration.expected);
    // Deterministic on repeat.
    const again = migrations.migrateFields(
      migration.contentTypeKey,
      migration.fromVersion,
      payload.fields,
    );
    assert.deepEqual(again.fields, migration.expected);
  }
});

test("unknown extensions survive the edit cycle in the corpus (§68/§88)", () => {
  const payload = corpus.legacyPayloads[0];
  assert.ok(payload !== undefined);
  const edited = mergeExtensions(payload.fields, { title: "Аудит (обновлено)" });
  const extensions = extractOf(edited);
  assert.deepEqual(extensions["vendor.crm"], { crm_id: "CRM-42" });

  function extractOf(value: unknown): Record<string, unknown> {
    return (value as { extensions?: Record<string, unknown> }).extensions ?? {};
  }
});

test("the plain-text subset of the retired v1 shape is still expressible in v2 (§15/§88)", () => {
  // v1's node vocabulary (paragraphs, headings, marks, links, URL images) is a
  // subset of v2, so a converted document validates unchanged. The one thing
  // that is NOT accepted is the absence of the version itself.
  const legacyShaped = {
    schema_version: 2,
    type: "document",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Старый текст" }] },
      {
        type: "heading",
        level: 2,
        content: [{ type: "text", text: "Заголовок", marks: ["strong"] }],
      },
    ],
  };
  assert.deepEqual(validateRichText(legacyShaped).ok, true);

  // The same content without the version is refused: v1 is not readable.
  const { schema_version: _drop, ...unversioned } = legacyShaped;
  const result = validateRichText(unversioned);
  assert.equal(result.ok, false);
  assert.ok(
    !result.ok && result.issues.some((issue) => issue.code === "RICHTEXT_VERSION_REQUIRED"),
    JSON.stringify(result),
  );
});
