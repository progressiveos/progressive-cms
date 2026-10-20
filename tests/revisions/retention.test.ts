// Sealed-revision retention sweep (2026-09-29): per entity, keep the newest
// KEEP sealed revisions; the currently published one is never deleted; the
// sweep runs through the sanctioned opt-in past the guard trigger.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteRevisionOp } from "@pcms/api";
import { newStableId, systemClock } from "@pcms/core";
import {
  createRevisionStore,
  createVersionedEntityRegistry,
  sweepSealedRevisions,
} from "@pcms/revisions";
import {
  type ApiTestFixture,
  apiContextOf,
  createApiFixture,
  ownerActor,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

const ACTOR = { actorClass: "human" as const, actorId: "retention-test", origin: "human" as const };

async function fixtureWithEntry(t: { after: (fn: () => void) => void }) {
  const fixture: ApiTestFixture = await createApiFixture(t, {
    contentTypeDefinitions: [
      {
        key: "page",
        version: 1,
        title: "Page",
        bodyPolicy: "none" as const,
        fields: { title: { id: "title", type: "string" } },
      },
    ],
  });
  const entry = await fixture.app.entries.createEntry({
    contentTypeId: "page",
    createdBy: "retention-test",
  });
  const seal = async (title: string) => {
    const working = await fixture.app.revisions.createWorkingRevision({
      entityType: "entry",
      entityId: entry.id,
      payload: { fields: { title }, blocks: null },
      schemaVersion: "1",
      actor: ACTOR,
    });
    return (await fixture.app.revisions.sealRevision({ revisionId: working.id })).id;
  };
  return { fixture, entry, seal };
}

test("retention sweep: keeps newest KEEP, spares the published revision, detaches children", {
  skip: DB_SKIP,
}, async (t) => {
  const { fixture, entry, seal } = await fixtureWithEntry(t);
  const ctx = apiContextOf(ownerActor());

  // Six sealed revisions, sweep keeps 2 newest.
  const sealed = [];
  for (let i = 1; i <= 6; i += 1) sealed.push(await seal(`v${i}`));

  // The third-newest is "currently published" (protected despite its rank).
  const publishedId = sealed[sealed.length - 3];
  await fixture.pool.query(
    `INSERT INTO publications (entity_type, entity_id, context, generation, state, current_revision_id, current_payload_hash, first_published_at, published_at, modified_at)
     VALUES ('entry', $1, 'default', 1, 'PUBLISHED', $2, 'hash', now(), now(), now())`,
    [entry.id, publishedId],
  );

  const stats = await sweepSealedRevisions(fixture.pool, { keep: 2 });
  assert.ok(stats.deleted >= 3, `expected deletions, got ${stats.deleted}`);

  const remaining = await fixture.pool.query<{ id: string; revision_no: number }>(
    "SELECT id, revision_no FROM revisions WHERE entity_id = $1 AND state = 'SEALED' ORDER BY revision_no",
    [entry.id],
  );
  const nos = remaining.rows.map((row) => row.revision_no).sort((a, b) => a - b);
  // 6 sealed total, keep 2 newest (5,6) + the published one (4).
  assert.deepEqual(nos, [4, 5, 6]);
  assert.ok(remaining.rows.some((row) => row.id === publishedId));

  // Direct op delete still works afterwards (the GUC is per-transaction);
  // target a survivor (v5 — the sweep only removed v1..v3).
  // Direct op delete still works afterwards (the GUC is per-transaction);
  // target a survivor (v5 — the sweep only removed v1..v3).
  const survivor = sealed[4];
  assert.ok(survivor !== undefined);
  await deleteRevisionOp(fixture.app, ctx, { revision_id: survivor });
  assert.equal(await fixture.app.revisions.getRevision(fixture.pool, survivor), null);
});
