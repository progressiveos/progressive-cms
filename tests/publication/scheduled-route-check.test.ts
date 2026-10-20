import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApiFastify, createDraft, queryCollectionFeed, sealRevision } from "@pcms/api";
import { createPublicationJobHandlers } from "@pcms/publication";
import { registerSiteRoute } from "../../apps/web/src/site.js";
import { apiContextOf, ownerActor } from "../helpers/api-composition.js";
import { rollbackApiFixture } from "../helpers/rollback-api-fixture.js";

const defs = JSON.parse(
  readFileSync("fixtures/content/reference-content-types.json", "utf8"),
).contentTypes;
for (const scheduled of [false, true]) {
  test(`${scheduled ? "scheduled Worker" : "immediate ChangeSet"}: first publication must create its canonical route`, async (t) => {
    let now = new Date("2026-10-14T00:00:00Z");
    const clock = { now: () => new Date(now) };
    const { app, pool } = await rollbackApiFixture(t, {
      clock,
      themeDir: "themes/reference-theme-v1",
      contentTypeDefinitions: defs,
      seoEnvironment: "production",
    });
    const ctx = apiContextOf(ownerActor());
    const site = await app.routes.ensureSite("default");
    await app.domains.addDomainBinding({ siteId: site.id, hostname: "news.test", isPrimary: true });
    const draft = await createDraft(app, ctx, {
      content_type: "news",
      payload: {
        fields: { title: "Scheduled route check" },
        blocks: { schema_version: 1, blocks: [] },
      },
    });
    await sealRevision(app, ctx, { revision_id: draft.revision_id });
    const actor = { actorClass: "human" as const, actorId: "route-check" };
    const change = await app.changesets.createChangeset({ title: "Route check", actor });
    const item = await app.changesets.addItem(change.id, {
      entityType: "entry",
      entityId: draft.entry_id as never,
      intent: "PUBLISH",
      targetRevisionId: draft.revision_id as never,
      expectedGeneration: 0,
      routeOperation: { kind: "set", siteId: site.id, path: "/news/scheduled-route/" },
    });
    const preflight = await app.changesets.preflight(change.id);
    assert.equal(preflight.ok, true, JSON.stringify(preflight.issues));
    let jobState: unknown = null;
    let sourcePreserved = true;
    if (scheduled) {
      const plan = await app.plans.createPlan({ changesetId: change.id, timezone: "UTC", actor });
      await app.plans.compilePlan(plan.id, {
        startAt: new Date("2026-10-14T00:01:00Z"),
        batchSize: 1,
        interval: { unit: "days", value: 1 },
      });
      now = new Date("2026-10-14T00:02:00Z");
      const claimed = await app.jobs.claim({
        workerId: "route-check",
        limit: 100,
        leaseMilliseconds: 30000,
      });
      const job = claimed.find((j) => j.type === "publication.publish");
      assert.ok(job);
      sourcePreserved = (job.payload as { changesetItemId?: string }).changesetItemId === item.id;
      const handlers = createPublicationJobHandlers({
        pool,
        clock,
        publications: app.publications,
        changesets: app.changesets,
        siteKey: app.defaultSiteKey,
      });
      const outcome = await handlers["publication.publish"](job.payload as never, {
        job: { id: job.id },
        attempt: 1,
      });
      if (outcome === undefined) await app.jobs.complete(job.id);
      else if (typeof outcome === "object")
        await app.jobs.fail(job.id, outcome.outcome, outcome.error);
      else await app.jobs.fail(job.id, outcome, "scheduled handler failure");
      jobState = (await app.jobs.getJob(pool, job.id))?.state;
      // Duplicate Worker dispatch must not add another publication event/generation.
      const beforeRetry = await pool.query(
        "SELECT generation FROM publications WHERE entity_id=$1",
        [draft.entry_id],
      );
      await handlers["publication.publish"](job.payload as never, {
        job: { id: job.id },
        attempt: 2,
      });
      assert.deepEqual(
        (
          await pool.query("SELECT generation FROM publications WHERE entity_id=$1", [
            draft.entry_id,
          ])
        ).rows,
        beforeRetry.rows,
      );
    } else {
      await app.changesets.apply(change.id, { actor });
    }
    const publication = await app.publications.getPublication(
      pool,
      "entry",
      draft.entry_id as never,
    );
    const route = await pool.query(
      "SELECT path FROM routes WHERE target_id=$1 AND retired_at IS NULL",
      [draft.entry_id],
    );
    const feed = await queryCollectionFeed(
      { pool, isKnownContentType: (key) => app.contentTypes.getLatestContentType(key) !== null },
      {
        context: "default",
        contentTypes: ["news"],
        sectionEntryId: null,
        tagField: "tags",
        tag: null,
        page: 1,
        pageSize: 10,
      },
    );
    const sitemap = await app.seoDiscovery.getSitemapDocument();
    const server = createApiFastify(() => "scheduled-check");
    await registerSiteRoute(server, { application: app });
    t.after(() => server.close());
    const http = await server.inject({
      method: "GET",
      url: "/news/scheduled-route/",
      headers: { host: "news.test" },
    });
    assert.equal(publication?.generation, 1);
    if (scheduled) {
      assert.equal(jobState, "SUCCEEDED");
      assert.equal(sourcePreserved, true);
    }

    assert.equal(publication?.state, "PUBLISHED");
    assert.equal(publication?.currentRevisionId, draft.revision_id);
    assert.equal(route.rows[0]?.path, "/news/scheduled-route/");
    assert.equal(http.statusCode, 200);
    assert.equal(feed.total, 1);
    assert.ok(sitemap?.includes("/news/scheduled-route/"));
  });
}

async function scheduledFixture(t: Parameters<typeof rollbackApiFixture>[0], route = true) {
  let now = new Date("2026-10-14T00:00:00Z");
  const clock = { now: () => new Date(now) };
  const { app, pool } = await rollbackApiFixture(t, { clock, contentTypeDefinitions: defs });
  const ctx = apiContextOf(ownerActor());
  const site = await app.routes.ensureSite("default");
  const draft = await createDraft(app, ctx, {
    content_type: "news",
    payload: {
      fields: { title: "Atomic scheduled item" },
      blocks: { schema_version: 1, blocks: [] },
    },
  });
  await sealRevision(app, ctx, { revision_id: draft.revision_id });
  const actor = { actorClass: "human" as const, actorId: "atomic-check" };
  const change = await app.changesets.createChangeset({ title: "Atomic check", actor });
  const item = await app.changesets.addItem(change.id, {
    entityType: "entry",
    entityId: draft.entry_id as never,
    intent: "PUBLISH",
    targetRevisionId: draft.revision_id as never,
    expectedGeneration: 0,
    ...(route
      ? { routeOperation: { kind: "set" as const, siteId: site.id, path: "/scheduled/" } }
      : {}),
  });
  assert.equal((await app.changesets.preflight(change.id)).ok, true);
  const plan = await app.plans.createPlan({
    changesetId: change.id,
    timezone: "UTC",
    failurePolicy: "pause_plan",
    actor,
  });
  await app.plans.compilePlan(plan.id, {
    startAt: new Date("2026-10-14T00:01:00Z"),
    batchSize: 1,
    interval: { unit: "days", value: 1 },
  });
  now = new Date("2026-10-14T00:02:00Z");
  const job = (
    await app.jobs.claim({ workerId: "atomic-check", limit: 100, leaseMilliseconds: 30000 })
  ).find((job) => job.type === "publication.publish");
  assert.ok(job);
  const payload = job.payload as import("@pcms/publication").PublicationJobPayload;
  const deps = {
    pool,
    clock,
    publications: app.publications,
    changesets: app.changesets,
    siteKey: app.defaultSiteKey,
  };
  const dispatch = (input = payload, override = deps) =>
    createPublicationJobHandlers(override)["publication.publish"](input, {
      job: { id: job.id },
      attempt: 1,
    });
  const counts = async () =>
    (
      await pool.query(
        `SELECT (SELECT count(*) FROM publication_events WHERE entity_id=$1 AND event_type IN ('PUBLISH_FIRST','PUBLISH_UPDATE')) AS events, (SELECT count(*) FROM publication_outbox) AS outbox`,
        [draft.entry_id],
      )
    ).rows;
  return {
    app,
    pool,
    clock,
    ctx,
    site,
    draft,
    actor,
    item,
    plan,
    job,
    payload,
    deps,
    dispatch,
    counts,
    advance: () => {
      now = new Date("2026-10-14T00:04:00Z");
    },
  };
}

test("compiled RC11 payload resolves immutable route; retry adds no events or outbox side effects", async (t) => {
  const fx = await scheduledFixture(t);
  assert.equal(fx.payload.changesetItemId, fx.item.id);
  assert.equal("routeOperation" in fx.payload, false);
  assert.equal(await fx.dispatch(), undefined);
  const before = await fx.counts();
  assert.equal(before[0]?.events, "1");
  assert.equal(await fx.dispatch(), undefined);
  assert.deepEqual(await fx.counts(), before);
  assert.equal(
    (await fx.app.publications.getPublication(fx.pool, "entry", fx.draft.entry_id as never))
      ?.generation,
    1,
  );
});

for (const field of [
  "entityId",
  "targetRevisionId",
  "changesetItemId",
  "planId",
  "planItemId",
  "context",
  "entityType",
  "site",
] as const) {
  test(`scheduled source mismatch: ${field} fails closed`, async (t) => {
    const fx = await scheduledFixture(t);
    const payload = { ...fx.payload };
    if (field === "site") {
      const outcome = await fx.dispatch(payload, { ...fx.deps, siteKey: "foreign-site" });
      assert.ok(typeof outcome === "object" && outcome.outcome === "permanent");
      assert.equal((outcome.error as { code: string }).code, "CHANGESET_ITEM_INVALID");
    } else {
      if (field === "context" || field === "entityType") payload[field] = "wrong";
      else payload[field] = "00000000-0000-7000-8000-000000000001" as never;
      const outcome = await fx.dispatch(payload);
      assert.ok(typeof outcome === "object" && outcome.outcome === "permanent");
      assert.equal((outcome.error as { code: string }).code, "CHANGESET_ITEM_INVALID");
    }
    assert.equal(
      await fx.app.publications.getPublication(fx.pool, "entry", fx.draft.entry_id as never),
      null,
    );
    assert.equal((await fx.counts())[0]?.events, "0");
    assert.equal(
      (
        await fx.pool.query("SELECT count(*) AS n FROM routes WHERE target_id=$1", [
          fx.draft.entry_id,
        ])
      ).rows[0]?.n,
      "0",
    );
    if (["planId", "planItemId", "changesetItemId"].includes(field)) {
      assert.equal(
        (
          await fx.pool.query("SELECT state FROM publication_plan_items WHERE plan_id=$1", [
            fx.plan.id,
          ])
        ).rows[0]?.state,
        "SCHEDULED",
      );
    }
  });
}

test("route collision rolls back publication, returns typed failure and pauses plan", async (t) => {
  const fx = await scheduledFixture(t);
  const other = await createDraft(fx.app, fx.ctx, {
    content_type: "news",
    payload: { fields: { title: "Existing owner" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await fx.app.routes.activateRoute({
    siteId: fx.site.id,
    path: "/scheduled/",
    targetType: "entry",
    targetId: other.entry_id,
  });
  const before = await fx.counts();
  const outcome = await fx.dispatch();
  assert.ok(typeof outcome === "object" && outcome.outcome === "permanent");
  assert.equal((outcome.error as { code: string }).code, "ROUTE_CONFLICT");
  await fx.app.jobs.fail(fx.job.id, outcome.outcome, outcome.error);
  assert.equal((await fx.app.jobs.getJob(fx.pool, fx.job.id))?.state, "DEAD");
  assert.equal(
    await fx.app.publications.getPublication(fx.pool, "entry", fx.draft.entry_id as never),
    null,
  );
  assert.deepEqual(await fx.counts(), before);
  assert.equal(
    (await fx.pool.query("SELECT state FROM publication_plan_items WHERE plan_id=$1", [fx.plan.id]))
      .rows[0]?.state,
    "FAILED",
  );
  assert.equal(
    (await fx.pool.query("SELECT status FROM publication_plans WHERE id=$1", [fx.plan.id])).rows[0]
      ?.status,
    "PAUSED",
  );
  assert.equal(
    (
      await fx.pool.query(
        "SELECT target_id FROM routes WHERE path='/scheduled/' AND retired_at IS NULL",
      )
    ).rows[0]?.target_id,
    other.entry_id,
  );
});

test("route failure after pointer write rolls back generation and publication events", async (t) => {
  const fx = await scheduledFixture(t);
  const { createChangeSetService, PublicationError } = await import("@pcms/publication");
  const { revisionReaderFromStore } = await import("../helpers/publication-composition.js");
  let pointerSeen = false;
  const changesets = createChangeSetService(fx.pool, {
    clock: fx.clock,
    revisions: revisionReaderFromStore(fx.app.revisions),
    publications: fx.app.publications,
    routes: {
      async activateWithinTx(tx) {
        pointerSeen =
          (await fx.app.publications.getPublication(tx, "entry", fx.draft.entry_id as never))
            ?.state === "PUBLISHED";
        throw new PublicationError("ROUTE_CONFLICT", "route rejected at commit");
      },
      async retireWithinTx() {
        throw new Error("unexpected retire");
      },
    },
  });
  const before = await fx.counts();
  const outcome = await fx.dispatch(fx.payload, { ...fx.deps, changesets });
  assert.equal(pointerSeen, true);
  assert.ok(typeof outcome === "object" && outcome.outcome === "permanent");
  assert.equal(
    await fx.app.publications.getPublication(fx.pool, "entry", fx.draft.entry_id as never),
    null,
  );
  assert.deepEqual(await fx.counts(), before);
});

test("source without routeOperation preserves route-free publication semantics", async (t) => {
  const fx = await scheduledFixture(t, false);
  assert.equal(await fx.dispatch(), undefined);
  assert.equal(
    (await fx.app.publications.getPublication(fx.pool, "entry", fx.draft.entry_id as never))
      ?.generation,
    1,
  );
  assert.equal(
    (
      await fx.pool.query("SELECT count(*) AS n FROM routes WHERE target_id=$1", [
        fx.draft.entry_id,
      ])
    ).rows[0]?.n,
    "0",
  );
});

test("unchanged revision with a new route executes CAS once instead of skipping the route", async (t) => {
  const fx = await scheduledFixture(t);
  await fx.dispatch();
  const change = await fx.app.changesets.createChangeset({
    title: "Move existing revision",
    actor: fx.actor,
  });
  await fx.app.changesets.addItem(change.id, {
    entityType: "entry",
    entityId: fx.draft.entry_id as never,
    intent: "PUBLISH",
    targetRevisionId: fx.draft.revision_id as never,
    expectedGeneration: 1,
    routeOperation: { kind: "set", siteId: fx.site.id, path: "/moved/", freesPath: "/scheduled/" },
  });
  assert.equal((await fx.app.changesets.preflight(change.id)).ok, true);
  const plan = await fx.app.plans.createPlan({
    changesetId: change.id,
    timezone: "UTC",
    actor: fx.actor,
  });
  await fx.app.plans.compilePlan(plan.id, {
    startAt: new Date("2026-10-14T00:03:00Z"),
    batchSize: 1,
    interval: { unit: "days", value: 1 },
  });
  fx.advance();
  const job = (
    await fx.app.jobs.claim({ workerId: "move-check", limit: 100, leaseMilliseconds: 30000 })
  ).find((job) => job.type === "publication.publish");
  assert.ok(job);
  const handler = createPublicationJobHandlers(fx.deps)["publication.publish"];
  const payload = job.payload as import("@pcms/publication").PublicationJobPayload;
  assert.equal(await handler(payload, { job: { id: job.id }, attempt: 1 }), undefined);
  assert.equal(
    (await fx.app.publications.getPublication(fx.pool, "entry", fx.draft.entry_id as never))
      ?.generation,
    2,
  );
  assert.deepEqual(
    (
      await fx.pool.query("SELECT path FROM routes WHERE target_id=$1 AND retired_at IS NULL", [
        fx.draft.entry_id,
      ])
    ).rows,
    [{ path: "/moved/" }],
  );
  const before = await fx.counts();
  assert.equal(await handler(payload, { job: { id: job.id }, attempt: 2 }), undefined);
  assert.deepEqual(await fx.counts(), before);
});

test("stale compiled generation fails CAS without creating a route", async (t) => {
  const fx = await scheduledFixture(t);
  await fx.pool.withTransaction((tx) =>
    fx.app.publications.publishWithinTx(tx, {
      entityType: "entry",
      entityId: fx.draft.entry_id as never,
      targetRevisionId: fx.draft.revision_id as never,
      expectedGeneration: 0,
      actor: fx.actor,
    }),
  );
  const before = await fx.counts();
  const outcome = await fx.dispatch();
  assert.ok(typeof outcome === "object" && outcome.outcome === "permanent");
  assert.equal((outcome.error as { code: string }).code, "PUBLICATION_CONFLICT");
  assert.deepEqual(await fx.counts(), before);
  assert.equal(
    (
      await fx.pool.query("SELECT count(*) AS n FROM routes WHERE target_id=$1", [
        fx.draft.entry_id,
      ])
    ).rows[0]?.n,
    "0",
  );
});

test("foreign job cannot execute or fail another job's scheduled item", async (t) => {
  const fx = await scheduledFixture(t);
  const outcome = await createPublicationJobHandlers(fx.deps)["publication.publish"](fx.payload, {
    job: { id: "00000000-0000-7000-8000-000000000001" },
    attempt: 1,
  });
  assert.ok(typeof outcome === "object" && outcome.outcome === "permanent");
  assert.equal((outcome.error as { code: string }).code, "CHANGESET_ITEM_INVALID");
  assert.equal(
    (await fx.pool.query("SELECT state FROM publication_plan_items WHERE plan_id=$1", [fx.plan.id]))
      .rows[0]?.state,
    "SCHEDULED",
  );
  assert.equal(
    await fx.app.publications.getPublication(fx.pool, "entry", fx.draft.entry_id as never),
    null,
  );
});
