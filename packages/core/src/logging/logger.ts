// Structured logging kernel (PCMS-OPS-T006, Operations spec §28/§29).
//
// Single-line JSON objects to stdout (journald-friendly), AsyncLocalStorage
// request/operation context, and a redaction pass that removes secret-shaped
// keys before serialization (Operations §28: never log passwords, tokens,
// TOTP secrets, session cookies, form PII — the redaction policy ships now,
// ahead of the data).

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { LogLevel } from "../config/schema.js";

export type { LogLevel };
export type LogFields = Record<string, unknown>;

export interface LogContext {
  requestId?: string;
  operation?: string;
  actorId?: string;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Fixed extra context (e.g. a worker run id); the dynamic ALS context wins on clash. */
  withContext(context: LogContext): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Destination; defaults to process.stdout. Tests inject a capture sink. */
  sink?: (line: string) => void;
  /** Fixed fields merged into every line (process name, milestone tags). */
  base?: LogFields;
}

const LEVELS: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;

/** Secret-shaped keys are stripped wherever they appear in a log record. */
const REDACT_KEY =
  /pass(word)?|secret|token|authorization|cookie|credential|totp|api[-_]?key|private[-_]?key|session[-_]?id/i;

const als = new AsyncLocalStorage<LogContext>();

/** Runs `work` with a logging context (request_id, operation, …) attached. */
export function runWithLogContext<Out>(context: LogContext, work: () => Out): Out {
  return als.run(context, work);
}

export function currentLogContext(): LogContext {
  return als.getStore() ?? {};
}

export function newRequestId(): string {
  return randomUUID();
}

/** Error → structured value (message/stack/code only; no surrounding object walk). */
export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      name: error.name,
      message: error.message,
      ...(code === undefined ? {} : { code }),
      stack: error.stack,
    };
  }
  return { name: "NonError", message: String(error) };
}

/**
 * Deep-copies a value replacing secret-shaped keys, cycles and BigInts so
 * the result is always safely JSON.stringify-able.
 */
export function redactFields(value: LogFields, depth = 0): LogFields {
  return walk(value, depth, new WeakSet<object>()) as LogFields;
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = REDACT_KEY.test(key) ? REDACTED : walk(item, depth + 1, seen);
  }
  return out;
}

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? ((line: string) => process.stdout.write(line));
  return createScoped(options, sink, {});
}

function createScoped(
  options: LoggerOptions,
  sink: (line: string) => void,
  staticContext: LogContext,
): Logger {
  const threshold = LEVELS[options.level];

  function emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVELS[level] < threshold) return;
    const context = { ...staticContext, ...currentLogContext() };
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...options.base,
      ...(context.requestId === undefined ? {} : { request_id: context.requestId }),
      ...(context.operation === undefined ? {} : { operation: context.operation }),
      ...(context.actorId === undefined ? {} : { actor_id: context.actorId }),
      ...(fields === undefined ? {} : { ...fields }),
    };
    // Error convenience: error({..., err}) serializes the Error structurally.
    for (const key of ["err", "error"] as const) {
      if (record[key] instanceof Error) record[key] = serializeError(record[key]);
    }
    sink(`${JSON.stringify(redactFields(record))}\n`);
  }

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    withContext: (context) => createScoped(options, sink, { ...staticContext, ...context }),
  };
}
