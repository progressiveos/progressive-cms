// Revision deletion (2026-09-29 owner request): WORKING and SEALED revisions
// are deletable from the Admin and via API/CLI/MCP; the currently published
// revision is undeletable (REVISION_PUBLISHED); children detach safely.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteRevisionOp } from "@pcms/api";
import {
  type ApiTestFixture,
  apiContextOf,
  createApiFixture,
  ownerActor,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

const REFERENCE_CONTENT_TYPES = [
  {
    key: "page",
    version: 1,
    title: "Page",
    bodyPolicy: "block_document" as const,
    fields: {
      title: { id: "title", type: "string", required: true },
    },
  },
];

const ACTOR = {
  actorClass: "human" as const,
  actorId: "rev-delete-test",
  origin: "human" as const,
};

async function fixtureWithEntry(t: { after: (fn: () => void) => void }) {
  const fixture: ApiTestFixture = await createApiFixture(t, {
    contentTypeDefinitions: [...REFERENCE_CONTENT_TYPES],
  });
  const entry = await fixture.app.entries.createEntry({
    contentTypeId: "page",
    createdBy: "rev-delete-test",
  });
  const sealOne = async (title: string) => {
    const working = await fixture.app.revisions.createWorkingRevision({
      entityType: "entry",
      entityId: entry.id,
      payload: { fields: { title }, blocks: { schema_version: 1, blocks: [] } },
      schemaVersion: "1",
      actor: ACTOR,
    });
    return (await fixture.app.revisions.sealRevision({ revisionId: working.id })).id;
  };
  return { fixture, entry, sealOne };
}

test("revision delete: WORKING and SEALED deletable, branched-from children detach", {
  skip: DB_SKIP,
}, async (t) => {
  const { fixture, entry, sealOne } = await fixtureWithEntry(t);
  const ctx = apiContextOf(ownerActor());

  const working = await fixture.app.revisions.createWorkingRevision({
    entityType: "entry",
    entityId: entry.id,
    payload: { fields: { title: "draft" }, blocks: null },
    schemaVersion: "1",
    actor: ACTOR,
  });
  const deleted = await deleteRevisionOp(fixture.app, ctx, { revision_id: working.id });
  assert.equal(deleted.deleted, true);
  assert.equal(await fixture.app.revisions.getRevision(fixture.pool, working.id), null);

  const sealed = await sealOne("sealed garbage");
  // A draft branched from it (parent FK must not block the cleanup).
  await fixture.app.revisions.createWorkingRevision({
    entityType: "entry",
    entityId: entry.id,
    payload: { fields: { title: "sealed garbage" }, blocks: null },
    schemaVersion: "1",
    actor: ACTOR,
    parentRevisionId: sealed,
  });
  await deleteRevisionOp(fixture.app, ctx, { revision_id: sealed });
  assert.equal(await fixture.app.revisions.getRevision(fixture.pool, sealed), null);
  const child = await fixture.pool.query<{ parent_revision_id: string | null }>(
    "SELECT parent_revision_id FROM revisions WHERE entity_id = $1 AND state = 'WORKING'",
    [entry.id],
  );
  assert.equal(child.rows[0]?.parent_revision_id, null);
});

test("revision delete: the currently published revision is undeletable", {
  skip: DB_SKIP,
}, async (t) => {
  const { fixture, sealOne } = await fixtureWithEntry(t);
  const ctx = apiContextOf(ownerActor());
  const sealed = await sealOne("live page");

  // Simulate the live publication pointer (the op reads the same table the
  // publication service maintains).
  await fixture.pool.query(
    `INSERT INTO publications (entity_type, entity_id, context, generation, state, current_revision_id, current_payload_hash, first_published_at, published_at, modified_at)
     VALUES ('entry', $1, 'default', 1, 'PUBLISHED', $2, 'hash', now(), now(), now())`,
    [(await entryIdOf(fixture, sealed)).id, sealed],
  );
  await assert.rejects(
    () => deleteRevisionOp(fixture.app, ctx, { revision_id: sealed }),
    (error: unknown) => (error as { code?: string }).code === "REVISION_PUBLISHED",
  );
});

async function entryIdOf(fixture: ApiTestFixture, revisionId: string) {
  const row = await fixture.pool.query<{ entity_id: string }>(
    "SELECT entity_id FROM revisions WHERE id = $1",
    [revisionId],
  );
  return { id: row.rows[0]?.entity_id ?? "" };
}
