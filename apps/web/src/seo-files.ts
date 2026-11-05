// Public SEO documents (M17 §44/§45): /robots.txt and /sitemap.xml rendered
// from the SEO subsystem's policy + sitemap builders. The origin always comes
// from the primary domain binding — never the request Host — and a
// non-indexable environment serves nothing (the route returns 404) so staging
// cannot publish a crawlable document by accident.
import type { ApplicationServices } from "@pcms/api";
import type { AppConfig } from "@pcms/core";
import { renderRobotsTxt } from "@pcms/seo";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface SeoFilesRouteOptions {
  readonly application: ApplicationServices;
  readonly securityTxt?: AppConfig["http"]["securityTxt"];
  readonly now?: () => Date;
}

export function registerSeoFilesRoute(
  fastify: FastifyInstance,
  options: SeoFilesRouteOptions,
): void {
  const { application } = options;

  const securityTxt = async (request: FastifyRequest, reply: FastifyReply) => {
    const document = options.securityTxt;
    const remaining =
      document === undefined
        ? 0
        : Math.floor(
            (Date.parse(document.expires) - (options.now?.() ?? new Date()).getTime()) / 1000,
          );
    if (request.protocol !== "https" || document === undefined || remaining <= 0)
      return reply.status(404).send();
    void reply.header("content-type", "text/plain; charset=utf-8");
    void reply.header("x-content-type-options", "nosniff");
    void reply.header("cache-control", `public, max-age=${Math.min(3600, remaining)}`);
    return reply.send(
      `Contact: ${document.contact}\nExpires: ${document.expires}\n${document.preferredLanguages === undefined ? "" : `Preferred-Languages: ${document.preferredLanguages}\n`}`,
    );
  };
  if (options.securityTxt !== undefined) {
    fastify.get("/.well-known/security.txt", securityTxt);
    fastify.get("/security.txt", securityTxt);
  }

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
