// PCMS-OPS-T003 — PostgreSQL dev/integration environment smoke test:
// base reachable → disposable database created → usable → dropped.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertBaseReachable,
  createTestDatabase,
  dropTestDatabase,
  runPsql,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

test("disposable database lifecycle: create → query → drop", (t) => {
  if (!testDatabaseConfigured()) {
    t.skip("PCMS_TEST_DATABASE_URL is not set — no PostgreSQL integration on this machine");
    return;
  }
  assertBaseReachable();
  const db = createTestDatabase(t);
  return db.then((database) => {
    // The disposable database exists and executes queries (via psql here;
    // the JS driver stack is exercised from PCMS-OPS-T004 onward).
    const out = runPsql(
      {
        host: database.connection.host,
        port: String(database.connection.port),
        user: database.connection.user,
        password: database.connection.password,
        database: database.connection.database,
      },
      database.name,
      "SELECT current_database()",
    );
    assert.match(out, new RegExp(database.name));

    // Explicit drop works and is verified.
    dropTestDatabase(database);
    assert.throws(() => {
      runPsql(
        {
          host: database.connection.host,
          port: String(database.connection.port),
          user: database.connection.user,
          password: database.connection.password,
          database: database.connection.database,
        },
        database.name,
        "SELECT 1",
      );
    });
  });
});
