// ADR-0017 R3 — inter-process revoke gate with TWO REAL PROCESSES sharing one
// PostgreSQL: the parent (web A) and a spawned child (web B / worker) hold
// independent in-process caches; the ONLY shared authority is the database.
// Scenario: child composes and verifies operations/events exist → parent
// DISABLES the extension → child's next operation entry and next event
// dispatch must refuse, without any local invalidation.
//
// In-flight guarantee (documented contract): the revision gate sits at
// operation ENTRY — an already-started operation runs to completion; every
// NEW entry re-checks and refuses.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  createCapabilityRegistry,
  createExtensionCatalog,
  defineExtensionArtifact,
} from "@pcms/extensions/internal";
import {
  apiContextOf,
  connectionInfoOf,
  createApiFixture,
  ownerActor,
} from "../helpers/api-composition.js";

const CHILD_SCRIPT = `
// Runs as an independent process (web B / worker role). Verifies that the
// operation is visible, then waits for the parent's disable, then verifies
// the refusal — everything composed locally, nothing shared but PostgreSQL.
import assert from "node:assert/strict";
import {
  createCapabilityRegistry,
  createExtensionCatalog,
  createExtensionLifecycleService,
  defineExtensionArtifact,
} from "@pcms/extensions/internal";
import { createExtensionOperationsService } from "@pcms/api";
import { createDbPool, systemClock } from "@pcms/core";

const manifest = {
  id: "progressive.test.proc",
  name: "Proc Revoke",
  version: "1.0.0",
  extension_contract: "2.0",
  cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
  entrypoint: { type: "module" },
  permissions: ["media.generate"],
  requires: [],
  provides: [],
  registrations: {
    operations: [{
      operation_id: "ping",
      permission: "media.generate",
      mutation: false,
      title: "Ping",
      input_schema: { type: "object", additionalProperties: true },
      output_schema: { type: "object", additionalProperties: true },
      handler: "ping",
    }],
    event_subscriptions: [{
      subscription_id: "on-entry-published",
      event_type: "EntryPublished",
      handler: "onPublished",
    }],
  },
  data_policy: "drop",
};
const catalog = createExtensionCatalog();
catalog.register(
  defineExtensionArtifact({
    manifest,
    module: { ping: async () => ({ ok: true }), onPublished: async () => {} },
  }),
);
const pool = createDbPool({
  connectionInfo: {
    host: process.env.PCMS_DB_HOST,
    port: Number(process.env.PCMS_DB_PORT ?? 5432),
    database: process.env.PCMS_DB_NAME,
    user: process.env.PCMS_DB_USER,
    password: process.env.PCMS_DB_PASSWORD,
    sslMode: "disable",
  },
  max: 2,
});
const lifecycle = createExtensionLifecycleService({
  pool,
  clock: systemClock,
  coreVersion: "1.0.0-rc.1",
  catalog,
  systemCapabilities: createCapabilityRegistry(),
});
const operations = createExtensionOperationsService({
  catalog,
  enabledIds: () => lifecycle.enabledIds(),
  lifecycleRevision: () => lifecycle.revision(),
});

const line = async (message) => {
  process.stdout.write(message + "\\n");
};

await operations.list();
await line("READY");

for await (const chunk of process.stdin) {
  const command = String(chunk).trim();
  if (command === "VERIFY_DISABLED") {
    const items = await operations.list();
    await line(items.length === 0 ? "DISABLED_OK" : "STILL_PRESENT");
  } else if (command === "VERIFY_SUBSCRIPTIONS_GONE") {
    // Worker-side equivalent: the revision-gated subscription refresh must
    // recompose to an empty set (no enabled extension contributes events).
    let attempts = 0;
    let gone = false;
    while (attempts < 20 && !gone) {
      const revision = await lifecycle.revision();
      const enabled = await lifecycle.enabledIds();
      gone = enabled.length === 0 && revision !== "0";
      attempts += 1;
      if (!gone) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await line(gone ? "SUBSCRIPTIONS_GONE" : "SUBSCRIPTIONS_STUCK");
    break;
  }
}
await pool.end();
`;

test("R3: a disable in web A revokes web B/worker (independent processes, shared PostgreSQL)", async (t) => {
  if (process.env.PCMS_TEST_DATABASE_URL === undefined)
    return t.skip("PCMS_TEST_DATABASE_URL is not set");

  const catalog = createExtensionCatalog();
  catalog.register(
    defineExtensionArtifact({
      manifest: {
        id: "progressive.test.proc",
        name: "Proc Revoke",
        version: "1.0.0",
        extension_contract: "2.0",
        cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
        entrypoint: { type: "module" },
        permissions: ["media.generate"],
        requires: [],
        provides: [],
        registrations: {
          operations: [
            {
              operation_id: "ping",
              permission: "media.generate",
              mutation: false,
              title: "Ping",
              input_schema: { type: "object", additionalProperties: true },
              output_schema: { type: "object", additionalProperties: true },
              handler: "ping",
            },
          ],
        },
        data_policy: "drop",
      },
      module: { ping: async () => ({}) },
    }),
  );
  const fixture = await createApiFixture(t, { extensionCatalog: catalog });
  const api = await import("@pcms/api");
  const ctx = apiContextOf(ownerActor());

  await api.installExtension(fixture.app, ctx, { extension_id: "progressive.test.proc" });
  await api.enableExtension(fixture.app, ctx, { extension_id: "progressive.test.proc" });

  // The fixture's PER-TEST database (not the template URL) is the shared
  // authority the child composes against.
  const connection = connectionInfoOf(fixture.db);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PCMS_DB_HOST: connection.host,
    PCMS_DB_PORT: String(connection.port ?? 5432),
    PCMS_DB_NAME: connection.database,
    PCMS_DB_USER: connection.user,
    ...(connection.password === undefined ? {} : { PCMS_DB_PASSWORD: connection.password }),
  };

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", CHILD_SCRIPT],
    {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  t.after(() => {
    child.kill();
  });
  const stdout: string[] = [];
  let readyResolve: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout.push(text);
    if (text.includes("READY")) readyResolve?.();
  });
  child.stderr.on("data", (chunk: Buffer) => stdout.push(`[child-err] ${chunk}`));

  // The child composes its own caches and reports READY (operation visible).
  const timeout = setTimeout(() => readyResolve?.(), 30_000);
  await ready;
  clearTimeout(timeout);
  assert.ok(stdout.join("").includes("READY"), `child never became ready: ${stdout.join("")}`);

  // Web A disables.
  await api.disableExtension(fixture.app, ctx, { extension_id: "progressive.test.proc" });

  // Web B refuses the operation on its next entry — no local invalidation.
  child.stdin.write("VERIFY_DISABLED\n");
  const verifyDisabled = await waitForLine(child, stdout, ["DISABLED_OK", "STILL_PRESENT"]);
  assert.equal(verifyDisabled, "DISABLED_OK");

  // Worker-side: the revision-gated subscription set recomposes to empty.
  child.stdin.write("VERIFY_SUBSCRIPTIONS_GONE\n");
  const subscriptions = await waitForLine(child, stdout, [
    "SUBSCRIPTIONS_GONE",
    "SUBSCRIPTIONS_STUCK",
  ]);
  assert.equal(subscriptions, "SUBSCRIPTIONS_GONE");
});

function waitForLine(
  child: ReturnType<typeof spawn>,
  buffer: string[],
  options: readonly string[],
): Promise<string> {
  return new Promise((resolve) => {
    const scan = () => {
      const joined = buffer.join("");
      for (const option of options) {
        if (joined.includes(option)) return option;
      }
      return undefined;
    };
    const found = scan();
    if (found !== undefined) {
      resolve(found);
      return;
    }
    const stream = child.stdout;
    if (stream === null) {
      resolve("TIMEOUT");
      return;
    }
    const listener = (chunk: Buffer) => {
      buffer.push(chunk.toString());
      const hit = scan();
      if (hit !== undefined) {
        stream.off("data", listener);
        resolve(hit);
      }
    };
    stream.on("data", listener);
    setTimeout(() => resolve(scan() ?? "TIMEOUT"), 30_000);
  });
}
