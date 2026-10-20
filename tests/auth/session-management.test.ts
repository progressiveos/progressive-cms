// PCMS-AUTH-T027 — active session management application services: list,
// identify current, revoke one/all (Auth spec §33/§34). This is the surface
// M10's Users/Sessions UI consumes.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSessionService,
  createUserIdentityService,
  DEFAULT_SESSION_COOKIE,
  parseSessionCookie,
  type SessionService,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from "@pcms/auth";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

function connectionInfo(db: TestDatabase) {
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

async function withManagement(
  t: { after: (fn: () => void) => void },
  run: (sessions: SessionService, pool: DbPool, userId: string) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const users = createUserIdentityService(pool);
  const user = await users.createUser({ displayName: "M", email: "mgmt@example.com" });
  await run(createSessionService(pool), pool, user.id);
}

test("listing shows created/last-active/coarse metadata and marks nothing sensitive", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withManagement(t, async (sessions, _pool, userId) => {
    await sessions.createSession(userId, {
      metadata: { clientClass: "browser", platform: "linux" },
    });
    await sessions.createSession(userId, { metadata: { clientClass: "cli" } });

    const active = await sessions.listActiveSessions(userId);
    assert.equal(active.length, 2);
    for (const session of active) {
      assert.ok(session.createdAt instanceof Date);
      assert.ok(session.lastSeenAt instanceof Date);
      // Coarse metadata only — no IP strings, no user-agent fingerprints.
      const meta = JSON.stringify(session.metadata ?? {});
      assert.equal(meta.includes("127.0.0.1"), false);
      assert.equal(meta.toLowerCase().includes("user-agent"), false);
    }
  });
});

test("logout current revokes exactly one session; logout all revokes the rest", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withManagement(t, async (sessions, _pool, userId) => {
    const current = await sessions.createSession(userId, {});
    const other = await sessions.createSession(userId, {});

    await sessions.revokeSession(current.sessionId, "logout");
    assert.equal(await sessions.resolveSession(current.rawToken), null);
    assert.notEqual(await sessions.resolveSession(other.rawToken), null);
    assert.equal(await sessions.listActiveSessions(userId).then((r) => r.length), 1);

    assert.equal(await sessions.revokeAllForUser(userId, "logout-all"), 1);
    assert.equal(await sessions.resolveSession(other.rawToken), null);
    assert.equal((await sessions.listActiveSessions(userId)).length, 0);
  });
});

test("admin revoke by session id cannot be confused with a foreign user's session", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withManagement(t, async (sessions, pool, userId) => {
    const users = createUserIdentityService(pool);
    const stranger = await users.createUser({ displayName: "S", email: "stranger@example.com" });
    const mine = await sessions.createSession(userId, {});
    const theirs = await sessions.createSession(stranger.id, {});

    await sessions.revokeSession(mine.sessionId, "admin-revoked");
    assert.notEqual(await sessions.resolveSession(theirs.rawToken), null); // untouched

    // Revoking an already-revoked session is a clean 404-style error.
    await assert.rejects(
      () => sessions.revokeSession(mine.sessionId, "again"),
      (err: { code: string }) => err.code === "AUTH_SESSION_INVALID",
    );
    void theirs;
  });
});

test("logout hands the client a cleared cookie that parses to nothing usable", () => {
  const cleared = serializeClearedSessionCookie(DEFAULT_SESSION_COOKIE);
  assert.match(cleared, /Max-Age=0/);
  const parsed = parseSessionCookie(cleared, DEFAULT_SESSION_COOKIE);
  assert.equal(parsed, "cleared"); // sentinel, never a real token shape
  // And the live cookie shape carries the full secure attributes.
  const live = serializeSessionCookie(DEFAULT_SESSION_COOKIE, "realtoken", 600);
  assert.match(live, /HttpOnly/);
  assert.match(live, /Secure/);
});
