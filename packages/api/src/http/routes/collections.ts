// Public collections REST surface (Theme Contract §43).
//
// GET /api/v1/collections/:key/items — anonymous, rate-limited read of a
// theme-declared collection's published feed. This is the machine-facing half
// of the collection contract (the theme scope injection is the other half):
// agents verify the feed contract here with plain GETs. Read-only by
// construction — the route never generates derivatives and never mutates.

import { localizedRoutePath } from "@pcms/routing";
import {
  COLLECTION_DEFAULT_PAGE_SIZE,
  parseCollectionFeedQuery,
  queryCollectionFeed,
} from "../../collection-source.js";
import { ApiError } from "../../errors.js";
import { readBindingFeedOptions } from "../../feed-options.js";
import type { ApiRoute } from "../registry.js";
import { createRateLimiter } from "./search.js";

const STABLE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const COLLECTIONS_QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    page: { type: "string", pattern: "^[0-9]+$" },
    page_size: { type: "string", pattern: "^[0-9]+$" },
    tag: { type: "string", maxLength: 64 },
    locale: { type: "string", maxLength: 16 },
    section: { type: "string", maxLength: 64 },
  },
} as const;

/** First media reference of a feed row (hero field, else first image block). */
function firstImageAssetId(fields: Record<string, unknown>, blocks: unknown): string | null {
  if (typeof fields.hero_image === "string" && STABLE_ID_RE.test(fields.hero_image)) {
    return fields.hero_image;
  }
  const visit = (nodes: unknown): string | null => {
    if (!Array.isArray(nodes)) return null;
    for (const value of nodes) {
      const block = value as {
        type?: string;
        props?: Record<string, unknown>;
        children?: unknown[];
      };
      if (block.type === "image" && typeof block.props?.media_id === "string") {
        return block.props.media_id;
      }
      const nested = visit(block.children);
      if (nested !== null) return nested;
    }
    return null;
  };
  const fromBlocks = visit(blocks);
  return fromBlocks !== null && STABLE_ID_RE.test(fromBlocks) ? fromBlocks : null;
}

/** Rich-text/plain teaser of a feed row (intro → teaser → first body
 * paragraph) — the same fallback chain the theme feed cards use (§43). */
function cardTeaser(fields: Record<string, unknown>): string | null {
  const plain = (value: unknown): string => {
    if (typeof value === "string") return value.trim();
    if (typeof value !== "object" || value === null) return "";
    const document = value as { type?: string; content?: unknown };
    if (document.type !== "document") return "";
    const walk = (node: unknown): string => {
      if (typeof node === "string") return node;
      if (Array.isArray(node)) return node.map(walk).join("");
      if (typeof node === "object" && node !== null) {
        const record = node as Record<string, unknown>;
        if (typeof record.text === "string") return record.text;
        return walk(record.content);
      }
      return "";
    };
    return walk(document.content).trim();
  };
  const body = fields.body;
  const firstParagraph =
    typeof body === "object" &&
    body !== null &&
    (body as { type?: string; content?: unknown }).type === "document"
      ? plain({
          type: "document",
          content: [
            ((body as { content?: unknown[] }).content ?? []).find(
              (node) => (node as { type?: string }).type === "paragraph",
            ) ?? [],
          ],
        })
      : "";
  return plain(fields.intro) || plain(fields.teaser) || firstParagraph.slice(0, 200) || null;
}

export function makeCollectionsRoutes(): ApiRoute[] {
  const rateLimit = createRateLimiter({ now: () => new Date() });
  return [
    {
      spec: {
        method: "GET",
        url: "/collections/:key/items",
        operationId: "list_collection_items",
        summary:
          "Public feed of a theme-declared collection (published cards; page/page_size/tag; rate-limited)",
        tag: "content",
        auth: "public",
        querySchema: COLLECTIONS_QUERY_SCHEMA,
      },
      async handle(app, _ctx, request) {
        rateLimit(request.ip);
        const params = request.params as { key: string };
        const binding = app.themeDiscovery?.getManifest().collections?.[params.key];
        if (binding === undefined) {
          throw new ApiError(
            "COLLECTION_UNKNOWN",
            `collection "${params.key}" is not declared by the active theme`,
            { status: 404 },
          );
        }
        const query = request.query as Record<string, unknown>;
        let context = "default";
        if (typeof query.locale === "string" && query.locale !== "" && query.locale !== "default") {
          try {
            context = await app.localization.contextFor(query.locale);
          } catch {
            throw new ApiError("API_REQUEST_INVALID", `locale "${query.locale}" is not enabled`, {
              status: 400,
            });
          }
        }
        // "self"-scoped collections bind to the page they render on; over
        // REST the section is explicit — silently ignoring it would publish
        // a different (wider) feed under the same key.
        let sectionEntryId: string | null = null;
        if (typeof query.section === "string" && query.section !== "") {
          if (!STABLE_ID_RE.test(query.section)) {
            throw new ApiError("COLLECTION_SECTION_INVALID", "section must be a stable entry id", {
              status: 400,
            });
          }
          sectionEntryId = query.section;
        }
        const { page, pageSize, tag } = parseCollectionFeedQuery(query, {
          pageSize: binding.page_size ?? COLLECTION_DEFAULT_PAGE_SIZE,
        });
        const site = await app.routes.ensureSite(app.defaultSiteKey);
        const feed = await queryCollectionFeed(
          {
            pool: app.pool,
            isKnownContentType: (key) => app.contentTypes.getLatestContentType(key) !== null,
          },
          {
            context,
            contentTypes: binding.content_types,
            sectionEntryId,
            // REST keeps its declared semantics: no `section` = the whole
            // site, `section` = its direct children. The manifest's
            // template-context scope has no meaning here.
            scope: sectionEntryId === null ? "site" : "section",
            order: readBindingFeedOptions(binding).order,
            siteId: site.id,
            tagField: binding.tag_field ?? "tags",
            tag,
            page,
            pageSize,
          },
        );
        const items = feed.items.map((row) => {
          const fields = row.fields ?? {};
          const tags = Array.isArray(fields[binding.tag_field ?? "tags"])
            ? (fields[binding.tag_field ?? "tags"] as unknown[]).filter(
                (value): value is string => typeof value === "string",
              )
            : [];
          return {
            entry_id: row.entry_id,
            href: localizedRoutePath({ locale: row.route_locale, path: row.route_path }),
            title: typeof fields.title === "string" ? fields.title : row.entry_id,
            teaser: cardTeaser(fields),
            date: row.published_at,
            tags,
            // Media REFERENCE only: the route stays derivative-free and
            // read-only; themes resolve the actual image model through the
            // media scope / buildImageModel (Theme Contract §43).
            image_asset_id: firstImageAssetId(fields, row.blocks),
          };
        });
        return {
          status: 200,
          body: {
            collection: params.key,
            total: feed.total,
            page: feed.page,
            page_size: feed.pageSize,
            page_count: feed.pageCount,
            tag,
            tags: feed.tags,
            has_next: feed.page < feed.pageCount,
            has_prev: feed.page > 1,
            items,
          },
        };
      },
    },
  ];
}
