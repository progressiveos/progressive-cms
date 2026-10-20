// Standard browser-compatibility alias for the current site's favicon
// (CORE-FAVICON-01): `/favicon.ico` answers with a same-origin redirect to the
// SAME resolved Site Identity favicon the core head section already links.
//
// There is deliberately no separate favicon setting and no second media
// pipeline: the route reads the one existing source of truth — the icon links
// the core head renders on entry-less surfaces (search results, error pages).
// Nothing is placed in a web root and no Nginx rule is required. When the site
// declares no favicon, or its favicon-v1 derivative was never materialized,
// the route answers 404: absence is configuration, not a defect.

import { createHash } from "node:crypto";
import type { ApplicationServices } from "@pcms/api";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface FaviconRouteOptions {
  readonly application: ApplicationServices;
}

/** Public media delivery namespace (Media spec §33) — the only place this
 * route may point a client. A custom or external redirect target can never
 * enter, so the alias cannot be turned into an open redirect. */
const MEDIA_PREFIX = "/media/";

export function registerFaviconRoute(fastify: FastifyInstance, options: FaviconRouteOptions): void {
  const { application } = options;

  fastify.get("/favicon.ico", async (request, reply: FastifyReply) => {
    const icons = await application.seoDiscovery.siteFaviconIcons();
    // `icon` is the favicon-v1 PNG by contract (512×512); apple-touch-icon is
    // the same brand mark and only a fallback when rel="icon" is absent.
    const icon = icons.find((entry) => entry.rel === "icon") ?? icons[0];
    if (icon === undefined) return reply.status(404).send();
    // Keep the request's own origin: the resolved URL carries the primary
    // domain, and redirecting a staging (or otherwise bound) request to it
    // would serve another site's/environment's asset.
    const target = new URL(icon.href, "http://local");
    const location = `${target.pathname}${target.search}`;
    if (!location.startsWith(MEDIA_PREFIX)) return reply.status(404).send();
    // Conditional caching keyed on the current target: after the identity's
    // favicon changes the derived tag changes too, so a revalidating client
    // gets the new location instead of a pinned old icon.
    const etag = `"${createHash("sha256").update(location).digest("hex").slice(0, 32)}"`;
    void reply.header("etag", etag);
    // 302, never 301: the redirect is bounded by max-age, so a favicon change
    // reaches clients shortly after assignment instead of being cached
    // permanently by a browser that never revalidates.
    void reply.header("cache-control", "public, max-age=300");
    if (request.headers["if-none-match"] === etag) return reply.status(304).send();
    return reply.redirect(location, 302);
  });
}
