// Public search page (PCMS-SEARCH-T011/T012; Search spec §21/§22/§23).
//
// `/search/` is an explicit system route: reserved in Routing (content can
// never claim it), server-rendered through the application search service,
// bounded (same parse/limits as the public API), rate-limited, and always
// noindex (spec §22 — search result pages must never create indexable
// combinatorial URLs). Rendering uses the configured theme's
// `search` template (or legacy `search-result` component) when available; the built-in semantic markup is
// the fallback so the route works theme-less.

import type { SystemDocumentInjection } from "@pcms/analytics";
import { type ApplicationServices, createRateLimiter } from "@pcms/api";
import { escapeHtmlString as escapeHtml } from "@pcms/core";
import { PREVIEW_RESPONSE_HEADERS } from "@pcms/publication";
import type { SearchResultItemViewModel, SearchResultPageViewModel } from "@pcms/themes";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { publicSecurityHeaders } from "./public-headers.js";
import { analyticsPageInjection, applySystemSlots } from "./system-slots.js";

/**
 * Appends the system analytics contribution (validated origins + inline
 * script hashes) to the CSP policy STRING our own builder emitted
 * (directives separated by "; ", sources by spaces).
 */
function mergeSystemCsp(
  policy: string | undefined,
  injection: Pick<SystemDocumentInjection, "origins" | "scriptHashes" | "blobFrame">,
): string {
  const directives = new Map<string, string[]>();
  for (const part of (policy ?? "").split(";")) {
    const tokens = part
      .trim()
      .split(/\s+/)
      .filter((token) => token !== "");
    if (tokens.length === 0) continue;
    directives.set(tokens[0]!, tokens.slice(1));
  }
  const addTo = (directive: string, sources: readonly string[]) => {
    if (sources.length === 0) return;
    directives.set(directive, [...new Set([...(directives.get(directive) ?? []), ...sources])]);
  };
  for (const [originDirective, origins] of Object.entries(injection.origins)) {
    if (!origins || origins.length === 0) continue;
    addTo(originDirective.replaceAll("_", "-"), origins);
  }
  addTo("script-src", injection.scriptHashes);
  if (injection.blobFrame) addTo("frame-src", ["blob:"]);
  if (directives.size === 0) return policy ?? "";
  return [...directives.entries()]
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}

/** Search spec §22: noindex on every search result response. */
const SEARCH_X_ROBOTS_TAG = "noindex, follow";
const searchRateLimits = new WeakMap<ApplicationServices, ReturnType<typeof createRateLimiter>>();

interface PageSearchParams {
  readonly q: string;
  readonly locale: string;
  readonly cursor?: string;
  readonly sort?: string;
  readonly content_type?: string;
  readonly date_from?: string;
  readonly date_to?: string;
}

export interface SearchPageTheme {
  readonly headers: Readonly<Record<string, string>>;
  render(search: SearchResultPageViewModel): Promise<string | null>;
}

export function registerSearchPageRoute(
  fastify: FastifyInstance,
  options: { application: ApplicationServices; theme?: SearchPageTheme },
): void {
  const handler = createSearchPageHandler(options);
  fastify.get("/search", handler);
  fastify.get("/search/", handler);
}

/** Shared live/ signed-preview search: identical query validation and result scope. */
export function createSearchPageHandler(options: {
  application: ApplicationServices;
  theme?: SearchPageTheme;
  preview?: boolean;
  locale?: string;
}): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const themeComponent = options.theme ?? null;
  const searchRateLimit =
    searchRateLimits.get(options.application) ?? createRateLimiter({ now: () => new Date() });
  searchRateLimits.set(options.application, searchRateLimit);

  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    void reply.header("x-robots-tag", options.preview ? "noindex, nofollow" : SEARCH_X_ROBOTS_TAG);
    void reply.header("content-type", "text/html; charset=utf-8");
    // The full public-page security baseline (CSP/nosniff/permissions),
    // identical to the site pages — the system route is a public page first.
    for (const [name, value] of Object.entries(
      options.theme?.headers ?? publicSecurityHeaders(undefined),
    )) {
      void reply.header(name, value);
    }
    if (options.preview)
      for (const [name, value] of Object.entries(PREVIEW_RESPONSE_HEADERS))
        void reply.header(name, value);
    const query = request.query as Record<string, unknown>;
    const params: PageSearchParams = {
      q: typeof query.q === "string" ? query.q : "",
      locale:
        options.locale ??
        (typeof query.locale === "string" && query.locale !== "default"
          ? query.locale
          : (await options.application.localization.get()).defaultLocale),
      ...(typeof query.cursor === "string" && query.cursor !== "" ? { cursor: query.cursor } : {}),
      ...(typeof query.sort === "string" && query.sort !== "" ? { sort: query.sort } : {}),
      ...Object.fromEntries(
        ["content_type", "date_from", "date_to"].flatMap((key) =>
          typeof query[key] === "string" && query[key] !== "" ? [[key, query[key]]] : [],
        ),
      ),
    };
    // System document slots (ADR-0016): one injection per request — the CSP
    // header and the injected HTML share the same instance (script hashes).
    const searchInjection = options.preview
      ? null
      : analyticsPageInjection(options.application, {
          pageId: "",
          pageType: "search",
          locale: params.locale,
          isSearch: true,
        });
    if (searchInjection !== null) {
      void reply.header(
        "content-security-policy",
        mergeSystemCsp(
          (options.theme?.headers ?? publicSecurityHeaders(undefined))["content-security-policy"],
          searchInjection,
        ),
      );
    }
    const { application } = options;
    // The built-in markup is a core-rendered public page: it carries the
    // Site Identity favicon like theme pages do (owner tail 2026-10-03).
    const icons = await options.application.seoDiscovery.siteFaviconIcons().catch(() => []);

    if (params.q.trim() === "") {
      // Spec §16: an empty public query renders the landing, never a dump.
      void reply
        .status(200)
        .send(
          applySystemSlots(
            await renderPage(params, null, 0, [], null, themeComponent, options.preview, icons),
            searchInjection,
          ),
        );
      return;
    }
    try {
      // Rate-limit per client, never one shared bucket: a single key would
      // let one visitor exhaust everyone's search budget (self-DoS).
      searchRateLimit(request.ip);
      const result = await application.searchQuery({
        ...params,
        limit: 20,
      });
      const items: SearchResultItemViewModel[] = result.items.map((item) => ({
        ...item,
        modified_at: item.modified_at === null ? null : item.modified_at.toISOString(),
        published_at: item.published_at === null ? null : item.published_at.toISOString(),
      }));
      void reply
        .status(200)
        .send(
          applySystemSlots(
            await renderPage(
              params,
              params.q,
              result.total,
              items,
              result.next_cursor,
              themeComponent,
              options.preview,
              icons,
            ),
            searchInjection,
          ),
        );
      return;
    } catch (error) {
      const code = (error as { code?: string }).code ?? "SEARCH_QUERY_INVALID";
      const status =
        code === "SEARCH_RATE_LIMITED" ? 429 : code === "SEARCH_INDEX_UNAVAILABLE" ? 503 : 400;
      const message =
        code === "SEARCH_INDEX_UNAVAILABLE"
          ? "Search is temporarily unavailable."
          : error instanceof Error
            ? error.message
            : "invalid search request";
      void reply.status(status).send(errorPage(params, code, message, options.preview, icons));
      return;
    }
  };

  return handler;
}

async function renderPage(
  params: PageSearchParams,
  query: string | null,
  total: number,
  items: readonly SearchResultItemViewModel[],
  nextCursor: string | null,
  themeComponent: SearchPageTheme | null,
  preview = false,
  icons: readonly SearchHeadIcon[] = [],
): Promise<string> {
  if (themeComponent !== null) {
    try {
      const html = await themeComponent.render({
        query: params.q,
        locale: params.locale,
        total,
        items,
        next_cursor: nextCursor,
        next_url: nextSearchUrl(params, nextCursor),
        sort: params.sort ?? "relevance",
        filters: searchFilters(params),
        limit: 20,
      });
      if (html !== null && html.trim() !== "") return html;
    } catch (error) {
      if (preview) throw error;
      // Theme rendering failure must not take the system route down.
    }
  }
  if (preview) throw new Error("candidate search template did not render");
  return wrapSearchPage(fallbackBody(params, query, total, items, nextCursor), preview, icons);
}

function fallbackBody(
  params: PageSearchParams,
  query: string | null,
  total: number,
  items: readonly SearchResultItemViewModel[],
  nextCursor: string | null,
): string {
  const form = `<form action="/search/" method="get" role="search">
  <input type="search" name="q" value="${escapeHtml(params.q)}" maxlength="256" aria-label="Search query"/>
  <input type="hidden" name="locale" value="${escapeHtml(params.locale)}"/>
  ${Object.entries({ sort: params.sort ?? "relevance", ...searchFilters(params) })
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${escapeHtml(value)}"/>`)
    .join("")}
  <button type="submit">Search</button>
</form>`;
  if (query === null) {
    return `<main id="main"><section class="search">${form}<p>Enter a search query.</p></section></main>`;
  }
  const list = items
    .map(
      (item) => `<li class="search__result">
  ${item.path === null ? `<span>${escapeHtml(item.title)}</span>` : `<a href="${escapeHtml(item.path)}">${escapeHtml(item.title)}</a>`}
  ${
    item.snippet === null
      ? ""
      : `<p class="search__snippet">${item.snippet.segments
          .map((segment) =>
            segment.match
              ? `<em class="search-hit">${escapeHtml(segment.text)}</em>`
              : escapeHtml(segment.text),
          )
          .join("")}</p>`
  }
</li>`,
    )
    .join("\n");
  const pagination =
    nextCursor === null
      ? ""
      : `<nav aria-label="Result pages"><a href="${escapeHtml(nextSearchUrl(params, nextCursor) ?? "")}">Next page</a></nav>`;
  return `<main id="main"><section class="search">${form}<p>Results found: ${total}</p><ol class="search__results">${list}</ol>${pagination}</section></main>`;
}

function searchFilters(params: PageSearchParams): Record<string, string> {
  return Object.fromEntries(
    ["content_type", "date_from", "date_to"].flatMap((key) => {
      const value = params[key as keyof PageSearchParams];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function nextSearchUrl(params: PageSearchParams, cursor: string | null): string | null {
  if (cursor === null) return null;
  return `/search/?${new URLSearchParams({
    q: params.q,
    locale: params.locale,
    sort: params.sort ?? "relevance",
    cursor,
    ...searchFilters(params),
  })}`;
}

function errorPage(
  params: PageSearchParams,
  code: string,
  message: string,
  preview = false,
  icons: readonly SearchHeadIcon[] = [],
): string {
  return wrapSearchPage(
    `<main id="main"><section class="search">
  <form action="/search/" method="get" role="search">
    <input type="search" name="q" value="${escapeHtml(params.q)}" maxlength="256"/>
    <button type="submit">Search</button>
  </form>
  <p class="search__error" data-code="${escapeHtml(code)}">${escapeHtml(message)}</p>
</section></main>`,
    preview,
    icons,
  );
}

/** Site Identity favicon link for the built-in markup (same shape the core
 * head section renders on theme pages). */
interface SearchHeadIcon {
  readonly rel: string;
  readonly href: string;
  readonly type?: string;
  readonly sizes?: string;
}

export function wrapSearchPage(
  body: string,
  preview = false,
  icons: readonly SearchHeadIcon[] = [],
): string {
  const iconTags = icons
    .map((icon) => {
      const attrs = [
        `rel="${escapeHtml(icon.rel)}"`,
        `href="${escapeHtml(icon.href)}"`,
        icon.type === undefined ? "" : `type="${escapeHtml(icon.type)}"`,
        icon.sizes === undefined ? "" : `sizes="${escapeHtml(icon.sizes)}"`,
      ]
        .filter((a) => a !== "")
        .join(" ");
      return `<link ${attrs}/>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="${preview ? "noindex, nofollow" : "noindex, follow"}"/>
<title>Search — Progressive CMS</title>
${iconTags === "" ? "" : `${iconTags}\n`}</head>
<body>
${body}
</body>
</html>`;
}
