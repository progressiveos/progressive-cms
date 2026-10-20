import assert from "node:assert/strict";
import { test } from "node:test";
import type { DbClient, DbPool } from "@pcms/core";
import type { ApplicationServices } from "../../packages/api/src/context.js";
import { buildExtensionCallContext } from "../../packages/api/src/extension-platform.js";

test("extension platform: API audit preserves the supplied subject", async () => {
  const writes: Array<{ readonly sql: string; readonly params: readonly unknown[] | undefined }> =
    [];
  const client = {
    query: async <T extends Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
      writes.push({ sql, params });
      return { rows: [] as T[] };
    },
  } as unknown as DbClient;
  const pool = {
    query: async <T extends Record<string, unknown>>() => ({ rows: [] as T[] }),
    withTransaction: async <R>(run: (tx: DbClient) => Promise<R>) => run(client),
  } as unknown as DbPool;
  const context = await buildExtensionCallContext(
    {
      defaultSiteKey: "default",
      pool,
      routes: { ensureSite: async () => ({ key: "default", defaultLocale: "en" }) },
    } as unknown as ApplicationServices,
    null,
    { extensionId: "progressive.platform-fixture", config: null },
    { guestId: "guest-1" },
  );

  await context.platform.transaction(async (tx) => {
    tx.audit("PLATFORM_FIXTURE_NOTE_CREATED", { type: "extension_entity", id: "note-1" });
  });

  const auditWrite = writes.find(({ sql }) => sql.includes("INSERT INTO auth_security_events"));
  assert.ok(auditWrite, "transaction writes the audit event");
  assert.equal(auditWrite.params?.[2], "GUEST");
  assert.equal(auditWrite.params?.[4], "extension_entity");
  assert.equal(auditWrite.params?.[5], "note-1");
});

// Public void hooks must finish before commit, including non-SQL failures.
for (const writer of ["audit", "outbox"] as const) {
  test(`extension transaction awaits delayed ${writer} and rejects pre-SQL failure`, async () => {
    const { createExtensionPlatformServices } = await import("@pcms/extensions/internal");
    const order: string[] = [];
    let fail = false;
    const write = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(writer);
      if (fail) throw new Error("serialization failed");
    };
    const platform = createExtensionPlatformServices({
      pool: {
        query: clientQuery,
        withTransaction: async (run) => {
          try {
            const result = await run({ query: clientQuery } as DbClient);
            order.push("commit");
            return result;
          } catch (error) {
            order.push("rollback");
            throw error;
          }
        },
      },
      authorize: async () => {},
      actor: { kind: "actor", id: "owner", type: "user" },
      requestId: "request",
      extensionId: "example.catalog",
      auditWriter: write,
      outboxAppender: write,
    });
    const run = () =>
      platform.transaction(async (tx) => {
        if (writer === "audit") tx.audit("Changed", { type: "item", id: "1" });
        else tx.outbox.append("example.catalog/Changed", { id: "1" });
      });
    await run();
    assert.deepEqual(order, [writer, "commit"]);
    order.length = 0;
    fail = true;
    await assert.rejects(run, /serialization failed/);
    assert.deepEqual(order, [writer, "rollback"]);
  });
}

async function clientQuery<T extends Record<string, unknown>>() {
  return { rows: [] as T[], rowCount: 0 };
}
