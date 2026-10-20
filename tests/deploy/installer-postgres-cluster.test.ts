import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const installer = readFileSync("deploy/scripts/install-release.sh", "utf8");
const selector = installer.match(/^select_pg_cluster\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(selector);

function select(port: number, clusters: string) {
  return spawnSync(
    "bash",
    [
      "-c",
      [
        'die() { printf "%s\\n" "$*" >&2; exit 1; }',
        'pg_lsclusters() { printf "%s\\n" "$QA_CLUSTERS"; }',
        'eval "$1"; select_pg_cluster "$2"',
      ].join("\n"),
      "test",
      selector as string,
      String(port),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, QA_CLUSTERS: clusters },
    },
  );
}

test("installer selects the actual PostgreSQL cluster on the requested port", () => {
  const clusters =
    "16 rc12qa 5433 online postgres /data/16 /log/16\n18 main 5432 online postgres /data/18 /log/18";
  for (const [port, expected] of [
    [5432, "18 main\n"],
    [5433, "16 rc12qa\n"],
  ] as const) {
    const result = select(port, clusters);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
});

test("installer refuses missing or ambiguous PostgreSQL clusters", () => {
  for (const clusters of [
    "",
    "16 first 5432 down postgres /data/16 /log/16\n18 main 5432 online postgres /data/18 /log/18",
  ]) {
    const result = select(5432, clusters);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected one cluster on port 5432/);
  }
});
