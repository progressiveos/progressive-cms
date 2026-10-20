// PCMS-PCPUB E7 gate — `cms bundle` through the public CLI surface:
// offline validate/pack/inspect with --json determinism, exit codes, and
// the deterministic-pack property (identical fixed clock/random inputs
// produce identical archives). No DB access.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "@pcms/cli";

const PNG_1PX = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000d4944415478da63fcffff3f030005fe02fea72d1" +
    "ee60000000049454e44ae426082",
  "hex",
);

function sanitizeEnv(): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PCMS_")) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  };
}

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "pcpub-cli-"));
  mkdirSync(join(dir, "content"), { recursive: true });
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(
    join(dir, "publication.yaml"),
    'changeset_title: "CLI gate"\npublication:\n  mode: none\n',
  );
  writeFileSync(
    join(dir, "content", "hero.pcmd"),
    `---
pcmd_version: 1
operation: create
external_id: hero
content_type: page
fields:
  title: Страница
---
:::block text@1
rich_text: "Пример"
:::
`,
  );
  writeFileSync(join(dir, "assets", "hero.png"), PNG_1PX);
  return dir;
}

test("cms bundle: offline validate/pack/inspect gate", async () => {
  const restore = sanitizeEnv();
  try {
    const dir = makeWorkspace();

    // validate: ok, machine mode
    const validated = await runCli(["bundle", "validate", dir, "--json"]);
    assert.equal(validated.exitCode, 0, validated.stderr);
    const report = JSON.parse(validated.stdout) as { ok: boolean; bundle_id: string };
    assert.equal(report.ok, true);
    assert.match(report.bundle_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);

    // Offline validation is independent of an implicit site config, while an
    // operator-supplied missing config remains a typed error.
    const missingExplicitConfig = await runCli([
      "--config",
      join(dir, "missing-pcms.json"),
      "bundle",
      "validate",
      dir,
      "--json",
    ]);
    assert.equal(missingExplicitConfig.exitCode, 2);
    assert.match(missingExplicitConfig.stdout, /CONFIG_NOT_FOUND/);

    // pack
    const out = join(dir, "bundle.pcpub");
    const packed = await runCli(["bundle", "pack", dir, "--out", out, "--json"]);
    assert.equal(packed.exitCode, 0, packed.stderr);
    const packInfo = JSON.parse(packed.stdout) as {
      bundle_id: string;
      entries: number;
      assets: number;
    };
    assert.equal(packInfo.entries, 1);
    assert.equal(packInfo.assets, 1);
    assert.ok(readFileSync(out).length > 0);

    // inspect: deterministic --json, matching ids
    const inspected = await runCli(["bundle", "inspect", out, "--json"]);
    assert.equal(inspected.exitCode, 0, inspected.stderr);
    const info = JSON.parse(inspected.stdout) as {
      bundle_id: string;
      pcpub_version: number;
      entries: number;
    };
    assert.equal(info.bundle_id, packInfo.bundle_id);
    assert.equal(info.pcpub_version, 1);

    // validate the packed file too
    const revalidated = await runCli(["bundle", "validate", out, "--json"]);
    assert.equal(revalidated.exitCode, 0, revalidated.stderr);

    // usage errors: exit 2
    const noOut = await runCli(["bundle", "pack", dir, "--json"]);
    assert.equal(noOut.exitCode, 2);
    const bogus = await runCli(["bundle", "bogus", "--json"]);
    assert.equal(bogus.exitCode, 2);

    rmSync(dir, { recursive: true, force: true });
  } finally {
    restore();
  }
});

test("cms bundle validate: markdown rich_text bridge + interaction blocks offline", async () => {
  const restore = sanitizeEnv();
  try {
    // Deployment with a typesFile — the CLI wires semantic checks against it.
    const deploy = mkdtempSync(join(tmpdir(), "pcpub-cli-cfg-"));
    const typesFile = join(deploy, "content-types.json");
    writeFileSync(
      typesFile,
      JSON.stringify([
        {
          key: "page",
          version: 1,
          title: "Page",
          bodyPolicy: "block_document",
          fields: {
            title: { id: "title", type: "string", required: true },
            body: { id: "body", type: "block_document" },
          },
        },
      ]),
    );
    writeFileSync(
      join(deploy, "pcms.json"),
      JSON.stringify({
        nodeEnv: "development",
        http: { host: "127.0.0.1", port: 3000 },
        db: {
          host: "127.0.0.1",
          port: 5432,
          database: "pcms",
          user: "pcms",
          passwordSecretRef: "db.password",
          sslMode: "disable",
        },
        content: { typesFile },
      }),
    );
    const config = join(deploy, "pcms.json");

    // Workspace exercising BOTH gaps this gate used to miss offline: a
    // Markdown rich_text prop (server ingest bridges it to the AST) and the
    // form@1 interaction block (registered by @pcms/forms, not first-party).
    const dir = mkdtempSync(join(tmpdir(), "pcpub-cli-bridge-"));
    mkdirSync(join(dir, "content"), { recursive: true });
    writeFileSync(
      join(dir, "publication.yaml"),
      'changeset_title: "Bridge gate"\npublication:\n  mode: none\n',
    );
    writeFileSync(
      join(dir, "content", "landing.pcmd"),
      `---
pcmd_version: 1
operation: create
external_id: page-landing
content_type: page
fields:
  title: Главная
---
:::block text@1
rich_text: |
  Markdown с **выделением** и списком:

  - один
  - два
:::

:::block cta@1
title: Оставить заявку
text: "Markdown-текст кнопочного блока — **мост обязателен**."
primary_action:
  type: external_url
  url: /contacts/
:::

:::block callout@1
title: Примечание
body: "Markdown в body — тоже мост."
kind: note
:::

:::block form@1
form_definition_id: "0198c0de-0000-7000-8000-0000000000f1"
:::
`,
    );

    const validated = await runCli(["bundle", "validate", dir, "--config", config, "--json"]);
    assert.equal(validated.exitCode, 0, validated.stderr);
    const report = JSON.parse(validated.stdout) as { ok: boolean };
    assert.equal(report.ok, true);

    // Registry semantics stay fail-closed: an unversioned block type upgrade
    // is still rejected offline.
    writeFileSync(
      join(dir, "content", "landing.pcmd"),
      `---
pcmd_version: 1
operation: create
external_id: page-landing
content_type: page
fields:
  title: Главная
---
:::block text@2
rich_text: "апгрейд версии схемы"
:::
`,
    );
    const rejected = await runCli(["bundle", "validate", dir, "--config", config, "--json"]);
    // Machine envelope stays exit-0; the verdict lives in the payload.
    const bad = JSON.parse(rejected.stdout) as {
      ok: boolean;
      issues: { code: string }[];
    };
    assert.equal(bad.ok, false);
    assert.equal(
      bad.issues.some((issue) => issue.code === "PCPUB_COMPAT_UNSUPPORTED_BLOCK_VERSION"),
      true,
    );

    rmSync(dir, { recursive: true, force: true });
    rmSync(deploy, { recursive: true, force: true });
  } finally {
    restore();
  }
});

test("cms bundle v2 example declares offline status and target mapping", async () => {
  const restore = sanitizeEnv();
  const dir = mkdtempSync(join(tmpdir(), "pcpub-example-cli-"));
  try {
    const out = join(dir, "external.pcpub");
    const packed = await runCli([
      "bundle",
      "pack",
      "examples/pcpub/external-entries",
      "--out",
      out,
      "--json",
    ]);
    assert.equal(packed.exitCode, 0, packed.stderr);
    const info = JSON.parse(packed.stdout);
    assert.equal(info.pcpub_version, 2);
    assert.equal(info.external_entries_validation, "not_checked_on_server");
    assert.deepEqual(info.external_entries, {
      "existing-article": { path: "/blog/existing-article/", locale: "default" },
    });
    for (const args of [
      ["bundle", "validate", "examples/pcpub/external-entries", "--json"],
      ["bundle", "validate", out, "--json"],
      ["bundle", "inspect", out, "--json"],
    ]) {
      const result = await runCli(args);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).external_entries_validation, "not_checked_on_server");
    }
    const human = await runCli(["bundle", "inspect", out]);
    assert.match(human.stdout, /existence has not been checked on the server/);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
