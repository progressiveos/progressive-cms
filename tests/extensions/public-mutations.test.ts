// PREPUBLIC §5 — public mutation contract on extension routes: per-IP rate
// limiting, same-origin enforcement, server-issued guest principals and durable
// Idempotency-Key anti-replay — exercised through the real dispatcher.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createExtensionCatalog,
  defineExtensionArtifact,
  type ExtensionCatalog,
} from "@pcms/extensions/internal";
import { createRouteService } from "@pcms/routing";
import {
  createExtensionHttpRouter,
  type ExtensionHttpFacts,
} from "../../packages/api/src/extension-http.js";
import { createExtensionRouteService } from "../../packages/api/src/extension-routes.js";
import { connectionInfoOf } from "../helpers/api-composition.js";
import { createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const MANIFEST = {
  id: "progressive.test-mutations",
  name: "Mutation fixture",
  version: "1.0.0",
  extension_contract: "2.0",
  cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
  requires: [],
  provides: [],
  permissions: [],
  config_schema: undefined,
  migrations: undefined,
  data_policy: "retain",
  entrypoint: { type: "module" },
  registrations: {
    blocks: [],
    field_types: [],
    routes: [],
    event_subscriptions: [],
    validators: [],
    providers: [],
    operations: [],
    http_routes: [
      {
        route_id: "note",
        method: "POST",
        path: "notes",
        visibility: "public",
        handler: "createNote",
      },
      {
        route_id: "member-note",
        method: "POST",
        path: "member-notes",
        visibility: "session",
        handler: "createNote",
      },
      {
        route_id: "read-note",
        method: "GET",
        path: "notes/:note_id",
        visibility: "public",
        handler: "readNote",
      },
      {
        route_id: "probe-permission",
        method: "POST",
        path: "probe-permission",
        visibility: "public",
        handler: "probePermission",
      },
      {
        route_id: "redirect-note",
        method: "POST",
        path: "notes/redirect",
        visibility: "public",
        handler: "redirectNote",
      },
    ],
    views: [],
    sitemap_sources: [],
    search_sources: [],
    media_usage_sources: [],
    jobs: [],
  },
};

interface Seen {
  actorKind: string | null;
  calls: number;
}

function catalog(
  seen: Seen,
  notes: Map<string, { owner: string | null; body: string }>,
): ExtensionCatalog {
  const registry = createExtensionCatalog();
  registry.register(
    defineExtensionArtifact({
      manifest: MANIFEST,
      module: {
        createNote: (call: { actor: { kind: string }; guestId: string | null }) => {
          seen.calls += 1;
          seen.actorKind = call.actor.kind;
          return { status: 200, json: { ok: true, guest: call.guestId, actor: call.actor.kind } };
        },
        // Object-level authorization (PREPUBLIC §5): the owner is the
        // Core-issued guest principal, never a client-supplied header.
        readNote: (call: { params: { note_id: string }; guestId: string | null }) => {
          const note = notes.get(call.params.note_id);
          if (note === undefined || note.owner !== call.guestId) {
            return { status: 404, json: { error: "not found" } };
          }
          return { status: 200, json: { body: note.body, guest: call.guestId } };
        },
        probePermission: async (call: {
          platform: { authorize: (permission: string) => Promise<void> };
        }) => {
          try {
            await call.platform.authorize("search.admin");
            return { status: 200, json: { authorized: true } };
          } catch (error) {
            return {
              status: 200,
              json: { authorized: false, code: (error as { code?: string }).code },
            };
          }
        },
        redirectNote: () => ({ status: 302, location: "/shop/complete" }),
      },
      contentSha256: "0".repeat(64),
    }),
  );
  return registry;
}

async function harness(
  t: { after: (fn: () => void | Promise<void>) => void },
  seen: Seen,
): Promise<{
  pool: DbPool;
  router: ReturnType<typeof createExtensionHttpRouter>;
  app: never;
  notes: Map<string, { owner: string | null; body: string }>;
}> {
  const notes = new Map<string, { owner: string | null; body: string }>();
  const db = await createTestDatabase(t as never);
  const pool: DbPool = createDbPool({
    connectionInfo: connectionInfoOf(db),
    max: 2,
    connectionTimeoutMilliseconds: 5000,
  });
  t.after(() => void pool.end());
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const extensionRoutes = createExtensionRouteService({
    pool,
    reserved: {
      isReserved: (path: string) => path.startsWith("/admin/") || path.startsWith("/x/"),
      assertNotReserved: () => {},
      listReserved: () => [],
    },
    activeEntryRoutes: async () => [],
  });
  const router = createExtensionHttpRouter({
    catalog: catalog(seen, notes),
    lifecycle: {
      enabledIds: async () => ["progressive.test-mutations"],
      revision: async () => "rev-1",
    },
    resolveRuntime: async (extensionId) => ({ id: extensionId, config: {} }),
    extensionRoutes,
  });
  const app = { defaultSiteKey: "default", pool, routes: createRouteService(pool) } as never;
  return { pool, router, app, notes };
}

const facts = (
  overrides: {
    readonly origin?: string | undefined;
    readonly ip?: string;
    readonly path?: string;
    readonly method?: string;
    readonly body?: unknown;
    readonly headers?: Record<string, string | undefined>;
  } = {},
): ExtensionHttpFacts => ({
  path: overrides.path ?? "/x/progressive.test-mutations/notes",
  method: overrides.method ?? "POST",
  query: {},
  body: overrides.body ?? { body: "hello" },
  mutation: {
    host: "site.example",
    ip: overrides.ip ?? "203.0.113.7",
    headers: {
      origin: Object.hasOwn(overrides, "origin") ? overrides.origin : "https://site.example",
      ...(overrides.headers ?? {}),
    },
  },
});

const dispatch = (
  h: Awaited<ReturnType<typeof harness>>,
  factsInput: ExtensionHttpFacts,
): ReturnType<ReturnType<typeof createExtensionHttpRouter>["dispatch"]> =>
  h.router.dispatch(h.app, factsInput, null);

test("public mutations: same-origin required, cross-origin refused", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const seen: Seen = { actorKind: null, calls: 0 };
  const h = await harness(t, seen);
  const cross = await dispatch(h, facts({ origin: "https://evil.example" }));
  assert.equal(cross.kind, "failure");
  assert.equal((cross as { code?: string }).code, "EXTENSION_MUTATION_ORIGIN");
  const mismatchedReferer = await dispatch(
    h,
    facts({ headers: { referer: "https://evil.example/form" } }),
  );
  assert.equal((mismatchedReferer as { code?: string }).code, "EXTENSION_MUTATION_ORIGIN");
  const same = await dispatch(h, facts());
  assert.equal(same.kind, "json");
  assert.equal(seen.calls, 1, "same-origin mutation executed");
  // A request without a session cookie has no browser identity; its identity
  // is anonymous and rate-limit/idempotency protections still apply.
  const noOrigin = await dispatch(h, facts({ origin: undefined }));
  assert.equal(noOrigin.kind, "json");
  const cookie = String((same as { setCookie?: string }).setCookie).split(";", 1)[0];
  const cookieNoOrigin = await dispatch(h, facts({ origin: undefined, headers: { cookie } }));
  assert.equal((cookieNoOrigin as { code?: string }).code, "EXTENSION_MUTATION_ORIGIN");
});

test("public mutations: only the server-issued guest cookie establishes identity", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const seen: Seen = { actorKind: null, calls: 0 };
  const h = await harness(t, seen);
  const guest = await dispatch(h, facts({ headers: { "x-pcms-guest-id": "guest-abc12345" } }));
  assert.equal(guest.kind, "json");
  const guestId = (guest as { body?: { guest?: string } }).body?.guest;
  assert.match(guestId ?? "", /^[0-9a-f-]{36}$/);
  assert.notEqual(guestId, "guest-abc12345");
  assert.equal(seen.actorKind, "guest", "handler sees the guest principal");
  const cookie = String((guest as { setCookie?: string }).setCookie);
  assert.match(cookie, /^pcms_guest=[A-Za-z0-9_-]{43};/);
  assert.match(cookie, /HttpOnly; SameSite=Lax/);
  const token = cookie.split("=", 2)[1]?.split(";", 1)[0];
  const storedHash = await h.pool.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pcms_guest_sessions WHERE token_hash = $1) AS exists",
    [token],
  );
  assert.equal(storedHash.rows[0]?.exists, false, "database stores only the token hash");
});

test("public mutations: a successful redirect preserves a newly issued guest cookie", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const seen: Seen = { actorKind: null, calls: 0 };
  const h = await harness(t, seen);
  const result = await dispatch(h, facts({ path: "/x/progressive.test-mutations/notes/redirect" }));
  assert.equal(result.kind, "redirect");
  assert.equal((result as { location?: string }).location, "/shop/complete");
  assert.match(
    (result as { setCookie?: string }).setCookie ?? "",
    /^pcms_guest=[A-Za-z0-9_-]{43};.*HttpOnly; SameSite=Lax/,
  );
});

test("public mutations: Idempotency-Key replays durably, conflicts on drift", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const seen: Seen = { actorKind: null, calls: 0 };
  const h = await harness(t, seen);
  const first = await dispatch(h, facts({ headers: { "idempotency-key": "order-create-0001" } }));
  assert.equal(first.kind, "json");
  const cookie = String((first as { setCookie?: string }).setCookie).split(";", 1)[0];
  const replay = await dispatch(
    h,
    facts({ headers: { cookie, "idempotency-key": "order-create-0001" } }),
  );
  assert.equal(replay.kind, "json");
  assert.deepEqual(
    (replay as { body?: unknown }).body,
    (first as { body?: unknown }).body,
    "stored handler response is replayed",
  );
  assert.equal(seen.calls, 1, "handler executed exactly once");
  // Same key + same scope, different fingerprint (body drifts) — 409.
  const conflict = await h.router.dispatch(
    h.app,
    {
      path: "/x/progressive.test-mutations/notes",
      method: "POST",
      query: {},
      body: { body: "DIFFERENT" },
      // Same guest principal as the original key holder.
      mutation: {
        host: "site.example",
        ip: "203.0.113.7",
        headers: { origin: "https://site.example", cookie, "idempotency-key": "order-create-0001" },
      },
    },
    null,
  );
  assert.equal(conflict.kind, "failure");
  assert.equal((conflict as { code?: string }).code, "IDEMPOTENCY_KEY_CONFLICT");
  const badKey = await dispatch(h, facts({ headers: { "idempotency-key": "short" } }));
  assert.equal((badKey as { code?: string }).code, "EXTENSION_IDEMPOTENCY_KEY_INVALID");
});

test("public mutations: per-IP rate limit bounds sustained writes", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const seen: Seen = { actorKind: null, calls: 0 };
  const h = await harness(t, seen);
  let limited = 0;
  const session = await dispatch(h, facts());
  const cookie = String((session as { setCookie?: string }).setCookie).split(";", 1)[0];
  for (let index = 0; index < 35; index += 1) {
    const result = await dispatch(h, facts({ headers: { cookie } }));
    if (
      result.kind === "failure" &&
      (result as { code?: string }).code === "EXTENSION_MUTATION_RATE_LIMITED"
    ) {
      limited += 1;
    }
  }
  assert.ok(limited >= 1, "sustained same-IP writes hit the token bucket");
  assert.ok(seen.calls < 35, "not every write reached the handler");
});

test("public mutations: non-public mutating routes keep session gates", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const seen: Seen = { actorKind: null, calls: 0 };
  const h = await harness(t, seen);
  const result = await h.router.dispatch(
    h.app,
    { ...facts(), path: "/x/progressive.test-mutations/member-notes" },
    null,
  );
  assert.equal((result as { code?: string }).code, "AUTH_REQUIRED");
  assert.equal(seen.calls, 0, "session routes never execute anonymously");
});

test("public mutations: missing transport facts refuse the mutation fail-closed", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const seen: Seen = { actorKind: null, calls: 0 };
  const h = await harness(t, seen);
  const result = await h.router.dispatch(
    h.app,
    { path: "/x/progressive.test-mutations/notes", method: "POST", query: {}, body: {} },
    null,
  );
  assert.equal((result as { code?: string }).code, "EXTENSION_MUTATION_FACTS_MISSING");
  assert.equal(seen.calls, 0);
});

test("public mutations: spoofed guest headers cannot claim another guest's objects", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const seen: Seen = { actorKind: null, calls: 0 };
  const h = await harness(t, seen);
  const created = await dispatch(h, facts({ headers: { "x-pcms-guest-id": "guest-owner-0001" } }));
  assert.equal(created.kind, "json");
  const ownerId = (created as { body?: { guest?: string } }).body?.guest ?? null;
  const ownerCookie = String((created as { setCookie?: string }).setCookie).split(";", 1)[0];
  assert.notEqual(ownerId, "guest-owner-0001", "client-selected header is ignored");
  h.notes.set("note-1", { owner: ownerId, body: "secret of owner" });

  // The owner can resume the server-issued identity with its HttpOnly cookie.
  const own = await dispatch(
    h,
    facts({
      method: "GET",
      path: "/x/progressive.test-mutations/notes/note-1",
      body: undefined,
      headers: { cookie: ownerCookie },
    }),
  );
  assert.equal(own.kind, "json");
  assert.equal((own as { body?: { body?: string } }).body?.body, "secret of owner");

  // Even the exact server principal id is insufficient when supplied through
  // the spoofable header; the extension receives a different fresh identity.
  const forged = await dispatch(
    h,
    facts({
      method: "GET",
      path: "/x/progressive.test-mutations/notes/note-1",
      body: undefined,
      headers: { "x-pcms-guest-id": ownerId ?? "guest-attacker" },
    }),
  );
  assert.equal((forged as { status?: number }).status, 404);
  // No header at all — same isolation.
  const anonymous = await dispatch(
    h,
    facts({ method: "GET", path: "/x/progressive.test-mutations/notes/note-1", body: undefined }),
  );
  assert.equal((anonymous as { status?: number }).status, 404);
});

test("public mutations: guest principal carries zero platform permissions", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const seen: Seen = { actorKind: null, calls: 0 };
  const h = await harness(t, seen);
  const probe = await dispatch(
    h,
    facts({
      path: "/x/progressive.test-mutations/probe-permission",
      headers: { "x-pcms-guest-id": "guest-probe-0001" },
    }),
  );
  assert.equal(probe.kind, "json");
  assert.deepEqual((probe as { body?: { authorized?: boolean; code?: string } }).body, {
    authorized: false,
    code: "AUTH_PERMISSION_DENIED",
  });
});

test("public mutations: concurrent same-key writes execute the handler exactly once", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const seen: Seen = { actorKind: null, calls: 0 };
  const h = await harness(t, seen);
  const session = await dispatch(h, facts());
  const cookie = String((session as { setCookie?: string }).setCookie).split(";", 1)[0];
  seen.calls = 0;
  const fired = [
    dispatch(h, facts({ headers: { cookie, "idempotency-key": "concurrent-key-001" } })),
    dispatch(h, facts({ headers: { cookie, "idempotency-key": "concurrent-key-001" } })),
  ];
  const results = await Promise.all(fired);
  assert.equal(seen.calls, 1, "handler ran exactly once");
  const jsonCount = results.filter((entry) => entry.kind === "json").length;
  const conflictCount = results.filter(
    (entry) =>
      entry.kind === "failure" && (entry as { code?: string }).code === "IDEMPOTENCY_IN_PROGRESS",
  ).length;
  assert.equal(jsonCount + conflictCount, 2, "both callers got a definitive answer");
  assert.ok(jsonCount >= 1, "at least the winner succeeded");
});

test("public mutation replay is guest-bound across NAT and IP changes", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const seen: Seen = { actorKind: null, calls: 0 };
  const h = await harness(t, seen);
  const headers = { "idempotency-key": "shared-key-0001" };
  const first = await dispatch(h, facts({ headers }));
  const other = await dispatch(h, facts({ headers }));
  assert.equal(first.kind, "json");
  assert.equal(other.kind, "json");
  assert.notDeepEqual((first as { body: unknown }).body, (other as { body: unknown }).body);
  const cookie = String((first as { setCookie?: string }).setCookie).split(";", 1)[0];
  const replay = await dispatch(h, facts({ ip: "203.0.113.99", headers: { ...headers, cookie } }));
  assert.deepEqual((replay as { body: unknown }).body, (first as { body: unknown }).body);
  assert.equal(seen.calls, 2);
});
