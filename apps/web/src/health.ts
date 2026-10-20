// Health endpoints (PCMS-OPS-T008, Operations spec §26).
//
//   /health/live  — process alive; independent of PostgreSQL state.
//   /health/ready — required dependencies usable right now (M01: database).
//
// Public bodies carry status only: no dependency names, no error detail, no
// config material. Failed checks are logged (structured, internal) so
// operators get the diagnosis without exposing it publicly.

import type { Logger } from "@pcms/core";
import type { FastifyInstance } from "fastify";

export interface HealthCheck {
  name: string;
  /** Resolves false on unavailability/timeouts; must never throw. */
  run: (timeoutMilliseconds: number) => Promise<boolean>;
}

export const READINESS_PROBE_TIMEOUT_MILLISECONDS = 2000;

export interface HealthPluginOptions {
  logger: Logger;
  checks: HealthCheck[];
}

export async function healthRoutes(
  fastify: FastifyInstance,
  options: HealthPluginOptions,
): Promise<void> {
  fastify.get("/health/live", async () => ({ status: "live" }));

  fastify.get("/health/ready", async (_request, reply) => {
    const results = await Promise.all(
      options.checks.map(async (check) => ({
        name: check.name,
        ok: await check.run(READINESS_PROBE_TIMEOUT_MILLISECONDS).catch(() => false),
      })),
    );
    const healthy = results.every((result) => result.ok);
    if (healthy) {
      return reply.code(200).send({ status: "ready" });
    }
    for (const failed of results.filter((result) => !result.ok)) {
      options.logger.warn("health.check.failed", {
        operation: "health.ready",
        check: failed.name,
      });
    }
    return reply.code(503).send({ status: "not_ready" });
  });
}
