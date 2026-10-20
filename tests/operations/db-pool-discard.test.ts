import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createDbPool } from "@pcms/core";

test("discarded leased session is destroyed and cannot leak an advisory lock to the pool", {
  skip: !process.env.PCMS_TEST_DATABASE_URL,
}, async (t) => {
  const url = new URL(process.env.PCMS_TEST_DATABASE_URL ?? "");
  const pool = createDbPool({
    max: 1,
    connectionInfo: {
      host: url.hostname,
      port: Number(url.port || 5432),
      database: decodeURIComponent(url.pathname.slice(1)),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      sslMode: "disable",
    },
  });
  t.after(() => pool.end());
  const key = `pcms:test:discard:${randomUUID()}`;
  let previousPid: unknown;
  await pool.withClient(async (db) => {
    previousPid = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    await db.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
    assert.equal(typeof db.discard, "function");
    db.discard?.(new Error("cleanup failed"));
  });
  let nextPid: unknown;
  await pool.withClient(async (db) => {
    nextPid = (await db.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    assert.notEqual(nextPid, previousPid);
    assert.equal(
      (await db.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [key])).rows[0]
        ?.locked,
      true,
    );
    await db.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
  });
  await pool.withClient(async (db) =>
    assert.equal((await db.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid, nextPid),
  );
});
