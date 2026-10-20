// PCMS-AUTH-T025 — security audit events: actor/action structured records,
// OPERATOR transport marks, and the no-secrets guarantee.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMachineIdentityService,
  createSessionService,
  createUserIdentityService,
  operatorActor,
  recordSecurityEvent,
  type SecurityEvent,
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

const HOSTILE_METADATA = {
  password: "super-secret-password-15",
  totpCode: "123456",
  recoveryCode: "abcd-ef01-2345-6789",
  rawToken: "pcms_ab12cd34_secretsecretsecret",
  cookie: "__Host-pcms_session=stealme",
  fine: "reason code only",
};

async function withEvents(
  t: { after: (fn: () => void) => void },
  run: (pool: DbPool) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  await run(pool);
}

test("hostile secret-shaped metadata is redacted before storage and sink", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withEvents(t, async (pool) => {
    const seen: SecurityEvent[] = [];
    await recordSecurityEvent(
      pool,
      (event) => {
        seen.push(event);
      },
      {
        type: "LOGIN_FAILURE",
        actorType: "USER",
        actorId: null,
        subjectType: "user",
        metadata: HOSTILE_METADATA,
      },
    );

    const stored = await pool.query<{ metadata: unknown }>(
      "SELECT metadata FROM auth_security_events WHERE event_type = 'LOGIN_FAILURE'",
    );
    const storedText = JSON.stringify(stored.rows[0]?.metadata ?? "");
    for (const secret of [
      HOSTILE_METADATA.password,
      HOSTILE_METADATA.totpCode,
      HOSTILE_METADATA.recoveryCode,
      HOSTILE_METADATA.rawToken,
    ]) {
      assert.equal(storedText.includes(secret), false);
    }
    assert.ok(storedText.includes("fine"));
    // The sink saw the same redacted view.
    assert.equal(seen.length, 1);
    const sinkMetadata = seen[0]?.metadata as Record<string, unknown>;
    assert.notEqual(sinkMetadata.password, HOSTILE_METADATA.password);
    assert.equal(sinkMetadata.fine, "reason code only");
  });
});

test("operator actions record the OPERATOR actor class and transport", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withEvents(t, async (pool) => {
    await recordSecurityEvent(pool, null, {
      type: "PASSWORD_RESET",
      actorType: "OPERATOR",
      actorId: "operator:cli",
      subjectType: "user",
      subjectId: "u-123",
      transport: "operator",
      metadata: { reason: "local_operator_recovery" },
    });
    const rows = await pool.query<{
      actor_type: string;
      transport: string | null;
      event_type: string;
    }>(
      "SELECT actor_type, transport, event_type FROM auth_security_events ORDER BY created_at DESC LIMIT 1",
    );
    const row = rows.rows[0]!;
    assert.equal(row.actor_type, "OPERATOR");
    assert.equal(row.transport, "operator");
    assert.equal(row.event_type, "PASSWORD_RESET");
    void operatorActor;
  });
});

test("lifecycle services emit the events they promise (session revoke, token revoke)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withEvents(t, async (pool) => {
    const users = createUserIdentityService(pool);
    const user = await users.createUser({ displayName: "E", email: "events@example.com" });
    const sessions = createSessionService(pool);
    const { sessionId } = await sessions.createSession(user.id, {});
    await sessions.revokeSession(sessionId, "logout");

    const machines = createMachineIdentityService(pool);
    const account = await machines.createServiceAccount({ name: "ev", purpose: "test" });
    const { token } = await machines.createAccessToken({
      serviceAccountId: account.id,
      scopes: ["content.read"],
      ttlMilliseconds: 60_000,
    });
    await machines.revokeAccessToken(token.id, "test");

    const types = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM auth_security_events WHERE event_type IN ('SESSION_REVOKED','TOKEN_CREATED','TOKEN_REVOKED') ORDER BY event_type",
    );
    assert.deepEqual(
      types.rows.map((r) => r.event_type),
      ["SESSION_REVOKED", "TOKEN_CREATED", "TOKEN_REVOKED"],
    );
  });
});
