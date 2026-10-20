// PCMS-AUTH-T009 — CSRF protection: session-bound synchronizer tokens for
// cookie-authenticated mutations (Auth spec §30).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AuthError,
  assertCsrfToken,
  assertSameOrigin,
  createSessionService,
  createUserIdentityService,
  hashCsrfToken,
  newCsrfToken,
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

test("missing, wrong, and foreign-session CSRF tokens are rejected; matching passes", () => {
  const token = newCsrfToken();
  const hash = hashCsrfToken(token);

  assert.throws(
    () => assertCsrfToken(hash, undefined),
    (err: AuthError) => err.code === "AUTH_CSRF_TOKEN_MISSING" && err.status === 403,
  );
  assert.throws(
    () => assertCsrfToken(hash, ""),
    (err: AuthError) => err.code === "AUTH_CSRF_TOKEN_MISSING",
  );
  assert.throws(
    () => assertCsrfToken(hash, "attacker-guess"),
    (err: AuthError) => err.code === "AUTH_CSRF_TOKEN_INVALID",
  );
  assert.throws(
    () => assertCsrfToken(null, token),
    (err: AuthError) => err.code === "AUTH_CSRF_TOKEN_INVALID",
  );
  assert.doesNotThrow(() => assertCsrfToken(hash, token));
});

test("each session gets its own token; rotation retires the old one", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const users = createUserIdentityService(pool);
  const sessions = createSessionService(pool);
  const user = await users.createUser({ displayName: "C", email: "csrf@example.com" });

  const created = await sessions.createSession(user.id, {});
  assert.ok(created.csrfToken.length >= 32);
  const resolved = await sessions.resolveSession(created.rawToken);
  assert.equal(resolved?.csrfHash, hashCsrfToken(created.csrfToken));
  assert.doesNotThrow(() => assertCsrfToken(resolved?.csrfHash ?? null, created.csrfToken));

  // A different session's token never validates against this session.
  const other = await sessions.createSession(user.id, {});
  assert.throws(
    () => assertCsrfToken(resolved?.csrfHash ?? null, other.csrfToken),
    (err: AuthError) => err.code === "AUTH_CSRF_TOKEN_INVALID",
  );

  // Rotation: the fresh session carries a new CSRF context.
  const rotated = await sessions.rotateSession(created.rawToken);
  assert.notEqual(rotated.csrfToken, created.csrfToken);
  const rotatedResolved = await sessions.resolveSession(rotated.rawToken);
  assert.doesNotThrow(() => assertCsrfToken(rotatedResolved?.csrfHash ?? null, rotated.csrfToken));
});

test("origin check rejects cross-site Origins and passes same-site/absent", () => {
  assert.doesNotThrow(() =>
    assertSameOrigin("https://admin.example.com", "https://admin.example.com"),
  );
  assert.doesNotThrow(() =>
    assertSameOrigin("https://admin.example.com/", "https://admin.example.com"),
  );
  assert.doesNotThrow(() => assertSameOrigin(undefined, "https://admin.example.com"));
  assert.doesNotThrow(() => assertSameOrigin("https://any.example.com", undefined));
  assert.throws(
    () => assertSameOrigin("https://evil.example", "https://admin.example.com"),
    (err: AuthError) => err.code === "AUTH_CSRF_TOKEN_INVALID",
  );
});

test("DB-backed: the csrf_hash column never contains the raw token", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const users = createUserIdentityService(pool);
  const sessions = createSessionService(pool);
  const user = await users.createUser({ displayName: "S", email: "hash@example.com" });
  const { csrfToken } = await sessions.createSession(user.id, {});
  const stored = await pool.query<{ csrf_hash: string }>(
    "SELECT csrf_hash FROM auth_sessions WHERE csrf_hash IS NOT NULL LIMIT 1",
  );
  assert.equal(stored.rows[0]?.csrf_hash, hashCsrfToken(csrfToken));
  assert.notEqual(stored.rows[0]?.csrf_hash, csrfToken);
});
