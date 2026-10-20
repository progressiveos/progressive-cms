// Shared route/ingest helpers (deduplicated 2026-09-28 audit W4): the same
// guard and parse shapes used by several route files and the pcpub ingest
// layer. Keep them tiny and dependency-free.

import type { PcpubLimits } from "@pcms/publication";
import { DEFAULT_PCPUB_LIMITS } from "@pcms/publication";
import type { FastifyRequest } from "fastify";
import type { ApplicationServices } from "../../context.js";
import { ApiError } from "../../errors.js";

/** Stable-id request gate (UUIDv7 shape, 400 otherwise). */
export function stableId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new ApiError("API_REQUEST_INVALID", `${name} must be a stable id`, { status: 400 });
  }
  return value;
}

/** JSON-object body gate. */
export function jsonBody(request: FastifyRequest): Record<string, unknown> {
  if (typeof request.body !== "object" || request.body === null) {
    throw new ApiError("API_REQUEST_INVALID", "a JSON object body is required", { status: 400 });
  }
  return request.body as Record<string, unknown>;
}

/** Empty-string-normalizing optional string (query params). */
export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Effective pcpub bundle limits (config override or package defaults). */
export function pcpubLimitsFrom(app: ApplicationServices): PcpubLimits {
  return app.pcpubBundleLimits ?? DEFAULT_PCPUB_LIMITS;
}

/** Media storage gate (503 when the composition has no storage bound). */
export function requireStorage(app: ApplicationServices) {
  if (app.mediaStorage === null) {
    throw new ApiError("MEDIA_STORAGE_CONFIG", "media storage is not configured", { status: 503 });
  }
  return app.mediaStorage;
}

/** Media quarantine gate (503 when the composition has no quarantine bound). */
export function requireQuarantine(app: ApplicationServices) {
  if (app.mediaQuarantine === null) {
    throw new ApiError("MEDIA_STORAGE_CONFIG", "media quarantine is not configured", {
      status: 503,
    });
  }
  return app.mediaQuarantine;
}
