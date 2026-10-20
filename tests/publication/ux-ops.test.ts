// Publication UX projections (owner productization pass 0.1.28): pending
// publication aggregation and the human history view, against real
// PostgreSQL. The changeset machinery stays authoritative — these tests pin
// the read models the Admin publication tabs render.
import assert from "node:assert/strict";
import { test } from "node:test";
import { listPendingPublicationsOp, listPublicationHistoryOp } from "@pcms/api";
import {
  createDbPool,
  type DbPool,
  loadMigrations,
  migrateDatabase,
  newStableId,
} from "@pcms/core";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

function connectionInfoOf(db: TestDatabase) {
  const info = {
    host: db.connection.host,
    port: db.connection.port,
    database: db.connection.database,
    user: db.connection.user,
    sslMode: "disable" as const,
  };
  return db.connection.password === undefined
    ? info
    : { ...info, password: db.connection.password };
}

/** Minimal app/ctx doubles: the ops only need the pool + an authorize noop. */
function harness(pool: DbPool) {
  const app = {
    pool,
    authorize: (actor: { permissions: readonly string[] }, permission: string) => {
      if (!actor.permissions.includes(permission)) {
        throw new Error(`forbidden: ${permission}`);
      }
    },
  } as never;
  const ctx = { actor: { permissions: ["publication.read"] } } as never;
  return { app, ctx };
}

async function seedEntry(
  pool: DbPool,
  input: {
    readonly title: string;
    readonly working: boolean;
    readonly publishedRevisionNo: number | null;
    readonly latestRevisionNo: number;
  },
): Promise<string> {
  const entryId = newStableId();
  await pool.query(
    `INSERT INTO entries (id, content_type_id, created_by) VALUES ($1, 'page@1', 'user-1')`,
    [entryId],
  );
  for (let no = 1; no <= input.latestRevisionNo; no += 1) {
    const state = no < input.latestRevisionNo || !input.working ? "SEALED" : "WORKING";
    const sealedExtras =
      state === "SEALED" ? ", now()::timestamptz, $6::text" : ", NULL::timestamptz, $6::text";
    await pool.query(
      `INSERT INTO revisions (id, entity_type, entity_id, revision_no, state, payload, schema_version, origin, created_by_type, created_by, sealed_at, payload_hash)
       VALUES ($1, 'entry', $2, $3, $4, $5::jsonb, '1', 'human', 'human', 'user-1'${sealedExtras})`,
      [
        newStableId(),
        entryId,
        no,
        state,
        JSON.stringify({ fields: { title: input.title } }),
        // Per-revision hash (realistic: a re-seal changes the payload).
        state === "SEALED" ? `${input.title}-${no}` : null,
      ],
    );
  }
  if (input.publishedRevisionNo !== null) {
    await pool.query(
      `INSERT INTO publications (entity_type, entity_id, state, current_revision_id, current_payload_hash, generation, first_published_at, published_at, modified_at)
       SELECT 'entry', $1, 'PUBLISHED', r.id, 'hash-1', 1, now(), now(), now()
       FROM revisions r WHERE r.entity_id = $1 AND r.revision_no = $2`,
      [entryId, input.publishedRevisionNo],
    );
  }
  return entryId;
}

test("pending view lists never-published drafts and stale sealed revisions", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfoOf(db), max: 2 });
  try {
    await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
    const { app, ctx } = harness(pool);

    await seedEntry(pool, {
      title: "Черновик",
      working: true,
      publishedRevisionNo: null,
      latestRevisionNo: 1,
    });
    await seedEntry(pool, {
      title: "Перезапечатан",
      working: false,
      publishedRevisionNo: 1,
      latestRevisionNo: 2,
    });
    await seedEntry(pool, {
      title: "Актуален",
      working: false,
      publishedRevisionNo: 1,
      latestRevisionNo: 1,
    });

    const result = await listPendingPublicationsOp(app, ctx, {});
    const titles = result.items.map((item) => item.title);
    assert.ok(titles.includes("Черновик"), "draft is pending");
    assert.ok(titles.includes("Перезапечатан"), "stale sealed revision is pending");
    assert.ok(!titles.includes("Актуален"), "current pointer is not pending");

    const draft = result.items.find((item) => item.title === "Черновик");
    assert.equal(draft?.status, "draft");
    assert.equal(draft?.published, false);
    const ready = result.items.find((item) => item.title === "Перезапечатан");
    assert.equal(ready?.status, "ready");
    assert.equal(ready?.expected_generation, 1);
    assert.equal(ready?.revision_id.length, 36);
  } finally {
    await pool.end();
  }
});

test("sealed duplicate of the published revision is NOT pending (spangar phantom, 0.1.182)", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfoOf(db), max: 2 });
  try {
    await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
    const { app, ctx } = harness(pool);

    // An autosave re-seal with payload identical to the published revision
    // (same payload_hash): pending must NOT report phantom work — and the
    // op must not throw (0.1.182 regressed here: latest CTE lacked
    // payload_hash, the route answered 500 on every call).
    const entryId = newStableId();
    await pool.query(
      `INSERT INTO entries (id, content_type_id, created_by) VALUES ($1, 'page@1', 'user-1')`,
      [entryId],
    );
    const sameHash = "phantom-same-hash";
    for (const [no, state] of [
      [1, "SEALED"],
      [2, "SEALED"],
    ] as const) {
      await pool.query(
        `INSERT INTO revisions (id, entity_type, entity_id, revision_no, state, payload, schema_version, origin, created_by_type, created_by, sealed_at, payload_hash)
         VALUES ($1, 'entry', $2, $3, $4, $5::jsonb, '1', 'human', 'human', 'user-1', now(), $6::text)`,
        [
          newStableId(),
          entryId,
          no,
          state,
          JSON.stringify({ fields: { title: "Фантом" } }),
          sameHash,
        ],
      );
    }
    await pool.query(
      `INSERT INTO publications (entity_type, entity_id, state, current_revision_id, current_payload_hash, generation, first_published_at, published_at, modified_at)
       SELECT 'entry', $1, 'PUBLISHED', r.id, $2, 7, now(), now(), now()
       FROM revisions r WHERE r.entity_id = $1 AND r.revision_no = 1`,
      [entryId, sameHash],
    );

    const result = await listPendingPublicationsOp(app, ctx, {});
    assert.ok(
      !result.items.some((item) => item.entry_id === entryId),
      "payload-identical sealed duplicate is not pending work",
    );
    // A GENUINE change on top of the same published pointer stays pending
    // (payload_hash differs), and the item carries the verification fields.
    await pool.query(
      `INSERT INTO revisions (id, entity_type, entity_id, revision_no, state, payload, schema_version, origin, created_by_type, created_by, sealed_at, payload_hash)
       VALUES ($1, 'entry', $2, 3, 'SEALED', $3::jsonb, '1', 'human', 'human', 'user-1', now(), 'phantom-real-change')`,
      [newStableId(), entryId, JSON.stringify({ fields: { title: "Фантом v2" } })],
    );
    const after = await listPendingPublicationsOp(app, ctx, {});
    const row = after.items.find((item) => item.entry_id === entryId);
    assert.ok(row !== undefined, "a real re-seal stays pending");
    assert.equal(row.payload_hash, "phantom-real-change");
    assert.equal(row.expected_generation, 7, "live generation is the CAS baseline");
    assert.ok(row.published_revision_id !== null);
  } finally {
    await pool.end();
  }
});

test("folders never appear in the pending publication projection (owner invariant)", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfoOf(db), max: 2 });
  try {
    await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
    const { app, ctx } = harness(pool);

    // A structural folder with a WORKING revision would match the pending
    // filter without the entry_kind gate (migration 1702 semantics).
    const folderId = newStableId();
    await pool.query(
      `INSERT INTO entries (id, content_type_id, entry_kind, created_by) VALUES ($1, 'folder@1', 'folder', 'user-1')`,
      [folderId],
    );
    await pool.query(
      `INSERT INTO revisions (id, entity_type, entity_id, revision_no, state, payload, schema_version, origin, created_by_type, created_by, sealed_at, payload_hash)
       VALUES ($1, 'entry', $2, 1, 'WORKING', $3::jsonb, '1', 'human', 'human', 'user-1', NULL::timestamptz, NULL::text)`,
      [newStableId(), folderId, JSON.stringify({ fields: { title: "Папка Документы" } })],
    );
    await seedEntry(pool, {
      title: "Обычный черновик",
      working: true,
      publishedRevisionNo: null,
      latestRevisionNo: 1,
    });

    const result = await listPendingPublicationsOp(app, ctx, {});
    const titles = result.items.map((item) => item.title);
    assert.ok(!titles.includes("Папка Документы"), "folder is excluded from the pending list");
    assert.ok(titles.includes("Обычный черновик"), "content entries stay pending");
  } finally {
    await pool.end();
  }
});

test("pending rows carry the published flag and the earliest scheduled instant", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfoOf(db), max: 2 });
  try {
    await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
    const { app, ctx } = harness(pool);

    // Working changes on top of a published pointer → working_changes.
    const entryId = await seedEntry(pool, {
      title: "Живой с правками",
      working: true,
      publishedRevisionNo: 1,
      latestRevisionNo: 2,
    });

    // A scheduled plan item pointing at the entry through its changeset item.
    const changesetId = newStableId();
    const changesetItemId = newStableId();
    const planId = newStableId();
    const planItemId = newStableId();
    const targetRevision = await pool.query<{ id: string }>(
      `SELECT id FROM revisions WHERE entity_id = $1 AND revision_no = 2`,
      [entryId],
    );
    await pool.query(
      `INSERT INTO changesets (id, title, state, created_by_type, created_by) VALUES ($1, 'По расписанию', 'PARTIALLY_SCHEDULED', 'human', 'user-9')`,
      [changesetId],
    );
    await pool.query(
      `INSERT INTO changeset_items (id, changeset_id, entity_type, entity_id, intent, target_revision_id, expected_generation, position)
       VALUES ($1, $2, 'entry', $3, 'PUBLISH', $4, 0, 1)`,
      [changesetItemId, changesetId, entryId, targetRevision.rows[0]?.id],
    );
    await pool.query(
      `INSERT INTO publication_plans (id, changeset_id, status, failure_policy, timezone, created_by_type, created_by)
       VALUES ($1, $2, 'COMPILED', 'continue', 'UTC', 'human', 'user-9')`,
      [planId, changesetId],
    );
    await pool.query(
      `INSERT INTO publication_plan_items (id, plan_id, changeset_item_id, batch_no, publish_at, state)
       VALUES ($1, $2, $3, 1, now() + interval '1 day', 'SCHEDULED')`,
      [planItemId, planId, changesetItemId],
    );

    const result = await listPendingPublicationsOp(app, ctx, {});
    const row = result.items.find((item) => item.title === "Живой с правками");
    assert.ok(row !== undefined, "working_changes row is pending");
    assert.equal(row.published, true, "the published baseline is reported");
    assert.equal(row.status, "working_changes");
    assert.ok(row.scheduled_at !== null, "the schedule instant is projected");
  } finally {
    await pool.end();
  }
});

test("history collapses changeset events into named operations", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfoOf(db), max: 2 });
  try {
    await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
    const { app, ctx } = harness(pool);

    const entryA = await seedEntry(pool, {
      title: "Ангар А",
      working: false,
      publishedRevisionNo: null,
      latestRevisionNo: 1,
    });
    const entryB = await seedEntry(pool, {
      title: "Ангар Б",
      working: false,
      publishedRevisionNo: null,
      latestRevisionNo: 1,
    });

    const changesetId = newStableId();
    await pool.query(
      `INSERT INTO changesets (id, title, state, created_by_type, created_by) VALUES ($1, 'Релиз ангаров', 'APPLIED', 'human', 'user-9')`,
      [changesetId],
    );
    for (const entryId of [entryA, entryB]) {
      await pool.query(
        `INSERT INTO publication_events (id, entity_type, entity_id, context, event_type, to_revision_id, actor_class, actor_id, changeset_id)
         VALUES ($1, 'entry', $2, 'default', 'PUBLISH_FIRST',
                 (SELECT id FROM revisions WHERE entity_id = $2 AND revision_no = 1),
                 'human', 'user-9', $3)`,
        [newStableId(), entryId, changesetId],
      );
    }
    // One ungrouped event keeps its individual row.
    await pool.query(
      `INSERT INTO publication_events (id, entity_type, entity_id, context, event_type, to_revision_id, actor_class, actor_id)
       VALUES ($1, 'entry', $2, 'default', 'PUBLISH_UPDATE',
               (SELECT id FROM revisions WHERE entity_id = $2 AND revision_no = 1),
               'human', 'user-9')`,
      [newStableId(), entryA],
    );

    const result = await listPublicationHistoryOp(app, ctx, {});
    const pack = result.items.find((item) => item.kind === "package");
    assert.ok(pack !== undefined, "changeset collapses into one package row");
    assert.equal(pack.title, "Релиз ангаров");
    assert.equal(pack.entry_count, 2);
    assert.deepEqual([...pack.entries].map((entry) => entry.title).sort(), ["Ангар А", "Ангар Б"]);
    const single = result.items.find((item) => item.kind === "single");
    assert.ok(
      single !== undefined && single.title.includes("Ангар А"),
      "single event keeps the entry title",
    );
  } finally {
    await pool.end();
  }
});

test("reidentifyLocale moves entry + all revisions preserving pointers and payloads (identity repair 0.1.185)", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfoOf(db), max: 2 });
  try {
    await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
    const { entries } =
      (await import("@pcms/content")) !== undefined
        ? { entries: (await import("@pcms/content")).createEntriesService(pool) }
        : { entries: undefined as never };

    // The spangar shape: agent created the entry with a non-default identity,
    // revisions + a publication pointer exist, the owner has a working draft.
    const entryId = newStableId();
    await pool.query(
      `INSERT INTO entries (id, content_type_id, created_by, locale) VALUES ($1, 'page@1', 'user-1', 'ru-RU')`,
      [entryId],
    );
    for (const [no, state, hash] of [
      [1, "SEALED", "pub-hash"],
      [2, "SEALED", "draft-hash"],
      [3, "WORKING", null],
    ] as const) {
      await pool.query(
        `INSERT INTO revisions (id, entity_type, entity_id, revision_no, state, payload, schema_version, locale, origin, created_by_type, created_by, sealed_at, payload_hash, edit_generation)
         VALUES ($1, 'entry', $2, $3, $4, $5::jsonb, '1', 'ru-RU', 'human', 'human', 'user-1',
                 CASE WHEN $4 = 'SEALED' THEN now() ELSE NULL END, $6, $7)`,
        [
          newStableId(),
          entryId,
          no,
          state,
          JSON.stringify({ fields: { title: `Стр ${no}` } }),
          hash,
          no,
        ],
      );
    }
    await pool.query(
      `INSERT INTO publications (entity_type, entity_id, state, current_revision_id, current_payload_hash, generation, first_published_at, published_at, modified_at)
       SELECT 'entry', $1, 'PUBLISHED', r.id, 'pub-hash', 1, now(), now(), now()
       FROM revisions r WHERE r.entity_id = $1 AND r.revision_no = 1`,
      [entryId],
    );
    const before = await pool.query<{
      id: string;
      locale: string;
      payload: unknown;
      edit_generation: number;
    }>(
      `SELECT id, locale, payload, edit_generation FROM revisions WHERE entity_id = $1 ORDER BY revision_no`,
      [entryId],
    );
    const publishedPointer = await pool.query<{ current_revision_id: string }>(
      `SELECT current_revision_id FROM publications WHERE entity_type = 'entry' AND entity_id = $1`,
      [entryId],
    );

    const result = await entries.reidentifyLocale(entryId as never, "default");
    assert.equal(result.revisionsAdopted, 1, "only the WORKING draft is adopted");
    assert.equal(result.entry.locale, "default");

    const after = await pool.query<{
      id: string;
      locale: string;
      payload: unknown;
      edit_generation: number;
    }>(
      `SELECT id, locale, payload, edit_generation FROM revisions WHERE entity_id = $1 ORDER BY revision_no`,
      [entryId],
    );
    assert.deepEqual(
      after.rows.map((r) => r.id),
      before.rows.map((r) => r.id),
      "revision ids preserved",
    );
    assert.deepEqual(
      after.rows.map((r) => r.payload),
      before.rows.map((r) => r.payload),
      "payloads untouched",
    );
    assert.deepEqual(
      after.rows.map((r) => r.edit_generation),
      before.rows.map((r) => r.edit_generation),
      "edit generations untouched",
    );
    // Sealed history is immutable (Publication spec §6) and keeps its
    // original locale; the working draft rides the identity locale.
    assert.equal(after.rows.find((r) => r.edit_generation === 3)?.locale, "default");
    assert.equal(after.rows.find((r) => r.edit_generation === 1)?.locale, "ru-RU");
    assert.equal(after.rows.find((r) => r.edit_generation === 2)?.locale, "ru-RU");
    const pointerAfter = await pool.query<{ current_revision_id: string }>(
      `SELECT current_revision_id FROM publications WHERE entity_type = 'entry' AND entity_id = $1`,
      [entryId],
    );
    assert.equal(
      pointerAfter.rows[0]?.current_revision_id,
      publishedPointer.rows[0]?.current_revision_id,
      "publication pointer untouched",
    );
  } finally {
    await pool.end();
  }
});

test("cleanupEntryRevisions deletes all sealed revisions except published (owner 2026-10-06)", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { createDbPool, loadMigrations, migrateDatabase, newStableId } = await import("@pcms/core");
  const { cleanupEntryRevisionsOp } = await import("@pcms/api");
  const { createTestDatabase, testDatabaseConfigured: configured } = await import(
    "../helpers/testdb.js"
  );
  void testDatabaseConfigured;
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfoOf(db), max: 2 });
  try {
    await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
    const app = { pool, authorize: () => {} } as never;
    // actor.type/id feed the audit row (auth_security_events NOT NULLs).
    const ctx = {
      actor: { type: "human", id: "test", permissions: ["content.edit"] },
      transport: "api",
    } as never;

    // 1 published + 1 working + 4 sealed junk (the iterative-editing case).
    const entryId = newStableId();
    await pool.query(
      `INSERT INTO entries (id, content_type_id, created_by) VALUES ($1, 'page@1', 'user-1')`,
      [entryId],
    );
    for (const [no, state] of [
      [1, "SEALED"],
      [2, "SEALED"],
      [3, "SEALED"],
      [4, "SEALED"],
      [5, "SEALED"],
      [6, "WORKING"],
    ] as const) {
      await pool.query(
        `INSERT INTO revisions (id, entity_type, entity_id, revision_no, state, payload, schema_version, locale, origin, created_by_type, created_by, sealed_at, payload_hash, edit_generation)
         VALUES ($1, 'entry', $2, $3, $4, $5::jsonb, '1', 'default', 'human', 'human', 'user-1',
                 CASE WHEN $4 = 'SEALED' THEN now() ELSE NULL END, $6 || '-v' || $7::text, $3)`,
        [
          newStableId(),
          entryId,
          no,
          state,
          JSON.stringify({ fields: { title: `v${no}` } }),
          "hash",
          String(no),
        ],
      );
    }
    await pool.query(
      `INSERT INTO publications (entity_type, entity_id, state, current_revision_id, current_payload_hash, generation, first_published_at, published_at, modified_at)
       SELECT 'entry', $1, 'PUBLISHED', r.id, r.payload_hash, 1, now(), now(), now()
       FROM revisions r WHERE r.entity_id = $1 AND r.revision_no = 1`,
      [entryId],
    );

    const result = await cleanupEntryRevisionsOp(app, ctx, { entry_id: entryId });
    assert.equal(result.deleted, 4, "4 sealed junk revisions deleted");
    assert.equal(result.kept_published_revision_id.length, 36);
    assert.ok(result.working_revision_kept !== null, "working revision kept");
    const left = await pool.query<{ state: string }>(
      `SELECT state FROM revisions WHERE entity_type = 'entry' AND entity_id = $1
       ORDER BY revision_no`,
      [entryId],
    );
    assert.deepEqual(
      left.rows.map((r) => r.state),
      ["SEALED", "WORKING"],
    );
    assert.equal(left.rows.length, 2);
  } finally {
    await pool.end();
  }
});

test("cleanup also removes ever-published revisions and stale context rows (owner 2026-10-06)", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { createDbPool, loadMigrations, migrateDatabase, newStableId } = await import("@pcms/core");
  const { cleanupEntryRevisionsOp } = await import("@pcms/api");
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfoOf(db), max: 2 });
  try {
    await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
    const app = { pool, authorize: () => {} } as never;
    const ctx = {
      actor: { type: "human", id: "test", permissions: ["content.edit"] },
      transport: "api",
    } as never;

    // rev1 published (default), rev2 published in a STALE context then
    // superseded, rev3 sealed junk. Cleanup must keep ONLY rev1 + working.
    const entryId = newStableId();
    await pool.query(
      `INSERT INTO entries (id, content_type_id, created_by) VALUES ($1, 'page@1', 'user-1')`,
      [entryId],
    );
    for (const [no, state, ctxl] of [
      [1, "SEALED", "default"],
      [2, "SEALED", "legacy-ctx"],
      [3, "SEALED", "default"],
    ] as const) {
      await pool.query(
        `INSERT INTO revisions (id, entity_type, entity_id, revision_no, state, payload, schema_version, locale, origin, created_by_type, created_by, sealed_at, payload_hash)
         VALUES ($1, 'entry', $2, $3, $4, $5::jsonb, '1', $6, 'human', 'human', 'user-1', now(), $6 || '-h' || $7::text)`,
        [
          newStableId(),
          entryId,
          no,
          state,
          JSON.stringify({ fields: { title: `v${no}` } }),
          ctxl,
          String(no),
        ],
      );
    }
    await pool.query(
      `INSERT INTO publications (entity_type, entity_id, context, state, current_revision_id, current_payload_hash, generation, first_published_at, published_at, modified_at)
       VALUES ('entry', $1, 'default', 'PUBLISHED', (SELECT id FROM revisions WHERE entity_id=$1 AND revision_no=1), 'h', 8, now(), now(), now()),
              ('entry', $1, 'legacy-ctx', 'PUBLISHED', (SELECT id FROM revisions WHERE entity_id=$1 AND revision_no=2), 'h', 1, now(), now(), now())`,
      [entryId],
    );

    const result = await cleanupEntryRevisionsOp(app, ctx, { entry_id: entryId });
    assert.equal(result.deleted, 2, "rev2 (ever-published in stale ctx) and rev3 deleted");
    const left = await pool.query<{ revision_no: number; state: string }>(
      `SELECT revision_no, state FROM revisions WHERE entity_id = $1 ORDER BY revision_no`,
      [entryId],
    );
    assert.deepEqual(
      left.rows.map((r) => [r.revision_no, r.state]),
      [[1, "SEALED"]],
    );
    const ctxRows = await pool.query<{ context: string }>(
      `SELECT context FROM publications WHERE entity_id = $1`,
      [entryId],
    );
    assert.deepEqual(
      ctxRows.rows.map((r) => r.context),
      ["default"],
      "stale context row purged",
    );
  } finally {
    await pool.end();
  }
});
