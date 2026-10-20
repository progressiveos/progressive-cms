// Generates frozen contract baselines for the M14 unified contract-diff
// gate (PCMS-EXT-T016). Baselines are machine-generated snapshots of the
// canonical registries at an accepted release point:
//   node --import tsx scripts/generate-contract-baselines.mjs
// A breaking change must never be regenerated into the baseline silently —
// tests/extensions/contract-diff.test.ts fails on removals/narrowings, and
// an approved additive change is the only reason to re-run this script.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const evalTs = (program) =>
  execFileSync(process.execPath, ["--import", "tsx", "--eval", program], {
    encoding: "utf8",
  });

mkdirSync("fixtures/extensions/contract-baselines", { recursive: true });

const permissions = evalTs(`
  const auth = await import("@pcms/auth");
  process.stdout.write(JSON.stringify({ permissions: auth.PERMISSION_REGISTRY }, null, 2));
`);
writeFileSync("fixtures/extensions/contract-baselines/permissions-v1.json", permissions);

const configSchema = evalTs(`
  const core = await import("@pcms/core");
  process.stdout.write(JSON.stringify({ config_schema: core.CONFIG_SCHEMA }, null, 2));
`);
writeFileSync("fixtures/extensions/contract-baselines/config-schema-v1.json", configSchema);

console.log("contract baselines written: permissions-v1.json, config-schema-v1.json");
