// Owner incident 2026-10-01 (0.1.134): the Admin "Посмотреть" preview of a
// WORKING revision used to seal it and fork a fresh draft — mutating the
// revision set and misattributing changed_by to whoever merely looked. The
// fix renders the WORKING revision through an allow_draft preview token.
// Regression: minting (and re-minting) such a token must not mutate the
// revision in any observable way: state, edit generation, revision count,
// changed_by/at stay exactly as the real editor left them; the open editor
// keeps editing the same WORKING revision. A preview-only actor (no
// revision.seal, no content.create) must be able to look — the existing
// allow_draft contract (preview.create + content.edit) is enough.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperationContext } from "@pcms/api";
import {
  createApiFastify,
  createApiV1,
  createDraft,
  makeDiscoveryRoutes,
  makeMutationRoutes,
  sealRevision,
  updateDraft,
} from "@pcms/api";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const OWNER_CTX = (): OperationContext => apiContextOf(ownerActor(), "rest", "req_owner");

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
  withContext: () => silentLogger,
};

const PAGE_PAYLOAD = () => ({
  fields: { title: "Incident page" },
  blocks: { schema_version: 1, blocks: [] },
});

interface RevisionRow {
  readonly [key: string]: unknown;
  readonly id: string;
  readonly state: string;
  readonly created_by: string;
}

test("allow_draft preview token minting never mutates the WORKING revision", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  // The reference "page" type, same as the mutations suite baseline.
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [
      {
        key: "page",
        version: 1,
        title: "Page",
        bodyPolicy: "block_document",
        fields: {
          title: { id: "title", type: "string", required: true, sortable: true },
        },
      },
    ],
  });
  const fastify = createApiFastify(() => "req_preview");
  await fastify.register(createApiV1([...makeDiscoveryRoutes(), ...makeMutationRoutes()]), {
    application: app,
    logger: silentLogger,
    cookieSecure: false,
  });
  const ownerCtx = OWNER_CTX();

  const draft = await createDraft(app, ownerCtx, {
    content_type: "page",
    payload: PAGE_PAYLOAD(),
  });

  // A real editorial trail: a second edit by a DIFFERENT actor, so
  // changed_by is meaningful and must survive a mere preview.
  await updateDraft(
    app,
    apiContextOf(scopedActor(["content.edit"], "svc-editor"), "rest", "req_edit"),
    {
      revision_id: draft.revision_id,
      payload: { fields: { title: "Incident page v2" }, blocks: { schema_version: 1, blocks: [] } },
      expected_edit_generation: 0,
    },
  );

  const snapshot = async (): Promise<{ count: number; rows: readonly RevisionRow[] }> => {
    const result = await app.pool.query<RevisionRow>(
      "SELECT id, state, created_by, created_at FROM revisions WHERE entity_type = 'entry' AND entity_id = $1 ORDER BY revision_no",
      [draft.entry_id],
    );
    return { count: result.rows.length, rows: result.rows };
  };
  const before = await snapshot();
  assert.equal(before.count, 1, "edits mutate the WORKING revision in place — no fork");
  assert.equal(before.rows[0]?.state, "WORKING");
  // Attribution stays with the draft's creator even after another actor's
  // edit — which is exactly what the old preview fork broke (it minted a
  // fresh revision with the VIEWER's identity).
  assert.equal(before.rows[0]?.created_by, "test-owner");

  // The viewer holds preview.create + content.edit + content.read — no
  // revision.seal, no content.create, nothing publication-grade.
  const viewerToken = await app.machineIdentity.createAccessToken({
    serviceAccountId: (
      await app.machineIdentity.createServiceAccount({
        name: "preview-viewer",
        purpose: "incident regression",
        allowedScopes: ["preview.create", "content.edit", "content.read"],
      })
    ).id,
    scopes: ["preview.create", "content.edit", "content.read"],
    ttlMilliseconds: 3_600_000,
  });
  const auth = { authorization: `Bearer ${viewerToken.rawSecret}` };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const minted = await fastify.inject({
      method: "POST",
      url: "/api/v1/previews",
      headers: auth,
      payload: {
        scope: {
          kind: "revision",
          entity_type: "entry",
          entity_id: draft.entry_id,
          revision_id: draft.revision_id,
          allow_draft: true,
        },
      },
    });
    assert.equal(minted.statusCode, 201, `attempt ${attempt}`);
    const body = minted.json() as { token: string };
    assert.ok(body.token.length > 20, `attempt ${attempt}: token issued`);
  }

  const after = await snapshot();
  assert.deepEqual(after, before, "preview must not add revisions nor touch attribution");

  // The open editor keeps editing the same WORKING revision with the same
  // generation — no REVISION_NOT_WORKING / STALE from a human preview.
  await updateDraft(
    app,
    apiContextOf(scopedActor(["content.edit"], "svc-editor"), "rest", "req_edit2"),
    {
      revision_id: draft.revision_id,
      payload: { fields: { title: "Incident page v3" }, blocks: { schema_version: 1, blocks: [] } },
      expected_edit_generation: 1,
    },
  );
  const edited = await snapshot();
  assert.equal(edited.count, 1);
  assert.equal(edited.rows[0]?.state, "WORKING");

  // SEALED preview stays supported without allow_draft.
  await sealRevision(app, ownerCtx, { revision_id: draft.revision_id });
  const sealedPreview = await fastify.inject({
    method: "POST",
    url: "/api/v1/previews",
    headers: { authorization: `Bearer ${viewerToken.rawSecret}` },
    payload: {
      scope: {
        kind: "revision",
        entity_type: "entry",
        entity_id: draft.entry_id,
        revision_id: draft.revision_id,
      },
    },
  });
  assert.equal(sealedPreview.statusCode, 201);
});
