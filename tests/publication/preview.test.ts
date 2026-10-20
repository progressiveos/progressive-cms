// PCMS-PUB-T016/T017 — candidate preview consistency + signed preview token
// security (Publication spec §45–§48, owner instructions #39–#41):
// - a changeset preview resolves ALL candidate revisions together
// - tokens reject tampering and expiry; secrets come from configuration
// - preview is noindex/outside public routes and never mutates public state
// - raw tokens cannot survive the core logger redaction
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDbPool,
  createLogger,
  type DbPool,
  fixedClock,
  loadMigrations,
  migrateDatabase,
  newStableId,
  type StableId,
} from "@pcms/core";
import {
  type ChangeSetService,
  createChangeSetService,
  createPreviewStateResolver,
  createPreviewTokenService,
  createPublicationService,
  PREVIEW_RESPONSE_HEADERS,
  type PreviewRef,
  type PreviewStateResolver,
  type PublicationService,
  type RevisionReaderPort,
} from "@pcms/publication";
import { createRevisionStore, createVersionedEntityRegistry } from "@pcms/revisions";
import { revisionReaderFromStore } from "../helpers/publication-composition.js";
import { createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

function makeResolver(revisions: RevisionReaderPort, changesets: ChangeSetService) {
  return createPreviewStateResolver({
    revisions,
    changesets,
    clock: fixedClock("2026-10-01T09:00:00Z"),
  });
}

test("preview token: issue/verify round-trip, expiry, tamper, cross-secret rejection", () => {
  const clock = fixedClock("2026-10-01T09:00:00Z");
  const tokens = createPreviewTokenService({ secret: SECRET, ttlMilliseconds: 60_000, clock });
  const ref: PreviewRef = {
    kind: "revision",
    entityType: "entry",
    entityId: newStableId(),
    revisionId: newStableId(),
  };
  const token = tokens.issue(ref);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const verified = tokens.verify(token);
  assert.equal(verified.ok, true);
  if (verified.ok) assert.deepEqual(verified.ref, ref);

  // Tampering: payload edits, signature edits, structural junk.
  assert.equal(tokens.verify(`${token}x`).ok, false);
  const [payload, signature] = token.split(".") as [string, string];
  assert.equal(tokens.verify(`${payload.slice(0, -2)}aa.${signature}`).ok, false);
  assert.equal(tokens.verify("not-a-token").ok, false);
  assert.equal(tokens.verify(`${payload}.${signature.slice(0, -1)}`).ok, false);

  // Different secret: structurally valid but untrusted.
  const other = createPreviewTokenService({
    secret: "y".repeat(40),
    ttlMilliseconds: 60_000,
    clock,
  });
  assert.equal(other.verify(token).ok, false);

  // Expiry is decided by the clock, deterministically.
  const expiredCheck = tokens.verify(token); // still valid
  assert.equal(expiredCheck.ok, true);
  const later = createPreviewTokenService({
    secret: SECRET,
    ttlMilliseconds: 0,
    clock: fixedClock("2026-10-01T10:00:00Z"),
  });
  const expired = later.verify(token);
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.reason, "PREVIEW_TOKEN_EXPIRED");

  // Fail-secure secret handling.
  assert.throws(
    () => createPreviewTokenService({ secret: "short", ttlMilliseconds: 1, clock }),
    (error: unknown) => (error as { code?: string }).code === "PREVIEW_SECRET_MISSING",
  );
});

test("preview response headers pin noindex/noreferrer/no-store", () => {
  assert.equal(PREVIEW_RESPONSE_HEADERS["X-Robots-Tag"], "noindex, nofollow");
  assert.equal(PREVIEW_RESPONSE_HEADERS["Referrer-Policy"], "no-referrer");
  assert.equal(PREVIEW_RESPONSE_HEADERS["Cache-Control"], "private, no-store");
});

test("raw preview tokens are redacted from logs by the core logger", () => {
  const clock = fixedClock("2026-10-01T09:00:00Z");
  const tokens = createPreviewTokenService({
    secret: SECRET,
    ttlMilliseconds: 60_000,
    clock,
  });
  const token = tokens.issue({ kind: "changeset", changesetId: newStableId() });
  const lines: unknown[] = [];
  const logger = createLogger({
    level: "info",
    sink: (line) => {
      lines.push(line);
    },
  });
  logger.error("preview rejected", { preview_token: token, token });
  const serialized = lines.map((line) => JSON.stringify(line)).join("\n");
  assert.ok(!serialized.includes(token), "token material must not appear in any log line");
});

test("changeset preview resolves every candidate revision together", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPreviewFixture(t, async (fx) => {
    const entryId = newStableId();
    const navId = newStableId();
    const globalId = newStableId();
    const entryRevision = await sealRevision(fx, "entry", entryId, { title: "candidate" });
    const navRevision = await sealRevision(fx, "navigation", navId, { items: [] });
    const globalRevision = await sealRevision(fx, "global_content", globalId, { footer: "v2" });

    const changeset = await fx.changesets.createChangeset({ title: "preview", actor: ACTOR });
    await fx.changesets.addItem(changeset.id, {
      entityType: "entry",
      entityId: entryId,
      intent: "PUBLISH",
      targetRevisionId: entryRevision,
      expectedGeneration: 0,
    });
    await fx.changesets.addItem(changeset.id, {
      entityType: "navigation",
      entityId: navId,
      intent: "PUBLISH",
      targetRevisionId: navRevision,
      expectedGeneration: 0,
    });
    await fx.changesets.addItem(changeset.id, {
      entityType: "global_content",
      entityId: globalId,
      intent: "PUBLISH",
      targetRevisionId: globalRevision,
      expectedGeneration: 0,
    });

    const state = await fx.preview.resolve(fx.pool, {
      kind: "changeset",
      changesetId: changeset.id,
    });
    assert.equal(state.entities.length, 3);
    assert.deepEqual(
      state.entities.map((e) => e.revision?.revisionId).sort(),
      [entryRevision, navRevision, globalRevision].sort(),
      "candidate nav/globals/content resolved together, not current public state",
    );

    // Single-revision preview resolves one candidate.
    const single = await fx.preview.resolve(fx.pool, {
      kind: "revision",
      entityType: "entry",
      entityId: entryId,
      revisionId: entryRevision,
    });
    assert.equal(single.entities.length, 1);
    assert.deepEqual(
      single.entities[0]!.revision?.payloadHash,
      (await fx.revisions.getSealedRevision(fx.pool, "entry", entryId, entryRevision))?.payloadHash,
    );
  });
});

test("preview never mutates public state (issue/verify/expiry side-effect free)", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPreviewFixture(t, async (fx) => {
    const entryId = newStableId();
    const revisionId = await sealRevision(fx, "entry", entryId, { seeded: true });
    const ref: PreviewRef = {
      kind: "revision",
      entityType: "entry",
      entityId: entryId,
      revisionId,
    };
    const token = fx.tokens.issue(ref);
    const verified = fx.tokens.verify(token);
    assert.equal(verified.ok, true);
    await fx.preview.resolve(fx.pool, ref);
    // No publication pointer appeared; expiry would change nothing either.
    const publication = await fx.publications.getPublication(fx.pool, "entry", entryId);
    assert.equal(publication, null);
  });
});

// -- fixture -----------------------------------------------------------------

const CLOCK = fixedClock("2026-10-01T09:00:00Z");
const ACTOR = { actorClass: "human", actorId: "editor-1" } as const;
const SYSTEM = { actorClass: "system", actorId: "system", origin: "system" } as const;
const SECRET = "x".repeat(32) + "preview-secret-not-for-production";

interface Fixture {
  pool: DbPool;
  store: ReturnType<typeof createRevisionStore>;
  revisions: RevisionReaderPort;
  changesets: ChangeSetService;
  publications: PublicationService;
  preview: PreviewStateResolver;
  tokens: ReturnType<typeof createPreviewTokenService>;
}

async function sealRevision(
  fx: Fixture,
  entityType: string,
  entityId: StableId,
  payload: unknown,
): Promise<StableId> {
  const working = await fx.store.createWorkingRevision({
    entityType,
    entityId,
    payload,
    schemaVersion: "1",
    actor: SYSTEM,
  });
  return (await fx.store.sealRevision({ revisionId: working.id })).id;
}

async function withPreviewFixture(
  t: { after: (fn: () => void) => void },
  run: (fx: Fixture) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: {
      host: db.connection.host,
      port: db.connection.port,
      database: db.connection.database,
      user: db.connection.user,
      sslMode: "disable" as const,
      ...(db.connection.password === undefined ? {} : { password: db.connection.password }),
    },
    max: 5,
    connectionTimeoutMilliseconds: 3000,
  });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const store = createRevisionStore(pool, {
    registry: createVersionedEntityRegistry(
      ["entry", "global_content", "theme_settings", "navigation"].map((entityType) => ({
        entityType,
        description: entityType,
        validateForSeal: () => [],
      })),
    ),
    clock: CLOCK,
  });
  const revisions = revisionReaderFromStore(store);
  const publications = createPublicationService(pool, { clock: CLOCK, revisions });
  const changesets = createChangeSetService(pool, { clock: CLOCK, revisions, publications });
  const preview = makeResolver(revisions, changesets);
  const tokens = createPreviewTokenService({
    secret: SECRET,
    ttlMilliseconds: 60_000,
    clock: CLOCK,
  });
  await run({ pool, store, revisions, changesets, publications, preview, tokens });
}

test("draft preview: a WORKING revision renders with a draft token, never otherwise", async (t) => {
  await withPreviewFixture(t, async (fx) => {
    const entryId = newStableId();
    const working = await fx.store.createWorkingRevision({
      entityType: "entry",
      entityId: entryId,
      payload: { draft: true },
      schemaVersion: "1",
      actor: SYSTEM,
    });
    const ref = {
      kind: "revision" as const,
      entityType: "entry",
      entityId: entryId,
      revisionId: working.id,
    };
    // Plain token (sealed-only policy): WORKING stays rejected.
    await assert.rejects(
      () => fx.preview.resolve(fx.pool, ref),
      (error: unknown) => (error as { code?: string }).code === "REVISION_NOT_SEALED",
    );
    // Draft token + a reader port with getWorkingRevision: resolves.
    const draftReader: RevisionReaderPort = {
      ...fx.revisions,
      async getWorkingRevision(executor, entityType, entityId, revisionId) {
        const record = await fx.store.getRevision(executor, revisionId);
        if (record === null || record.state !== "WORKING") return null;
        if (record.entityType !== entityType || record.entityId !== entityId) return null;
        return {
          revisionId: record.id,
          entityType: record.entityType,
          entityId: record.entityId,
          payloadHash: record.payloadHash ?? "preview-hash",
          schemaVersion: record.schemaVersion,
          locale: record.locale,
          payload: record.payload,
          mediaVersions: record.mediaVersions,
          sidecar: record.sidecar,
          sealedAt: record.updatedAt ?? record.createdAt,
        };
      },
    };
    const draftPreview = createPreviewStateResolver({
      revisions: draftReader,
      changesets: fx.changesets,
      clock: CLOCK,
    });
    const state = await draftPreview.resolve(fx.pool, ref, { draft: true });
    assert.equal(state.entities[0]?.revision?.revisionId, working.id);
    // Draft tokens themselves carry the flag through HMAC verify.
    const token = fx.tokens.issue(ref, { draft: true });
    assert.deepEqual(fx.tokens.verify(token), { ok: true, ref, draft: true });
    const plain = fx.tokens.issue(ref);
    const plainVerified = fx.tokens.verify(plain);
    assert.equal(plainVerified.ok ? plainVerified.draft : null, false);
    // A SEALED revision still previews fine under a draft token (separate
    // entity: an entry holds at most one WORKING revision at a time).
    const otherEntryId = newStableId();
    const sealedId = await sealRevision(fx, "entry", otherEntryId, { sealed: true });
    const sealedState = await draftPreview.resolve(
      fx.pool,
      { kind: "revision", entityType: "entry", entityId: otherEntryId, revisionId: sealedId },
      { draft: true },
    );
    assert.equal(sealedState.entities[0]?.revision?.revisionId, sealedId);
  });
});

test("preview tokens carry a candidate theme id (signed, 2026-10-01)", () => {
  const clock = fixedClock("2026-10-01T09:00:00Z");
  const tokens = createPreviewTokenService({ secret: SECRET, ttlMilliseconds: 60_000, clock });
  const ref: PreviewRef = {
    kind: "revision",
    entityType: "entry",
    entityId: newStableId(),
    revisionId: newStableId(),
  };
  const themed = tokens.issue(ref, { theme: "candidate" });
  const verified = tokens.verify(themed);
  assert.equal(verified.ok, true);
  assert.equal(verified.ok ? verified.theme : "missing", "candidate");
  // Absence stays absent — pre-0.1.130 tokens keep verifying without a theme.
  const plainVerified = tokens.verify(tokens.issue(ref));
  assert.equal(plainVerified.ok ? (plainVerified.theme ?? "absent") : "invalid", "absent");
});

test("service preview scope, theme and locale are signed and expire under the same TTL", () => {
  const clock = fixedClock("2026-10-01T09:00:00Z");
  const tokens = createPreviewTokenService({ secret: SECRET, ttlMilliseconds: 60_000, clock });
  for (const template of ["search", "error-404"] as const) {
    const ref: PreviewRef = { kind: "service", template, locale: "en-US" };
    const token = tokens.issue(ref, { theme: "candidate" });
    const verified = tokens.verify(token);
    assert.ok(verified.ok);
    assert.deepEqual(verified.ref, ref);
    assert.equal(verified.theme, "candidate");
    assert.equal(verified.draft, false);
    assert.equal(tokens.verify(`${token}x`).ok, false);
    const later = createPreviewTokenService({
      secret: SECRET,
      ttlMilliseconds: 60_000,
      clock: fixedClock("2026-10-01T09:01:01Z"),
    });
    assert.deepEqual(later.verify(token), { ok: false, reason: "PREVIEW_TOKEN_EXPIRED" });
  }
});
