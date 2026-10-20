// Admin Workspace static bundle (PCMS-ADMIN-T001; ADR-0009).
//
// Serves the built apps/admin SPA under /admin/. The bundle is a pure static
// artifact — the web process never executes admin build code. A missing
// bundle is a startup warning, not an error: API-only deployments keep
// working, and Operations decides when the Admin ships.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { Logger } from "@pcms/core";
import type { FastifyInstance } from "fastify";

export async function registerAdminStatic(
  fastify: FastifyInstance,
  options: { distDir: string; logger: Logger },
): Promise<void> {
  const indexHtml = join(options.distDir, "index.html");
  if (!existsSync(indexHtml)) {
    options.logger.warn("admin.bundle.missing", {
      operation: "admin.static",
      dist_dir: options.distDir,
    });
    return;
  }
  if (!statSync(indexHtml).isFile()) {
    options.logger.warn("admin.bundle.invalid", {
      operation: "admin.static",
      dist_dir: options.distDir,
    });
    return;
  }

  const securityHeaders: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    // The Admin is an authenticated internal surface: no third-party origins,
    // inline style attributes allowed (design tokens use external CSS),
    // same-origin XHR only. Media previews are same-origin /media URLs.
    "content-security-policy":
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
  };

  await fastify.register(fastifyStatic, {
    root: options.distDir,
    prefix: "/admin/",
    setHeaders(reply, path) {
      for (const [name, value] of Object.entries(securityHeaders)) {
        void reply.header(name, value);
      }
      // Vite emits content-hashed asset names; the HTML entry must never be
      // cached so a deploy is picked up on the next reload.
      void reply.header(
        "cache-control",
        path.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable",
      );
    },
  });

  // Bare /admin redirects to the SPA entry (hash routing needs no fallback).
  fastify.get("/admin", async (_request, reply) => {
    for (const [name, value] of Object.entries(securityHeaders)) {
      void reply.header(name, value);
    }
    void reply.redirect("/admin/");
    return reply;
  });
}
