// PCMS-INT-T012/T013 — inbound endpoint contract + InboundEvent
// persistence/dedup/retention: duplicate provider events (by provider
// event id or by payload fingerprint) never cause a second side effect;
// oversized payloads rejected; verification failures leave no receivable
// event; raw payloads age out (bounded retention) while metadata remains.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, fixedClock } from "@pcms/core";
import {
  createInboundService,
  InboundContractRegistry,
  type InboundEndpointContract,
  type IntegrationError,
} from "@pcms/integrations";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const CLOCK = fixedClock(new Date("2026-09-20T12:00:00.000Z"));

const contract: InboundEndpointContract = {
  payloadLimitBytes: 64 * 1024,
  verify(request) {
    if (request.headers["x-signature"] !== "good") {
      throw new Error("bad signature");
    }
  },
  extractEventId(request) {
    const match = request.rawBody.match(/"event_id":"([^"]+)"/);
    return match === null ? null : (match[1] ?? null);
  },
  parse(request) {
    const parsed = JSON.parse(request.rawBody) as { kind?: string };
    if (parsed.kind === undefined) throw new Error("unparseable");
    return { eventType: parsed.kind, normalized: { kind: parsed.kind } };
  },
};

async function fixture(t: { after: (fn: () => void) => void }) {
  if (!testDatabaseConfigured()) return null;
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  const { loadMigrations, migrateDatabase } = await import("@pcms/core");
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const contracts = new InboundContractRegistry();
  contracts.register("integration_instance:fake-inbound", contract);
  const inbound = createInboundService({ pool, clock: CLOCK, contracts });
  const SOURCE_ID = "018f0000-0000-7000-8000-00000000ab01";
  const base = {
    sourceType: "integration_instance" as const,
    sourceId: SOURCE_ID,
    contractKey: "integration_instance:fake-inbound",
    headers: { "x-signature": "good" },
  };
  return { pool, inbound, base };
}

test("duplicate provider event (id or fingerprint) never re-triggers side effects", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const body = JSON.stringify({ event_id: "evt-1", kind: "payment.succeeded" });
  const first = await fx.inbound.receive({ ...fx.base, rawBody: body });
  assert.equal(first.duplicate, false);
  assert.equal(first.eventType, "payment.succeeded");
  const second = await fx.inbound.receive({ ...fx.base, rawBody: body });
  assert.equal(second.duplicate, true);
  assert.equal(second.record.id, first.record.id);
  // Same event id, different body → still a duplicate (id identity wins).
  const mutated = await fx.inbound.receive({
    ...fx.base,
    rawBody: JSON.stringify({ event_id: "evt-1", kind: "tampered" }),
  });
  assert.equal(mutated.duplicate, true);
  // No event id → payload fingerprint dedup.
  const anonymous = JSON.stringify({ kind: "form.received" });
  const a1 = await fx.inbound.receive({ ...fx.base, rawBody: anonymous });
  const a2 = await fx.inbound.receive({ ...fx.base, rawBody: anonymous });
  assert.equal(a1.duplicate, false);
  assert.equal(a2.duplicate, true);
});

test("verification failures and oversize payloads are refused without a receivable event", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await assert.rejects(
    fx.inbound.receive({
      ...fx.base,
      headers: { "x-signature": "forged" },
      rawBody: JSON.stringify({ event_id: "evt-x", kind: "k" }),
    }),
    (error: IntegrationError) => error.code === "INTEGRATION_INBOUND_INVALID",
  );
  await assert.rejects(
    fx.inbound.receive({ ...fx.base, rawBody: "x".repeat(65 * 1024) }),
    (error: IntegrationError) => error.code === "INTEGRATION_INBOUND_PAYLOAD_TOO_LARGE",
  );
  assert.equal((await fx.inbound.list()).length, 0);
});

test("parse failure persists a FAILED record with a safe error code", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const result = await fx.inbound.receive({
    ...fx.base,
    rawBody: JSON.stringify({ event_id: "evt-9" }),
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.record.status, "FAILED");
  assert.equal(result.record.errorCode, "INTEGRATION_INBOUND_INVALID");
});

test("lifecycle: processed/failed transitions; listings never expose raw payloads", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const received = await fx.inbound.receive({
    ...fx.base,
    rawBody: JSON.stringify({ event_id: "evt-2", kind: "k" }),
  });
  await fx.inbound.markProcessed(received.record.id);
  const listed = await fx.inbound.list({ sourceId: fx.base.sourceId });
  const row = listed.find((record) => record.id === received.record.id);
  assert.equal(row?.status, "PROCESSED");
  assert.ok(row !== undefined && !("raw_payload" in (row as unknown as Record<string, unknown>)));
});

test("retention nulls old raw payloads but keeps the record", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const received = await fx.inbound.receive({
    ...fx.base,
    rawBody: JSON.stringify({ event_id: "evt-3", kind: "k" }),
  });
  const aged = await fx.pool.query(
    `UPDATE integration_inbound_event SET received_at = $2::timestamptz - interval '30 days'
     WHERE id = $1`,
    [received.record.id, CLOCK.now()],
  );
  assert.equal(aged.rowCount, 1);
  const purged = await fx.inbound.enforceRetention(7);
  assert.equal(purged >= 1, true);
  const raw = await fx.pool.query<{ raw_payload: unknown }>(
    `SELECT raw_payload FROM integration_inbound_event WHERE id = $1`,
    [received.record.id],
  );
  assert.equal(raw.rows[0]?.raw_payload, null);
  // Record itself remains inspectable.
  const listed = await fx.inbound.list();
  assert.equal(
    listed.some((record) => record.id === received.record.id),
    true,
  );
});
