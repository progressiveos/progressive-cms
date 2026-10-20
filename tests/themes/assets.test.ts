// Asset manifest/build pipeline tests (PCMS-THEME-T017).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { detectAdminLeakage, hashAsset, MAX_ASSET_BYTES, planAssetBuild } from "@pcms/themes";

function makeTheme(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pcms-assets-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test("fingerprinted production outputs are deterministic content hashes", () => {
  const dir = makeTheme({
    "assets/css/theme.css": "body{--x:1}",
    "assets/js/theme.js": "console.log('a')",
  });
  const plan = planAssetBuild(dir, {
    css: ["assets/css/theme.css"],
    js: ["assets/js/theme.js"],
    fingerprint: true,
  });
  assert.deepEqual(plan.issues, []);
  const hash = hashAsset("body{--x:1}");
  assert.deepEqual(
    plan.outputs.map((o) => [o.source, o.output]),
    [
      ["assets/css/theme.css", `assets/css/theme.${hash}.css`],
      ["assets/js/theme.js", `assets/js/theme.${hashAsset("console.log('a')")}.js`],
    ],
  );
  // Same content → same output name; different content → different name.
  const plan2 = planAssetBuild(dir, { css: ["assets/css/theme.css"], fingerprint: true });
  assert.equal(plan2.outputs[0]?.hash, plan.outputs[0]?.hash);
});

test("without fingerprint, outputs keep their source names", () => {
  const dir = makeTheme({ "assets/css/theme.css": "body{}" });
  const plan = planAssetBuild(dir, { css: ["assets/css/theme.css"] });
  assert.deepEqual(
    plan.outputs.map((o) => o.output),
    ["assets/css/theme.css"],
  );
});

test("missing, oversized and undeclared-root assets are reported", () => {
  const dir = makeTheme({ "assets/css/theme.css": "body{}" });
  const plan = planAssetBuild(dir, {
    css: ["assets/css/theme.css", "assets/css/missing.css", "templates/evil.css"],
    js: [`assets/js/big.js`],
  });
  // big.js wasn't written: missing; templates/evil.css: outside assets/
  assert.equal(plan.outputs.length, 1);
  assert.deepEqual(plan.issues.map((i) => i.code).sort(), [
    "THEME_ASSET_MISSING",
    "THEME_ASSET_MISSING",
    "THEME_ASSET_MISSING",
  ]);
  const evil = plan.issues.find((i) => i.path === "templates/evil.css");
  assert.match(evil?.message ?? "", /outside assets/);
  const bigDir = makeTheme({ "assets/js/big.js": "x".repeat(MAX_ASSET_BYTES + 1) });
  const bigPlan = planAssetBuild(bigDir, { js: ["assets/js/big.js"] });
  assert.deepEqual(
    bigPlan.issues.map((i) => i.code),
    ["THEME_ASSET_TOO_LARGE"],
  );
});

test("public assets referencing the Admin bundle fail the build (§32)", () => {
  assert.equal(detectAdminLeakage("assets/js/theme.js", "import '@pcms/admin';"), true);
  assert.equal(
    detectAdminLeakage("assets/css/theme.css", "@import url('pcms-admin/design.css');"),
    true,
  );
  assert.equal(detectAdminLeakage("assets/js/theme.js", "document.querySelector('.nav')"), false);
  assert.equal(detectAdminLeakage("assets/img/logo.svg", "<svg/>"), false);

  const dir = makeTheme({ "assets/js/leak.js": "import '@pcms/admin/setup';" });
  const plan = planAssetBuild(dir, { js: ["assets/js/leak.js"] });
  assert.deepEqual(
    plan.issues.map((i) => i.code),
    ["THEME_ASSET_ADMIN_LEAKAGE"],
  );
  assert.deepEqual(plan.outputs, []);
});
