// Public SEO documents (M17 §44/§45): /robots.txt and /sitemap.xml rendered
// from the SEO subsystem's policy + sitemap builders. The origin always comes
// from the primary domain binding — never the request Host — and a
// non-indexable environment serves nothing (the route returns 404) so staging
// cannot publish a crawlable document by accident.
import type { ApplicationServices } from "@pcms/api";
import { renderRobotsTxt } from "@pcms/seo";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface SeoFilesRouteOptions {
  readonly application: ApplicationServices;
}

export function registerSeoFilesRoute(
  fastify: FastifyInstance,
  options: SeoFilesRouteOptions,
): void {
  const { application } = options;

  fastify.get("/robots.txt", async (_request, reply: FastifyReply) => {
    const policy = await application.seoDiscovery.getRobotsPolicy();
    void reply.header("content-type", "text/plain; charset=utf-8");
    void reply.header("cache-control", "public, max-age=3600");
    return reply.send(renderRobotsTxt(policy));
  });

  fastify.get("/sitemap.xml", async (_request, reply: FastifyReply) => {
    const document = await application.seoDiscovery.getSitemapDocument();
    if (document === null) return reply.status(404).send();
    void reply.header("content-type", "application/xml; charset=utf-8");
    void reply.header("cache-control", "public, max-age=3600");
    return reply.send(document);
  });
}
