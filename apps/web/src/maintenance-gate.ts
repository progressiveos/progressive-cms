// Maintenance Mode request gate (PCMS-OPS-T118; task brief §19–§26, §70, §71).
//
// Semantics: while maintenance is ON the anonymous public receives the
// branded Core-owned 503 page; only authenticated actors holding
// `site.maintenance.bypass` see the real site. Admin, auth flows, health
// endpoints, MCP and signed previews stay reachable so an administrator can
// always turn the mode back off (no lock-out, no redirect loops).
//
// API behavior (task brief §25): anonymous public content APIs are closed
// consistently with the public site (503 JSON envelope), except the auth
// endpoints needed to gain a bypass-privileged session.

import { type ApplicationServices, authenticateRequest } from "@pcms/api";
import type { Logger } from "@pcms/core";
import {
  createMaintenancePageHtml,
  loadPcmsMarkSvg,
  type MaintenanceState,
  readMaintenanceState,
} from "@pcms/operations";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** Exact health endpoints (Operations spec §26) — never gated. */
const MAINTENANCE_EXEMPT_PATHS = new Set([
  "/health/live",
  "/health/ready",
  "/admin", // SPA shell + /admin redirect (registerAdminStatic)
  "/preview", // signed-token surface: capability URLs stay valid (§25)
  "/preview/page", // signed-token page render — same credential as /preview
  "/mcp", // bearer-only operator transport, no public content
]);

// /themes/ serves the active theme's PUBLIC assets only (M17-T007): no
// protected content can leak, and the bypass-privileged site render needs
// its CSS/JS while maintenance is ON.
const MAINTENANCE_EXEMPT_PREFIXES = ["/admin/", "/api/v1/auth/", "/themes/"];

export function maintenancePathExempt(path: string): boolean {
  if (MAINTENANCE_EXEMPT_PATHS.has(path)) return true;
  return MAINTENANCE_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** CSP for the self-contained maintenance page: no JS by construction. */
const MAINTENANCE_PAGE_CSP =
  "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";

export interface MaintenanceGateOptions {
  readonly application: ApplicationServices;
  readonly logger: Logger;
  readonly cookieSecure: boolean;
}

export function registerMaintenanceGate(
  fastify: FastifyInstance,
  options: MaintenanceGateOptions,
): void {
  const { application, logger, cookieSecure } = options;
  // No TTL cache: a stale `enabled:false` window after a toggle would let
  // anonymous traffic past the gate (browser corpus §72 caught exactly that).
  // The state read is one primary-key SELECT — negligible next to rendering.
  const readState = async (): Promise<MaintenanceState | null> =>
    readMaintenanceState(application.pool).catch(() => null);

  const renderPage = (state: MaintenanceState): string =>
    createMaintenancePageHtml(
      {
        title: state.title,
        message: state.message,
        promoLabel: state.promoLabel,
        promoUrl: state.promoUrl,
      },
      { logoSvg: loadPcmsMarkSvg() },
    );

  const sendMaintenancePage = (reply: FastifyReply, state: MaintenanceState): FastifyReply => {
    return reply
      .code(503)
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header("x-robots-tag", "noindex, nofollow")
      .header("retry-after", String(state.retryAfterSeconds))
      .header("content-security-policy", MAINTENANCE_PAGE_CSP)
      .send(renderPage(state));
  };

  const sendMaintenanceEnvelope = (reply: FastifyReply, state: MaintenanceState): FastifyReply => {
    return reply
      .code(503)
      .header("cache-control", "no-store")
      .header("retry-after", String(state.retryAfterSeconds))
      .send({ error: { code: "SITE_MAINTENANCE", message: state.title } });
  };

  fastify.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const state = await readState();
    if (state === null || !state.enabled) return;
    const path = request.url.split("?")[0] ?? "/";
    if (maintenancePathExempt(path)) return;

    const auth = await authenticateRequest(application, request, { cookieSecure }).catch(
      () => null,
    );
    if (auth !== null && auth.actor.permissions.has("site.maintenance.bypass")) {
      // Bypass-privileged staff see the real site (task brief §23).
      return;
    }
    if (path.startsWith("/api/")) {
      sendMaintenanceEnvelope(reply, state);
      logger.info("maintenance.blocked", {
        operation: "maintenance.gate",
        request_id: request.id,
        surface: "api",
      });
      return reply;
    }
    sendMaintenancePage(reply, state);
    logger.info("maintenance.blocked", {
      operation: "maintenance.gate",
      request_id: request.id,
      surface: "public",
    });
    return reply;
  });
}
