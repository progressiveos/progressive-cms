import type { ApplicationServices } from "@pcms/api";
import { getPublicAgentMarkdownSettings } from "@pcms/api";
import { isStableId } from "@pcms/core";
import {
  parseSeoDocument,
  resolveSeoMetadata,
  type SeoDocument,
  type SitemapCandidate,
  toSiteSeoDefaults,
} from "@pcms/seo";
import type { FastifyInstance, FastifyReply } from "fastify";
import { escapeMarkdownInline } from "./markdown-render.js";

export type PublicRepresentation = "html" | "markdown";
export interface MarkdownDiscoveryEnvironment {
  readonly site: Awaited<ReturnType<ApplicationServices["routes"]["ensureSite"]>>;
  readonly localization: Awaited<ReturnType<ApplicationServices["localization"]["get"]>>;
  readonly identity: Awaited<ReturnType<ApplicationServices["seoDiscovery"]["getSiteIdentity"]>>;
}
export const MAX_LLMS_PAGES = 200;
const MAX_LLMS_CHECKS = 1000;
const MAX_LLMS_DOCUMENT_BYTES = 131_072;
const MAX_LLMS_TOTAL_BYTES = 2_097_152;

function quality(accept: string, type: string, subtype: string): number {
  const matches = accept.split(",").flatMap((part, order) => {
    const [mediaRange, ...parameters] = part.trim().toLowerCase().split(";");
    const [rangeType, rangeSubtype] = (mediaRange ?? "").trim().split("/");
    if (
      !rangeType ||
      !rangeSubtype ||
      (rangeType !== "*" && rangeType !== type) ||
      (rangeSubtype !== "*" && rangeSubtype !== subtype)
    )
      return [];
    const qParam = parameters.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const q = qParam === undefined ? 1 : Number(qParam.slice(2));
    return [
      {
        q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0,
        specificity: Number(rangeType !== "*") + Number(rangeSubtype !== "*"),
        order,
      },
    ];
  });
  matches.sort((a, b) => b.specificity - a.specificity || a.order - b.order);
  return matches[0]?.q ?? 0;
}

export function preferredRepresentation(accept: string | undefined): PublicRepresentation {
  if (accept === undefined || accept.trim() === "") return "html";
  const markdown = quality(accept, "text", "markdown");
  const html = Math.max(
    quality(accept, "text", "html"),
    quality(accept, "application", "xhtml+xml"),
  );
  return markdown > 0 && markdown > html ? "markdown" : "html";
}

export function acceptsHtml(accept: string | undefined): boolean {
  return (
    accept === undefined ||
    accept.trim() === "" ||
    Math.max(quality(accept, "text", "html"), quality(accept, "application", "xhtml+xml")) > 0
  );
}

export function htmlPathFromMarkdown(path: string, trailingSlash = true): string {
  if (path === "/index.md") return "/";
  if (path.endsWith("/index.md")) {
    const base = path.slice(0, -"index.md".length);
    return trailingSlash ? base : base.slice(0, -1) || "/";
  }
  const base = path.slice(0, -".md".length) || "/";
  if (base === "/" || /\.[^/]+$/.test(base)) return base;
  return trailingSlash && !base.endsWith("/") ? `${base}/` : base;
}

export function markdownPathForHtml(path: string): string {
  if (path === "/") return "/index.md";
  return `${path.endsWith("/") ? path.slice(0, -1) : path}.md`;
}

function samePathIgnoringTrailingSlash(left: string, right: string): boolean {
  const canonical = (path: string) =>
    path !== "/" && path.endsWith("/") ? path.slice(0, -1) : path;
  return canonical(left) === canonical(right);
}

function hasUnambiguousMarkdownPath(path: string): boolean {
  if (path.includes("[") || path.includes("]") || path.includes("|")) return false;
  const markdown = markdownPathForHtml(path).replace(/[()]/g, (part) =>
    part === "(" ? "%28" : "%29",
  );
  try {
    return (
      !markdown.includes("%") &&
      new URL(markdown, "https://example.invalid").pathname === markdown &&
      samePathIgnoringTrailingSlash(htmlPathFromMarkdown(markdown), path)
    );
  } catch {
    return false;
  }
}

export function renderLlmsTxt(
  siteName: string,
  sitemapUrl: string,
  pages: readonly {
    readonly path: string;
    readonly title: string;
    readonly description: string | null;
  }[],
): string {
  const title = escapeMarkdownInline(siteName.replace(/[\r\n]+/g, " ").trim() || "Site");
  return [
    `# ${title}`,
    "",
    "## Content",
    "",
    ...pages.map((page) => {
      const path = markdownPathForHtml(page.path).replace(/[()]/g, (part) =>
        part === "(" ? "%28" : "%29",
      );
      const description = page.description?.trim();
      return `- [${escapeMarkdownInline(page.title)}](${path})${description ? ` — ${escapeMarkdownInline(description)}` : ""}`;
    }),
    "",
    "## Sitemap",
    "",
    `- [XML sitemap](${sitemapUrl})`,
    "",
  ].join("\n");
}

export function registerMarkdownFiles(
  fastify: FastifyInstance,
  options: {
    readonly application: ApplicationServices;
    readonly checkAvailability?: (candidate: SitemapCandidate) => Promise<string | null>;
    readonly prepareAvailability?: (
      candidates: readonly SitemapCandidate[],
      environment: MarkdownDiscoveryEnvironment,
    ) => Promise<(candidate: SitemapCandidate) => Promise<string | null>>;
  },
): void {
  fastify.get("/llms.txt", async (_request, reply: FastifyReply) => {
    const { globalEnabled } = await getPublicAgentMarkdownSettings(options.application, null);
    if (!globalEnabled) return reply.status(404).send();
    const candidates = await options.application.seoDiscovery.getPublicSitemapCandidates();
    if (candidates === null) return reply.status(404).send();
    const identity = await options.application.seoDiscovery.getSiteIdentity().catch(() => null);
    const site = await options.application.routes.ensureSite(options.application.defaultSiteKey);
    const localization = await options.application.localization.get();
    const checkAvailability = options.prepareAvailability
      ? await options.prepareAvailability(
          candidates
            .filter(
              (candidate) =>
                candidate.markdown?.enabled &&
                hasUnambiguousMarkdownPath(candidate.path) &&
                (candidate.locale === localization.defaultLocale ||
                  (localization.enabled &&
                    candidate.locale !== undefined &&
                    localization.locales.includes(candidate.locale))),
            )
            .slice(0, MAX_LLMS_CHECKS),
          { site, localization, identity },
        )
      : options.checkAvailability;
    const pages: { path: string; title: string; description: string | null }[] = [];
    const skipped: Record<string, number> = {};
    let checks = 0;
    let bytes = 0;
    for (const candidate of candidates) {
      if (!isStableId(candidate.entryId) || !/^\/(?!\/)[^\s<>\\]*$/.test(candidate.path)) continue;
      if (!hasUnambiguousMarkdownPath(candidate.path)) {
        skipped.ambiguous_markdown_path = (skipped.ambiguous_markdown_path ?? 0) + 1;
        continue;
      }
      if (
        candidate.locale === undefined ||
        (candidate.locale !== localization.defaultLocale &&
          (!localization.enabled || !localization.locales.includes(candidate.locale)))
      )
        continue;
      if (candidate.markdown === undefined) {
        skipped.revision_unavailable_or_disabled =
          (skipped.revision_unavailable_or_disabled ?? 0) + 1;
        continue;
      }
      if (!candidate.markdown.enabled) continue;
      if (checks >= MAX_LLMS_CHECKS) {
        skipped.check_limit = 1;
        break;
      }
      checks += 1;
      const size = Buffer.byteLength(JSON.stringify(candidate.markdown.payload) ?? "");
      if (size > MAX_LLMS_DOCUMENT_BYTES) {
        skipped.document_limit = (skipped.document_limit ?? 0) + 1;
        continue;
      }
      bytes += size;
      if (bytes > MAX_LLMS_TOTAL_BYTES) {
        skipped.byte_limit = 1;
        break;
      }
      const reason = checkAvailability
        ? await checkAvailability(candidate)
        : "availability_unverified";
      if (reason !== null) {
        skipped[reason] = (skipped[reason] ?? 0) + 1;
        continue;
      }
      let seo: SeoDocument | null;
      try {
        seo = candidate.markdown.seo === null ? null : parseSeoDocument(candidate.markdown.seo);
      } catch {
        continue;
      }
      const metadata = resolveSeoMetadata(
        seo,
        {
          page_title:
            typeof candidate.markdown.title === "string" ? candidate.markdown.title : null,
          intro: typeof candidate.markdown.intro === "string" ? candidate.markdown.intro : null,
          hero_image: null,
        },
        toSiteSeoDefaults(identity),
      );
      pages.push({
        path: candidate.path,
        title: metadata.title.value ?? candidate.path,
        description: metadata.description.value,
      });
      if (pages.length === MAX_LLMS_PAGES) break;
    }
    if (Object.keys(skipped).length > 0)
      fastify.log.info({ skipped, checked: checks }, "markdown.discovery_unconfirmed");
    void reply.header("content-type", "text/plain; charset=utf-8");
    void reply.header("x-content-type-options", "nosniff");
    void reply.header("cache-control", "no-cache");
    return reply.send(renderLlmsTxt(identity?.site_name ?? site.title, "/sitemap.xml", pages));
  });
}
