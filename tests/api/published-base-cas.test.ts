import assert from "node:assert/strict";
import { test } from "node:test";
import { createDraft, createWorkingDraft } from "@pcms/api";
import { apiContextOf, ownerActor } from "../helpers/api-composition.js";
import { rollbackApiFixture } from "../helpers/rollback-api-fixture.js";

test("branched draft retains its base and stale publication generation is rejected", {
  skip: !process.env.PCMS_TEST_DATABASE_URL,
}, async (t) => {
  const { app } = await rollbackApiFixture(t, {
    contentTypeDefinitions: [
      {
        key: "page",
        version: 1,
        title: "Page",
        bodyPolicy: "rich_text",
        fields: { title: { id: "title", type: "string", required: true } },
      },
    ],
  });
  const ctx = apiContextOf(ownerActor("cas-test"));
  const original = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Original" } },
  });
  await app.revisions.sealRevision({ revisionId: original.revision_id as never });
  const publish = (revision: string, generation: number) =>
    app.publications.publish({
      entityType: "entry",
      entityId: original.entry_id as never,
      targetRevisionId: revision as never,
      expectedGeneration: generation,
      actor: { actorClass: "operator", actorId: "cas-test" },
    });
  await publish(original.revision_id, 0);
  const next = await createWorkingDraft(app, ctx, {
    entry_id: original.entry_id,
    from_revision_id: original.revision_id,
  });
  assert.equal(next.base_revision_id, original.revision_id);
  await app.revisions.sealRevision({ revisionId: next.revision_id as never });
  await publish(next.revision_id, 1);
  const stale = await createWorkingDraft(app, ctx, {
    entry_id: original.entry_id,
    from_revision_id: original.revision_id,
  });
  assert.equal(stale.base_revision_id, original.revision_id);
  await app.revisions.sealRevision({ revisionId: stale.revision_id as never });
  await assert.rejects(publish(stale.revision_id, 1));
  const current = await app.publications.getPublication(
    app.pool,
    "entry",
    original.entry_id as never,
  );
  assert.equal(current?.currentRevisionId, next.revision_id);
  assert.equal(current?.generation, 2);
});
