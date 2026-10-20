// Content schema validate/apply (2026-09-29 "schemas via API"): the
// content_schema.propose/apply permissions existed with no surface. Pins:
// additive-only policy (new types + new optional fields), violations block
// apply, applies persist overrides that the boot overlay merges over the
// typesFile, and both definition file shapes are accepted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyContentSchemaOp, validateContentSchemaOp } from "@pcms/api";
import {
  createContentTypeRegistry,
  diffContentTypeDefinitions,
  effectiveContentTypeDefinitions,
  parseDefinitionsInput,
} from "@pcms/content";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

const BASE_TYPE = {
  key: "landing",
  version: 1,
  title: "Landing",
  bodyPolicy: "none" as const,
  fields: {
    title: { id: "title", type: "string", required: true },
  },
};

function fixtureActor(
  t: Awaited<ReturnType<typeof createApiFixture>>,
  permissions?: readonly string[],
) {
  const actor = permissions === undefined ? ownerActor() : scopedActor(permissions);
  return apiContextOf(actor);
}

test("parseDefinitionsInput: bare array and contentTypes wrapper both accepted", () => {
  const bare = [{ key: "a", version: 1, title: "A", fields: {} }];
  assert.deepEqual(parseDefinitionsInput(bare), bare);
  assert.deepEqual(parseDefinitionsInput({ contentTypes: bare }), bare);
  assert.throws(() => parseDefinitionsInput({ nope: true }), /contentTypes/);
});

test("diff: additive changes pass, non-additive violations are named", () => {
  // diff works on normalized (LoadedContentType) values; probe-register to
  // get them — the same path the ops use.
  const registryProbe = (definitions: unknown[]) => {
    const scratch = createContentTypeRegistry();
    return definitions.map((definition) => scratch.registerContentType(definition as never));
  };
  const current = registryProbe([BASE_TYPE]);
  const additive = registryProbe([
    {
      ...BASE_TYPE,
      fields: {
        ...BASE_TYPE.fields,
        feature_icon: { id: "feature_icon", type: "icon" },
      },
    },
    { key: "faq", version: 1, title: "FAQ", fields: { title: { id: "title", type: "string" } } },
  ]);
  const diff = diffContentTypeDefinitions(current, additive);
  assert.deepEqual(diff.added_types, ["faq@1"]);
  assert.deepEqual(diff.added_fields["landing@1"], ["feature_icon"]);
  assert.deepEqual(diff.violations, []);

  const regressive = registryProbe([
    {
      ...BASE_TYPE,
      fields: { title: { id: "title", type: "text", required: true } },
    },
  ]);
  const bad = diffContentTypeDefinitions(current, regressive);
  assert.equal(bad.violations.length, 1);
  assert.match(bad.violations[0]?.message ?? "", /"title" type changed/);

  const requiredNew = registryProbe([
    {
      ...BASE_TYPE,
      fields: {
        ...BASE_TYPE.fields,
        must_have: { id: "must_have", type: "string", required: true },
      },
    },
  ]);
  const bad2 = diffContentTypeDefinitions(current, requiredNew);
  assert.equal(bad2.violations.length, 1);
  assert.match(bad2.violations[0]?.message ?? "", /must be optional/);
});

test("validate + apply: additive set persists overrides and boot overlay merges them", {
  skip: DB_SKIP,
}, async (t) => {
  const fixture = await createApiFixture(t, {
    contentTypeDefinitions: [BASE_TYPE],
  });
  const ctx = fixtureActor(fixture);
  const proposed = {
    definitions: [
      {
        ...BASE_TYPE,
        fields: { ...BASE_TYPE.fields, body_image: { id: "body_image", type: "media" } },
      },
      {
        key: "service_v2",
        version: 1,
        title: "Service v2",
        fields: { title: { id: "title", type: "string" } },
      },
    ],
  };

  const report = await validateContentSchemaOp(fixture.app, ctx, proposed);
  assert.equal(report.ok, true);
  assert.equal(report.restart_required, true);

  const applied = await applyContentSchemaOp(fixture.app, ctx, proposed);
  assert.equal(applied.ok, true);
  assert.equal(applied.restart_required, true);

  // Overrides persisted…
  const rows = await fixture.pool.query(
    "SELECT count(*)::int AS n FROM pcms_content_type_overrides",
  );
  assert.equal(rows.rows[0]?.n, 2);

  // …and the boot overlay resolves the effective set over the file.
  const effective = await effectiveContentTypeDefinitions(fixture.pool, [BASE_TYPE]);
  const keys = effective.map((definition) => `${definition.key}@${definition.version}`).sort();
  assert.deepEqual(keys, ["landing@1", "service_v2@1"]);
  const landing = effective.find((definition) => definition.key === "landing");
  assert.ok("body_image" in (landing?.fields ?? {}));
});

test("apply rejects non-additive sets with named violations and persists nothing", {
  skip: DB_SKIP,
}, async (t) => {
  const fixture = await createApiFixture(t, {
    contentTypeDefinitions: [BASE_TYPE],
  });
  const ctx = fixtureActor(fixture);
  await assert.rejects(
    () =>
      applyContentSchemaOp(fixture.app, ctx, {
        definitions: [
          {
            ...BASE_TYPE,
            fields: { title: { id: "title", type: "string" } }, // required flag dropped
          },
        ],
      }),
    /additive|violations|validate/i,
  );
  const rows = await fixture.pool.query(
    "SELECT count(*)::int AS n FROM pcms_content_type_overrides",
  );
  assert.equal(rows.rows[0]?.n, 0);
});

test("permissions: propose/apply are denied without the scope", { skip: DB_SKIP }, async (t) => {
  const fixture = await createApiFixture(t, { contentTypeDefinitions: [BASE_TYPE] });
  const ctx = fixtureActor(fixture, ["content.read"]);
  await assert.rejects(() => validateContentSchemaOp(fixture.app, ctx, { definitions: [] }));
  await assert.rejects(() => applyContentSchemaOp(fixture.app, ctx, { definitions: [] }));
});
