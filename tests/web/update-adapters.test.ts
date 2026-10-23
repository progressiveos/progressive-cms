import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type DbPool, systemClock } from "@pcms/core";
import {
  createUpdateOrchestrator,
  ExtensionError,
  parseReleaseManifest,
  type UpdatePreflight,
} from "@pcms/extensions/internal";
import {
  createProductionUpdatePorts,
  type UpdateAdapterOptions,
  waitForWorkerRestartConfirmation,
  workerHeartbeatConfirmsRestart,
} from "../../apps/web/src/update-adapters.js";

test("backup veto is recorded before deployment and never changes current", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pcms-backup-veto-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync(root, join(root, "current"));
  const recorded: unknown[][] = [];
  const pool = {
    query: async (_sql: string, values: unknown[]) => {
      recorded.push(values);
      return { rows: [] };
    },
  } as unknown as DbPool;
  const target = parseReleaseManifest({
    manifest_version: "1",
    version: "2.0.0",
    core_db_migrations: [],
    required_runtime: { node: ">=24 <25", postgres: ">=14 <19" },
    supports_extension_contracts: ["2.0"],
    backup_required: false,
    rollback_policy: "rollback_safe",
  });
  const preflight = {
    current: { version: "1.0.0" },
    target: { version: "2.0.0", rollbackPolicy: "rollback_safe" },
    plannedCoreMigrations: [],
    plannedExtensionMigrations: [],
    issues: [],
    outcome: "READY",
  } as unknown as UpdatePreflight;
  const unexpected = async () => {
    assert.fail("backup failure must not reach deployment/migrations/restarts");
  };
  const orchestrator = createUpdateOrchestrator({
    pool,
    clock: systemClock,
    target,
    preflight,
    actor: { type: "operator", id: "test" },
    ports: {
      backupGate: {
        confirm: async () => {
          throw new Error("backup failed");
        },
      },
      maintenance: { enter: unexpected, exit: unexpected },
      releaseDeployment: { deploy: unexpected },
      migrations: { applyCore: unexpected, applyExtensionMigrations: unexpected },
      serviceRestart: { restart: unexpected },
      postflightDoctor: { run: unexpected },
    },
  });
  await assert.rejects(
    orchestrator.apply({}),
    (error: unknown) => error instanceof ExtensionError && error.code === "UPDATE_BACKUP_REQUIRED",
  );
  assert.equal(readlinkSync(join(root, "current")), root);
  assert.ok(recorded.some((values) => values.includes("UPDATE_BACKUP_REQUIRED")));
});

test("deployment verification failure restores current through the privileged unit before migrations", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pcms-adapter-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const scenario of ["unreadable", "wrong-version", "before-switch", "success"]) {
    const base = join(root, scenario);
    for (const path of ["bin", "incoming", "previous", "target"])
      mkdirSync(join(base, path), { recursive: true });
    const current = join(base, "current");
    const previous = join(base, "previous");
    const target = join(base, "target");
    symlinkSync(previous, current);
    writeFileSync(
      join(target, "build-metadata.json"),
      JSON.stringify({ version: scenario === "success" ? "2.0.0" : "wrong" }),
      {
        mode: scenario === "unreadable" ? 0o000 : 0o600,
      },
    );
    writeFileSync(
      join(base, "bin/systemctl"),
      `#!${process.execPath}
const fs = require('node:fs');
const base = ${JSON.stringify(base)};
const request = base + '/incoming/rollback-deployment.json';
fs.appendFileSync(base + '/calls', 'start\\n');
if (fs.existsSync(request)) {
  const {previous, target} = JSON.parse(fs.readFileSync(request));
  if (previous !== base + '/previous' || target !== base + '/target') process.exit(2);
  fs.unlinkSync(base + '/current'); fs.symlinkSync(previous, base + '/current'); fs.unlinkSync(request);
} else {
  if (${JSON.stringify(scenario)} === 'before-switch') process.exit(1);
  fs.unlinkSync(base + '/current'); fs.symlinkSync(base + '/target', base + '/current');
  fs.writeFileSync(base + '/status', base + '/target');
}
`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${join(base, "bin")}:${oldPath}`;
    try {
      const ports = createProductionUpdatePorts({
        incomingDir: join(base, "incoming"),
        currentSymlink: current,
        installStatusFile: join(base, "status"),
        installUnit: "test-install",
      } as UpdateAdapterOptions);
      const preflight = { target: { version: "2.0.0" } } as Parameters<
        NonNullable<typeof ports.releaseDeployment>["deploy"]
      >[0];
      const deploy = ports.releaseDeployment?.deploy(preflight) as Promise<void>;
      if (scenario === "success") await assert.doesNotReject(deploy);
      else await assert.rejects(deploy);
      assert.equal(readlinkSync(current), scenario === "success" ? target : previous);
      assert.equal(
        readFileSync(join(base, "calls"), "utf8"),
        ["before-switch", "success"].includes(scenario) ? "start\n" : "start\nstart\n",
      );
    } finally {
      process.env.PATH = oldPath;
    }
  }
});

test("worker postflight rejects a fresh heartbeat from before the restart", () => {
  const requestedAt = new Date("2026-10-12T23:00:00.000Z");
  assert.equal(
    workerHeartbeatConfirmsRestart(
      { bootId: "old-process", startedAt: new Date("2026-10-12T22:59:00.000Z") },
      { bootId: "old-process", requestedAt },
    ),
    false,
  );
  assert.equal(
    workerHeartbeatConfirmsRestart(
      { bootId: "new-process", startedAt: new Date("2026-10-12T23:00:01.000Z") },
      { bootId: "old-process", requestedAt },
    ),
    true,
  );
  assert.equal(
    workerHeartbeatConfirmsRestart(
      { bootId: "new-process", startedAt: new Date("2026-10-12T22:59:59.000Z") },
      { bootId: "old-process", requestedAt },
    ),
    false,
  );
  assert.equal(
    workerHeartbeatConfirmsRestart({ bootId: "new-process", startedAt: requestedAt }, undefined),
    false,
  );
});

test("worker postflight waits for the restarted process to publish its first heartbeat", async () => {
  const requestedAt = new Date("2026-10-12T23:00:00.000Z");
  const baseline = { bootId: "old-process", requestedAt };
  const oldHeartbeat = {
    bootId: "old-process",
    startedAt: new Date("2026-10-12T22:59:00.000Z"),
  };
  const newHeartbeat = {
    bootId: "new-process",
    startedAt: new Date("2026-10-12T23:00:01.000Z"),
  };
  let now = 0;
  let reads = 0;

  const confirmed = await waitForWorkerRestartConfirmation(
    async () => {
      reads += 1;
      return reads < 3 ? oldHeartbeat : newHeartbeat;
    },
    baseline,
    {
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    },
  );

  assert.deepEqual(confirmed, newHeartbeat);
  assert.equal(reads, 3);
});

test("worker postflight fails closed when restart confirmation times out", async () => {
  const requestedAt = new Date("2026-10-12T23:00:00.000Z");
  const oldHeartbeat = {
    bootId: "old-process",
    startedAt: new Date("2026-10-12T22:59:00.000Z"),
  };
  let now = 0;
  let reads = 0;

  const confirmed = await waitForWorkerRestartConfirmation(
    async () => {
      reads += 1;
      return oldHeartbeat;
    },
    { bootId: "old-process", requestedAt },
    {
      timeoutMs: 200,
      pollIntervalMs: 100,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    },
  );

  assert.equal(confirmed, null);
  assert.equal(reads, 3);
});

test("backup gate reports retention warnings only after checksum verification", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "pcms-backup-warnings-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, "bin"));
  mkdirSync(join(base, "20261022T000000Z"));
  const set = join(base, "20261022T000000Z");
  writeFileSync(join(set, "manifest.json"), "{}");
  writeFileSync(join(set, "db.dump"), "test");
  // sha256 of the literal string "test"; the production verifier executes sha256sum.
  const valid = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08  db.dump\n";
  const oldPath = process.env.PATH;
  process.env.PATH = `${join(base, "bin")}:${oldPath}`;
  try {
    const preflight = {} as UpdatePreflight;
    for (const scenario of ["legacy", "warning", "bad-checksum", "failed-unit", "bad-warning"]) {
      writeFileSync(
        join(base, "bin/systemctl"),
        `#!/bin/sh\nexit ${scenario === "failed-unit" ? 1 : 0}\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(set, "checksums.sha256"),
        scenario === "bad-checksum" ? `${"0".repeat(64)}  db.dump\n` : valid,
      );
      rmSync(join(set, "warnings.json"), { force: true });
      if (scenario !== "legacy")
        writeFileSync(
          join(set, "warnings.json"),
          JSON.stringify(scenario === "bad-warning" ? ["unknown"] : ["BACKUP_RETENTION_FAILED"]),
        );
      const ports = createProductionUpdatePorts({
        backupDir: base,
        backupUnit: "test-backup",
      } as UpdateAdapterOptions);
      if (["bad-checksum", "failed-unit", "bad-warning"].includes(scenario)) {
        await assert.rejects(ports.backupGate.confirm(preflight));
        assert.deepEqual(ports.backupGate.warnings?.(), []);
      } else {
        await ports.backupGate.confirm(preflight);
        assert.deepEqual(
          ports.backupGate.warnings?.(),
          scenario === "warning" ? ["BACKUP_RETENTION_FAILED"] : [],
        );
      }
    }
  } finally {
    process.env.PATH = oldPath;
  }
});
