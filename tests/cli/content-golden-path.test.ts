// Site-developer report 2026-10-02 (Core 0.1.146): the content golden path
// was unusable from the CLI — `cms content draft --entry <id> …` exited
// INTERNAL_ERROR "unexpected argument" because the common
// `const [subcommand, operand, ...rest]` destructure ate the first named
// flag as a positional operand in the five branches that have none
// (create/draft/patch/seal/preview). Regression: the documented flag syntax
// parses end-to-end against a real API (create → draft (+ --from-revision) →
// patch → seal → preview, with the global --json variation), and input
// errors stay usage/input errors (exit 2), never INTERNAL_ERROR.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiFastify, createApiV1, makeDiscoveryRoutes, makeMutationRoutes } from "@pcms/api";
import { runCli } from "@pcms/cli";
import type { FastifyInstance } from "fastify";
import { createApiFixture } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

test("content golden path: documented flag syntax parses against a real API", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [
      {
        key: "page",
        version: 1,
        title: "Page",
        bodyPolicy: "block_document",
        fields: {
          title: { id: "title", type: "string", required: true, sortable: true },
        },
      },
    ],
  });
  const fastify: FastifyInstance = createApiFastify(() => "req_cli_content");
  await fastify.register(createApiV1([...makeDiscoveryRoutes(), ...makeMutationRoutes()]), {
    application: app,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    cookieSecure: false,
  });
  await fastify.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => {
    void fastify.close();
  });
  const address = fastify.server.address();
  assert.ok(address !== null && typeof address === "object");
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: (
      await app.machineIdentity.createServiceAccount({
        name: "cli-content",
        purpose: "golden path parser regression",
        allowedScopes: [
          "content.read",
          "content.create",
          "content.edit",
          "preview.create",
          "revision.seal",
        ],
      })
    ).id,
    scopes: ["content.read", "content.create", "content.edit", "preview.create", "revision.seal"],
    ttlMilliseconds: 3_600_000,
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PCMS_API_URL: `http://127.0.0.1:${address.port}`,
    PCMS_API_TOKEN: token.rawSecret,
    PCMS_SITE_KEY: "default",
    PCMS_ENVIRONMENT: "dev",
  };
  const { contentCommand: command } = await import("../../packages/cli/src/commands/content.js");
  type CommandResult = Awaited<ReturnType<typeof command>>;
  const run = (args: string[], json: boolean): Promise<CommandResult> =>
    command({ args, options: { json, yes: false }, env, cwd: process.cwd() });

  // Framework-level end-to-end: the real dispatcher strips the GLOBAL --json
  // (it may follow the subcommand) and the golden path parses the rest.
  const savedContext = [process.env.PCMS_SITE_KEY, process.env.PCMS_ENVIRONMENT];
  process.env.PCMS_SITE_KEY = "default";
  process.env.PCMS_ENVIRONMENT = "dev";
  const savedUrl = process.env["PCMS_API_URL"];
  const savedToken = process.env["PCMS_API_TOKEN"];
  process.env["PCMS_API_URL"] = env["PCMS_API_URL"];
  process.env["PCMS_API_TOKEN"] = token.rawSecret;
  t.after(() => {
    for (const [i, key] of ["PCMS_SITE_KEY", "PCMS_ENVIRONMENT"].entries()) {
      if (savedContext[i] === undefined) delete process.env[key];
      else process.env[key] = savedContext[i];
    }
    if (savedUrl === undefined) delete process.env["PCMS_API_URL"];
    else process.env["PCMS_API_URL"] = savedUrl;
    if (savedToken === undefined) delete process.env["PCMS_API_TOKEN"];
    else process.env["PCMS_API_TOKEN"] = savedToken;
  });

  const dir = mkdtempSync(join(tmpdir(), "pcms-cli-content-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const payloadPath = join(dir, "payload.json");
  writeFileSync(
    payloadPath,
    JSON.stringify({
      content_type: "page",
      payload: { fields: { title: "CLI-страница" }, blocks: { schema_version: 1, blocks: [] } },
    }),
  );

  // create --file: the first flag used to be eaten as the operand.
  const created = await run(["create", "--file", payloadPath], true);
  assert.equal(created.exitCode, 0, created.stderr || created.stdout);
  const createdBody = JSON.parse(created.stdout) as { entry_id: string; revision_id: string };
  const entryId = createdBody.entry_id;

  // --from-revision is a branch from immutable history, so seal the initial
  // revision before using it as the source of a new working draft.
  const sourceSealed = await command({
    args: ["seal", "--revision", createdBody.revision_id],
    options: { json: true, yes: true, environment: "prod" },
    env,
    cwd: process.cwd(),
  });
  assert.equal(sourceSealed.exitCode, 0, sourceSealed.stderr || sourceSealed.stdout);

  // The exact reported repro shape: draft --entry <id> --json (global flag
  // after the subcommand), then the documented --from-revision variation.
  const opened = await run(["draft", "--entry", entryId], true);
  assert.equal(opened.exitCode, 0, opened.stderr || opened.stdout);
  const openedBody = JSON.parse(opened.stdout) as { revision_id: string };
  assert.ok(openedBody.revision_id.length > 10);

  // The exact reported repro, through runCli: global --json AFTER the
  // subcommand. (Needs an entry that exists — run after `create`.)
  void runCli;

  const reopened = await run(
    ["draft", "--entry", entryId, "--from-revision", createdBody.revision_id],
    true,
  );
  assert.equal(reopened.exitCode, 0, reopened.stderr || reopened.stdout);

  // patch --revision --file --expected-generation (CAS gate stays server-side).
  const patched = await run(
    [
      "patch",
      "--revision",
      openedBody.revision_id,
      "--file",
      payloadPath,
      "--expected-generation",
      "0",
    ],
    true,
  );
  assert.equal(patched.exitCode, 0, patched.stderr || patched.stdout);

  // seal needs the target-safety confirmation (global --environment/--yes).
  const sealed = await command({
    args: ["seal", "--revision", openedBody.revision_id],
    options: { json: true, yes: true, environment: "prod" },
    env,
    cwd: process.cwd(),
  });
  assert.equal(sealed.exitCode, 0, sealed.stderr || sealed.stdout);
  const sealedBody = JSON.parse(sealed.stdout) as { payload_hash: string };
  assert.ok(sealedBody.payload_hash.length > 10);

  // preview --entity-id --revision --allow-draft.
  const previewed = await run(
    ["preview", "--entity-id", entryId, "--revision", openedBody.revision_id, "--allow-draft"],
    true,
  );
  assert.equal(previewed.exitCode, 0, previewed.stderr || previewed.stdout);
  // The mint response is {preview_url, token} — the signed reference is the token.
  const previewBody = JSON.parse(previewed.stdout) as { token?: string };
  assert.ok((previewBody.token ?? "").length > 10, previewed.stdout);

  // Human (non-JSON) variation still parses.
  const human = await run(["draft", "--entry", entryId], false);
  assert.equal(human.exitCode, 0, human.stderr);

  // The reported command shape end-to-end through the real dispatcher:
  // `cms content draft --entry <id> --json` (was INTERNAL_ERROR).
  const viaDispatcher = await runCli(["content", "draft", "--entry", entryId, "--json"]);
  assert.equal(viaDispatcher.exitCode, 0, viaDispatcher.stderr || viaDispatcher.stdout);
  const dispatcherBody = JSON.parse(viaDispatcher.stdout) as { revision_id?: string };
  assert.ok((dispatcherBody.revision_id ?? "").length > 10, viaDispatcher.stdout);

  // Input errors remain usage/input: missing flag value, unknown flag —
  // exit 2 with usage on stderr, never INTERNAL_ERROR (was the defect).
  for (const bad of [
    ["draft", "--entry"],
    ["draft", "--bogus", "x"],
    ["patch", "--revision", openedBody.revision_id],
  ] as const) {
    const failed = await run([...bad], true);
    assert.equal(failed.exitCode, 2, `${bad.join(" ")}: ${failed.stderr}`);
    // CLI convention: usage/input errors print on stderr (with a usage line),
    // never the machine INTERNAL_ERROR envelope.
    assert.ok(failed.stderr.includes("usage:"), failed.stderr);
    assert.equal(failed.stderr.includes("INTERNAL_ERROR"), false, failed.stderr);
    assert.equal(failed.stdout.includes("INTERNAL_ERROR"), false, failed.stdout);
  }
});
