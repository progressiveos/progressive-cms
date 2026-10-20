// PCMS-OPS-T006 — structured logging: JSON shape, request IDs, redaction
// baseline, level filtering, context propagation.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLogger,
  currentLogContext,
  type LogFields,
  newRequestId,
  redactFields,
  runWithLogContext,
} from "@pcms/core";

function capture(level: "debug" | "info" | "warn" | "error" = "info", base?: LogFields) {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level,
    ...(base === undefined ? {} : { base }),
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

test("log lines are single JSON objects with ts/level/msg", () => {
  const { logger, lines } = capture();
  logger.info("boot complete", { component: "web" });
  const line = lines[0] ?? {};
  assert.equal(line.level, "info");
  assert.equal(line.msg, "boot complete");
  assert.equal(line.component, "web");
  assert.match(String(line.ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test("level filtering hides debug at info threshold", () => {
  const { logger, lines } = capture("info");
  logger.debug("noisy detail");
  logger.warn("visible warning");
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.level, "warn");
});

test("request id from AsyncLocalStorage context appears as request_id", () => {
  const { logger, lines } = capture();
  runWithLogContext({ requestId: "req-123", operation: "http.request" }, () => {
    logger.info("handled");
  });
  assert.equal(lines[0]?.request_id, "req-123");
  assert.equal(lines[0]?.operation, "http.request");
  // outside the context the fields are absent
  logger.info("outside");
  assert.equal("request_id" in (lines[1] ?? {}), false);
  assert.equal(currentLogContext().requestId, undefined);
});

test("withContext adds static context; dynamic ALS context wins", () => {
  const { logger, lines } = capture();
  const scoped = logger.withContext({ requestId: "static-run", operation: "worker" });
  scoped.info("a");
  runWithLogContext({ requestId: "dynamic-req" }, () => scoped.info("b"));
  assert.equal(lines[0]?.request_id, "static-run");
  assert.equal(lines[1]?.request_id, "dynamic-req", "more specific ALS context overrides");
  assert.equal(lines[1]?.operation, "worker");
});

test("redaction baseline strips secret-shaped keys recursively", () => {
  const { logger, lines } = capture();
  logger.info("login attempt", {
    username: "ann",
    password: "hunter2",
    nested: { apiKey: "sk-123", visible: 42 },
    list: [{ token: "tok-1" }, { ok: true }],
    Authorization: "Bearer x",
    sessionCookie: "sid=…",
    dbPasswordHash: "…",
  });
  const line = lines[0] ?? {};
  assert.equal(line.username, "ann");
  assert.equal(line.password, "[REDACTED]");
  const nested = line.nested as Record<string, unknown>;
  assert.equal(nested.apiKey, "[REDACTED]");
  assert.equal(nested.visible, 42);
  const list = line.list as Record<string, unknown>[];
  assert.equal(list[0]?.token, "[REDACTED]");
  assert.equal(list[1]?.ok, true);
  assert.equal(line.Authorization, "[REDACTED]");
  assert.equal(line.sessionCookie, "[REDACTED]");
  assert.equal(line.dbPasswordHash, "[REDACTED]");
});

test("redaction is applied even to Error objects and nested config-ish data", () => {
  const { logger, lines } = capture();
  const error = new Error("db connect failed");
  logger.error("startup failed", { err: error, db: { user: "pcms", password: "must-not-appear" } });
  const line = lines[0] ?? {};
  const err = line.err as Record<string, unknown>;
  assert.equal(err.name, "Error");
  assert.equal(err.message, "db connect failed");
  assert.match(String(err.stack), /logging\.test\.ts|Error:/);
  const db = line.db as Record<string, unknown>;
  assert.equal(db.password, "[REDACTED]");
  assert.equal(db.user, "pcms");
});

test("serialization stays safe for BigInt and circular structures", () => {
  const self: Record<string, unknown> = {};
  self.selfRef = self; // circular before redaction
  const record = redactFields({ count: 10n, self });
  const json = JSON.stringify(record);
  assert.match(json, /"count":"10"/);
  assert.match(json, /\[Circular\]/);
});

test("newRequestId produces unique identifiers", () => {
  const a = newRequestId();
  const b = newRequestId();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f-]{36}$/);
});

test("base fields from options land on every line", () => {
  const { logger, lines } = capture("info", { process: "pcms-web" });
  logger.info("x");
  logger.warn("y");
  assert.equal(lines[0]?.process, "pcms-web");
  assert.equal(lines[1]?.process, "pcms-web");
});
