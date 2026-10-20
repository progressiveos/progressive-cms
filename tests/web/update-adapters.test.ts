import assert from "node:assert/strict";
import { test } from "node:test";
import {
  waitForWorkerRestartConfirmation,
  workerHeartbeatConfirmsRestart,
} from "../../apps/web/src/update-adapters.js";

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
