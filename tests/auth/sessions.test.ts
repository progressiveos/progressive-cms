// PCMS-AUTH-T007/T008 — opaque sessions: token-hash-only storage, rotation,
// expiry (idle/absolute), revocation, cookie attributes, fixation.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertValidCookieConfig,
  CookieConfigError,
  createSessionService,
  createUserIdentityService,
  DEFAULT_SESSION_COOKIE,
  hashSessionToken,
  parseSessionCookie,
  type SessionService,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  sessionHashesEqual,
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

async function withSessions(
  t: { after: (fn: () => void) => void },
  run: (
    sessions: SessionService,
    users: ReturnType<typeof createUserIdentityService>,
    pool: DbPool,
  ) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  await run(createSessionService(pool), createUserIdentityService(pool), pool);
}

test("DB stores only the token hash; resolution works solely from the raw token", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withSessions(t, async (sessions, users, pool) => {
    const user = await users.createUser({ displayName: "S", email: "s@example.com" });
    const { sessionId, rawToken } = await sessions.createSession(user.id, {});

    const stored = await pool.query<{ token_hash: string }>(
      "SELECT token_hash FROM auth_sessions WHERE id = $1",
      [sessionId],
    );
    const storedHash = stored.rows[0]?.token_hash ?? "";
    assert.equal(storedHash.startsWith("pcms_"), false); // not a raw token shape
    assert.equal(storedHash, hashSessionToken(rawToken));
    assert.ok(!storedHash.includes(rawToken) && rawToken.length === 43); // 32B b64url
    assert.ok(sessionHashesEqual(storedHash, hashSessionToken(rawToken)));

    const resolved = await sessions.resolveSession(rawToken);
    assert.equal(resolved?.session.id, sessionId);
    assert.equal(await sessions.resolveSession("totally-wrong-token"), null);
  });
});

test("absolute and idle expiry both kill the session", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withSessions(t, async (sessions, users, pool) => {
    const user = await users.createUser({ displayName: "X", email: "x@example.com" });

    // Absolute expiry (default 30d): move the clock past it.
    const { rawToken } = await sessions.createSession(user.id, { now: new Date(0) });
    const later = new Date(31 * 24 * 60 * 60 * 1000);
    assert.equal(await sessions.resolveSession(rawToken, { now: later }), null);

    // Idle expiry: timeouts are service-level config — use a service with a
    // 1s idle window and one consistent synthetic clock.
    const idleService = createSessionService(pool, {
      timeouts: { idleTimeoutMilliseconds: 1000, absoluteTimeoutMilliseconds: 100_000 },
    });
    const { rawToken: token2 } = await idleService.createSession(user.id, {
      now: new Date(100_000),
    });
    const midIdle = new Date(100_000 + 800);
    const afterIdle = new Date(100_000 + 2000);
    const touched = await idleService.resolveSession(token2, { now: midIdle });
    assert.notEqual(touched, null); // inside idle window…
    const gone = await idleService.resolveSession(token2, { now: afterIdle });
    assert.equal(gone, null); // …but idle timeout applies from last_seen
  });
});

test("rotation issues a fresh token and revokes the old one (fixation-proof)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withSessions(t, async (sessions, users) => {
    const user = await users.createUser({ displayName: "R", email: "r@example.com" });
    const first = await sessions.createSession(user.id, {});
    const second = await sessions.rotateSession(first.rawToken);

    assert.notEqual(second.rawToken, first.rawToken);
    assert.notEqual(second.sessionId, first.sessionId);
    assert.equal(await sessions.resolveSession(first.rawToken), null); // old dead
    const resolved = await sessions.resolveSession(second.rawToken);
    assert.equal(resolved?.session.id, second.sessionId);

    // Replaying the pre-rotation token cannot rotate again (no live session).
    await assert.rejects(
      () => sessions.rotateSession(first.rawToken),
      (err: { code: string }) => err.code === "AUTH_SESSION_INVALID",
    );
    // Rotation preserves authentication strength (authenticated_at/mfa_at) —
    // with one consistent synthetic clock across create/rotate/resolve.
    const epoch = 1_700_000_000_000;
    const mfa = await sessions.createSession(user.id, {
      mfaAt: new Date(epoch),
      now: new Date(epoch),
    });
    const rotated = await sessions.rotateSession(mfa.rawToken, { now: new Date(epoch + 5000) });
    const check = await sessions.resolveSession(rotated.rawToken, {
      now: new Date(epoch + 5000),
    });
    assert.equal(check?.session.mfaAt?.getTime(), epoch);
  });
});

test("revocation: single session and revoke-all; disabled users lose sessions instantly", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withSessions(t, async (sessions, users) => {
    const user = await users.createUser({ displayName: "D", email: "d@example.com" });
    const a = await sessions.createSession(user.id, {});
    const b = await sessions.createSession(user.id, {});

    await sessions.revokeSession(a.sessionId, "admin-revoked");
    assert.equal(await sessions.resolveSession(a.rawToken), null);
    assert.notEqual(await sessions.resolveSession(b.rawToken), null);

    assert.equal(await sessions.revokeAllForUser(user.id, "password-reset"), 1);
    assert.equal(await sessions.resolveSession(b.rawToken), null);

    // Disabled user: even an unrevoked, valid session resolves to nothing —
    // the lookup joins user status, so disable takes effect immediately.
    const c = await sessions.createSession(user.id, {});
    await users.disableUser(user.id);
    assert.equal(await sessions.resolveSession(c.rawToken), null);
    await users.enableUser(user.id);
    assert.notEqual(await sessions.resolveSession(c.rawToken), null); // c was never revoked
  });
});

test("listActiveSessions exposes only live sessions with coarse metadata", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withSessions(t, async (sessions, users) => {
    const user = await users.createUser({ displayName: "L", email: "l@example.com" });
    await sessions.createSession(user.id, { metadata: { clientClass: "browser" } });
    const dead = await sessions.createSession(user.id, {});
    await sessions.revokeSession(dead.sessionId, "test");

    const active = await sessions.listActiveSessions(user.id);
    assert.equal(active.length, 1);
    assert.deepEqual(active[0]?.metadata, { clientClass: "browser" });
  });
});

test("cookie contract: __Host- prefix, Secure/HttpOnly/SameSite/Path=/, no Domain", () => {
  const header = serializeSessionCookie(DEFAULT_SESSION_COOKIE, "abc-token", 3600);
  assert.match(header, /^__Host-pcms_session=abc-token;/);
  assert.match(header, /Max-Age=3600/);
  assert.match(header, /; Path=\//);
  assert.match(header, /; HttpOnly/);
  assert.match(header, /; SameSite=Lax/);
  assert.match(header, /; Secure$/);
  assert.doesNotMatch(header, /Domain=/);

  assert.equal(
    parseSessionCookie("other=x; __Host-pcms_session=abc-token", DEFAULT_SESSION_COOKIE),
    "abc-token",
  );
  assert.equal(parseSessionCookie(undefined, DEFAULT_SESSION_COOKIE), null);
  assert.equal(parseSessionCookie("__Host-pcms_session=bad value!", DEFAULT_SESSION_COOKIE), null);
  assert.match(serializeClearedSessionCookie(DEFAULT_SESSION_COOKIE), /Max-Age=0/);

  // Fail-secure configuration: __Host- demands Secure.
  assert.throws(
    () => assertValidCookieConfig({ name: "__Host-pcms_session", secure: false, sameSite: "Lax" }),
    CookieConfigError,
  );
  assert.doesNotThrow(() =>
    assertValidCookieConfig({ name: "pcms_session", secure: false, sameSite: "Lax" }),
  );
});
