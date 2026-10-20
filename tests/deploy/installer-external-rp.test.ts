// Incident 152fz.p-os.ru (2026-10-09) — external-rp bootstrap P0 gates.
// The quiet installer MUST refuse `--profile external-rp` without an explicit
// `--trusted-proxy-edge` BEFORE any side effect (root check, apt, config
// render), and must never trust-everyone. Runs the real pinned script.
import assert from "node:assert/strict";
import { execFile, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const INSTALLER = path.resolve("deploy/scripts/install-release.sh");
const CONFIG_TEMPLATE = path.resolve("deploy/sites/pcms.production.template.json");

/** Runs the installer with the ambient systemd INVOCATION_ID stripped —
 * otherwise the script takes the orchestrated branch and never reaches the
 * bootstrap argument validation this file pins. */
function installer(args: string[]): Promise<{ code: number; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.INVOCATION_ID;
  return run("bash", [INSTALLER, ...args], { env, timeout: 30_000 }).then(
    (result) => ({ code: 0, stderr: result.stderr }),
    (error: { code?: number; stderr?: string }) => ({
      code: error.code ?? 1,
      // stderr only: execFile's message echoes the command line, which would
      // false-match assertions about the script's own diagnostics.
      stderr: error.stderr ?? "",
    }),
  );
}

test("quiet external-rp without --trusted-proxy-edge fails naming the flag, before side effects", async () => {
  const { code, stderr } = await installer([
    "--yes",
    "--profile",
    "external-rp",
    "--http-host",
    "10.9.9.9",
  ]);
  assert.notEqual(code, 0);
  assert.match(stderr, /--trusted-proxy-edge/);
  // The refusal happens in the argument pre-flight — before the root gate,
  // apt, units or config render could touch anything.
  assert.doesNotMatch(stderr, /требует root/);
});

test("trust-everyone edges are rejected (0.0.0.0/0, ::/0, wildcard hosts)", async () => {
  for (const edge of ["0.0.0.0/0", "::/0", "0.0.0.0", "::"]) {
    const { code, stderr } = await installer([
      "--yes",
      "--profile",
      "external-rp",
      "--http-host",
      "10.9.9.9",
      "--trusted-proxy-edge",
      edge,
    ]);
    assert.notEqual(code, 0, `edge ${edge} must be rejected`);
    assert.match(stderr, /доверять всем/, `edge ${edge}`);
  }
});

test("malformed addresses are rejected (out-of-range octet, junk)", async () => {
  for (const edge of ["999.9.9.9", "10.0.0.0/33", "not-an-address"]) {
    const { code, stderr } = await installer([
      "--yes",
      "--profile",
      "external-rp",
      "--http-host",
      "10.9.9.9",
      "--trusted-proxy-edge",
      edge,
    ]);
    assert.notEqual(code, 0, `edge ${edge} must be rejected`);
    assert.match(stderr, /ожидался IPv4\/IPv6-адрес или CIDR/, `edge ${edge}`);
  }
});

test("a valid edge passes the pre-flight (the failure is environmental, not the flag)", async () => {
  for (const edge of ["10.8.0.82", "10.8.0.0/24", "fd00::1"]) {
    const { code, stderr } = await installer([
      "--yes",
      "--profile",
      "external-rp",
      "--http-host",
      "10.9.9.9",
      "--trusted-proxy-edge",
      edge,
    ]);
    assert.notEqual(code, 0); // dev/CI host: stops at root/incoming preflight
    assert.doesNotMatch(stderr, /trusted-proxy-edge/, `edge ${edge}`);
  }
});

test("installer renders a trusted-proxy CIDR into the production config template", async () => {
  const script = await readFile(INSTALLER, "utf8");
  const replacement = script.match(
    /-e "(s(.)__TRUSTED_PROXY_EDGE__\2\$\{OPT_TRUSTED_PROXY_EDGE\}\2g)"/,
  );
  assert.ok(replacement?.[1]);

  const rendered = spawnSync(
    "sed",
    ["-e", replacement[1].replace("${OPT_TRUSTED_PROXY_EDGE}", "10.8.0.0/24"), CONFIG_TEMPLATE],
    { encoding: "utf8" },
  );
  assert.equal(rendered.status, 0, rendered.stderr);
  const config = JSON.parse(rendered.stdout) as { http: { trustedProxies: string[] } };
  assert.ok(config.http.trustedProxies.includes("10.8.0.0/24"));
});

test("bootstrap registry defaults to my.p-cms.ru and preserves an explicit registry URL", async () => {
  const script = await readFile(INSTALLER, "utf8");
  const assignment = script.match(/^\s*OPT_REGISTRY_URL=\$\{OPT_REGISTRY_URL:-[^\n]+$/m)?.[0];
  assert.ok(assignment);
  for (const [input, expected] of [
    ["", "https://my.p-cms.ru"],
    ["https://registry.example", "https://registry.example"],
  ]) {
    const result: SpawnSyncReturns<string> = spawnSync(
      "bash",
      [
        "-c",
        `OPT_REGISTRY_URL=$1; ${assignment}; printf '%s' "$OPT_REGISTRY_URL"`,
        "registry-test",
        input ?? "",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
  const template = JSON.parse(await readFile(CONFIG_TEMPLATE, "utf8"));
  assert.equal(template.registry.baseUrl, "https://my.p-cms.ru");
});
