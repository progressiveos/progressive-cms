// PCMS-API-T001/T002 — transport-independent application layer + common
// error/validation/request-id model. Acceptance: transport boundary tests +
// stable error fixtures (API spec §78 T001/T002).
import assert from "node:assert/strict";
import { test } from "node:test";
import { domainErrorCode, httpStatusForError, requirePermission, toErrorEnvelope } from "@pcms/api";
import { AuthError } from "@pcms/auth";
import { ContentError } from "@pcms/content";
import { MediaError } from "@pcms/media";
import { NavigationError } from "@pcms/navigation";
import { PublicationError } from "@pcms/publication";
import { RevisionError } from "@pcms/revisions";
import { RoutingError } from "@pcms/routing";
import { SeoError } from "@pcms/seo";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const REFERENCE_CONTENT_TYPES = [
  {
    key: "page",
    version: 1,
    title: "Page",
    bodyPolicy: "block_document",
    fields: {
      title: { id: "title", type: "string", required: true, sortable: true },
    },
  },
] as const;

test("application services wire without HTTP and enforce authorization (T001)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...REFERENCE_CONTENT_TYPES],
  });

  // Discovery works transport-independently.
  const types = app.contentDiscovery.listContentTypes();
  // The system folder type is always registered next to the site types.
  assert.equal(types.length, 2);
  assert.deepEqual(
    types.map((type) => type.key),
    ["folder", "page"],
  );

  // Operation-level authorization: a content-scoped agent cannot publish.
  const agent = apiContextOf(scopedActor(["content.read", "content.create"]));
  assert.throws(
    () => requirePermission(app, agent, "publication.publish"),
    (error) => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.code, "AUTH_PERMISSION_DENIED");
      return true;
    },
  );

  // Same permission key authorizes for a suitably-scoped actor.
  const publisher = apiContextOf(scopedActor(["publication.publish"]));
  requirePermission(app, publisher, "publication.publish");

  // Unregistered permission keys are rejected (no second registry, M08 rules).
  assert.throws(
    () => requirePermission(app, apiContextOf(scopedActor(["content.read"])), "made.up.key"),
    (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.code, "AUTH_UNKNOWN_PERMISSION");
      return true;
    },
  );
});

test("seal validation is wired into the application layer entry adapter (T001)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...REFERENCE_CONTENT_TYPES],
  });
  const ctx = apiContextOf(ownerActor());
  requirePermission(app, ctx, "content.create");
  const entry = await app.entries.createEntry({
    contentTypeId: "page",
    createdBy: `${ctx.actor.type}:${ctx.actor.id}`,
  });
  const working = await app.revisions.createWorkingRevision({
    entityType: "entry",
    entityId: entry.id,
    payload: { fields: {}, blocks: null },
    schemaVersion: "1",
    actor: { actorClass: "human", actorId: ctx.actor.id, origin: "human" },
  });
  // Publish-level validation: required field missing → seal rejected with
  // stable issue codes, not a transport-specific message.
  await assert.rejects(
    () => app.revisions.sealRevision({ revisionId: working.id }),
    (error: unknown) => {
      assert.ok(error instanceof RevisionError);
      assert.equal(error.code, "REVISION_VALIDATION_FAILED");
      const issues = (error.details as { issues: { code: string }[] }).issues;
      assert.ok(issues.some((issue) => issue.code === "FIELD_REQUIRED"));
      return true;
    },
  );
});

test("error model: stable codes map to documented HTTP classes (T002)", () => {
  // Representative stable codes from every subsystem (spec §8).
  const cases: readonly [unknown, string, number][] = [
    [new ContentError("ENTRY_NOT_FOUND", "missing"), "ENTRY_NOT_FOUND", 404],
    [new ContentError("ENTRY_ALREADY_EXISTS", "dup"), "ENTRY_ALREADY_EXISTS", 409],
    [new ContentError("ENTRY_PERSISTENCE_FAILED", "db"), "ENTRY_PERSISTENCE_FAILED", 500],
    [new RevisionError("REVISION_STALE", "stale"), "REVISION_STALE", 409],
    [new RevisionError("REVISION_VALIDATION_FAILED", "invalid"), "REVISION_VALIDATION_FAILED", 422],
    [new PublicationError("PUBLICATION_CONFLICT", "conflict"), "PUBLICATION_CONFLICT", 409],
    [new PublicationError("CHANGESET_EMPTY", "empty"), "CHANGESET_EMPTY", 422],
    [new MediaError("MEDIA_TOO_LARGE", "big"), "MEDIA_TOO_LARGE", 413],
    [new MediaError("MEDIA_IMPORT_SSRF_BLOCKED", "ssrf"), "MEDIA_IMPORT_SSRF_BLOCKED", 422],
    [new SeoError("SEO_DOCUMENT_INVALID", "bad"), "SEO_DOCUMENT_INVALID", 422],
    [new RoutingError("ROUTE_COLLISION", "collision"), "ROUTE_COLLISION", 409],
    [new RoutingError("DOMAIN_ALREADY_BOUND", "bound"), "DOMAIN_ALREADY_BOUND", 409],
    [new NavigationError("NAV_SET_BOUND", "bound"), "NAV_SET_BOUND", 409],
    [new AuthError("AUTH_THROTTLED", "slow", 429), "AUTH_THROTTLED", 429],
    [new AuthError("AUTH_PERMISSION_DENIED", "no", 403), "AUTH_PERMISSION_DENIED", 403],
  ];
  for (const [error, code, expected] of cases) {
    assert.equal(httpStatusForError(error), expected, `${code} → ${expected}`);
    assert.equal(domainErrorCode(error), code);
  }
  // Unknown internals collapse to a stable internal code.
  assert.equal(httpStatusForError(new TypeError("x")), 500);
  assert.equal(domainErrorCode(new TypeError("x")), null);
});

test("error model: one machine envelope with request id (T002)", () => {
  const envelope = toErrorEnvelope(
    new PublicationError("PUBLICATION_CONFLICT", "generation moved", {
      details: { expected: 3, current: 4 },
    }),
    "req_abc",
  );
  assert.deepEqual(envelope, {
    error: {
      code: "PUBLICATION_CONFLICT",
      message: "generation moved",
      request_id: "req_abc",
      details: [{ code: "STATE", expected: 3, current: 4 }],
      retryable: false,
    },
  });
  // CAS conflicts carry the current generation for agent recovery (spec §52).
  // Validation issues keep their code/path/message/severity/source shape.
  const validation = toErrorEnvelope(
    new RevisionError("REVISION_VALIDATION_FAILED", "failed", {
      details: {
        issues: [
          { code: "FIELD_REQUIRED", path: "/fields/title", message: "required", severity: "error" },
        ],
      },
    }),
    "req_abc",
  );
  assert.deepEqual(validation.error.details, [
    { code: "FIELD_REQUIRED", path: "/fields/title", message: "required", severity: "error" },
  ]);
  // Unexpected errors never leak internals in the envelope.
  const internal = toErrorEnvelope(new Error("connect ECONNREFUSED /var/run/postgresql"), "req_x");
  assert.equal(internal.error.code, "INTERNAL_ERROR");
  assert.equal(internal.error.message, "unexpected internal error");
  assert.equal(internal.error.retryable, true);
});
